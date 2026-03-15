import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ObsidianClient } from "../obsidian.js";
import type { VaultCache } from "../cache.js";

/** Registers all 38 individual granular tools, filtered by the shouldRegister predicate. */
export function registerGranularTools(
  _server: McpServer,
  _client: ObsidianClient,
  _cache: VaultCache,
  _shouldRegister: (name: string) => boolean,
): number {
  // Phase 2: all 38 granular tools will be registered here
  return 0;
}
