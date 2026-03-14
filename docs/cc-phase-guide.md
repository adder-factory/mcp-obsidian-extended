# CC Phase Guide — Build Steps

**Read `cc-instructions-final.md` first** for all decisions and specs.
**Use `cc-reference.md`** for API endpoints, type definitions, and tool descriptions.

---

## Phase 1 — Scaffold, Config & HTTP Client

**Goal:** Clean fork, scaffold TypeScript project, build config loader and HTTP client.
**Checkpoint:** `npm run build` compiles clean.
**Commit:** `feat: scaffold TypeScript project, config, and HTTP client`

### Step 1.1 — Clean the Fork

Remove all Python files: `*.py`, `pyproject.toml`, `uv.lock`, `Dockerfile`, `.python-version`, existing `src/` directory. Keep `.git/`, `LICENSE`, `README.md` (will be rewritten in Phase 3).

### Step 1.2 — Scaffold

Create `package.json`:
```json
{
  "name": "mcp-obsidian-extended",
  "version": "1.0.0",
  "description": "MCP server for Obsidian — 38 tools, 100% REST API coverage",
  "license": "MIT",
  "type": "module",
  "bin": { "mcp-obsidian-extended": "./dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "inspect": "npx @modelcontextprotocol/inspector node dist/index.js",
    "test:smoke": "tsx scripts/smoke-test.ts",
    "pack:mcpb": "npm run build && mcpb pack"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.24.0"
  },
  "peerDependencies": {
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.8.2",
    "@types/node": "^22.13.10",
    "zod": "^3.25.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "tsx": "^4.0.0"
  }
}
```

Create `tsconfig.json` — see `cc-instructions-final.md` for all compiler flags.

Create `.node-version` (content: `22`), `.gitignore` (`node_modules/`, `dist/`, `.env`).

Run `npm install`.

### Step 1.3 — Build `src/errors.ts`

```typescript
export class ObsidianApiError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly errorCode?: number) {
    super(message);
    this.name = "ObsidianApiError";
  }
}
export class ObsidianConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "ObsidianConnectionError";
  }
}
export class ObsidianAuthError extends Error {
  constructor() {
    super("Authentication failed. Check OBSIDIAN_API_KEY.");
    this.name = "ObsidianAuthError";
  }
}
```

### Step 1.4 — Build `src/config.ts`

Three-tier config loader: Defaults → config file → env vars.

- Define `Config` interface matching all 15 env vars (see `cc-instructions-final.md`)
- Define `DEFAULTS` object with all default values
- `findAndLoadConfigFile()` — search 4 locations, parse JSON, validate
- `applyEnvVars()` — override config from `process.env`
- `validateConfig()` — check required fields (apiKey), validate types
- `saveConfigToFile()` — for the `configure` tool's `set` action
- `getRedactedConfig()` — for display (API key NEVER shown, not even masked)
- Export `loadConfig(): Config`

### Step 1.5 — Build `src/obsidian.ts`

HTTP client class. See `cc-reference.md` for all method signatures.

Key implementation details:
- **Constructor:** takes `Config`, builds base URL, creates HTTPS agent with cert handling
- **Auth:** Bearer token on every request except `GET /`
- **TLS:** If `scheme=http`, no TLS. If `certPath` set, use as `ca`. Otherwise `rejectUnauthorized: false`
- **Timeouts:** `config.timeout` for normal requests, `config.timeout * 2` for search operations
- **Path encoding:** URL-encode file path segments. Apply `sanitizeFilePath()` before encoding
- **Case-insensitive fallback:** On 404, retry with lowercased filename before throwing
- **Empty dir handling:** On 404 for `listFilesInDir()`, check if dir exists in vault listing
- **Response validation:** Check content-type, parse error bodies, map to custom error types
- **Write locks:** `withFileLock()` serializes writes per file path
- **Write verification:** Optional read-after-write for PUT ops when `config.verifyWrites=true`
- **Connection health:** `ensureConnection()` checks every 30s, sets `isConnected` flag
- **Debug logging:** When `config.debug=true`, log method/path/status/timing to stderr
- **Log function:** `process.stderr.write()` only, never `console.log()`

### Step 1.6 — Build `src/cache.ts`

Vault cache with link parser and graph analysis. See `cc-reference.md` for full interface.

Key components:
- `VaultCache` class: in-memory Map of `CachedNote` objects
- `parseLinks(content, currentPath)`: regex parser for `[[wikilinks]]` and `[text](path.md)` links
- `initialize()`: fetch all .md files via REST API, parse content + links, runs in background (non-blocking)
- `refresh()`: incremental — compare `stat.mtime`, only re-fetch changed notes
- `startAutoRefresh(intervalMs)`: background timer (default 10 min)
- Cache-aware reads: `getNote()` returns cached content, invalidated on writes
- Graph queries: `getBacklinks()`, `getForwardLinks()`, `getOrphanNotes()`, `getMostConnectedNotes()`, `getVaultGraph()`
- Offline fallback: when API unreachable, serve cached data with "(cached)" flag

### Step 1.7 — Build `src/schemas.ts`

Shared Zod schemas used by both granular and consolidated tools:

```typescript
import { z } from "zod";
export const formatSchema = z.enum(["markdown", "json", "map"]).default("markdown").describe("Response format");
export const periodSchema = z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).describe("Periodic note type");
export const patchOptionsSchema = { /* see cc-reference.md */ };
```

### Verification

```bash
npm run build  # Zero errors
```

---

## Phase 2 — Tools, Server Entry, CLI

**Goal:** All 38 tools in both modes, server entry point, CLI flags.
**Checkpoint:** `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | OBSIDIAN_API_KEY=test node dist/index.js` returns all tools.
**Commit:** `feat: add all tools, dual mode, CLI, cache, and graph analysis`

### Step 2.1 — Build `src/tools.ts` (Dispatcher)

This file handles mode selection, presets, and filtering:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ObsidianClient } from "./obsidian.js";
import { Config } from "./config.js";
import { registerGranularTools } from "./tools/granular.js";
import { registerConsolidatedTools } from "./tools/consolidated.js";

export function registerAllTools(server: McpServer, client: ObsidianClient, config: Config): number {
  // 1. Determine base tool set from preset
  // 2. Apply INCLUDE_TOOLS / EXCLUDE_TOOLS
  // 3. Always include protected tools: configure, status/get_server_status
  // 4. Register via granular or consolidated based on config.toolMode
  // 5. Return count of registered tools
}
```

### Step 2.2 — Build `src/tools/granular.ts`

38 individual tools using `server.tool()` + Zod. Pattern:

```typescript
export function registerGranularTools(
  server: McpServer,
  client: ObsidianClient,
  shouldRegister: (name: string) => boolean
): number {
  let count = 0;
  
  if (shouldRegister("list_files_in_vault")) {
    server.tool(
      "list_files_in_vault",
      "List all files and directories in vault root",
      {},
      async () => { /* call client.listFilesInVault() */ }
    );
    count++;
  }
  // ... all 38 tools
  return count;
}
```

**Use `cc-reference.md`** for every tool's description, input schema, and which client method it calls.

**Brevity rules:** Max 15 words per tool description, max 10 words per parameter `.describe()`.

**The `configure` tool (#34):**
- Actions: `show` (redacted config), `set` (change a setting), `reset` (restore defaults)
- Settings changeable immediately: debug, timeout, verifyWrites, maxResponseChars
- Settings requiring restart: toolMode, toolPreset → save to file, return "restart needed" message
- Always registered — immune to filtering

**Vault Analysis tools (#35-38):**
- `get_backlinks` — query cache for all notes linking to a given file, return with context
- `get_vault_structure` — vault stats: total notes, total links, orphan notes, most connected, directory tree
- `get_note_connections` — backlinks + forward links for a specific note
- `refresh_cache` — force cache rebuild. **Protected — always registered**
- All require cache to be enabled (`OBSIDIAN_ENABLE_CACHE=true`, which is the default)
- If cache is disabled, return clear error: "Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true"

### Step 2.3 — Build `src/tools/consolidated.ts`

10 combined tools. Each uses an `action` enum parameter. Plus `vault_analysis` (#11) for graph. Pattern:

```typescript
server.tool(
  "vault",
  "Read, write, search, and manage vault files",
  {
    action: z.enum(["list", "list_dir", "get", "put", "append", "patch", "delete", "search_replace"]),
    path: z.string().optional().describe("File or directory path"),
    content: z.string().optional().describe("Content for write operations"),
    format: formatSchema.optional(),
    // ... see cc-reference.md for full schema
  },
  async (args) => {
    switch (args.action) {
      case "list": return jsonResult(await client.listFilesInVault());
      // ...
    }
  }
);
```

**Use Zod `.refine()`** for conditional validation (e.g. `action=put` requires `content`).

### Step 2.4 — Build `src/index.ts`

Entry point. Order of operations:

1. **Shebang:** `#!/usr/bin/env node`
2. **CLI flag detection** (before anything else):
   - `--version` / `-v` → print version + tool count, exit
   - `--setup` → run interactive wizard (readline), exit
   - `--show-config` → print redacted config, exit
   - `--validate` → test connection + auth, exit
3. **Load config:** `const config = loadConfig();`
4. **Validate API key:** If empty, log error to stderr and exit
5. **Create client:** `const client = new ObsidianClient(config);`
6. **Create cache:** `const cache = new VaultCache(client, config.cacheTtl);` — pass to client: `client.setCache(cache);`
7. **Create server:** `const server = new McpServer({ name: "mcp-obsidian-extended", version: "1.0.0" });`
8. **Register tools:** `const toolCount = registerAllTools(server, client, cache, config);`
9. **Startup health check** (non-blocking):
   ```typescript
   try {
     const status = await client.getServerStatus();
     log("info", `Connected to Obsidian REST API (authenticated)`);
     // Start cache build in background (non-blocking)
     if (config.enableCache) {
       cache.initialize().then(() => {
         log("info", `Cache: ready (${cache.noteCount} notes, ${cache.linkCount} links)`);
         cache.startAutoRefresh();
       }).catch(err => {
         log("warn", `Cache build failed: ${err.message}. Graph tools unavailable.`);
       });
     }
   } catch {
     log("warn", "Could not connect to Obsidian. Tools will fail until Obsidian is running.");
   }
   ```
10. **Log startup summary:**
   ```
   [info] mcp-obsidian-extended v1.0.0
   [info] Config: ~/.obsidian-mcp.config.json + env overrides
   [info] Tools: granular mode | preset: full | 38 registered
   [info] Connected to Obsidian REST API v1.0
   [info] Cache: building... (312 notes)
   ```
11. **Connect transport:** `await server.connect(new StdioServerTransport());`

### Step 2.5 — Setup Wizard (`--setup`)

Interactive readline-based wizard. 4 steps:
1. Connection (API key, host, port, scheme) → test connection immediately
2. Tool mode (granular/consolidated) + preset (full/read-only/minimal/safe)
3. Reliability (verifyWrites, maxResponseChars, debug)
4. Save config file → output Claude Desktop JSON snippet

Use Node's built-in `readline` — no extra dependencies. Only runs when stdout is a TTY.

### Verification

```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | OBSIDIAN_API_KEY=test node dist/index.js
# Should return JSON-RPC response with 38 tools (granular mode)

TOOL_MODE=consolidated OBSIDIAN_API_KEY=test node dist/index.js
# Should show 11 tools
```

---

## Phase 3 — Test, Polish & Package

**Goal:** Test against live Obsidian on dev machine, write all deliverables, open PR.
**Checkpoint:** Smoke tests pass against live Obsidian. All static tools pass. PR open.
**Commit:** `feat: tested, documented, ready for publish`

**Obsidian is running on the dev machine with `mcp-test-vault`.** CC can now run live tests directly. The API key is in the `.env` file or environment variable `OBSIDIAN_API_KEY`.

### Step 3.1 — Smoke Test Script

Create `scripts/smoke-test.ts` — tests both tool modes:

1. Status check (connectivity + auth)
2. List vault files
3. Put a test file (`_smoke_test.md` with a `[[wikilink]]` in content)
4. Read it back + verify content matches
5. Append to it + verify
6. Search for the content
7. Delete it + verify 404
8. Cache: verify cache built (note count > 0)
9. Backlinks: create two linked notes, verify backlink detected, clean up
10. Mode verification: check tool count in granular (38) and consolidated (11)

Add `npm run test:smoke` script. Exit 0 = pass, 1 = fail.

### Step 3.2 — Live Testing (CC runs against mcp-test-vault on dev machine)

**Obsidian is running on the dev machine.** CC can run all live tests directly.

First run the smoke test:
```bash
OBSIDIAN_API_KEY=<key> npm run test:smoke
```

Then run manual tests in order — stop and fix failures before proceeding:
- **Group A (read-only):** status, list vault, list dir, get file (all 3 formats), list commands, simple search, get periodic note, batch get
- **Group B (writes):** put file, get + verify, append + verify, patch under heading + verify, active file put/append/get, periodic note append
- **Group C (navigation):** open_file, open_file with newLeaf, execute_command (safe command like toggle-sidebar)
- **Group D (search):** simple search for written content, JsonLogic (`{"glob": [{"var": "path"}, "*.md"]}`), Dataview DQL (`LIST FROM ""`)
- **Group E (delete):** delete test file → verify gone (404)
- **Group F (periodic by date):** get/put/append/delete for a specific past date
- **Group G (consolidated mode):** re-run key tests with `TOOL_MODE=consolidated`
- **Group H (configure tool):** show config, set debug=true, verify debug logging, reset
- **Group I (cache + graph):** wait for cache build, get_vault_structure (verify note count), get_backlinks on a linked note, get_note_connections, refresh_cache

**Tests the user does manually (CC cannot):**
- **Group J (offline fallback):** user stops Obsidian → verify cached reads → user restarts
- **Desktop Extension:** user installs .mcpb in Claude Desktop, verifies UI form fields

### Step 3.3 — README.md

Structure (in this order):

1. **Title + badges** (TypeScript, MCP SDK version, npm version, license)
2. **One-line description**
3. **Installation** — 3 paths: Desktop Extension (recommended) → npx → Setup Wizard
4. **Quick Start** — just API key, 3 lines of JSON
5. **What's New vs Original** — bullet list of improvements
6. **Tools** — table of all 38 tools (granular names)
7. **Tool Modes** — granular vs consolidated, token comparison
8. **Tool Presets** — full, read-only, minimal, safe
9. **Configuration** — three-tier explanation, env var table, config file format
10. **CLI** — --setup, --version, --show-config, --validate
11. **Debugging** — MCP Inspector, debug logging, --validate
12. **Reliability** — connection recovery, write verification, idempotency, truncation
13. **Optional Plugins** — Dataview, Periodic Notes
14. **Competitive Comparison** — table vs cyanheads, mcpvault, ToKiDoO
15. **Acknowledgments** — mandatory credits (see cc-instructions-final.md)
16. **License** — MIT

### Step 3.4 — CHANGELOG.md

```markdown
# Changelog

## 1.0.0 (2026-03-XX)

Initial release — TypeScript rewrite of mcp-obsidian with full API coverage.

### New
- 38 MCP tools covering 100% of Obsidian Local REST API
- Dual tool mode: granular (38 tools) and consolidated (11 tools)
- Tool presets: full, read-only, minimal, safe
- Tool filtering: INCLUDE_TOOLS / EXCLUDE_TOOLS
- Desktop Extension (.mcpb) for one-click install
- Interactive setup wizard (--setup)
- Self-config tool (configure settings from chat)
- Dataview DQL search
- Full periodic notes CRUD (by current period and by date)
- Command execution
- Open file in Obsidian UI
- Connection recovery with auto-reconnect
- Vault cache with auto-refresh and offline fallback
- Link graph analysis: backlinks, forward links, orphan detection, vault structure
- Write verification (optional read-after-write)
- Case-insensitive path fallback
- search_replace tool
- Configurable timeouts, TLS cert loading, HTTP mode
- Debug logging mode

### Fixed (from upstream)
- Empty directory returns 404 instead of empty list (#98)
- PATCH hangs on invalid target (#3) — mitigated with timeouts
- Search timeout on large vaults (#88)
- Broken recent periodic notes (#92)
- Environment variable defaults ignored (#86)
- Python/pydantic build failures (#100, #9, #45)
```

### Step 3.5 — CI/CD

Create `.github/workflows/ci.yml` — build + lint on Node 22 + 24.

### Step 3.6 — Desktop Extension

Create `manifest.json` in repo root (see cc-instructions-final.md section on MCPB... the full manifest is in the older addendum 6 — use the `user_config` with api_key, tool_mode, tool_preset fields).

Run `npm run pack:mcpb` to produce the .mcpb file.

### Step 3.7 — Example Config File

Create `obsidian-mcp.config.example.json`:
```json
{
  "host": "127.0.0.1",
  "port": 27124,
  "scheme": "https",
  "tools": {
    "mode": "granular",
    "preset": "full",
    "include": [],
    "exclude": []
  },
  "reliability": {
    "timeout": 30000,
    "verifyWrites": false,
    "maxResponseChars": 500000
  },
  "tls": {
    "certPath": null,
    "verifySsl": false
  },
  "debug": false
}
```
Note: `apiKey` intentionally omitted — should be in env var or Claude Desktop config, not in a file that might be committed.

### Step 3.8 — npm Publish Prep

- Ensure `dist/index.js` has shebang (`#!/usr/bin/env node`) — use postbuild script
- `npm link` → `npx mcp-obsidian-extended --version` works
- `npm run build && npm run lint` — clean
- **Do NOT publish yet** — wait for user approval

### Step 3.9 — Claude Desktop Config (for local testing)

```json
{
  "mcpServers": {
    "mcp-obsidian-extended": {
      "command": "node",
      "args": ["/Users/adderclaudedev/projects/mcp-obsidian-extended/dist/index.js"],
      "env": { "OBSIDIAN_API_KEY": "<key>" }
    }
  }
}
```

After npm publish, switch to:
```json
{
  "mcpServers": {
    "mcp-obsidian-extended": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian-extended"],
      "env": { "OBSIDIAN_API_KEY": "<key>" }
    }
  }
}
```

### Post Phase 3

Switch Obsidian back to main vault (restart after switch). Push session notes to `projects/mcp-obsidian-extended/session-02-build.md`.

---

## Code Review — PR Workflow Per Phase

**CodeRabbitAI and Greptile review PRs automatically when opened.** CC should NOT commit directly to main.

### Branch Strategy

```
main (protected)
├── feat/phase-1-scaffold-client-cache    → PR #1 → reviewed → merge
├── feat/phase-2-tools-server-cli         → PR #2 → reviewed → merge
└── feat/phase-3-test-readme-publish      → PR #3 → reviewed → merge
```

### Per-Phase Workflow

1. Create branch: `git checkout -b feat/phase-1-scaffold-client-cache`
2. Build the phase — multiple commits per branch is fine
3. Run **Sonar** locally after `npm run build` — fix critical/high issues before PR
4. Push branch + **open PR** to `main` with description of what the phase covers
5. **CodeRabbitAI** automatically reviews the PR diff — address its feedback
6. **Greptile** automatically reviews the PR with codebase context — address its feedback
7. Push fixes to the same branch until both tools are satisfied
8. **Wait for user approval** — do NOT merge without confirmation
9. Merge PR → start next phase from updated `main`

### Tool Roles

| Tool | How it works | When |
|------|-------------|------|
| **Sonar** | Run locally via CLI after `npm run build` | Before pushing each PR |
| **CodeRabbitAI** | Automatic on PR open — reviews diff, leaves comments | On each PR — fix before merge |
| **Greptile** | Automatic on PR open — codebase-aware review | On each PR — fix before merge |

### What Each Tool Catches

**Phase 1 PR:**
- Sonar: TLS security, credential handling, unhandled rejections, complexity
- CodeRabbitAI/Greptile: Missing endpoints, cache invalidation gaps, error handling paths

**Phase 2 PR:**
- Sonar: `any` types, unchecked index access, input validation
- CodeRabbitAI/Greptile: Tool description quality, Zod schema correctness, consolidated mode validation, tool/client method mapping

**Phase 3 PR:**
- Sonar: Final quality gate — zero critical/high issues
- CodeRabbitAI/Greptile: README completeness, test coverage, config examples

CC fixes all flagged issues before asking user to approve the merge. The PR stays open until all tools pass.

---

## Full Code Verification Toolchain

CC must run ALL of these tools before each PR. All are open source / free tier.

### Security Scanning (run locally before PR)

| Tool | What it does | Command |
|------|-------------|---------|
| **npm audit** | Dependency vulnerability check | `npm audit` |
| **Snyk** | Deep dependency + SAST code scanning | `npx snyk test` + `npx snyk code test` |
| **eslint-plugin-security** | ESLint security rules for Node.js | Add to ESLint config |
| **Semgrep** | Pattern-based SAST for JS/TS | `npx semgrep --config auto src/` |
| **Socket.dev** | Supply chain security — risky dep behaviors | `npx socket npm audit` |

### Code Quality (run locally before PR)

| Tool | What it does | Command |
|------|-------------|---------|
| **Sonar** | Static analysis — bugs, smells, complexity | Run locally or CI |
| **ESLint** | Linting + style + security plugin | `npm run lint` |
| **TypeScript strict** | Compile-time type safety | `npm run build` |
| **Knip** | Unused exports, files, dependencies | `npx knip` |
| **Madge** | Circular dependency detection | `npx madge --circular --extensions ts src/` |
| **Depcheck** | Unused/missing dependencies | `npx depcheck` |

### PR-Level Review (automatic on PR open)

| Tool | What it does |
|------|-------------|
| **CodeRabbitAI** | AI code review on PR diffs |
| **Greptile** | Codebase-aware AI review |

### Package.json Scripts

```json
{
  "scripts": {
    "verify:all": "npm run build && npm run lint && npm audit && npx knip && npx madge --circular --extensions ts src/",
    "security:all": "npx snyk test && npx snyk code test && npx semgrep --config auto src/"
  }
}
```

### ESLint Security Plugin

Add `eslint-plugin-security` to devDependencies and enable in ESLint config.

### Pre-PR Checklist (run before every push)

```bash
npm run verify:all          # build + lint + audit + unused + circular
npm run security:all        # snyk deps + snyk code + semgrep
```

### Zero Tolerance

- npm audit: zero high/critical
- Snyk: zero high/critical in deps or code
- Semgrep: zero findings (or explicitly suppressed with comment)
- ESLint + security plugin: zero errors
- TypeScript: zero errors
- Knip: zero unused exports/files
- Madge: zero circular dependencies
- CodeRabbitAI/Greptile: all feedback addressed
