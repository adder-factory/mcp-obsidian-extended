# mcp-obsidian-extended

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.27-green.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

Full-featured MCP server for Obsidian — 39 tools covering 100% of the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

## Prerequisites

Install and enable the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin. Copy the API key from Obsidian Settings → Local REST API.

## Installation

### Option 1: npx (recommended)

Add to your Claude Desktop config:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-obsidian-extended": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian-extended"],
      "env": {
        "OBSIDIAN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Option 2: Setup Wizard

```bash
npx mcp-obsidian-extended --setup
```

Interactive wizard that tests your connection, configures settings, and outputs the Claude Desktop JSON snippet.

### Option 3: Standalone Binary (no Node.js required)

Download the platform binary from [Releases](https://github.com/adder-factory/mcp-obsidian-extended/releases):

```json
{
  "mcpServers": {
    "mcp-obsidian-extended": {
      "command": "/path/to/mcp-obsidian-extended",
      "env": { "OBSIDIAN_API_KEY": "your-api-key-here" }
    }
  }
}
```

### Option 4: Desktop Extension

Download the `.mcpb` file from [Releases](https://github.com/adder-factory/mcp-obsidian-extended/releases) and open it in Claude Desktop for one-click install.

## What's New vs the Original

This is a TypeScript rewrite of [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) with:

- **100% REST API coverage** — 39 tools vs the original 7
- **Dual tool mode** — granular (39 tools) or consolidated (11 tools, saves tokens)
- **Tool presets** — full, read-only, minimal, safe
- **Tool filtering** — INCLUDE_TOOLS / EXCLUDE_TOOLS env vars
- **LLM Skill resource** — `obsidian://skill` teaches LLMs best practices, adapts to tool mode and compact setting
- **Compact responses** — abbreviate field names for token savings (`OBSIDIAN_COMPACT_RESPONSES=true`)
- **Move/rename files** — `move_file` tool with conflict detection and partial-failure recovery
- **Standalone binary** — `npm run build:sea` produces a binary that doesn't require Node.js
- **Dataview DQL search** — query vault using the Dataview plugin
- **Full periodic notes** — CRUD by current period and by specific date
- **Vault cache + graph analysis** — backlinks, orphan detection, vault structure
- **Connection recovery** — auto-reconnect when Obsidian comes back
- **Self-config tool** — change settings from chat without restarting
- **Setup wizard** — interactive `--setup` for first-time configuration
- **Upstream bug fixes** — empty dir 404, search timeouts, broken periodic notes

## Tools

### Granular Mode (39 tools, default)

| #   | Tool                            | Description                                             |
| --- | ------------------------------- | ------------------------------------------------------- |
| 1   | `list_files_in_vault`           | List all files and directories in vault root            |
| 2   | `list_files_in_dir`             | List files in a vault directory                         |
| 3   | `get_file_contents`             | Read a vault file as markdown, JSON, or document map    |
| 4   | `put_content`                   | Create or overwrite a vault file (idempotent)           |
| 5   | `append_content`                | Append to a vault file                                  |
| 6   | `patch_content`                 | Insert at a heading, block, or frontmatter target       |
| 7   | `delete_file`                   | Delete a vault file to Obsidian trash (idempotent)      |
| 8   | `search_replace`                | Find and replace text in a vault file                   |
| 9   | `move_file`                     | Move or rename a .md vault file                         |
| 10  | `get_active_file`               | Read the currently open file                            |
| 11  | `put_active_file`               | Replace content of the currently open file              |
| 12  | `append_active_file`            | Append to the currently open file                       |
| 13  | `patch_active_file`             | Patch the active file at a target                       |
| 14  | `delete_active_file`            | Delete the currently open file                          |
| 15  | `list_commands`                 | List all Obsidian command palette commands              |
| 16  | `execute_command`               | Run an Obsidian command by ID                           |
| 17  | `open_file`                     | Open a file in the Obsidian UI                          |
| 18  | `simple_search`                 | Full-text search across all vault files                 |
| 19  | `complex_search`                | Search with JsonLogic queries (glob, regexp)            |
| 20  | `dataview_search`               | Query vault using Dataview DQL                          |
| 21  | `get_periodic_note`             | Get the current periodic note                           |
| 22  | `put_periodic_note`             | Replace current periodic note content                   |
| 23  | `append_periodic_note`          | Append to current periodic note                         |
| 24  | `patch_periodic_note`           | Patch current periodic note at a target                 |
| 25  | `delete_periodic_note`          | Delete current periodic note                            |
| 26  | `get_periodic_note_for_date`    | Get periodic note for a specific date                   |
| 27  | `put_periodic_note_for_date`    | Replace periodic note for a date                        |
| 28  | `append_periodic_note_for_date` | Append to periodic note for a date                      |
| 29  | `patch_periodic_note_for_date`  | Patch periodic note for a date                          |
| 30  | `delete_periodic_note_for_date` | Delete periodic note for a date                         |
| 31  | `get_server_status`             | Check Obsidian API connection and version               |
| 32  | `batch_get_file_contents`       | Read multiple vault files in one call                   |
| 33  | `get_recent_changes`            | Get recently modified files sorted by date              |
| 34  | `get_recent_periodic_notes`     | Get recent periodic notes for a period type             |
| 35  | `configure`                     | View or change server settings, or load LLM usage guide |
| 36  | `get_backlinks`                 | Get all notes that link to a file                       |
| 37  | `get_vault_structure`           | Vault stats: note count, links, orphans, most connected |
| 38  | `get_note_connections`          | Get backlinks and forward links for a note              |
| 39  | `refresh_cache`                 | Force refresh vault cache and link graph                |

### Consolidated Mode (11 tools)

Combines related tools into multi-action tools. Reduces the tool list sent to the LLM, saving tokens on every request.

| #   | Tool             | Actions                                                               | Replaces    |
| --- | ---------------- | --------------------------------------------------------------------- | ----------- |
| 1   | `vault`          | list, list_dir, get, put, append, patch, delete, search_replace, move | Tools 1-9   |
| 2   | `active_file`    | get, put, append, patch, delete                                       | Tools 10-14 |
| 3   | `commands`       | list, execute                                                         | Tools 15-16 |
| 4   | `open_file`      | —                                                                     | Tool 17     |
| 5   | `search`         | simple, jsonlogic, dataview                                           | Tools 18-20 |
| 6   | `periodic_note`  | get, put, append, patch, delete                                       | Tools 21-30 |
| 7   | `status`         | —                                                                     | Tool 31     |
| 8   | `batch_get`      | —                                                                     | Tool 32     |
| 9   | `recent`         | changes, periodic_notes                                               | Tools 33-34 |
| 10  | `configure`      | show, set, reset, skill                                               | Tool 35     |
| 11  | `vault_analysis` | backlinks, connections, structure, refresh                            | Tools 36-39 |

Set `TOOL_MODE=consolidated` to enable.

## Tool Presets

Control which tools are available. Set via `TOOL_PRESET` env var.

| Preset      | Granular | Consolidated                | Description               |
| ----------- | -------- | --------------------------- | ------------------------- |
| `full`      | 39 tools | 11 tools, all actions       | Everything (default)      |
| `read-only` | 19 tools | 10 tools, read actions only | No writes or deletes      |
| `minimal`   | 8 tools  | 4 tools                     | Essentials only           |
| `safe`      | 35 tools | 11 tools, no delete action  | Everything except deletes |

### Tool Filtering

Fine-tune beyond presets with `INCLUDE_TOOLS` and `EXCLUDE_TOOLS` (comma-separated tool names).

```bash
# Only allow read + search in granular mode
INCLUDE_TOOLS=list_files_in_vault,get_file_contents,simple_search

# Allow everything except deletes in granular mode
EXCLUDE_TOOLS=delete_file,delete_active_file,delete_periodic_note,delete_periodic_note_for_date
```

Protected tools (`configure`, `get_server_status`/`status`, `refresh_cache`/`vault_analysis`) are always registered regardless of filters.

## Configuration

Three-tier priority: **Defaults → Config file → Env vars** (env always wins).

### Environment Variables

| Variable                      | Default      | Description                                   |
| ----------------------------- | ------------ | --------------------------------------------- |
| `OBSIDIAN_API_KEY`            | _(required)_ | Bearer token from REST API plugin             |
| `OBSIDIAN_HOST`               | `127.0.0.1`  | Obsidian host                                 |
| `OBSIDIAN_PORT`               | `27124`      | REST API port                                 |
| `OBSIDIAN_SCHEME`             | `https`      | `https` or `http`                             |
| `OBSIDIAN_TIMEOUT`            | `30000`      | Request timeout ms (search gets 2x)           |
| `OBSIDIAN_CERT_PATH`          | —            | Path to .crt for TLS verification             |
| `OBSIDIAN_VERIFY_SSL`         | `false`      | Strict TLS verification                       |
| `OBSIDIAN_VERIFY_WRITES`      | `false`      | Read-after-write verification                 |
| `OBSIDIAN_MAX_RESPONSE_CHARS` | `500000`     | Truncation limit (0 = disabled)               |
| `OBSIDIAN_DEBUG`              | `false`      | HTTP debug logging to stderr                  |
| `OBSIDIAN_CONFIG`             | —            | Custom config file path                       |
| `TOOL_MODE`                   | `granular`   | `granular` or `consolidated`                  |
| `TOOL_PRESET`                 | `full`       | `full`, `read-only`, `minimal`, `safe`        |
| `INCLUDE_TOOLS`               | —            | Whitelist tool names (comma-separated)        |
| `EXCLUDE_TOOLS`               | —            | Blacklist tool names (comma-separated)        |
| `OBSIDIAN_CACHE_TTL`          | `600000`     | Cache refresh interval ms (10 min)            |
| `OBSIDIAN_ENABLE_CACHE`       | `true`       | Enable/disable vault cache                    |
| `OBSIDIAN_COMPACT_RESPONSES`  | `false`      | Abbreviate JSON field names for token savings |

### Config File

Auto-discovered from (in order):

1. `OBSIDIAN_CONFIG` env var
2. `./obsidian-mcp.config.json`
3. `~/.obsidian-mcp.config.json`
4. `~/.config/obsidian-mcp/config.json`

See [`obsidian-mcp.config.example.json`](./obsidian-mcp.config.example.json) for the full format. The API key should be in an env var or Claude Desktop config — not in a file that might be committed.

## CLI

```bash
npx mcp-obsidian-extended --setup        # Interactive setup wizard
npx mcp-obsidian-extended --version      # Print version
npx mcp-obsidian-extended --show-config  # Print active config (API key redacted)
npx mcp-obsidian-extended --validate     # Test connection + auth
```

## Debugging

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### Debug Logging

Set `OBSIDIAN_DEBUG=true` to log HTTP method/path/status/timing to stderr. Never logs request bodies or auth headers.

### Validate Connection

```bash
OBSIDIAN_API_KEY=your-key npx mcp-obsidian-extended --validate
```

### Server Logs

```bash
# macOS
tail -f ~/Library/Logs/Claude/mcp-server-mcp-obsidian-extended.log

# Windows
Get-Content "$env:APPDATA\Claude\Logs\mcp-server-mcp-obsidian-extended.log" -Wait
```

## Reliability

- **Connection recovery** — health check every 30s, auto-reconnect when Obsidian comes back
- **Graceful offline startup** — warns but doesn't crash if Obsidian isn't running
- **Write verification** — optional read-after-write for PUT ops (`OBSIDIAN_VERIFY_WRITES=true`)
- **Write locks** — per-file serialization prevents concurrent write races
- **Idempotent operations** — PUT and DELETE are safe to retry on timeout
- **Response truncation** — large files capped at 500K chars (configurable)
- **Vault cache** — in-memory cache with auto-refresh, serves cached reads when offline
- **Case-insensitive paths** — automatic fallback on 404 for mismatched case

## LLM Skill Resource

The server exposes an MCP resource at `obsidian://skill` — a dynamic usage guide that teaches LLMs how to use the tools effectively. Content adapts based on active tool mode (granular/consolidated) and compact response setting.

Covers: golden rules, step-by-step workflows, error recovery, tool selection guide, known pitfalls, and (when applicable) consolidated action reference and compact field mapping.

Also ships as `.claude/skills/obsidian-mcp/SKILL.md` for Claude Code users. Additionally, `configure({ action: "skill" })` returns the guide as tool output — useful for clients that don't expose MCP resources to conversations.

### Claude.ai Setup

Claude.ai registers MCP resources but does not currently expose them to conversations. Use one of these options to load the skill guide:

**Option A: Upload Skill (recommended)** — Download `mcp-obsidian-extended.zip` from [Releases](https://github.com/adder-factory/mcp-obsidian-extended/releases). In Claude.ai, go to Customize → Skills → "+" → Upload and select the ZIP. Requires Code execution to be enabled. Per-user (does not sync across surfaces).

**Option B: Auto-load per session** — Add to your Project Instructions: _"Call `configure({ action: 'skill' })` at the start of each conversation."_ One tool call, always returns the latest guide tailored to the active mode and compact setting.

**Option C: Claude Code (automatic)** — `SKILL.md` ships in the npm package. Claude Code reads it automatically when the server is configured.

**Option D: API** — Upload via the Skills API: `POST /v1/skills` with the `anthropic-beta: skills-2025-01-01` header.

> **Important:** `TOOL_MODE=consolidated` is strongly recommended for Claude.ai. Granular mode registers 39 tools, which can exceed Claude.ai's platform tool loading limits — in testing, only 34 of 39 tools loaded (missing patch_content, move_file, configure, get_recent_changes, get_recent_periodic_notes). Consolidated mode's 11 tools load reliably and save ~42% on tool registration tokens.

## Compact Responses

Set `OBSIDIAN_COMPACT_RESPONSES=true` to abbreviate JSON field names (`content`→`c`, `frontmatter`→`fm`, `path`→`p`, etc.) and strip JSON whitespace. Reduces token usage for large vault operations. Toggle at runtime via the `configure` tool without restart.

### Token Savings: Granular + Verbose vs Consolidated + Compact

Measured against a live Obsidian vault with real notes, links, and search results:

**Tool Registration Overhead (sent to LLM on every request)**

| Mode                   | Tools | Size         | Savings   |
| ---------------------- | ----- | ------------ | --------- |
| Granular (default)     | 39    | 32,772 chars | —         |
| Consolidated + compact | 11    | 18,911 chars | **42.3%** |

**Response Size Comparison (same data, both modes)**

| Response Type            | Verbose     | Compact     | Savings |
| ------------------------ | ----------- | ----------- | ------- |
| NoteJson (format:json)   | 602 chars   | 468 chars   | 22.3%   |
| DocumentMap (format:map) | 213 chars   | 133 chars   | 37.6%   |
| Search results           | 464 chars   | 330 chars   | 28.9%   |
| Vault structure          | 639 chars   | 348 chars   | 45.5%   |
| Note connections         | 597 chars   | 434 chars   | 27.3%   |
| Command list             | 1,885 chars | 1,357 chars | 28.0%   |

**Combined Session Overhead (tool defs + skill resource + 10 tool calls)**

| Configuration          | Total        | Estimated Tokens | Savings   |
| ---------------------- | ------------ | ---------------- | --------- |
| Granular + verbose     | 44,119 chars | ~11,030 tokens   | —         |
| Consolidated + compact | 31,283 chars | ~7,821 tokens    | **29.1%** |

Savings of **~3,200 tokens per session**. The biggest win is tool registration (42.3%) — sent on every LLM request. Response savings (27.4%) compound across multi-tool conversations.

## Performance

Benchmarked against Obsidian Local REST API on macOS with mcp-test-vault.

### Stress Test — 395K Operations

| Metric           | Result                                                         |
| ---------------- | -------------------------------------------------------------- |
| Duration         | 307.6s                                                         |
| Total operations | 394,607                                                        |
| Throughput       | 1,282 ops/s                                                    |
| Error rate       | 0.01% (33/394K — read timeouts during cache rebuild, expected) |
| Memory (heap)    | 27.9MB stable (no memory leak)                                 |
| Crashes          | 0                                                              |

### Latency Percentiles

| Operation      | Count  | p50 | p95 | p99  |
| -------------- | ------ | --- | --- | ---- |
| get            | 98,750 | 0ms | 1ms | 3ms  |
| put            | 59,261 | 1ms | 2ms | 3ms  |
| append         | 39,619 | 1ms | 2ms | 4ms  |
| search         | 39,522 | 0ms | 1ms | 2ms  |
| list           | 39,406 | 0ms | 1ms | 1ms  |
| get_json       | 39,329 | 0ms | 1ms | 3ms  |
| cache_rebuild  | 19,714 | 6ms | 9ms | 12ms |
| delete_put     | 19,667 | 1ms | 3ms | 5ms  |
| search_replace | 19,643 | 1ms | 4ms | 6ms  |

Sub-millisecond reads at p50. Stable memory after 395K operations. Write locks serialize correctly under concurrent load. Cache rebuilds don't block reads.

### Full-Coverage Stress Test — All 55 Tools

| Metric           | Result                                        |
| ---------------- | --------------------------------------------- |
| Duration         | 323s                                          |
| Total operations | 379,557                                       |
| Throughput       | 1,175 ops/s                                   |
| Error rate       | 0.24% (916/380K — all gracefully handled)     |
| Tool coverage    | 55/55 (35 granular + 20 consolidated actions) |
| Memory (heap)    | 17.8MB stable (no memory leak)                |
| Crashes          | 0                                             |

Error breakdown:

- `patch_*` operations: 722 errors (0.19%) — heading structure race conditions under concurrent writes
- `get`/`batch_get` timeouts: 194 errors — 30s timeouts during heavy cache rebuilds

All errors are gracefully handled with structured error messages. No crashes, no data corruption.

### Advanced Stress Tests — Edge Case Validation

6 targeted scenarios testing reliability under extreme conditions:

| Scenario                  | Duration | Ops   | Result | Key Finding                                                |
| ------------------------- | -------- | ----- | ------ | ---------------------------------------------------------- |
| Heading Mismatch Recovery | 3m       | 8,763 | PASS   | 89.5% PATCH success under concurrent heading restructuring |
| Cache Stampede            | 14ms     | 42    | PASS   | 20 concurrent waiters, 1 build only, zero redundant builds |
| Large Vault Scale         | 385ms    | 292   | PASS   | 205 notes/789 links cached in 136ms                        |
| Write Contention Torture  | 3m       | 7,145 | PASS   | 0% errors, file lock serialization holds                   |
| Periodic Notes Date Sweep | 15m      | 60    | PASS   | All date edge cases handled                                |
| Error Cascade Recovery    | 59ms     | 58    | PASS   | 0 unhandled exceptions, auto-recovery works                |

Totals: 16,360 ops | p50=2ms | p95=37ms | 19.3MB heap stable | 6/6 pass

### Combined Benchmark Summary

| Test Suite            | Operations   | Key Result                              |
| --------------------- | ------------ | --------------------------------------- |
| Stress test           | 225          | 10/10 scenarios, write locks verified   |
| Extended benchmark    | 394,607      | 1,282 ops/s, 0.01% error rate           |
| Full tool coverage    | 379,557      | 55/55 tools exercised, 1,175 ops/s      |
| Advanced stress tests | 16,360       | 6/6 edge case scenarios pass            |
| **Grand total**       | **~790,749** | **Zero crashes. Zero data corruption.** |

## Optional Plugins

| Plugin                                                                      | Required For                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | **All functionality** (required)                            |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview)               | `dataview_search` tool                                      |
| [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes)       | Periodic note tools (daily/weekly/monthly/quarterly/yearly) |

## Comparison

| Feature               | mcp-obsidian-extended           | mcp-obsidian (original) | cyanheads (363★) | mcpvault (~50★) | ToKiDoO (6★) |
| --------------------- | ------------------------------- | ----------------------- | ---------------- | --------------- | ------------ |
| Language              | TypeScript                      | Python                  | TypeScript       | TypeScript      | TypeScript   |
| Install               | npx / .mcpb                     | uvx (requires Python)   | npx              | npx             | npx          |
| Tools                 | 39 granular / 11 consolidated   | 7                       | 8                | 14 (filesystem) | ~15          |
| REST API coverage     | 100%                            | ~20%                    | ~25%             | 0% (filesystem) | ~40%         |
| Tool filtering        | INCLUDE/EXCLUDE + presets       | —                       | —                | —               | INCLUDE only |
| Dual mode             | granular + consolidated         | —                       | —                | —               | —            |
| Dataview DQL          | Yes (TABLE queries)             | —                       | —                | —               | —            |
| Active file ops       | Full CRUD                       | —                       | —                | —               | —            |
| Commands              | list + execute                  | —                       | —                | —               | —            |
| Periodic notes        | Full CRUD + by date             | —                       | —                | —               | —            |
| Self-config tool      | Yes (from chat)                 | —                       | —                | —               | —            |
| Setup wizard          | Yes (--setup)                   | —                       | —                | —               | —            |
| Desktop Extension     | .mcpb one-click install         | —                       | —                | —               | —            |
| Configurable timeouts | Yes                             | —                       | —                | N/A             | —            |
| Vault cache + offline | REST-only cache                 | —                       | Yes              | —               | —            |
| Graph analysis        | Backlinks, orphans, connections | —                       | —                | —               | Filesystem   |
| Write locks           | Per-file mutex                  | —                       | —                | —               | —            |
| Benchmarked           | 395K ops, 1,282 ops/s           | —                       | —                | —               | —            |
| CI/CD                 | GitHub Actions                  | —                       | —                | —               | —            |
| Known bugs            | Fixed (7 upstream)              | 50+ open issues         | —                | —               | —            |

> mcp-obsidian-extended is a TypeScript rewrite of [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) by Markus Pfundstein, which pioneered the MCP server approach for Obsidian. We fix 7 upstream bugs and expand from 7 tools to 39 with full API coverage.

## Known Limitations

- **move_file is .md only:** Non-markdown files (images, PDFs) cannot be moved via the REST API content endpoint — the text round-trip would corrupt binary data. Wikilinks from other notes pointing to the moved file are not updated automatically.
- **PATCH under concurrent writes:** When multiple writers restructure headings simultaneously, PATCH operations may fail to find their target. With automatic retry and document map refresh, success rate is 89.5% under extreme concurrent load (up from ~5% without retry). Under normal single-user usage, PATCH success is ~99%+. For heavy concurrent editing scenarios, prefer `search_replace` over `patch_content`.
- **Dataview queries:** Only `TABLE` queries are supported by the Obsidian Local REST API. `LIST` queries are not supported — this is an upstream API limitation, not a server limitation. Use `TABLE` with column selection as a workaround.
- **Cache rebuild contention:** During cache rebuilds on large vaults (500+ notes), read operations may experience brief timeouts (~0.05% of requests). The server handles this gracefully with automatic retries. Cache stampede is prevented — 20 concurrent callers share a single build with zero redundant builds.

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

## License

[MIT](./LICENSE)
