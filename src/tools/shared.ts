import type { NoteJson, DocumentMap, ToolResult, ObsidianClient } from "../obsidian.js";
import { textResult, errorResult, jsonResult } from "../obsidian.js";
import type { VaultCache } from "../cache.js";
import type { Config } from "../config.js";
import { getRedactedConfig, saveConfigToFile, setDebugEnabled, log } from "../config.js";

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
 * @returns The parsed number, or undefined if invalid.
 */
function parsePosIntValue(value: string, min: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return undefined;
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
  const configPath = config.configFilePath ?? "./obsidian-mcp.config.json";
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
  const configPath = config.configFilePath ?? "./obsidian-mcp.config.json";
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
  for (const path of cache.getFileList()) {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash !== -1) {
      dirs.add(path.slice(0, lastSlash));
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

// --- Batch file fetch (path-preserving) ---

/** Result entry for a single file in a batch fetch operation. */
interface BatchFileResult {
  readonly path: string;
  readonly content?: unknown;
  readonly error?: string;
}

/**
 * Fetches multiple vault files in parallel, preserving the file path even on rejection.
 * Each promise wraps its own error so allSettled never loses the `fp` variable.
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
  const results = await Promise.allSettled(
    filePaths.map(async (fp): Promise<BatchFileResult> => {
      try {
        const content = await client.getFileContents(fp, format);
        return { path: fp, content };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { path: fp, error: reason };
      }
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<BatchFileResult> => r.status === "fulfilled")
    .map((r) => r.value);
}
