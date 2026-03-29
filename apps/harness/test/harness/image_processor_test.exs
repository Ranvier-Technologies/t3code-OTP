defmodule Harness.ImageProcessorTest do
  use ExUnit.Case, async: true

  alias Harness.ImageProcessor

  @valid_png_data_url "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  @valid_jpeg_data_url "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
  @valid_gif_data_url "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP8AACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=="
  @valid_webp_data_url "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"

  defp make_attachment(overrides \\ %{}) do
    Map.merge(
      %{
        "type" => "image",
        "id" => "img-001",
        "name" => "screenshot.png",
        "mimeType" => "image/png",
        "sizeBytes" => 1024,
        "dataUrl" => @valid_png_data_url
      },
      overrides
    )
  end

  # --- parse_attachments/1 ---

  describe "parse_attachments/1" do
    test "parses a single valid image attachment" do
      assert {:ok, [image]} = ImageProcessor.parse_attachments([make_attachment()])
      assert image.mime_type == "image/png"
      assert image.name == "screenshot.png"
      # size_bytes is computed from actual base64 payload, not from the client-supplied sizeBytes
      assert is_integer(image.size_bytes) and image.size_bytes > 0
      assert is_binary(image.base64_data)
      assert String.starts_with?(image.data_url, "data:image/png;base64,")
    end

    test "parses multiple valid attachments" do
      attachments = [
        make_attachment(%{"name" => "a.png"}),
        make_attachment(%{
          "name" => "b.jpg",
          "mimeType" => "image/jpeg",
          "dataUrl" => @valid_jpeg_data_url
        })
      ]

      assert {:ok, images} = ImageProcessor.parse_attachments(attachments)
      assert length(images) == 2
      assert Enum.at(images, 0).name == "a.png"
      assert Enum.at(images, 1).name == "b.jpg"
    end

    test "supports all allowed MIME types" do
      for {mime, url} <- [
            {"image/png", @valid_png_data_url},
            {"image/jpeg", @valid_jpeg_data_url},
            {"image/gif", @valid_gif_data_url},
            {"image/webp", @valid_webp_data_url}
          ] do
        attachment = make_attachment(%{"mimeType" => mime, "dataUrl" => url})
        assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
        assert image.mime_type == mime
      end
    end

    test "filters out non-image attachments" do
      text_attachment = %{"type" => "text", "content" => "hello"}
      image_attachment = make_attachment()

      assert {:ok, [image]} =
               ImageProcessor.parse_attachments([text_attachment, image_attachment])

      assert image.name == "screenshot.png"
    end

    test "returns empty list for no attachments" do
      assert {:ok, []} = ImageProcessor.parse_attachments([])
    end

    test "returns empty list for nil input" do
      assert {:ok, []} = ImageProcessor.parse_attachments(nil)
    end

    test "returns empty list when all attachments are non-image" do
      assert {:ok, []} =
               ImageProcessor.parse_attachments([%{"type" => "text", "content" => "hello"}])
    end

    test "rejects attachment with missing dataUrl" do
      attachment = make_attachment() |> Map.delete("dataUrl")
      assert {:error, :missing_data_url} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with empty dataUrl" do
      attachment = make_attachment(%{"dataUrl" => ""})
      assert {:error, :missing_data_url} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with invalid data URL format" do
      attachment = make_attachment(%{"dataUrl" => "not-a-data-url"})
      assert {:error, :invalid_data_url_format} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with data URL missing base64 marker" do
      attachment = make_attachment(%{"dataUrl" => "data:image/png,rawdata"})
      assert {:error, :invalid_data_url_format} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects unsupported MIME type" do
      attachment =
        make_attachment(%{
          "mimeType" => "image/bmp",
          "dataUrl" => "data:image/bmp;base64,Qk0="
        })

      assert {:error, {:unsupported_mime_type, "image/bmp"}} =
               ImageProcessor.parse_attachments([attachment])
    end

    test "rejects image whose actual base64 payload exceeds max size" do
      max_bytes = 10 * 1024 * 1024
      # Create a valid base64 string that decodes to > 10MB.
      # Repeat "AAAA" (decodes to 3 bytes each) enough times to exceed the limit.
      oversized_b64 = String.duplicate("AAAA", div(max_bytes, 3) + 1)
      oversized_data_url = "data:image/png;base64," <> oversized_b64
      attachment = make_attachment(%{"sizeBytes" => 100, "dataUrl" => oversized_data_url})

      assert {:error, {:image_too_large, _, ^max_bytes}} =
               ImageProcessor.parse_attachments([attachment])
    end

    test "accepts image whose base64 payload is within max size" do
      # Our test fixtures are tiny PNGs, well under 10MB
      attachment = make_attachment()
      assert {:ok, [_]} = ImageProcessor.parse_attachments([attachment])
    end

    test "stops at first error in list" do
      bad = make_attachment(%{"dataUrl" => "bad"})
      good = make_attachment()

      assert {:error, :invalid_data_url_format} =
               ImageProcessor.parse_attachments([bad, good])
    end

    test "ignores client-supplied sizeBytes and computes actual payload size" do
      # Even with a spoofed sizeBytes of 100, the actual size is derived from base64
      attachment = make_attachment(%{"sizeBytes" => 100})
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      # The actual decoded size of the test PNG base64 data, not the spoofed 100
      assert image.size_bytes != 100
      assert is_integer(image.size_bytes) and image.size_bytes > 0
    end

    test "parses attachment even when sizeBytes is missing" do
      attachment = make_attachment() |> Map.delete("sizeBytes")
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      assert is_integer(image.size_bytes) and image.size_bytes > 0
    end

    test "parses attachment even when sizeBytes is non-integer" do
      attachment = make_attachment(%{"sizeBytes" => "1024"})
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      assert is_integer(image.size_bytes) and image.size_bytes > 0
    end

    test "parses attachment even when sizeBytes is negative" do
      attachment = make_attachment(%{"sizeBytes" => -1})
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      assert is_integer(image.size_bytes) and image.size_bytes > 0
    end

    test "computes correct decoded size from base64 payload" do
      # 4 base64 chars = 3 decoded bytes; "AAAA" decodes to 3 bytes
      attachment = make_attachment(%{"dataUrl" => "data:image/png;base64,AAAA"})
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      assert image.size_bytes == 3
    end

    test "computes correct decoded size with padding" do
      # "AA==" decodes to 1 byte (4 chars, 2 padding)
      attachment = make_attachment(%{"dataUrl" => "data:image/png;base64,AA=="})
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      assert image.size_bytes == 1
    end

    test "rejects malformed base64 with bad alphabet characters" do
      attachment = make_attachment(%{"dataUrl" => "data:image/png;base64,!!@@##$$"})
      assert {:error, :invalid_base64} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects malformed base64 with incompatible padding" do
      # "A===" is not valid base64 (single char + 3 padding is illegal)
      attachment = make_attachment(%{"dataUrl" => "data:image/png;base64,A==="})
      assert {:error, :invalid_base64} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects base64 that is only padding characters" do
      attachment = make_attachment(%{"dataUrl" => "data:image/png;base64,===="})
      assert {:error, :invalid_base64} = ImageProcessor.parse_attachments([attachment])
    end
  end

  # --- to_codex_input/1 ---

  describe "to_codex_input/1" do
    test "produces Codex image input format" do
      {:ok, [image]} = ImageProcessor.parse_attachments([make_attachment()])
      result = ImageProcessor.to_codex_input(image)

      assert result == %{
               "type" => "image",
               "image_url" => @valid_png_data_url
             }
    end
  end

  # --- to_opencode_part/1 ---

  describe "to_opencode_part/1" do
    test "produces OpenCode image part format" do
      {:ok, [image]} = ImageProcessor.parse_attachments([make_attachment()])
      result = ImageProcessor.to_opencode_part(image)

      assert result == %{
               "type" => "image_url",
               "url" => @valid_png_data_url
             }
    end
  end
end
