defmodule Harness.Dev.ExplainTest do
  use ExUnit.Case

  alias Harness.Dev.Explain

  test "topics returns a non-empty sorted list" do
    topics = Explain.topics()
    assert is_list(topics)
    assert topics != []

    # Each topic has slug and title
    for topic <- topics do
      assert is_binary(topic.slug)
      assert is_binary(topic.title)
      assert topic.slug != ""
      assert topic.title != ""
    end

    # Sorted by slug
    slugs = Enum.map(topics, & &1.slug)
    assert slugs == Enum.sort(slugs)
  end

  test "all listed topic slugs can be rendered" do
    topics = Explain.topics()

    for %{slug: slug} <- topics do
      assert {:ok, data} = Explain.topic(slug), "Failed to render topic: #{slug}"
      assert is_map(data)
      assert data[:title], "Topic #{slug} missing title"
    end
  end

  test "bridge-contract topic returns structured contract" do
    assert {:ok, data} = Explain.topic("bridge-contract")
    assert data.title =~ "Bridge"
    assert is_map(data.content)
    assert is_list(data.content.node_to_elixir)
    assert is_list(data.content.elixir_to_node)
    assert length(data.content.node_to_elixir) == 13
    assert length(data.content.elixir_to_node) == 2
  end

  test "startup topic returns content with steps" do
    assert {:ok, data} = Explain.topic("startup")
    assert data.title =~ "Startup"
    assert is_binary(data.content)
    assert data.content =~ "initialize"
    assert data.content =~ "account/read"
    assert data.content =~ "thread/start"
  end

  test "resume-fallback topic explains recoverable errors" do
    assert {:ok, data} = Explain.topic("resume-fallback")
    assert data.content =~ "not found"
    assert data.content =~ "thread/start"
  end

  test "unknown topic returns error with available slugs" do
    assert {:error, msg} = Explain.topic("nonexistent-topic-xyz")
    assert msg =~ "Unknown topic"
    assert msg =~ "startup"
  end

  test "nil topic returns error" do
    assert {:error, _} = Explain.topic(nil)
  end
end
