defmodule Harness.Dev.InspectTest do
  use ExUnit.Case

  alias Harness.Dev.Inspect

  test "sessions/0 returns enriched session list" do
    result = Inspect.sessions()
    assert is_map(result)
    assert is_list(result.sessions)
    assert is_integer(result.total)
    assert result.total == length(result.sessions)
    assert is_integer(result.timestamp)
  end

  test "session/1 returns error for unknown thread" do
    assert {:error, msg} = Inspect.session("nonexistent-thread-id-xyz")
    assert msg =~ "not found"
  end

  test "bridge/0 returns Elixir-observable bridge status" do
    result = Inspect.bridge()
    assert is_map(result)

    # Explicitly marks this as Elixir-side only
    assert result.elixir_side_only == true

    # Infrastructure checks
    assert is_boolean(result.pubsub_alive)
    assert is_boolean(result.registry_alive)
    assert is_boolean(result.supervisor_alive)

    # Snapshot server info
    assert is_map(result.snapshot_server)
    assert is_boolean(result.snapshot_server.alive)
    assert is_integer(result.snapshot_server.sequence)

    # WAL stats
    assert is_map(result.wal)

    assert is_integer(result.timestamp)
  end
end
