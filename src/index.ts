#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig, getRedactedConfig, saveConfigToFile, log, setDebugEnabled } from "./config.js";
import { ObsidianClient, setCompactResponses } from "./obsidian.js";
import { VaultCache } from "./cache.js";
import { registerAllTools } from "./tools.js";
import { buildSkillContent } from "./skill.js";

process.title = "mcp-obsidian-extended";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg: unknown = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION: string =
  pkg !== null && typeof pkg === "object" && "version" in pkg && typeof (pkg as Record<string, unknown>)["version"] === "string"
    ? (pkg as Record<string, unknown>)["version"] as string
    : "unknown";

// --- CLI: --show-config ---

/** Prints the active configuration (API key redacted) to stderr and exits. */
function showConfig(): void {
  const config = loadConfig();
  const redacted = getRedactedConfig(config);
  process.stderr.write(`mcp-obsidian-extended v${VERSION} — Active Configuration\n\n`);
  process.stderr.write(`${JSON.stringify(redacted, null, 2)}\n`);
  process.exit(0);
}

// --- CLI: --validate ---

/** Tests connectivity and authentication against the configured Obsidian instance. */
async function validate(): Promise<void> {
  process.stderr.write(`mcp-obsidian-extended v${VERSION} — Validating connection...\n\n`);
  const config = loadConfig();

  if (!config.apiKey) {
    process.stderr.write("FAIL: OBSIDIAN_API_KEY is not set.\n");
    process.exit(1);
  }

  process.stderr.write(`  Host: ${config.scheme}://${config.host}:${String(config.port)}\n`);
  process.stderr.write(`  API Key: [SET]\n`);
  if (config.configFilePath) {
    process.stderr.write(`  Config: ${config.configFilePath}\n`);
  }
  process.stderr.write("\n");

  const client = new ObsidianClient(config);
  try {
    const status = await client.getServerStatus();
    process.stderr.write(`  Connection: OK (${status.service})\n`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Connection: FAIL — ${message}\n`);
    process.exit(1);
  }

  try {
    await client.listFilesInVault();
    process.stderr.write("  Authentication: OK\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Authentication: FAIL — ${message}\n`);
    process.exit(1);
  }

  process.stderr.write("\nAll checks passed.\n");
  process.exit(0);
}

// --- CLI: --setup helpers ---

/** Validates and returns a port number, warning and defaulting on invalid input. */
function validatePort(portStr: string): number {
  const portNum = Number(portStr);
  if (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535) return portNum;
  process.stderr.write(`  Warning: invalid port "${portStr}" — using default 27124\n`);
  return 27124;
}

/** Validates and returns an enum value, warning and defaulting on invalid input. */
function validateEnum<T extends string>(value: string, valid: ReadonlySet<T>, label: string, fallback: T): T {
  if (valid.has(value as T)) return value as T;
  process.stderr.write(`  Warning: invalid ${label} "${value}" — using default "${fallback}"\n`);
  return fallback;
}

// --- CLI: --setup ---

/** Interactive setup wizard. Prompts for connection details, tests, and saves config. */
async function setup(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write("Error: --setup requires an interactive terminal (TTY).\n");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (prompt: string, defaultVal?: string): Promise<string> =>
    new Promise((res) => {
      const suffix = defaultVal === undefined ? "" : ` [${defaultVal}]`;
      rl.question(`${prompt}${suffix}: `, (answer) => {
        res(answer.trim() || defaultVal || "");
      });
    });

  process.stderr.write(`\nmcp-obsidian-extended v${VERSION} — Setup Wizard\n`);
  process.stderr.write(`${"━".repeat(50)}\n\n`);

  // Step 1: Connection
  process.stderr.write("Step 1/4: Connection\n\n");
  const apiKey = await ask("  API Key (from Obsidian Settings → Local REST API)");
  if (!apiKey) {
    process.stderr.write("\nError: API key is required.\n");
    rl.close();
    process.exit(1);
  }
  const host = await ask("  Host", "127.0.0.1");
  const portStr = await ask("  Port", "27124");
  const port = validatePort(portStr);
  const schemeRaw = await ask("  Scheme (https/http)", "https");
  const scheme = validateEnum(schemeRaw, new Set(["http", "https"] as const), "scheme", "https" as const);

  // Test connection
  process.stderr.write("\n  Testing connection...\n");
  const testConfig = loadConfig();
  const tempConfig = {
    ...testConfig,
    apiKey,
    host,
    port,
    scheme: scheme === "http" ? "http" as const : "https" as const,
  };
  const testClient = new ObsidianClient(tempConfig);
  try {
    await testClient.getServerStatus();
    await testClient.listFilesInVault();
    process.stderr.write("  ✓ Connected and authenticated!\n\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ✗ Connection failed: ${message}\n`);
    process.stderr.write("  Saving config anyway — you can fix the connection later.\n\n");
  }

  // Step 2: Tool Mode
  process.stderr.write("Step 2/4: Tool Mode\n\n");
  const toolModeRaw = await ask("  Mode (granular = 38 tools, consolidated = 11 tools)", "granular");
  const toolMode = validateEnum(toolModeRaw, new Set(["granular", "consolidated"] as const), "mode", "granular" as const);
  const toolPresetRaw = await ask("  Preset (full, read-only, minimal, safe)", "full");
  const toolPreset = validateEnum(toolPresetRaw, new Set(["full", "read-only", "minimal", "safe"] as const), "preset", "full" as const);

  // Step 3: Reliability
  process.stderr.write("\nStep 3/4: Reliability\n\n");
  const validBools = new Set(["true", "false"] as const);
  const verifyWritesRaw = await ask("  Verify writes (true/false)", "false");
  const verifyWrites = validateEnum(verifyWritesRaw, validBools, "verify writes", "false" as const);
  const maxResponseChars = await ask("  Max response chars (0 = unlimited)", "500000");
  const debugRaw = await ask("  Debug logging (true/false)", "false");
  const debug = validateEnum(debugRaw, validBools, "debug", "false" as const);

  // Step 4: Save
  process.stderr.write("\nStep 4/4: Save\n\n");
  const savePath = await ask("  Config file path", join(homedir(), ".obsidian-mcp.config.json"));
  const resolvedPath = resolve(savePath);

  const configToSave: Record<string, unknown> = {
    host,
    port,
    scheme: scheme === "http" ? "http" : "https",
    tools: {
      mode: toolMode === "consolidated" ? "consolidated" : "granular",
      preset: toolPreset,
    },
    reliability: {
      verifyWrites: verifyWrites === "true",
      maxResponseChars: (() => {
        const parsed = Number(maxResponseChars);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500000;
      })(),
    },
    debug: debug === "true",
  };

  mkdirSync(dirname(resolvedPath), { recursive: true });
  saveConfigToFile(resolvedPath, configToSave);
  process.stderr.write(`\n  Config saved to: ${resolvedPath}\n\n`);

  // Output Claude Desktop config snippet
  process.stderr.write("  Add this to your Claude Desktop config:\n\n");
  // Config auto-discovery paths (must match config.ts CONFIG_SEARCH_PATHS)
  const defaultPaths = new Set([
    resolve(join(homedir(), ".obsidian-mcp.config.json")),
    resolve(join(homedir(), ".config", "obsidian-mcp", "config.json")),
  ]);
  // CWD-relative path excluded — it varies by runtime context, so always
  // include OBSIDIAN_CONFIG in the snippet when the user picks a CWD-relative path.
  const isNonDefaultPath = !defaultPaths.has(resolvedPath);
  const maskedKey = apiKey.length > 4 ? `${apiKey.slice(0, 4)}${"*".repeat(apiKey.length - 4)}` : "****";
  const envBlock: Record<string, string> = { OBSIDIAN_API_KEY: maskedKey };
  if (isNonDefaultPath) {
    envBlock["OBSIDIAN_CONFIG"] = resolvedPath;
  }
  const snippet = {
    mcpServers: {
      "mcp-obsidian-extended": {
        command: "npx",
        args: ["-y", "mcp-obsidian-extended"],
        env: envBlock,
      },
    },
  };
  process.stderr.write(`${JSON.stringify(snippet, null, 2)}\n\n`);
  process.stderr.write("  (API key shown masked — replace with your actual key in the config above)\n\n");

  rl.close();
  process.exit(0);
}

// --- Main ---

/** Entry point: parses CLI flags, loads config, creates client/cache/server, and connects transport. */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--version") || args.has("-v")) {
    process.stderr.write(`mcp-obsidian-extended v${VERSION}\n`);
    process.exit(0);
  }

  if (args.has("--show-config")) {
    showConfig();
    return;
  }

  if (args.has("--validate")) {
    await validate();
    return;
  }

  if (args.has("--setup")) {
    await setup();
    return;
  }

  const config = loadConfig();

  setDebugEnabled(config.debug);
  setCompactResponses(config.compactResponses);

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

  const skillContent = buildSkillContent(config.toolMode, config.compactResponses);
  server.resource(
    "obsidian-skill",
    "obsidian://skill",
    { description: "LLM usage guide for Obsidian MCP tools" },
    async () => ({ contents: [{ uri: "obsidian://skill", text: skillContent, mimeType: "text/markdown" }] }),
  );

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
        try {
          await cache.initialize();
        } finally {
          // Always start auto-refresh: if initialize() failed, the timer will
          // call refresh() → initialize() on the next tick, providing automatic recovery.
          cache.startAutoRefresh();
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Startup check failed: ${message}. Tools may fail until Obsidian is running.`);
      // Start auto-refresh even on failure — refresh() will call initialize()
      // on the next tick, providing automatic recovery when Obsidian comes back
      if (config.enableCache) {
        cache.startAutoRefresh();
      }
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
