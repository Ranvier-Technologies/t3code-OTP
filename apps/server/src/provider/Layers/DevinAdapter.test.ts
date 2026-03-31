import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { DevinAdapter } from "../Services/DevinAdapter.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { DevinAdapterLive } from "./DevinAdapter.ts";

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function asThreadId(value: string) {
  return ThreadId.makeUnsafe(value);
}

function eventTypes(events: ReadonlyArray<ProviderRuntimeEvent>): ReadonlyArray<string> {
  return events.map((event) => event.type);
}

function eventsOfType<TType extends ProviderRuntimeEvent["type"]>(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  type: TType,
): ReadonlyArray<Extract<ProviderRuntimeEvent, { type: TType }>> {
  return events.filter((event) => event.type === type) as unknown as ReadonlyArray<
    Extract<ProviderRuntimeEvent, { type: TType }>
  >;
}

function makeDirectoryLayer() {
  const bindings: ProviderRuntimeBinding[] = [];

  return {
    bindings,
    layer: Layer.succeed(ProviderSessionDirectory, {
      upsert: (binding) =>
        Effect.sync(() => {
          bindings.push(binding);
        }),
      getProvider: () =>
        Effect.die(
          new Error("ProviderSessionDirectory.getProvider is not used in DevinAdapter tests"),
        ),
      getBinding: () => Effect.succeed(Option.none()),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
    }),
  };
}

function installFetchStub(handler: (call: FetchCall) => Response | Promise<Response>): {
  readonly calls: FetchCall[];
  readonly restore: () => void;
} {
  const calls: FetchCall[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : null;
    const call: FetchCall = {
      method: init?.method ?? "GET",
      url: String(input),
      body,
    };
    calls.push(call);
    return await handler(call);
  }) as unknown as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
}

function installDevinApiKey(value = "cog_test"): () => void {
  const previous = process.env.T3CODE_DEVIN_API_KEY;
  process.env.T3CODE_DEVIN_API_KEY = value;

  return () => {
    if (previous === undefined) {
      delete process.env.T3CODE_DEVIN_API_KEY;
    } else {
      process.env.T3CODE_DEVIN_API_KEY = previous;
    }
  };
}

function makeHarness() {
  const directory = makeDirectoryLayer();
  const serverSettingsLayer = ServerSettingsService.layerTest({
    providers: {
      devin: {
        enabled: true,
        orgId: "org-123",
        baseUrl: "https://api.example.test",
      },
    },
  });

  return {
    bindings: directory.bindings,
    layer: DevinAdapterLive.pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "devin-adapter-test-" })),
      Layer.provideMerge(serverSettingsLayer),
      Layer.provideMerge(directory.layer),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}

describe("DevinAdapterLive", () => {
  it.effect("lazy-creates the remote session on first sendTurn and persists the binding", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const fetchStub = installFetchStub((call) => {
        if (
          call.method === "POST" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions"
        ) {
          return jsonResponse({
            session_id: "devin-session-1",
            url: "https://app.devin.ai/sessions/devin-session-1",
            status: "running",
            status_detail: "working",
          });
        }

        if (
          call.method === "GET" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions/devin-session-1"
        ) {
          return jsonResponse({
            session_id: "devin-session-1",
            url: "https://app.devin.ai/sessions/devin-session-1",
            status: "exit",
            status_detail: "finished",
          });
        }

        if (
          call.method === "GET" &&
          call.url ===
            "https://api.example.test/v3/organizations/org-123/sessions/devin-session-1/messages?first=100"
        ) {
          return jsonResponse({
            items: [],
            end_cursor: null,
            has_next_page: false,
            total: 0,
          });
        }

        return jsonResponse({});
      });
      const restoreEnv = installDevinApiKey();

      try {
        const adapter = yield* DevinAdapter;
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-devin-lazy-create");

        const session = yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });

        assert.equal(session.resumeCursor !== undefined, true);
        assert.equal(fetchStub.calls.length, 0);

        const startedTurn = yield* adapter.sendTurn({
          threadId,
          input: "Build the feature.",
          attachments: [],
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));

        assert.equal(startedTurn.resumeCursor !== undefined, true);
        assert.equal(
          fetchStub.calls.some(
            (call) =>
              call.method === "POST" &&
              call.url === "https://api.example.test/v3/organizations/org-123/sessions",
          ),
          true,
        );
        assert.deepEqual(eventTypes(events).includes("thread.started"), true);
        assert.deepEqual(harness.bindings.at(-1)?.resumeCursor, {
          orgId: "org-123",
          devinId: "devin-session-1",
          lastMessageCursor: null,
          lastMessageEventId: null,
        });
      } finally {
        fetchStub.restore();
        restoreEnv();
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "sends follow-up turns through the session message endpoint instead of creating a new session",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const fetchStub = installFetchStub((call) => {
          if (
            call.method === "POST" &&
            call.url === "https://api.example.test/v3/organizations/org-123/sessions"
          ) {
            return jsonResponse({
              session_id: "devin-session-2",
              url: "https://app.devin.ai/sessions/devin-session-2",
              status: "running",
              status_detail: "working",
            });
          }

          if (
            call.method === "POST" &&
            call.url ===
              "https://api.example.test/v3/organizations/org-123/sessions/devin-session-2/messages"
          ) {
            return jsonResponse({});
          }

          if (
            call.method === "GET" &&
            call.url ===
              "https://api.example.test/v3/organizations/org-123/sessions/devin-session-2"
          ) {
            return jsonResponse({
              session_id: "devin-session-2",
              url: "https://app.devin.ai/sessions/devin-session-2",
              status: "exit",
              status_detail: "finished",
            });
          }

          if (
            call.method === "GET" &&
            call.url ===
              "https://api.example.test/v3/organizations/org-123/sessions/devin-session-2/messages?first=100"
          ) {
            return jsonResponse({
              items: [],
              end_cursor: null,
              has_next_page: false,
              total: 0,
            });
          }

          if (
            call.method === "POST" &&
            call.url ===
              "https://api.example.test/v3/organizations/org-123/sessions/devin-session-2/archive"
          ) {
            return jsonResponse({});
          }

          return jsonResponse({});
        });
        const restoreEnv = installDevinApiKey();

        try {
          const adapter = yield* DevinAdapter;
          const threadId = asThreadId("thread-devin-follow-up");

          yield* adapter.startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
          });
          yield* adapter.sendTurn({
            threadId,
            input: "First task.",
            attachments: [],
          });
          yield* adapter.sendTurn({
            threadId,
            input: "Follow up.",
            attachments: [],
          });

          const createCalls = fetchStub.calls.filter(
            (call) =>
              call.method === "POST" &&
              call.url === "https://api.example.test/v3/organizations/org-123/sessions",
          );
          const messageCalls = fetchStub.calls.filter(
            (call) =>
              call.method === "POST" &&
              call.url ===
                "https://api.example.test/v3/organizations/org-123/sessions/devin-session-2/messages",
          );

          assert.equal(createCalls.length, 1);
          assert.equal(messageCalls.length, 1);
          assert.match(messageCalls[0]?.body ?? "", /Follow up\./);
        } finally {
          fetchStub.restore();
          restoreEnv();
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("suppresses duplicate assistant messages that share the same event id", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const fetchStub = installFetchStub((call) => {
        if (
          call.method === "POST" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions"
        ) {
          return jsonResponse({
            session_id: "devin-session-3",
            url: "https://app.devin.ai/sessions/devin-session-3",
            status: "running",
            status_detail: "working",
          });
        }

        if (
          call.method === "GET" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions/devin-session-3"
        ) {
          return jsonResponse({
            session_id: "devin-session-3",
            url: "https://app.devin.ai/sessions/devin-session-3",
            status: "exit",
            status_detail: "finished",
          });
        }

        if (
          call.method === "GET" &&
          call.url ===
            "https://api.example.test/v3/organizations/org-123/sessions/devin-session-3/messages?first=100"
        ) {
          return jsonResponse({
            items: [
              {
                event_id: "evt-duplicate",
                source: "devin",
                message: "hello once",
                created_at: "2026-03-30T00:00:00.000Z",
              },
              {
                event_id: "evt-duplicate",
                source: "devin",
                message: "hello twice",
                created_at: "2026-03-30T00:00:01.000Z",
              },
            ],
            end_cursor: "cursor-1",
            has_next_page: false,
            total: 2,
          });
        }

        return jsonResponse({});
      });
      const restoreEnv = installDevinApiKey();

      try {
        const adapter = yield* DevinAdapter;
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-devin-dedupe");

        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Say hello.",
          attachments: [],
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));

        assert.equal(eventsOfType(events, "content.delta").length, 1);
        assert.equal(eventsOfType(events, "item.started").length, 1);
        assert.equal(eventsOfType(events, "item.completed").length, 1);
        assert.deepEqual(eventsOfType(events, "content.delta")[0]?.payload, {
          streamKind: "assistant_text",
          delta: "hello once",
        });
      } finally {
        fetchStub.restore();
        restoreEnv();
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("maps waiting_for_approval into waiting state, warning, and completed turn", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const fetchStub = installFetchStub((call) => {
        if (
          call.method === "POST" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions"
        ) {
          return jsonResponse({
            session_id: "devin-session-4",
            url: "https://app.devin.ai/sessions/devin-session-4",
            status: "running",
            status_detail: "working",
          });
        }

        if (
          call.method === "GET" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions/devin-session-4"
        ) {
          return jsonResponse({
            session_id: "devin-session-4",
            url: "https://app.devin.ai/sessions/devin-session-4",
            status: "suspended",
            status_detail: "waiting_for_approval",
          });
        }

        if (
          call.method === "GET" &&
          call.url ===
            "https://api.example.test/v3/organizations/org-123/sessions/devin-session-4/messages?first=100"
        ) {
          return jsonResponse({
            items: [],
            end_cursor: null,
            has_next_page: false,
            total: 0,
          });
        }

        return jsonResponse({});
      });
      const restoreEnv = installDevinApiKey();

      try {
        const adapter = yield* DevinAdapter;
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-devin-waiting");

        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Please continue.",
          attachments: [],
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));

        const waitingStates = eventsOfType(events, "session.state.changed").filter(
          (event) => event.payload.state === "waiting",
        );
        const warnings = eventsOfType(events, "runtime.warning");
        const completedTurns = eventsOfType(events, "turn.completed");

        assert.equal(waitingStates.length >= 1, true);
        assert.equal(warnings.length >= 1, true);
        assert.equal(
          String(warnings.at(-1)?.payload.message).includes("waiting for approval"),
          true,
        );
        assert.deepEqual(completedTurns.at(-1)?.payload, {
          state: "completed",
          stopReason: "waiting_for_approval",
        });
      } finally {
        fetchStub.restore();
        restoreEnv();
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("maps provider error status into an error state and failed turn", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const fetchStub = installFetchStub((call) => {
        if (
          call.method === "POST" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions"
        ) {
          return jsonResponse({
            session_id: "devin-session-5",
            url: "https://app.devin.ai/sessions/devin-session-5",
            status: "running",
            status_detail: "working",
          });
        }

        if (
          call.method === "GET" &&
          call.url === "https://api.example.test/v3/organizations/org-123/sessions/devin-session-5"
        ) {
          return jsonResponse({
            session_id: "devin-session-5",
            url: "https://app.devin.ai/sessions/devin-session-5",
            status: "error",
            status_detail: "error",
          });
        }

        if (
          call.method === "GET" &&
          call.url ===
            "https://api.example.test/v3/organizations/org-123/sessions/devin-session-5/messages?first=100"
        ) {
          return jsonResponse({
            items: [],
            end_cursor: null,
            has_next_page: false,
            total: 0,
          });
        }

        return jsonResponse({});
      });
      const restoreEnv = installDevinApiKey();

      try {
        const adapter = yield* DevinAdapter;
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-devin-error");

        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Do the task.",
          attachments: [],
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));

        const errorStates = eventsOfType(events, "session.state.changed").filter(
          (event) => event.payload.state === "error",
        );
        const completedTurns = eventsOfType(events, "turn.completed");

        assert.equal(errorStates.length >= 1, true);
        assert.deepEqual(completedTurns.at(-1)?.payload, {
          state: "failed",
          stopReason: "error",
        });
      } finally {
        fetchStub.restore();
        restoreEnv();
      }
    }).pipe(Effect.provide(harness.layer));
  });
});
