#!/usr/bin/env bun
/**
 * benchmark-failure-storm.ts — Benchmark 4: Failure Storm Under Load.
 *
 * Tests how many simultaneous session crashes each runtime can absorb
 * without affecting survivor sessions.
 *
 * For each crash step K in CRASH_STEPS, launches (TOTAL_SESSIONS - K) normal
 * sessions and K crash sessions. Crash sessions die after ~10 deltas.
 * Measures survivor completeness, latency spikes around crash events,
 * memory cleanup, and error cascading.
 *
 * Usage:
 *   bun run scripts/benchmark-failure-storm.ts --runtime=node
 *   bun run scripts/benchmark-failure-storm.ts --runtime=elixir
 *   bun run scripts/benchmark-failure-storm.ts --runtime=node --steps=0,1,3
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

const TOTAL_SESSIONS = 30;
const DEFAULT_CRASH_STEPS = [0, 1, 3, 5, 10, 15, 20];
const CRASH_STEPS: number[] = (() => {
  const flag = process.argv.find((a) => a.startsWith("--steps="));
  if (flag) return flag.split("=")[1]!.split(",").map(Number);
  return DEFAULT_CRASH_STEPS;
})();
const RUNS_PER_STEP = 3;
const DELTA_COUNT = 200;
const DELTA_SIZE_KB = 5;
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

function median(arr: number[]): number {
  return percentile(arr, 50);
}

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

interface SessionStats {
  id: string;
  role: "survivor" | "victim";
  deltaCount: number;
  turnsCompleted: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  errors: string[];
  crashedAt: number | null;
}

function createStats(id: string, role: "survivor" | "victim"): SessionStats {
  return {
    id,
    role,
    deltaCount: 0,
    turnsCompleted: 0,
    firstDeltaAt: null,
    lastDeltaAt: null,
    errors: [],
    crashedAt: null,
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
    survivor_error_count: number;
    crash_lag_spike_ms: number;
    memory_cleanup_bytes: number;
  };
  timeSeries: Array<{ elapsed_ms: number; [key: string]: number }>;
}

// ---------------------------------------------------------------------------
// Single run result
// ---------------------------------------------------------------------------

interface RunResult {
  survivorStats: SessionStats[];
  victimStats: SessionStats[];
  crashTimestamps: number[];
  lagMeasurements: Array<{ ts: number; lag_ms: number }>;
  memoryBefore: number;
  memoryAfter: number;
  survivorFirstDeltaLatencies: number[];
  survivorThroughput: number;
  startupMs: number;
  timeSeries: Array<{ elapsed_ms: number; [key: string]: number }>;
}

// ---------------------------------------------------------------------------
// Node runtime — child process per session
// ---------------------------------------------------------------------------

async function runNodeSingle(K: number): Promise<RunResult> {
  const survivors = TOTAL_SESSIONS - K;
  const allStats: SessionStats[] = [];
  const crashTimestamps: number[] = [];
  const lagMeasurements: Array<{ ts: number; lag_ms: number }> = [];

  // Event loop lag tracking
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    lagMeasurements.push({ ts: Date.now(), lag_ms: Math.max(0, lag) });
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

  // Spawn survivor sessions
  for (let i = 0; i < survivors; i++) {
    const sid = `survivor-node-${i}-${Date.now()}`;
    const stats = createStats(sid, "survivor");
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
  }

  // Spawn victim (crash) sessions
  for (let i = 0; i < K; i++) {
    const sid = `victim-node-${i}-${Date.now()}`;
    const stats = createStats(sid, "victim");
    allStats.push(stats);

    const child = spawn(
      "bun",
      [
        "run",
        "scripts/mock-codex-server.ts",
        String(DELTA_COUNT),
        String(DELTA_SIZE_KB),
        String(DELAY_MS),
        "crash",
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );

    // Detect crash via exit event
    child.on("exit", (code) => {
      if (code !== 0) {
        stats.crashedAt = Date.now();
        crashTimestamps.push(Date.now());
      }
    });

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
  }

  const startupMs = Date.now() - startPhaseStart;
  log(
    `  ${TOTAL_SESSIONS} sessions started in ${(startupMs / 1000).toFixed(1)}s (${survivors} survivors, ${K} victims)`,
  );

  // Memory before sending turns
  const memBefore = process.memoryUsage().heapUsed;

  // Fire ALL turns simultaneously
  const turnSendTime = Date.now();
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
      input: [{ type: "text", text: "failure storm test" }],
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for survivors to complete (or crash events + 30s)
  const timeSeries: Array<{ elapsed_ms: number; [key: string]: number }> = [];
  const maxWait = Date.now() + 120_000;
  let allCrashesDone = K === 0;
  let crashSettledAt: number | null = K === 0 ? Date.now() : null;

  while (Date.now() < maxWait) {
    const survivorsDone = allStats.filter(
      (s) => s.role === "survivor" && s.turnsCompleted > 0,
    ).length;
    const victimsCrashed = allStats.filter(
      (s) => s.role === "victim" && s.crashedAt !== null,
    ).length;
    const survivorDeltas = allStats
      .filter((s) => s.role === "survivor")
      .reduce((sum, s) => sum + s.deltaCount, 0);
    const mem = process.memoryUsage();

    timeSeries.push({
      elapsed_ms: Date.now() - turnSendTime,
      survivor_completed: survivorsDone,
      victim_crashed: victimsCrashed,
      survivor_deltas: survivorDeltas,
      heap_used: mem.heapUsed,
      rss: mem.rss,
    });

    if (!allCrashesDone && victimsCrashed >= K) {
      allCrashesDone = true;
      crashSettledAt = Date.now();
      log(`  All ${K} victims crashed. Continuing to monitor survivors...`);
    }

    // Done when all survivors completed (or errored)
    const allSurvivorsSettled = allStats
      .filter((s) => s.role === "survivor")
      .every((s) => s.turnsCompleted > 0 || s.errors.length > 0);
    if (allSurvivorsSettled) break;

    // If crashes settled, wait up to 30 more seconds for survivors
    if (crashSettledAt && Date.now() - crashSettledAt > 30_000) {
      log(`  30s after crashes, some survivors still incomplete. Breaking.`);
      break;
    }

    process.stdout.write(
      `\r  ${ts()} survivors=${survivorsDone}/${survivors} victims_crashed=${victimsCrashed}/${K} deltas=${survivorDeltas}`,
    );
    await sleep(1000);
  }

  console.log("");
  clearInterval(lagTimer);

  // Memory after
  const memAfter = process.memoryUsage().heapUsed;

  // Kill all remaining processes
  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  // Compute survivor first-delta latencies
  const survivorFirstDeltaLatencies = allStats
    .filter((s) => s.role === "survivor" && s.firstDeltaAt)
    .map((s) => s.firstDeltaAt! - turnSendTime);

  // Compute survivor throughput
  const survivorEvents = allStats
    .filter((s) => s.role === "survivor")
    .reduce((sum, s) => sum + s.deltaCount, 0);
  const survivorFirstDelta = Math.min(
    ...allStats.filter((s) => s.role === "survivor" && s.firstDeltaAt).map((s) => s.firstDeltaAt!),
  );
  const survivorLastDelta = Math.max(
    ...allStats.filter((s) => s.role === "survivor" && s.lastDeltaAt).map((s) => s.lastDeltaAt!),
  );
  const survivorStreamDuration = (survivorLastDelta - survivorFirstDelta) / 1000;
  const survivorThroughput =
    survivorStreamDuration > 0 ? survivorEvents / survivorStreamDuration : 0;

  return {
    survivorStats: allStats.filter((s) => s.role === "survivor"),
    victimStats: allStats.filter((s) => s.role === "victim"),
    crashTimestamps,
    lagMeasurements,
    memoryBefore: memBefore,
    memoryAfter: memAfter,
    survivorFirstDeltaLatencies,
    survivorThroughput,
    startupMs,
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Elixir runtime — HarnessClientManager
// ---------------------------------------------------------------------------

async function runElixirSingle(K: number): Promise<RunResult> {
  const survivors = TOTAL_SESSIONS - K;
  const allStats: SessionStats[] = [];
  const crashTimestamps: number[] = [];
  const lagMeasurements: Array<{ ts: number; lag_ms: number }> = [];

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.id === raw.threadId);
      if (!stats) return;
      if (raw.method === "item/agentMessage/delta") {
        stats.deltaCount++;
        const now = Date.now();
        if (!stats.firstDeltaAt) stats.firstDeltaAt = now;
        stats.lastDeltaAt = now;
      }
      if (raw.method === "turn/completed") stats.turnsCompleted++;
      // Detect crash events for victims
      if (raw.method === "session/error" || raw.method === "session/exited") {
        if (stats.role === "victim") {
          stats.crashedAt = Date.now();
          crashTimestamps.push(Date.now());
        } else {
          // Error on a survivor means crash cascaded!
          stats.errors.push(`unexpected ${raw.method}`);
        }
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("  Connected to harness");

  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;
  let baselineMemory = 0;
  try {
    const baseline = (await fetch(METRICS_URL).then((r) => r.json())) as any;
    baselineMemory = baseline.beam?.total_memory ?? 0;
  } catch {}

  const startPhaseStart = Date.now();

  // Start survivor sessions
  for (let i = 0; i < survivors; i++) {
    const sid = `survivor-elixir-${i}-${Date.now()}`;
    const stats = createStats(sid, "survivor");
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
  }

  // Start victim (crash) sessions
  for (let i = 0; i < K; i++) {
    const sid = `victim-elixir-${i}-${Date.now()}`;
    const stats = createStats(sid, "victim");
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
            mode: "crash",
          },
        },
      });
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const startupMs = Date.now() - startPhaseStart;
  log(
    `  ${TOTAL_SESSIONS} sessions started in ${(startupMs / 1000).toFixed(1)}s (${survivors} survivors, ${K} victims)`,
  );

  // Memory before sending turns
  let memBefore = 0;
  try {
    const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
    memBefore = m.beam?.total_memory ?? 0;
  } catch {}

  // Fire ALL turns simultaneously
  const turnSendTime = Date.now();
  const turnPromises = allStats
    .filter((s) => s.errors.length === 0)
    .map((s) =>
      mgr.sendTurn(s.id, { input: [{ type: "text", text: "failure storm test" }] }).catch(() => {}),
    );
  await Promise.all(turnPromises);
  log("  All turns accepted");

  // Wait for survivors to complete
  const timeSeries: Array<{ elapsed_ms: number; [key: string]: number }> = [];
  const maxWait = Date.now() + 120_000;
  let allCrashesDone = K === 0;
  let crashSettledAt: number | null = K === 0 ? Date.now() : null;

  while (Date.now() < maxWait) {
    const survivorsDone = allStats.filter(
      (s) => s.role === "survivor" && s.turnsCompleted > 0,
    ).length;
    const victimsCrashed = allStats.filter(
      (s) => s.role === "victim" && s.crashedAt !== null,
    ).length;
    const survivorDeltas = allStats
      .filter((s) => s.role === "survivor")
      .reduce((sum, s) => sum + s.deltaCount, 0);

    let beamMemory = 0;
    let processCount = 0;
    let schedulerUtil = 0;
    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      beamMemory = m.beam?.total_memory ?? 0;
      processCount = m.beam?.process_count ?? 0;
      const sched = m.beam?.scheduler_utilization;
      if (Array.isArray(sched) && sched.length > 0) {
        schedulerUtil = sched.reduce((s: number, u: number) => s + u, 0) / sched.length;
      }
    } catch {}

    timeSeries.push({
      elapsed_ms: Date.now() - turnSendTime,
      survivor_completed: survivorsDone,
      victim_crashed: victimsCrashed,
      survivor_deltas: survivorDeltas,
      beam_memory: beamMemory,
      process_count: processCount,
      scheduler_util: schedulerUtil,
    });

    if (!allCrashesDone && victimsCrashed >= K) {
      allCrashesDone = true;
      crashSettledAt = Date.now();
      log(`  All ${K} victims crashed. Continuing to monitor survivors...`);
    }

    const allSurvivorsSettled = allStats
      .filter((s) => s.role === "survivor")
      .every((s) => s.turnsCompleted > 0 || s.errors.length > 0);
    if (allSurvivorsSettled) break;

    if (crashSettledAt && Date.now() - crashSettledAt > 30_000) {
      log(`  30s after crashes, some survivors still incomplete. Breaking.`);
      break;
    }

    process.stdout.write(
      `\r  ${ts()} survivors=${survivorsDone}/${survivors} victims_crashed=${victimsCrashed}/${K} deltas=${survivorDeltas} procs=${processCount}`,
    );
    await sleep(1000);
  }

  console.log("");

  // Memory after
  let memAfter = 0;
  try {
    const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
    memAfter = m.beam?.total_memory ?? 0;
  } catch {}

  // Compute survivor first-delta latencies
  const survivorFirstDeltaLatencies = allStats
    .filter((s) => s.role === "survivor" && s.firstDeltaAt)
    .map((s) => s.firstDeltaAt! - turnSendTime);

  // Compute survivor throughput
  const survivorEvents = allStats
    .filter((s) => s.role === "survivor")
    .reduce((sum, s) => sum + s.deltaCount, 0);
  const survivorWithDeltas = allStats.filter(
    (s) => s.role === "survivor" && s.firstDeltaAt && s.lastDeltaAt,
  );
  const survivorFirstDelta =
    survivorWithDeltas.length > 0 ? Math.min(...survivorWithDeltas.map((s) => s.firstDeltaAt!)) : 0;
  const survivorLastDelta =
    survivorWithDeltas.length > 0 ? Math.max(...survivorWithDeltas.map((s) => s.lastDeltaAt!)) : 0;
  const survivorStreamDuration = (survivorLastDelta - survivorFirstDelta) / 1000;
  const survivorThroughput =
    survivorStreamDuration > 0 ? survivorEvents / survivorStreamDuration : 0;

  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();

  return {
    survivorStats: allStats.filter((s) => s.role === "survivor"),
    victimStats: allStats.filter((s) => s.role === "victim"),
    crashTimestamps,
    lagMeasurements,
    memoryBefore: memBefore,
    memoryAfter: memAfter,
    survivorFirstDeltaLatencies,
    survivorThroughput,
    startupMs,
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Compute crash lag spike: max lag within 2s of any crash event
// ---------------------------------------------------------------------------

function computeCrashLagSpike(
  crashTimestamps: number[],
  lagMeasurements: Array<{ ts: number; lag_ms: number }>,
): number {
  if (crashTimestamps.length === 0 || lagMeasurements.length === 0) return 0;

  let maxLag = 0;
  for (const crashTs of crashTimestamps) {
    for (const m of lagMeasurements) {
      if (Math.abs(m.ts - crashTs) <= 2000) {
        maxLag = Math.max(maxLag, m.lag_ms);
      }
    }
  }
  return maxLag;
}

// ---------------------------------------------------------------------------
// Run a single step (K crashes) with RUNS_PER_STEP repetitions, take median
// ---------------------------------------------------------------------------

async function runStep(K: number): Promise<BenchmarkStep> {
  const survivors = TOTAL_SESSIONS - K;
  const stepLabel = `${K} crashes / ${survivors} survivors`;
  log(`Step K=${K}: ${stepLabel}`);

  const runResults: RunResult[] = [];

  for (let run = 1; run <= RUNS_PER_STEP; run++) {
    log(`  Run ${run}/${RUNS_PER_STEP}`);
    const result = RUNTIME === "elixir" ? await runElixirSingle(K) : await runNodeSingle(K);
    runResults.push(result);

    // Progress summary
    const survivorComplete = result.survivorStats.filter((s) => s.turnsCompleted > 0).length;
    const survivorErrors = result.survivorStats.reduce((sum, s) => sum + s.errors.length, 0);
    const victimCrashed = result.victimStats.filter((s) => s.crashedAt !== null).length;
    const correctness =
      survivors > 0
        ? (result.survivorStats.reduce((sum, s) => sum + s.deltaCount, 0) /
            (survivors * DELTA_COUNT)) *
          100
        : 100;
    log(
      `    survivors_ok=${survivorComplete}/${survivors} victim_crashed=${victimCrashed}/${K} correctness=${correctness.toFixed(1)}% errors=${survivorErrors}`,
    );

    if (run < RUNS_PER_STEP) {
      log(`    Cooldown ${COOLDOWN_MS}ms...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // Take median of each metric across runs
  const medianOf = (fn: (r: RunResult) => number) => median(runResults.map(fn));

  const survivorErrorCount = medianOf((r) =>
    r.survivorStats.reduce((sum, s) => sum + s.errors.length, 0),
  );

  const correctnessPct = medianOf((r) => {
    if (survivors === 0) return 100;
    const totalDeltas = r.survivorStats.reduce((sum, s) => sum + s.deltaCount, 0);
    return (totalDeltas / (survivors * DELTA_COUNT)) * 100;
  });

  const crashLagSpike = medianOf((r) => computeCrashLagSpike(r.crashTimestamps, r.lagMeasurements));

  const memoryCleanup = medianOf((r) => Math.max(0, r.memoryBefore - r.memoryAfter));

  const latencyP50 = medianOf((r) => percentile(r.survivorFirstDeltaLatencies, 50));
  const latencyP99 = medianOf((r) => percentile(r.survivorFirstDeltaLatencies, 99));
  const throughput = medianOf((r) => r.survivorThroughput);
  const startupMs = medianOf((r) => r.startupMs);
  const memoryBytes = medianOf((r) => r.memoryAfter);

  const lagP99 =
    RUNTIME === "node"
      ? medianOf((r) => {
          const lags = r.lagMeasurements.map((m) => m.lag_ms);
          return percentile(lags, 99);
        })
      : null;

  // Use the middle run's time series for output
  const middleRun = runResults[Math.floor(runResults.length / 2)]!;

  return {
    benchmark: "failure-storm",
    runtime: RUNTIME as "node" | "elixir",
    step: K,
    stepLabel,
    metrics: {
      memory_bytes: memoryBytes,
      per_session_memory_bytes: survivors > 0 ? memoryBytes / survivors : null,
      latency_p50_ms: latencyP50,
      latency_p99_ms: latencyP99,
      throughput_events_per_sec: throughput,
      event_loop_lag_p99_ms: lagP99,
      scheduler_util_avg: null, // populated for elixir below
      correctness_pct: correctnessPct,
      startup_ms: startupMs,
      survivor_error_count: survivorErrorCount,
      crash_lag_spike_ms: crashLagSpike,
      memory_cleanup_bytes: memoryCleanup,
    },
    timeSeries: middleRun.timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(62) + "╗");
  console.log("║" + `  Benchmark 4: Failure Storm Under Load — ${RUNTIME}`.padEnd(62) + "║");
  console.log(
    "║" + `  ${TOTAL_SESSIONS} sessions, crash steps: [${CRASH_STEPS.join(",")}]`.padEnd(62) + "║",
  );
  console.log(
    "║" +
      `  ${DELTA_COUNT} deltas × ${DELTA_SIZE_KB}KB, ${RUNS_PER_STEP} runs/step`.padEnd(62) +
      "║",
  );
  console.log("╚" + "═".repeat(62) + "╝\n");

  const steps: BenchmarkStep[] = [];

  for (const K of CRASH_STEPS) {
    const step = await runStep(K);
    steps.push(step);

    console.log("");
    console.log(`  ── K=${K} (${step.stepLabel}) ──`);
    console.log(`     correctness:       ${step.metrics.correctness_pct.toFixed(1)}%`);
    console.log(`     survivor errors:   ${step.metrics.survivor_error_count}`);
    console.log(`     crash lag spike:   ${step.metrics.crash_lag_spike_ms.toFixed(1)}ms`);
    console.log(
      `     memory cleanup:    ${(step.metrics.memory_cleanup_bytes / 1024 / 1024).toFixed(2)}MB`,
    );
    console.log(
      `     latency p50/p99:   ${step.metrics.latency_p50_ms.toFixed(1)}ms / ${step.metrics.latency_p99_ms.toFixed(1)}ms`,
    );
    console.log(
      `     throughput:        ${Math.round(step.metrics.throughput_events_per_sec)} events/s`,
    );
    if (step.metrics.event_loop_lag_p99_ms != null) {
      console.log(`     event loop p99:   ${step.metrics.event_loop_lag_p99_ms.toFixed(1)}ms`);
    }
    console.log("");

    if (K < CRASH_STEPS[CRASH_STEPS.length - 1]!) {
      log(`Cooldown between steps...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // Summary table
  console.log("\n" + "═".repeat(90));
  console.log("  FAILURE STORM RESULTS SUMMARY");
  console.log("═".repeat(90));
  console.log(
    "  " +
      "K".padEnd(4) +
      "Label".padEnd(26) +
      "Correct%".padEnd(10) +
      "Errors".padEnd(8) +
      "LagSpike".padEnd(10) +
      "Cleanup".padEnd(10) +
      "Throughput".padEnd(12),
  );
  console.log("  " + "-".repeat(80));

  for (const s of steps) {
    console.log(
      "  " +
        String(s.step).padEnd(4) +
        s.stepLabel.padEnd(26) +
        `${s.metrics.correctness_pct.toFixed(1)}%`.padEnd(10) +
        String(s.metrics.survivor_error_count).padEnd(8) +
        `${s.metrics.crash_lag_spike_ms.toFixed(1)}ms`.padEnd(10) +
        `${(s.metrics.memory_cleanup_bytes / 1024 / 1024).toFixed(1)}MB`.padEnd(10) +
        `${Math.round(s.metrics.throughput_events_per_sec)} ev/s`.padEnd(12),
    );
  }

  console.log("═".repeat(90));

  // Write output
  const filename = `benchmark-failure-storm-${RUNTIME}-${Date.now()}.json`;
  const output = {
    benchmark: "failure-storm",
    runtime: RUNTIME,
    config: {
      totalSessions: TOTAL_SESSIONS,
      crashSteps: CRASH_STEPS,
      runsPerStep: RUNS_PER_STEP,
      deltaCount: DELTA_COUNT,
      deltaSizeKb: DELTA_SIZE_KB,
      delayMs: DELAY_MS,
      cooldownMs: COOLDOWN_MS,
    },
    steps,
  };
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
