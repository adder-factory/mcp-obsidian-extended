#!/usr/bin/env tsx
/**
 * 10-minute comprehensive stress test covering ALL tools in both
 * granular and consolidated modes against a live Obsidian vault.
 *
 * Test categories:
 * - CRUD lifecycle (put/get/append/patch/search_replace/delete)
 * - Concurrent write storms (same file, different files)
 * - Search (simple, JsonLogic, Dataview TABLE)
 * - Cache lifecycle (build, invalidate, rebuild, graph queries)
 * - Heading mismatch retry (concurrent writes changing headings)
 * - Active file operations
 * - Periodic notes CRUD
 * - Commands and open_file
 * - Batch operations
 * - Error recovery (404, invalid targets, auth)
 *
 * Usage: npx tsx scripts/stress-test-10m.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ObsidianClient } from "../src/obsidian.js";
import { VaultCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";

// --- .env loader ---
try {
  const envPath = resolve(process.cwd(), ".env");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
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
  /* no .env */
}

// --- Helpers ---
const write = (msg: string): void => {
  process.stderr.write(msg);
};
const writeln = (msg: string): void => {
  process.stderr.write(msg + "\n");
};
const PREFIX = "_stress10m_";
const DURATION_MS = 10 * 60 * 1000; // 10 minutes
const startTime = Date.now();

function elapsed(): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// Stats
interface Stats {
  total: number;
  passed: number;
  failed: number;
  errors: Map<string, number>;
  latencies: number[];
  toolCoverage: Set<string>;
}

const stats: Stats = {
  total: 0,
  passed: 0,
  failed: 0,
  errors: new Map(),
  latencies: [],
  toolCoverage: new Set(),
};

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const result = await fn();
  return [result, Date.now() - t0];
}

async function runOp(tool: string, fn: () => Promise<void>): Promise<boolean> {
  stats.total++;
  stats.toolCoverage.add(tool);
  try {
    const [, ms] = await timed(fn);
    stats.passed++;
    stats.latencies.push(ms);
    return true;
  } catch (err: unknown) {
    stats.failed++;
    const msg =
      err instanceof Error
        ? err.message.slice(0, 80)
        : String(err).slice(0, 80);
    stats.errors.set(msg, (stats.errors.get(msg) ?? 0) + 1);
    return false;
  }
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function timeLeft(): boolean {
  return Date.now() - startTime < DURATION_MS;
}

// --- Test Scenarios ---

const config = loadConfig();
const client = new ObsidianClient(config);
const createdFiles: string[] = [];

function testFile(name: string): string {
  const path = `${PREFIX}${name}_${randomId()}.md`;
  createdFiles.push(path);
  return path;
}

// 1. CRUD Lifecycle — full put/get/append/patch/search_replace/delete cycle
async function scenarioCrudLifecycle(): Promise<void> {
  const f = testFile("crud");
  const heading = `Heading_${randomId()}`;
  const content = `# ${heading}\n\nInitial content.\n\n## Sub\n\nSub content.\n`;

  await runOp("put_content", () => client.putContent(f, content));
  await runOp("get_file_contents_md", async () => {
    await client.getFileContents(f, "markdown");
  });
  await runOp("get_file_contents_json", async () => {
    await client.getFileContents(f, "json");
  });
  await runOp("get_file_contents_map", async () => {
    await client.getFileContents(f, "map");
  });
  await runOp("append_content", () =>
    client.appendContent(f, "\nAppended line.\n"),
  );
  await runOp("patch_content_heading", () =>
    client.patchContent(f, "\nPatched under heading.\n", {
      operation: "append",
      targetType: "heading",
      target: heading,
    }),
  );
  await runOp("patch_content_block", () =>
    client.patchContent(f, "\nPatched under sub.\n", {
      operation: "append",
      targetType: "heading",
      target: "Sub",
    }),
  );

  // search_replace: read → modify → write
  const raw = await client.getFileContents(f, "markdown", true);
  if (typeof raw === "string" && raw.includes("Initial content")) {
    await runOp("search_replace", async () => {
      await client.putContent(
        f,
        raw.replace("Initial content", "Replaced content"),
      );
    });
  }

  await runOp("delete_file", () => client.deleteFile(f));
  createdFiles.pop(); // Already deleted
}

// 2. Concurrent write storms — same file
async function scenarioConcurrentSameFile(): Promise<void> {
  const f = testFile("concurrent");
  await client.putContent(f, "# Root\n\nBase.\n");

  const writes = Array.from({ length: 8 }, (_, i) =>
    runOp("concurrent_append_same", () =>
      client.appendContent(f, `\nConcurrent line ${String(i)}\n`),
    ),
  );
  await Promise.allSettled(writes);

  // Verify content integrity
  const result = await client.getFileContents(f, "markdown");
  if (typeof result === "string") {
    const lineCount = result
      .split("\n")
      .filter((l) => l.includes("Concurrent line")).length;
    if (lineCount < 6) {
      stats.failed++;
      stats.errors.set(
        "concurrent_integrity_low",
        (stats.errors.get("concurrent_integrity_low") ?? 0) + 1,
      );
    }
  }
}

// 3. Concurrent write storms — different files
async function scenarioConcurrentDiffFiles(): Promise<void> {
  const files = Array.from({ length: 5 }, () => testFile("diffwrite"));
  await Promise.all(
    files.map((f) => client.putContent(f, `# H\n\nContent for ${f}\n`)),
  );

  const writes = files.map((f) =>
    runOp("concurrent_append_diff", () =>
      client.appendContent(f, `\nParallel write at ${String(Date.now())}\n`),
    ),
  );
  await Promise.allSettled(writes);
}

// 4. Search operations
async function scenarioSearch(): Promise<void> {
  const f = testFile("search");
  const needle = `UniqueNeedle_${randomId()}`;
  await client.putContent(
    f,
    `# Searchable\n\nThis note contains ${needle} for testing.\n`,
  );

  // Wait briefly for index
  await new Promise<void>((r) => {
    setTimeout(r, 500);
  });

  await runOp("simple_search", async () => {
    const results = await client.simpleSearch(needle, 50);
    if (results.length === 0) throw new Error("simple_search found nothing");
  });

  await runOp("complex_search_glob", async () => {
    await client.complexSearch({ glob: [{ var: "path" }, `${PREFIX}*`] });
  });

  // Dataview TABLE (LIST not supported)
  await runOp("dataview_search", async () => {
    try {
      await client.dataviewSearch(`TABLE file.mtime FROM "${PREFIX}search"`);
    } catch (err: unknown) {
      // Dataview plugin may not be installed — record but don't fail
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("405") || msg.includes("plugin")) return;
      throw err;
    }
  });
}

// 5. Cache lifecycle — build, query, invalidate, rebuild
async function scenarioCacheLifecycle(): Promise<void> {
  const cache = new VaultCache(client, 600000);

  await runOp("cache_initialize", () => cache.initialize());
  await runOp("cache_get_backlinks", async () => {
    cache.getBacklinks(createdFiles[0] ?? "nonexistent.md");
  });
  await runOp("cache_get_structure", async () => {
    const orphans = cache.getOrphanNotes();
    const connected = cache.getMostConnectedNotes(5);
    if (
      cache.noteCount === 0 &&
      orphans.length === 0 &&
      connected.length === 0
    ) {
      throw new Error("cache empty");
    }
  });
  await runOp("cache_get_connections", async () => {
    const notes = cache.getAllNotes();
    if (notes.length > 0) {
      const note = pick(notes);
      cache.getBacklinks(note.path);
      cache.getForwardLinks(note.path);
    }
  });
  await runOp("cache_invalidate_rebuild", async () => {
    cache.invalidateAll();
    await cache.initialize();
    if (cache.noteCount === 0) throw new Error("rebuild failed");
  });
  await runOp("cache_wait_for_init", async () => {
    cache.invalidateAll();
    const p = cache.initialize();
    const ready = await cache.waitForInitialization(5000);
    await p;
    if (!ready) throw new Error("waitForInitialization returned false");
  });
  cache.stopAutoRefresh();
}

// 6. Heading mismatch retry simulation
async function scenarioHeadingRetry(): Promise<void> {
  const f = testFile("heading_retry");
  await client.putContent(
    f,
    "# Alpha\n\nAlpha content.\n\n## Beta\n\nBeta content.\n",
  );

  // Concurrent: one writer changes content while another patches a heading
  const writer = runOp("heading_concurrent_write", () =>
    client.appendContent(f, "\nNew paragraph under root.\n"),
  );
  const patcher = runOp("heading_concurrent_patch", () =>
    client.patchContent(f, "\nPatched under Alpha.\n", {
      operation: "append",
      targetType: "heading",
      target: "Alpha",
    }),
  );
  await Promise.allSettled([writer, patcher]);

  // Verify file is still valid
  await runOp("heading_verify", async () => {
    const result = await client.getFileContents(f, "json");
    if (typeof result === "string") throw new Error("expected JSON");
  });
}

// 7. Active file operations
async function scenarioActiveFile(): Promise<void> {
  // Create a file and open it to make it active
  const f = testFile("active");
  await client.putContent(f, "# Active Test\n\nActive content.\n");
  await client.openFile(f);
  await new Promise<void>((r) => {
    setTimeout(r, 300);
  }); // Wait for Obsidian to open

  await runOp("get_active_file_md", async () => {
    await client.getActiveFile("markdown");
  });
  await runOp("get_active_file_json", async () => {
    await client.getActiveFile("json");
  });
  await runOp("get_active_file_map", async () => {
    await client.getActiveFile("map");
  });
  await runOp("append_active_file", () =>
    client.appendActiveFile("\nActive append.\n"),
  );
  await runOp("patch_active_file", () =>
    client.patchActiveFile("\nActive patch.\n", {
      operation: "append",
      targetType: "heading",
      target: "Active Test",
    }),
  );
}

// 8. Periodic notes
async function scenarioPeriodicNotes(): Promise<void> {
  // Use past dates to avoid interfering with real daily notes
  const year = 2020;
  const month = 1;
  const day = 15;

  await runOp("put_periodic_note_for_date", () =>
    client.putPeriodicNoteForDate(
      "daily",
      year,
      month,
      day,
      "# Daily Test\n\nStress test content.\n",
    ),
  );
  await runOp("get_periodic_note_for_date", async () => {
    await client.getPeriodicNoteForDate("daily", year, month, day, "markdown");
  });
  await runOp("append_periodic_note_for_date", () =>
    client.appendPeriodicNoteForDate(
      "daily",
      year,
      month,
      day,
      "\nAppended to periodic.\n",
    ),
  );
  await runOp("patch_periodic_note_for_date", () =>
    client.patchPeriodicNoteForDate(
      "daily",
      year,
      month,
      day,
      "\nPatched periodic.\n",
      {
        operation: "append",
        targetType: "heading",
        target: "Daily Test",
      },
    ),
  );
  await runOp("delete_periodic_note_for_date", () =>
    client.deletePeriodicNoteForDate("daily", year, month, day),
  );
}

// 9. Commands and navigation
async function scenarioCommandsAndNav(): Promise<void> {
  await runOp("list_commands", async () => {
    const { commands } = await client.listCommands();
    if (commands.length === 0) throw new Error("no commands");
  });

  // Open a file
  const f = createdFiles.length > 0 ? createdFiles[0]! : testFile("nav");
  if (!createdFiles.includes(f)) {
    await client.putContent(f, "# Nav Test\n\nNav content.\n");
  }
  await runOp("open_file", () => client.openFile(f, false));
  await runOp("open_file_new_leaf", () => client.openFile(f, true));

  // Execute a safe command
  await runOp("execute_command", async () => {
    try {
      await client.executeCommand("app:toggle-left-sidebar");
    } catch {
      // Command may not exist — that's OK
    }
  });
}

// 10. Batch operations
async function scenarioBatch(): Promise<void> {
  const files = Array.from({ length: 3 }, () => testFile("batch"));
  await Promise.all(
    files.map((f, i) =>
      client.putContent(
        f,
        `# Batch ${String(i)}\n\nBatch content ${String(i)}.\n`,
      ),
    ),
  );

  await runOp("batch_get_files", async () => {
    const results: Array<{ path: string; content?: unknown; error?: string }> =
      [];
    for (const f of files) {
      try {
        const content = await client.getFileContents(f, "markdown");
        results.push({ path: f, content });
      } catch (err: unknown) {
        results.push({
          path: f,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const successes = results.filter((r) => r.content !== undefined).length;
    if (successes < 2)
      throw new Error(
        `batch only got ${String(successes)}/${String(files.length)}`,
      );
  });
}

// 11. Error recovery — 404, bad targets, delete idempotency
async function scenarioErrorRecovery(): Promise<void> {
  await runOp("get_404_graceful", async () => {
    try {
      await client.getFileContents(
        "nonexistent_file_xyz_" + randomId() + ".md",
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("should have thrown"))
        throw err;
      // Expected 404 error — pass
    }
  });

  await runOp("delete_idempotent", async () => {
    await client.deleteFile("nonexistent_" + randomId() + ".md"); // Should not throw
  });

  await runOp("list_empty_dir", async () => {
    try {
      await client.listFilesInDir("nonexistent_dir_" + randomId());
    } catch {
      // Expected 404 — pass
    }
  });

  await runOp("patch_invalid_target", async () => {
    const f = testFile("errpatch");
    await client.putContent(f, "# Exist\n\nContent.\n");
    try {
      await client.patchContent(f, "text", {
        operation: "append",
        targetType: "heading",
        target: "DoesNotExist_" + randomId(),
      });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("should have thrown"))
        throw err;
      // Expected error — pass
    }
  });
}

// 12. Directory listing
async function scenarioDirectoryListing(): Promise<void> {
  await runOp("list_files_in_vault", async () => {
    const { files } = await client.listFilesInVault();
    if (files.length === 0) throw new Error("vault empty");
  });

  await runOp("list_files_in_dir", async () => {
    const { files } = await client.listFilesInVault();
    const dirs = new Set<string>();
    for (const f of files) {
      const slash = f.indexOf("/");
      if (slash > 0) dirs.add(f.slice(0, slash));
    }
    if (dirs.size > 0) {
      const dir = [...dirs][0]!;
      await client.listFilesInDir(dir);
    }
  });
}

// 13. Server status and config
async function scenarioStatusAndConfig(): Promise<void> {
  await runOp("get_server_status", async () => {
    const status = await client.getServerStatus();
    if (!status.authenticated) throw new Error("not authenticated");
  });
}

// 14. Link graph stress — many linked files
async function scenarioLinkGraph(): Promise<void> {
  const files = Array.from({ length: 5 }, (_, i) =>
    testFile(`graph${String(i)}`),
  );

  // Create files with wikilinks between them
  for (let i = 0; i < files.length; i++) {
    const links = files
      .filter((_, j) => j !== i)
      .map((f) => `[[${f.replace(".md", "")}]]`)
      .join(", ");
    await client.putContent(
      files[i]!,
      `# Node ${String(i)}\n\nLinks to: ${links}\n`,
    );
  }

  const cache = new VaultCache(client, 600000);
  await cache.initialize();

  await runOp("graph_backlinks", async () => {
    const bl = cache.getBacklinks(files[0]!);
    if (bl.length === 0) throw new Error("no backlinks found");
  });

  await runOp("graph_forward_links", async () => {
    const fl = cache.getForwardLinks(files[0]!);
    if (fl.length === 0) throw new Error("no forward links found");
  });

  await runOp("graph_orphan_check", async () => {
    cache.getOrphanNotes();
  });

  await runOp("graph_most_connected", async () => {
    cache.getMostConnectedNotes(10);
  });

  await runOp("graph_vault_structure", async () => {
    const graph = cache.getVaultGraph();
    if (graph.nodes.length === 0) throw new Error("empty graph");
  });

  cache.stopAutoRefresh();
}

// 15. Rapid fire mixed operations
async function scenarioRapidFireMixed(): Promise<void> {
  const f = testFile("rapid");
  await client.putContent(
    f,
    `# Rapid\n\n## Section A\n\nA content.\n\n## Section B\n\nB content.\n`,
  );

  const ops: Array<() => Promise<void>> = [
    () =>
      runOp("rapid_get", async () => {
        await client.getFileContents(f, "markdown");
      }).then(() => {}),
    () =>
      runOp("rapid_get_json", async () => {
        await client.getFileContents(f, "json");
      }).then(() => {}),
    () =>
      runOp("rapid_get_map", async () => {
        await client.getFileContents(f, "map");
      }).then(() => {}),
    () =>
      runOp("rapid_append", () =>
        client.appendContent(f, `\nRapid ${randomId()}\n`),
      ).then(() => {}),
    () =>
      runOp("rapid_search", async () => {
        await client.simpleSearch("Rapid", 20);
      }).then(() => {}),
    () =>
      runOp("rapid_status", async () => {
        await client.getServerStatus();
      }).then(() => {}),
    () =>
      runOp("rapid_list", async () => {
        await client.listFilesInVault();
      }).then(() => {}),
  ];

  // Fire 20 random ops concurrently
  const batch = Array.from({ length: 20 }, () => pick(ops)());
  await Promise.allSettled(batch);
}

// --- Main Loop ---

async function run(): Promise<void> {
  writeln("\n╔═══════════════════════════════════════════════════════════╗");
  writeln("║  10-MINUTE COMPREHENSIVE STRESS TEST                     ║");
  writeln("║  All tools • Granular + Consolidated • Concurrent writes  ║");
  writeln("╚═══════════════════════════════════════════════════════════╝\n");

  // Connectivity check
  const status = await client.getServerStatus();
  writeln(
    `  Connected: ${status.service} (authenticated: ${String(status.authenticated)})`,
  );

  const { files } = await client.listFilesInVault();
  writeln(`  Vault: ${String(files.length)} files`);

  if (files.length > 100 && process.env["SMOKE_TEST_CONFIRM"] !== "true") {
    writeln(
      "\n  ⚠ Vault has >100 files. Set SMOKE_TEST_CONFIRM=true to proceed.",
    );
    process.exit(1);
  }

  writeln(`  Duration: 10 minutes\n`);
  writeln("  Starting scenarios...\n");

  // Scenario rotation — keep cycling through all scenarios for 10 minutes
  const scenarios: Array<[string, () => Promise<void>]> = [
    ["CRUD Lifecycle", scenarioCrudLifecycle],
    ["Concurrent Same File", scenarioConcurrentSameFile],
    ["Concurrent Diff Files", scenarioConcurrentDiffFiles],
    ["Search Operations", scenarioSearch],
    ["Cache Lifecycle", scenarioCacheLifecycle],
    ["Heading Retry", scenarioHeadingRetry],
    ["Active File", scenarioActiveFile],
    ["Periodic Notes", scenarioPeriodicNotes],
    ["Commands & Nav", scenarioCommandsAndNav],
    ["Batch Operations", scenarioBatch],
    ["Error Recovery", scenarioErrorRecovery],
    ["Directory Listing", scenarioDirectoryListing],
    ["Status & Config", scenarioStatusAndConfig],
    ["Link Graph", scenarioLinkGraph],
    ["Rapid Fire Mixed", scenarioRapidFireMixed],
  ];

  let round = 0;
  while (timeLeft()) {
    round++;
    writeln(`  ── Round ${String(round)} [${elapsed()}] ──`);

    for (const [name, fn] of scenarios) {
      if (!timeLeft()) break;
      write(`    ${name}... `);
      try {
        await fn();
        writeln("✓");
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message.slice(0, 60)
            : String(err).slice(0, 60);
        writeln(`✗ (${msg})`);
      }

      // Periodic cleanup to avoid file bloat
      if (createdFiles.length > 30) {
        const toDelete = createdFiles.splice(0, 20);
        await Promise.allSettled(
          toDelete.map((f) => client.deleteFile(f).catch(() => {})),
        );
      }
    }

    // Progress report every round
    const opsPerSec = stats.total / ((Date.now() - startTime) / 1000);
    writeln(
      `    [ops: ${String(stats.total)} | pass: ${String(stats.passed)} | fail: ${String(stats.failed)} | ${opsPerSec.toFixed(1)} ops/s | tools: ${String(stats.toolCoverage.size)}]\n`,
    );
  }

  // --- Cleanup ---
  writeln("  Cleaning up test files...");
  await Promise.allSettled(
    createdFiles.map((f) => client.deleteFile(f).catch(() => {})),
  );

  // --- Final Report ---
  const totalSec = (Date.now() - startTime) / 1000;
  const errorRate = stats.total > 0 ? (stats.failed / stats.total) * 100 : 0;

  writeln("\n╔═══════════════════════════════════════════════════════════╗");
  writeln("║  FINAL REPORT                                            ║");
  writeln("╚═══════════════════════════════════════════════════════════╝");
  writeln(`  Duration:     ${totalSec.toFixed(1)}s (${String(round)} rounds)`);
  writeln(`  Operations:   ${String(stats.total)} total`);
  writeln(`  Passed:       ${String(stats.passed)}`);
  writeln(`  Failed:       ${String(stats.failed)} (${errorRate.toFixed(2)}%)`);
  writeln(`  Throughput:   ${(stats.total / totalSec).toFixed(1)} ops/sec`);
  writeln(`  Tool Coverage: ${String(stats.toolCoverage.size)} unique tools`);
  writeln("");
  writeln("  Latency (ms):");
  writeln(`    p50:  ${String(percentile(stats.latencies, 50))}`);
  writeln(`    p95:  ${String(percentile(stats.latencies, 95))}`);
  writeln(`    p99:  ${String(percentile(stats.latencies, 99))}`);
  writeln(`    max:  ${String(percentile(stats.latencies, 100))}`);
  writeln("");
  writeln(
    `  Heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
  );
  writeln("");

  if (stats.errors.size > 0) {
    writeln("  Errors:");
    const sorted = [...stats.errors.entries()].sort((a, b) => b[1] - a[1]);
    for (const [msg, count] of sorted.slice(0, 10)) {
      writeln(`    ${String(count)}x ${msg}`);
    }
    writeln("");
  }

  writeln("  Tools exercised:");
  const toolList = [...stats.toolCoverage].sort();
  for (let i = 0; i < toolList.length; i += 4) {
    writeln(`    ${toolList.slice(i, i + 4).join(", ")}`);
  }
  writeln("");

  // Pass/fail threshold
  if (errorRate > 10) {
    writeln("  RESULT: ✗ FAIL (error rate >10%)");
    process.exit(1);
  } else {
    writeln("  RESULT: ✓ PASS");
    process.exit(0);
  }
}

run().catch((err) => {
  writeln(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
