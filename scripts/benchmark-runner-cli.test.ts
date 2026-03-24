import { assert, describe, it } from "@effect/vitest";

import {
  BENCHMARK_SUITE,
  expandRuntimes,
  filterBenchmarkSuite,
  parseBenchmarkRunnerArgv,
} from "./benchmark-runner-cli.ts";

describe("benchmark-runner-cli", () => {
  describe("parseBenchmarkRunnerArgv", () => {
    it("defaults runtime to both and quick to false", () => {
      const parsed = parseBenchmarkRunnerArgv([]);
      assert.deepStrictEqual(parsed, {
        runtime: "both",
        only: null,
        skip: [],
        quick: false,
      });
    });

    it("parses --runtime, --only, --skip, and --quick", () => {
      const parsed = parseBenchmarkRunnerArgv([
        "--runtime=node",
        "--only=session-ramp,payload-ramp",
        "--skip=failure-storm",
        "--quick",
      ]);
      assert.deepStrictEqual(parsed, {
        runtime: "node",
        only: ["session-ramp", "payload-ramp"],
        skip: ["failure-storm"],
        quick: true,
      });
    });

    it("trims only/skip tokens and drops empties", () => {
      const parsed = parseBenchmarkRunnerArgv(["--only= a , b ", "--skip= , x , "]);
      assert.deepStrictEqual(parsed.only, ["a", "b"]);
      assert.deepStrictEqual(parsed.skip, ["x"]);
    });
  });

  describe("expandRuntimes", () => {
    it("expands both to elixir then node", () => {
      assert.deepStrictEqual(expandRuntimes("both"), ["elixir", "node"]);
    });

    it("returns a single runtime as a one-element array", () => {
      assert.deepStrictEqual(expandRuntimes("node"), ["node"]);
    });
  });

  describe("filterBenchmarkSuite", () => {
    it("filters by --only when set", () => {
      const out = filterBenchmarkSuite(BENCHMARK_SUITE, ["session-ramp"], []);
      assert.deepStrictEqual(
        out.map((b) => b.name),
        ["session-ramp"],
      );
    });

    it("excludes names in skip", () => {
      const out = filterBenchmarkSuite(BENCHMARK_SUITE, null, ["session-ramp", "payload-ramp"]);
      assert.ok(!out.some((b) => b.name === "session-ramp"));
      assert.ok(!out.some((b) => b.name === "payload-ramp"));
      assert.equal(out.length, BENCHMARK_SUITE.length - 2);
    });

    it("applies only before skip semantics via filter order", () => {
      const out = filterBenchmarkSuite(
        BENCHMARK_SUITE,
        ["session-ramp", "payload-ramp"],
        ["session-ramp"],
      );
      assert.deepStrictEqual(
        out.map((b) => b.name),
        ["payload-ramp"],
      );
    });
  });
});
