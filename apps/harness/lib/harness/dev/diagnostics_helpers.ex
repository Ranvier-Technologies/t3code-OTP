defmodule Harness.Dev.DiagnosticsHelpers do
  @moduledoc """
  Shared helpers for provider session diagnostics.

  Used by all provider GenServers in their `:get_diagnostics` handler
  to produce a consistent, safe subset of internal state.
  """

  @doc "Check if an Erlang Port is still alive."
  def port_alive?(nil), do: false

  def port_alive?(port) do
    try do
      Port.info(port) != nil
    catch
      _, _ -> false
    end
  end

  @doc "Sanitize turn_state to only expose id and started_at."
  def sanitize_turn_state(nil), do: nil
  def sanitize_turn_state(turn) when is_map(turn), do: Map.take(turn, [:id, :started_at])
  def sanitize_turn_state(_), do: nil

  @doc "Sanitize account to only expose type, plan_type, spark_enabled."
  def sanitize_account(nil), do: nil

  def sanitize_account(account) when is_map(account),
    do: Map.take(account, [:type, :plan_type, :spark_enabled])

  def sanitize_account(_), do: nil

  @doc "Safely get process info for a pid. Returns nil if process is dead."
  def process_info_safe(pid) when is_pid(pid) do
    case Process.info(pid, [
           :memory,
           :heap_size,
           :total_heap_size,
           :message_queue_len,
           :reductions
         ]) do
      nil -> nil
      info -> Map.new(info)
    end
  end

  def process_info_safe(_), do: nil

  @doc "Extract method names from a pending requests map (%{id => %{method: m, ...}})."
  def pending_methods(pending) when is_map(pending) do
    pending
    |> Map.values()
    |> Enum.map(fn
      %{method: m} when is_binary(m) -> m
      _ -> nil
    end)
    |> Enum.reject(&is_nil/1)
  end

  def pending_methods(_), do: []
end
