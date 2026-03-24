defmodule Harness.Dev.Doctor do
  @moduledoc """
  Transport-agnostic health probes for provider binaries and harness infrastructure.

  Invariant: no harness state mutation. Side effects limited to diagnostic probes
  (System.find_executable, System.cmd, Process.whereis).
  """

  @check_timeout_ms 4_000

  @provider_binaries %{
    "codex" => %{binary: "codex", version_args: ["--version"]},
    "claude" => %{binary: "claude", version_args: ["--version"]},
    "cursor" => %{binary: "cursor", version_args: ["--version"]},
    "opencode" => %{binary: "opencode", version_args: ["--version"]}
  }

  @doc """
  Run all health checks. Returns overall status and per-check results.
  """
  def full do
    checks = %{
      beam: check_beam(),
      bridge: check_bridge(),
      codex: check_binary("codex"),
      claude: check_binary("claude"),
      cursor: check_binary("cursor"),
      opencode: check_binary("opencode")
    }

    overall =
      if Enum.all?(Map.values(checks), &(&1.status in ["healthy", "not_installed"])) do
        "healthy"
      else
        "degraded"
      end

    %{overall: overall, checks: checks, timestamp: now_ms()}
  end

  @doc """
  Run a single health check by target name.
  """
  def check(target) when target in ~w(codex claude cursor opencode) do
    {:ok, check_binary(target)}
  end

  def check("bridge"), do: {:ok, check_bridge()}
  def check("beam"), do: {:ok, check_beam()}

  def check(other),
    do: {:error, "Unknown target: #{other}. Valid: codex, claude, cursor, opencode, bridge, beam"}

  # --- Binary checks ---

  defp check_binary(provider) do
    case Map.get(@provider_binaries, provider) do
      nil ->
        %{status: "error", detail: "Unknown provider: #{provider}"}

      %{binary: name, version_args: args} ->
        do_check_binary(name, args)
    end
  end

  defp do_check_binary(name, args) do
    case System.find_executable(name) do
      nil ->
        %{status: "not_installed", binary: nil, version: nil, detail: "#{name} not found in PATH"}

      path ->
        case run_version_check(path, args) do
          {:ok, version} ->
            %{status: "healthy", binary: path, version: version, detail: nil}

          {:error, reason} ->
            %{status: "degraded", binary: path, version: nil, detail: reason}
        end
    end
  end

  defp run_version_check(binary, args) do
    try do
      case System.cmd(binary, args, stderr_to_stdout: true, timeout: @check_timeout_ms) do
        {output, 0} ->
          version = parse_version(output)
          {:ok, version || String.trim(output)}

        {output, code} ->
          {:error, "Exit code #{code}: #{String.slice(String.trim(output), 0, 200)}"}
      end
    catch
      :error, %ErlangError{original: :timeout} ->
        {:error, "Version check timed out after #{@check_timeout_ms}ms"}

      kind, reason ->
        {:error, "#{kind}: #{inspect(reason)}"}
    end
  end

  defp parse_version(output) do
    case Regex.run(~r/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/, output) do
      [_, version] -> version
      _ -> nil
    end
  end

  # --- Infrastructure checks ---

  defp check_bridge do
    snapshot_alive = Process.whereis(Harness.SnapshotServer) != nil

    %{
      status: if(snapshot_alive, do: "healthy", else: "degraded"),
      endpoint_running: Process.whereis(HarnessWeb.Endpoint) != nil,
      pubsub_alive: Process.whereis(Harness.PubSub) != nil,
      registry_alive: Process.whereis(Harness.SessionRegistry) != nil,
      supervisor_alive: Process.whereis(Harness.SessionSupervisor) != nil,
      snapshot_server_alive: snapshot_alive
    }
  end

  defp check_beam do
    memory = :erlang.memory()
    total_mb = Float.round(memory[:total] / (1024 * 1024), 1)

    %{
      status: "healthy",
      process_count: :erlang.system_info(:process_count),
      total_memory_mb: total_mb,
      scheduler_count: :erlang.system_info(:schedulers_online),
      otp_release: to_string(:erlang.system_info(:otp_release))
    }
  end

  defp now_ms, do: System.system_time(:millisecond)
end
