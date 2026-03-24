import { describe, expect, it } from "vitest";

import {
  MINIMUM_CODEX_CLI_VERSION,
  compareCodexCliVersions,
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./codexCliVersion.ts";

describe("parseCodexCliVersion", () => {
  it("extracts and normalizes supported version strings from CLI output", () => {
    expect(parseCodexCliVersion("codex 0.37\n")).toBe("0.37.0");
    expect(parseCodexCliVersion("Codex CLI v0.37.1\nbuild abc123")).toBe("0.37.1");
    expect(parseCodexCliVersion("version: 0.37.0-beta.2")).toBe("0.37.0-beta.2");
  });

  it("returns null when CLI output does not contain a valid semver", () => {
    expect(parseCodexCliVersion("codex version unknown")).toBeNull();
    expect(parseCodexCliVersion("codex 0.37.0.1")).toBeNull();
  });
});

describe("compareCodexCliVersions", () => {
  it("compares normalized release versions numerically", () => {
    expect(compareCodexCliVersions("0.37", "0.37.0")).toBe(0);
    expect(compareCodexCliVersions("0.37.1", "0.37.0")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.36.9", "0.37.0")).toBeLessThan(0);
  });

  it("orders prerelease versions before the final release", () => {
    expect(compareCodexCliVersions("0.37.0-beta.1", "0.37.0")).toBeLessThan(0);
    expect(compareCodexCliVersions("0.37.0-beta.2", "0.37.0-beta.10")).toBeLessThan(0);
    expect(compareCodexCliVersions("0.37.0-rc.1", "0.37.0-beta.10")).toBeGreaterThan(0);
  });
});

describe("isCodexCliVersionSupported", () => {
  it("uses the minimum supported version threshold", () => {
    expect(isCodexCliVersionSupported(MINIMUM_CODEX_CLI_VERSION)).toBe(true);
    expect(isCodexCliVersionSupported("0.37")).toBe(true);
    expect(isCodexCliVersionSupported("0.36.9")).toBe(false);
    expect(isCodexCliVersionSupported("0.37.0-beta.1")).toBe(false);
  });
});

describe("formatCodexCliUpgradeMessage", () => {
  it("formats upgrade guidance for detected and unknown versions", () => {
    expect(formatCodexCliUpgradeMessage("0.36.0")).toBe(
      "Codex CLI v0.36.0 is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
    );
    expect(formatCodexCliUpgradeMessage(null)).toBe(
      "The installed Codex CLI version is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
    );
  });
});
