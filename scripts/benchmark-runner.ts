#!/usr/bin/env bun
/**
 * benchmark-runner.ts — Orchestrator for the OTP crossover benchmark suite.
 *
 * Runs all 5 benchmarks for both runtimes (node + elixir) sequentially.
 * The Elixir harness must be started externally before running with --runtime=elixir.
 *
 * Usage:
 *   bun run scripts/benchmark-runner.ts --runtime=node
 *   bun run scripts/benchmark-runner.ts --runtime=elixir
 *   bun run scripts/benchmark-runner.ts --runtime=both
 *   bun run scripts/benchmark-runner.ts --runtime=node --only=session-ramp,payload-ramp
 *   bun run scripts/benchmark-runner.ts --runtime=both --quick
 *
 * Options:
 *   --runtime=node|elixir|both   Which runtime(s) to benchmark (default: both)
 *   --only=name,name,...          Only run specific benchmarks
 *   --quick                       Use reduced step counts for quick verification
 *   --skip=name,name,...          Skip specific benchmarks
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";

import {
  BENCHMARK_SUITE,
  expandRuntimes,
  filterBenchmarkSuite,
  parseBenchmarkRunnerArgv,
} from "./benchmark-runner-cli.ts";

const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const { runtime: RUNTIME, only: ONLY, skip: SKIP, quick: QUICK } = parseBenchmarkRunnerArgv(args);
const benchmarks = filterBenchmarkSuite(BENCHMARK_SUITE, ONLY, SKIP);

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;

// ---------------------------------------------------------------------------
// Run a single benchmark script as a child process
// ---------------------------------------------------------------------------

function runBenchmark(
  script: string,
  runtime: string,
  extraArgs: string[] = [],
): Promise<{ exitCode: number; duration_s: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const childArgs = ["run", `scripts/${script}`, `--runtime=${runtime}`, ...extraArgs];

    console.log(`    $ bun ${childArgs.join(" ")}`);

    const child = spawn("bun", childArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        duration_s: (Date.now() - start) / 1000,
      });
    });

    child.on("error", () => {
      resolve({ exitCode: 1, duration_s: (Date.now() - start) / 1000 });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runtimes = expandRuntimes(RUNTIME);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  OTP Crossover Benchmark Suite                              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  Runtimes:   ${runtimes.join(", ")}`);
  console.log(`  Benchmarks: ${benchmarks.map((b) => b.name).join(", ")}`);
  console.log(`  Mode:       ${QUICK ? "quick (reduced steps)" : "full"}`);
  console.log(`  Output:     ${OUTPUT_DIR}/`);
  console.log("");

  if (runtimes.includes("elixir")) {
    // Verify harness is running
    const HARNESS_PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
    try {
      const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/metrics`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`  ✓ Elixir harness detected on port ${HARNESS_PORT}\n`);
    } catch {
      if (RUNTIME !== "node") {
        console.error(`  ✗ Elixir harness not running on port ${HARNESS_PORT}`);
        console.error(`    Start it first: cd apps/harness && mix phx.server`);
        console.error(`    Or run with --runtime=node to skip Elixir benchmarks\n`);
        process.exit(1);
      }
    }
  }

  const results: Array<{
    benchmark: string;
    runtime: string;
    exitCode: number;
    duration_s: number;
  }> = [];

  for (const runtime of runtimes) {
    console.log(`\n${"═".repeat(62)}`);
    console.log(`  Runtime: ${runtime.toUpperCase()}`);
    console.log(`${"═".repeat(62)}\n`);

    for (const bench of benchmarks) {
      console.log(`  ${ts()} ▶ ${bench.name} (${runtime})`);

      const extraArgs: string[] = [];
      if (QUICK) {
        extraArgs.push(`--steps=${bench.quickSteps}`);
        // Sustained leak: also reduce duration in quick mode
        if (bench.name === "sustained-leak") {
          extraArgs.push("--duration=60000");
        }
      }

      const result = await runBenchmark(bench.script, runtime, extraArgs);
      results.push({ benchmark: bench.name, runtime, ...result });

      const status = result.exitCode === 0 ? "✓" : "✗";
      console.log(
        `\n  ${ts()} ${status} ${bench.name} (${runtime}) — ${result.duration_s.toFixed(0)}s\n`,
      );

      // Cooldown between benchmarks
      if (benchmarks.indexOf(bench) < benchmarks.length - 1) {
        console.log(`  ${ts()} Cooling down (5s)...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log(`\n${"═".repeat(62)}`);
  console.log("  BENCHMARK SUITE SUMMARY");
  console.log(`${"═".repeat(62)}\n`);

  const totalDuration = (Date.now() - t0) / 1000;
  const passed = results.filter((r) => r.exitCode === 0).length;
  const failed = results.filter((r) => r.exitCode !== 0).length;

  console.log(`  Total:    ${results.length} benchmark runs`);
  console.log(`  Passed:   ${passed}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Duration: ${(totalDuration / 60).toFixed(1)} minutes\n`);

  // Table
  console.log("  ┌────────────────────┬──────────┬────────┬────────────┐");
  console.log("  │ Benchmark          │ Runtime  │ Status │ Duration   │");
  console.log("  ├────────────────────┼──────────┼────────┼────────────┤");
  for (const r of results) {
    const status = r.exitCode === 0 ? "  ✓  " : "  ✗  ";
    console.log(
      `  │ ${r.benchmark.padEnd(18)} │ ${r.runtime.padEnd(8)} │${status} │ ${(r.duration_s.toFixed(0) + "s").padStart(10)} │`,
    );
  }
  console.log("  └────────────────────┴──────────┴────────┴────────────┘\n");

  // List output files
  const outputFiles = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith("benchmark-"))
    .sort()
    .slice(-results.length * 2); // last N*2 files

  if (outputFiles.length > 0) {
    console.log("  Output files:");
    for (const f of outputFiles) {
      console.log(`    ${OUTPUT_DIR}/${f}`);
    }
    console.log("");
  }

  console.log(`  Run analysis: bun run scripts/benchmark-analyze.ts\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
