# Cursor ACP Protocol Schema Reference

> Sourced from live CLI probing of `cursor agent acp`.
> **CLI Version:** `2026.03.30-a5d3e17`
> **IDE Version:** `2.6.22` (arm64)
> **Probed:** 2026-03-31 (ACP protocol), 2026-04-06 (CLI surface + models)
> **Transport:** Standard JSON-RPC 2.0 over stdio (ndjson, one JSON object per line)
> **Protocol Version:** 1

---

## CLI Surface (updated 2026-04-06)

The `cursor agent` CLI has matured significantly beyond the initial `--print` tool. The CLI now exposes configuration that previously required the ACP protocol.

### Invocation Modes

| Mode | Command | Description |
|------|---------|-------------|
| Interactive (TUI) | `cursor agent` | Full TUI with chat, tools, approvals |
| Interactive + prompt | `cursor agent "fix the bug"` | TUI with initial prompt |
| Headless (print) | `cursor agent -p "fix the bug"` | Non-interactive, stdout output |
| Cloud | `cursor agent -c` | Opens composer picker |
| Plan mode | `cursor agent --mode plan` or `--plan` | Read-only analysis |
| Ask mode | `cursor agent --mode ask` | Q&A, no edits |
| Resume | `cursor agent --resume [chatId]` | Resume specific session |
| Continue | `cursor agent --continue` | Continue last session |

### CLI Flags (complete list)

**Authentication:**
| Flag | Description |
|------|-------------|
| `--api-key <key>` | Cursor **User API Key** (also `CURSOR_API_KEY` env var). Alternative to `cursor agent login` (browser OAuth) for headless/CI auth. Generated at `cursor.com/settings` → Integrations → User API Keys. Bills to Cursor subscription, NOT a provider key. Admin API Keys do not work — only User API Keys. BYOK (provider keys like OpenAI `sk-*`) is a separate desktop-only feature and cannot be passed here. |
| `-H, --header <header>` | Custom header on agent requests (repeatable, format: `'Name: Value'`). |

**Output:**
| Flag | Description |
|------|-------------|
| `-p, --print` | Headless mode — print to stdout, full tool access |
| `--output-format <fmt>` | `text` (default), `json`, or `stream-json` (with `--print`) |
| `--stream-partial-output` | Stream text deltas individually (with `--print` + `stream-json`) |

**Session:**
| Flag | Description |
|------|-------------|
| `--resume [chatId]` | Resume specific session |
| `--continue` | Continue previous session |
| `--model <model>` | Model selection (e.g., `gpt-5`, `sonnet-4`, `sonnet-4-thinking`) |
| `--list-models` | List available models and exit |
| `--mode <mode>` | Execution mode: `plan` (read-only) or `ask` (Q&A) |
| `--plan` | Shorthand for `--mode=plan` (ignored with `--cloud`) |
| `-c, --cloud` | Cloud mode (composer picker) |

**Trust & Permissions:**
| Flag | Description |
|------|-------------|
| `-f, --force` / `--yolo` | Auto-approve commands unless explicitly denied |
| `--sandbox <mode>` | `enabled` or `disabled` (overrides config) |
| `--approve-mcps` | Auto-approve all MCP servers |
| `--trust` | Trust workspace without prompt (headless only) |

**Workspace:**
| Flag | Description |
|------|-------------|
| `--workspace <path>` | Custom workspace directory (default: cwd) |
| `-w, --worktree [name]` | Isolated git worktree at `~/.cursor/worktrees/<repo>/<name>` |
| `--worktree-base <branch>` | Branch to base worktree on (default: HEAD) |
| `--skip-worktree-setup` | Skip `.cursor/worktrees.json` setup scripts |

### Subcommands

| Command | Description |
|---------|-------------|
| `agent [prompt...]` | Start the agent (default) |
| `login` | Authenticate with Cursor (set `NO_OPEN_BROWSER` to disable browser) |
| `logout` | Sign out and clear auth |
| `status` / `whoami` | View auth status |
| `models` | List available models |
| `about` | Version, system, account info |
| `update` | Self-update cursor agent |
| `create-chat` | Create empty chat, return ID |
| `ls` | Browse chat sessions for resume (interactive) |
| `resume` | Resume latest chat |
| `mcp` | MCP server management (see below) |
| `generate-rule` / `rule` | Interactive Cursor rule generation |
| `install-shell-integration` | Install shell integration to `~/.zshrc` |
| `uninstall-shell-integration` | Remove shell integration |

### MCP Subcommands (`cursor agent mcp`)

| Command | Description |
|---------|-------------|
| `login <identifier>` | Authenticate with MCP server from `.cursor/mcp.json` |
| `list` | List configured MCP servers and their status |
| `list-tools <identifier>` | List available tools for a specific MCP |
| `enable <identifier>` | Add MCP server to local approved list |
| `disable <identifier>` | Disable an MCP server |

### Available Models (as of 2026-04-06)

85+ models available. Key families:

| Family | Models | Notes |
|--------|--------|-------|
| **Auto** | `auto` | Default, Cursor selects model |
| **Composer** | `composer-2-fast` (default), `composer-2`, `composer-1.5` | Cursor's own models |
| **GPT-5.4** | low/medium/high/xhigh + fast variants | 1M context, reasoning levels |
| **GPT-5.4 Mini** | none/low/medium/high/xhigh | Smaller, faster |
| **GPT-5.4 Nano** | none/low/medium/high/xhigh | Smallest GPT-5.4 |
| **GPT-5.3 Codex** | low/medium/high/xhigh + fast variants | Code-optimized |
| **GPT-5.3 Codex Spark** | low/medium/high/xhigh (preview) | New Spark series |
| **GPT-5.2 Codex** | low/medium/high/xhigh + fast variants | Previous gen |
| **GPT-5.2** | low/medium/high/xhigh + fast variants | General |
| **GPT-5.1** | low/medium/high | Older gen |
| **GPT-5.1 Codex Max** | low/medium/high/xhigh + fast | Previous code-optimized |
| **GPT-5.1 Codex Mini** | low/medium/high | Compact code model |
| **GPT-5 Mini** | `gpt-5-mini` | Legacy |
| **Claude 4.6** | `claude-4.6-opus-high`, `opus-max`, `opus-high-thinking`, `opus-max-thinking`, `sonnet-medium`, `sonnet-medium-thinking` | 1M context |
| **Claude 4.5** | `claude-4.5-opus-high`, `opus-high-thinking`, `sonnet`, `sonnet-thinking` | 1M context |
| **Claude 4** | `claude-4-sonnet`, `4-sonnet-1m`, `4-sonnet-thinking`, `4-sonnet-1m-thinking` | |
| **Gemini** | `gemini-3.1-pro`, `gemini-3-flash` | Google models |
| **Grok** | `grok-4-20`, `grok-4-20-thinking` | xAI models |
| **Kimi** | `kimi-k2.5` | Moonshot model |

**Model ID format:** The CLI model IDs use a flat slug format (`claude-4.6-opus-high-thinking`) while the ACP protocol uses a bracketed parameter format (`claude-opus-4-6[thinking=true,context=200k,effort=high]`). The CLI accepts flat slugs and translates internally.

---

## Meta

| Field | Value |
|-------|-------|
| Wire format | Standard JSON-RPC 2.0 (`{"jsonrpc":"2.0", ...}`) |
| Framing | Newline-delimited JSON (ndjson) — one message per line |
| ID type | Integer (auto-incrementing, matches request↔response) |
| Spawn command | `cursor agent acp` (args: `["agent", "acp"]`) |
| Protocol version | `1` (sent in `initialize`, echoed in response) |

---

## Lifecycle State Machine

```
spawn("cursor", ["agent", "acp"])
  │
  ├─► initialize ──────────► { agentCapabilities, authMethods }
  │
  ├─► authenticate ─────────► {} (empty = success)
  │
  ├─► session/new ──────────► { sessionId, modes, models, configOptions }
  │   ◄── session/update (available_commands_update)  [unsolicited]
  │
  │   ┌─── READY ───────────────────────────────────────────────┐
  │   │                                                         │
  │   ├─► session/prompt ──► session/update stream ──► { stopReason }
  │   │   ◄── agent_thought_chunk (reasoning)                   │
  │   │   ◄── agent_message_chunk (assistant text)              │
  │   │   ◄── tool_call / tool_call_update                      │
  │   │   ◄── session/request_permission (approval)             │
  │   │   ◄── session/elicitation (user input)                  │
  │   │   ◄── cursor/ask_question (multi-option)                │
  │   │   ◄── cursor/create_plan / cursor/update_todos          │
  │   │                                                         │
  │   ├─► session/cancel (notification) ──► { stopReason: "cancelled" }
  │   │                                                         │
  │   ├─► session/set_config_option ──► { configOptions }       │
  │   ├─► session/set_mode ──► {}                               │
  │   │   ◄── session/update (current_mode_update) [unsolicited]│
  │   ├─► session/set_model ──► {}                              │
  │   │                                                         │
  │   ├─► session/load ──► { modes, models, configOptions }     │
  │   │   ◄── session/update (available_commands_update)        │
  │   └────────────────────────────────────────────────────────┘
  │
  └─► Process closes → cleanup
```

---

## Agent Methods (Client → Agent)

### `initialize`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": {
      "readTextFile": false,
      "writeTextFile": false
    },
    "terminal": false
  },
  "clientInfo": {
    "name": "my-client",
    "version": "1.0.0"
  }
}
```

**Response result:**

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": {
      "http": true,
      "sse": true
    },
    "promptCapabilities": {
      "audio": false,
      "embeddedContext": false,
      "image": true
    }
  },
  "authMethods": [
    {
      "id": "cursor_login",
      "name": "Cursor Login",
      "description": "Authenticate using..."
    }
  ]
}
```

**Notes:**
- `agentCapabilities` is flat (not nested)
- `authMethods` is top-level
- Setting `fs` and `terminal` capabilities to `true` enables `fs/*` and `terminal/*` callback methods (agent → client)

---

### `authenticate`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "methodId": "cursor_login"
}
```

**Response result:**

```json
{}
```

**Notes:**
- Requires `cursor agent login` to have been run first (or `--api-key` flag)

---

### `session/new`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "cwd": "/path/to/workspace",
  "mcpServers": []
}
```

**Response result:**

```json
{
  "sessionId": "uuid-string",
  "modes": {
    "currentModeId": "agent",
    "availableModes": [
      {
        "id": "agent",
        "name": "Agent",
        "description": "Full agent capabilities with tool access"
      },
      { "id": "plan", "name": "Plan", "description": "Read-only mode..." },
      { "id": "ask", "name": "Ask", "description": "Q&A mode..." }
    ]
  },
  "models": {
    "currentModelId": "default[]",
    "availableModels": [
      { "modelId": "default[]", "name": "Auto" }
    ]
  },
  "configOptions": [
    {
      "id": "mode",
      "name": "Mode",
      "description": "Controls how...",
      "category": "mode",
      "type": "select",
      "currentValue": "agent",
      "options": [
        { "value": "agent", "name": "Agent", "description": "Full agent..." }
      ]
    },
    {
      "id": "model",
      "name": "Model",
      "description": "Controls which model...",
      "category": "model",
      "type": "select",
      "currentValue": "default[]",
      "options": []
    }
  ]
}
```

**Side effects:**
- Emits unsolicited `session/update` notification with `available_commands_update` after response

---

### `session/load`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "sessionId": "uuid-string",
  "cwd": "/path/to/workspace",
  "mcpServers": []
}
```

**Response result:**

```json
{
  "modes": {},
  "models": {},
  "configOptions": []
}
```

**Notes:**
- Does NOT return `sessionId` (you already have it)
- `currentModelId` reflects any model changes from prior session
- Emits `available_commands_update` after response (same as session/new)
- `mcpServers` is **required** (omitting returns `-32603` with `invalid_type`)

---

### `session/prompt`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "sessionId": "uuid-string",
  "prompt": [
    {
      "type": "text",
      "text": "user message"
    }
  ]
}
```

**Response result:**

```json
{
  "stopReason": "end_turn"
}
```

**Notes:**
- `prompt` is an **array of content items**, NOT a string
- `stopReason` is `"end_turn"` or `"cancelled"`
- Response arrives AFTER all `session/update` streaming is complete

---

### `session/cancel`

**Type:** Notification (no `id` field, no response)
**Wire-verified:** Yes

**Params:**

```json
{
  "sessionId": "uuid-string"
}
```

**Behavior:**
- The in-flight `session/prompt` request responds with `{"stopReason": "cancelled"}`
- Some streaming notifications may arrive between cancel and the prompt response
- If no prompt is in-flight, cancel is silently ignored

---

### `session/set_config_option`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "sessionId": "uuid-string",
  "configId": "model",
  "value": "gpt-5.4-mini[reasoning=medium]"
}
```

**Response result:**

```json
{
  "configOptions": []
}
```

**Notes:**
- Parameter is `configId` (NOT `optionId`)
- Returns full updated `configOptions` array

---

### `session/set_mode`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "sessionId": "uuid-string",
  "modeId": "plan"
}
```

**Response result:**

```json
{}
```

**Side effects:**
- Emits `session/update` with `current_mode_update` BEFORE the response

---

### `session/set_model`

**Type:** Request
**Wire-verified:** Yes

**Request params:**

```json
{
  "sessionId": "uuid-string",
  "modelId": "composer-2[fast=true]"
}
```

**Response result:**

```json
{}
```

---

### Methods NOT found via ACP (return `-32601`)

These methods are **not implemented** in the ACP protocol as of `2026.03.30-a5d3e17`:

| Method | Error | CLI alternative? |
|--------|-------|-----------------|
| `session/list` | `"Method not found"` | `cursor agent ls` (TUI-only) |
| `session/fork` | `"Method not found"` | None |
| `session/resume` | `"Method not found"` | `cursor agent --resume [chatId]` / `--continue` |
| `session/close` | `"Method not found"` | None |
| `logout` | `"Method not found"` | `cursor agent logout` |

---

## Client Methods (Agent → Client)

### `session/update` (Notification)

**Type:** Notification (no `id`)
**Wire-verified:** Yes

**Params envelope:**

```json
{
  "sessionId": "uuid-string",
  "update": {
    "sessionUpdate": "<discriminant>",
    // ... variant-specific fields
  }
}
```

**Discriminant is a string**, not an object with `_tag`.

#### Variant: `agent_thought_chunk`

```json
{
  "sessionUpdate": "agent_thought_chunk",
  "content": {
    "type": "text",
    "text": "token"
  }
}
```

- Only emitted by reasoning-capable models
- Streams BEFORE `agent_message_chunk` in the same turn

#### Variant: `agent_message_chunk`

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": {
    "type": "text",
    "text": "token"
  }
}
```

- Streams after `agent_thought_chunk` (if present)

#### Variant: `tool_call`

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call_...",
  "title": "Read File",
  "kind": "read",
  "status": "pending",
  "rawInput": {}
}
```

**`kind` values observed:**

| kind | Description |
|------|-------------|
| `"shell"` | Shell/terminal command |
| `"file_edit"` | File modification |
| `"file_read"` / `"read"` | File read |
| `"mcp"` | MCP tool call |

#### Variant: `tool_call_update`

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_...",
  "status": "in_progress",
  "rawOutput": {
    "content": "file contents..."
  }
}
```

**Status transitions:** `pending` → `in_progress` → `completed`
- `rawOutput` is an **object with `content` key**, NOT a raw string
- `rawOutput` only present on `completed` status

#### Variant: `available_commands_update`

```json
{
  "sessionUpdate": "available_commands_update",
  "availableCommands": [
    { "name": "copy-request-id", "description": "Copy the last request ID to clipboard" },
    { "name": "canvas", "description": ">- (builtin skill)" }
  ]
}
```

- Pushed unsolicited after `session/new` and `session/load`
- Includes builtin + user-defined skills from `.cursor/`

#### Variant: `current_mode_update`

```json
{
  "sessionUpdate": "current_mode_update",
  "currentModeId": "plan"
}
```

#### Variant: `plan`

```json
{
  "sessionUpdate": "plan",
  "entries": [
    { "content": "Step description", "status": "pending" }
  ]
}
```

#### Variant: `user_message_chunk`

Echoed user input. Should be ignored.

---

### `session/request_permission` (Request)

**Type:** Request (agent → client, expects response)
**Wire-verified:** Yes

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "requestId": "req_...",
    "toolName": "shell",
    "command": "ls -la"
  }
}
```

**Response (approve):**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "decision": "accept"
  }
}
```

Decisions: `"accept"` | `"reject"`

---

### `session/elicitation` (Request)

**Type:** Request (agent → client)
**Wire status:** Not yet wire-verified

Structured user input form — schema TBD.

---

### `cursor/ask_question` (Request)

**Type:** Request (agent → client, Cursor extension)

```json
{
  "method": "cursor/ask_question",
  "params": {
    "toolCallId": "call_...",
    "title": "Question title",
    "questions": [
      {
        "id": "q1",
        "prompt": "Which option?",
        "options": [
          { "id": "opt1", "label": "Option A" },
          { "id": "opt2", "label": "Option B" }
        ],
        "allowMultiple": false
      }
    ]
  }
}
```

---

### `cursor/create_plan` (Request)

**Type:** Request (agent → client, Cursor extension)

```json
{
  "method": "cursor/create_plan",
  "params": {
    "toolCallId": "call_...",
    "name": "Plan name",
    "overview": "Plan overview",
    "plan": "Plan description",
    "todos": [
      { "id": "todo1", "content": "Todo text", "title": "Todo title", "status": "pending" }
    ],
    "phases": []
  }
}
```

---

### `cursor/update_todos` (Notification)

**Type:** Notification (Cursor extension)

```json
{
  "method": "cursor/update_todos",
  "params": {
    "toolCallId": "call_...",
    "todos": [],
    "merge": true
  }
}
```

---

### `fs/*` and `terminal/*` Client Callbacks

**Type:** Request (agent → client)

These are only sent if the corresponding capabilities are advertised in `initialize`:

| Method | Purpose |
|--------|---------|
| `fs/read_text_file` | Read file through client |
| `fs/write_text_file` | Write file through client |
| `terminal/create` | Create terminal |
| `terminal/output` | Read terminal output |
| `terminal/wait_for_exit` | Wait for exit |
| `terminal/kill` | Kill terminal |
| `terminal/release` | Release handle |

**Error response when unsupported:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "fs operations not supported"
  }
}
```

---

## mcpServers Schema

The `mcpServers` field in `session/new` and `session/load` is a **required array** of a **discriminated union** with 3 variants. The discriminant is the `type` field.

### Variant: `http`

```json
{
  "name": "server-name",
  "type": "http",
  "url": "http://host:port/path",
  "headers": [
    { "key": "Authorization", "value": "Bearer ..." }
  ]
}
```

### Variant: `sse`

```json
{
  "name": "server-name",
  "type": "sse",
  "url": "http://host:port/sse",
  "headers": [
    { "key": "Authorization", "value": "Bearer ..." }
  ]
}
```

### Variant: `command` (stdio)

```json
{
  "name": "server-name",
  "type": "command",
  "command": "npx",
  "args": ["-y", "@server/mcp"],
  "env": [
    { "key": "API_KEY", "value": "..." }
  ]
}
```

**Key schema notes:**
- Discriminant is `type`, not `transport`
- `type: "command"` for stdio (not `"stdio"`)
- `headers` and `env` are arrays of `{key, value}` objects, not `Record<string, string>`

---

## ConfigOption Schema

```typescript
interface ConfigOption {
  id: string;               // "mode" | "model"
  name: string;
  description: string;
  category: string;         // "mode" | "model"
  type: "select";           // only "select" observed
  currentValue: string;
  options: SelectOption[];
}

interface SelectOption {
  value: string;
  name: string;
  description?: string;
}
```

**Known config IDs:** `"mode"`, `"model"` (only 2 observed)

---

## Model ID Formats

Two ID formats coexist:

### ACP Protocol Format (from `session/new` response)

Pattern: `name[param=value,param=value]`

```
default[]
composer-2[fast=true]
gpt-5.4-mini[reasoning=medium]
claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]
claude-sonnet-4-6[thinking=true,context=200k,effort=medium]
```

**Known parameters:**

| Parameter | Values | Meaning |
|-----------|--------|---------|
| `reasoning` | `low`, `medium`, `high` | Reasoning effort |
| `thinking` | `true`, `false` | Extended thinking |
| `context` | `200k`, `272k` | Context window |
| `effort` | `medium`, `high` | Thinking effort |
| `fast` | `true`, `false` | Fast mode |

### CLI Slug Format (from `cursor agent models` / `--model` flag)

Pattern: `family-version-variant`

```
auto
composer-2-fast
gpt-5.4-medium
gpt-5.4-mini-high
claude-4.6-opus-high-thinking
claude-4.6-sonnet-medium
grok-4-20-thinking
kimi-k2.5
```

The CLI accepts flat slugs and translates to the bracketed ACP format internally.

---

## Error Response Shapes

### Standard JSON-RPC errors

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found",
    "data": { "method": "session/list" }
  }
}
```

### Error codes observed

| Code | Message | Data shape | When |
|------|---------|------------|------|
| `-32601` | `"Method not found": <method>` | `{"method": "<method>"}` | Unknown method |
| `-32602` | `Invalid params` | `{"message": "Session <id> not found"}` | Bad session ID |
| `-32603` | `Internal error` | Zod validation array | Schema validation failure |
| `-32603` | `Internal error` | `{"details": "Session <id> not found"}` | Session not found |

### Zod validation error format (`-32603`)

```json
{
  "code": -32603,
  "message": "Internal error",
  "data": [
    {
      "expected": "string",
      "code": "invalid_type",
      "path": ["sessionId"],
      "message": "Invalid input"
    },
    {
      "code": "invalid_union",
      "errors": [[], []],
      "path": ["mcpServers", 0],
      "message": "Invalid input"
    }
  ]
}
```

**Zod error codes observed:** `invalid_type`, `invalid_value`, `invalid_union`

---

## Behavioral Observations

### Model-dependent features

| Feature | Composer 2 | GPT-5.4 Mini | Claude 4.6 Opus Thinking | Grok 4.20 Thinking |
|---------|-----------|-------------|--------------------------|-------------------|
| `agent_thought_chunk` | No | Yes | Yes (expected) | Yes (expected) |
| `agent_message_chunk` | Yes | Yes | Yes | Yes |
| Reasoning stream | N/A | Streams before assistant text | Extended thinking | Chain-of-thought |

### Cancel semantics

- `session/cancel` is a **notification** (no `id`, no response)
- The in-flight `session/prompt` response arrives with `{"stopReason": "cancelled"}`
- Some streaming notifications may arrive between cancel send and prompt response
- If no prompt is in-flight, cancel is silently ignored

### `session/load` vs `session/new`

- `session/load` does NOT return `sessionId` (caller already has it)
- `session/load` returns the same `modes`/`models`/`configOptions` shape
- `session/load` reflects model changes from prior session (`currentModelId` updated)
- `session/load` triggers `available_commands_update` just like `session/new`
- `session/load` requires `mcpServers` array (not optional)

### `session/set_config_option` vs `session/set_mode` vs `session/set_model`

Three ways to change config:

| Method | Param | Returns | Side effect |
|--------|-------|---------|-------------|
| `session/set_config_option` | `configId` + `value` | Full `configOptions[]` | None |
| `session/set_mode` | `modeId` | `{}` | Emits `current_mode_update` |
| `session/set_model` | `modelId` | `{}` | None |

`set_config_option` is the generic version; `set_mode` and `set_model` are shortcuts.

---

## CLI vs ACP: Integration Paths

### Path 1: ACP Protocol (recommended for full integration)

```
spawn("cursor", ["agent", "acp"])
  → JSON-RPC 2.0 over stdio
  → Full bidirectional control
  → Rich event stream
```

**Pros:** Full control, persistent session, mid-turn cancel, elicitation, live model/mode switch.
**Cons:** Must manage process lifecycle, handle handshake, track RPC IDs.

### Path 2: CLI Print Mode (simpler, limited)

```
cursor agent --print --output-format stream-json --model <model> --force "prompt"
  → Stream-JSON on stdout
  → Process exits after turn
```

**Pros:** Simple, fire-and-forget per turn.
**Cons:** No mid-turn cancel (kill signal only), no elicitation, no live model/mode switch, process re-spawn per turn.

### Path 3: CLI Print Mode + New Flags

The new flags (`--model`, `--mode`, `--approve-mcps`, `--trust`, `--sandbox`, `--worktree`) narrow the gap:

```
cursor agent --print --output-format stream-json \
  --model claude-4.6-opus-high-thinking \
  --mode agent --force --approve-mcps --trust \
  --stream-partial-output "prompt text"
```

Still lacks mid-turn cancel, mid-session config changes, elicitation, and permission negotiation.
