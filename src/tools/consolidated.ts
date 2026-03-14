import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ObsidianClient } from "../obsidian.js";
import type { VaultCache } from "../cache.js";

export function registerConsolidatedTools(
  _server: McpServer,
  _client: ObsidianClient,
  _cache: VaultCache,
  _shouldRegister: (name: string) => boolean,
): number {
  // Phase 2: all 11 consolidated tools will be registered here
  return 0;
}
