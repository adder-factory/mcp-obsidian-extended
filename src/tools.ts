import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ObsidianClient } from "./obsidian.js";
import type { VaultCache } from "./cache.js";
import type { Config } from "./config.js";
import { registerGranularTools } from "./tools/granular.js";
import { registerConsolidatedTools } from "./tools/consolidated.js";

// --- Preset Definitions ---

/** Tool names included in each granular-mode preset. */
const GRANULAR_PRESETS: Record<string, readonly string[]> = {
  full: [
    "list_files_in_vault", "list_files_in_dir", "get_file_contents", "put_content",
    "append_content", "patch_content", "delete_file", "search_replace",
    "get_active_file", "put_active_file", "append_active_file", "patch_active_file", "delete_active_file",
    "list_commands", "execute_command", "open_file",
    "simple_search", "complex_search", "dataview_search",
    "get_periodic_note", "put_periodic_note", "append_periodic_note", "patch_periodic_note", "delete_periodic_note",
    "get_periodic_note_for_date", "put_periodic_note_for_date", "append_periodic_note_for_date",
    "patch_periodic_note_for_date", "delete_periodic_note_for_date",
    "get_server_status", "batch_get_file_contents", "get_recent_changes", "get_recent_periodic_notes",
    "configure", "get_backlinks", "get_vault_structure", "get_note_connections", "refresh_cache",
  ],
  "read-only": [
    "list_files_in_vault", "list_files_in_dir", "get_file_contents",
    "get_active_file", "list_commands", "open_file",
    "simple_search", "complex_search", "dataview_search",
    "get_periodic_note", "get_periodic_note_for_date",
    "get_server_status", "batch_get_file_contents", "get_recent_changes", "get_recent_periodic_notes",
    "configure", "get_backlinks", "get_vault_structure", "get_note_connections", "refresh_cache",
  ],
  minimal: [
    "list_files_in_vault", "get_file_contents", "append_content", "simple_search",
    "get_server_status", "batch_get_file_contents", "configure",
  ],
  safe: [
    "list_files_in_vault", "list_files_in_dir", "get_file_contents", "put_content",
    "append_content", "patch_content", "search_replace",
    "get_active_file", "put_active_file", "append_active_file", "patch_active_file",
    "list_commands", "execute_command", "open_file",
    "simple_search", "complex_search", "dataview_search",
    "get_periodic_note", "put_periodic_note", "append_periodic_note", "patch_periodic_note",
    "get_periodic_note_for_date", "put_periodic_note_for_date", "append_periodic_note_for_date",
    "patch_periodic_note_for_date",
    "get_server_status", "batch_get_file_contents", "get_recent_changes", "get_recent_periodic_notes",
    "configure", "get_backlinks", "get_vault_structure", "get_note_connections", "refresh_cache",
  ],
};

/** Tool names included in each consolidated-mode preset. */
const CONSOLIDATED_PRESETS: Record<string, readonly string[]> = {
  full: [
    "vault", "active_file", "commands", "open_file", "search",
    "periodic_note", "status", "batch_get", "recent", "configure", "vault_analysis",
  ],
  "read-only": [
    "vault", "active_file", "commands", "search",
    "periodic_note", "status", "batch_get", "recent", "configure", "vault_analysis",
  ],
  minimal: [
    "vault", "search", "status", "configure",
  ],
  safe: [
    "vault", "active_file", "commands", "open_file", "search",
    "periodic_note", "status", "batch_get", "recent", "configure", "vault_analysis",
  ],
};

/** Protected tools that are always registered regardless of filtering. */
const PROTECTED_GRANULAR = new Set(["configure", "get_server_status", "refresh_cache"]);
const PROTECTED_CONSOLIDATED = new Set(["configure", "status", "vault_analysis"]);

// --- Filtering Logic ---

/**
 * Builds the shouldRegister predicate from preset + include/exclude + protected.
 * Priority: Protected (always) → INCLUDE whitelist → EXCLUDE blacklist → preset base set.
 */
function buildFilter(
  preset: readonly string[],
  includeTools: readonly string[],
  excludeTools: readonly string[],
  protectedTools: ReadonlySet<string>,
): (name: string) => boolean {
  const presetSet = new Set(preset);

  return (name: string): boolean => {
    // Protected tools always pass
    if (protectedTools.has(name)) {
      return true;
    }

    // If INCLUDE is specified, only those tools (from the preset) are allowed
    if (includeTools.length > 0) {
      const includeSet = new Set(includeTools);
      return includeSet.has(name) && presetSet.has(name);
    }

    // If EXCLUDE is specified, remove those from the preset
    if (excludeTools.length > 0) {
      const excludeSet = new Set(excludeTools);
      return presetSet.has(name) && !excludeSet.has(name);
    }

    // Default: use the preset as-is
    return presetSet.has(name);
  };
}

// --- Main Entry ---

/** Registers MCP tools based on the active mode, preset, and include/exclude filters. */
export function registerAllTools(
  server: McpServer,
  client: ObsidianClient,
  cache: VaultCache,
  config: Config,
): number {
  const isConsolidated = config.toolMode === "consolidated";
  const presets = isConsolidated ? CONSOLIDATED_PRESETS : GRANULAR_PRESETS;
  const protectedTools = isConsolidated ? PROTECTED_CONSOLIDATED : PROTECTED_GRANULAR;
  const preset = presets[config.toolPreset] ?? presets["full"];

  // preset is guaranteed defined since we default to "full" above
  const shouldRegister = buildFilter(preset!, config.includeTools, config.excludeTools, protectedTools);

  if (isConsolidated) {
    return registerConsolidatedTools(server, client, cache, shouldRegister, config);
  }
  return registerGranularTools(server, client, cache, shouldRegister, config);
}
