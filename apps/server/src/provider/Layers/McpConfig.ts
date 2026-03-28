/**
 * McpConfigServiceLive - In-memory MCP configuration resolution and snapshot layer.
 *
 * Currently a stub that returns empty configs. The resolution pipeline
 * (project config, workspace config, provider overrides) will be fleshed out
 * in a future task. What matters now is the service interface, wiring, and
 * persistence model.
 *
 * Persistence: The `mcpConfigVersion` hash is stored in `runtime_payload_json`
 * (which lives in the existing `provider_session_runtime` table). Diagnostic
 * snapshots are held in-memory in this service, keyed by thread ID.
 *
 * @module McpConfigServiceLive
 */
import type { ResolvedMcpConfig } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { McpConfigService, type McpConfigServiceShape } from "../Services/McpConfig.ts";

/**
 * Build an empty resolved config with a deterministic version hash.
 */
function makeEmptyResolvedConfig(): ResolvedMcpConfig {
  const resolvedAt = new Date().toISOString() as ResolvedMcpConfig["resolvedAt"];
  return {
    version: "empty-0" as ResolvedMcpConfig["version"],
    servers: [],
    resolvedAt,
  };
}

const makeMcpConfigService = Effect.gen(function* () {
  const snapshots = new Map<string, ResolvedMcpConfig>();

  const resolveConfig: McpConfigServiceShape["resolveConfig"] = (params) =>
    Effect.sync(() => {
      // Stub: return empty config for all providers.
      // Claude manages its own MCP natively through the Agent SDK;
      // the empty config is intentional and the ClaudeAdapter translator
      // will return null for it.
      const config = makeEmptyResolvedConfig();

      // Store diagnostic snapshot keyed by threadId if provided.
      if (params.threadId) {
        snapshots.set(params.threadId, config);
      }

      return config;
    });

  const getSnapshot: McpConfigServiceShape["getSnapshot"] = (threadId) =>
    Effect.sync(() => snapshots.get(threadId) ?? null);

  return {
    resolveConfig,
    getSnapshot,
  } satisfies McpConfigServiceShape;
});

export const McpConfigServiceLive = Layer.effect(McpConfigService, makeMcpConfigService);
