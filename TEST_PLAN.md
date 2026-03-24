# Test Plan

## Current Snapshot

- Test files discovered: `113`
- Source files discovered across primary app/package targets: `311`
- Existing coverage is strong in pure utilities, schema/contracts, and several server orchestration paths.
- Largest remaining risks are shared boundary code that is only covered indirectly: provider startup compatibility, event-stream correctness, persistence/projection recovery, path/security helpers, and high-value UI interaction flows.

## Priority 0

- `apps/server` provider startup and compatibility gates
  - Cover `codexCliVersion.ts`, provider health probes, auth-status parsing, startup/resume compatibility failures, and account/model selection.
  - Focus on deterministic unit tests around version parsing, CLI output normalization, prerelease ordering, and explicit fail-fast messages.
- `apps/server` orchestration correctness
  - Expand tests for `ProviderRuntimeIngestion`, `ProviderCommandReactor`, `ProjectionPipeline`, `OrchestrationEngine`, and `ProjectionSnapshotQuery`.
  - Exercise duplicate events, restart/bootstrap recovery, per-thread routing, idempotency, and bounded-memory behavior.
- `apps/server` WebSocket protocol robustness
  - Add unit/integration coverage for raw frame decoding, malformed payloads, large payload rejection, reconnection behavior, and attachment/static path safety.
  - Include UTF-8 multibyte chunk boundaries and websocket message lifecycle error handling.
- `apps/server` persistence and checkpointing
  - Cover migration sequencing, transaction boundaries, projection replay consistency, checkpoint diff storage, and decode-vs-SQL error mapping.

## Priority 1

- `apps/server` Git, terminal, and filesystem boundaries
  - Add tests for braced rename parsing, shell/path recovery, PTY startup races, open-in-editor path handling, and attachment path normalization.
- `apps/web` state and orchestration projection logic
  - Expand tests for stores, history bootstrap, pending input/approval flows, thread selection, terminal context projection, and project script/keybinding state.
- `apps/web` critical interaction components
  - Add browser or component tests for composer send state, branch toolbar synchronization, sidebar width persistence, terminal drawer behavior, and provider/model controls.
- `apps/desktop`
  - Extend update-machine and shell-env coverage with launch-time edge cases, platform branching, and failure recovery.

## Priority 2

- `packages/shared` and `packages/contracts`
  - Keep schema/runtime utility coverage near complete; add only for new branches or regressions.
- `apps/marketing`
  - Limit to smoke/build regressions and release-path checks.
- End-to-end and soak coverage
  - Add targeted long-running scenarios for reconnects, session resume, partial provider streams, and concurrent project/thread activity once the lower layers are stable.

## Test Matrix

- Unit tests for pure transforms, parsers, normalizers, schema adapters, and error mapping.
- Service-layer integration tests for Effect services, persistence, provider adapters, and websocket routing.
- Browser/component tests for UI behaviors where DOM state or user interaction matters.
- Focused regression tests for every bug fixed from `.plans/16c-pr89-remediation-checklist.md`.

## Immediate Queue

1. Add direct tests for `apps/server/src/provider/codexCliVersion.ts`.
2. Add regression coverage for websocket multibyte UTF-8 chunk decoding in `apps/server/src/wsServer.ts`.
3. Add direct path traversal and normalization tests for `apps/server/src/attachmentPaths.ts`.
4. Add regression tests for git braced rename parsing in `apps/server/src/git/Layers/GitCore.ts`.
5. Add bounded-state tests for `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
