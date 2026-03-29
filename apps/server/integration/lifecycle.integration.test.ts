import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Queue, Stream } from "effect";

import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { McpConfigServiceLive } from "../src/provider/Layers/McpConfig.ts";
import { McpConfigService } from "../src/provider/Services/McpConfig.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { ServerConfig } from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../src/persistence/Services/ProviderSessionRuntime.ts";

import { makeTestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";
import { codexTurnTextFixture } from "./fixtures/providerRuntime.ts";

// ── Helpers ──────────────────────────────────────────────────────

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Lifecycle fixture uses the **real** McpConfigServiceLive (not a mock)
 * so that config resolution, snapshot persistence, and rehydration are
 * exercised through the same code paths as production.
 */
const makeLifecycleFixture = Effect.gen(function* () {
  const cwd = yield* makeWorkspaceDirectory;
  const harness = yield* makeTestProviderAdapterHarness();

  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(harness.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  // shared includes McpConfigServiceLive (real) — NOT McpConfigService.layerTest().
  const shared = Layer.mergeAll(
    runtimeRepositoryLayer,
    directoryLayer,
    Layer.succeed(ProviderAdapterRegistry, registry),
    ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
    AnalyticsService.layerTest,
    McpConfigServiceLive,
  );

  const layer = Layer.merge(shared, makeProviderServiceLive().pipe(Layer.provide(shared))).pipe(
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "lifecycle-int-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  return { cwd, harness, layer };
});

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

// ── Resume cursor ────────────────────────────────────────────────

it.effect("recovers session with persisted resume cursor after adapter death", () =>
  Effect.gen(function* () {
    const fixture = yield* makeLifecycleFixture;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = ThreadId.makeUnsafe("lifecycle-resume-cursor");

      // 1. Start session — adapter generates a resume cursor.
      const session = yield* provider.startSession(threadId, {
        threadId,
        provider: "codex",
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      const originalCursor = session.resumeCursor;
      assert.isDefined(originalCursor);

      // 2. Run a turn so the binding is fully exercised.
      yield* fixture.harness.queueTurnResponse(threadId, {
        events: codexTurnTextFixture,
      });
      yield* collectEventsDuring(
        provider.streamEvents,
        codexTurnTextFixture.length,
        provider.sendTurn({ threadId, input: "hello", attachments: [] }),
      );

      // 3. Kill adapter sessions directly (simulates process crash —
      //    ProviderService still has the persisted binding).
      yield* fixture.harness.adapter.stopAll();
      assert.equal(fixture.harness.listActiveSessionIds().length, 0);

      // 4. Queue a response for the session that recovery will create.
      yield* fixture.harness.queueTurnResponseForNextSession({
        events: codexTurnTextFixture,
      });

      // 5. sendTurn triggers automatic recovery: the ProviderService reads
      //    the persisted binding, extracts the resume cursor, and calls
      //    adapter.startSession(resumeCursor) before forwarding the turn.
      const recoveryEvents = yield* collectEventsDuring(
        provider.streamEvents,
        codexTurnTextFixture.length,
        provider.sendTurn({
          threadId,
          input: "continue after crash",
          attachments: [],
        }),
      );
      assert.equal(recoveryEvents.length, codexTurnTextFixture.length);

      // 6. Verify: the recovered session carries the original resume cursor.
      const sessions = yield* provider.listSessions();
      const recovered = sessions.find((s) => String(s.threadId) === String(threadId));
      assert.isDefined(recovered);
      assert.deepEqual(recovered!.resumeCursor, originalCursor);

      // 7. Verify: adapter was started exactly twice (original + recovery).
      assert.equal(fixture.harness.getStartCount(), 2);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ── MCP snapshot lifecycle ───────────────────────────────────────

it.effect("MCP snapshot survives adapter death and is reused on recovery", () =>
  Effect.gen(function* () {
    const fixture = yield* makeLifecycleFixture;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const mcpConfig = yield* McpConfigService;
      const runtimeRepo = yield* ProviderSessionRuntimeRepository;
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const threadId = ThreadId.makeUnsafe("lifecycle-mcp-snapshot");

      // 1. Write project MCP config with one server.
      yield* fs.makeDirectory(join(fixture.cwd, ".t3"), { recursive: true });
      yield* fs.writeFileString(
        join(fixture.cwd, ".t3", "mcp.json"),
        JSON.stringify({
          servers: {
            "lifecycle-server": {
              command: "node",
              args: ["mcp-server.js"],
              transport: "stdio",
              enabled: true,
            },
          },
        }),
      );

      // 2. Start session — real McpConfigServiceLive resolves config from
      //    disk and persists a snapshot (both in-memory cache + disk).
      yield* provider.startSession(threadId, {
        threadId,
        provider: "codex",
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      // 3. Verify: MCP config ref persisted in the session binding.
      const binding = yield* runtimeRepo.getByThreadId({ threadId });
      assert.equal(binding._tag, "Some");
      if (binding._tag !== "Some") return;
      const payload = binding.value.runtimePayload as Record<string, unknown>;
      const mcpRef = payload.mcpConfigRef as Record<string, unknown> | undefined;
      assert.isDefined(mcpRef);
      assert.equal(mcpRef!.serverCount, 1);

      // 4. Verify: snapshot is in the MCP service cache.
      const snapshot = yield* mcpConfig.getSnapshot(threadId);
      assert.isNotNull(snapshot);
      assert.equal(snapshot!.servers.length, 1);
      assert.equal(snapshot!.servers[0]!.name, "lifecycle-server");

      // 5. Kill adapter + delete the config file.
      //    Without the snapshot, re-resolution would return 0 servers.
      yield* fixture.harness.adapter.stopAll();
      yield* fs.remove(join(fixture.cwd, ".t3", "mcp.json"));

      // 6. Queue a response and trigger recovery via sendTurn.
      yield* fixture.harness.queueTurnResponseForNextSession({
        events: codexTurnTextFixture,
      });
      yield* collectEventsDuring(
        provider.streamEvents,
        codexTurnTextFixture.length,
        provider.sendTurn({
          threadId,
          input: "continue with mcp",
          attachments: [],
        }),
      );

      // 7. Verify: snapshot survived recovery (not cleared — only
      //    stopSession clears it; adapter crash does not).
      const snapshotAfterRecovery = yield* mcpConfig.getSnapshot(threadId);
      assert.isNotNull(snapshotAfterRecovery);
      assert.equal(snapshotAfterRecovery!.servers.length, 1);
      assert.equal(snapshotAfterRecovery!.servers[0]!.name, "lifecycle-server");
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ── Clean teardown ───────────────────────────────────────────────

it.effect("stopSession cleans up binding and MCP snapshot", () =>
  Effect.gen(function* () {
    const fixture = yield* makeLifecycleFixture;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const mcpConfig = yield* McpConfigService;
      const runtimeRepo = yield* ProviderSessionRuntimeRepository;
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const threadId = ThreadId.makeUnsafe("lifecycle-stop-cleanup");

      // Write MCP config and start session.
      yield* fs.makeDirectory(join(fixture.cwd, ".t3"), { recursive: true });
      yield* fs.writeFileString(
        join(fixture.cwd, ".t3", "mcp.json"),
        JSON.stringify({
          servers: {
            "cleanup-server": {
              command: "echo",
              transport: "stdio",
              enabled: true,
            },
          },
        }),
      );

      yield* provider.startSession(threadId, {
        threadId,
        provider: "codex",
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      // Pre-condition: binding and snapshot exist.
      const bindingBefore = yield* runtimeRepo.getByThreadId({ threadId });
      assert.equal(bindingBefore._tag, "Some");
      const snapshotBefore = yield* mcpConfig.getSnapshot(threadId);
      assert.isNotNull(snapshotBefore);

      // Stop session through the ProviderService public API.
      yield* provider.stopSession({ threadId });

      // Binding removed.
      const bindingAfter = yield* runtimeRepo.getByThreadId({ threadId });
      assert.equal(bindingAfter._tag, "None");

      // MCP snapshot cleared.
      const snapshotAfter = yield* mcpConfig.getSnapshot(threadId);
      assert.isNull(snapshotAfter);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ── Session isolation ────────────────────────────────────────────

it.effect("concurrent sessions on separate threads remain isolated", () =>
  Effect.gen(function* () {
    const fixture = yield* makeLifecycleFixture;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadA = ThreadId.makeUnsafe("lifecycle-concurrent-a");
      const threadB = ThreadId.makeUnsafe("lifecycle-concurrent-b");

      // Start two sessions on the same provider.
      const sessionA = yield* provider.startSession(threadA, {
        threadId: threadA,
        provider: "codex",
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      const sessionB = yield* provider.startSession(threadB, {
        threadId: threadB,
        provider: "codex",
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.notEqual(String(sessionA.threadId), String(sessionB.threadId));

      // Run a turn on each.
      yield* fixture.harness.queueTurnResponse(threadA, {
        events: codexTurnTextFixture,
      });
      yield* collectEventsDuring(
        provider.streamEvents,
        codexTurnTextFixture.length,
        provider.sendTurn({
          threadId: threadA,
          input: "turn for A",
          attachments: [],
        }),
      );

      yield* fixture.harness.queueTurnResponse(threadB, {
        events: codexTurnTextFixture,
      });
      yield* collectEventsDuring(
        provider.streamEvents,
        codexTurnTextFixture.length,
        provider.sendTurn({
          threadId: threadB,
          input: "turn for B",
          attachments: [],
        }),
      );

      // Stop A — B must not be affected.
      yield* provider.stopSession({ threadId: threadA });

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(String(sessions[0]!.threadId), String(threadB));

      // B is still fully operational.
      yield* fixture.harness.queueTurnResponse(threadB, {
        events: codexTurnTextFixture,
      });
      yield* collectEventsDuring(
        provider.streamEvents,
        codexTurnTextFixture.length,
        provider.sendTurn({
          threadId: threadB,
          input: "another turn for B",
          attachments: [],
        }),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
