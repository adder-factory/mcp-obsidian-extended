#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, log } from "./config.js";
import { ObsidianClient } from "./obsidian.js";
import { VaultCache } from "./cache.js";
import { registerAllTools } from "./tools.js";

const VERSION = "1.0.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // CLI flags — Phase 2 will add --setup, --show-config, --validate
  if (args.includes("--version") || args.includes("-v")) {
    process.stderr.write(`mcp-obsidian-extended v${VERSION}\n`);
    process.exit(0);
  }

  const config = loadConfig();

  if (!config.apiKey) {
    log("error", "OBSIDIAN_API_KEY is required. Set it as an environment variable or in config file.");
    process.exit(1);
  }

  const client = new ObsidianClient(config);
  const cache = new VaultCache(client, config.cacheTtl);
  client.setCache(cache);

  const server = new McpServer({
    name: "mcp-obsidian-extended",
    version: VERSION,
  });

  const toolCount = registerAllTools(server, client, cache, config);

  log("info", `mcp-obsidian-extended v${VERSION}`);
  if (config.configFilePath) {
    log("info", `Config: ${config.configFilePath} + env overrides`);
  }
  log("info", `Tools: ${config.toolMode} mode | preset: ${config.toolPreset} | ${String(toolCount)} registered`);

  // Startup health check — runs in background so transport connects immediately
  void (async () => {
    try {
      await client.getServerStatus();
      log("info", "Connected to Obsidian REST API");
      // Verify auth with an authenticated endpoint
      await client.listFilesInVault();
      log("info", "API key verified");
      if (config.enableCache) {
        await cache.initialize();
        cache.startAutoRefresh();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Startup check failed: ${message}. Tools may fail until Obsidian is running.`);
    }
  })();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log("error", `Fatal: ${message}`);
  process.exit(1);
});
