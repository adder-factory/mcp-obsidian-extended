import { resolve } from "node:path";

import type { NoteJson, DocumentMap, ToolResult, ObsidianClient } from "../obsidian.js";
import { textResult, errorResult, jsonResult } from "../obsidian.js";
import type { VaultCache } from "../cache.js";
import type { Config } from "../config.js";
import { getRedactedConfig, saveConfigToFile, setDebugEnabled, log } from "../config.js";

// --- Cache readiness ---

/** Minimal interface for cache readiness checks — decoupled from concrete VaultCache. */
interface CacheReadyCheckable {
  getIsInitialized(): boolean;
  waitForInitialization(timeoutMs: number): Promise<boolean>;
}

/** Options for the ensureCacheReady helper. */
interface EnsureCacheReadyOptions {
  readonly cache: CacheReadyCheckable;
  readonly tool: string;
  readonly enableCache: boolean;
}

/** Maximum time (ms) graph tools will wait for a cache build to complete. TODO: make configurable via env var in v2. */
const CACHE_INIT_TIMEOUT_MS = 5000;

/**
 * Ensures the cache is initialized before running a graph query.
 * Returns an error ToolResult if the cache is disabled or not yet available,
 * or undefined if the cache is ready.
 * @param options - Cache instance, tool name, and enableCache flag.
 * @returns An error result if cache is unavailable, undefined if ready.
 */
export async function ensureCacheReady(
  { cache, tool, enableCache }: EnsureCacheReadyOptions,
): Promise<ToolResult | undefined> {
  if (!enableCache) return errorResult(`[${tool}] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true`);
  if (cache.getIsInitialized()) return undefined;
  if (await cache.waitForInitialization(CACHE_INIT_TIMEOUT_MS)) return undefined;
  return errorResult(`[${tool}] Cache not available. Try again shortly or use refresh_cache to rebuild.`);
}

// --- File content formatting ---

/**
 * Formats file contents for display, handling markdown, JSON, and map formats.
 * @param result - The raw file content from the API.
 * @returns A text or JSON tool result.
 */
export function formatFileContents(result: string | NoteJson | DocumentMap): ReturnType<typeof textResult> {
  if (typeof result === "string") {
    return textResult(result);
  }
  return jsonResult(result);
}

// --- Regex helpers ---

/**
 * Escapes a string for use as a literal in a RegExp.
 * @param str - The string to escape.
 * @returns Escaped string safe for use in `new RegExp(...)`.
 */
export function escapeRegex(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// --- Config value parsers ---

/**
 * Parses a boolean string value.
 * @param value - The string to parse ("true" or "false").
 * @returns The boolean value, or undefined if invalid.
 */
function parseBoolValue(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Parses a positive integer string value.
 * @param value - The string to parse.
 * @param min - The minimum acceptable value.
 * @returns The parsed number, or undefined if invalid (empty, decimal, non-finite, or below min).
 */
function parsePosIntValue(value: string, min: number): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return undefined;
  return n;
}

// --- Configure helpers ---

/**
 * Builds a config file update object for a given setting and value.
 * @param setting - The setting name to update.
 * @param value - The new string value.
 * @returns A partial config update object, or undefined if the value is invalid.
 */
function buildConfigUpdate(setting: string, value: string): Record<string, unknown> | undefined {
  switch (setting) {
    case "debug": {
      const b = parseBoolValue(value);
      return b === undefined ? undefined : { debug: b };
    }
    case "timeout": {
      const n = parsePosIntValue(value, 1);
      return n === undefined ? undefined : { reliability: { timeout: n } };
    }
    case "verifyWrites": {
      const b = parseBoolValue(value);
      return b === undefined ? undefined : { reliability: { verifyWrites: b } };
    }
    case "maxResponseChars": {
      const n = parsePosIntValue(value, 0);
      return n === undefined ? undefined : { reliability: { maxResponseChars: n } };
    }
    case "toolMode":
      if (value !== "granular" && value !== "consolidated") return undefined;
      return { tools: { mode: value } };
    case "toolPreset":
      if (value !== "full" && value !== "read-only" && value !== "minimal" && value !== "safe") return undefined;
      return { tools: { preset: value } };
    default:
      return undefined;
  }
}

/**
 * Builds a config file update that resets a setting to its default value.
 * @param setting - The setting name to reset.
 * @returns A partial config update object, or undefined for unknown settings.
 */
function buildConfigReset(setting: string): Record<string, unknown> | undefined {
  switch (setting) {
    case "debug":
      return { debug: false };
    case "timeout":
      return { reliability: { timeout: 30000 } };
    case "verifyWrites":
      return { reliability: { verifyWrites: false } };
    case "maxResponseChars":
      return { reliability: { maxResponseChars: 500000 } };
    case "toolMode":
      return { tools: { mode: "granular" } };
    case "toolPreset":
      return { tools: { preset: "full" } };
    default:
      return undefined;
  }
}

/**
 * Applies an immediate-effect setting change to the running process.
 * Only `debug` takes effect without a restart; all other settings require a restart.
 * @param setting - The setting name being changed.
 * @param value - The new string value.
 */
function applyImmediateSetting(setting: string, value: string): void {
  if (setting === "debug") {
    setDebugEnabled(value === "true");
    log("info", `Debug logging ${value === "true" ? "enabled" : "disabled"}`);
  }
}

/**
 * Handles the configure "set" action — validates, saves, and applies the setting.
 * Only `debug` takes effect immediately; all other settings require a restart.
 * @param setting - The setting name to change.
 * @param value - The new value string.
 * @param config - The active config object (for file path lookup).
 * @returns A tool result describing success or the validation error.
 */
export function handleConfigureSet(
  setting: string | undefined,
  value: string | undefined,
  config: Config,
): ToolResult {
  if (!setting) {
    return errorResult("[configure] Setting name is required for 'set' action");
  }
  if (value === undefined) {
    return errorResult("[configure] Value is required for 'set' action");
  }
  const immediateSettings = new Set(["debug"]);
  const restartSettings = new Set(["timeout", "verifyWrites", "maxResponseChars", "toolMode", "toolPreset"]);
  if (!immediateSettings.has(setting) && !restartSettings.has(setting)) {
    return errorResult(`[configure] Unknown setting: ${setting}. Available: ${[...immediateSettings, ...restartSettings].join(", ")}`);
  }
  const configPath = config.configFilePath ?? resolve("obsidian-mcp.config.json");
  const updates = buildConfigUpdate(setting, value);
  if (updates === undefined) {
    return errorResult(`[configure] Invalid value "${value}" for setting "${setting}"`);
  }
  saveConfigToFile(configPath, updates);
  if (immediateSettings.has(setting)) {
    applyImmediateSetting(setting, value);
    return textResult(`Setting "${setting}" updated to "${value}" (effective immediately)`);
  }
  return textResult(`Setting "${setting}" saved to config file. Restart the server for this change to take effect.`);
}

/**
 * Handles the configure "reset" action — resets a setting to its default value.
 * @param setting - The setting name to reset.
 * @param config - The active config object (for file path lookup).
 * @returns A tool result describing success or the validation error.
 */
export function handleConfigureReset(setting: string | undefined, config: Config): ToolResult {
  if (!setting) return errorResult("[configure] Setting name is required for 'reset' action");
  const configPath = config.configFilePath ?? resolve("obsidian-mcp.config.json");
  const resetUpdates = buildConfigReset(setting);
  if (resetUpdates === undefined) {
    return errorResult(`[configure] Unknown setting: ${setting}`);
  }
  saveConfigToFile(configPath, resetUpdates);
  // Apply immediately for settings that take effect without restart
  if (setting === "debug") {
    applyImmediateSetting(setting, "false");
    return textResult(`Setting "${setting}" reset to default (effective immediately)`);
  }
  return textResult(`Setting "${setting}" reset to default in config file. Restart the server for this change to take effect.`);
}

/**
 * Shows the current (redacted) configuration.
 * @param config - The active config object.
 * @returns A JSON tool result with the redacted config.
 */
export function handleConfigureShow(config: Config): ToolResult {
  // Note: config is the startup snapshot. Live runtime changes (e.g. debug toggle)
  // are not reflected here — they take effect on the process but this shows the
  // persisted config. A restart will pick up any file-based changes.
  return jsonResult(getRedactedConfig(config));
}

// --- Vault structure ---

/**
 * Builds vault structure statistics from cache.
 * @param cache - The vault cache instance.
 * @param limit - Maximum number of most-connected notes to include.
 * @returns A JSON tool result with vault stats.
 */
export function buildVaultStructure(cache: VaultCache, limit: number): ToolResult {
  const orphans = cache.getOrphanNotes();
  const mostConnected = cache.getMostConnectedNotes(limit);
  const graph = cache.getVaultGraph();
  const dirs = new Set<string>();
  for (const p of cache.getFileList()) {
    let lastSlash = p.lastIndexOf("/");
    while (lastSlash !== -1) {
      const dir = p.slice(0, lastSlash);
      if (dirs.has(dir)) break; // this dir and all its parents are already tracked
      dirs.add(dir);
      lastSlash = dir.lastIndexOf("/");
    }
  }
  return jsonResult({
    noteCount: cache.noteCount,
    linkCount: cache.linkCount,
    directoryCount: dirs.size,
    orphanCount: orphans.length,
    orphans: orphans.slice(0, 20),
    mostConnected,
    edgeCount: graph.edges.length,
  });
}

// --- Recent changes (batched, cache-aware) ---

/** Batch size for concurrent API calls in the cache-miss fallback path. */
const RECENT_CHANGES_BATCH_SIZE = 20;

/**
 * Fetches recent changes using cache if available, or batched API calls as fallback.
 * Batching is used to avoid unbounded concurrent calls on large vaults.
 * @param client - The Obsidian API client.
 * @param cache - The vault cache instance.
 * @param config - The active config object.
 * @param limit - Maximum number of results to return.
 * @returns A JSON tool result with the most recently modified files.
 */
export async function handleRecentChanges(
  client: ObsidianClient,
  cache: VaultCache,
  config: Config,
  limit: number,
): Promise<ToolResult> {
  if (config.enableCache && cache.getIsInitialized()) {
    const allNotes = cache.getAllNotes();
    const sorted = [...allNotes]
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit)
      .map((n) => ({ path: n.path, mtime: n.stat.mtime }));
    return jsonResult(sorted);
  }
  const { files } = await client.listFilesInVault();
  const mdFiles = files.filter((f) => f.toLowerCase().endsWith(".md"));
  const withStats: Array<{ path: string; mtime: number }> = [];
  for (let i = 0; i < mdFiles.length; i += RECENT_CHANGES_BATCH_SIZE) {
    const batch = mdFiles.slice(i, i + RECENT_CHANGES_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (fp) => {
        const result = await client.getFileContents(fp, "json");
        if (typeof result !== "string" && "stat" in result) {
          return { path: fp, mtime: result.stat.mtime };
        }
        return { path: fp, mtime: 0 };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        withStats.push(r.value);
      }
    }
  }
  withStats.sort((a, b) => b.mtime - a.mtime);
  return jsonResult(withStats.slice(0, limit));
}

/**
 * Fetches recent periodic notes by listing the vault directory.
 * @param client - The Obsidian API client.
 * @param period - The period type (daily, weekly, etc.).
 * @param limit - Maximum number of results to return.
 * @returns A JSON tool result with the most recent periodic note paths.
 */
export async function handleRecentPeriodicNotes(
  client: ObsidianClient,
  period: string,
  limit: number,
): Promise<ToolResult> {
  const { files } = await client.listFilesInVault();
  // Folder names are Obsidian defaults — the REST API does not expose user-configured paths.
  // Users with custom folder names should use get_periodic_note_for_date instead.
  const periodDirs: Record<string, string> = {
    daily: "Daily Notes",
    weekly: "Weekly Notes",
    monthly: "Monthly Notes",
    quarterly: "Quarterly Notes",
    yearly: "Yearly Notes",
  };
  const dirName = periodDirs[period] ?? period;
  const periodFiles = files
    .filter((f) => f.startsWith(`${dirName}/`) && f.toLowerCase().endsWith(".md"))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);
  return jsonResult(periodFiles);
}

// --- Batch file fetch (path-preserving, concurrency-capped) ---

/** Result entry for a single file in a batch fetch operation. */
interface BatchFileResult {
  readonly path: string;
  readonly content?: unknown;
  readonly error?: string;
}

/** Batch size for concurrent API calls in batchGetFiles. */
const BATCH_GET_BATCH_SIZE = 20;

/**
 * Fetches multiple vault files in parallel with a concurrency cap.
 * Each per-file error is caught individually so one failure does not abort the batch.
 * @param client - The Obsidian API client.
 * @param filePaths - The list of file paths to fetch.
 * @param format - The response format (markdown, json, or map).
 * @returns An array of results, each with path and either content or error.
 */
export async function batchGetFiles(
  client: ObsidianClient,
  filePaths: readonly string[],
  format: "markdown" | "json" | "map" | undefined,
): Promise<BatchFileResult[]> {
  const output: BatchFileResult[] = [];
  for (let i = 0; i < filePaths.length; i += BATCH_GET_BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_GET_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (fp): Promise<BatchFileResult> => {
        try {
          const content = await client.getFileContents(fp, format);
          return { path: fp, content };
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          return { path: fp, error: reason };
        }
      }),
    );
    output.push(...results);
  }
  return output;
}
