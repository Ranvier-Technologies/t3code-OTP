import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings", () => {
  it("includes default Devin provider settings", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.devin).toEqual({
      enabled: true,
      orgId: "",
      baseUrl: "https://api.devin.ai",
      customModels: [],
    });

    expect(decodeServerSettings({}).providers.devin).toEqual({
      enabled: true,
      orgId: "",
      baseUrl: "https://api.devin.ai",
      customModels: [],
    });
  });
});

describe("ServerSettingsPatch", () => {
  it("accepts Devin model selections and provider patches", () => {
    const parsed = decodeServerSettingsPatch({
      textGenerationModelSelection: {
        provider: "devin",
        model: "devin-default",
      },
      providers: {
        devin: {
          enabled: false,
          orgId: "org_123",
          baseUrl: "https://example.devin.local",
          customModels: [],
        },
      },
    });

    expect(parsed.textGenerationModelSelection).toEqual({
      provider: "devin",
      model: "devin-default",
    });
    expect(parsed.providers?.devin).toEqual({
      enabled: false,
      orgId: "org_123",
      baseUrl: "https://example.devin.local",
      customModels: [],
    });
  });
});
