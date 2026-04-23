#!/usr/bin/env tsx
/**
 * 5-minute sustained stress test for mcp-obsidian-extended.
 * Hammers the Obsidian REST API with continuous mixed workloads for 5 minutes,
 * tracking throughput, latency percentiles, error rates, and memory usage.
 * All output goes to stderr. Exit 0 = pass, Exit 1 = fail.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { ObsidianClient } from "../src/obsidian.js";
import { VaultCache } from "../src/cache.js";

// --- Config ---

const DURATION_MS = 5 * 60 * 1000; // 5 minutes
const REPORT_INTERVAL_MS = 30_000; // Print stats every 30s
const STRESS_PREFIX = "_stress5m_";
const VAULT_FILE_LIMIT = 50;
const CONCURRENCY = 8; // Parallel workers
const FILE_POOL_SIZE = 30; // Rotating file pool

// --- Helpers ---

/** Writes a message to stderr. */
function write(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Loads .env from cwd if present. */
function loadDotenv(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      let key = trimmed.slice(0, eqIndex).trim();
      if (key.startsWith("export ")) key = key.slice(7).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key.length > 0 && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    /* no .env is fine */
  }
}

// --- Latency Tracker ---

interface LatencyBucket {
  count: number;
  errors: number;
  latencies: number[];
}

/** Tracks per-operation latency and error counts. */
class Stats {
  private readonly buckets = new Map<string, LatencyBucket>();
  private readonly startTime = Date.now();
  private lastReportOps = 0;
  private lastReportTime = Date.now();

  /** Records a completed operation. */
  record(op: string, latencyMs: number, isError: boolean): void {
    let bucket = this.buckets.get(op);
    if (!bucket) {
      bucket = { count: 0, errors: 0, latencies: [] };
      this.buckets.set(op, bucket);
    }
    bucket.count++;
    bucket.latencies.push(latencyMs);
    if (isError) bucket.errors++;
  }

  /** Returns total operations across all buckets. */
  get totalOps(): number {
    let total = 0;
    for (const b of this.buckets.values()) total += b.count;
    return total;
  }

  /** Returns total errors across all buckets. */
  get totalErrors(): number {
    let total = 0;
    for (const b of this.buckets.values()) total += b.errors;
    return total;
  }

  /** Returns elapsed time since start in seconds. */
  get elapsedSec(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /** Computes a percentile from a sorted array. */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)] ?? 0;
  }

  /** Prints a periodic progress report. */
  printProgress(): void {
    const now = Date.now();
    const intervalOps = this.totalOps - this.lastReportOps;
    const intervalSec = (now - this.lastReportTime) / 1000;
    const opsPerSec =
      intervalSec > 0 ? (intervalOps / intervalSec).toFixed(1) : "0";
    const elapsed = ((now - this.startTime) / 1000).toFixed(0);
    const remaining = Math.max(
      0,
      (DURATION_MS - (now - this.startTime)) / 1000,
    ).toFixed(0);
    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

    write(
      `  [${elapsed}s] ${String(this.totalOps)} ops (${opsPerSec}/s), ${String(this.totalErrors)} errors, heap: ${memMb}MB, ${remaining}s remaining`,
    );

    this.lastReportOps = this.totalOps;
    this.lastReportTime = now;
  }

  /** Prints the final summary with per-operation percentiles. */
  printFinal(): void {
    write("");
    write("=== Final Results ===");
    write("");

    const totalSec = this.elapsedSec;
    const opsPerSec = (this.totalOps / totalSec).toFixed(1);
    const errorRate =
      this.totalOps > 0
        ? ((this.totalErrors / this.totalOps) * 100).toFixed(2)
        : "0";
    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

    write(`  Duration:    ${totalSec.toFixed(1)}s`);
    write(`  Total ops:   ${String(this.totalOps)}`);
    write(`  Throughput:  ${opsPerSec} ops/s`);
    write(`  Errors:      ${String(this.totalErrors)} (${errorRate}%)`);
    write(`  Heap:        ${memMb}MB`);
    write("");

    // Per-operation breakdown
    write(
      "  Operation              Count    Errors   p50      p95      p99      max",
    );
    write("  " + "─".repeat(80));

    const sortedOps = [...this.buckets.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );
    for (const [op, bucket] of sortedOps) {
      const sorted = bucket.latencies.slice().sort((a, b) => a - b);
      const p50 = this.percentile(sorted, 50).toFixed(0);
      const p95 = this.percentile(sorted, 95).toFixed(0);
      const p99 = this.percentile(sorted, 99).toFixed(0);
      const max = (sorted[sorted.length - 1] ?? 0).toFixed(0);
      const name = op.padEnd(20);
      const count = String(bucket.count).padStart(6);
      const errors = String(bucket.errors).padStart(6);
      write(
        `  ${name} ${count}    ${errors}   ${p50.padStart(4)}ms   ${p95.padStart(4)}ms   ${p99.padStart(4)}ms   ${max.padStart(4)}ms`,
      );
    }
    write("");
  }
}

// --- Operations ---

type OpFn = (
  client: ObsidianClient,
  stats: Stats,
  filePool: string[],
) => Promise<void>;

/** Picks a random element from an array. */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** PUT a file with random content. */
const opPut: OpFn = async (client, stats, filePool) => {
  const file = pick(filePool);
  const content = `# Stress ${file}\n\nTimestamp: ${Date.now()}\n\n${"Data block. ".repeat(20)}\n`;
  const start = Date.now();
  try {
    await client.putContent(file, content);
    stats.record("put", Date.now() - start, false);
  } catch {
    stats.record("put", Date.now() - start, true);
  }
};

/** GET a file. */
const opGet: OpFn = async (client, stats, filePool) => {
  const file = pick(filePool);
  const start = Date.now();
  try {
    await client.getFileContents(file, "markdown");
    stats.record("get", Date.now() - start, false);
  } catch {
    stats.record("get", Date.now() - start, true);
  }
};

/** GET a file as JSON (NoteJson). */
const opGetJson: OpFn = async (client, stats, filePool) => {
  const file = pick(filePool);
  const start = Date.now();
  try {
    await client.getFileContents(file, "json");
    stats.record("get_json", Date.now() - start, false);
  } catch {
    stats.record("get_json", Date.now() - start, true);
  }
};

/** Append to a file. */
const opAppend: OpFn = async (client, stats, filePool) => {
  const file = pick(filePool);
  const start = Date.now();
  try {
    await client.appendContent(file, `\nAppended at ${Date.now()}\n`);
    stats.record("append", Date.now() - start, false);
  } catch {
    stats.record("append", Date.now() - start, true);
  }
};

/** DELETE then re-PUT a file. */
const opDeletePut: OpFn = async (client, stats, filePool) => {
  const file = pick(filePool);
  const start = Date.now();
  try {
    await client.deleteFile(file);
    await client.putContent(file, `# Recreated\n\nAt ${Date.now()}\n`);
    stats.record("delete_put", Date.now() - start, false);
  } catch {
    stats.record("delete_put", Date.now() - start, true);
  }
};

/** Simple search. */
const opSearch: OpFn = async (client, stats) => {
  const queries = [
    "stress",
    "test",
    "timestamp",
    "data",
    "block",
    "recreated",
    "appended",
  ];
  const start = Date.now();
  try {
    await client.simpleSearch(pick(queries));
    stats.record("search", Date.now() - start, false);
  } catch {
    stats.record("search", Date.now() - start, true);
  }
};

/** List vault files. */
const opList: OpFn = async (client, stats) => {
  const start = Date.now();
  try {
    await client.listFilesInVault();
    stats.record("list", Date.now() - start, false);
  } catch {
    stats.record("list", Date.now() - start, true);
  }
};

/** Server status (no auth, lightweight). */
const opStatus: OpFn = async (client, stats) => {
  const start = Date.now();
  try {
    await client.getServerStatus();
    stats.record("status", Date.now() - start, false);
  } catch {
    stats.record("status", Date.now() - start, true);
  }
};

/** Search-replace in a file. */
const opSearchReplace: OpFn = async (client, stats, filePool) => {
  const file = pick(filePool);
  const start = Date.now();
  try {
    // First ensure file exists
    await client.putContent(
      file,
      `# SR Test\n\nReplace target: OLD_VALUE_${Date.now()}\n`,
    );
    // Read content, do manual search-replace via put
    const content = await client.getFileContents(file, "markdown");
    if (typeof content === "string") {
      const updated = content.replace(
        /OLD_VALUE_\d+/,
        `NEW_VALUE_${Date.now()}`,
      );
      await client.putContent(file, updated);
    }
    stats.record("search_replace", Date.now() - start, false);
  } catch {
    stats.record("search_replace", Date.now() - start, true);
  }
};

/** Cache rebuild. */
const opCacheRebuild: OpFn = async (client, stats) => {
  const cache = new VaultCache(client, 60_000);
  client.setCache(cache);
  const start = Date.now();
  try {
    await cache.initialize();
    cache.stopAutoRefresh();
    stats.record("cache_rebuild", Date.now() - start, false);
  } catch {
    cache.stopAutoRefresh();
    stats.record("cache_rebuild", Date.now() - start, true);
  }
};

// Weighted operation distribution — reads dominate (realistic workload)
const OPS: Array<{ weight: number; fn: OpFn }> = [
  { weight: 25, fn: opGet }, // 25% reads
  { weight: 10, fn: opGetJson }, // 10% JSON reads
  { weight: 15, fn: opPut }, // 15% writes
  { weight: 10, fn: opAppend }, // 10% appends
  { weight: 5, fn: opDeletePut }, // 5%  delete+recreate
  { weight: 10, fn: opSearch }, // 10% searches
  { weight: 10, fn: opList }, // 10% listings
  { weight: 5, fn: opStatus }, // 5%  status checks
  { weight: 5, fn: opSearchReplace }, // 5% search-replace
  { weight: 5, fn: opCacheRebuild }, // 5% cache rebuilds
];

/** Picks a random operation based on weights. */
function pickOp(): OpFn {
  const totalWeight = OPS.reduce((sum, o) => sum + o.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const op of OPS) {
    rand -= op.weight;
    if (rand <= 0) return op.fn;
  }
  return OPS[0]!.fn;
}

// --- Worker ---

/** Runs operations continuously until deadline. */
async function worker(
  id: number,
  client: ObsidianClient,
  stats: Stats,
  filePool: string[],
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const op = pickOp();
    await op(client, stats, filePool);
  }
}

// --- Cleanup ---

/** Removes all stress test files from the vault. */
async function cleanup(client: ObsidianClient): Promise<void> {
  const { files } = await client.listFilesInVault();
  const stressFiles = files.filter((f) => f.includes(STRESS_PREFIX));
  await Promise.all(
    stressFiles.map((f) => client.deleteFile(f).catch(() => {})),
  );
  if (stressFiles.length > 0) {
    write(`  Cleaned up ${String(stressFiles.length)} stress test files`);
  }
}

// --- Main ---

async function main(): Promise<void> {
  write("");
  write("=== mcp-obsidian-extended 5-minute stress test ===");
  write("");
  write(`  Duration:    ${String(DURATION_MS / 1000)}s`);
  write(`  Concurrency: ${String(CONCURRENCY)} workers`);
  write(`  File pool:   ${String(FILE_POOL_SIZE)} files`);
  write(`  Reports:     every ${String(REPORT_INTERVAL_MS / 1000)}s`);
  write("");

  loadDotenv();
  const config = loadConfig();

  if (!config.apiKey) {
    write("[error] OBSIDIAN_API_KEY is not set.");
    process.exit(1);
  }

  const client = new ObsidianClient(config);

  // Safety guard
  const { files } = await client.listFilesInVault();
  if (files.length > VAULT_FILE_LIMIT) {
    write(
      `[error] Vault has ${String(files.length)} files — use a test vault.`,
    );
    process.exit(1);
  }

  // Seed file pool
  const filePool = Array.from(
    { length: FILE_POOL_SIZE },
    (_, i) => `${STRESS_PREFIX}${String(i).padStart(3, "0")}.md`,
  );
  write("  Seeding file pool...");
  await Promise.all(
    filePool.map((f, i) =>
      client.putContent(
        f,
        `# Stress File ${String(i)}\n\nSeed content for stress testing.\n\n[[${filePool[(i + 1) % FILE_POOL_SIZE]!}]]\n`,
      ),
    ),
  );
  write(`  ${String(filePool.length)} files created`);
  write("");

  const stats = new Stats();
  const deadline = Date.now() + DURATION_MS;

  // Progress reporter
  const reportTimer = setInterval(() => {
    stats.printProgress();
  }, REPORT_INTERVAL_MS);

  write("  Starting workers...");
  write("");

  try {
    // Launch concurrent workers
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        worker(i, client, stats, filePool, deadline),
      ),
    );
  } finally {
    clearInterval(reportTimer);
  }

  // Final report
  stats.printProgress();
  stats.printFinal();

  // Cleanup
  write("  Cleaning up...");
  await cleanup(client);

  // Pass/fail criteria
  const errorRate =
    stats.totalOps > 0 ? (stats.totalErrors / stats.totalOps) * 100 : 0;
  const opsPerSec = stats.totalOps / stats.elapsedSec;

  write("  Pass criteria:");
  write(
    `    Error rate < 5%:     ${errorRate < 5 ? "PASS" : "FAIL"} (${errorRate.toFixed(2)}%)`,
  );
  write(
    `    Throughput > 10/s:   ${opsPerSec > 10 ? "PASS" : "FAIL"} (${opsPerSec.toFixed(1)}/s)`,
  );
  write(`    No crashes:          PASS`);
  write("");

  process.exit(errorRate < 5 && opsPerSec > 10 ? 0 : 1);
}

main().catch((err: unknown) => {
  write(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
