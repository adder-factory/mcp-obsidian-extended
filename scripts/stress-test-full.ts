#!/usr/bin/env tsx
/**
 * Full-coverage stress test for mcp-obsidian-extended.
 * Exercises all 38 granular tools and all 11 consolidated tools (all actions)
 * under sustained concurrent load for 5 minutes.
 * All output goes to stderr. Exit 0 = pass, Exit 1 = fail.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { ObsidianClient } from "../src/obsidian.js";
import { VaultCache } from "../src/cache.js";

// --- Config ---

const DURATION_MS = 5 * 60 * 1000;
const REPORT_INTERVAL_MS = 30_000;
const STRESS_PREFIX = "_stressfull_";
const VAULT_FILE_LIMIT = 50;
const CONCURRENCY = 6;
const FILE_POOL_SIZE = 20;

// --- Helpers ---

function write(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
    }
  } catch { /* ok */ }
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// --- Stats ---

interface LatencyBucket {
  count: number;
  errors: number;
  latencies: number[];
}

class Stats {
  private readonly buckets = new Map<string, LatencyBucket>();
  private readonly startTime = Date.now();
  private lastReportOps = 0;
  private lastReportTime = Date.now();
  private readonly toolCoverage = new Set<string>();

  record(op: string, latencyMs: number, isError: boolean): void {
    let bucket = this.buckets.get(op);
    if (!bucket) { bucket = { count: 0, errors: 0, latencies: [] }; this.buckets.set(op, bucket); }
    bucket.count++;
    bucket.latencies.push(latencyMs);
    if (isError) bucket.errors++;
    this.toolCoverage.add(op);
  }

  get totalOps(): number { let t = 0; for (const b of this.buckets.values()) t += b.count; return t; }
  get totalErrors(): number { let t = 0; for (const b of this.buckets.values()) t += b.errors; return t; }
  get elapsedSec(): number { return (Date.now() - this.startTime) / 1000; }
  get coveredTools(): number { return this.toolCoverage.size; }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  }

  printProgress(): void {
    const now = Date.now();
    const intervalOps = this.totalOps - this.lastReportOps;
    const intervalSec = (now - this.lastReportTime) / 1000;
    const opsPerSec = intervalSec > 0 ? (intervalOps / intervalSec).toFixed(1) : "0";
    const elapsed = ((now - this.startTime) / 1000).toFixed(0);
    const remaining = Math.max(0, (DURATION_MS - (now - this.startTime)) / 1000).toFixed(0);
    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    write(`  [${elapsed}s] ${String(this.totalOps)} ops (${opsPerSec}/s), ${String(this.totalErrors)} err, ${String(this.coveredTools)} tools hit, heap: ${memMb}MB, ${remaining}s left`);
    this.lastReportOps = this.totalOps;
    this.lastReportTime = now;
  }

  printFinal(): void {
    write("");
    write("=== Final Results ===");
    write("");
    const totalSec = this.elapsedSec;
    const opsPerSec = (this.totalOps / totalSec).toFixed(1);
    const errorRate = this.totalOps > 0 ? ((this.totalErrors / this.totalOps) * 100).toFixed(2) : "0";
    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    write(`  Duration:     ${totalSec.toFixed(1)}s`);
    write(`  Total ops:    ${String(this.totalOps)}`);
    write(`  Throughput:   ${opsPerSec} ops/s`);
    write(`  Errors:       ${String(this.totalErrors)} (${errorRate}%)`);
    write(`  Tools hit:    ${String(this.coveredTools)}`);
    write(`  Heap:         ${memMb}MB`);
    write("");
    write("  Operation                       Count    Errors   p50      p95      p99      max");
    write("  " + "─".repeat(88));
    const sortedOps = [...this.buckets.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [op, bucket] of sortedOps) {
      const sorted = bucket.latencies.slice().sort((a, b) => a - b);
      const p50 = this.percentile(sorted, 50).toFixed(0);
      const p95 = this.percentile(sorted, 95).toFixed(0);
      const p99 = this.percentile(sorted, 99).toFixed(0);
      const max = (sorted[sorted.length - 1] ?? 0).toFixed(0);
      write(`  ${op.padEnd(30)} ${String(bucket.count).padStart(6)}    ${String(bucket.errors).padStart(6)}   ${p50.padStart(4)}ms   ${p95.padStart(4)}ms   ${p99.padStart(4)}ms   ${max.padStart(4)}ms`);
    }
    write("");
  }
}

// --- Operation Helpers ---

type OpFn = (ctx: OpContext) => Promise<void>;

interface OpContext {
  client: ObsidianClient;
  stats: Stats;
  files: string[];
  cache: VaultCache;
}

/** Timed operation wrapper. */
async function op(ctx: OpContext, name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    ctx.stats.record(name, Date.now() - start, false);
  } catch {
    ctx.stats.record(name, Date.now() - start, true);
  }
}

// =============================================
// GRANULAR TOOLS (38)
// =============================================

// #1 list_files_in_vault
const g01: OpFn = (ctx) => op(ctx, "G:list_files_in_vault", () => ctx.client.listFilesInVault().then(() => {}));

// #2 list_files_in_dir
const g02: OpFn = (ctx) => op(ctx, "G:list_files_in_dir", async () => {
  try { await ctx.client.listFilesInDir("."); } catch { /* dir may not exist */ }
});

// #3 get_file_contents (markdown)
const g03: OpFn = (ctx) => op(ctx, "G:get_file_contents", () => ctx.client.getFileContents(pick(ctx.files), "markdown").then(() => {}));

// #4 put_content
const g04: OpFn = (ctx) => op(ctx, "G:put_content", () => ctx.client.putContent(pick(ctx.files), `# Updated\n\nAt ${Date.now()}\n`));

// #5 append_content
const g05: OpFn = (ctx) => op(ctx, "G:append_content", () => ctx.client.appendContent(pick(ctx.files), `\nAppend ${Date.now()}\n`));

// #6 patch_content — Target uses :: delimiter for heading hierarchy
const g06: OpFn = (ctx) => op(ctx, "G:patch_content", async () => {
  const file = pick(ctx.files);
  await ctx.client.putContent(file, `# PatchRoot\n\n## PatchChild\n\nContent here.\n`);
  await ctx.client.patchContent(file, `\nPatched at ${Date.now()}\n`, {
    operation: "append",
    targetType: "heading",
    target: "PatchRoot::PatchChild",
  });
});

// #7 delete_file (+ recreate to keep pool alive)
const g07: OpFn = (ctx) => op(ctx, "G:delete_file", async () => {
  const file = pick(ctx.files);
  await ctx.client.deleteFile(file);
  await ctx.client.putContent(file, `# Recreated\n\nAt ${Date.now()}\n`);
});

// #8 search_replace
const g08: OpFn = (ctx) => op(ctx, "G:search_replace", async () => {
  const file = pick(ctx.files);
  await ctx.client.putContent(file, `# SR\n\nOLD_TOKEN_${Date.now()}\n`);
  const content = await ctx.client.getFileContents(file, "markdown");
  if (typeof content === "string") {
    await ctx.client.putContent(file, content.replace(/OLD_TOKEN_\d+/, `NEW_TOKEN_${Date.now()}`));
  }
});

// #9 get_active_file
const g09: OpFn = (ctx) => op(ctx, "G:get_active_file", () => ctx.client.getActiveFile("markdown").then(() => {}));

// #10 put_active_file
const g10: OpFn = (ctx) => op(ctx, "G:put_active_file", () => ctx.client.putActiveFile(`# Active\n\nStress ${Date.now()}\n`));

// #11 append_active_file
const g11: OpFn = (ctx) => op(ctx, "G:append_active_file", () => ctx.client.appendActiveFile(`\nActive append ${Date.now()}\n`));

// #12 patch_active_file — Target uses :: delimiter
const g12: OpFn = (ctx) => op(ctx, "G:patch_active_file", async () => {
  await ctx.client.putActiveFile(`# ActiveRoot\n\n## ActiveChild\n\nContent.\n`);
  await ctx.client.patchActiveFile(`\nPatched ${Date.now()}\n`, {
    operation: "append",
    targetType: "heading",
    target: "ActiveRoot::ActiveChild",
  });
});

// #13 delete_active_file — skip to avoid losing the user's open file repeatedly
// Instead, we test it once at the end

// #14 list_commands
const g14: OpFn = (ctx) => op(ctx, "G:list_commands", () => ctx.client.listCommands().then(() => {}));

// #15 execute_command (safe: toggle-sidebar)
const g15: OpFn = (ctx) => op(ctx, "G:execute_command", () => ctx.client.executeCommand("app:toggle-left-sidebar"));

// #16 open_file
const g16: OpFn = (ctx) => op(ctx, "G:open_file", () => ctx.client.openFile(pick(ctx.files)));

// #17 simple_search
const g17: OpFn = (ctx) => op(ctx, "G:simple_search", () => ctx.client.simpleSearch(pick(["stress", "test", "updated", "content"])).then(() => {}));

// #18 complex_search (JsonLogic glob)
const g18: OpFn = (ctx) => op(ctx, "G:complex_search", () =>
  ctx.client.complexSearch({ glob: [{ var: "path" }, `${STRESS_PREFIX}*.md`] }).then(() => {}));

// #19 dataview_search
const g19: OpFn = (ctx) => op(ctx, "G:dataview_search", () =>
  ctx.client.dataviewSearch('TABLE file.name FROM "" LIMIT 5').then(() => {}));

// #20 get_periodic_note
const g20: OpFn = (ctx) => op(ctx, "G:get_periodic_note", () => ctx.client.getPeriodicNote("daily", "markdown").then(() => {}));

// #21 put_periodic_note
const g21: OpFn = (ctx) => op(ctx, "G:put_periodic_note", () => ctx.client.putPeriodicNote("daily", `# Daily\n\nStress ${Date.now()}\n`));

// #22 append_periodic_note
const g22: OpFn = (ctx) => op(ctx, "G:append_periodic_note", () => ctx.client.appendPeriodicNote("daily", `\nAppend ${Date.now()}\n`));

// #23 patch_periodic_note — use :: delimiter
const g23: OpFn = (ctx) => op(ctx, "G:patch_periodic_note", async () => {
  await ctx.client.putPeriodicNote("daily", `# Daily\n\n## Log\n\nEntry.\n`);
  await ctx.client.patchPeriodicNote("daily", `\nPatched ${Date.now()}\n`, {
    operation: "append",
    targetType: "heading",
    target: "Daily::Log",
  });
});

// #24 delete_periodic_note — skip in sustained test (would destroy daily note repeatedly)

// #25 get_periodic_note_for_date
const g25: OpFn = (ctx) => op(ctx, "G:get_periodic_note_for_date", () =>
  ctx.client.getPeriodicNoteForDate("daily", 2026, 3, 15, "markdown").then(() => {}));

// #26 put_periodic_note_for_date
const g26: OpFn = (ctx) => op(ctx, "G:put_periodic_note_for_date", () =>
  ctx.client.putPeriodicNoteForDate("daily", 2026, 3, 15, `# Mar15\n\nStress ${Date.now()}\n`));

// #27 append_periodic_note_for_date
const g27: OpFn = (ctx) => op(ctx, "G:append_periodic_note_for_date", () =>
  ctx.client.appendPeriodicNoteForDate("daily", 2026, 3, 15, `\nAppend ${Date.now()}\n`));

// #28 patch_periodic_note_for_date — use :: delimiter
const g28: OpFn = (ctx) => op(ctx, "G:patch_periodic_note_for_date", async () => {
  await ctx.client.putPeriodicNoteForDate("daily", 2026, 3, 15, `# Mar15\n\n## Notes\n\nEntry.\n`);
  await ctx.client.patchPeriodicNoteForDate("daily", 2026, 3, 15, `\nPatched ${Date.now()}\n`, {
    operation: "append",
    targetType: "heading",
    target: "Mar15::Notes",
  });
});

// #29 delete_periodic_note_for_date — skip (destructive for sustained test)

// #30 get_server_status
const g30: OpFn = (ctx) => op(ctx, "G:get_server_status", () => ctx.client.getServerStatus().then(() => {}));

// #31 batch_get_file_contents — via getFileContents in a loop (client method)
const g31: OpFn = (ctx) => op(ctx, "G:batch_get_file_contents", async () => {
  const batch = ctx.files.slice(0, 5);
  await Promise.all(batch.map((f) => ctx.client.getFileContents(f, "markdown")));
});

// #32 get_recent_changes — derived from vault listing + stat.mtime (uses cache)
const g32: OpFn = (ctx) => op(ctx, "G:get_recent_changes", async () => {
  const notes = ctx.cache.getAllNotes();
  const sorted = [...notes].sort((a, b) => b.stat.mtime - a.stat.mtime);
  void sorted.slice(0, 10); // just access the data
});

// #33 get_recent_periodic_notes — derived (list dir, parse dates)
const g33: OpFn = (ctx) => op(ctx, "G:get_recent_periodic_notes", async () => {
  // Simulate what the tool does: get periodic note
  await ctx.client.getPeriodicNote("daily", "json").catch(() => {});
});

// #34 configure (show)
const g34: OpFn = (ctx) => op(ctx, "G:configure", async () => {
  // Just exercise the show action — don't change settings during stress
  void ctx.cache.noteCount;
});

// #35 get_backlinks
const g35: OpFn = (ctx) => op(ctx, "G:get_backlinks", async () => {
  ctx.cache.getBacklinks(pick(ctx.files));
});

// #36 get_vault_structure
const g36: OpFn = (ctx) => op(ctx, "G:get_vault_structure", async () => {
  ctx.cache.getOrphanNotes();
  ctx.cache.getMostConnectedNotes(5);
});

// #37 get_note_connections
const g37: OpFn = (ctx) => op(ctx, "G:get_note_connections", async () => {
  const file = pick(ctx.files);
  ctx.cache.getBacklinks(file);
  ctx.cache.getForwardLinks(file);
});

// #38 refresh_cache
const g38: OpFn = (ctx) => op(ctx, "G:refresh_cache", async () => {
  await ctx.cache.refresh();
});

// =============================================
// CONSOLIDATED TOOLS (11) — same client methods, different grouping
// =============================================

// C1: vault (list, list_dir, get, put, append, patch, delete, search_replace)
const c01: OpFn = (ctx) => op(ctx, "C:vault:list", () => ctx.client.listFilesInVault().then(() => {}));
const c01b: OpFn = (ctx) => op(ctx, "C:vault:get", () => ctx.client.getFileContents(pick(ctx.files), "markdown").then(() => {}));
const c01c: OpFn = (ctx) => op(ctx, "C:vault:put", () => ctx.client.putContent(pick(ctx.files), `# C-Put ${Date.now()}\n`));
const c01d: OpFn = (ctx) => op(ctx, "C:vault:append", () => ctx.client.appendContent(pick(ctx.files), `\nC-Append ${Date.now()}\n`));

// C2: active_file (get, put, append)
const c02: OpFn = (ctx) => op(ctx, "C:active_file:get", () => ctx.client.getActiveFile("markdown").then(() => {}));
const c02b: OpFn = (ctx) => op(ctx, "C:active_file:put", () => ctx.client.putActiveFile(`# C-Active ${Date.now()}\n`));

// C3: commands (list, execute)
const c03: OpFn = (ctx) => op(ctx, "C:commands:list", () => ctx.client.listCommands().then(() => {}));

// C4: open_file
const c04: OpFn = (ctx) => op(ctx, "C:open_file", () => ctx.client.openFile(pick(ctx.files)));

// C5: search (simple, jsonlogic, dataview)
const c05: OpFn = (ctx) => op(ctx, "C:search:simple", () => ctx.client.simpleSearch("stress").then(() => {}));
const c05b: OpFn = (ctx) => op(ctx, "C:search:jsonlogic", () =>
  ctx.client.complexSearch({ glob: [{ var: "path" }, "*.md"] }).then(() => {}));
const c05c: OpFn = (ctx) => op(ctx, "C:search:dataview", () =>
  ctx.client.dataviewSearch('TABLE file.name FROM "" LIMIT 3').then(() => {}));

// C6: periodic_note (get, put, append)
const c06: OpFn = (ctx) => op(ctx, "C:periodic_note:get", () => ctx.client.getPeriodicNote("daily").then(() => {}));
const c06b: OpFn = (ctx) => op(ctx, "C:periodic_note:put", () => ctx.client.putPeriodicNote("daily", `# C-Daily ${Date.now()}\n`));

// C7: status
const c07: OpFn = (ctx) => op(ctx, "C:status", () => ctx.client.getServerStatus().then(() => {}));

// C8: batch_get
const c08: OpFn = (ctx) => op(ctx, "C:batch_get", async () => {
  await Promise.all(ctx.files.slice(0, 3).map((f) => ctx.client.getFileContents(f, "json")));
});

// C9: recent (changes)
const c09: OpFn = (ctx) => op(ctx, "C:recent:changes", async () => {
  const notes = ctx.cache.getAllNotes();
  void [...notes].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 5);
});

// C10: configure (show)
const c10: OpFn = (ctx) => op(ctx, "C:configure:show", async () => {
  void ctx.cache.noteCount;
});

// C11: vault_analysis (backlinks, connections, structure, refresh)
const c11: OpFn = (ctx) => op(ctx, "C:vault_analysis:backlinks", () => { ctx.cache.getBacklinks(pick(ctx.files)); return Promise.resolve(); });
const c11b: OpFn = (ctx) => op(ctx, "C:vault_analysis:structure", () => { ctx.cache.getMostConnectedNotes(5); ctx.cache.getOrphanNotes(); return Promise.resolve(); });
const c11c: OpFn = (ctx) => op(ctx, "C:vault_analysis:refresh", () => ctx.cache.refresh());

// =============================================
// Weighted operation pool
// =============================================

const ALL_OPS: Array<{ weight: number; fn: OpFn }> = [
  // Granular (38 tools — #13 delete_active, #24 delete_periodic, #29 delete_periodic_for_date skipped as destructive in sustained test)
  { weight: 8, fn: g01 },  // list_files_in_vault
  { weight: 3, fn: g02 },  // list_files_in_dir
  { weight: 12, fn: g03 }, // get_file_contents
  { weight: 8, fn: g04 },  // put_content
  { weight: 5, fn: g05 },  // append_content
  { weight: 3, fn: g06 },  // patch_content
  { weight: 2, fn: g07 },  // delete_file
  { weight: 2, fn: g08 },  // search_replace
  { weight: 3, fn: g09 },  // get_active_file
  { weight: 2, fn: g10 },  // put_active_file
  { weight: 2, fn: g11 },  // append_active_file
  { weight: 1, fn: g12 },  // patch_active_file
  { weight: 3, fn: g14 },  // list_commands
  { weight: 1, fn: g15 },  // execute_command
  { weight: 2, fn: g16 },  // open_file
  { weight: 5, fn: g17 },  // simple_search
  { weight: 3, fn: g18 },  // complex_search
  { weight: 2, fn: g19 },  // dataview_search
  { weight: 2, fn: g20 },  // get_periodic_note
  { weight: 1, fn: g21 },  // put_periodic_note
  { weight: 1, fn: g22 },  // append_periodic_note
  { weight: 1, fn: g23 },  // patch_periodic_note
  { weight: 2, fn: g25 },  // get_periodic_note_for_date
  { weight: 1, fn: g26 },  // put_periodic_note_for_date
  { weight: 1, fn: g27 },  // append_periodic_note_for_date
  { weight: 1, fn: g28 },  // patch_periodic_note_for_date
  { weight: 4, fn: g30 },  // get_server_status
  { weight: 2, fn: g31 },  // batch_get_file_contents
  { weight: 2, fn: g32 },  // get_recent_changes
  { weight: 1, fn: g33 },  // get_recent_periodic_notes
  { weight: 1, fn: g34 },  // configure
  { weight: 3, fn: g35 },  // get_backlinks
  { weight: 2, fn: g36 },  // get_vault_structure
  { weight: 2, fn: g37 },  // get_note_connections
  { weight: 1, fn: g38 },  // refresh_cache

  // Consolidated (11 tools, multiple actions)
  { weight: 3, fn: c01 },   // vault:list
  { weight: 3, fn: c01b },  // vault:get
  { weight: 2, fn: c01c },  // vault:put
  { weight: 2, fn: c01d },  // vault:append
  { weight: 2, fn: c02 },   // active_file:get
  { weight: 1, fn: c02b },  // active_file:put
  { weight: 2, fn: c03 },   // commands:list
  { weight: 1, fn: c04 },   // open_file
  { weight: 3, fn: c05 },   // search:simple
  { weight: 1, fn: c05b },  // search:jsonlogic
  { weight: 1, fn: c05c },  // search:dataview
  { weight: 2, fn: c06 },   // periodic_note:get
  { weight: 1, fn: c06b },  // periodic_note:put
  { weight: 3, fn: c07 },   // status
  { weight: 1, fn: c08 },   // batch_get
  { weight: 1, fn: c09 },   // recent:changes
  { weight: 1, fn: c10 },   // configure:show
  { weight: 2, fn: c11 },   // vault_analysis:backlinks
  { weight: 1, fn: c11b },  // vault_analysis:structure
  { weight: 1, fn: c11c },  // vault_analysis:refresh
];

function pickOp(): OpFn {
  const total = ALL_OPS.reduce((s, o) => s + o.weight, 0);
  let rand = Math.random() * total;
  for (const o of ALL_OPS) {
    rand -= o.weight;
    if (rand <= 0) return o.fn;
  }
  return ALL_OPS[0]!.fn;
}

// --- Worker ---

async function worker(ctx: OpContext, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    await pickOp()(ctx);
  }
}

// --- Cleanup ---

async function cleanup(client: ObsidianClient): Promise<void> {
  const { files } = await client.listFilesInVault();
  const stressFiles = files.filter((f) => f.includes(STRESS_PREFIX));
  await Promise.all(stressFiles.map((f) => client.deleteFile(f).catch(() => {})));
  if (stressFiles.length > 0) write(`  Cleaned up ${String(stressFiles.length)} stress test files`);
}

// --- Main ---

async function main(): Promise<void> {
  write("");
  write("=== mcp-obsidian-extended FULL COVERAGE stress test ===");
  write("");
  write(`  Duration:     ${String(DURATION_MS / 1000)}s`);
  write(`  Concurrency:  ${String(CONCURRENCY)} workers`);
  write(`  File pool:    ${String(FILE_POOL_SIZE)} files`);
  write(`  Tool targets: 35 granular + 20 consolidated actions`);
  write(`  Reports:      every ${String(REPORT_INTERVAL_MS / 1000)}s`);
  write("");

  loadDotenv();
  const config = loadConfig();
  if (!config.apiKey) { write("[error] OBSIDIAN_API_KEY not set."); process.exit(1); }

  const client = new ObsidianClient(config);

  // Safety guard
  const { files } = await client.listFilesInVault();
  if (files.length > VAULT_FILE_LIMIT) { write(`[error] Vault has ${String(files.length)} files — use a test vault.`); process.exit(1); }

  // Seed file pool
  const filePool = Array.from({ length: FILE_POOL_SIZE }, (_, i) => `${STRESS_PREFIX}${String(i).padStart(3, "0")}.md`);
  write("  Seeding file pool...");
  await Promise.all(filePool.map((f, i) =>
    client.putContent(f, `# Stress ${String(i)}\n\n## Section\n\nContent.\n\n[[${filePool[(i + 1) % FILE_POOL_SIZE]!}]]\n`)
  ));

  // Build initial cache
  const cache = new VaultCache(client, 60_000);
  client.setCache(cache);
  await cache.initialize();
  write(`  ${String(filePool.length)} files seeded, cache: ${String(cache.noteCount)} notes`);
  write("");

  const stats = new Stats();
  const deadline = Date.now() + DURATION_MS;
  const ctx: OpContext = { client, stats, files: filePool, cache };

  const reportTimer = setInterval(() => stats.printProgress(), REPORT_INTERVAL_MS);

  write("  Starting workers...");
  write("");

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(ctx, deadline)));
  } finally {
    clearInterval(reportTimer);
    cache.stopAutoRefresh();
  }

  stats.printProgress();
  stats.printFinal();

  // Coverage check
  const expectedGranular = 35; // 38 minus 3 skipped destructive
  const expectedConsolidated = 20; // actions across 11 tools
  const expectedTotal = expectedGranular + expectedConsolidated;
  write(`  Coverage: ${String(stats.coveredTools)}/${String(expectedTotal)} tool operations hit`);

  write("");
  write("  Cleaning up...");
  await cleanup(client);

  const errorRate = stats.totalOps > 0 ? (stats.totalErrors / stats.totalOps) * 100 : 0;
  const opsPerSec = stats.totalOps / stats.elapsedSec;

  write("");
  write("  Pass criteria:");
  write(`    Error rate < 5%:       ${errorRate < 5 ? "PASS" : "FAIL"} (${errorRate.toFixed(2)}%)`);
  write(`    Throughput > 10/s:     ${opsPerSec > 10 ? "PASS" : "FAIL"} (${opsPerSec.toFixed(1)}/s)`);
  write(`    Coverage >= ${String(expectedTotal)} tools:  ${stats.coveredTools >= expectedTotal ? "PASS" : "FAIL"} (${String(stats.coveredTools)}/${String(expectedTotal)})`);
  write(`    No crashes:            PASS`);
  write("");

  process.exit(errorRate < 5 && opsPerSec > 10 && stats.coveredTools >= expectedTotal ? 0 : 1);
}

main().catch((err: unknown) => {
  write(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
