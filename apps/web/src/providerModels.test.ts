import { describe, expect, it } from "vitest";

import { getDefaultServerModel, getProviderModels } from "./providerModels";

describe("providerModels Devin fallback", () => {
  it("exposes the synthetic Devin model when the server has not reported one yet", () => {
    expect(getProviderModels([], "devin")).toEqual([
      {
        slug: "devin-default",
        name: "Devin Default",
        isCustom: false,
        capabilities: null,
      },
    ]);
  });

  it("uses the synthetic Devin model as the default server model", () => {
    expect(getDefaultServerModel([], "devin")).toBe("devin-default");
  });
});
