# Why T3Code Might Want Two Runtimes

_Local-first multi-agent desktop apps eventually become supervision problems._

The easy version of this conversation is "pick one runtime." The interesting version is:

> If T3Code wants to be local-first, maybe even local-only, multi-provider, stable under failure, and eventually capable of orchestrating subagents, which runtime should own supervision?

That is the question that matters.

Not "which language is cooler."

Not "which ecosystem is more fun."

Not even "which runtime is faster."

The answer I have landed on is this:

> Elixir becomes compelling when the app stops being "a JavaScript app that opens one coding session" and starts becoming "a supervised tree of local agent runtimes and subagents."
> Node still remains the pragmatic home for adapters, event mapping, desktop integration, and a lot of the surrounding product surface.

> **Note:** This was exercised locally as an architectural experiment. It is not evidence that T3Code has already "moved to Elixir."

## Quick Take

If you only want the short version, here it is:

- If T3Code stayed mostly Codex-first, desktop-centric, and one-session-at-a-time, I would stay much more Node-first.
- If T3Code grows into a true local multi-agent control plane with subagents, OTP starts solving problems that are structural rather than incidental.
- The most honest answer is not "Elixir instead of Node." It is a clean hybrid boundary.

This is the boundary I would actually defend:

```text
Elixir (supervision + connections)
├── Phoenix Channel WS server
├── Session GenServers (one per provider session)
├── Subagent supervision tree
├── HarnessSnapshot (in-memory read model)
└── Provider process management
    ├── codex (stdio JSON-RPC)
    ├── claude (stdio stream-json)
    ├── cursor (stdio ACP)
    └── opencode (HTTP + SSE)

          ◄── Phoenix Channel WS ──►

Node (intelligence + UI)
├── HarnessClientAdapter (WS bridge)
├── Canonical event mapping (TS)
├── OrchestrationEngine (event sourcing)
├── Browser/Electron WebSocket
├── SQLite persistence
└── Desktop integration
```

## The Real Problem

T3Code is not trying to be a generic backend that happens to expose a WebSocket.

It is trying to be a local-first, maybe local-only, app that has to manage:

- multiple providers (Codex, Claude, Cursor, OpenCode — each with different transport protocols)
- long-lived sessions
- reconnects and partial streams
- approvals and elicitation
- replay and rebuild
- eventually, subagents

That changes the architecture question.

Once you have several provider processes running locally, each with its own event stream, failure modes, and lifecycle, the job stops looking like "serve some HTTP" and starts looking like "supervise a tree of unstable runtimes."

That is the point where Elixir stops sounding like a side quest.

## What Elixir Actually Makes Better

The best case for Elixir is not generic throughput. It is not "the BEAM is cool." It is that OTP maps unusually well to the shape of this problem.

### 1. Session isolation stops being a convention

Each provider session is already its own unstable thing:

- a Codex app-server process speaking JSON-RPC over stdio
- a Claude runtime process speaking stream-json over stdio
- a Cursor ACP process with its own authentication and session model
- an OpenCode HTTP server with SSE event streaming

In OTP, each of those naturally becomes its own GenServer with its own mailbox, lifecycle, and restart boundary.

That matters because:

- one broken session does not poison siblings
- one degraded provider does not imply global instability
- one noisy or memory-heavy path is contained to its own process heap

This is the single strongest pro-Elixir argument.

### 2. Supervision trees look like the product

A local agent app increasingly looks like a supervision tree already:

```text
App
  -> Workspace
    -> Session
      -> Turn
      -> Connector
      -> Subagent
```

And once subagents are real, the fit gets even tighter:

```text
Thread
  -> Parent session (GenServer)
    -> Subagent A (GenServer → codex process)
    -> Subagent B (GenServer → opencode serve)
    -> Subagent C (GenServer → claude process)
```

At that point, "start child," "monitor child," "restart child," and "stop subtree" are not just architecture words. They are the product.

### 3. Concurrent waiting becomes normal

These apps spend a surprising amount of time waiting:

- provider stream open
- approval pending
- elicitation pending
- connector degraded
- replay rebuilding
- one subagent idle while another streams

OTP treats "many small independent things waiting at the same time" as normal. Node can do this too, but it usually does it by discipline. OTP does it by default.

### 4. Per-process GC quietly matters

Long-lived local tools accumulate state: stream buffers, replay buffers, tool outputs, pending approvals, subagent histories.

In the BEAM, each process owns its heap and its garbage collection. A badly behaved session is contained to its own process and less likely to make the whole app feel softer after a few hours of use.

### 5. Subagents make the argument much stronger

If T3Code stayed a one-agent-at-a-time tool, I would not push hard for Elixir.

Subagents change the math. They intensify:

- parent-child cancellation
- partial failure handling
- concurrent approvals across siblings
- concurrent streams from different providers
- nested delegation
- tree cleanup on parent abort

OTP stops feeling like architecture taste and starts feeling like the native operating model.

## What Elixir Does Not Fix

This is where Elixir fans usually get less disciplined than they should.

Introducing Elixir does **not** make Node disappear.

T3Code is still a TypeScript-shaped product:

- React frontend
- desktop shell concerns
- JS-native provider ecosystem
- local tooling integration
- adapter and event mapping logic (thousands of lines of TypeScript)

So the honest question is not "would Elixir be nice?"

It is:

> Is the supervision problem important enough to justify carrying a second runtime?

### Provider SDKs are npm packages

`@anthropic-ai/claude-agent-sdk` is a Node package. Julius's Claude adapter imports the SDK and uses its `query()` function directly — no bridge, no serialization, no second process. If a future provider SDK only offers a programmatic JS API with no CLI, Elixir cannot consume it natively.

Today the harness spawns provider binaries (`claude`, `codex`, `agent`, `opencode`), which is equivalent. But the SDK path is simpler when it exists.

### TypeScript types are the contract

The 46 `ProviderRuntimeEvent` types, the `OrchestrationCommand` schemas, the `WsPush` envelopes — all defined in TypeScript with Effect Schema. Event mapping (raw provider events to canonical types) is inherently a TypeScript problem because the types live there. Moving that to Elixir would mean duplicating or generating schemas across languages.

The 1,235-line `codexEventMapping.ts` and the 2,912-line `ClaudeAdapter.ts` are evidence: the intelligence layer is TypeScript-shaped regardless of where supervision lives.

### Electron is Node

Electron already bundles Node. The T3Code server runs as a child process inside Electron. Adding BEAM means spawning a second runtime, managing its lifecycle, and bundling it for macOS (arm64 + x64), Windows, and Linux. That is 50-100MB of additional binary size and another failure surface on user machines.

This is not ideological friction. It is shipping friction.

### The shared event loop is a real advantage

When the OrchestrationEngine receives an event, it persists to SQLite, updates the in-memory read model, and pushes to the browser — all in the same tick, zero serialization. With the harness, there is an extra hop: Elixir GenServer → Phoenix Channel → Node WebSocket → Effect Queue → OrchestrationEngine. That hop adds ~1ms and a failure mode (bridge disconnect).

For most operations that latency is invisible. But the failure mode is real: if the bridge drops during a streaming turn, events are lost until reconnection.

### One debugger, one stack trace

When something fails in Node, you get a continuous stack trace. With the harness, an error can start in Elixir (GenServer crash), manifest in Node (bridge disconnect), and surface in the browser (events stop). Debugging across two runtimes with two log systems is objectively harder.

### A bad hybrid is worse than a good single-runtime design

If the ownership boundary is vague, you get two runtimes, unclear authority, bridge complexity, and duplicated failure modes.

So if Elixir enters the picture, the boundary cannot be hand-wavy. It has to be sharp.

## The Boundary I Would Actually Defend

| Area                            | Best owner |
| :------------------------------ | :--------- |
| Session + subagent supervision  | Elixir     |
| Provider connection management  | Elixir     |
| Harness event streaming         | Elixir     |
| In-memory read model (snapshot) | Elixir     |
| Canonical event mapping         | Node       |
| Provider adapter logic          | Node       |
| SQLite persistence              | Node       |
| Browser/Electron WebSocket      | Node       |
| Desktop + product integration   | Node       |

The key point is simple:

> The best use of Elixir here is not "replace Node."
> It is "own the process tree."

## What the Local Experiments Actually Showed

This is where I want to stay disciplined, because architecture writing becomes dishonest very quickly when it starts claiming more than the repo really proves.

### What we verified end-to-end

All four providers ran through the Elixir harness with real prompts returning real responses:

| Provider | Transport                       | Events streamed             | Verified |
| -------- | ------------------------------- | --------------------------- | -------- |
| Claude   | stdio stream-json via `/bin/sh` | 20 events, responded "Four" | Yes      |
| Codex    | stdio JSON-RPC via Erlang Port  | 48 events, full turn cycle  | Yes      |
| Cursor   | stdio ACP via Erlang Port       | 7 events, turn complete     | Yes      |
| OpenCode | HTTP + SSE via raw TCP + Req    | 21+ events, SSE streaming   | Yes      |

The full pipeline:

```text
Node WS client
  → Phoenix Channel (join "harness:lobby")
    → SessionManager routes to GenServer
      → GenServer spawns provider process
        → Provider streams events back
          → SnapshotServer projects into HarnessSnapshot
            → PubSub broadcasts
              → Channel pushes to Node
```

Along the way, we hit and solved real implementation problems:

- Erlang Ports with `{:spawn_executable}` and `{:line, N}` send `{:eol, line}` tuples, while `{:spawn, cmd}` sends raw binary. Every GenServer must handle both.
- Claude's `--print` mode reads stdin by default, causing a 3-second hang. Fix: spawn via `/bin/sh -c "... < /dev/null"`.
- Codex uses internal UUIDs for thread IDs, not our harness IDs. Must capture from `thread/start` response.
- Cursor's ACP `session/prompt` expects a structured array `[{type: "text", text: "..."}]`, not a plain string.
- OpenCode's SSE uses chunked transfer encoding that neither `:httpc` nor Req deliver reliably for streaming. Raw `:gen_tcp` with regex extraction of `data: {json}` patterns works.
- Background processes (like SSE listeners) must use `spawn` + `Process.monitor`, not `spawn_link`, to prevent crash cascading to the parent GenServer.

Those are not theoretical findings. They are the kind of things you only learn by running real provider processes through a real supervision tree.

The harness includes a CLI (`bin/harness`) that can start all four providers, run a dry-run across them, query the live snapshot, and manage sessions — a full local control plane in a single command.

### What would be misleading to claim

- T3Code has moved to Elixir (it has not)
- Elixir has replaced Node (Node still owns all the intelligence)
- The OTP path is production-landed (it is a local prototype)
- The repo proves Elixir is strictly better (it proves the hybrid boundary works)

The right sentence is still:

> This was exercised locally as an architectural experiment, with real provider processes producing real responses through the Elixir harness.

## The Tradeoff in One Table

| Dimension             | Elixir/OTP                       | Node/TypeScript                            |
| :-------------------- | :------------------------------- | :----------------------------------------- |
| Session supervision   | Native fit                       | Possible, but more manual                  |
| Failure isolation     | Structural (BEAM processes)      | Behavioral (requires explicit boundaries)  |
| Subagent trees        | DynamicSupervisor.start_child    | Manual cleanup chains                      |
| Per-process GC        | Independent heaps, microsecond   | Shared V8 heap, stop-the-world             |
| Adding a new provider | ~500 lines GenServer             | ~2,000-3,000 lines adapter                 |
| Desktop packaging     | Adds 50-100MB BEAM runtime       | No additional overhead                     |
| JS-native ecosystem   | Weaker (must spawn as processes) | Stronger (can import as packages)          |
| Event mapping         | Stays in TypeScript              | Stays in TypeScript                        |
| Hybrid risk           | Can split if boundary is vague   | Avoids dual runtime, centralizes more risk |

## Why Subagents Change the Calculus

This is the section where my opinion becomes less neutral.

Subagents are the breakpoint.

Imagine a future session like this:

```text
Parent task
  -> Codex subagent for implementation
  -> OpenCode subagent for search
  -> Claude subagent for synthesis
```

Now ask the annoying questions:

- What happens if one subagent crashes mid-turn?
- What happens if one subagent is blocked on approval while another keeps streaming?
- What happens if the parent cancels and all children must stop cleanly?
- What happens if one child leaks memory or gets wedged on reconnect?

A Node-only architecture can answer them, but it answers them behaviorally: careful process accounting, careful cleanup chains, careful shared-state discipline.

OTP gives you a stronger starting point because it already assumes the world is made of many small, failure-prone processes that need supervision. Each subagent is a GenServer under a DynamicSupervisor. Parent crash cascades to children via process links. One child's memory leak is contained to its own heap. Restart policies are declarative, not imperative.

That is why subagents materially strengthen the pro-Elixir case.

## I Ran a Structured Multi-Perspective Review

I did not want this to read like "I like OTP, therefore OTP wins."

So I ran a structured multi-perspective review using AI agents assigned to challenge the framing from different angles: one argued the strongest case for OTP, one argued the strongest case for staying Node-first, and one argued the strongest case for not overstating what the repo actually proves.

That changed the piece in useful ways.

### Best argument for OTP

> If the system becomes a tree of unstable local runtimes, OTP is not a fancy optimization. It is the native operating model.

### Best argument for staying Node-first

> If you do not actually get to delete Node, then Elixir is a second runtime, not a replacement runtime, and that cost must be justified.

That objection is healthy. It is why the honest conclusion is not "rewrite T3Code in Elixir."

### Best warning against overstating the experiment

> Do not claim more than the experiment actually proved.

The local experiments are meaningful — four providers, real responses, real streaming. They are not the same thing as a finished migration.

## So, Should T3Code Use Elixir Instead of Node?

Two questions keep this honest:

**"What concrete failures become simpler in OTP?"** — If the answer is vague, Elixir is aesthetic preference. It becomes compelling when it cashes out into session isolation, subagent trees, cancellation cascades, and concurrent blocked workflows.

**"What existing Node responsibilities actually disappear?"** — Almost none. Event mapping, adapter logic, desktop integration, SQLite writes — all stay. The win is clarified ownership, not deletion of Node.

So I would not argue for replacing the whole backend or pretending the JS ecosystem no longer matters.

## Final Take

If T3Code remained just "a TypeScript app that opens one coding session," I would not push hard for Elixir.

If T3Code becomes "a supervised tree of local agent runtimes and subagents," the argument changes.

That is when Elixir stops being a nice-to-have and starts becoming one of the most natural runtimes for the control plane.

But even then, Node does not go away. It still matters because the product still lives in a JS-shaped world.

The position I would actually stand behind:

> Elixir owns the process tree. Node owns the intelligence.

That is not a purity argument. It is a boundary argument.
