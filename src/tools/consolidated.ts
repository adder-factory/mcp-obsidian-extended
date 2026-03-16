import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ObsidianClient, ToolResult, PatchOptions } from "../obsidian.js";
import { textResult, errorResult, jsonResult } from "../obsidian.js";
import type { VaultCache } from "../cache.js";
import { CACHE_INIT_TIMEOUT_MS } from "../cache.js";
import type { Config } from "../config.js";
import { buildErrorMessage } from "../errors.js";
import {
  formatSchema,
  periodSchema,
  patchOperationSchema,
  patchTargetTypeSchema,
  patchContentTypeSchema,
} from "../schemas.js";
import {
  formatFileContents,
  escapeRegex,
  handleConfigureSet,
  handleConfigureReset,
  handleConfigureShow,
  buildVaultStructure,
  handleRecentChanges,
  handleRecentPeriodicNotes,
  batchGetFiles,
} from "./shared.js";

// --- Preset action restrictions for consolidated mode ---

/** Actions allowed in read-only preset (consolidated mode). */
const READ_ONLY_ACTIONS: Record<string, ReadonlySet<string>> = {
  vault: new Set(["list", "list_dir", "get"]),
  active_file: new Set(["get"]),
  commands: new Set(["list"]),
  periodic_note: new Set(["get"]),
  // recent and search are inherently read-only — no action restrictions needed
  vault_analysis: new Set(["backlinks", "connections", "structure", "refresh"]),
};

/** Actions removed in safe preset (consolidated mode). */
const SAFE_BLOCKED_ACTIONS: Record<string, ReadonlySet<string>> = {
  vault: new Set(["delete"]),
  active_file: new Set(["delete"]),
  periodic_note: new Set(["delete"]),
};

// --- Helpers ---

/** Checks if an action is allowed under the active preset for a given tool. */
function isActionAllowed(toolName: string, action: string, preset: string): boolean {
  if (preset === "read-only") {
    const allowed = READ_ONLY_ACTIONS[toolName];
    return allowed === undefined || allowed.has(action);
  }
  if (preset === "safe") {
    const blocked = SAFE_BLOCKED_ACTIONS[toolName];
    return !blocked?.has(action);
  }
  return true;
}

// --- Vault action args type ---

/** Inferred args shape for the vault consolidated tool. */
interface VaultArgs {
  readonly action: "list" | "list_dir" | "get" | "put" | "append" | "patch" | "delete" | "search_replace";
  readonly path?: string | undefined;
  readonly content?: string | undefined;
  readonly format?: "markdown" | "json" | "map" | undefined;
  readonly operation?: PatchOptions["operation"] | undefined;
  readonly targetType?: PatchOptions["targetType"] | undefined;
  readonly target?: string | undefined;
  readonly targetDelimiter?: string | undefined;
  readonly trimTargetWhitespace?: boolean | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly contentType?: PatchOptions["contentType"];
  readonly search?: string | undefined;
  readonly replace?: string | undefined;
  readonly useRegex: boolean;
  readonly caseSensitive: boolean;
  readonly replaceAll: boolean;
}

/** Validates that path is present, returning an error result if missing. */
function requirePath(action: string, path: string | undefined): ToolResult | undefined {
  if (!path) return errorResult(`[vault] path is required for ${action}`);
  return undefined;
}

/** Dispatches a vault action to the appropriate client method. */
async function handleVaultAction(
  client: ObsidianClient,
  action: VaultArgs["action"],
  path: string | undefined,
  args: VaultArgs,
): Promise<ToolResult> {
  if (action === "list") return jsonResult(await client.listFilesInVault());
  const pathErr = requirePath(action, path);
  if (pathErr) return pathErr;
  // After requirePath, path is guaranteed non-empty
  const safePath = path!;
  switch (action) {
    case "list_dir":
      return jsonResult(await client.listFilesInDir(safePath));
    case "get":
      return formatFileContents(await client.getFileContents(safePath, args.format));
    case "put":
      if (args.content === undefined) return errorResult("[vault] content is required for put");
      await client.putContent(safePath, args.content);
      return textResult(`Written: ${safePath}`);
    case "append":
      if (args.content === undefined) return errorResult("[vault] content is required for append");
      await client.appendContent(safePath, args.content);
      return textResult(`Appended to: ${safePath}`);
    case "patch":
      return handleVaultPatch(client, safePath, args);
    case "delete":
      await client.deleteFile(safePath);
      return textResult(`Deleted: ${safePath}`);
    case "search_replace":
      return handleVaultSearchReplace(client, safePath, args.search, args.replace, args.caseSensitive, args.replaceAll, args.useRegex);
    default: {
      const _exhaustive: never = action;
      return errorResult(`[vault] Unknown action: ${String(_exhaustive)}`);
    }
  }
}

// --- Extracted vault action handlers ---

/** Args for the vault "patch" action. */
interface VaultPatchArgs {
  readonly content?: string | undefined;
  readonly operation?: PatchOptions["operation"] | undefined;
  readonly targetType?: PatchOptions["targetType"] | undefined;
  readonly target?: string | undefined;
  readonly targetDelimiter?: string | undefined;
  readonly trimTargetWhitespace?: boolean | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly contentType?: PatchOptions["contentType"];
}

/** Handles the vault "patch" action. */
async function handleVaultPatch(client: ObsidianClient, path: string, args: VaultPatchArgs): Promise<ToolResult> {
  if (args.content === undefined) return errorResult("[vault] content is required for patch");
  if (!args.operation) return errorResult("[vault] operation is required for patch");
  if (!args.targetType) return errorResult("[vault] targetType is required for patch");
  if (!args.target) return errorResult("[vault] target is required for patch");
  await client.patchContent(path, args.content, {
    operation: args.operation,
    targetType: args.targetType,
    target: args.target,
    targetDelimiter: args.targetDelimiter,
    trimTargetWhitespace: args.trimTargetWhitespace,
    createIfMissing: args.createIfMissing,
    contentType: args.contentType,
  });
  return textResult(`Patched: ${path}`);
}

/** Handles the vault "search_replace" action. */
async function handleVaultSearchReplace(
  client: ObsidianClient,
  path: string,
  search: string | undefined,
  replaceText: string | undefined,
  caseSensitive: boolean,
  replaceAll: boolean,
  useRegex: boolean,
): Promise<ToolResult> {
  if (!search) return errorResult("[vault] search is required for search_replace");
  if (replaceText === undefined) return errorResult("[vault] replace is required for search_replace");
  const result = await client.getFileContents(path, "markdown", true);
  if (typeof result !== "string") {
    return errorResult("[vault] Expected markdown content");
  }
  const flags = `${caseSensitive ? "" : "i"}${replaceAll ? "g" : ""}`;
  let pattern: RegExp;
  if (useRegex) {
    try { pattern = new RegExp(search, flags); } catch { return errorResult(`[vault] Invalid regex: "${search}"`); }
  } else {
    pattern = new RegExp(escapeRegex(search), flags);
  }
  const updated = useRegex ? result.replace(pattern, replaceText) : result.replace(pattern, () => replaceText);
  if (updated === result) {
    return textResult(`No matches found for "${search}" in ${path}`);
  }
  await client.putContent(path, updated);
  return textResult(`Replaced in: ${path}`);
}

// --- Extracted periodic_note action handlers ---

/** Args for the periodic_note "patch" action. */
interface PeriodicPatchArgs {
  readonly period: string;
  readonly isByDate: boolean;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly content: string | undefined;
  readonly operation: "append" | "prepend" | "replace" | undefined;
  readonly targetType: "heading" | "block" | "frontmatter" | undefined;
  readonly target: string | undefined;
  readonly targetDelimiter: string | undefined;
  readonly trimTargetWhitespace: boolean | undefined;
  readonly createIfMissing: boolean | undefined;
  readonly contentType: "markdown" | "json" | undefined;
}

/** Handles periodic_note "patch" action. */
async function handlePeriodicPatch(client: ObsidianClient, args: PeriodicPatchArgs): Promise<ToolResult> {
  if (args.content === undefined) return errorResult("[periodic_note] content is required for patch");
  if (!args.operation) return errorResult("[periodic_note] operation is required for patch");
  if (!args.targetType) return errorResult("[periodic_note] targetType is required for patch");
  if (!args.target) return errorResult("[periodic_note] target is required for patch");
  const patchOpts = {
    operation: args.operation, targetType: args.targetType, target: args.target,
    targetDelimiter: args.targetDelimiter, trimTargetWhitespace: args.trimTargetWhitespace,
    createIfMissing: args.createIfMissing, contentType: args.contentType,
  };
  if (args.isByDate) {
    await client.patchPeriodicNoteForDate(args.period, args.year, args.month, args.day, args.content, patchOpts);
  } else {
    await client.patchPeriodicNote(args.period, args.content, patchOpts);
  }
  return textResult(`Patched ${args.period} note`);
}

// --- Extracted periodic_note handler ---

/** Periodic note args shape. */
interface PeriodicNoteArgs {
  readonly action: "get" | "put" | "append" | "patch" | "delete";
  readonly period: string;
  readonly year?: number | undefined;
  readonly month?: number | undefined;
  readonly day?: number | undefined;
  readonly content?: string | undefined;
  readonly format?: "markdown" | "json" | "map" | undefined;
  readonly operation?: "append" | "prepend" | "replace" | undefined;
  readonly targetType?: "heading" | "block" | "frontmatter" | undefined;
  readonly target?: string | undefined;
  readonly targetDelimiter?: string | undefined;
  readonly trimTargetWhitespace?: boolean | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly contentType?: "markdown" | "json" | undefined;
}

/** Dispatches a periodic_note action to the appropriate client method. */
async function handlePeriodicNoteAction(client: ObsidianClient, args: PeriodicNoteArgs): Promise<ToolResult> {
  const { action, period, year, month, day } = args;
  const hasYear = year !== undefined;
  const hasMonth = month !== undefined;
  const hasDay = day !== undefined;
  const dateFieldCount = [hasYear, hasMonth, hasDay].filter(Boolean).length;
  if (dateFieldCount > 0 && dateFieldCount < 3) {
    return errorResult("[periodic_note] All of year, month, and day are required for date-scoped operations (or omit all for current period)");
  }
  const isByDate = dateFieldCount === 3;
  // When isByDate is true all three date fields are defined (validated above).
  // Extract concrete numbers for passing to by-date client methods.
  const y = year ?? 0;
  const m = month ?? 0;
  const d = day ?? 0;
  switch (action) {
    case "get":
      return isByDate
        ? formatFileContents(await client.getPeriodicNoteForDate(period, y, m, d, args.format))
        : formatFileContents(await client.getPeriodicNote(period, args.format));
    case "put":
      if (args.content === undefined) return errorResult("[periodic_note] content is required for put");
      await (isByDate ? client.putPeriodicNoteForDate(period, y, m, d, args.content) : client.putPeriodicNote(period, args.content));
      return textResult(`Updated ${period} note`);
    case "append":
      if (args.content === undefined) return errorResult("[periodic_note] content is required for append");
      await (isByDate ? client.appendPeriodicNoteForDate(period, y, m, d, args.content) : client.appendPeriodicNote(period, args.content));
      return textResult(`Appended to ${period} note`);
    case "patch":
      return handlePeriodicPatch(client, {
        period, isByDate, year: y, month: m, day: d,
        content: args.content, operation: args.operation, targetType: args.targetType,
        target: args.target, targetDelimiter: args.targetDelimiter, trimTargetWhitespace: args.trimTargetWhitespace,
        createIfMissing: args.createIfMissing, contentType: args.contentType,
      });
    case "delete":
      await (isByDate ? client.deletePeriodicNoteForDate(period, y, m, d) : client.deletePeriodicNote(period));
      return textResult(`Deleted ${period} note`);
    default: {
      const _exhaustive: never = action;
      return errorResult(`[periodic_note] Unknown action: ${String(_exhaustive)}`);
    }
  }
}

// --- Extracted vault_analysis handler ---

/** Ensures the cache is initialized, waiting up to 5s if a build is in progress. */
async function ensureCacheReady(cache: VaultCache): Promise<ToolResult | undefined> {
  if (!cache.getIsInitialized() && !(await cache.waitForInitialization(CACHE_INIT_TIMEOUT_MS))) {
    return errorResult("[vault_analysis] Cache is still building. Try again shortly.");
  }
  return undefined;
}

/** Dispatches a vault_analysis action to the appropriate cache query. */
async function handleVaultAnalysisAction(
  cache: VaultCache,
  config: Config,
  action: "backlinks" | "connections" | "structure" | "refresh",
  path: string | undefined,
  limit: number,
): Promise<ToolResult> {
  if (!config.enableCache) {
    return errorResult("[vault_analysis] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
  }
  switch (action) {
    case "backlinks": {
      if (!path) return errorResult("[vault_analysis] path is required for backlinks");
      const notReady = await ensureCacheReady(cache);
      if (notReady) return notReady;
      return jsonResult(cache.getBacklinks(path));
    }
    case "connections": {
      if (!path) return errorResult("[vault_analysis] path is required for connections");
      const notReady = await ensureCacheReady(cache);
      if (notReady) return notReady;
      return jsonResult({ backlinks: cache.getBacklinks(path), forwardLinks: cache.getForwardLinks(path) });
    }
    case "structure": {
      const notReady = await ensureCacheReady(cache);
      if (notReady) return notReady;
      return buildVaultStructure(cache, limit);
    }
    case "refresh":
      await cache.refresh();
      if (!cache.getIsInitialized()) return errorResult("[vault_analysis] Cache refresh failed — Obsidian may be unreachable");
      return textResult(`Cache refreshed: ${String(cache.noteCount)} notes, ${String(cache.linkCount)} links`);
    default: {
      const _exhaustive: never = action;
      return errorResult(`[vault_analysis] Unknown action: ${String(_exhaustive)}`);
    }
  }
}

// --- Registration ---

/** Registers all 11 consolidated tools, filtered by the shouldRegister predicate. */
export function registerConsolidatedTools(
  server: McpServer,
  client: ObsidianClient,
  cache: VaultCache,
  shouldRegister: (name: string) => boolean,
  config: Config,
): number {
  let count = 0;

  // --- 1. vault ---
  if (shouldRegister("vault")) {
    server.registerTool(
      "vault",
      {
        description: "Read, write, search vault files. Do not retry append/patch/search_replace on timeout",
        inputSchema: z.object({
          action: z.enum(["list", "list_dir", "get", "put", "append", "patch", "delete", "search_replace"]).describe("Operation"),
          path: z.string().optional().describe("File or directory path"),
          content: z.string().optional().describe("Content for writes"),
          format: formatSchema.optional(),
          operation: patchOperationSchema.optional(),
          targetType: patchTargetTypeSchema.optional(),
          target: z.string().optional().describe("Patch target"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim whitespace"),
          createIfMissing: z.boolean().optional().describe("Create if missing"),
          contentType: patchContentTypeSchema.optional(),
          search: z.string().optional().describe("Search text"),
          replace: z.string().optional().describe("Replace text"),
          useRegex: z.boolean().default(false).describe("Regex matching"),
          caseSensitive: z.boolean().default(true).describe("Case sensitive"),
          replaceAll: z.boolean().default(true).describe("Replace all"),
        }),
      },
      async (args) => {
        const { action, path } = args;
        if (!isActionAllowed("vault", action, config.toolPreset)) {
          return errorResult(`[vault] Action "${action}" is not allowed in "${config.toolPreset}" preset`);
        }
        try {
          return await handleVaultAction(client, action, path, args);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "vault", path }));
        }
      },
    );
    count++;
  }

  // --- 2. active_file ---
  if (shouldRegister("active_file")) {
    server.registerTool(
      "active_file",
      {
        description: "Read, write, or delete the open file. Do not retry append/patch on timeout",
        inputSchema: z.object({
          action: z.enum(["get", "put", "append", "patch", "delete"]).describe("Operation"),
          content: z.string().optional().describe("Content for writes"),
          format: formatSchema.optional(),
          operation: patchOperationSchema.optional(),
          targetType: patchTargetTypeSchema.optional(),
          target: z.string().optional().describe("Patch target"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim whitespace"),
          contentType: patchContentTypeSchema.optional(),
        }),
      },
      async (args) => {
        const { action } = args;
        if (!isActionAllowed("active_file", action, config.toolPreset)) {
          return errorResult(`[active_file] Action "${action}" is not allowed in "${config.toolPreset}" preset`);
        }
        try {
          switch (action) {
            case "get":
              return formatFileContents(await client.getActiveFile(args.format));
            case "put":
              if (args.content === undefined) return errorResult("[active_file] content is required for put");
              await client.putActiveFile(args.content);
              return textResult("Active file updated");
            case "append":
              if (args.content === undefined) return errorResult("[active_file] content is required for append");
              await client.appendActiveFile(args.content);
              return textResult("Appended to active file");
            case "patch": {
              if (args.content === undefined) return errorResult("[active_file] content is required for patch");
              if (!args.operation) return errorResult("[active_file] operation is required for patch");
              if (!args.targetType) return errorResult("[active_file] targetType is required for patch");
              if (!args.target) return errorResult("[active_file] target is required for patch");
              await client.patchActiveFile(args.content, {
                operation: args.operation,
                targetType: args.targetType,
                target: args.target,
                targetDelimiter: args.targetDelimiter,
                trimTargetWhitespace: args.trimTargetWhitespace,
                contentType: args.contentType,
              });
              return textResult("Active file patched");
            }
            case "delete":
              await client.deleteActiveFile();
              return textResult("Active file deleted");
            default: {
              const _exhaustive: never = action;
              return errorResult(`[active_file] Unknown action: ${String(_exhaustive)}`);
            }
          }
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "active_file" }));
        }
      },
    );
    count++;
  }

  // --- 3. commands ---
  if (shouldRegister("commands")) {
    server.registerTool(
      "commands",
      {
        description: "List or execute Obsidian commands",
        inputSchema: z.object({
          action: z.enum(["list", "execute"]).describe("Operation"),
          commandId: z.string().optional().describe("Command ID for execute"),
        }),
      },
      async ({ action, commandId }) => {
        if (!isActionAllowed("commands", action, config.toolPreset)) {
          return errorResult(`[commands] Action "${action}" is not allowed in "${config.toolPreset}" preset`);
        }
        try {
          switch (action) {
            case "list":
              return jsonResult(await client.listCommands());
            case "execute":
              if (!commandId) return errorResult("[commands] commandId is required for execute");
              await client.executeCommand(commandId);
              return textResult(`Executed: ${commandId}`);
            default: {
              const _exhaustive: never = action;
              return errorResult(`[commands] Unknown action: ${String(_exhaustive)}`);
            }
          }
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "commands" }));
        }
      },
    );
    count++;
  }

  // --- 4. open_file ---
  if (shouldRegister("open_file")) {
    server.registerTool(
      "open_file",
      {
        description: "Open a file in the Obsidian UI",
        inputSchema: z.object({
          path: z.string().describe("File path"),
          newLeaf: z.boolean().default(false).describe("Open in new tab"),
        }),
      },
      async ({ path, newLeaf }) => {
        try {
          await client.openFile(path, newLeaf);
          return textResult(`Opened: ${path}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "open_file", path }));
        }
      },
    );
    count++;
  }

  // --- 5. search ---
  if (shouldRegister("search")) {
    server.registerTool(
      "search",
      {
        description: "Search vault with text, JsonLogic, or Dataview TABLE",
        inputSchema: z.object({
          type: z.enum(["simple", "jsonlogic", "dataview"]).describe("Search type"),
          query: z.string().optional().describe("Query for simple/dataview"),
          jsonQuery: z.record(z.unknown()).optional().describe("JsonLogic object"),
          contextLength: z.number().default(100).describe("Context chars"),
        }),
      },
      async ({ type, query, jsonQuery, contextLength }) => {
        try {
          switch (type) {
            case "simple":
              if (!query) return errorResult("[search] query is required for simple search");
              return jsonResult(await client.simpleSearch(query, contextLength));
            case "jsonlogic":
              if (!jsonQuery) return errorResult("[search] jsonQuery is required for jsonlogic search");
              return jsonResult(await client.complexSearch(jsonQuery));
            case "dataview":
              if (!query) return errorResult("[search] query is required for dataview search");
              return jsonResult(await client.dataviewSearch(query));
            default: {
              const _exhaustive: never = type;
              return errorResult(`[search] Unknown type: ${String(_exhaustive)}`);
            }
          }
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "search" }));
        }
      },
    );
    count++;
  }

  // --- 6. periodic_note ---
  if (shouldRegister("periodic_note")) {
    server.registerTool(
      "periodic_note",
      {
        description: "CRUD on periodic notes. Do not retry append/patch on timeout",
        inputSchema: z.object({
          action: z.enum(["get", "put", "append", "patch", "delete"]).describe("Operation"),
          period: periodSchema,
          year: z.number().int().optional().describe("Year (omit for current)"),
          month: z.number().int().min(1).max(12).optional().describe("Month (1-12)"),
          day: z.number().int().min(1).max(31).optional().describe("Day (1-31)"),
          content: z.string().optional().describe("Content for writes"),
          format: formatSchema.optional(),
          operation: patchOperationSchema.optional(),
          targetType: patchTargetTypeSchema.optional(),
          target: z.string().optional().describe("Patch target"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim whitespace"),
          createIfMissing: z.boolean().optional().describe("Create if missing"),
          contentType: patchContentTypeSchema.optional(),
        }),
      },
      async (args) => {
        if (!isActionAllowed("periodic_note", args.action, config.toolPreset)) {
          return errorResult(`[periodic_note] Action "${args.action}" is not allowed in "${config.toolPreset}" preset`);
        }
        try {
          return await handlePeriodicNoteAction(client, args);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "periodic_note" }));
        }
      },
    );
    count++;
  }

  // --- 7. status (PROTECTED) ---
  if (shouldRegister("status")) {
    server.registerTool(
      "status",
      {
        description: "Check Obsidian API connection and version",
      },
      async () => {
        try {
          return jsonResult(await client.getServerStatus());
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "status" }));
        }
      },
    );
    count++;
  }

  // --- 8. batch_get ---
  if (shouldRegister("batch_get")) {
    server.registerTool(
      "batch_get",
      {
        description: "Read multiple vault files in one call",
        inputSchema: z.object({
          paths: z.array(z.string()).min(1).describe("File paths"),
          format: formatSchema.optional(),
        }),
      },
      async ({ paths, format }) => {
        try {
          return jsonResult(await batchGetFiles(client, paths, format));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "batch_get" }));
        }
      },
    );
    count++;
  }

  // --- 9. recent ---
  if (shouldRegister("recent")) {
    server.registerTool(
      "recent",
      {
        description: "Get recently modified files or periodic notes",
        inputSchema: z.object({
          type: z.enum(["changes", "periodic_notes"]).describe("Query type"),
          period: periodSchema.optional(),
          limit: z.number().int().min(1).default(10).describe("Max results"),
        }),
      },
      async ({ type, period, limit }) => {
        try {
          switch (type) {
            case "changes":
              return await handleRecentChanges(client, cache, config, limit);
            case "periodic_notes":
              if (!period) return errorResult("[recent] period is required for periodic_notes");
              return await handleRecentPeriodicNotes(client, period, limit);
            default: {
              const _exhaustive: never = type;
              return errorResult(`[recent] Unknown type: ${String(_exhaustive)}`);
            }
          }
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "recent" }));
        }
      },
    );
    count++;
  }

  // --- 10. configure (PROTECTED) ---
  if (shouldRegister("configure")) {
    server.registerTool(
      "configure",
      {
        description: "View or change server settings",
        inputSchema: z.object({
          action: z.enum(["show", "set", "reset"]).describe("Action"),
          setting: z.string().optional().describe("Setting name"),
          value: z.string().optional().describe("New value"),
        }),
      },
      async ({ action, setting, value }) => {
        try {
          switch (action) {
            case "show":
              return handleConfigureShow(config);
            case "set":
              return handleConfigureSet(setting, value, config);
            case "reset":
              return handleConfigureReset(setting, config);
            default: {
              const _exhaustive: never = action;
              return errorResult(`[configure] Unknown action: ${String(_exhaustive)}`);
            }
          }
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "configure" }));
        }
      },
    );
    count++;
  }

  // --- 11. vault_analysis ---
  if (shouldRegister("vault_analysis")) {
    server.registerTool(
      "vault_analysis",
      {
        description: "Backlinks, connections, structure, and cache refresh",
        inputSchema: z.object({
          action: z.enum(["backlinks", "connections", "structure", "refresh"]).describe("Analysis type"),
          path: z.string().optional().describe("File path for backlinks/connections"),
          limit: z.number().int().min(1).default(10).describe("Top N for structure"),
        }),
      },
      async ({ action, path, limit }) => {
        if (!isActionAllowed("vault_analysis", action, config.toolPreset)) {
          return errorResult(`[vault_analysis] Action "${action}" is not allowed in "${config.toolPreset}" preset`);
        }
        try {
          return await handleVaultAnalysisAction(cache, config, action, path, limit);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "vault_analysis", path }));
        }
      },
    );
    count++;
  }

  return count;
}

