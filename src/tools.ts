import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ObsidianClient } from "./obsidian.js";
import type { VaultCache } from "./cache.js";
import type { Config } from "./config.js";

/** Registers MCP tools based on the active mode, preset, and include/exclude filters. */
export function registerAllTools(
  _server: McpServer,
  _client: ObsidianClient,
  _cache: VaultCache,
  _config: Config,
): number {
  // Phase 2: tool registration will be implemented here
  return 0;
}
