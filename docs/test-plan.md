# Test Plan

## Goals

- Protect the highest-risk behavior first: provider lifecycle, orchestration correctness, persistence integrity, and UI state recovery.
- Favor fast deterministic tests for pure logic and protocol mapping before adding broader integration coverage.
- Keep failures actionable by testing package boundaries where behavior changes, not just implementation details.

## Current Snapshot

- Monorepo areas: `apps/server`, `apps/web`, `apps/desktop`, `apps/harness`, `packages/contracts`, `packages/shared`, `scripts`.
- Existing automated coverage is strongest in schema validation, store logic, websocket flows, and selected UI logic.
- Rough gap scan:
  - `113` existing `*.test.*` files across `apps/`, `packages/`, and `scripts/`
  - `311` non-test source files under the main TypeScript packages/apps
  - `198` source files without an adjacent test file

## Priority Order

### P0: Runtime correctness and data integrity

- `apps/server/src/orchestration/*`
  - Command invariants, decider/projector transitions, projection pipeline ordering, runtime receipt handling, checkpoint reactor behavior.
- `apps/server/src/persistence/*`
  - Migration idempotency, projection writes, event store reads, checkpoint/thread/session persistence invariants.
- `apps/server/src/provider/Layers/*`
  - Codex/Claude/Harness event mapping, approval/user-input handling, degraded runtime behavior, provider health checks.
- `apps/server/src/codexAppServerManager.ts`
  - Session bootstrap/resume, version gate failures, reconnect/restart behavior, partial-stream recovery.

### P1: API boundaries and transport reliability

- `apps/server/src/wsServer.ts` and `apps/server/src/wsServer/readiness.ts`
  - Ready-state gating, push ordering, malformed input handling, auth rejection, RPC routing invariants.
- `apps/server/src/processRunner.ts`, `apps/server/src/open.ts`, `apps/server/src/workspaceEntries.ts`
  - Shell/process failures, path safety, filesystem search limits, gitignore behavior.
- `packages/contracts/src/*`
  - Schema compatibility for protocol payloads and model/provider contracts whenever contract surfaces change.

### P2: Client state predictability

- `apps/web/src/store.ts`, `apps/web/src/session-logic.ts`, `apps/web/src/historyBootstrap.ts`, `apps/web/src/wsTransport.ts`
  - Reconnect bootstrap, optimistic updates, pending approvals/user input, terminal state cleanup, diff caching.
- `apps/web/src/lib/*`
  - Storage, timestamp formatting, project query helpers, terminal focus/context behavior, route parsing.
- `apps/web/src/components/*logic*.ts`
  - Selection, toolbar state, composer send-state, timeline calculations, project script controls.

### P3: UI rendering and desktop shell edges

- `apps/web/src/components/**/*.tsx`
  - Browser tests for high-value interactive paths: composer, timeline, sidebar, approvals, project/thread navigation.
- `apps/desktop/src/*`
  - Update flows, preload bridge contracts, environment sync, confirm dialog behavior.
- `scripts/*.ts`
  - Utility and release scripts that transform artifacts or orchestrate environments.

## Test Matrix By Layer

- Unit tests
  - Pure helpers, normalization logic, sorting/ranking, version parsing, storage wrappers, timestamp formatting.
- Integration tests
  - Provider adapters, websocket server flows, orchestration + persistence pipelines, checkpoint projections.
- Browser/component tests
  - Critical interaction flows in `apps/web` that depend on DOM behavior.
- Smoke/system tests
  - Existing desktop smoke flow and selected server/provider harness scenarios.

## Execution Strategy

1. Expand pure unit coverage around untested runtime gates and normalization helpers.
2. Add integration tests for failure handling at server boundaries before broadening UI tests.
3. Add browser tests only for flows where rendering materially affects correctness.
4. Keep every new bugfix or feature paired with a narrow regression test in the nearest package.

## First Test To Implement

- Target: `apps/server/src/provider/codexCliVersion.ts`
- Why first:
  - It gates whether Codex sessions can start at all.
  - The code is pure and currently untested, so coverage is cheap and high-signal.
  - Semver parsing and prerelease ordering are classic regression points.
- Minimum assertions:
  - parse noisy CLI output
  - normalize two-segment versions like `0.37`
  - compare prerelease vs stable versions correctly
  - enforce `MINIMUM_CODEX_CLI_VERSION`
  - format the upgrade error message consistently

## Required Validation

Run before closing work:

```bash
bun fmt
bun lint
bun typecheck
```
