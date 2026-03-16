import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ObsidianClient } from "../obsidian.js";
import { textResult, errorResult, jsonResult } from "../obsidian.js";
import type { VaultCache } from "../cache.js";
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

// --- Registration sub-functions (split to keep complexity below 15) ---

/** Registers vault file tools (#1-8). */
function registerVaultTools(
  server: McpServer,
  client: ObsidianClient,
  shouldRegister: (name: string) => boolean,
): number {
  let count = 0;

  // --- 1. list_files_in_vault ---
  if (shouldRegister("list_files_in_vault")) {
    server.registerTool(
      "list_files_in_vault",
      { description: "List all files and directories in vault root" },
      async () => {
        try {
          return jsonResult(await client.listFilesInVault());
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "list_files_in_vault" }));
        }
      },
    );
    count++;
  }

  // --- 2. list_files_in_dir ---
  if (shouldRegister("list_files_in_dir")) {
    server.registerTool(
      "list_files_in_dir",
      {
        description: "List files in a vault directory",
        inputSchema: z.object({ dirPath: z.string().describe("Directory path") }),
      },
      async ({ dirPath }) => {
        try {
          return jsonResult(await client.listFilesInDir(dirPath));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "list_files_in_dir", path: dirPath }));
        }
      },
    );
    count++;
  }

  // --- 3. get_file_contents ---
  if (shouldRegister("get_file_contents")) {
    server.registerTool(
      "get_file_contents",
      {
        description: "Read a vault file as markdown, JSON, or document map",
        inputSchema: z.object({
          filePath: z.string().describe("File path"),
          format: formatSchema.optional(),
        }),
      },
      async ({ filePath, format }) => {
        try {
          return formatFileContents(await client.getFileContents(filePath, format));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_file_contents", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 4. put_content ---
  if (shouldRegister("put_content")) {
    server.registerTool(
      "put_content",
      {
        description: "Create or overwrite a vault file (idempotent)",
        inputSchema: z.object({
          filePath: z.string().describe("File path"),
          content: z.string().describe("File content"),
        }),
      },
      async ({ filePath, content }) => {
        try {
          await client.putContent(filePath, content);
          return textResult(`Written: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "put_content", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 5. append_content ---
  if (shouldRegister("append_content")) {
    server.registerTool(
      "append_content",
      {
        description: "Append to a vault file (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          filePath: z.string().describe("File path"),
          content: z.string().describe("Content to append"),
        }),
      },
      async ({ filePath, content }) => {
        try {
          await client.appendContent(filePath, content);
          return textResult(`Appended to: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "append_content", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 6. patch_content ---
  if (shouldRegister("patch_content")) {
    server.registerTool(
      "patch_content",
      {
        description: "Insert at heading/block/frontmatter (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          filePath: z.string().describe("File path"),
          content: z.string().describe("Content to insert"),
          operation: patchOperationSchema,
          targetType: patchTargetTypeSchema,
          target: z.string().describe("Target heading/block/field"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
          createIfMissing: z.boolean().optional().describe("Create target if missing"),
          contentType: patchContentTypeSchema.optional(),
        }),
      },
      async ({ filePath, content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType }) => {
        try {
          await client.patchContent(filePath, content, { operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType });
          return textResult(`Patched: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "patch_content", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 7. delete_file ---
  if (shouldRegister("delete_file")) {
    server.registerTool(
      "delete_file",
      {
        description: "Delete a vault file to Obsidian trash (idempotent)",
        inputSchema: z.object({ filePath: z.string().describe("File path") }),
      },
      async ({ filePath }) => {
        try {
          await client.deleteFile(filePath);
          return textResult(`Deleted: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "delete_file", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 8. search_replace ---
  if (shouldRegister("search_replace")) {
    server.registerTool(
      "search_replace",
      {
        description: "Find and replace in a vault file (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          filePath: z.string().describe("File path"),
          search: z.string().describe("Text to find"),
          replace: z.string().describe("Replacement text"),
          useRegex: z.boolean().default(false).describe("Use regex matching"),
          caseSensitive: z.boolean().default(true).describe("Case-sensitive match"),
          replaceAll: z.boolean().default(true).describe("Replace all occurrences"),
        }),
      },
      async ({ filePath, search, replace, useRegex, caseSensitive, replaceAll }) => {
        try {
          const result = await client.getFileContents(filePath, "markdown", true);
          if (typeof result !== "string") return errorResult("[search_replace] Expected markdown content");
          const flags = `${caseSensitive ? "" : "i"}${replaceAll ? "g" : ""}`;
          let pattern: RegExp;
          if (useRegex) {
            try { pattern = new RegExp(search, flags); } catch { return errorResult(`[search_replace] Invalid regex: "${search}"`); }
          } else {
            pattern = new RegExp(escapeRegex(search), flags);
          }
          const updated = useRegex ? result.replace(pattern, replace) : result.replace(pattern, () => replace);
          if (updated === result) return textResult(`No matches found for "${search}" in ${filePath}`);
          await client.putContent(filePath, updated);
          return textResult(`Replaced in: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "search_replace", path: filePath }));
        }
      },
    );
    count++;
  }

  return count;
}

/** Registers active file tools (#9-13). */
function registerActiveFileTools(
  server: McpServer,
  client: ObsidianClient,
  shouldRegister: (name: string) => boolean,
): number {
  let count = 0;

  // --- 9. get_active_file ---
  if (shouldRegister("get_active_file")) {
    server.registerTool(
      "get_active_file",
      {
        description: "Read the currently open file in Obsidian",
        inputSchema: z.object({ format: formatSchema.optional() }),
      },
      async ({ format }) => {
        try {
          return formatFileContents(await client.getActiveFile(format));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_active_file" }));
        }
      },
    );
    count++;
  }

  // --- 10. put_active_file ---
  if (shouldRegister("put_active_file")) {
    server.registerTool(
      "put_active_file",
      {
        description: "Replace content of the open file (idempotent)",
        inputSchema: z.object({ content: z.string().describe("New file content") }),
      },
      async ({ content }) => {
        try {
          await client.putActiveFile(content);
          return textResult("Active file updated");
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "put_active_file" }));
        }
      },
    );
    count++;
  }

  // --- 11. append_active_file ---
  if (shouldRegister("append_active_file")) {
    server.registerTool(
      "append_active_file",
      {
        description: "Append to the open file (not idempotent, do not retry on timeout)",
        inputSchema: z.object({ content: z.string().describe("Content to append") }),
      },
      async ({ content }) => {
        try {
          await client.appendActiveFile(content);
          return textResult("Appended to active file");
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "append_active_file" }));
        }
      },
    );
    count++;
  }

  // --- 12. patch_active_file ---
  if (shouldRegister("patch_active_file")) {
    server.registerTool(
      "patch_active_file",
      {
        description: "Patch the active file at a target (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          content: z.string().describe("Content to insert"),
          operation: patchOperationSchema,
          targetType: patchTargetTypeSchema,
          target: z.string().describe("Target heading/block/field"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
          contentType: patchContentTypeSchema.optional(),
        }),
      },
      async ({ content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, contentType }) => {
        try {
          await client.patchActiveFile(content, { operation, targetType, target, targetDelimiter, trimTargetWhitespace, contentType });
          return textResult("Active file patched");
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "patch_active_file" }));
        }
      },
    );
    count++;
  }

  // --- 13. delete_active_file ---
  if (shouldRegister("delete_active_file")) {
    server.registerTool(
      "delete_active_file",
      { description: "Delete the currently open file (idempotent)" },
      async () => {
        try {
          await client.deleteActiveFile();
          return textResult("Active file deleted");
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "delete_active_file" }));
        }
      },
    );
    count++;
  }

  return count;
}

/** Registers command, open, and search tools (#14-19). */
function registerCommandAndSearchTools(
  server: McpServer,
  client: ObsidianClient,
  shouldRegister: (name: string) => boolean,
): number {
  let count = 0;

  // --- 14. list_commands ---
  if (shouldRegister("list_commands")) {
    server.registerTool(
      "list_commands",
      { description: "List all Obsidian command palette commands" },
      async () => {
        try {
          return jsonResult(await client.listCommands());
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "list_commands" }));
        }
      },
    );
    count++;
  }

  // --- 15. execute_command ---
  if (shouldRegister("execute_command")) {
    server.registerTool(
      "execute_command",
      {
        description: "Run an Obsidian command by ID",
        inputSchema: z.object({ commandId: z.string().describe("Command ID") }),
      },
      async ({ commandId }) => {
        try {
          await client.executeCommand(commandId);
          return textResult(`Executed: ${commandId}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "execute_command" }));
        }
      },
    );
    count++;
  }

  // --- 16. open_file ---
  if (shouldRegister("open_file")) {
    server.registerTool(
      "open_file",
      {
        description: "Open a file in the Obsidian UI",
        inputSchema: z.object({
          filePath: z.string().describe("File path"),
          newLeaf: z.boolean().default(false).describe("Open in new tab"),
        }),
      },
      async ({ filePath, newLeaf }) => {
        try {
          await client.openFile(filePath, newLeaf);
          return textResult(`Opened: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "open_file", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 17. simple_search ---
  if (shouldRegister("simple_search")) {
    server.registerTool(
      "simple_search",
      {
        description: "Full-text search across all vault files",
        inputSchema: z.object({
          query: z.string().describe("Search query"),
          contextLength: z.number().default(100).describe("Context chars"),
        }),
      },
      async ({ query, contextLength }) => {
        try {
          return jsonResult(await client.simpleSearch(query, contextLength));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "simple_search" }));
        }
      },
    );
    count++;
  }

  // --- 18. complex_search ---
  if (shouldRegister("complex_search")) {
    server.registerTool(
      "complex_search",
      {
        description: "Search vault with JsonLogic queries (glob, regexp)",
        inputSchema: z.object({
          query: z.record(z.unknown()).describe("JsonLogic query object"),
        }),
      },
      async ({ query }) => {
        try {
          return jsonResult(await client.complexSearch(query));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "complex_search" }));
        }
      },
    );
    count++;
  }

  // --- 19. dataview_search ---
  if (shouldRegister("dataview_search")) {
    server.registerTool(
      "dataview_search",
      {
        description: "Query vault with Dataview TABLE queries (LIST not supported)",
        inputSchema: z.object({ dql: z.string().describe("DQL query string") }),
      },
      async ({ dql }) => {
        try {
          return jsonResult(await client.dataviewSearch(dql));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "dataview_search" }));
        }
      },
    );
    count++;
  }

  return count;
}

/** Registers current-period periodic note tools (#20-24). */
function registerPeriodicNoteTools(
  server: McpServer,
  client: ObsidianClient,
  shouldRegister: (name: string) => boolean,
): number {
  let count = 0;

  // --- 20. get_periodic_note ---
  if (shouldRegister("get_periodic_note")) {
    server.registerTool(
      "get_periodic_note",
      {
        description: "Get the current periodic note",
        inputSchema: z.object({ period: periodSchema, format: formatSchema.optional() }),
      },
      async ({ period, format }) => {
        try {
          return formatFileContents(await client.getPeriodicNote(period, format));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_periodic_note" }));
        }
      },
    );
    count++;
  }

  // --- 21. put_periodic_note ---
  if (shouldRegister("put_periodic_note")) {
    server.registerTool(
      "put_periodic_note",
      {
        description: "Replace current periodic note content (idempotent)",
        inputSchema: z.object({ period: periodSchema, content: z.string().describe("Note content") }),
      },
      async ({ period, content }) => {
        try {
          await client.putPeriodicNote(period, content);
          return textResult(`Updated ${period} note`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "put_periodic_note" }));
        }
      },
    );
    count++;
  }

  // --- 22. append_periodic_note ---
  if (shouldRegister("append_periodic_note")) {
    server.registerTool(
      "append_periodic_note",
      {
        description: "Append to current periodic note (not idempotent, do not retry on timeout)",
        inputSchema: z.object({ period: periodSchema, content: z.string().describe("Content to append") }),
      },
      async ({ period, content }) => {
        try {
          await client.appendPeriodicNote(period, content);
          return textResult(`Appended to ${period} note`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "append_periodic_note" }));
        }
      },
    );
    count++;
  }

  // --- 23. patch_periodic_note ---
  if (shouldRegister("patch_periodic_note")) {
    server.registerTool(
      "patch_periodic_note",
      {
        description: "Patch current periodic note at target (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          period: periodSchema,
          content: z.string().describe("Content to insert"),
          operation: patchOperationSchema,
          targetType: patchTargetTypeSchema,
          target: z.string().describe("Target heading/block/field"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
          createIfMissing: z.boolean().optional().describe("Create target if missing"),
          contentType: patchContentTypeSchema.optional(),
        }),
      },
      async ({ period, content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType }) => {
        try {
          await client.patchPeriodicNote(period, content, { operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType });
          return textResult(`Patched ${period} note`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "patch_periodic_note" }));
        }
      },
    );
    count++;
  }

  // --- 24. delete_periodic_note ---
  if (shouldRegister("delete_periodic_note")) {
    server.registerTool(
      "delete_periodic_note",
      {
        description: "Delete current periodic note (idempotent)",
        inputSchema: z.object({ period: periodSchema }),
      },
      async ({ period }) => {
        try {
          await client.deletePeriodicNote(period);
          return textResult(`Deleted ${period} note`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "delete_periodic_note" }));
        }
      },
    );
    count++;
  }

  return count;
}

/** Registers date-scoped periodic note tools (#25-29). */
function registerPeriodicNoteDateTools(
  server: McpServer,
  client: ObsidianClient,
  shouldRegister: (name: string) => boolean,
): number {
  let count = 0;

  // --- 25. get_periodic_note_for_date ---
  if (shouldRegister("get_periodic_note_for_date")) {
    server.registerTool(
      "get_periodic_note_for_date",
      {
        description: "Get periodic note for a specific date",
        inputSchema: z.object({
          period: periodSchema,
          year: z.number().int().describe("Year"),
          month: z.number().int().min(1).max(12).describe("Month (1-12)"),
          day: z.number().int().min(1).max(31).describe("Day (1-31)"),
          format: formatSchema.optional(),
        }),
      },
      async ({ period, year, month, day, format }) => {
        try {
          return formatFileContents(await client.getPeriodicNoteForDate(period, year, month, day, format));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_periodic_note_for_date" }));
        }
      },
    );
    count++;
  }

  // --- 26. put_periodic_note_for_date ---
  if (shouldRegister("put_periodic_note_for_date")) {
    server.registerTool(
      "put_periodic_note_for_date",
      {
        description: "Replace periodic note for a date (idempotent)",
        inputSchema: z.object({
          period: periodSchema,
          year: z.number().int().describe("Year"),
          month: z.number().int().min(1).max(12).describe("Month (1-12)"),
          day: z.number().int().min(1).max(31).describe("Day (1-31)"),
          content: z.string().describe("Note content"),
        }),
      },
      async ({ period, year, month, day, content }) => {
        try {
          await client.putPeriodicNoteForDate(period, year, month, day, content);
          return textResult(`Updated ${period} note for ${String(year)}-${String(month)}-${String(day)}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "put_periodic_note_for_date" }));
        }
      },
    );
    count++;
  }

  // --- 27. append_periodic_note_for_date ---
  if (shouldRegister("append_periodic_note_for_date")) {
    server.registerTool(
      "append_periodic_note_for_date",
      {
        description: "Append to periodic note for a date (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          period: periodSchema,
          year: z.number().int().describe("Year"),
          month: z.number().int().min(1).max(12).describe("Month (1-12)"),
          day: z.number().int().min(1).max(31).describe("Day (1-31)"),
          content: z.string().describe("Content to append"),
        }),
      },
      async ({ period, year, month, day, content }) => {
        try {
          await client.appendPeriodicNoteForDate(period, year, month, day, content);
          return textResult(`Appended to ${period} note for ${String(year)}-${String(month)}-${String(day)}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "append_periodic_note_for_date" }));
        }
      },
    );
    count++;
  }

  // --- 28. patch_periodic_note_for_date ---
  if (shouldRegister("patch_periodic_note_for_date")) {
    server.registerTool(
      "patch_periodic_note_for_date",
      {
        description: "Patch periodic note for a date (not idempotent, do not retry on timeout)",
        inputSchema: z.object({
          period: periodSchema,
          year: z.number().int().describe("Year"),
          month: z.number().int().min(1).max(12).describe("Month (1-12)"),
          day: z.number().int().min(1).max(31).describe("Day (1-31)"),
          content: z.string().describe("Content to insert"),
          operation: patchOperationSchema,
          targetType: patchTargetTypeSchema,
          target: z.string().describe("Target heading/block/field"),
          targetDelimiter: z.string().optional().describe("Heading delimiter"),
          trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
          createIfMissing: z.boolean().optional().describe("Create target if missing"),
          contentType: patchContentTypeSchema.optional(),
        }),
      },
      async ({ period, year, month, day, content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType }) => {
        try {
          await client.patchPeriodicNoteForDate(period, year, month, day, content, { operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType });
          return textResult(`Patched ${period} note for ${String(year)}-${String(month)}-${String(day)}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "patch_periodic_note_for_date" }));
        }
      },
    );
    count++;
  }

  // --- 29. delete_periodic_note_for_date ---
  if (shouldRegister("delete_periodic_note_for_date")) {
    server.registerTool(
      "delete_periodic_note_for_date",
      {
        description: "Delete periodic note for a date (idempotent)",
        inputSchema: z.object({
          period: periodSchema,
          year: z.number().int().describe("Year"),
          month: z.number().int().min(1).max(12).describe("Month (1-12)"),
          day: z.number().int().min(1).max(31).describe("Day (1-31)"),
        }),
      },
      async ({ period, year, month, day }) => {
        try {
          await client.deletePeriodicNoteForDate(period, year, month, day);
          return textResult(`Deleted ${period} note for ${String(year)}-${String(month)}-${String(day)}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "delete_periodic_note_for_date" }));
        }
      },
    );
    count++;
  }

  return count;
}

/** Registers system, batch, recent, configure, and vault analysis tools (#30-38). */
function registerSystemAndAnalysisTools(
  server: McpServer,
  client: ObsidianClient,
  cache: VaultCache,
  shouldRegister: (name: string) => boolean,
  config: Config,
): number {
  let count = 0;

  // --- 30. get_server_status (PROTECTED) ---
  if (shouldRegister("get_server_status")) {
    server.registerTool(
      "get_server_status",
      { description: "Check Obsidian API connection and version" },
      async () => {
        try {
          return jsonResult(await client.getServerStatus());
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_server_status" }));
        }
      },
    );
    count++;
  }

  // --- 31. batch_get_file_contents ---
  if (shouldRegister("batch_get_file_contents")) {
    server.registerTool(
      "batch_get_file_contents",
      {
        description: "Read multiple vault files in one call",
        inputSchema: z.object({
          filePaths: z.array(z.string()).min(1).describe("File paths"),
          format: formatSchema.optional(),
        }),
      },
      async ({ filePaths, format }) => {
        try {
          return jsonResult(await batchGetFiles(client, filePaths, format));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "batch_get_file_contents" }));
        }
      },
    );
    count++;
  }

  // --- 32. get_recent_changes ---
  if (shouldRegister("get_recent_changes")) {
    server.registerTool(
      "get_recent_changes",
      {
        description: "Get recently modified files sorted by date",
        inputSchema: z.object({ limit: z.number().int().min(1).default(10).describe("Max results") }),
      },
      async ({ limit }) => {
        try {
          return await handleRecentChanges(client, cache, config, limit);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_recent_changes" }));
        }
      },
    );
    count++;
  }

  // --- 33. get_recent_periodic_notes ---
  if (shouldRegister("get_recent_periodic_notes")) {
    server.registerTool(
      "get_recent_periodic_notes",
      {
        description: "Get recent periodic notes for a period type",
        inputSchema: z.object({
          period: periodSchema,
          limit: z.number().int().min(1).default(5).describe("Max results"),
        }),
      },
      async ({ period, limit }) => {
        try {
          return await handleRecentPeriodicNotes(client, period, limit);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_recent_periodic_notes" }));
        }
      },
    );
    count++;
  }

  // --- 34. configure (PROTECTED) ---
  if (shouldRegister("configure")) {
    server.registerTool(
      "configure",
      {
        description: "View or change server settings",
        inputSchema: z.object({
          action: z.enum(["show", "set", "reset"]).describe("Action"),
          setting: z.string().optional().describe("Setting name for set/reset"),
          value: z.string().optional().describe("New value for set"),
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

  // --- 35. get_backlinks ---
  if (shouldRegister("get_backlinks")) {
    server.registerTool(
      "get_backlinks",
      {
        description: "Get all notes that link to a file (from cache)",
        inputSchema: z.object({ filePath: z.string().describe("File path") }),
      },
      async ({ filePath }) => {
        try {
          if (!config.enableCache) return errorResult("[get_backlinks] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          if (!cache.getIsInitialized() && !(await cache.waitForInitialization(5000))) {
            return errorResult("[get_backlinks] Cache is still building. Try again shortly.");
          }
          return jsonResult(cache.getBacklinks(filePath));
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_backlinks", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 36. get_vault_structure ---
  if (shouldRegister("get_vault_structure")) {
    server.registerTool(
      "get_vault_structure",
      {
        description: "Get vault stats: note count, links, orphans, most connected",
        inputSchema: z.object({ limit: z.number().int().min(1).default(10).describe("Top N connected") }),
      },
      async ({ limit }) => {
        try {
          if (!config.enableCache) return errorResult("[get_vault_structure] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          if (!cache.getIsInitialized() && !(await cache.waitForInitialization(5000))) {
            return errorResult("[get_vault_structure] Cache is still building. Try again shortly.");
          }
          return buildVaultStructure(cache, limit);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_vault_structure" }));
        }
      },
    );
    count++;
  }

  // --- 37. get_note_connections ---
  if (shouldRegister("get_note_connections")) {
    server.registerTool(
      "get_note_connections",
      {
        description: "Get backlinks and forward links for a note",
        inputSchema: z.object({ filePath: z.string().describe("File path") }),
      },
      async ({ filePath }) => {
        try {
          if (!config.enableCache) return errorResult("[get_note_connections] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          if (!cache.getIsInitialized() && !(await cache.waitForInitialization(5000))) {
            return errorResult("[get_note_connections] Cache is still building. Try again shortly.");
          }
          return jsonResult({ backlinks: cache.getBacklinks(filePath), forwardLinks: cache.getForwardLinks(filePath) });
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_note_connections", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 38. refresh_cache (PROTECTED) ---
  if (shouldRegister("refresh_cache")) {
    server.registerTool(
      "refresh_cache",
      { description: "Force refresh vault cache and link graph" },
      async () => {
        try {
          if (!config.enableCache) return errorResult("[refresh_cache] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          await cache.refresh();
          if (!cache.getIsInitialized()) {
            return errorResult("[refresh_cache] Cache refresh failed — Obsidian may be unreachable");
          }
          return textResult(`Cache refreshed: ${String(cache.noteCount)} notes, ${String(cache.linkCount)} links`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "refresh_cache" }));
        }
      },
    );
    count++;
  }

  return count;
}

// --- Registration ---

/** Registers all 38 individual granular tools, filtered by the shouldRegister predicate. */
export function registerGranularTools(
  server: McpServer,
  client: ObsidianClient,
  cache: VaultCache,
  shouldRegister: (name: string) => boolean,
  config: Config,
): number {
  return (
    registerVaultTools(server, client, shouldRegister) +
    registerActiveFileTools(server, client, shouldRegister) +
    registerCommandAndSearchTools(server, client, shouldRegister) +
    registerPeriodicNoteTools(server, client, shouldRegister) +
    registerPeriodicNoteDateTools(server, client, shouldRegister) +
    registerSystemAndAnalysisTools(server, client, cache, shouldRegister, config)
  );
}

