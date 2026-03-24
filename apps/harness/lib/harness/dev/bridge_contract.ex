defmodule Harness.Dev.BridgeContract do
  @moduledoc """
  Structured bridge contract: Node ↔ Elixir channel messages.

  This is the canonical source of truth for the Phoenix Channel surface
  between Node.js (HarnessClientManager.ts) and Elixir (HarnessChannel).
  """

  @doc """
  Returns the full bridge contract as a structured map.
  """
  def contract do
    %{
      title: "Node ↔ Elixir Bridge Contract",
      description:
        "Phoenix Channel over WebSocket. Node joins 'harness:lobby', " <>
          "sends commands, receives push events. Socket URL: " <>
          "ws://127.0.0.1:{port}/socket/websocket?secret={secret}&vsn=2.0.0",
      node_to_elixir: node_to_elixir_events(),
      elixir_to_node: elixir_to_node_events(),
      lifecycle: lifecycle_notes()
    }
  end

  defp node_to_elixir_events do
    [
      %{
        event: "session.start",
        params: ~w(threadId provider cwd model resumeCursor runtimeMode providerOptions),
        required: ~w(threadId),
        description: "Start a new provider session. Blocks until ready (up to 60s)."
      },
      %{
        event: "session.sendTurn",
        params: ~w(threadId input model effort interactionMode modelOptions),
        required: ~w(threadId),
        description: "Send a turn to an active session."
      },
      %{
        event: "session.interrupt",
        params: ~w(threadId turnId),
        required: ~w(threadId),
        description: "Interrupt the active turn."
      },
      %{
        event: "session.respondToApproval",
        params: ~w(threadId requestId decision),
        required: ~w(threadId requestId decision),
        description: "Respond to a tool approval request (approve/deny)."
      },
      %{
        event: "session.respondToUserInput",
        params: ~w(threadId requestId answers),
        required: ~w(threadId requestId answers),
        description: "Respond to a user input request."
      },
      %{
        event: "session.stop",
        params: ~w(threadId),
        required: ~w(threadId),
        description: "Stop a session and terminate its GenServer."
      },
      %{
        event: "session.readThread",
        params: ~w(threadId),
        required: ~w(threadId),
        description: "Read thread state from the provider."
      },
      %{
        event: "session.rollbackThread",
        params: ~w(threadId numTurns),
        required: ~w(threadId numTurns),
        description: "Rollback thread by N turns."
      },
      %{
        event: "session.listSessions",
        params: [],
        required: [],
        description: "List all active sessions."
      },
      %{
        event: "session.stopAll",
        params: [],
        required: [],
        description: "Stop all sessions."
      },
      %{
        event: "provider.listModels",
        params: ~w(provider),
        required: ~w(provider),
        description: "List models for a provider (cached in ETS, 10-min TTL)."
      },
      %{
        event: "snapshot.get",
        params: [],
        required: [],
        description: "Get current snapshot with all session states."
      },
      %{
        event: "events.replay",
        params: ~w(afterSeq),
        required: ~w(afterSeq),
        description: "Replay events since sequence number (WAL ring buffer, max 500 events)."
      }
    ]
  end

  defp elixir_to_node_events do
    [
      %{
        event: "harness.event",
        fields: ~w(eventId threadId provider createdAt kind method payload seq),
        kind_values: ~w(session notification request error),
        description:
          "Raw provider event with monotonic sequence number. " <>
            "All provider lifecycle and content events flow through this push."
      },
      %{
        event: "harness.session.changed",
        fields: ~w(threadId session),
        session_fields:
          ~w(threadId provider status model cwd runtimeMode activeTurn pendingRequests createdAt updatedAt),
        description: "Pushed when session state changes (status, turn, requests)."
      }
    ]
  end

  defp lifecycle_notes do
    [
      "Node connects to ws://127.0.0.1:{port}/socket/websocket with secret param",
      "Node joins 'harness:lobby' topic",
      "Heartbeat: Phoenix 'phoenix' topic, 30s interval",
      "On reconnect: Node sends events.replay with lastSeenSeq to recover missed events",
      "If afterSeq is too old (evicted from WAL), replay returns :gap — Node must full-resync via snapshot.get",
      "Request timeout: 30s on Node side",
      "Session start timeout: 60s (OpenCode server takes ~20s to boot)"
    ]
  end
end
