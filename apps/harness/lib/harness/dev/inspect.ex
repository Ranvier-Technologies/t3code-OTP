defmodule Harness.Dev.Inspect do
  @moduledoc """
  Transport-agnostic service for inspecting live harness runtime state.

  Provides enriched views of sessions, individual session diagnostics,
  and Elixir-observable bridge health. Called by HTTP adapter for
  remote agent access.
  """

  alias Harness.Dev.DiagnosticsHelpers, as: DH

  @doc """
  List all sessions with enriched diagnostics and snapshot status.
  """
  def sessions do
    raw_sessions = Harness.SessionManager.list_sessions()
    snapshot = Harness.SnapshotServer.get_snapshot()

    enriched =
      Enum.map(raw_sessions, fn %{threadId: tid, provider: provider} ->
        base = %{threadId: tid, provider: provider}

        # Enrich with GenServer diagnostics (best-effort)
        diag_fields =
          case Harness.SessionManager.get_diagnostics(tid) do
            {:ok, diag} ->
              Map.take(diag, [
                :ready,
                :port_alive,
                :pending_count,
                :binary_path,
                :stopped,
                :stopping
              ])

            {:error, _} ->
              %{}
          end

        # Enrich with snapshot status
        snapshot_fields =
          case Map.get(snapshot[:sessions] || %{}, tid) do
            nil -> %{}
            ss -> %{status: ss[:status], model: ss[:model]}
          end

        base |> Map.merge(diag_fields) |> Map.merge(snapshot_fields)
      end)

    %{sessions: enriched, total: length(enriched), timestamp: now_ms()}
  end

  @doc """
  Get full diagnostics for a single session.
  Includes GenServer state, process info, and snapshot session.
  """
  def session(thread_id) do
    case Harness.SessionManager.get_diagnostics(thread_id) do
      {:ok, diag} ->
        # Enrich with process info
        pid = find_session_pid(thread_id)
        process_info = DH.process_info_safe(pid)

        # Enrich with snapshot session
        snapshot = Harness.SnapshotServer.get_snapshot()
        snapshot_session = Map.get(snapshot[:sessions] || %{}, thread_id)

        {:ok,
         Map.merge(diag, %{
           pid: if(pid, do: inspect(pid), else: nil),
           process_info: process_info,
           snapshot_session: snapshot_session
         })}

      {:error, _} = err ->
        err
    end
  end

  @doc """
  Report Elixir-observable bridge health.

  This reports only what Elixir can directly observe: OTP process liveness,
  WAL stats, and snapshot state. It does NOT represent full Node-side health.
  """
  def bridge do
    snapshot = Harness.SnapshotServer.get_snapshot()

    wal_stats =
      try do
        Harness.SnapshotServer.get_wal_stats()
      catch
        :exit, _ -> %{error: "SnapshotServer unreachable"}
      end

    %{
      elixir_side_only: true,
      endpoint_running: Process.whereis(HarnessWeb.Endpoint) != nil,
      pubsub_alive: Process.whereis(Harness.PubSub) != nil,
      registry_alive: Process.whereis(Harness.SessionRegistry) != nil,
      supervisor_alive: Process.whereis(Harness.SessionSupervisor) != nil,
      snapshot_server: %{
        alive: Process.whereis(Harness.SnapshotServer) != nil,
        sequence: snapshot[:sequence] || 0,
        session_count: map_size(snapshot[:sessions] || %{})
      },
      wal: wal_stats,
      timestamp: now_ms()
    }
  end

  # --- Private ---

  defp find_session_pid(thread_id) do
    case Registry.lookup(Harness.SessionRegistry, thread_id) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  defp now_ms, do: System.system_time(:millisecond)
end
