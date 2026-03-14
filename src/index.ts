#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig, log, setDebugEnabled } from "./config.js";
import { ObsidianClient } from "./obsidian.js";
import { VaultCache } from "./cache.js";
import { registerAllTools } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg: unknown = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION: string =
  pkg !== null && typeof pkg === "object" && "version" in pkg && typeof (pkg as Record<string, unknown>)["version"] === "string"
    ? (pkg as Record<string, unknown>)["version"] as string
    : "unknown";

/** Entry point: parses CLI flags, loads config, creates client/cache/server, and connects transport. */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  // CLI flags — Phase 2 will add --setup, --show-config, --validate
  if (args.has("--version") || args.has("-v")) {
    process.stderr.write(`mcp-obsidian-extended v${VERSION}\n`);
    process.exit(0);
  }

  const config = loadConfig();

  setDebugEnabled(config.debug);

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

try {
  await main();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  log("error", `Fatal: ${message}`);
  process.exit(1);
}
