#!/usr/bin/env tsx
/**
 * Stress tests for mcp-obsidian-extended — exercises concurrency, throughput,
 * and edge cases against a live Obsidian instance.
 * All output goes to stderr. Exit 0 = pass, Exit 1 = fail.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { ObsidianClient } from "../src/obsidian.js";
import { VaultCache } from "../src/cache.js";
import { ObsidianApiError } from "../src/errors.js";

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

const STRESS_PREFIX = "_stress_test_";
const VAULT_FILE_LIMIT = 50;

/** Formats milliseconds as a human-readable duration. */
function fmt(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

/** Times an async function and returns [result, elapsedMs]. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const result = await fn();
  return [result, Date.now() - start];
}

// --- Stress Tests ---

interface StressResult {
  name: string;
  passed: boolean;
  duration: number;
  ops: number;
  details: string;
}

/** Test 1: Concurrent writes to different files — tests write lock independence. */
async function testConcurrentWritesDifferentFiles(
  client: ObsidianClient,
): Promise<StressResult> {
  const count = 20;
  const files = Array.from(
    { length: count },
    (_, i) => `${STRESS_PREFIX}concurrent_${String(i)}.md`,
  );
  const content = (i: number): string =>
    `# Concurrent Write ${String(i)}\n\nWritten at ${new Date().toISOString()}\n`;

  const [, duration] = await timed(async () => {
    await Promise.all(files.map((f, i) => client.putContent(f, content(i))));
  });

  // Verify all files exist
  let verified = 0;
  for (const f of files) {
    const c = await client.getFileContents(f, "markdown");
    if (typeof c === "string" && c.includes("Concurrent Write")) verified++;
  }

  // Cleanup
  await Promise.all(files.map((f) => client.deleteFile(f).catch(() => {})));

  return {
    name: "Concurrent writes (different files)",
    passed: verified === count,
    duration,
    ops: count,
    details: `${String(verified)}/${String(count)} verified, ${fmt(duration)} total, ${fmt(duration / count)}/op`,
  };
}

/** Test 2: Concurrent writes to the SAME file — tests write lock serialization. */
async function testConcurrentWritesSameFile(
  client: ObsidianClient,
): Promise<StressResult> {
  const file = `${STRESS_PREFIX}same_file.md`;
  const count = 10;
  await client.putContent(file, "# Start\n");

  const [, duration] = await timed(async () => {
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        client.appendContent(file, `\nLine ${String(i)}\n`),
      ),
    );
  });

  const result = await client.getFileContents(file, "markdown");
  const lineCount =
    typeof result === "string" ? (result.match(/Line \d+/g) ?? []).length : 0;
  await client.deleteFile(file).catch(() => {});

  return {
    name: "Concurrent writes (same file — lock test)",
    passed: lineCount === count,
    duration,
    ops: count,
    details: `${String(lineCount)}/${String(count)} lines written, ${fmt(duration)} total`,
  };
}

/** Test 3: Rapid sequential reads — throughput benchmark. */
async function testRapidReads(client: ObsidianClient): Promise<StressResult> {
  const file = `${STRESS_PREFIX}read_target.md`;
  await client.putContent(
    file,
    "# Read Target\n\nContent for rapid read testing.\n".repeat(10),
  );

  const count = 50;
  const [, duration] = await timed(async () => {
    for (let i = 0; i < count; i++) {
      await client.getFileContents(file, "markdown");
    }
  });

  await client.deleteFile(file).catch(() => {});

  return {
    name: "Rapid sequential reads",
    passed: true,
    duration,
    ops: count,
    details: `${String(count)} reads in ${fmt(duration)}, ${fmt(duration / count)}/op`,
  };
}

/** Test 4: Concurrent reads — parallel throughput. */
async function testConcurrentReads(
  client: ObsidianClient,
): Promise<StressResult> {
  const file = `${STRESS_PREFIX}concurrent_read.md`;
  await client.putContent(file, "# Concurrent Read Target\n\nContent.\n");

  const count = 30;
  let successes = 0;
  const [, duration] = await timed(async () => {
    const results = await Promise.allSettled(
      Array.from({ length: count }, () =>
        client.getFileContents(file, "markdown"),
      ),
    );
    successes = results.filter((r) => r.status === "fulfilled").length;
  });

  await client.deleteFile(file).catch(() => {});

  return {
    name: "Concurrent reads (parallel)",
    passed: successes === count,
    duration,
    ops: count,
    details: `${String(successes)}/${String(count)} succeeded in ${fmt(duration)}, ${fmt(duration / count)}/op`,
  };
}

/** Test 5: Concurrent searches — tests search timeout handling. */
async function testConcurrentSearches(
  client: ObsidianClient,
): Promise<StressResult> {
  const count = 10;
  let successes = 0;
  const queries = [
    "test",
    "obsidian",
    "note",
    "markdown",
    "link",
    "file",
    "content",
    "search",
    "vault",
    "stress",
  ];

  const [, duration] = await timed(async () => {
    const results = await Promise.allSettled(
      queries.slice(0, count).map((q) => client.simpleSearch(q)),
    );
    successes = results.filter((r) => r.status === "fulfilled").length;
  });

  return {
    name: "Concurrent searches",
    passed: successes === count,
    duration,
    ops: count,
    details: `${String(successes)}/${String(count)} completed in ${fmt(duration)}, ${fmt(duration / count)}/op`,
  };
}

/** Test 6: Rapid create-read-delete cycle — full CRUD throughput. */
async function testCrudCycle(client: ObsidianClient): Promise<StressResult> {
  const count = 15;
  let successes = 0;

  const [, duration] = await timed(async () => {
    for (let i = 0; i < count; i++) {
      const file = `${STRESS_PREFIX}crud_${String(i)}.md`;
      await client.putContent(file, `# CRUD ${String(i)}\n`);
      const content = await client.getFileContents(file, "markdown");
      if (
        typeof content === "string" &&
        content.includes(`CRUD ${String(i)}`)
      ) {
        successes++;
      }
      await client.deleteFile(file);
    }
  });

  return {
    name: "Rapid create-read-delete cycles",
    passed: successes === count,
    duration,
    ops: count * 3, // put + get + delete per cycle
    details: `${String(successes)}/${String(count)} cycles, ${String(count * 3)} ops in ${fmt(duration)}, ${fmt(duration / (count * 3))}/op`,
  };
}

/** Test 7: Cache rebuild under load — stress the cache while reading. */
async function testCacheRebuildUnderLoad(
  client: ObsidianClient,
): Promise<StressResult> {
  // Create some files for the cache to index
  const fileCount = 10;
  const files = Array.from(
    { length: fileCount },
    (_, i) => `${STRESS_PREFIX}cache_${String(i)}.md`,
  );
  await Promise.all(
    files.map((f, i) => {
      // Self-link fallback satisfies noUncheckedIndexedAccess; the indexed
      // access is always in bounds (i < fileCount === files.length).
      const next = files[(i + 1) % fileCount] ?? f;
      return client.putContent(f, `# Cache File ${String(i)}\n\n[[${next}]]\n`);
    }),
  );

  const cache = new VaultCache(client, 60_000);
  client.setCache(cache);

  let rebuildCount = 0;
  const [, duration] = await timed(async () => {
    // Build cache 3 times while doing concurrent reads
    for (let round = 0; round < 3; round++) {
      await Promise.all([
        cache.initialize().then(() => {
          rebuildCount++;
        }),
        ...files.map((f) =>
          client.getFileContents(f, "markdown").catch(() => {}),
        ),
      ]);
    }
  });

  cache.stopAutoRefresh();

  // Cleanup
  await Promise.all(files.map((f) => client.deleteFile(f).catch(() => {})));

  return {
    name: "Cache rebuild under concurrent reads",
    passed: rebuildCount === 3 && cache.noteCount >= 0,
    duration,
    ops: 3 + fileCount * 3,
    details: `${String(rebuildCount)}/3 rebuilds, ${String(cache.noteCount)} notes cached, ${fmt(duration)} total`,
  };
}

/** Test 8: Large file handling — write and read a large file. */
async function testLargeFile(client: ObsidianClient): Promise<StressResult> {
  const file = `${STRESS_PREFIX}large.md`;
  const sizeMb = 1;
  const content = `# Large File Test\n\n${"Lorem ipsum dolor sit amet. ".repeat(40000)}\n`; // ~1MB

  let writeTime = 0;
  let readTime = 0;
  let readSize = 0;

  const [, duration] = await timed(async () => {
    const [, wt] = await timed(() => client.putContent(file, content));
    writeTime = wt;

    const [result, rt] = await timed(() =>
      client.getFileContents(file, "markdown"),
    );
    readTime = rt;
    readSize = typeof result === "string" ? result.length : 0;
  });

  await client.deleteFile(file).catch(() => {});

  return {
    name: `Large file (${String(sizeMb)}MB) write + read`,
    passed: readSize > 0,
    duration,
    ops: 2,
    details: `write: ${fmt(writeTime)}, read: ${fmt(readTime)}, size: ${String(Math.round(readSize / 1024))}KB`,
  };
}

/** Test 9: Error recovery — verify graceful handling of 404s and bad requests. */
async function testErrorRecovery(
  client: ObsidianClient,
): Promise<StressResult> {
  let handled = 0;
  const tests = 5;

  const [, duration] = await timed(async () => {
    // 404 on non-existent file
    try {
      await client.getFileContents("_nonexistent_file_12345.md", "markdown");
    } catch (e) {
      if (e instanceof ObsidianApiError && e.statusCode === 404) handled++;
    }

    // 404 on non-existent directory
    try {
      await client.listFilesInDir("_nonexistent_dir_12345");
    } catch (e) {
      if (e instanceof ObsidianApiError && e.statusCode === 404) handled++;
    }

    // Delete non-existent file (should not throw — idempotent)
    try {
      await client.deleteFile("_nonexistent_delete_12345.md");
      handled++;
    } catch {
      /* unexpected */
    }

    // Valid operation after errors — should still work
    try {
      await client.listFilesInVault();
      handled++;
    } catch {
      /* unexpected */
    }

    // Search with empty query
    try {
      await client.simpleSearch("");
      handled++;
    } catch (e) {
      if (e instanceof ObsidianApiError) handled++; // graceful error is fine too
    }
  });

  return {
    name: "Error recovery (404s, edge cases)",
    passed: handled === tests,
    duration,
    ops: tests,
    details: `${String(handled)}/${String(tests)} handled gracefully in ${fmt(duration)}`,
  };
}

/** Test 10: Mixed concurrent workload — reads, writes, searches simultaneously. */
async function testMixedWorkload(
  client: ObsidianClient,
): Promise<StressResult> {
  const file = `${STRESS_PREFIX}mixed.md`;
  await client.putContent(file, "# Mixed Workload\n\nInitial content.\n");

  let successes = 0;
  const totalOps = 20;

  const [, duration] = await timed(async () => {
    const ops = await Promise.allSettled([
      // Reads
      ...Array.from({ length: 5 }, () =>
        client.getFileContents(file, "markdown"),
      ),
      ...Array.from({ length: 3 }, () => client.getFileContents(file, "json")),
      // Writes
      ...Array.from({ length: 4 }, (_, i) =>
        client.appendContent(file, `\nMixed line ${String(i)}\n`),
      ),
      // Searches
      ...Array.from({ length: 4 }, () => client.simpleSearch("mixed")),
      // Listings
      ...Array.from({ length: 2 }, () => client.listFilesInVault()),
      // Status
      ...Array.from({ length: 2 }, () => client.getServerStatus()),
    ]);
    successes = ops.filter((r) => r.status === "fulfilled").length;
  });

  await client.deleteFile(file).catch(() => {});

  return {
    name: "Mixed concurrent workload",
    passed: successes >= totalOps - 2, // allow 2 failures for race conditions
    duration,
    ops: totalOps,
    details: `${String(successes)}/${String(totalOps)} succeeded in ${fmt(duration)}, ${fmt(duration / totalOps)}/op`,
  };
}

// --- Cleanup ---

/** Removes all stress test files from the vault. */
async function cleanup(client: ObsidianClient): Promise<void> {
  const { files } = await client.listFilesInVault();
  const stressFiles = files.filter((f) => f.includes(STRESS_PREFIX));
  for (const f of stressFiles) {
    try {
      await client.deleteFile(f);
    } catch {
      /* ignore */
    }
  }
  if (stressFiles.length > 0) {
    write(
      `  Cleaned up ${String(stressFiles.length)} leftover stress test files`,
    );
  }
}

// --- Main ---

async function main(): Promise<void> {
  write("");
  write("=== mcp-obsidian-extended stress tests ===");
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
      `[error] Vault has ${String(files.length)} files — too many for stress testing. Use a test vault.`,
    );
    process.exit(1);
  }

  const tests = [
    () => testConcurrentWritesDifferentFiles(client),
    () => testConcurrentWritesSameFile(client),
    () => testRapidReads(client),
    () => testConcurrentReads(client),
    () => testConcurrentSearches(client),
    () => testCrudCycle(client),
    () => testCacheRebuildUnderLoad(client),
    () => testLargeFile(client),
    () => testErrorRecovery(client),
    () => testMixedWorkload(client),
  ];

  const results: StressResult[] = [];

  for (const test of tests) {
    try {
      const result = await test();
      results.push(result);
      const icon = result.passed ? "\u2713" : "\u2717";
      write(`  ${icon} ${result.name}`);
      write(`    ${result.details}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      write(`  \u2717 Test threw: ${msg}`);
      results.push({
        name: "unknown",
        passed: false,
        duration: 0,
        ops: 0,
        details: msg,
      });
    }
  }

  // Final cleanup
  write("");
  write("  Cleaning up...");
  await cleanup(client);

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalOps = results.reduce((sum, r) => sum + r.ops, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const avgPerOp = totalOps > 0 ? `${fmt(totalDuration / totalOps)}/op avg` : "n/a";

  write("");
  write(
    `Results: ${String(passed)} passed, ${String(failed)} failed out of ${String(results.length)} tests`,
  );
  write(
    `Total: ${String(totalOps)} operations in ${fmt(totalDuration)} (${avgPerOp})`,
  );
  write("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  write(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
