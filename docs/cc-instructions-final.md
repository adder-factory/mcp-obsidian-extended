# CC Instructions — mcp-obsidian-extended (Final)

**Project:** `mcp-obsidian-extended`
**Local path:** `/Users/adderclaudedev/projects/mcp-obsidian-extended`
**Session:** 02 — Build
**Date:** 2026-03-14

**Read this file first.** Then read `cc-phase-guide.md` for build steps. Use `cc-reference.md` as lookup during implementation. These 3 files are the only instructions — ignore all older `cc-amendment-*` and `cc-addendum-*` files.

---

## What We're Building

A TypeScript MCP server for Obsidian that wraps 100% of the Local REST API. Rewrite of [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) (Python) with full API coverage, upstream bug fixes, token optimization, and user-friendly configuration.

- **Repo:** `https://github.com/adder-factory/mcp-obsidian-extended`
- **Fork of:** `MarkusPfundstein/mcp-obsidian` (Python → TypeScript rewrite)
- **License:** MIT
- **Package:** `mcp-obsidian-extended` (npm, run via `npx`)

---

## Final Numbers

| Metric | Value |
|--------|-------|
| **Tools** | 38 granular / 11 consolidated (includes `configure` + `refresh_cache`, always registered) |
| **Tool modes** | 2 — `granular` (38 individual, default) + `consolidated` (11 combined) |
| **Source files** | 9 |
| **Env vars** | 17 |
| **Install methods** | 4 (Desktop Extension, npx, setup wizard, config file) |
| **CLI flags** | 4 (`--setup`, `--version`, `--show-config`, `--validate`) |

---

## Project Structure

```
mcp-obsidian-extended/
├── .github/workflows/ci.yml    — Build + lint on Node 22 + 24
├── src/
│   ├── index.ts                — Entry point, CLI flags, McpServer + StdioServerTransport
│   ├── config.ts               — Three-tier config loading (defaults → file → env)
│   ├── cache.ts                — Vault cache + link parser + graph analysis
│   ├── obsidian.ts             — HTTP client (all REST methods, TLS, timeouts, locks)
│   ├── tools.ts                — Mode dispatcher + filtering + presets
│   ├── tools/
│   │   ├── granular.ts         — 38 individual tool registrations
│   │   └── consolidated.ts     — 10 consolidated tool registrations
│   ├── schemas.ts              — Shared Zod schemas (format, period, patchOptions)
│   └── errors.ts               — Custom error types
├── scripts/
│   └── smoke-test.ts           — 8-step verification script
├── manifest.json               — MCPB Desktop Extension manifest
├── obsidian-mcp.config.example.json
├── package.json
├── tsconfig.json
├── .node-version               — 22
├── .gitignore
├── CHANGELOG.md
├── LICENSE                     — MIT
└── README.md
```

---

## All Decisions (Locked)

### Language & Runtime
- TypeScript, Node >=22 LTS (enforced via `engines` field)
- MCP SDK: `@modelcontextprotocol/sdk` ^1.24.0 with `McpServer` class
- Zod ^3.25.0 for schema validation (peer dep)
- ESM modules (`"type": "module"`)

### TypeScript Strictness
`strict: true` plus: `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `isolatedModules`, `sourceMap`, `declarationMap`

### Security
- Self-signed cert: `rejectUnauthorized: false` default, `OBSIDIAN_CERT_PATH` for proper verification
- API key: validate on startup, never log, mask in errors, redact from stack traces
- Path sanitization: reject `..`, reject absolute paths, normalize separators
- Request timeouts: 30s default, search gets 2x, configurable via `OBSIDIAN_TIMEOUT`
- Response validation: check content-type before parsing, structured error messages
- Stderr-only logging: never `console.log()`, stdout is MCP transport
- Per-file write locks: prevent concurrent write race conditions
- ESLint: `no-console` error, `no-explicit-any` error, `strict-boolean-expressions` warn

### Tool Architecture
- **Dual mode:** `granular` (38 tools, default) and `consolidated` (11 tools)
- **Presets:** `full`, `read-only`, `minimal`, `safe` (work in both modes)
- **Filtering:** `INCLUDE_TOOLS` / `EXCLUDE_TOOLS` env vars (applied after presets)
- **Protected tools:** `configure`, `status`, and `refresh_cache` always registered regardless of filters
- **Brevity rules:** Tool descriptions max 15 words, parameter descriptions max 10 words
- **Idempotency markers:** non-idempotent tools note "do not retry on timeout"

### Reliability
- **Vault cache:** In-memory cache of all notes + parsed links, auto-refresh every 10 min, offline fallback
- Connection recovery: health check every 30s, auto-reconnect when Obsidian comes back
- Write verification: optional read-after-write for PUT ops (`OBSIDIAN_VERIFY_WRITES`)
- Large file truncation: 500K char default (`OBSIDIAN_MAX_RESPONSE_CHARS`)
- Graceful offline startup: warn but don't crash if Obsidian isn't running
- Debug logging: `OBSIDIAN_DEBUG=true` logs HTTP method/path/status/timing (never bodies/keys)
- Structured errors: every error tells the LLM what to do next

### Configuration
- Three-tier: Defaults → `obsidian-mcp.config.json` → Env vars (env always wins)
- Config file auto-discovered from 4 locations
- `--setup` wizard: interactive readline, tests connection live, creates config file
- `--validate`: tests connection + auth + config
- `--show-config`: prints active config (API key never shown)
- `configure` MCP tool: change runtime settings from chat

### Packaging
- npm publish via `npx`
- Desktop Extension (.mcpb) for one-click install in Claude Desktop
- CI/CD: GitHub Actions build + lint on Node 22 + 24, produce .mcpb artifact

---

## Env Vars (17 total)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OBSIDIAN_API_KEY` | **yes** | — | Bearer token from REST API plugin |
| `OBSIDIAN_HOST` | no | `127.0.0.1` | Obsidian host |
| `OBSIDIAN_PORT` | no | `27124` | REST API port |
| `OBSIDIAN_SCHEME` | no | `https` | `https` or `http` (http skips all TLS) |
| `OBSIDIAN_TIMEOUT` | no | `30000` | Request timeout ms (search gets 2x) |
| `OBSIDIAN_CERT_PATH` | no | — | Path to .crt for TLS verification |
| `OBSIDIAN_VERIFY_SSL` | no | `false` | Strict TLS verification |
| `OBSIDIAN_VERIFY_WRITES` | no | `false` | Read-after-write verification for PUT ops |
| `OBSIDIAN_MAX_RESPONSE_CHARS` | no | `500000` | Truncation limit (0=disabled) |
| `OBSIDIAN_DEBUG` | no | `false` | HTTP debug logging to stderr |
| `OBSIDIAN_CONFIG` | no | — | Custom path to config file |
| `TOOL_MODE` | no | `granular` | `granular` (38 tools) or `consolidated` (11 tools) |
| `TOOL_PRESET` | no | `full` | `full`, `read-only`, `minimal`, `safe` |
| `INCLUDE_TOOLS` | no | — | Whitelist tool names (comma-separated) |
| `EXCLUDE_TOOLS` | no | — | Blacklist tool names (comma-separated) |
| `OBSIDIAN_CACHE_TTL` | no | `600000` | Cache refresh interval ms (default 10 min) |
| `OBSIDIAN_ENABLE_CACHE` | no | `true` | Enable/disable vault cache |

Config priority: Defaults → Config file → Env vars (env always wins)

Config file search order: `OBSIDIAN_CONFIG` → `./obsidian-mcp.config.json` → `~/.obsidian-mcp.config.json` → `~/.config/obsidian-mcp/config.json`

---

## Tool List — Granular Mode (38 tools)

### Vault Files (8)
| # | Name | Method | Endpoint | Notes |
|---|------|--------|----------|-------|
| 1 | `list_files_in_vault` | GET | `/vault/` | |
| 2 | `list_files_in_dir` | GET | `/vault/{dir}/` | Handle empty dir 404 gracefully |
| 3 | `get_file_contents` | GET | `/vault/{path}` | Formats: markdown, json, map |
| 4 | `put_content` | PUT | `/vault/{path}` | Idempotent |
| 5 | `append_content` | POST | `/vault/{path}` | NOT idempotent |
| 6 | `patch_content` | PATCH | `/vault/{path}` | NOT idempotent. Mention createIfMissing + map hint |
| 7 | `delete_file` | DELETE | `/vault/{path}` | Idempotent. REST API only — never filesystem |
| 8 | `search_replace` | compound | GET+PUT | NOT idempotent. String find/replace in file |

### Active File (5)
| # | Name | Method | Endpoint |
|---|------|--------|----------|
| 9 | `get_active_file` | GET | `/active/` |
| 10 | `put_active_file` | PUT | `/active/` |
| 11 | `append_active_file` | POST | `/active/` |
| 12 | `patch_active_file` | PATCH | `/active/` |
| 13 | `delete_active_file` | DELETE | `/active/` |

### Commands (2)
| # | Name | Method | Endpoint |
|---|------|--------|----------|
| 14 | `list_commands` | GET | `/commands/` |
| 15 | `execute_command` | POST | `/commands/{id}/` |

### Open (1)
| # | Name | Method | Endpoint |
|---|------|--------|----------|
| 16 | `open_file` | POST | `/open/{path}` |

### Search (3)
| # | Name | Method | Endpoint | Content-Type |
|---|------|--------|----------|--------------|
| 17 | `simple_search` | POST | `/search/simple/` | — |
| 18 | `complex_search` | POST | `/search/` | `application/vnd.olrapi.jsonlogic+json` |
| 19 | `dataview_search` | POST | `/search/` | `application/vnd.olrapi.dataview.dql+txt` |

### Periodic Notes — Current (5)
| # | Name | Method | Endpoint |
|---|------|--------|----------|
| 20 | `get_periodic_note` | GET | `/periodic/{period}/` |
| 21 | `put_periodic_note` | PUT | `/periodic/{period}/` |
| 22 | `append_periodic_note` | POST | `/periodic/{period}/` |
| 23 | `patch_periodic_note` | PATCH | `/periodic/{period}/` |
| 24 | `delete_periodic_note` | DELETE | `/periodic/{period}/` |

### Periodic Notes — By Date (5)
| # | Name | Method | Endpoint |
|---|------|--------|----------|
| 25 | `get_periodic_note_for_date` | GET | `/periodic/{period}/{y}/{m}/{d}/` |
| 26 | `put_periodic_note_for_date` | PUT | `/periodic/{period}/{y}/{m}/{d}/` |
| 27 | `append_periodic_note_for_date` | POST | `/periodic/{period}/{y}/{m}/{d}/` |
| 28 | `patch_periodic_note_for_date` | PATCH | `/periodic/{period}/{y}/{m}/{d}/` |
| 29 | `delete_periodic_note_for_date` | DELETE | `/periodic/{period}/{y}/{m}/{d}/` |

### System (1)
| # | Name | Method | Endpoint |
|---|------|--------|----------|
| 30 | `get_server_status` | GET | `/` | **Protected — always registered** |

### Custom / Derived (3)
| # | Name | Implementation |
|---|------|----------------|
| 31 | `batch_get_file_contents` | Multiple GET /vault/{path} |
| 32 | `get_recent_changes` | Derived from vault listing + stat.mtime |
| 33 | `get_recent_periodic_notes` | Derived from periodic notes dir listing |

### Meta (1)
| # | Name | Implementation |
|---|------|----------------|
| 34 | `configure` | Read/write config file + in-memory settings. **Protected — always registered** |

### Vault Analysis (4)
| # | Name | Implementation |
|---|------|----------------|
| 35 | `get_backlinks` | From cache: all notes linking to a given file, with context |
| 36 | `get_vault_structure` | From cache: directory tree, link graph summary, orphans, most connected |
| 37 | `get_note_connections` | From cache: backlinks + forward links for a note |
| 38 | `refresh_cache` | Force refresh vault cache and link graph. **Protected — always registered** |

---

## Tool List — Consolidated Mode (10 tools)

| # | Name | Replaces | Actions |
|---|------|----------|---------|
| 1 | `vault` | Tools 1-8 | list, list_dir, get, put, append, patch, delete, search_replace |
| 2 | `active_file` | Tools 9-13 | get, put, append, patch, delete |
| 3 | `commands` | Tools 14-15 | list, execute |
| 4 | `open_file` | Tool 16 | (no action param — stays simple) |
| 5 | `search` | Tools 17-19 | simple, jsonlogic, dataview |
| 6 | `periodic_note` | Tools 20-29 | get, put, append, patch, delete (+ optional date params) |
| 7 | `status` | Tool 30 | (no action param) **Protected** |
| 8 | `batch_get` | Tool 31 | (no action param) |
| 9 | `recent` | Tools 32-33 | changes, periodic_notes |
| 10 | `configure` | Tool 34 | show, set, reset. **Protected** |
| 11 | `vault_analysis` | Tools 35-38 | backlinks, connections, structure, refresh_cache |

INCLUDE_TOOLS/EXCLUDE_TOOLS uses the tool names of the active mode. In granular mode: `get_file_contents`, `simple_search`, etc. In consolidated mode: `vault`, `search`, etc.

---

## Tool Presets

Applied before INCLUDE/EXCLUDE. Priority: Preset → INCLUDE/EXCLUDE → final set.

### Granular mode
- `full` — all 38 tools (default)
- `read-only` — 20 tools: all GET operations + search + analysis + status + configure
- `minimal` — 7 tools: list_files_in_vault, get_file_contents, append_content, simple_search, get_server_status, batch_get_file_contents, configure
- `safe` — 34 tools: all 38 minus delete_file, delete_active_file, delete_periodic_note, delete_periodic_note_for_date

### Consolidated mode
- `full` — all 11 tools, all actions (default)
- `read-only` — all 11 tools but only read actions (get/list/backlinks/connections/structure)
- `minimal` — 4 tools: vault(list, get, append), search(simple only), status, configure
- `safe` — all 11 tools but delete action removed from vault, active_file, periodic_note

---

## Upstream Bugs We Fix

| Bug | Original Issue | Our Fix |
|-----|---------------|---------|
| Empty dir returns 404 | #98 | `listFilesInDir()` catches 404, checks dir existence, returns empty list |
| PATCH hangs on invalid target | #3 | Request timeout (30s) + tool description warns to use `format='map'` first |
| Search timeout on large vaults | #88 | Configurable timeout, search gets 2x |
| Broken recent periodic notes | #92 | Derived implementation (list dir + parse dates), not API call |
| No HTTP/cert support | #91 | `OBSIDIAN_SCHEME=http`, `OBSIDIAN_CERT_PATH` |
| Env var defaults ignored | #86 | Explicit defaults in config.ts |
| pydantic/Python build failures | #100, #9, #45 | TypeScript rewrite eliminates Python entirely |

---

## Competitive Advantages

| Feature | Us | cyanheads (363★) | mcpvault (~50★) | ToKiDoO (6★) |
|---------|-----|-----------|----------|---------|
| 100% REST API | ✅ 38 tools | ❌ 8 | ❌ 14 (filesystem) | ❌ ~15 |
| Tool filtering | ✅ | ❌ | ❌ | ✅ |
| Dual mode (granular/consolidated) | ✅ | ❌ | ❌ | ❌ |
| Dataview DQL | ✅ | ❌ | ❌ | ❌ |
| Periodic notes (full CRUD + by-date) | ✅ | ❌ | ❌ | ❌ |
| Desktop Extension (.mcpb) | ✅ | ❌ | ❌ | ❌ |
| Self-config tool | ✅ | ❌ | ❌ | ❌ |
| Setup wizard | ✅ | ❌ | ❌ | ❌ |
| Configurable timeouts | ✅ | ❌ | N/A | ❌ |
| Vault cache + offline fallback | ✅ | ✅ | ❌ | ❌ |
| Link graph / backlink analysis | ✅ (REST-only) | ❌ | ❌ | ✅ (filesystem) |

Ideas borrowed (credited in README):
- Case-insensitive path fallback — from cyanheads
- search_replace tool — from cyanheads
- INCLUDE_TOOLS filtering — from ToKiDoO
- Path traversal protection — from bitbonsai

---

## Acknowledgments (mandatory in README)

```markdown
## Acknowledgments

This project is a TypeScript rewrite of [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) by **Markus Pfundstein**, which pioneered the MCP server approach for Obsidian.

The Obsidian integration is made possible by [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) by **Adam Coddington**.

Design inspirations from the community:
- **Case-insensitive path fallback** and **search-replace tool** — [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) by **cyanheads**
- **Tool filtering** — [mcp-obsidian-advanced](https://github.com/ToKiDoO/mcp-obsidian-advanced) by **ToKiDoO**
- **Path traversal protection** — [mcpvault](https://github.com/bitbonsai/mcpvault) by **bitbonsai**
- **Graph analysis concept** — [mcp-obsidian-advanced](https://github.com/ToKiDoO/mcp-obsidian-advanced) by **ToKiDoO** and [obsidiantools](https://github.com/mfarragher/obsidiantools) by **mfarragher**
- **Vault cache concept** — [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) by **cyanheads**

Thank you to all upstream bug reporters whose detailed issues shaped our fixes.
```

---

## Critical Rules

1. All file operations through REST API — **never filesystem access**
2. `delete_file` uses DELETE /vault/{path} — **never rm**
3. All logging to **stderr** — stdout is MCP transport
4. **Never log the API key** — not in debug, not in errors, not in stack traces
5. Test against `mcp-test-vault` — **never destructive tests on main vault**
6. When on test vault, buffer session notes locally — push to main vault when done
7. **Branch per phase. Open PR. Fix CodeRabbitAI + Greptile feedback. Wait for user approval before merge.**
8. **Obsidian + mcp-test-vault runs on the dev machine.** CC can run live tests in Phase 3. User handles offline fallback testing and .mcpb install testing.

---

## Future / v2 Roadmap (not in v1)

- `read_note_aloud` — Web Speech API, reads notes through Mac speakers
- Anthropic Directory submission — after v1 launch

---

## Code Review Tools Available

CC has access to these tools — use them throughout the build:

- **Sonar** — static analysis. Run locally after each `npm run build`, before pushing PR. Fix critical/high issues.
- **CodeRabbitAI** — AI code review. Runs automatically when a PR is opened on GitHub. Reviews the diff, leaves inline comments. CC addresses feedback before requesting merge.
- **Greptile** — codebase-aware AI review. Runs automatically on PR open. Understands the full repo context. CC addresses feedback before requesting merge.

### Git Workflow

CC creates a **feature branch per phase** and opens a **PR to main** for each:

```
main (protected)
├── feat/phase-1-scaffold-client-cache    → PR #1 → Sonar + CodeRabbitAI + Greptile → merge
├── feat/phase-2-tools-server-cli         → PR #2 → Sonar + CodeRabbitAI + Greptile → merge
└── feat/phase-3-test-readme-publish      → PR #3 → Sonar + CodeRabbitAI + Greptile → merge
```

CC does NOT commit directly to main. Each PR must pass ALL verification tools before requesting user approval to merge.

### Full Verification Toolchain (all open source / free)

**Security:** `npm audit` + `npx snyk test` + `npx snyk code test` + `npx semgrep --config auto src/` + `eslint-plugin-security` + `npx socket npm audit`
**Quality:** Sonar + ESLint + TypeScript strict + `npx knip` (unused code) + `npx madge --circular` (circular deps) + `npx depcheck` (unused deps)
**PR Review:** CodeRabbitAI + Greptile (automatic on PR open)

**Zero tolerance:** Zero critical/high in all tools. Zero unused code. Zero circular deps. All PR feedback addressed.
