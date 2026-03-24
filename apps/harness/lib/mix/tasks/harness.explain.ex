defmodule Mix.Tasks.Harness.Explain do
  @shortdoc "Explain harness internals (local, no running harness needed)"
  @moduledoc """
  Explain harness internals. Works locally without a running harness.

  ## Usage

      mix harness.explain topics           # List all available topics
      mix harness.explain startup          # Explain Codex startup sequence
      mix harness.explain bridge-contract  # Show the full bridge contract
      mix harness.explain <topic>          # Explain any topic by slug
  """

  use Mix.Task

  @impl Mix.Task
  def run(["topics"]) do
    topics = Harness.Dev.Explain.topics()

    Mix.shell().info("Available explain topics:\n")

    for %{slug: slug, title: title} <- topics do
      Mix.shell().info("  #{String.pad_trailing(slug, 20)} #{title}")
    end

    Mix.shell().info("\nUsage: mix harness.explain <topic>")
  end

  def run([topic]) when is_binary(topic) do
    case Harness.Dev.Explain.topic(topic) do
      {:ok, data} ->
        print_topic(data)

      {:error, reason} ->
        Mix.shell().error(reason)
    end
  end

  def run([]) do
    Mix.shell().error(
      "Usage: mix harness.explain <topic>\nRun `mix harness.explain topics` to see available topics."
    )
  end

  def run(_) do
    Mix.shell().error("Usage: mix harness.explain <topic>")
  end

  defp print_topic(data) do
    Mix.shell().info("# #{data.title}\n")
    print_content(data)

    if related = data[:related_topics] do
      Mix.shell().info("\nRelated topics: #{Enum.join(related, ", ")}")
    end

    if files = data[:related_files] do
      Mix.shell().info("Related files:")
      for file <- files, do: Mix.shell().info("  #{file}")
    end
  end

  defp print_content(%{content: content}) when is_binary(content), do: Mix.shell().info(content)

  defp print_content(%{content: content}) when is_map(content),
    do: Mix.shell().info(Jason.encode!(content, pretty: true))

  defp print_content(data), do: Mix.shell().info(inspect(data, pretty: true))
end
