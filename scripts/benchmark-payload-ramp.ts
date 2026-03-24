#!/usr/bin/env bun
/**
 * benchmark-payload-ramp.ts — Benchmark 2: Payload Size Ramp ("The Noisy Neighbor Chart")
 *
 * Measures how one heavy session with increasing delta sizes affects 5 light
 * neighbor sessions. The key metric is light session first-delta latency —
 * how much the heavy session degrades its neighbors.
 *
 * Usage:
 *   bun run scripts/benchmark-payload-ramp.ts --runtime=node
 *   bun run scripts/benchmark-payload-ramp.ts --runtime=elixir
 *   bun run scripts/benchmark-payload-ramp.ts --runtime=node --steps=0.1,1,5
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

const DEFAULT_PAYLOAD_STEPS = [0.1, 1, 5, 10, 50, 100, 250, 500];
const stepsArg = process.argv.find((a) => a.startsWith("--steps="))?.split("=")[1];
const PAYLOAD_STEPS = stepsArg ? stepsArg.split(",").map(Number) : DEFAULT_PAYLOAD_STEPS;

const RUNS_PER_STEP = 3;
const LIGHT_COUNT = 5;
const HEAVY_DELTA_COUNT = 500;
const HEAVY_DELAY_MS = 1;
const LIGHT_DELTA_COUNT = 100;
const LIGHT_DELTA_SIZE_KB = 0.1;
const LIGHT_DELAY_MS = 10;
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

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

interface SessionStats {
  id: string;
  role: "heavy" | "light";
  deltaCount: number;
  turnsCompleted: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  turnAcceptedAt: number | null;
  firstDeltaLatencyMs: number | null;
  errors: string[];
}

function createStats(id: string, role: "heavy" | "light"): SessionStats {
  return {
    id,
    role,
    deltaCount: 0,
    turnsCompleted: 0,
    firstDeltaAt: null,
    lastDeltaAt: null,
    turnAcceptedAt: null,
    firstDeltaLatencyMs: null,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

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
    heavy_throughput_eps: number;
    light_throughput_eps: number;
  };
  timeSeries: Array<{ elapsed_ms: number; [key: string]: number }>;
}

interface RunResult {
  heavyStats: SessionStats;
  lightStats: SessionStats[];
  eventTimestamps: number[];
  lags: number[];
  metricSnapshots: any[];
  startupMs: number;
  peakMemoryBytes: number;
  perSessionMemoryBytes: number | null;
  schedulerUtilAvg: number | null;
}

// ---------------------------------------------------------------------------
// Node runtime — one run
// ---------------------------------------------------------------------------

async function runNodeStep(payloadKb: number): Promise<RunResult> {
  const heavyStats = createStats(`heavy-node-${payloadKb}-${Date.now()}`, "heavy");
  const lightStats: SessionStats[] = [];
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

  // Helper to spawn and initialize a session
  async function spawnSession(
    sid: string,
    stats: SessionStats,
    deltaCount: number,
    deltaSizeKb: number,
    delayMs: number,
  ) {
    const child = spawn(
      "bun",
      [
        "run",
        "scripts/mock-codex-server.ts",
        String(deltaCount),
        String(deltaSizeKb),
        String(delayMs),
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
          if (!stats.firstDeltaAt) {
            stats.firstDeltaAt = now;
            if (stats.turnAcceptedAt) {
              stats.firstDeltaLatencyMs = now - stats.turnAcceptedAt;
            }
          }
          stats.lastDeltaAt = now;
        }
        if (msg.method === "turn/completed") stats.turnsCompleted++;
      } catch {}
    });
    child.stderr?.resume();

    const rpc = (method: string, params: any, timeoutMs = 30000) =>
      new Promise<any>((resolve, reject) => {
        const id = session.nextId++;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error("timeout"));
        }, timeoutMs);
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
      await rpc("initialize", {
        clientInfo: { name: "benchmark", version: "1.0" },
        capabilities: {},
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const threadResult = await rpc("thread/start", { cwd: process.cwd() });
      session.codexThreadId = threadResult?.thread?.id ?? null;
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }

    return { session, rpc };
  }

  // Spawn heavy session
  await spawnSession(heavyStats.id, heavyStats, HEAVY_DELTA_COUNT, payloadKb, HEAVY_DELAY_MS);

  // Spawn light sessions
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const sid = `light-node-${i}-${payloadKb}-${Date.now()}`;
    const stats = createStats(sid, "light");
    lightStats.push(stats);
    await spawnSession(sid, stats, LIGHT_DELTA_COUNT, LIGHT_DELTA_SIZE_KB, LIGHT_DELAY_MS);
  }

  const startupMs = Date.now() - startPhaseStart;

  // Fire all 6 turns simultaneously
  const allStats = [heavyStats, ...lightStats];
  const turnTimeout = payloadKb >= 250 ? 180_000 : 60_000;

  for (const stats of allStats) {
    const session = sessions.get(stats.id);
    if (!session || stats.errors.length > 0) continue;

    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = session.nextId++;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error("timeout"));
        }, turnTimeout);
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

    const turnPromise = rpc("turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: `payload-ramp ${stats.role} ${payloadKb}KB` }],
    });

    turnPromise
      .then(() => {
        stats.turnAcceptedAt = Date.now();
      })
      .catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for completion
  const maxWait = payloadKb >= 250 ? 180_000 : 120_000;
  const end = Date.now() + maxWait;
  const metricSnapshots: any[] = [];
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

    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;
    await sleep(1000);
  }

  clearInterval(lagTimer);

  const peakMemoryBytes = Math.max(
    ...metricSnapshots.map((m: any) => m.rss || 0),
    process.memoryUsage().rss,
  );

  // Kill all
  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  return {
    heavyStats,
    lightStats,
    eventTimestamps,
    lags,
    metricSnapshots,
    startupMs,
    peakMemoryBytes,
    perSessionMemoryBytes: null,
    schedulerUtilAvg: null,
  };
}

// ---------------------------------------------------------------------------
// Elixir runtime — one run
// ---------------------------------------------------------------------------

async function runElixirStep(payloadKb: number): Promise<RunResult> {
  const heavyStats = createStats(`heavy-elixir-${payloadKb}-${Date.now()}`, "heavy");
  const lightStats: SessionStats[] = [];
  const eventTimestamps: number[] = [];

  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      // Match by threadId
      const allStats = [heavyStats, ...lightStats];
      const stats = allStats.find((s) => s.id === raw.threadId);
      if (!stats) return;
      if (raw.method === "item/agentMessage/delta") {
        stats.deltaCount++;
        const now = Date.now();
        eventTimestamps.push(now);
        if (!stats.firstDeltaAt) {
          stats.firstDeltaAt = now;
          if (stats.turnAcceptedAt) {
            stats.firstDeltaLatencyMs = now - stats.turnAcceptedAt;
          }
        }
        stats.lastDeltaAt = now;
      }
      if (raw.method === "turn/completed") stats.turnsCompleted++;
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();

  const startPhaseStart = Date.now();

  // Start heavy session
  try {
    await mgr.startSession({
      threadId: heavyStats.id,
      provider: "mock",
      cwd: process.cwd(),
      providerOptions: {
        mock: { deltaCount: HEAVY_DELTA_COUNT, deltaSizeKb: payloadKb, delayMs: HEAVY_DELAY_MS },
      },
    });
  } catch (e) {
    heavyStats.errors.push(e instanceof Error ? e.message : String(e));
  }

  // Start light sessions
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const sid = `light-elixir-${i}-${payloadKb}-${Date.now()}`;
    const stats = createStats(sid, "light");
    lightStats.push(stats);
    try {
      await mgr.startSession({
        threadId: sid,
        provider: "mock",
        cwd: process.cwd(),
        providerOptions: {
          mock: {
            deltaCount: LIGHT_DELTA_COUNT,
            deltaSizeKb: LIGHT_DELTA_SIZE_KB,
            delayMs: LIGHT_DELAY_MS,
          },
        },
      });
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const startupMs = Date.now() - startPhaseStart;

  // Fire all 6 turns simultaneously
  const allStats = [heavyStats, ...lightStats];
  const turnPromises = allStats
    .filter((s) => s.errors.length === 0)
    .map((s) =>
      mgr
        .sendTurn(s.id, {
          input: [{ type: "text", text: `payload-ramp ${s.role} ${payloadKb}KB` }],
        })
        .then(() => {
          s.turnAcceptedAt = Date.now();
        })
        .catch((e: any) => s.errors.push(e instanceof Error ? e.message : String(e))),
    );
  await Promise.all(turnPromises);

  // Wait for completion with metric snapshots
  const maxWait = payloadKb >= 250 ? 180_000 : 120_000;
  const end = Date.now() + maxWait;
  const metricSnapshots: any[] = [];
  let peakMemoryBytes = 0;
  let schedulerUtilAvg: number | null = null;
  let perSessionMemoryBytes: number | null = null;

  while (Date.now() < end) {
    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;
    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      metricSnapshots.push({ elapsed_ms: Date.now() - t0, ...m });
      if (m.beam?.total_memory && m.beam.total_memory > peakMemoryBytes) {
        peakMemoryBytes = m.beam.total_memory;
      }
      if (m.beam?.scheduler_utilization && Array.isArray(m.beam.scheduler_utilization)) {
        schedulerUtilAvg =
          m.beam.scheduler_utilization.reduce((s: number, u: number) => s + u, 0) /
          m.beam.scheduler_utilization.length;
      }
    } catch {}
    await sleep(1000);
  }

  // Fetch final metrics for per-session memory
  try {
    const postMetrics = (await fetch(METRICS_URL).then((r) => r.json())) as any;
    if (postMetrics.beam?.total_memory && postMetrics.beam.total_memory > peakMemoryBytes) {
      peakMemoryBytes = postMetrics.beam.total_memory;
    }
    const sessionData = (postMetrics.sessions ?? [])
      .filter((s: any) => {
        const tid = String(s.thread_id ?? "");
        return tid.includes("heavy-elixir") || tid.includes("light-elixir");
      })
      .map((s: any) => s.memory ?? 0);
    if (sessionData.length > 0) {
      perSessionMemoryBytes =
        sessionData.reduce((a: number, b: number) => a + b, 0) / sessionData.length;
    }
  } catch {}

  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();

  return {
    heavyStats,
    lightStats,
    eventTimestamps,
    lags: [],
    metricSnapshots,
    startupMs,
    peakMemoryBytes,
    perSessionMemoryBytes,
    schedulerUtilAvg,
  };
}

// ---------------------------------------------------------------------------
// Run a single step (with median over RUNS_PER_STEP)
// ---------------------------------------------------------------------------

async function runStep(payloadKb: number): Promise<BenchmarkStep> {
  const runResults: RunResult[] = [];

  for (let run = 1; run <= RUNS_PER_STEP; run++) {
    log(`  Run ${run}/${RUNS_PER_STEP} for ${payloadKb}KB...`);
    const result =
      RUNTIME === "elixir" ? await runElixirStep(payloadKb) : await runNodeStep(payloadKb);
    runResults.push(result);

    // Log run summary
    const lightCompleted = result.lightStats.filter((s) => s.turnsCompleted > 0).length;
    const lightLatencies = result.lightStats
      .map((s) => s.firstDeltaLatencyMs)
      .filter((l): l is number => l !== null);
    const heavyDeltas = result.heavyStats.deltaCount;
    log(
      `    Heavy: ${heavyDeltas}/${HEAVY_DELTA_COUNT} deltas | Light: ${lightCompleted}/${LIGHT_COUNT} completed, latencies=[${lightLatencies.map((l) => l.toFixed(0)).join(",")}]ms`,
    );

    if (run < RUNS_PER_STEP) {
      log(`    Cooldown ${COOLDOWN_MS / 1000}s...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // Compute medians across runs
  const allLightLatencies = runResults.flatMap((r) =>
    r.lightStats.map((s) => s.firstDeltaLatencyMs).filter((l): l is number => l !== null),
  );

  // Per-run aggregates for taking medians
  const runMemories = runResults.map((r) => r.peakMemoryBytes);
  const runStartups = runResults.map((r) => r.startupMs);
  const runLagP99s = runResults.map((r) => (r.lags.length > 0 ? percentile(r.lags, 99) : 0));
  const runSchedulerUtils = runResults
    .map((r) => r.schedulerUtilAvg)
    .filter((u): u is number => u !== null);
  const runPerSessionMem = runResults
    .map((r) => r.perSessionMemoryBytes)
    .filter((m): m is number => m !== null);

  // Throughput per run
  const runHeavyThroughputs = runResults.map((r) => {
    const h = r.heavyStats;
    if (h.firstDeltaAt && h.lastDeltaAt && h.lastDeltaAt > h.firstDeltaAt) {
      return h.deltaCount / ((h.lastDeltaAt - h.firstDeltaAt) / 1000);
    }
    return 0;
  });

  const runLightThroughputs = runResults.map((r) => {
    const throughputs = r.lightStats.map((s) => {
      if (s.firstDeltaAt && s.lastDeltaAt && s.lastDeltaAt > s.firstDeltaAt) {
        return s.deltaCount / ((s.lastDeltaAt - s.firstDeltaAt) / 1000);
      }
      return 0;
    });
    return throughputs.length > 0 ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length : 0;
  });

  const runTotalThroughputs = runResults.map((r) => {
    if (r.eventTimestamps.length > 1) {
      const dur = (r.eventTimestamps[r.eventTimestamps.length - 1]! - r.eventTimestamps[0]!) / 1000;
      return dur > 0 ? r.eventTimestamps.length / dur : 0;
    }
    return 0;
  });

  // Correctness: light sessions deltas received / expected
  const runCorrectness = runResults.map((r) => {
    const totalReceived = r.lightStats.reduce((s, st) => s + st.deltaCount, 0);
    const totalExpected = LIGHT_COUNT * LIGHT_DELTA_COUNT;
    return totalExpected > 0 ? (totalReceived / totalExpected) * 100 : 100;
  });

  // Use last run's time series for the step
  const lastRun = runResults[runResults.length - 1]!;
  const timeSeries = lastRun.metricSnapshots.map((m: any) => {
    const base: { elapsed_ms: number; [key: string]: number } = { elapsed_ms: m.elapsed_ms ?? 0 };
    if (m.heapUsed) base.heapUsed = m.heapUsed;
    if (m.rss) base.rss = m.rss;
    if (m.completed !== undefined) base.completed = m.completed;
    if (m.totalDeltas !== undefined) base.totalDeltas = m.totalDeltas;
    if (m.beam?.total_memory) base.beam_memory = m.beam.total_memory;
    if (m.beam?.process_count) base.beam_processes = m.beam.process_count;
    return base;
  });

  return {
    benchmark: "payload-ramp",
    runtime: RUNTIME as "node" | "elixir",
    step: payloadKb,
    stepLabel: `${payloadKb}KB deltas`,
    metrics: {
      memory_bytes: median(runMemories),
      per_session_memory_bytes: runPerSessionMem.length > 0 ? median(runPerSessionMem) : null,
      latency_p50_ms: percentile(allLightLatencies, 50),
      latency_p99_ms: percentile(allLightLatencies, 99),
      throughput_events_per_sec: median(runTotalThroughputs),
      event_loop_lag_p99_ms: RUNTIME === "node" ? median(runLagP99s) : null,
      scheduler_util_avg: runSchedulerUtils.length > 0 ? median(runSchedulerUtils) : null,
      correctness_pct: median(runCorrectness),
      startup_ms: median(runStartups),
      heavy_throughput_eps: median(runHeavyThroughputs),
      light_throughput_eps: median(runLightThroughputs),
    },
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "=".repeat(64));
  console.log("  Benchmark 2: Payload Size Ramp — The Noisy Neighbor Chart");
  console.log(`  Runtime: ${RUNTIME}`);
  console.log(`  Steps: [${PAYLOAD_STEPS.join(", ")}] KB`);
  console.log(`  Runs per step: ${RUNS_PER_STEP}`);
  console.log(
    `  Heavy: ${HEAVY_DELTA_COUNT} deltas @ 1ms | Light: ${LIGHT_COUNT}x ${LIGHT_DELTA_COUNT} deltas @ ${LIGHT_DELAY_MS}ms`,
  );
  console.log("=".repeat(64) + "\n");

  const steps: BenchmarkStep[] = [];

  for (let i = 0; i < PAYLOAD_STEPS.length; i++) {
    const payloadKb = PAYLOAD_STEPS[i]!;
    log(`Step ${i + 1}/${PAYLOAD_STEPS.length}: ${payloadKb}KB deltas`);

    const step = await runStep(payloadKb);
    steps.push(step);

    // Print step summary
    const m = step.metrics;
    console.log("");
    console.log(`  --- ${step.stepLabel} ---`);
    console.log(
      `  Light latency:  p50=${m.latency_p50_ms.toFixed(1)}ms  p99=${m.latency_p99_ms.toFixed(1)}ms`,
    );
    console.log(`  Heavy throughput: ${m.heavy_throughput_eps.toFixed(0)} events/s`);
    console.log(`  Light throughput: ${m.light_throughput_eps.toFixed(0)} events/s (avg)`);
    console.log(`  Total throughput: ${m.throughput_events_per_sec.toFixed(0)} events/s`);
    console.log(`  Correctness: ${m.correctness_pct.toFixed(1)}%`);
    console.log(`  Memory: ${(m.memory_bytes / 1024 / 1024).toFixed(1)}MB`);
    if (m.event_loop_lag_p99_ms !== null) {
      console.log(`  Event loop lag p99: ${m.event_loop_lag_p99_ms.toFixed(1)}ms`);
    }
    if (m.scheduler_util_avg !== null) {
      console.log(`  Scheduler util avg: ${(m.scheduler_util_avg * 100).toFixed(1)}%`);
    }
    console.log(`  Startup: ${m.startup_ms.toFixed(0)}ms`);
    console.log("");

    // Cooldown between steps
    if (i < PAYLOAD_STEPS.length - 1) {
      log(`Cooldown ${COOLDOWN_MS / 1000}s before next step...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // Final summary table
  console.log("\n" + "=".repeat(64));
  console.log("  PAYLOAD RAMP RESULTS SUMMARY");
  console.log("=".repeat(64));
  console.log("");
  console.log("  Step(KB)  Latency-p50  Latency-p99  Heavy-eps  Light-eps  Correct%");
  console.log("  " + "-".repeat(62));
  for (const step of steps) {
    const m = step.metrics;
    console.log(
      `  ${String(step.step).padStart(8)}` +
        `  ${m.latency_p50_ms.toFixed(1).padStart(11)}` +
        `  ${m.latency_p99_ms.toFixed(1).padStart(11)}` +
        `  ${m.heavy_throughput_eps.toFixed(0).padStart(9)}` +
        `  ${m.light_throughput_eps.toFixed(0).padStart(9)}` +
        `  ${m.correctness_pct.toFixed(1).padStart(8)}`,
    );
  }
  console.log("");

  // Write output
  const timestamp = Date.now();
  const filename = `benchmark-payload-ramp-${RUNTIME}-${timestamp}.json`;
  const output = {
    benchmark: "payload-ramp",
    runtime: RUNTIME,
    timestamp,
    config: {
      payloadSteps: PAYLOAD_STEPS,
      runsPerStep: RUNS_PER_STEP,
      lightCount: LIGHT_COUNT,
      heavyDeltaCount: HEAVY_DELTA_COUNT,
      heavyDelayMs: HEAVY_DELAY_MS,
      lightDeltaCount: LIGHT_DELTA_COUNT,
      lightDeltaSizeKb: LIGHT_DELTA_SIZE_KB,
      lightDelayMs: LIGHT_DELAY_MS,
    },
    steps,
  };

  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("=".repeat(64));

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
