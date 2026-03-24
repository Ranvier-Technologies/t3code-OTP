#!/usr/bin/env bun
/**
 * benchmark-session-ramp.ts — Benchmark 1: Session Count Ramp.
 *
 * Sweeps session count from 5 to 200 to find where Node's event loop
 * degrades while Elixir stays stable. Runs 3 times per step (takes median).
 *
 * Usage:
 *   bun run scripts/benchmark-session-ramp.ts --runtime=node
 *   bun run scripts/benchmark-session-ramp.ts --runtime=elixir
 *   bun run scripts/benchmark-session-ramp.ts --runtime=node --steps=5,10,20
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import v8 from "node:v8";

let HarnessClientManager: any;
try {
  const mod = await import("../apps/server/src/provider/Layers/HarnessClientManager.ts");
  HarnessClientManager = mod.HarnessClientManager;
} catch {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const RUNTIME = process.argv.find((a) => a.startsWith("--runtime="))?.split("=")[1] || "node";
const HARNESS_PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const HARNESS_SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";

const DEFAULT_STEPS = [5, 10, 20, 30, 50, 75, 100, 150, 200];
const stepsArg = process.argv.find((a) => a.startsWith("--steps="))?.split("=")[1];
const STEPS: number[] = stepsArg ? stepsArg.split(",").map(Number) : DEFAULT_STEPS;

const RUNS_PER_STEP = 3;
const DELTA_COUNT = 100;
const DELTA_SIZE_KB = 1;
const DELAY_MS = 10;
const COOLDOWN_MS = 5000;

mkdirSync(OUTPUT_DIR, { recursive: true });

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function medianNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return median(nums);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionStats {
  id: string;
  deltaCount: number;
  turnsCompleted: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  errors: string[];
}

function createStats(id: string): SessionStats {
  return {
    id,
    deltaCount: 0,
    turnsCompleted: 0,
    firstDeltaAt: null,
    lastDeltaAt: null,
    errors: [],
  };
}

interface RunMetrics {
  memory_bytes: number;
  per_session_memory_bytes: number | null;
  latency_p50_ms: number;
  latency_p99_ms: number;
  throughput_events_per_sec: number;
  event_loop_lag_p99_ms: number | null;
  scheduler_util_avg: number | null;
  correctness_pct: number;
  startup_ms: number;
}

interface TimeSeriesPoint {
  elapsed_ms: number;
  [key: string]: number;
}

interface BenchmarkStep {
  benchmark: string;
  runtime: "node" | "elixir";
  step: number;
  stepLabel: string;
  metrics: RunMetrics;
  timeSeries: TimeSeriesPoint[];
}

// ---------------------------------------------------------------------------
// Node runtime — N child processes
// ---------------------------------------------------------------------------

async function runNodeStep(
  N: number,
): Promise<{ metrics: RunMetrics; timeSeries: TimeSeriesPoint[] }> {
  const allStats: SessionStats[] = [];
  const eventTimestamps: number[] = [];

  // Event loop lag
  const lags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    if (lag > 5) lags.push(lag);
    lastLagCheck = now;
  }, 100);

  const sessions = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      rl: readline.Interface;
      pending: Map<number, any>;
      nextId: number;
      codexThreadId: string | null;
    }
  >();

  const startPhaseStart = Date.now();

  for (let i = 0; i < N; i++) {
    const sid = `ramp-node-${N}-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    const child = spawn(
      "bun",
      [
        "run",
        "scripts/mock-codex-server.ts",
        String(DELTA_COUNT),
        String(DELTA_SIZE_KB),
        String(DELAY_MS),
        "normal",
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );

    const rl = readline.createInterface({ input: child.stdout });
    const session = {
      child,
      rl,
      pending: new Map<number, any>(),
      nextId: 1,
      codexThreadId: null as string | null,
    };
    sessions.set(sid, session);

    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = session.pending.get(msg.id);
          if (p) {
            session.pending.delete(msg.id);
            p.resolve(msg.result ?? msg.error);
          }
          return;
        }
        if (msg.method === "item/agentMessage/delta") {
          stats.deltaCount++;
          const now = Date.now();
          eventTimestamps.push(now);
          if (!stats.firstDeltaAt) stats.firstDeltaAt = now;
          stats.lastDeltaAt = now;
        }
        if (msg.method === "turn/completed") stats.turnsCompleted++;
      } catch {}
    });
    child.stderr?.resume();

    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = session.nextId++;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error("timeout"));
        }, 30000);
        session.pending.set(id, {
          resolve: (v: any) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e: any) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    try {
      await rpc("initialize", { clientInfo: { name: "stress", version: "1.0" }, capabilities: {} });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const threadResult = await rpc("thread/start", { cwd: process.cwd() });
      session.codexThreadId = threadResult?.thread?.id ?? null;
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }

    if ((i + 1) % 10 === 0) log(`    ${i + 1}/${N} sessions started`);
  }

  const startupMs = Date.now() - startPhaseStart;

  // Heap snapshot before sending
  const preHeap = process.memoryUsage();

  // Send turns to ALL simultaneously
  for (const stats of allStats) {
    const session = sessions.get(stats.id);
    if (!session || stats.errors.length > 0) continue;

    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = session.nextId++;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error("timeout"));
        }, 60000);
        session.pending.set(id, {
          resolve: (v: any) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e: any) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    rpc("turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: "session-ramp test" }],
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for completion (max 120s), collect time series at 1s intervals
  const streamStart = Date.now();
  const end = streamStart + 120_000;
  const timeSeries: TimeSeriesPoint[] = [];

  while (Date.now() < end) {
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
    const mem = process.memoryUsage();

    timeSeries.push({
      elapsed_ms: Date.now() - streamStart,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      completed,
      totalDeltas,
    });

    if (
      completed === allStats.length ||
      allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)
    )
      break;
    await sleep(1000);
  }

  clearInterval(lagTimer);

  // Compute latencies from per-session durations
  const sessionLatencies = allStats
    .filter((s) => s.firstDeltaAt && s.lastDeltaAt)
    .map((s) => s.lastDeltaAt! - s.firstDeltaAt!);

  const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
  const expectedDeltas = N * DELTA_COUNT;
  const correctness = expectedDeltas > 0 ? (totalDeltas / expectedDeltas) * 100 : 0;

  let throughput = 0;
  if (eventTimestamps.length > 1) {
    const streamDur = (eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000;
    if (streamDur > 0) throughput = eventTimestamps.length / streamDur;
  }

  const postHeap = process.memoryUsage();

  // Kill all child processes
  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  return {
    metrics: {
      memory_bytes: postHeap.rss,
      per_session_memory_bytes: null,
      latency_p50_ms: percentile(sessionLatencies, 50),
      latency_p99_ms: percentile(sessionLatencies, 99),
      throughput_events_per_sec: Math.round(throughput),
      event_loop_lag_p99_ms: lags.length > 0 ? Math.round(percentile(lags, 99) * 10) / 10 : null,
      scheduler_util_avg: null,
      correctness_pct: Math.round(correctness * 10) / 10,
      startup_ms: startupMs,
    },
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Elixir runtime — N GenServer processes
// ---------------------------------------------------------------------------

async function runElixirStep(
  N: number,
  mgr: any,
): Promise<{ metrics: RunMetrics; timeSeries: TimeSeriesPoint[] }> {
  const allStats: SessionStats[] = [];
  const eventTimestamps: number[] = [];
  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;

  // Patch the mgr's onEvent to track our stats
  const originalOnEvent = mgr._benchOnEvent;
  mgr._benchOnEvent = (raw: any) => {
    const stats = allStats.find((s) => s.id === raw.threadId);
    if (!stats) return;
    if (raw.method === "item/agentMessage/delta") {
      stats.deltaCount++;
      const now = Date.now();
      eventTimestamps.push(now);
      if (!stats.firstDeltaAt) stats.firstDeltaAt = now;
      stats.lastDeltaAt = now;
    }
    if (raw.method === "turn/completed") stats.turnsCompleted++;
  };

  const startPhaseStart = Date.now();

  for (let i = 0; i < N; i++) {
    const sid = `ramp-elixir-${N}-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    try {
      await mgr.startSession({
        threadId: sid,
        provider: "mock",
        cwd: process.cwd(),
        providerOptions: {
          mock: { deltaCount: DELTA_COUNT, deltaSizeKb: DELTA_SIZE_KB, delayMs: DELAY_MS },
        },
      });
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }

    if ((i + 1) % 10 === 0) log(`    ${i + 1}/${N} sessions started`);
  }

  const startupMs = Date.now() - startPhaseStart;

  const preMetrics = (await fetch(METRICS_URL).then((r) => r.json())) as any;

  // Send turns to ALL simultaneously
  const turnPromises = allStats
    .filter((s) => s.errors.length === 0)
    .map((s) =>
      mgr.sendTurn(s.id, { input: [{ type: "text", text: "session-ramp test" }] }).catch(() => {}),
    );
  await Promise.all(turnPromises);

  // Wait for completion, collect time series at 1s intervals
  const streamStart = Date.now();
  const end = streamStart + 120_000;
  const timeSeries: TimeSeriesPoint[] = [];

  while (Date.now() < end) {
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);

    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      timeSeries.push({
        elapsed_ms: Date.now() - streamStart,
        total_memory: m.beam?.total_memory ?? 0,
        process_count: m.beam?.process_count ?? 0,
        completed,
        totalDeltas,
      });
    } catch {
      timeSeries.push({ elapsed_ms: Date.now() - streamStart, completed, totalDeltas });
    }

    if (completed >= N || allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;
    await sleep(1000);
  }

  // Final metrics
  const postMetrics = (await fetch(METRICS_URL).then((r) => r.json())) as any;
  const sessionData = (postMetrics.sessions ?? [])
    .filter((s: any) => String(s.thread_id ?? "").includes(`ramp-elixir-${N}`))
    .map((s: any) => ({ memory: s.memory, gc_count: s.gc_count, reductions: s.reductions }));

  // Compute latencies from per-session durations
  const sessionLatencies = allStats
    .filter((s) => s.firstDeltaAt && s.lastDeltaAt)
    .map((s) => s.lastDeltaAt! - s.firstDeltaAt!);

  const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
  const expectedDeltas = N * DELTA_COUNT;
  const correctness = expectedDeltas > 0 ? (totalDeltas / expectedDeltas) * 100 : 0;

  let throughput = 0;
  if (eventTimestamps.length > 1) {
    const streamDur = (eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000;
    if (streamDur > 0) throughput = eventTimestamps.length / streamDur;
  }

  const perSessionMemory =
    sessionData.length > 0
      ? sessionData.reduce((s: number, m: any) => s + m.memory, 0) / sessionData.length
      : null;

  let schedulerUtilAvg: number | null = null;
  if (postMetrics?.beam?.scheduler_utilization) {
    const sched = postMetrics.beam.scheduler_utilization;
    if (Array.isArray(sched) && sched.length > 0) {
      schedulerUtilAvg =
        Math.round((sched.reduce((s: number, u: number) => s + u, 0) / sched.length) * 1000) / 1000;
    }
  }

  // Cleanup sessions for this step
  try {
    await mgr.stopAll();
  } catch {}

  return {
    metrics: {
      memory_bytes: postMetrics.beam?.total_memory ?? 0,
      per_session_memory_bytes: perSessionMemory,
      latency_p50_ms: percentile(sessionLatencies, 50),
      latency_p99_ms: percentile(sessionLatencies, 99),
      throughput_events_per_sec: Math.round(throughput),
      event_loop_lag_p99_ms: null,
      scheduler_util_avg: schedulerUtilAvg,
      correctness_pct: Math.round(correctness * 10) / 10,
      startup_ms: startupMs,
    },
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Median aggregation across runs
// ---------------------------------------------------------------------------

function medianMetrics(runs: RunMetrics[]): RunMetrics {
  return {
    memory_bytes: median(runs.map((r) => r.memory_bytes)),
    per_session_memory_bytes: medianNullable(runs.map((r) => r.per_session_memory_bytes)),
    latency_p50_ms: median(runs.map((r) => r.latency_p50_ms)),
    latency_p99_ms: median(runs.map((r) => r.latency_p99_ms)),
    throughput_events_per_sec: median(runs.map((r) => r.throughput_events_per_sec)),
    event_loop_lag_p99_ms: medianNullable(runs.map((r) => r.event_loop_lag_p99_ms)),
    scheduler_util_avg: medianNullable(runs.map((r) => r.scheduler_util_avg)),
    correctness_pct: median(runs.map((r) => r.correctness_pct)),
    startup_ms: median(runs.map((r) => r.startup_ms)),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  Benchmark 1: Session Count Ramp — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  Steps: [${STEPS.join(", ")}]`.padEnd(58) + "║");
  console.log(
    "║" +
      `  ${RUNS_PER_STEP} runs/step × ${DELTA_COUNT} deltas × ${DELTA_SIZE_KB}KB`.padEnd(58) +
      "║",
  );
  console.log("╚" + "═".repeat(58) + "╝\n");

  const results: BenchmarkStep[] = [];

  // For Elixir, create and reuse a single manager across all steps
  let elixirMgr: any = null;
  if (RUNTIME === "elixir") {
    elixirMgr = new HarnessClientManager({
      harnessPort: HARNESS_PORT,
      harnessSecret: HARNESS_SECRET,
      onEvent: (raw: any) => {
        // Delegate to the step-specific handler
        if (elixirMgr._benchOnEvent) elixirMgr._benchOnEvent(raw);
      },
      onSessionChanged: () => {},
      onDisconnect: () => {},
      onReconnect: () => {},
    });
    await elixirMgr.connect();
    log("Connected to harness (reusing connection across steps)");
  }

  for (const N of STEPS) {
    console.log("\n" + "─".repeat(60));
    console.log(`  Step: ${N} sessions`);
    console.log("─".repeat(60));

    const runResults: { metrics: RunMetrics; timeSeries: TimeSeriesPoint[] }[] = [];

    for (let run = 1; run <= RUNS_PER_STEP; run++) {
      log(`Run ${run}/${RUNS_PER_STEP} with N=${N}...`);

      let result: { metrics: RunMetrics; timeSeries: TimeSeriesPoint[] };
      if (RUNTIME === "elixir") {
        result = await runElixirStep(N, elixirMgr);
      } else {
        result = await runNodeStep(N);
      }

      runResults.push(result);

      // Log run metrics
      const m = result.metrics;
      log(
        `  Run ${run} done: correctness=${m.correctness_pct}% throughput=${m.throughput_events_per_sec}ev/s startup=${m.startup_ms}ms`,
      );
      if (m.event_loop_lag_p99_ms !== null)
        log(`  Event loop lag p99: ${m.event_loop_lag_p99_ms}ms`);
      if (m.scheduler_util_avg !== null)
        log(`  Scheduler util avg: ${(m.scheduler_util_avg * 100).toFixed(1)}%`);
      if (m.per_session_memory_bytes !== null)
        log(`  Per-session memory: ${(m.per_session_memory_bytes / 1024).toFixed(1)}KB`);

      // Cooldown between runs
      if (run < RUNS_PER_STEP) {
        log(`  Cooling down ${COOLDOWN_MS / 1000}s...`);
        await sleep(COOLDOWN_MS);
      }
    }

    // Take median across runs
    const medianRun = medianMetrics(runResults.map((r) => r.metrics));

    // Use the time series from the median run (run with median throughput)
    const throughputs = runResults.map((r) => r.metrics.throughput_events_per_sec);
    const medianThroughput = median(throughputs);
    const medianIdx = throughputs.indexOf(
      throughputs.reduce((closest, v) =>
        Math.abs(v - medianThroughput) < Math.abs(closest - medianThroughput) ? v : closest,
      ),
    );
    const medianTimeSeries = runResults[medianIdx >= 0 ? medianIdx : 0]!.timeSeries;

    const step: BenchmarkStep = {
      benchmark: "session-ramp",
      runtime: RUNTIME as "node" | "elixir",
      step: N,
      stepLabel: `${N} sessions`,
      metrics: medianRun,
      timeSeries: medianTimeSeries,
    };

    results.push(step);

    // Summary for this step
    console.log(
      `\n  ▸ Median (N=${N}): throughput=${medianRun.throughput_events_per_sec}ev/s latency_p50=${medianRun.latency_p50_ms}ms p99=${medianRun.latency_p99_ms}ms correctness=${medianRun.correctness_pct}%`,
    );
    console.log(
      `    memory=${(medianRun.memory_bytes / 1024 / 1024).toFixed(1)}MB startup=${medianRun.startup_ms}ms`,
    );

    // Cooldown between steps
    if (N !== STEPS[STEPS.length - 1]) {
      log(`Cooling down ${COOLDOWN_MS / 1000}s before next step...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // Disconnect Elixir manager after all steps
  if (elixirMgr) {
    elixirMgr.disconnect();
    log("Disconnected from harness");
  }

  // Write output
  const filename = `benchmark-session-ramp-${RUNTIME}-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(results, null, 2));

  // Final summary table
  console.log("\n\n" + "═".repeat(60));
  console.log("  SESSION RAMP BENCHMARK — FINAL RESULTS");
  console.log("═".repeat(60));
  console.log(
    `  ${"Step".padEnd(8)} ${"Tput".padStart(8)} ${"P50".padStart(8)} ${"P99".padStart(8)} ${"Lag99".padStart(8)} ${"Mem MB".padStart(8)} ${"Corr%".padStart(8)}`,
  );
  console.log("  " + "─".repeat(56));

  for (const step of results) {
    const m = step.metrics;
    const lagStr =
      m.event_loop_lag_p99_ms !== null
        ? `${m.event_loop_lag_p99_ms}`
        : m.scheduler_util_avg !== null
          ? `${(m.scheduler_util_avg * 100).toFixed(1)}%`
          : "n/a";
    console.log(
      `  ${String(step.step).padEnd(8)} ${String(m.throughput_events_per_sec).padStart(8)} ${String(m.latency_p50_ms).padStart(8)} ${String(m.latency_p99_ms).padStart(8)} ${lagStr.padStart(8)} ${(m.memory_bytes / 1024 / 1024).toFixed(1).padStart(8)} ${String(m.correctness_pct).padStart(8)}`,
    );
  }

  console.log("═".repeat(60));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
