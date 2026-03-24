defmodule Mix.Tasks.Harness.Doctor do
  @shortdoc "Check provider binary health (local checks only)"
  @moduledoc """
  Run local health checks for provider binaries.

  These checks run locally and do NOT require a running harness.
  For live runtime checks (bridge, sessions), use the HTTP API:

      curl localhost:4321/api/dev/doctor
      curl localhost:4321/api/dev/doctor/bridge

  ## Usage

      mix harness.doctor                # Check all provider binaries
      mix harness.doctor codex          # Check Codex binary only
      mix harness.doctor claude         # Check Claude binary only
      mix harness.doctor cursor         # Check Cursor binary only
      mix harness.doctor opencode       # Check OpenCode binary only
  """

  use Mix.Task

  @local_targets ~w(codex claude cursor opencode beam)

  @impl Mix.Task
  def run([]) do
    Mix.shell().info("Harness Doctor — Local Binary Checks\n")

    for target <- @local_targets do
      {:ok, result} = Harness.Dev.Doctor.check(target)
      print_check(target, result)
    end
  end

  def run([target]) when target in @local_targets do
    {:ok, result} = Harness.Dev.Doctor.check(target)
    print_check(target, result)
  end

  def run(["bridge"]) do
    Mix.shell().error("""
    Bridge health requires a live harness. Use HTTP:

        curl -s localhost:4321/api/dev/doctor/bridge | jq .
    """)
  end

  def run([other]) do
    Mix.shell().error(
      "Unknown target: #{other}. Valid local targets: #{Enum.join(@local_targets, ", ")}"
    )
  end

  def run(_) do
    Mix.shell().error("Usage: mix harness.doctor [target]")
  end

  defp print_check(target, result) do
    status_icon =
      case result.status do
        "healthy" -> "✓"
        "not_installed" -> "—"
        _ -> "✗"
      end

    line = "  #{status_icon} #{String.pad_trailing(target, 12)} #{result.status}"

    line =
      if result[:version] do
        line <> " (v#{result.version})"
      else
        line
      end

    line =
      if result[:binary] do
        line <> " — #{result.binary}"
      else
        line
      end

    line =
      if result[:detail] do
        line <> " [#{result.detail}]"
      else
        line
      end

    Mix.shell().info(line)
  end
end
