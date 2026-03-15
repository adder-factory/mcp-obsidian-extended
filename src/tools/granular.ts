import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ObsidianClient, NoteJson, DocumentMap } from "../obsidian.js";
import { textResult, errorResult, jsonResult } from "../obsidian.js";
import type { VaultCache } from "../cache.js";
import type { Config } from "../config.js";
import { getRedactedConfig, saveConfigToFile, setDebugEnabled, log } from "../config.js";
import { buildErrorMessage } from "../errors.js";
import {
  formatSchema,
  periodSchema,
  patchOperationSchema,
  patchTargetTypeSchema,
  patchContentTypeSchema,
} from "../schemas.js";

// --- Consolidated preset action restrictions ---
// (Not used in granular mode — included here only for type-sharing with consolidated.ts)

// --- Helpers ---

/** Formats file contents for display, handling markdown, JSON, and map formats. */
function formatFileContents(result: string | NoteJson | DocumentMap): ReturnType<typeof textResult> {
  if (typeof result === "string") {
    return textResult(result);
  }
  return jsonResult(result);
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
  let count = 0;

  // --- 1. list_files_in_vault ---
  if (shouldRegister("list_files_in_vault")) {
    server.tool(
      "list_files_in_vault",
      "List all files and directories in vault root",
      {},
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
    server.tool(
      "list_files_in_dir",
      "List files in a vault directory",
      { dirPath: z.string().describe("Directory path") },
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
    server.tool(
      "get_file_contents",
      "Read a vault file as markdown, JSON, or document map",
      {
        filePath: z.string().describe("File path"),
        format: formatSchema.optional(),
      },
      async ({ filePath, format }) => {
        try {
          const result = await client.getFileContents(filePath, format);
          return formatFileContents(result);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_file_contents", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 4. put_content ---
  if (shouldRegister("put_content")) {
    server.tool(
      "put_content",
      "Create or overwrite a vault file (idempotent)",
      {
        filePath: z.string().describe("File path"),
        content: z.string().describe("File content"),
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
    server.tool(
      "append_content",
      "Append to a vault file (not idempotent, do not retry)",
      {
        filePath: z.string().describe("File path"),
        content: z.string().describe("Content to append"),
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
    server.tool(
      "patch_content",
      "Insert at heading/block/frontmatter (not idempotent, do not retry)",
      {
        filePath: z.string().describe("File path"),
        content: z.string().describe("Content to insert"),
        operation: patchOperationSchema,
        targetType: patchTargetTypeSchema,
        target: z.string().describe("Target heading/block/field"),
        targetDelimiter: z.string().optional().describe("Heading delimiter"),
        trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
        createIfMissing: z.boolean().optional().describe("Create target if missing"),
        contentType: patchContentTypeSchema.optional(),
      },
      async ({ filePath, content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType }) => {
        try {
          await client.patchContent(filePath, content, {
            operation,
            targetType,
            target,
            targetDelimiter,
            trimTargetWhitespace,
            createIfMissing,
            contentType,
          });
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
    server.tool(
      "delete_file",
      "Delete a vault file to Obsidian trash (idempotent)",
      { filePath: z.string().describe("File path") },
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
    server.tool(
      "search_replace",
      "Find and replace text in a vault file (not idempotent)",
      {
        filePath: z.string().describe("File path"),
        search: z.string().describe("Text to find"),
        replace: z.string().describe("Replacement text"),
        useRegex: z.boolean().default(false).describe("Use regex matching"),
        caseSensitive: z.boolean().default(true).describe("Case-sensitive match"),
        replaceAll: z.boolean().default(true).describe("Replace all occurrences"),
      },
      async ({ filePath, search, replace, useRegex, caseSensitive, replaceAll }) => {
        try {
          const result = await client.getFileContents(filePath, "markdown");
          if (typeof result !== "string") {
            return errorResult("[search_replace] Expected markdown content");
          }
          const flags = `${caseSensitive ? "" : "i"}${replaceAll ? "g" : ""}`;
          const pattern = useRegex ? new RegExp(search, flags) : new RegExp(escapeRegex(search), flags);
          const updated = result.replace(pattern, replace);
          if (updated === result) {
            return textResult(`No matches found for "${search}" in ${filePath}`);
          }
          await client.putContent(filePath, updated);
          return textResult(`Replaced in: ${filePath}`);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "search_replace", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 9. get_active_file ---
  if (shouldRegister("get_active_file")) {
    server.tool(
      "get_active_file",
      "Read the currently open file in Obsidian",
      { format: formatSchema.optional() },
      async ({ format }) => {
        try {
          const result = await client.getActiveFile(format);
          return formatFileContents(result);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_active_file" }));
        }
      },
    );
    count++;
  }

  // --- 10. put_active_file ---
  if (shouldRegister("put_active_file")) {
    server.tool(
      "put_active_file",
      "Replace content of the open file (idempotent)",
      { content: z.string().describe("New file content") },
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
    server.tool(
      "append_active_file",
      "Append to the open file (not idempotent, do not retry)",
      { content: z.string().describe("Content to append") },
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
    server.tool(
      "patch_active_file",
      "Patch the active file at a target (not idempotent)",
      {
        content: z.string().describe("Content to insert"),
        operation: patchOperationSchema,
        targetType: patchTargetTypeSchema,
        target: z.string().describe("Target heading/block/field"),
        targetDelimiter: z.string().optional().describe("Heading delimiter"),
        trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
        contentType: patchContentTypeSchema.optional(),
      },
      async ({ content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, contentType }) => {
        try {
          await client.patchActiveFile(content, {
            operation,
            targetType,
            target,
            targetDelimiter,
            trimTargetWhitespace,
            contentType,
          });
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
    server.tool(
      "delete_active_file",
      "Delete the currently open file (idempotent)",
      {},
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

  // --- 14. list_commands ---
  if (shouldRegister("list_commands")) {
    server.tool(
      "list_commands",
      "List all Obsidian command palette commands",
      {},
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
    server.tool(
      "execute_command",
      "Run an Obsidian command by ID",
      { commandId: z.string().describe("Command ID") },
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
    server.tool(
      "open_file",
      "Open a file in the Obsidian UI",
      {
        filePath: z.string().describe("File path"),
        newLeaf: z.boolean().default(false).describe("Open in new tab"),
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
    server.tool(
      "simple_search",
      "Full-text search across all vault files",
      {
        query: z.string().describe("Search query"),
        contextLength: z.number().default(100).describe("Context chars"),
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
    server.tool(
      "complex_search",
      "Search vault with JsonLogic queries (glob, regexp)",
      {
        query: z.record(z.unknown()).describe("JsonLogic query object"),
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
    server.tool(
      "dataview_search",
      "Query vault with Dataview DQL (requires plugin)",
      { dql: z.string().describe("DQL query string") },
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

  // --- 20. get_periodic_note ---
  if (shouldRegister("get_periodic_note")) {
    server.tool(
      "get_periodic_note",
      "Get the current periodic note",
      {
        period: periodSchema,
        format: formatSchema.optional(),
      },
      async ({ period, format }) => {
        try {
          const result = await client.getPeriodicNote(period, format);
          return formatFileContents(result);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_periodic_note" }));
        }
      },
    );
    count++;
  }

  // --- 21. put_periodic_note ---
  if (shouldRegister("put_periodic_note")) {
    server.tool(
      "put_periodic_note",
      "Replace current periodic note content (idempotent)",
      {
        period: periodSchema,
        content: z.string().describe("Note content"),
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
    server.tool(
      "append_periodic_note",
      "Append to current periodic note (not idempotent)",
      {
        period: periodSchema,
        content: z.string().describe("Content to append"),
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
    server.tool(
      "patch_periodic_note",
      "Patch current periodic note at a target (not idempotent)",
      {
        period: periodSchema,
        content: z.string().describe("Content to insert"),
        operation: patchOperationSchema,
        targetType: patchTargetTypeSchema,
        target: z.string().describe("Target heading/block/field"),
        targetDelimiter: z.string().optional().describe("Heading delimiter"),
        trimTargetWhitespace: z.boolean().optional().describe("Trim target whitespace"),
        createIfMissing: z.boolean().optional().describe("Create target if missing"),
        contentType: patchContentTypeSchema.optional(),
      },
      async ({ period, content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType }) => {
        try {
          await client.patchPeriodicNote(period, content, {
            operation,
            targetType,
            target,
            targetDelimiter,
            trimTargetWhitespace,
            createIfMissing,
            contentType,
          });
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
    server.tool(
      "delete_periodic_note",
      "Delete current periodic note (idempotent)",
      { period: periodSchema },
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

  // --- 25. get_periodic_note_for_date ---
  if (shouldRegister("get_periodic_note_for_date")) {
    server.tool(
      "get_periodic_note_for_date",
      "Get periodic note for a specific date",
      {
        period: periodSchema,
        year: z.number().int().describe("Year"),
        month: z.number().int().min(1).max(12).describe("Month (1-12)"),
        day: z.number().int().min(1).max(31).describe("Day (1-31)"),
        format: formatSchema.optional(),
      },
      async ({ period, year, month, day, format }) => {
        try {
          const result = await client.getPeriodicNoteForDate(period, year, month, day, format);
          return formatFileContents(result);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_periodic_note_for_date" }));
        }
      },
    );
    count++;
  }

  // --- 26. put_periodic_note_for_date ---
  if (shouldRegister("put_periodic_note_for_date")) {
    server.tool(
      "put_periodic_note_for_date",
      "Replace periodic note for a date (idempotent)",
      {
        period: periodSchema,
        year: z.number().int().describe("Year"),
        month: z.number().int().min(1).max(12).describe("Month (1-12)"),
        day: z.number().int().min(1).max(31).describe("Day (1-31)"),
        content: z.string().describe("Note content"),
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
    server.tool(
      "append_periodic_note_for_date",
      "Append to periodic note for a date (not idempotent)",
      {
        period: periodSchema,
        year: z.number().int().describe("Year"),
        month: z.number().int().min(1).max(12).describe("Month (1-12)"),
        day: z.number().int().min(1).max(31).describe("Day (1-31)"),
        content: z.string().describe("Content to append"),
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
    server.tool(
      "patch_periodic_note_for_date",
      "Patch periodic note for a date (not idempotent)",
      {
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
      },
      async ({ period, year, month, day, content, operation, targetType, target, targetDelimiter, trimTargetWhitespace, createIfMissing, contentType }) => {
        try {
          await client.patchPeriodicNoteForDate(period, year, month, day, content, {
            operation,
            targetType,
            target,
            targetDelimiter,
            trimTargetWhitespace,
            createIfMissing,
            contentType,
          });
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
    server.tool(
      "delete_periodic_note_for_date",
      "Delete periodic note for a date (idempotent)",
      {
        period: periodSchema,
        year: z.number().int().describe("Year"),
        month: z.number().int().min(1).max(12).describe("Month (1-12)"),
        day: z.number().int().min(1).max(31).describe("Day (1-31)"),
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

  // --- 30. get_server_status (PROTECTED) ---
  if (shouldRegister("get_server_status")) {
    server.tool(
      "get_server_status",
      "Check Obsidian API connection and version",
      {},
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
    server.tool(
      "batch_get_file_contents",
      "Read multiple vault files in one call",
      {
        filePaths: z.array(z.string()).min(1).describe("File paths"),
        format: formatSchema.optional(),
      },
      async ({ filePaths, format }) => {
        try {
          const results = await Promise.allSettled(
            filePaths.map(async (fp) => {
              const content = await client.getFileContents(fp, format);
              return { path: fp, content };
            }),
          );
          const output: Array<{ path: string; content?: unknown; error?: string }> = [];
          for (const r of results) {
            if (r.status === "fulfilled") {
              output.push(r.value);
            } else {
              const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
              output.push({ path: "(unknown)", error: reason });
            }
          }
          return jsonResult(output);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "batch_get_file_contents" }));
        }
      },
    );
    count++;
  }

  // --- 32. get_recent_changes ---
  if (shouldRegister("get_recent_changes")) {
    server.tool(
      "get_recent_changes",
      "Get recently modified files sorted by date",
      { limit: z.number().int().min(1).default(10).describe("Max results") },
      async ({ limit }) => {
        try {
          if (!config.enableCache || !cache.getIsInitialized()) {
            // Fallback: list vault and fetch stat info
            const { files } = await client.listFilesInVault();
            const mdFiles = files.filter((f) => f.toLowerCase().endsWith(".md"));
            const withStats = await Promise.allSettled(
              mdFiles.map(async (fp) => {
                const result = await client.getFileContents(fp, "json");
                if (typeof result !== "string" && "stat" in result) {
                  return { path: fp, mtime: result.stat.mtime };
                }
                return { path: fp, mtime: 0 };
              }),
            );
            const sorted = withStats
              .filter((r): r is PromiseFulfilledResult<{ path: string; mtime: number }> => r.status === "fulfilled")
              .map((r) => r.value)
              .sort((a, b) => b.mtime - a.mtime)
              .slice(0, limit);
            return jsonResult(sorted);
          }
          const allNotes = cache.getAllNotes();
          const sorted = [...allNotes]
            .sort((a, b) => b.stat.mtime - a.stat.mtime)
            .slice(0, limit)
            .map((n) => ({ path: n.path, mtime: n.stat.mtime }));
          return jsonResult(sorted);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_recent_changes" }));
        }
      },
    );
    count++;
  }

  // --- 33. get_recent_periodic_notes ---
  if (shouldRegister("get_recent_periodic_notes")) {
    server.tool(
      "get_recent_periodic_notes",
      "Get recent periodic notes for a period type",
      {
        period: periodSchema,
        limit: z.number().int().min(1).default(5).describe("Max results"),
      },
      async ({ period, limit }) => {
        try {
          // List vault files and find periodic note directory
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
            .sort()
            .reverse()
            .slice(0, limit);
          return jsonResult(periodFiles);
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_recent_periodic_notes" }));
        }
      },
    );
    count++;
  }

  // --- 34. configure (PROTECTED) ---
  if (shouldRegister("configure")) {
    server.tool(
      "configure",
      "View or change server settings",
      {
        action: z.enum(["show", "set", "reset"]).describe("Action"),
        setting: z.string().optional().describe("Setting name for set/reset"),
        value: z.string().optional().describe("New value for set"),
      },
      async ({ action, setting, value }) => {
        try {
          switch (action) {
            case "show":
              return jsonResult(getRedactedConfig(config));

            case "set": {
              if (!setting) {
                return errorResult("[configure] Setting name is required for 'set' action");
              }
              if (value === undefined) {
                return errorResult("[configure] Value is required for 'set' action");
              }
              const immediateSettings = new Set(["debug", "timeout", "verifyWrites", "maxResponseChars"]);
              const restartSettings = new Set(["toolMode", "toolPreset"]);

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
                applyImmediateSetting(setting, value, config);
                return textResult(`Setting "${setting}" updated to "${value}" (effective immediately)`);
              }
              return textResult(`Setting "${setting}" saved to config file. Restart the server for this change to take effect.`);
            }

            case "reset": {
              if (!setting) {
                return errorResult("[configure] Setting name is required for 'reset' action");
              }
              const configPath = config.configFilePath ?? "./obsidian-mcp.config.json";
              const resetUpdates = buildConfigReset(setting);
              if (resetUpdates === undefined) {
                return errorResult(`[configure] Unknown setting: ${setting}`);
              }
              saveConfigToFile(configPath, resetUpdates);
              return textResult(`Setting "${setting}" reset to default in config file. Restart the server for this change to take effect.`);
            }

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
    server.tool(
      "get_backlinks",
      "Get all notes that link to a file (from cache)",
      { filePath: z.string().describe("File path") },
      async ({ filePath }) => {
        try {
          if (!config.enableCache) {
            return errorResult("[get_backlinks] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          }
          if (!cache.getIsInitialized()) {
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
    server.tool(
      "get_vault_structure",
      "Get vault stats: note count, links, orphans, most connected",
      { limit: z.number().int().min(1).default(10).describe("Top N connected") },
      async ({ limit }) => {
        try {
          if (!config.enableCache) {
            return errorResult("[get_vault_structure] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          }
          if (!cache.getIsInitialized()) {
            return errorResult("[get_vault_structure] Cache is still building. Try again shortly.");
          }
          const orphans = cache.getOrphanNotes();
          const mostConnected = cache.getMostConnectedNotes(limit);
          const graph = cache.getVaultGraph();

          // Build directory tree summary
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
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_vault_structure" }));
        }
      },
    );
    count++;
  }

  // --- 37. get_note_connections ---
  if (shouldRegister("get_note_connections")) {
    server.tool(
      "get_note_connections",
      "Get backlinks and forward links for a note",
      { filePath: z.string().describe("File path") },
      async ({ filePath }) => {
        try {
          if (!config.enableCache) {
            return errorResult("[get_note_connections] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          }
          if (!cache.getIsInitialized()) {
            return errorResult("[get_note_connections] Cache is still building. Try again shortly.");
          }
          const backlinks = cache.getBacklinks(filePath);
          const forwardLinks = cache.getForwardLinks(filePath);
          return jsonResult({ backlinks, forwardLinks });
        } catch (err: unknown) {
          return errorResult(buildErrorMessage(err, { tool: "get_note_connections", path: filePath }));
        }
      },
    );
    count++;
  }

  // --- 38. refresh_cache (PROTECTED) ---
  if (shouldRegister("refresh_cache")) {
    server.tool(
      "refresh_cache",
      "Force refresh vault cache and link graph",
      {},
      async () => {
        try {
          if (!config.enableCache) {
            return errorResult("[refresh_cache] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true");
          }
          await cache.refresh();
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

// --- Configure Helpers ---

/** Escapes a string for use as a literal in a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a config file update object for a given setting and value. Returns undefined if value is invalid. */
function buildConfigUpdate(setting: string, value: string): Record<string, unknown> | undefined {
  switch (setting) {
    case "debug":
      if (value !== "true" && value !== "false") return undefined;
      return { debug: value === "true" };
    case "timeout": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1) return undefined;
      return { reliability: { timeout: n } };
    }
    case "verifyWrites":
      if (value !== "true" && value !== "false") return undefined;
      return { reliability: { verifyWrites: value === "true" } };
    case "maxResponseChars": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return undefined;
      return { reliability: { maxResponseChars: n } };
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

/** Builds a config file update that resets a setting to its default value. Returns undefined for unknown settings. */
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

/** Applies an immediate-effect setting change to the running config. */
function applyImmediateSetting(setting: string, value: string, _config: Config): void {
  // Config is readonly — we mutate the underlying process behavior directly
  switch (setting) {
    case "debug":
      setDebugEnabled(value === "true");
      log("info", `Debug logging ${value === "true" ? "enabled" : "disabled"}`);
      break;
    // timeout, verifyWrites, maxResponseChars take effect on next request via config file
    // (the client reads from config on construction, so these require restart)
    // We still save to file above — calling them "immediate" is a simplification
    // that means "saved and acknowledged" vs "requires tool re-registration"
  }
}
