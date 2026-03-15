#!/usr/bin/env tsx
// Smoke tests for mcp-obsidian-extended — runs against live Obsidian instance.
// All output goes to stderr. Exit 0 = pass, Exit 1 = fail.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { ObsidianClient } from "../src/obsidian.js";
import { VaultCache } from "../src/cache.js";
import { ObsidianApiError } from "../src/errors.js";

// --- Helpers ---

function write(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function pass(step: number, description: string): void {
  write(`  \u2713 Step ${String(step)}: ${description}`);
}

function fail(step: number, description: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  write(`  \u2717 Step ${String(step)}: ${description} \u2014 ${msg}`);
}

/** Load .env file from cwd if it exists, setting vars that are not already in process.env. */
function loadDotenv(): void {
  const envPath = resolve(process.cwd(), ".env");
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    // No .env file — that's fine, env vars may be set directly
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments (only for unquoted values)
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim();
      }
    }
    // Only set if not already in env (env vars take precedence)
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// --- Safety Guard ---

/**
 * Checks that the vault has fewer than a threshold of files, acting as a
 * guard against accidentally running destructive smoke tests on a real vault.
 * The dedicated mcp-test-vault should have very few files.
 * Can be bypassed with SMOKE_TEST_CONFIRM=true for larger test vaults.
 */
const VAULT_FILE_LIMIT = 50;

async function guardTestVault(client: ObsidianClient): Promise<void> {
  if (process.env["SMOKE_TEST_CONFIRM"] === "true") {
    return;
  }
  const { files } = await client.listFilesInVault();
  if (files.length > VAULT_FILE_LIMIT) {
    throw new Error(
      `Vault has ${String(files.length)} files (limit: ${String(VAULT_FILE_LIMIT)}). ` +
      "This looks like a real vault, not a test vault. " +
      "Set SMOKE_TEST_CONFIRM=true to override this safety check.",
    );
  }
}

// --- Test Files ---

const TEST_FILE = "_smoke_test.md";
const TEST_CONTENT = "# Smoke Test\n\nThis is a smoke test file.\n\n[[some link]]";
const APPEND_CONTENT = "\n\nAppended content.";

const LINK_FILE_A = "_smoke_link_a.md";
const LINK_FILE_B = "_smoke_link_b.md";
const LINK_CONTENT_A = "# Link Source\n\nThis note links to [[_smoke_link_b]].\n";
const LINK_CONTENT_B = "# Target Note\n\nTarget note content.\n";

// --- Test Steps ---

async function step1StatusCheck(client: ObsidianClient): Promise<void> {
  const status = await client.getServerStatus();
  // The REST API returns { status: "OK", service: "...", authenticated: bool, ... }
  // getServerStatus() is called without auth, so authenticated may be false here.
  // Auth is verified in step 2 via listFilesInVault() which requires a valid key.
  if (!status.service) {
    throw new Error(`Expected service field, got: ${JSON.stringify(status)}`);
  }
  write(`    (${status.service})`);
}

async function step2ListVaultFiles(client: ObsidianClient): Promise<void> {
  const result = await client.listFilesInVault();
  if (!Array.isArray(result.files)) {
    throw new Error("Expected files to be an array");
  }
  write(`    (${String(result.files.length)} files found)`);
}

async function step3PutTestFile(client: ObsidianClient): Promise<void> {
  await client.putContent(TEST_FILE, TEST_CONTENT);
}

async function step4ReadBack(client: ObsidianClient): Promise<void> {
  const content = await client.getFileContents(TEST_FILE, "markdown");
  if (typeof content !== "string") {
    throw new Error("Expected string response for markdown format");
  }
  // Obsidian may add a trailing newline; trim for comparison
  if (!content.includes("# Smoke Test") || !content.includes("[[some link]]")) {
    throw new Error(`Content mismatch. Got: ${content.slice(0, 200)}`);
  }
}

async function step5AppendAndVerify(client: ObsidianClient): Promise<void> {
  await client.appendContent(TEST_FILE, APPEND_CONTENT);
  const content = await client.getFileContents(TEST_FILE, "markdown");
  if (typeof content !== "string") {
    throw new Error("Expected string response for markdown format");
  }
  if (!content.includes("Appended content.")) {
    throw new Error(`Appended content not found. Got: ${content.slice(0, 300)}`);
  }
}

async function step6Search(client: ObsidianClient): Promise<void> {
  const results = await client.simpleSearch("smoke test");
  const found = results.some((r) => r.filename.includes("_smoke_test"));
  if (!found) {
    const filenames = results.map((r) => r.filename).join(", ");
    throw new Error(`_smoke_test.md not found in search results. Got: [${filenames}]`);
  }
}

async function step7Delete(client: ObsidianClient): Promise<void> {
  await client.deleteFile(TEST_FILE);
  // Verify it's gone — expect a 404
  try {
    await client.getFileContents(TEST_FILE, "markdown");
    throw new Error("File still exists after delete — expected 404");
  } catch (err: unknown) {
    if (err instanceof ObsidianApiError && err.statusCode === 404) {
      // Expected — file is deleted
      return;
    }
    throw err;
  }
}

const CACHE_SEED_FILE = "_smoke_cache_seed.md";

async function step8CacheCheck(client: ObsidianClient, cacheTtl: number): Promise<void> {
  // Seed a note to guarantee the cache has at least one entry, even on an empty vault
  await client.putContent(CACHE_SEED_FILE, "# Cache Seed\n\nEnsures cache is non-empty for testing.\n");
  const cache = new VaultCache(client, cacheTtl);
  client.setCache(cache);
  await cache.initialize();
  if (cache.noteCount <= 0) {
    throw new Error(`Expected noteCount > 0, got ${String(cache.noteCount)}`);
  }
  write(`    (${String(cache.noteCount)} notes, ${String(cache.linkCount)} links cached)`);
  cache.stopAutoRefresh();
  // Clean up seed file
  try { await client.deleteFile(CACHE_SEED_FILE); } catch { /* ignore */ }
}

async function step9BacklinksTest(client: ObsidianClient, cacheTtl: number): Promise<void> {
  // Create two linked notes
  await client.putContent(LINK_FILE_A, LINK_CONTENT_A);
  await client.putContent(LINK_FILE_B, LINK_CONTENT_B);

  // Build a fresh cache that includes the new files
  const cache = new VaultCache(client, cacheTtl);
  client.setCache(cache);
  await cache.initialize();

  // Check backlinks from B — A should link to B
  const backlinks = cache.getBacklinks(LINK_FILE_B);
  const hasBacklink = backlinks.some((bl) => bl.source === LINK_FILE_A);
  if (!hasBacklink) {
    const sources = backlinks.map((bl) => bl.source).join(", ");
    // Clean up before throwing
    cache.stopAutoRefresh();
    await cleanupLinkFiles(client);
    throw new Error(`Expected backlink from ${LINK_FILE_A}, got sources: [${sources}]`);
  }

  cache.stopAutoRefresh();
  // Clean up
  await cleanupLinkFiles(client);
}

async function cleanupLinkFiles(client: ObsidianClient): Promise<void> {
  try { await client.deleteFile(LINK_FILE_A); } catch { /* ignore */ }
  try { await client.deleteFile(LINK_FILE_B); } catch { /* ignore */ }
}

// --- Cleanup ---

async function cleanup(client: ObsidianClient): Promise<void> {
  // Best-effort removal of all test artifacts
  const testFiles = [TEST_FILE, LINK_FILE_A, LINK_FILE_B, CACHE_SEED_FILE];
  for (const file of testFiles) {
    try {
      await client.deleteFile(file);
    } catch {
      // Ignore — file may already be deleted
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  write("");
  write("=== mcp-obsidian-extended smoke tests ===");
  write("");

  // Load .env before loadConfig so API key is available
  loadDotenv();

  const config = loadConfig();

  if (!config.apiKey) {
    write("[error] OBSIDIAN_API_KEY is not set. Set it in .env or as an environment variable.");
    process.exit(1);
  }

  const client = new ObsidianClient(config);

  // Safety guard: refuse to run on vaults that look like real user vaults
  try {
    await guardTestVault(client);
  } catch (err: unknown) {
    write(`[error] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  interface Step {
    readonly num: number;
    readonly name: string;
    readonly fn: () => Promise<void> | void;
  }

  const steps: readonly Step[] = [
    { num: 1, name: "Status check", fn: () => step1StatusCheck(client) },
    { num: 2, name: "List vault files", fn: () => step2ListVaultFiles(client) },
    { num: 3, name: "Put test file", fn: () => step3PutTestFile(client) },
    { num: 4, name: "Read it back", fn: () => step4ReadBack(client) },
    { num: 5, name: "Append and verify", fn: () => step5AppendAndVerify(client) },
    { num: 6, name: "Search", fn: () => step6Search(client) },
    { num: 7, name: "Delete and verify 404", fn: () => step7Delete(client) },
    { num: 8, name: "Cache check", fn: () => step8CacheCheck(client, config.cacheTtl) },
    { num: 9, name: "Backlinks test", fn: () => step9BacklinksTest(client, config.cacheTtl) },
  ];

  try {
    for (const step of steps) {
      try {
        await step.fn();
        pass(step.num, step.name);
        passed++;
      } catch (err: unknown) {
        fail(step.num, step.name, err);
        failed++;
        // Stop on first failure — later steps depend on earlier ones
        break;
      }
    }
  } finally {
    // Always clean up test artifacts
    write("");
    write("  Cleaning up test files...");
    await cleanup(client);
  }

  write("");
  write(`Results: ${String(passed)} passed, ${String(failed)} failed out of ${String(steps.length)} steps`);
  write("");
  // Informational note — not counted as a test step
  write("  Note: To verify tool counts, run with TOOL_MODE=granular (38 tools) or TOOL_MODE=consolidated (11 tools).");
  write("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  write(`[fatal] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
