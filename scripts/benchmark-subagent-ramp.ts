#!/usr/bin/env bun
/**
 * benchmark-subagent-ramp.ts — Benchmark 3: Subagent Tree Width Ramp.
 *
 * Scales the number of concurrent parent sessions (each with 3 subagents
 * via mock mode "subagent") to find where event routing becomes a bottleneck.
 *
 * Usage:
 *   bun run scripts/benchmark-subagent-ramp.ts --runtime=node
 *   bun run scripts/benchmark-subagent-ramp.ts --runtime=elixir
 *   bun run scripts/benchmark-subagent-ramp.ts --runtime=node --steps=1,3,5
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

const DEFAULT_STEPS = [1, 3, 5, 10, 15, 20, 30];
const stepsArg = process.argv.find((a) => a.startsWith("--steps="))?.split("=")[1];
const STEPS = stepsArg ? stepsArg.split(",").map(Number) : DEFAULT_STEPS;

const RUNS_PER_STEP = 3;
const DELTA_COUNT = 60;
const DELTA_SIZE_KB = 5;
const DELAY_MS = 5;
const MODE = "subagent";
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

function median(arr: number[]): number {
  return percentile(arr, 50);
}

function stddev(arr: number[]): number {
  if (arr.length === 0) return 0;
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
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
  // Subagent lifecycle tracking
  spawnBegins: number;
  spawnEnds: number;
  interactionBegins: number;
  interactionEnds: number;
}

function createStats(id: string): SessionStats {
  return {
    id,
    deltaCount: 0,
    turnsCompleted: 0,
    firstDeltaAt: null,
    lastDeltaAt: null,
    errors: [],
    spawnBegins: 0,
    spawnEnds: 0,
    interactionBegins: 0,
    interactionEnds: 0,
  };
}

interface BenchmarkStep {
  benchmark: string;
  runtime: "node" | "elixir";
  step: number;
  stepLabel: string;
  metrics: {
    memory_bytes: number;
    per_session_memory_bytes: number | null;
    latency_p50_ms: number;
    latency_p99_ms: number;
    throughput_events_per_sec: number;
    event_loop_lag_p99_ms: number | null;
    scheduler_util_avg: number | null;
    correctness_pct: number;
    startup_ms: number;
    lifecycle_integrity_pct: number;
    fairness_stddev: number;
  };
  timeSeries: Array<{ elapsed_ms: number; [key: string]: number }>;
}

interface RunResult {
  allStats: SessionStats[];
  eventTimestamps: number[];
  lags: number[];
  metricSnapshots: Array<{ elapsed_ms: number; [key: string]: number }>;
  startupMs: number;
  memoryBytes: number;
  perSessionMemoryBytes: number | null;
  schedulerUtilAvg: number | null;
}

// ---------------------------------------------------------------------------
// Node runtime — N child processes with subagent mode
// ---------------------------------------------------------------------------

async function runNodeStep(N: number): Promise<RunResult> {
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
    const sid = `subramp-node-${N}-${i}-${Date.now()}`;
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
        MODE,
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
        if (msg.method === "collab_agent_spawn_begin") stats.spawnBegins++;
        if (msg.method === "collab_agent_spawn_end") stats.spawnEnds++;
        if (msg.method === "collab_agent_interaction_begin") stats.interactionBegins++;
        if (msg.method === "collab_agent_interaction_end") stats.interactionEnds++;
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
  }

  const startupMs = Date.now() - startPhaseStart;
  const preHeap = process.memoryUsage();

  // Fire all N turns simultaneously
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
      input: [{ type: "text", text: "subagent ramp test" }],
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for completion (max 120s)
  const end = Date.now() + 120_000;
  const metricSnapshots: Array<{ elapsed_ms: number; [key: string]: number }> = [];
  while (Date.now() < end) {
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
    const mem = process.memoryUsage();
    metricSnapshots.push({
      elapsed_ms: Date.now() - t0,
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
    process.stdout.write(
      `\r  ${ts()} step=${N} completed=${completed}/${N} deltas=${totalDeltas} heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`,
    );
    await sleep(1000);
  }

  clearInterval(lagTimer);

  const postHeap = process.memoryUsage();

  // Kill all
  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  return {
    allStats,
    eventTimestamps,
    lags,
    metricSnapshots,
    startupMs,
    memoryBytes: postHeap.heapUsed,
    perSessionMemoryBytes: N > 0 ? Math.round((postHeap.heapUsed - preHeap.heapUsed) / N) : null,
    schedulerUtilAvg: null,
  };
}

// ---------------------------------------------------------------------------
// Elixir runtime — N GenServer sessions with subagent mode
// ---------------------------------------------------------------------------

async function runElixirStep(N: number): Promise<RunResult> {
  const allStats: SessionStats[] = [];
  const eventTimestamps: number[] = [];

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.id === raw.threadId);
      if (!stats) return;
      if (raw.method === "item/agentMessage/delta") {
        stats.deltaCount++;
        const now = Date.now();
        eventTimestamps.push(now);
        if (!stats.firstDeltaAt) stats.firstDeltaAt = now;
        stats.lastDeltaAt = now;
      }
      if (raw.method === "collab_agent_spawn_begin") stats.spawnBegins++;
      if (raw.method === "collab_agent_spawn_end") stats.spawnEnds++;
      if (raw.method === "collab_agent_interaction_begin") stats.interactionBegins++;
      if (raw.method === "collab_agent_interaction_end") stats.interactionEnds++;
      if (raw.method === "turn/completed") stats.turnsCompleted++;
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();

  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;
  let baselineMemory = 0;
  try {
    const baseline = (await fetch(METRICS_URL).then((r) => r.json())) as any;
    baselineMemory = baseline.beam.total_memory ?? 0;
  } catch {}

  const startPhaseStart = Date.now();

  for (let i = 0; i < N; i++) {
    const sid = `subramp-elixir-${N}-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    try {
      await mgr.startSession({
        threadId: sid,
        provider: "mock",
        cwd: process.cwd(),
        providerOptions: {
          mock: {
            deltaCount: DELTA_COUNT,
            deltaSizeKb: DELTA_SIZE_KB,
            delayMs: DELAY_MS,
            mode: MODE,
          },
        },
      });
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const startupMs = Date.now() - startPhaseStart;

  // Fire all N turns simultaneously
  const turnPromises = allStats
    .filter((s) => s.errors.length === 0)
    .map((s) =>
      mgr.sendTurn(s.id, { input: [{ type: "text", text: "subagent ramp test" }] }).catch(() => {}),
    );
  await Promise.all(turnPromises);

  // Wait for completion (max 120s)
  const end = Date.now() + 120_000;
  const metricSnapshots: Array<{ elapsed_ms: number; [key: string]: number }> = [];
  while (Date.now() < end) {
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
    if (completed >= N || allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;

    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      metricSnapshots.push({
        elapsed_ms: Date.now() - t0,
        memory: m.beam.total_memory,
        process_count: m.beam.process_count,
        completed,
        totalDeltas,
      });
      process.stdout.write(
        `\r  ${ts()} step=${N} completed=${completed}/${N} deltas=${totalDeltas} mem=${(m.beam.total_memory / 1024 / 1024).toFixed(1)}MB procs=${m.beam.process_count}`,
      );
    } catch {}
    await sleep(1000);
  }

  // Collect final metrics
  let memoryBytes = 0;
  let perSessionMemoryBytes: number | null = null;
  let schedulerUtilAvg: number | null = null;
  try {
    const postMetrics = (await fetch(METRICS_URL).then((r) => r.json())) as any;
    memoryBytes = postMetrics.beam.total_memory ?? 0;
    if (N > 0 && baselineMemory > 0) {
      perSessionMemoryBytes = Math.round((memoryBytes - baselineMemory) / N);
    }
    if (
      postMetrics.beam?.scheduler_utilization &&
      Array.isArray(postMetrics.beam.scheduler_utilization)
    ) {
      const sched = postMetrics.beam.scheduler_utilization as number[];
      schedulerUtilAvg = sched.reduce((s, u) => s + u, 0) / sched.length;
    }
  } catch {}

  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();

  return {
    allStats,
    eventTimestamps,
    lags: [],
    metricSnapshots,
    startupMs,
    memoryBytes,
    perSessionMemoryBytes,
    schedulerUtilAvg,
  };
}

// ---------------------------------------------------------------------------
// Compute metrics from a single run
// ---------------------------------------------------------------------------

function computeRunMetrics(result: RunResult, N: number) {
  const { allStats, eventTimestamps, lags } = result;

  // Latencies: per-session total time from first delta to last delta
  const latencies = allStats
    .filter((s) => s.firstDeltaAt && s.lastDeltaAt)
    .map((s) => s.lastDeltaAt! - s.firstDeltaAt!);

  // Throughput
  let throughput = 0;
  if (eventTimestamps.length > 1) {
    const streamDur = (eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000;
    throughput = streamDur > 0 ? eventTimestamps.length / streamDur : 0;
  }

  // Correctness: sessions that received all expected deltas
  // Expected per session: 5 planning + 3*(DELTA_COUNT/3) subagent + 3 summary = DELTA_COUNT + 8
  const expectedDeltas = DELTA_COUNT + 8;
  const correctSessions = allStats.filter(
    (s) => s.deltaCount >= expectedDeltas && s.turnsCompleted > 0,
  ).length;
  const correctnessPct = N > 0 ? (correctSessions / N) * 100 : 0;

  // Lifecycle integrity: sessions where spawns==3 and interactions==3
  const integrityOk = allStats.filter(
    (s) =>
      s.spawnBegins === 3 &&
      s.spawnEnds === 3 &&
      s.interactionBegins === 3 &&
      s.interactionEnds === 3,
  ).length;
  const lifecycleIntegrityPct = N > 0 ? (integrityOk / N) * 100 : 0;

  // Fairness: stddev of per-session delta counts
  const counts = allStats.map((s) => s.deltaCount);
  const fairnessStddev = stddev(counts);

  return {
    latencyP50: percentile(latencies, 50),
    latencyP99: percentile(latencies, 99),
    throughput: Math.round(throughput),
    correctnessPct,
    lifecycleIntegrityPct,
    fairnessStddev: Math.round(fairnessStddev * 100) / 100,
    lagP99: lags.length > 0 ? percentile(lags, 99) : null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "+" + "=".repeat(62) + "+");
  console.log("|" + `  Benchmark 3: Subagent Tree Width Ramp -- ${RUNTIME}`.padEnd(62) + "|");
  console.log(
    "|" +
      `  Steps: [${STEPS.join(", ")}] x ${RUNS_PER_STEP} runs, ${DELTA_COUNT} deltas/session`.padEnd(
        62,
      ) +
      "|",
  );
  console.log("+" + "=".repeat(62) + "+\n");

  const benchmarkSteps: BenchmarkStep[] = [];

  for (const step of STEPS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  Step: ${step} parent sessions (${step * 3} subagents)`);
    console.log(`${"─".repeat(60)}`);

    const runResults: Array<{
      metrics: ReturnType<typeof computeRunMetrics>;
      result: RunResult;
    }> = [];

    for (let run = 1; run <= RUNS_PER_STEP; run++) {
      log(`Run ${run}/${RUNS_PER_STEP} with ${step} sessions...`);

      const result = RUNTIME === "elixir" ? await runElixirStep(step) : await runNodeStep(step);

      console.log(""); // newline after progress line

      const metrics = computeRunMetrics(result, step);

      // Print per-session subagent integrity
      for (const s of result.allStats) {
        const ok =
          s.spawnBegins === 3 &&
          s.spawnEnds === 3 &&
          s.interactionBegins === 3 &&
          s.interactionEnds === 3;
        if (!ok) {
          log(
            `  WARN ${s.id}: spawns=${s.spawnBegins}/${s.spawnEnds} interactions=${s.interactionBegins}/${s.interactionEnds} deltas=${s.deltaCount}`,
          );
        }
      }

      log(
        `  run=${run} throughput=${metrics.throughput} evt/s integrity=${metrics.lifecycleIntegrityPct.toFixed(0)}% fairness_stddev=${metrics.fairnessStddev} correctness=${metrics.correctnessPct.toFixed(0)}%`,
      );

      runResults.push({ metrics, result });

      if (run < RUNS_PER_STEP) {
        log(`  Cooling down ${COOLDOWN_MS}ms...`);
        await sleep(COOLDOWN_MS);
      }
    }

    // Take median across runs for each metric
    const medianThroughput = median(runResults.map((r) => r.metrics.throughput));
    const medianLatencyP50 = median(runResults.map((r) => r.metrics.latencyP50));
    const medianLatencyP99 = median(runResults.map((r) => r.metrics.latencyP99));
    const medianCorrectness = median(runResults.map((r) => r.metrics.correctnessPct));
    const medianIntegrity = median(runResults.map((r) => r.metrics.lifecycleIntegrityPct));
    const medianFairness = median(runResults.map((r) => r.metrics.fairnessStddev));
    const medianMemory = median(runResults.map((r) => r.result.memoryBytes));
    const medianPerSessionMem = median(runResults.map((r) => r.result.perSessionMemoryBytes ?? 0));
    const medianStartup = median(runResults.map((r) => r.result.startupMs));
    const medianLagP99 =
      RUNTIME === "node" ? median(runResults.map((r) => r.metrics.lagP99 ?? 0)) : null;
    const medianSchedUtil =
      RUNTIME === "elixir" ? median(runResults.map((r) => r.result.schedulerUtilAvg ?? 0)) : null;

    // Use the median run's time series
    const medianRunIdx = Math.floor(RUNS_PER_STEP / 2);
    const medianTimeSeries = runResults[medianRunIdx]!.result.metricSnapshots;

    const benchmarkStep: BenchmarkStep = {
      benchmark: "subagent-ramp",
      runtime: RUNTIME as "node" | "elixir",
      step,
      stepLabel: `${step} parents (${step * 3} subagents)`,
      metrics: {
        memory_bytes: medianMemory,
        per_session_memory_bytes: medianPerSessionMem || null,
        latency_p50_ms: medianLatencyP50,
        latency_p99_ms: medianLatencyP99,
        throughput_events_per_sec: medianThroughput,
        event_loop_lag_p99_ms: medianLagP99,
        scheduler_util_avg: medianSchedUtil,
        correctness_pct: medianCorrectness,
        startup_ms: medianStartup,
        lifecycle_integrity_pct: medianIntegrity,
        fairness_stddev: medianFairness,
      },
      timeSeries: medianTimeSeries,
    };

    benchmarkSteps.push(benchmarkStep);

    log(
      `MEDIAN: throughput=${medianThroughput} evt/s latency_p50=${medianLatencyP50.toFixed(0)}ms integrity=${medianIntegrity.toFixed(0)}% fairness=${medianFairness}`,
    );

    // Cooldown between steps
    if (step !== STEPS[STEPS.length - 1]) {
      log(`Cooling down ${COOLDOWN_MS}ms before next step...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log("\n" + "=".repeat(64));
  console.log("  SUBAGENT TREE WIDTH RAMP RESULTS");
  console.log("=".repeat(64));
  console.log("");
  console.log(
    "  Step".padEnd(30) +
      "Throughput".padEnd(14) +
      "Integrity".padEnd(12) +
      "Fairness".padEnd(12) +
      "P50 lat",
  );
  console.log("  " + "-".repeat(72));

  for (const s of benchmarkSteps) {
    const label = s.stepLabel.padEnd(28);
    const tput = `${s.metrics.throughput_events_per_sec} evt/s`.padEnd(14);
    const integ = `${s.metrics.lifecycle_integrity_pct.toFixed(0)}%`.padEnd(12);
    const fair = `${s.metrics.fairness_stddev}`.padEnd(12);
    const lat = `${s.metrics.latency_p50_ms.toFixed(0)}ms`;
    console.log(`  ${label}${tput}${integ}${fair}${lat}`);
  }

  console.log("");

  // Check for throughput linearity
  if (benchmarkSteps.length >= 2) {
    const first = benchmarkSteps[0]!;
    const last = benchmarkSteps[benchmarkSteps.length - 1]!;
    const sessionRatio = last.step / first.step;
    const throughputRatio =
      last.metrics.throughput_events_per_sec / (first.metrics.throughput_events_per_sec || 1);
    const scalingEfficiency = throughputRatio / sessionRatio;
    console.log(
      `  Scaling efficiency: ${(scalingEfficiency * 100).toFixed(1)}% (${first.step}->${last.step} sessions)`,
    );
    if (scalingEfficiency < 0.5) {
      console.log("  WARNING: Throughput does NOT scale linearly. Event routing is a bottleneck.");
    } else if (scalingEfficiency < 0.8) {
      console.log("  NOTE: Sub-linear scaling detected. Some overhead from event routing.");
    } else {
      console.log("  OK: Throughput scales near-linearly with session count.");
    }
  }

  console.log("");

  // Write output
  const filename = `benchmark-subagent-ramp-${RUNTIME}-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(benchmarkSteps, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("=".repeat(64));

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
