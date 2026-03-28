/**
 * McpConfigService - Service interface for MCP (Model Context Protocol) configuration
 * resolution and snapshot management.
 *
 * Resolves per-provider MCP server configurations and maintains in-memory
 * diagnostic snapshots keyed by thread ID. The `mcpConfigVersion` hash is
 * persisted in `runtime_payload_json` via the existing `provider_session_runtime`
 * table for change-detection across sessions.
 *
 * **Claude special case**: Claude manages its own MCP configuration natively
 * through the Agent SDK. The resolver returns an empty config for Claude,
 * leaving the ClaudeAdapter translator to decide how to handle it.
 *
 * @module McpConfigService
 */
import type { ProviderKind, ResolvedMcpConfig } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { McpConfigError } from "../Errors.ts";

/**
 * McpConfigServiceShape - Service API for MCP config resolution and snapshots.
 */
export interface McpConfigServiceShape {
  /**
   * Resolve the MCP configuration for a provider session.
   *
   * The resolution pipeline (project config, workspace config, provider overrides)
   * is currently a stub that returns an empty config. The service interface and
   * persistence wiring are the important parts; resolution logic will be fleshed
   * out in a future task.
   */
  readonly resolveConfig: (params: {
    readonly provider: ProviderKind;
    readonly cwd: string;
    readonly threadId?: string;
  }) => Effect.Effect<ResolvedMcpConfig, McpConfigError>;

  /**
   * Retrieve the most recently resolved config snapshot for a thread.
   *
   * Returns null if no config has been resolved for the given thread.
   */
  readonly getSnapshot: (threadId: string) => Effect.Effect<ResolvedMcpConfig | null, never>;
}

/**
 * McpConfigService - Service tag for MCP config resolution.
 */
export class McpConfigService extends ServiceMap.Service<McpConfigService, McpConfigServiceShape>()(
  "t3/provider/Services/McpConfig/McpConfigService",
) {}
