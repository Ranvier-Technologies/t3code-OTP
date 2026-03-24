/**
 * Pure CLI parsing and benchmark list selection for benchmark-runner.ts.
 */

export const BENCHMARK_SUITE = [
  { name: "session-ramp", script: "benchmark-session-ramp.ts", quickSteps: "5,10,20" },
  { name: "payload-ramp", script: "benchmark-payload-ramp.ts", quickSteps: "0.1,1,10" },
  { name: "subagent-ramp", script: "benchmark-subagent-ramp.ts", quickSteps: "1,3,5" },
  { name: "failure-storm", script: "benchmark-failure-storm.ts", quickSteps: "0,1,5" },
  { name: "sustained-leak", script: "benchmark-sustained-leak.ts", quickSteps: "1,5" },
] as const;

export type BenchmarkSuiteEntry = (typeof BENCHMARK_SUITE)[number];

export type ParsedBenchmarkRunnerArgv = {
  runtime: string;
  only: string[] | null;
  skip: string[];
  quick: boolean;
};

export function parseBenchmarkRunnerArgv(argv: string[]): ParsedBenchmarkRunnerArgv {
  const runtime = argv.find((a) => a.startsWith("--runtime="))?.split("=")[1] ?? "both";
  const onlyRaw = argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const only = onlyRaw
    ? onlyRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const skipRaw =
    argv
      .find((a) => a.startsWith("--skip="))
      ?.split("=")[1]
      ?.split(",") ?? [];
  const skip = skipRaw.map((s) => s.trim()).filter(Boolean);
  const quick = argv.includes("--quick");
  return { runtime, only, skip, quick };
}

export function expandRuntimes(runtime: string): string[] {
  return runtime === "both" ? ["elixir", "node"] : [runtime];
}

export function filterBenchmarkSuite<T extends { name: string }>(
  benchmarks: readonly T[],
  only: string[] | null,
  skip: string[],
): T[] {
  return benchmarks.filter((b) => {
    if (only && !only.includes(b.name)) return false;
    if (skip.includes(b.name)) return false;
    return true;
  });
}
