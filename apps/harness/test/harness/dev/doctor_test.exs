defmodule Harness.Dev.DoctorTest do
  use ExUnit.Case

  alias Harness.Dev.Doctor

  test "check/1 returns valid structure for known providers" do
    for provider <- ~w(codex claude cursor opencode) do
      assert {:ok, result} = Doctor.check(provider)
      assert result.status in ["healthy", "not_installed", "degraded", "error"]

      # All results have these keys
      assert Map.has_key?(result, :binary)
      assert Map.has_key?(result, :version)
      assert Map.has_key?(result, :detail)
    end
  end

  test "check/1 returns valid structure for beam" do
    assert {:ok, result} = Doctor.check("beam")
    assert result.status == "healthy"
    assert is_integer(result.process_count)
    assert is_float(result.total_memory_mb)
    assert is_integer(result.scheduler_count)
    assert is_binary(result.otp_release)
  end

  test "check/1 returns error for unknown target" do
    assert {:error, msg} = Doctor.check("unknown-provider")
    assert msg =~ "Unknown target"
  end

  test "full/0 returns overall status and all checks" do
    result = Doctor.full()
    assert result.overall in ["healthy", "degraded"]
    assert is_map(result.checks)
    assert Map.has_key?(result.checks, :beam)
    assert Map.has_key?(result.checks, :bridge)
    assert Map.has_key?(result.checks, :codex)
    assert Map.has_key?(result.checks, :claude)
    assert Map.has_key?(result.checks, :cursor)
    assert Map.has_key?(result.checks, :opencode)
    assert is_integer(result.timestamp)
  end

  test "bridge check reports infrastructure health" do
    assert {:ok, result} = Doctor.check("bridge")
    assert result.status in ["healthy", "degraded"]
    assert is_boolean(result.endpoint_running)
    assert is_boolean(result.pubsub_alive)
    assert is_boolean(result.registry_alive)
    assert is_boolean(result.supervisor_alive)
    assert is_boolean(result.snapshot_server_alive)
  end
end
