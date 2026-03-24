#!/usr/bin/env bun
/**
 * benchmark-sustained-leak.ts — Benchmark 5: Sustained Leak Over Time.
 *
 * Runs one leaking session alongside M healthy sessions for 5 minutes,
 * measuring how the leak affects healthy session latency over time.
 * Produces TIME SERIES data (60 data points per variant at 5s intervals).
 *
 * Usage:
 *   bun run scripts/benchmark-sustained-leak.ts --runtime=node
 *   bun run scripts/benchmark-sustained-leak.ts --runtime=elixir
 *   bun run scripts/benchmark-sustained-leak.ts --runtime=node --steps=1,5
 *   bun run scripts/benchmark-sustained-leak.ts --runtime=node --duration=60000
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

const DEFAULT_HEALTHY_STEPS = [1, 5, 10, 20];
const stepsArg = process.argv.find((a) => a.startsWith("--steps="))?.split("=")[1];
const HEALTHY_STEPS: number[] = stepsArg ? stepsArg.split(",").map(Number) : DEFAULT_HEALTHY_STEPS;

const durationArg = process.argv.find((a) => a.startsWith("--duration="))?.split("=")[1];
const DURATION_MS = durationArg ? Number(durationArg) : 300_000;
const SAMPLE_INTERVAL_MS = 5000;
const RUNS_PER_STEP = 1;

const LEAK_DELTA_COUNT = 999999;
const LEAK_DELTA_SIZE_KB = 50;
const LEAK_DELAY_MS = 50;

const HEALTHY_DELTA_COUNT = 200;
const HEALTHY_DELTA_SIZE_KB = 1;
const HEALTHY_DELAY_MS = 5;
const HEALTHY_TURN_INTERVAL_MS = 15000;

const COOLDOWN_MS = 10000;

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimeSeriesPoint {
  elapsed_ms: number;
  memory_bytes: number;
  healthy_turn_latency_ms: number;
  event_loop_lag_ms: number;
  healthy_throughput_eps: number;
  leak_memory_bytes: number;
}

interface LeakMetrics {
  memory_bytes: number;
  per_session_memory_bytes: number | null;
  latency_p50_ms: number;
  latency_p99_ms: number;
  throughput_events_per_sec: number;
  event_loop_lag_p99_ms: number | null;
  scheduler_util_avg: number | null;
  correctness_pct: number;
  startup_ms: number;
  memory_growth_bytes: number;
  memory_growth_pct: number;
  leak_deltas_received: number;
}

interface BenchmarkStep {
  benchmark: string;
  runtime: "node" | "elixir";
  step: number;
  stepLabel: string;
  metrics: LeakMetrics;
  timeSeries: TimeSeriesPoint[];
}

// ---------------------------------------------------------------------------
// Node child process helpers
// ---------------------------------------------------------------------------

interface NodeSession {
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  pending: Map<number, any>;
  nextId: number;
  codexThreadId: string | null;
}

function spawnMockSession(
  deltaCount: number,
  deltaSizeKb: number,
  delayMs: number,
  mode: "normal" | "leak",
): NodeSession {
  const child = spawn(
    "bun",
    [
      "run",
      "scripts/mock-codex-server.ts",
      String(deltaCount),
      String(deltaSizeKb),
      String(delayMs),
      mode,
    ],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );

  const rl = readline.createInterface({ input: child.stdout });
  child.stderr?.resume();

  return { child, rl, pending: new Map(), nextId: 1, codexThreadId: null };
}

function rpc(session: NodeSession, method: string, params: any, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
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
    session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function initSession(session: NodeSession): Promise<void> {
  await rpc(session, "initialize", {
    clientInfo: { name: "stress", version: "1.0" },
    capabilities: {},
  });
  session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const threadResult = await rpc(session, "thread/start", { cwd: process.cwd() });
  session.codexThreadId = threadResult?.thread?.id ?? null;
}

function sendTurn(session: NodeSession, text: string): void {
  const id = session.nextId++;
  const timer = setTimeout(() => {
    session.pending.delete(id);
  }, 120000);
  session.pending.set(id, {
    resolve: () => {
      clearTimeout(timer);
    },
    reject: () => {
      clearTimeout(timer);
    },
  });
  session.child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "turn/start",
      params: { threadId: session.codexThreadId, input: [{ type: "text", text }] },
    }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Node runtime — 1 leak + M healthy child processes
// ---------------------------------------------------------------------------

async function runNodeStep(
  M: number,
): Promise<{ metrics: LeakMetrics; timeSeries: TimeSeriesPoint[] }> {
  // --- Event loop lag tracking ---
  const lags: number[] = [];
  let windowLags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    if (lag > 5) {
      lags.push(lag);
      windowLags.push(lag);
    }
    lastLagCheck = now;
  }, 100);

  // --- Leak session ---
  let leakDeltaCount = 0;
  const leakSession = spawnMockSession(LEAK_DELTA_COUNT, LEAK_DELTA_SIZE_KB, LEAK_DELAY_MS, "leak");

  leakSession.rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const p = leakSession.pending.get(msg.id);
        if (p) {
          leakSession.pending.delete(msg.id);
          p.resolve(msg.result ?? msg.error);
        }
        return;
      }
      if (msg.method === "item/agentMessage/delta") leakDeltaCount++;
    } catch {}
  });

  // --- Healthy sessions ---
  interface HealthyState {
    session: NodeSession;
    deltaCount: number;
    turnInProgress: boolean;
    turnStartedAt: number;
    turnLatencies: number[];
    errors: string[];
  }

  const healthySessions: HealthyState[] = [];
  const allTurnLatencies: number[] = [];
  let windowDeltaCount = 0;

  const startPhaseStart = Date.now();

  // Init leak session
  try {
    await initSession(leakSession);
  } catch (e) {
    log(`Leak session init failed: ${e}`);
  }

  // Init healthy sessions
  for (let i = 0; i < M; i++) {
    const session = spawnMockSession(
      HEALTHY_DELTA_COUNT,
      HEALTHY_DELTA_SIZE_KB,
      HEALTHY_DELAY_MS,
      "normal",
    );
    const state: HealthyState = {
      session,
      deltaCount: 0,
      turnInProgress: false,
      turnStartedAt: 0,
      turnLatencies: [],
      errors: [],
    };

    session.rl.on("line", (line: string) => {
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
          state.deltaCount++;
          windowDeltaCount++;
        }
        if (msg.method === "turn/completed") {
          if (state.turnInProgress) {
            const latency = Date.now() - state.turnStartedAt;
            state.turnLatencies.push(latency);
            allTurnLatencies.push(latency);
            state.turnInProgress = false;
          }
        }
      } catch {}
    });

    try {
      await initSession(session);
    } catch (e) {
      state.errors.push(e instanceof Error ? e.message : String(e));
    }

    healthySessions.push(state);
    if ((i + 1) % 5 === 0) log(`  ${i + 1}/${M} healthy sessions started`);
  }

  const startupMs = Date.now() - startPhaseStart;
  log(`All sessions started in ${(startupMs / 1000).toFixed(1)}s (1 leak + ${M} healthy)`);

  // --- Baseline memory ---
  const baselineMemory = process.memoryUsage().heapUsed;
  log(`Baseline heap: ${(baselineMemory / 1024 / 1024).toFixed(1)}MB`);

  // --- Start leak session turn (streams forever) ---
  sendTurn(leakSession, "leak session - never ending stream");
  log("Leak session turn started (streaming indefinitely)");

  // --- Send initial turns to healthy sessions ---
  for (const hs of healthySessions) {
    if (hs.errors.length > 0) continue;
    hs.turnInProgress = true;
    hs.turnStartedAt = Date.now();
    sendTurn(hs.session, "healthy session turn");
  }
  log(`Initial turns sent to ${M} healthy sessions`);

  // --- Healthy turn cycling timer ---
  const turnCycleTimer = setInterval(() => {
    for (const hs of healthySessions) {
      if (hs.errors.length > 0 || hs.turnInProgress) continue;
      hs.turnInProgress = true;
      hs.turnStartedAt = Date.now();
      sendTurn(hs.session, "healthy session turn");
    }
  }, HEALTHY_TURN_INTERVAL_MS);

  // --- Main sampling loop ---
  const timeSeries: TimeSeriesPoint[] = [];
  const runStart = Date.now();
  let lastSampleTime = runStart;

  while (Date.now() - runStart < DURATION_MS) {
    await sleep(SAMPLE_INTERVAL_MS);

    const now = Date.now();
    const elapsed = now - runStart;
    const mem = process.memoryUsage();

    // Healthy turn latencies from recent window
    const recentLatencies = allTurnLatencies.slice(-20);
    const avgLatency =
      recentLatencies.length > 0
        ? recentLatencies.reduce((s, v) => s + v, 0) / recentLatencies.length
        : 0;

    // Event loop lag for this window
    const windowLagP99 = windowLags.length > 0 ? percentile(windowLags, 99) : 0;
    windowLags = [];

    // Throughput for this window
    const windowDur = (now - lastSampleTime) / 1000;
    const throughputEps = windowDur > 0 ? windowDeltaCount / windowDur : 0;
    windowDeltaCount = 0;
    lastSampleTime = now;

    timeSeries.push({
      elapsed_ms: elapsed,
      memory_bytes: mem.heapUsed,
      healthy_turn_latency_ms: Math.round(avgLatency),
      event_loop_lag_ms: Math.round(windowLagP99 * 10) / 10,
      healthy_throughput_eps: Math.round(throughputEps),
      leak_memory_bytes: 0, // Node: not tracked per-session
    });

    const totalHealthyTurns = healthySessions.reduce((s, hs) => s + hs.turnLatencies.length, 0);
    process.stdout.write(
      `\r  ${ts()} elapsed=${(elapsed / 1000).toFixed(0)}s mem=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
        `leakDeltas=${leakDeltaCount} healthyTurns=${totalHealthyTurns} lag=${windowLagP99.toFixed(1)}ms`,
    );
  }

  console.log("");
  clearInterval(turnCycleTimer);
  clearInterval(lagTimer);

  // --- Final metrics ---
  const finalMemory = process.memoryUsage().heapUsed;
  const memoryGrowth = finalMemory - baselineMemory;
  const memoryGrowthPct = baselineMemory > 0 ? (memoryGrowth / baselineMemory) * 100 : 0;

  const totalHealthyDeltas = healthySessions.reduce((s, hs) => s + hs.deltaCount, 0);
  const totalTurns = healthySessions.reduce((s, hs) => s + hs.turnLatencies.length, 0);
  const correctness = totalTurns > 0 ? 100 : 0; // turns that completed are correct

  let overallThroughput = 0;
  if (totalHealthyDeltas > 0) {
    overallThroughput = totalHealthyDeltas / (DURATION_MS / 1000);
  }

  // --- Kill all ---
  try {
    leakSession.child.kill("SIGKILL");
  } catch {}
  for (const hs of healthySessions) {
    try {
      hs.session.child.kill();
    } catch {}
  }

  log(`Killed leak session and ${M} healthy sessions`);

  return {
    metrics: {
      memory_bytes: finalMemory,
      per_session_memory_bytes: null,
      latency_p50_ms: percentile(allTurnLatencies, 50),
      latency_p99_ms: percentile(allTurnLatencies, 99),
      throughput_events_per_sec: Math.round(overallThroughput),
      event_loop_lag_p99_ms: lags.length > 0 ? Math.round(percentile(lags, 99) * 10) / 10 : null,
      scheduler_util_avg: null,
      correctness_pct: Math.round(correctness * 10) / 10,
      startup_ms: startupMs,
      memory_growth_bytes: memoryGrowth,
      memory_growth_pct: Math.round(memoryGrowthPct * 10) / 10,
      leak_deltas_received: leakDeltaCount,
    },
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Elixir runtime — 1 leak + M healthy GenServer processes
// ---------------------------------------------------------------------------

async function runElixirStep(
  M: number,
): Promise<{ metrics: LeakMetrics; timeSeries: TimeSeriesPoint[] }> {
  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;

  // --- Session state tracking ---
  let leakDeltaCount = 0;
  const leakThreadId = `leak-elixir-${M}-${Date.now()}`;

  interface HealthyElixirState {
    threadId: string;
    deltaCount: number;
    turnInProgress: boolean;
    turnStartedAt: number;
    turnLatencies: number[];
    errors: string[];
  }

  const healthyStates: HealthyElixirState[] = [];
  const allTurnLatencies: number[] = [];
  let windowDeltaCount = 0;

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const tid = raw.threadId;

      // Leak session events
      if (tid === leakThreadId) {
        if (raw.method === "item/agentMessage/delta") leakDeltaCount++;
        return;
      }

      // Healthy session events
      const hs = healthyStates.find((s) => s.threadId === tid);
      if (!hs) return;
      if (raw.method === "item/agentMessage/delta") {
        hs.deltaCount++;
        windowDeltaCount++;
      }
      if (raw.method === "turn/completed") {
        if (hs.turnInProgress) {
          const latency = Date.now() - hs.turnStartedAt;
          hs.turnLatencies.push(latency);
          allTurnLatencies.push(latency);
          hs.turnInProgress = false;
        }
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected to harness");

  const baseline = (await fetch(METRICS_URL).then((r: Response) => r.json())) as any;
  const baselineMemory = baseline.beam?.total_memory ?? 0;
  log(
    `Baseline: ${baseline.beam.process_count} processes, ${(baselineMemory / 1024 / 1024).toFixed(1)}MB`,
  );

  const startPhaseStart = Date.now();

  // --- Start leak session ---
  try {
    await mgr.startSession({
      threadId: leakThreadId,
      provider: "mock",
      cwd: process.cwd(),
      providerOptions: {
        mock: {
          deltaCount: LEAK_DELTA_COUNT,
          deltaSizeKb: LEAK_DELTA_SIZE_KB,
          delayMs: LEAK_DELAY_MS,
        },
      },
    });
  } catch (e) {
    log(`Leak session start failed: ${e}`);
  }
  log("Leak session started");

  // --- Start healthy sessions ---
  for (let i = 0; i < M; i++) {
    const threadId = `healthy-elixir-${M}-${i}-${Date.now()}`;
    const state: HealthyElixirState = {
      threadId,
      deltaCount: 0,
      turnInProgress: false,
      turnStartedAt: 0,
      turnLatencies: [],
      errors: [],
    };

    try {
      await mgr.startSession({
        threadId,
        provider: "mock",
        cwd: process.cwd(),
        providerOptions: {
          mock: {
            deltaCount: HEALTHY_DELTA_COUNT,
            deltaSizeKb: HEALTHY_DELTA_SIZE_KB,
            delayMs: HEALTHY_DELAY_MS,
          },
        },
      });
    } catch (e) {
      state.errors.push(e instanceof Error ? e.message : String(e));
    }

    healthyStates.push(state);
    if ((i + 1) % 5 === 0) log(`  ${i + 1}/${M} healthy sessions started`);
  }

  const startupMs = Date.now() - startPhaseStart;
  log(`All sessions started in ${(startupMs / 1000).toFixed(1)}s (1 leak + ${M} healthy)`);

  // --- Start leak turn (streams forever) ---
  await mgr
    .sendTurn(leakThreadId, {
      input: [{ type: "text", text: "leak session - never ending stream" }],
    })
    .catch(() => {});
  log("Leak session turn started (streaming indefinitely)");

  // --- Send initial turns to healthy sessions ---
  for (const hs of healthyStates) {
    if (hs.errors.length > 0) continue;
    hs.turnInProgress = true;
    hs.turnStartedAt = Date.now();
    mgr
      .sendTurn(hs.threadId, { input: [{ type: "text", text: "healthy session turn" }] })
      .catch(() => {});
  }
  log(`Initial turns sent to ${M} healthy sessions`);

  // --- Healthy turn cycling timer ---
  const turnCycleTimer = setInterval(() => {
    for (const hs of healthyStates) {
      if (hs.errors.length > 0 || hs.turnInProgress) continue;
      hs.turnInProgress = true;
      hs.turnStartedAt = Date.now();
      mgr
        .sendTurn(hs.threadId, { input: [{ type: "text", text: "healthy session turn" }] })
        .catch(() => {});
    }
  }, HEALTHY_TURN_INTERVAL_MS);

  // --- Main sampling loop ---
  const timeSeries: TimeSeriesPoint[] = [];
  const runStart = Date.now();
  let lastSampleTime = runStart;

  while (Date.now() - runStart < DURATION_MS) {
    await sleep(SAMPLE_INTERVAL_MS);

    const now = Date.now();
    const elapsed = now - runStart;

    // Fetch Elixir metrics
    let totalMemory = 0;
    let leakProcessMemory = 0;
    let schedulerUtil: number[] = [];

    try {
      const m = (await fetch(METRICS_URL).then((r: Response) => r.json())) as any;
      totalMemory = m.beam?.total_memory ?? 0;
      schedulerUtil = m.beam?.scheduler_utilization ?? [];

      // Find leak session memory
      const sessions = m.sessions ?? [];
      const leakSess = sessions.find((s: any) => String(s.thread_id ?? "").includes("leak"));
      if (leakSess) leakProcessMemory = leakSess.memory ?? 0;
    } catch {}

    // Healthy turn latencies from recent window
    const recentLatencies = allTurnLatencies.slice(-20);
    const avgLatency =
      recentLatencies.length > 0
        ? recentLatencies.reduce((s, v) => s + v, 0) / recentLatencies.length
        : 0;

    // Throughput for this window
    const windowDur = (now - lastSampleTime) / 1000;
    const throughputEps = windowDur > 0 ? windowDeltaCount / windowDur : 0;
    windowDeltaCount = 0;
    lastSampleTime = now;

    timeSeries.push({
      elapsed_ms: elapsed,
      memory_bytes: totalMemory,
      healthy_turn_latency_ms: Math.round(avgLatency),
      event_loop_lag_ms: 0, // Elixir: no event loop lag
      healthy_throughput_eps: Math.round(throughputEps),
      leak_memory_bytes: leakProcessMemory,
    });

    const totalHealthyTurns = healthyStates.reduce((s, hs) => s + hs.turnLatencies.length, 0);
    process.stdout.write(
      `\r  ${ts()} elapsed=${(elapsed / 1000).toFixed(0)}s mem=${(totalMemory / 1024 / 1024).toFixed(1)}MB ` +
        `leakDeltas=${leakDeltaCount} healthyTurns=${totalHealthyTurns} leakMem=${(leakProcessMemory / 1024).toFixed(0)}KB`,
    );
  }

  console.log("");
  clearInterval(turnCycleTimer);

  // --- Final metrics ---
  const finalMetrics = (await fetch(METRICS_URL).then((r: Response) => r.json())) as any;
  const finalMemory = finalMetrics.beam?.total_memory ?? 0;
  const memoryGrowth = finalMemory - baselineMemory;
  const memoryGrowthPct = baselineMemory > 0 ? (memoryGrowth / baselineMemory) * 100 : 0;

  const totalHealthyDeltas = healthyStates.reduce((s, hs) => s + hs.deltaCount, 0);
  const totalTurns = healthyStates.reduce((s, hs) => s + hs.turnLatencies.length, 0);
  const correctness = totalTurns > 0 ? 100 : 0;

  let overallThroughput = 0;
  if (totalHealthyDeltas > 0) {
    overallThroughput = totalHealthyDeltas / (DURATION_MS / 1000);
  }

  // Per-session memory (healthy only)
  const sessionData = (finalMetrics.sessions ?? []).filter((s: any) =>
    String(s.thread_id ?? "").includes("healthy-elixir"),
  );
  const perSessionMemory =
    sessionData.length > 0
      ? sessionData.reduce((s: number, m: any) => s + (m.memory ?? 0), 0) / sessionData.length
      : null;

  let schedulerUtilAvg: number | null = null;
  if (finalMetrics?.beam?.scheduler_utilization) {
    const sched = finalMetrics.beam.scheduler_utilization;
    if (Array.isArray(sched) && sched.length > 0) {
      schedulerUtilAvg =
        Math.round((sched.reduce((s: number, u: number) => s + u, 0) / sched.length) * 1000) / 1000;
    }
  }

  // --- Cleanup ---
  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();
  log(`Stopped all sessions and disconnected`);

  return {
    metrics: {
      memory_bytes: finalMemory,
      per_session_memory_bytes: perSessionMemory,
      latency_p50_ms: percentile(allTurnLatencies, 50),
      latency_p99_ms: percentile(allTurnLatencies, 99),
      throughput_events_per_sec: Math.round(overallThroughput),
      event_loop_lag_p99_ms: null,
      scheduler_util_avg: schedulerUtilAvg,
      correctness_pct: Math.round(correctness * 10) / 10,
      startup_ms: startupMs,
      memory_growth_bytes: memoryGrowth,
      memory_growth_pct: Math.round(memoryGrowthPct * 10) / 10,
      leak_deltas_received: leakDeltaCount,
    },
    timeSeries,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  Benchmark 5: Sustained Leak Over Time — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  Steps: [${HEALTHY_STEPS.join(", ")}] healthy sessions`.padEnd(58) + "║");
  console.log("║" + `  Duration: ${(DURATION_MS / 1000).toFixed(0)}s per variant`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const results: BenchmarkStep[] = [];

  for (const M of HEALTHY_STEPS) {
    console.log("\n" + "─".repeat(60));
    console.log(`  Step: ${M} healthy + 1 leak`);
    console.log("─".repeat(60));

    for (let run = 1; run <= RUNS_PER_STEP; run++) {
      log(`Run ${run}/${RUNS_PER_STEP} with M=${M}...`);

      let result: { metrics: LeakMetrics; timeSeries: TimeSeriesPoint[] };
      if (RUNTIME === "elixir") {
        result = await runElixirStep(M);
      } else {
        result = await runNodeStep(M);
      }

      const m = result.metrics;
      log(
        `  Done: latency_p50=${m.latency_p50_ms}ms p99=${m.latency_p99_ms}ms leakDeltas=${m.leak_deltas_received}`,
      );
      log(
        `  Memory: ${(m.memory_bytes / 1024 / 1024).toFixed(1)}MB growth=${(m.memory_growth_bytes / 1024 / 1024).toFixed(1)}MB (${m.memory_growth_pct}%)`,
      );
      if (m.event_loop_lag_p99_ms !== null)
        log(`  Event loop lag p99: ${m.event_loop_lag_p99_ms}ms`);
      if (m.scheduler_util_avg !== null)
        log(`  Scheduler util avg: ${(m.scheduler_util_avg * 100).toFixed(1)}%`);

      const step: BenchmarkStep = {
        benchmark: "sustained-leak",
        runtime: RUNTIME as "node" | "elixir",
        step: M,
        stepLabel: `${M} healthy + 1 leak`,
        metrics: m,
        timeSeries: result.timeSeries,
      };

      results.push(step);
    }

    // Cooldown between steps
    if (M !== HEALTHY_STEPS[HEALTHY_STEPS.length - 1]) {
      log(`Cooling down ${COOLDOWN_MS / 1000}s before next step...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // --- Write output ---
  const filename = `benchmark-sustained-leak-${RUNTIME}-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(results, null, 2));

  // --- Final summary table ---
  console.log("\n\n" + "═".repeat(70));
  console.log("  SUSTAINED LEAK BENCHMARK — FINAL RESULTS");
  console.log("═".repeat(70));
  console.log(
    `  ${"Step".padEnd(20)} ${"P50ms".padStart(8)} ${"P99ms".padStart(8)} ${"Growth%".padStart(8)} ` +
      `${"GrowMB".padStart(8)} ${"LeakDlt".padStart(8)} ${"Tput".padStart(8)}`,
  );
  console.log("  " + "─".repeat(66));

  for (const step of results) {
    const m = step.metrics;
    console.log(
      `  ${step.stepLabel.padEnd(20)} ${String(m.latency_p50_ms).padStart(8)} ${String(m.latency_p99_ms).padStart(8)} ` +
        `${String(m.memory_growth_pct).padStart(8)} ${(m.memory_growth_bytes / 1024 / 1024).toFixed(1).padStart(8)} ` +
        `${String(m.leak_deltas_received).padStart(8)} ${String(m.throughput_events_per_sec).padStart(8)}`,
    );
  }

  console.log("═".repeat(70));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);

  // --- Time series insight ---
  console.log("\n  Time Series Summary (first vs last sample per step):");
  for (const step of results) {
    if (step.timeSeries.length < 2) continue;
    const first = step.timeSeries[0]!;
    const last = step.timeSeries[step.timeSeries.length - 1]!;
    console.log(
      `  ${step.stepLabel}: mem ${(first.memory_bytes / 1024 / 1024).toFixed(1)}MB -> ${(last.memory_bytes / 1024 / 1024).toFixed(1)}MB, ` +
        `latency ${first.healthy_turn_latency_ms}ms -> ${last.healthy_turn_latency_ms}ms`,
    );
  }

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
