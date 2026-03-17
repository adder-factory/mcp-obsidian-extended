# mcp-obsidian-extended

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.24-green.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

Full-featured MCP server for Obsidian — 38 tools covering 100% of the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

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

### Option 3: Desktop Extension

Download the `.mcpb` file from [Releases](https://github.com/adder-factory/mcp-obsidian-extended/releases) and open it in Claude Desktop for one-click install.

## What's New vs the Original

This is a TypeScript rewrite of [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) with:

- **100% REST API coverage** — 38 tools vs the original 7
- **Dual tool mode** — granular (38 tools) or consolidated (11 tools, saves tokens)
- **Tool presets** — full, read-only, minimal, safe
- **Tool filtering** — INCLUDE_TOOLS / EXCLUDE_TOOLS env vars
- **Dataview DQL search** — query vault using the Dataview plugin
- **Full periodic notes** — CRUD by current period and by specific date
- **Vault cache + graph analysis** — backlinks, orphan detection, vault structure
- **Connection recovery** — auto-reconnect when Obsidian comes back
- **Self-config tool** — change settings from chat without restarting
- **Setup wizard** — interactive `--setup` for first-time configuration
- **Upstream bug fixes** — empty dir 404, search timeouts, broken periodic notes

## Tools

### Granular Mode (38 tools, default)

| # | Tool | Description |
|---|------|-------------|
| 1 | `list_files_in_vault` | List all files and directories in vault root |
| 2 | `list_files_in_dir` | List files in a vault directory |
| 3 | `get_file_contents` | Read a vault file as markdown, JSON, or document map |
| 4 | `put_content` | Create or overwrite a vault file (idempotent) |
| 5 | `append_content` | Append to a vault file |
| 6 | `patch_content` | Insert at a heading, block, or frontmatter target |
| 7 | `delete_file` | Delete a vault file to Obsidian trash (idempotent) |
| 8 | `search_replace` | Find and replace text in a vault file |
| 9 | `get_active_file` | Read the currently open file |
| 10 | `put_active_file` | Replace content of the currently open file |
| 11 | `append_active_file` | Append to the currently open file |
| 12 | `patch_active_file` | Patch the active file at a target |
| 13 | `delete_active_file` | Delete the currently open file |
| 14 | `list_commands` | List all Obsidian command palette commands |
| 15 | `execute_command` | Run an Obsidian command by ID |
| 16 | `open_file` | Open a file in the Obsidian UI |
| 17 | `simple_search` | Full-text search across all vault files |
| 18 | `complex_search` | Search with JsonLogic queries (glob, regexp) |
| 19 | `dataview_search` | Query vault using Dataview DQL |
| 20 | `get_periodic_note` | Get the current periodic note |
| 21 | `put_periodic_note` | Replace current periodic note content |
| 22 | `append_periodic_note` | Append to current periodic note |
| 23 | `patch_periodic_note` | Patch current periodic note at a target |
| 24 | `delete_periodic_note` | Delete current periodic note |
| 25 | `get_periodic_note_for_date` | Get periodic note for a specific date |
| 26 | `put_periodic_note_for_date` | Replace periodic note for a date |
| 27 | `append_periodic_note_for_date` | Append to periodic note for a date |
| 28 | `patch_periodic_note_for_date` | Patch periodic note for a date |
| 29 | `delete_periodic_note_for_date` | Delete periodic note for a date |
| 30 | `get_server_status` | Check Obsidian API connection and version |
| 31 | `batch_get_file_contents` | Read multiple vault files in one call |
| 32 | `get_recent_changes` | Get recently modified files sorted by date |
| 33 | `get_recent_periodic_notes` | Get recent periodic notes for a period type |
| 34 | `configure` | View or change server settings |
| 35 | `get_backlinks` | Get all notes that link to a file |
| 36 | `get_vault_structure` | Vault stats: note count, links, orphans, most connected |
| 37 | `get_note_connections` | Get backlinks and forward links for a note |
| 38 | `refresh_cache` | Force refresh vault cache and link graph |

### Consolidated Mode (11 tools)

Combines related tools into multi-action tools. Reduces the tool list sent to the LLM, saving tokens on every request.

| # | Tool | Actions | Replaces |
|---|------|---------|----------|
| 1 | `vault` | list, list_dir, get, put, append, patch, delete, search_replace | Tools 1-8 |
| 2 | `active_file` | get, put, append, patch, delete | Tools 9-13 |
| 3 | `commands` | list, execute | Tools 14-15 |
| 4 | `open_file` | — | Tool 16 |
| 5 | `search` | simple, jsonlogic, dataview | Tools 17-19 |
| 6 | `periodic_note` | get, put, append, patch, delete | Tools 20-29 |
| 7 | `status` | — | Tool 30 |
| 8 | `batch_get` | — | Tool 31 |
| 9 | `recent` | changes, periodic_notes | Tools 32-33 |
| 10 | `configure` | show, set, reset | Tool 34 |
| 11 | `vault_analysis` | backlinks, connections, structure, refresh | Tools 35-38 |

Set `TOOL_MODE=consolidated` to enable.

## Tool Presets

Control which tools are available. Set via `TOOL_PRESET` env var.

| Preset | Granular | Consolidated | Description |
|--------|----------|-------------|-------------|
| `full` | 38 tools | 11 tools, all actions | Everything (default) |
| `read-only` | 20 tools | 11 tools, read actions only | No writes or deletes |
| `minimal` | 7 tools | 4 tools | Essentials only |
| `safe` | 34 tools | 11 tools, no delete action | Everything except deletes |

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

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSIDIAN_API_KEY` | *(required)* | Bearer token from REST API plugin |
| `OBSIDIAN_HOST` | `127.0.0.1` | Obsidian host |
| `OBSIDIAN_PORT` | `27124` | REST API port |
| `OBSIDIAN_SCHEME` | `https` | `https` or `http` |
| `OBSIDIAN_TIMEOUT` | `30000` | Request timeout ms (search gets 2x) |
| `OBSIDIAN_CERT_PATH` | — | Path to .crt for TLS verification |
| `OBSIDIAN_VERIFY_SSL` | `false` | Strict TLS verification |
| `OBSIDIAN_VERIFY_WRITES` | `false` | Read-after-write verification |
| `OBSIDIAN_MAX_RESPONSE_CHARS` | `500000` | Truncation limit (0 = disabled) |
| `OBSIDIAN_DEBUG` | `false` | HTTP debug logging to stderr |
| `OBSIDIAN_CONFIG` | — | Custom config file path |
| `TOOL_MODE` | `granular` | `granular` or `consolidated` |
| `TOOL_PRESET` | `full` | `full`, `read-only`, `minimal`, `safe` |
| `INCLUDE_TOOLS` | — | Whitelist tool names (comma-separated) |
| `EXCLUDE_TOOLS` | — | Blacklist tool names (comma-separated) |
| `OBSIDIAN_CACHE_TTL` | `600000` | Cache refresh interval ms (10 min) |
| `OBSIDIAN_ENABLE_CACHE` | `true` | Enable/disable vault cache |

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

## Performance

Benchmarked against Obsidian Local REST API on macOS with mcp-test-vault.

### Stress Test — 395K Operations

| Metric | Result |
|--------|--------|
| Duration | 307.6s |
| Total operations | 394,607 |
| Throughput | 1,282 ops/s |
| Error rate | 0.01% (33/394K — read timeouts during cache rebuild, expected) |
| Memory (heap) | 27.9MB stable (no memory leak) |
| Crashes | 0 |

### Latency Percentiles

| Operation | Count | p50 | p95 | p99 |
|-----------|-------|-----|-----|-----|
| get | 98,750 | 0ms | 1ms | 3ms |
| put | 59,261 | 1ms | 2ms | 3ms |
| append | 39,619 | 1ms | 2ms | 4ms |
| search | 39,522 | 0ms | 1ms | 2ms |
| list | 39,406 | 0ms | 1ms | 1ms |
| get_json | 39,329 | 0ms | 1ms | 3ms |
| cache_rebuild | 19,714 | 6ms | 9ms | 12ms |
| delete_put | 19,667 | 1ms | 3ms | 5ms |
| search_replace | 19,643 | 1ms | 4ms | 6ms |

Sub-millisecond reads at p50. Stable memory after 395K operations. Write locks serialize correctly under concurrent load. Cache rebuilds don't block reads.

### Full-Coverage Stress Test — All 55 Tools

| Metric | Result |
|--------|--------|
| Duration | 323s |
| Total operations | 379,557 |
| Throughput | 1,175 ops/s |
| Error rate | 0.24% (916/380K — all gracefully handled) |
| Tool coverage | 55/55 (35 granular + 20 consolidated actions) |
| Memory (heap) | 17.8MB stable (no memory leak) |
| Crashes | 0 |

Error breakdown:
- `patch_*` operations: 722 errors (0.19%) — heading structure race conditions under concurrent writes
- `get`/`batch_get` timeouts: 194 errors — 30s timeouts during heavy cache rebuilds

All errors are gracefully handled with structured error messages. No crashes, no data corruption.

### Advanced Stress Tests — Edge Case Validation

6 targeted scenarios testing reliability under extreme conditions:

| Scenario | Duration | Ops | Result | Key Finding |
|----------|----------|-----|--------|-------------|
| Heading Mismatch Recovery | 3m | 8,763 | PASS | 89.5% PATCH success under concurrent heading restructuring |
| Cache Stampede | 14ms | 42 | PASS | 20 concurrent waiters, 1 build only, zero redundant builds |
| Large Vault Scale | 385ms | 292 | PASS | 205 notes/789 links cached in 136ms |
| Write Contention Torture | 3m | 7,145 | PASS | 0% errors, file lock serialization holds |
| Periodic Notes Date Sweep | 15m | 60 | PASS | All date edge cases handled |
| Error Cascade Recovery | 59ms | 58 | PASS | 0 unhandled exceptions, auto-recovery works |

Totals: 16,360 ops | p50=2ms | p95=37ms | 19.3MB heap stable | 6/6 pass

### Combined Benchmark Summary

| Test Suite | Operations | Key Result |
|-----------|-----------|------------|
| Stress test | 225 | 10/10 scenarios, write locks verified |
| Extended benchmark | 394,607 | 1,282 ops/s, 0.01% error rate |
| Full tool coverage | 379,557 | 55/55 tools exercised, 1,175 ops/s |
| Advanced stress tests | 16,360 | 6/6 edge case scenarios pass |
| **Grand total** | **~790,749** | **Zero crashes. Zero data corruption.** |

## Optional Plugins

| Plugin | Required For |
|--------|-------------|
| [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | **All functionality** (required) |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | `dataview_search` tool |
| [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) | Periodic note tools (daily/weekly/monthly/quarterly/yearly) |

## Comparison

| Feature | mcp-obsidian-extended | mcp-obsidian (original) | cyanheads (363★) | mcpvault (~50★) | ToKiDoO (6★) |
|---------|----------------------|------------------------|------------------|-----------------|--------------|
| Language | TypeScript | Python | TypeScript | TypeScript | TypeScript |
| Install | npx / .mcpb | uvx (requires Python) | npx | npx | npx |
| Tools | 38 granular / 11 consolidated | 7 | 8 | 14 (filesystem) | ~15 |
| REST API coverage | 100% | ~20% | ~25% | 0% (filesystem) | ~40% |
| Tool filtering | INCLUDE/EXCLUDE + presets | — | — | — | INCLUDE only |
| Dual mode | granular + consolidated | — | — | — | — |
| Dataview DQL | Yes (TABLE queries) | — | — | — | — |
| Active file ops | Full CRUD | — | — | — | — |
| Commands | list + execute | — | — | — | — |
| Periodic notes | Full CRUD + by date | — | — | — | — |
| Self-config tool | Yes (from chat) | — | — | — | — |
| Setup wizard | Yes (--setup) | — | — | — | — |
| Desktop Extension | .mcpb one-click install | — | — | — | — |
| Configurable timeouts | Yes | — | — | N/A | — |
| Vault cache + offline | REST-only cache | — | Yes | — | — |
| Graph analysis | Backlinks, orphans, connections | — | — | — | Filesystem |
| Write locks | Per-file mutex | — | — | — | — |
| Benchmarked | 395K ops, 1,282 ops/s | — | — | — | — |
| CI/CD | GitHub Actions | — | — | — | — |
| Known bugs | Fixed (7 upstream) | 50+ open issues | — | — | — |

> mcp-obsidian-extended is a TypeScript rewrite of [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) by Markus Pfundstein, which pioneered the MCP server approach for Obsidian. We fix 7 upstream bugs and expand from 7 tools to 38 with full API coverage.

## Known Limitations

- **PATCH under concurrent writes**: 89.5% success rate (10.5% failure) under concurrent heading restructuring — mitigated by automatic retry with document map refresh. For concurrent editing scenarios, prefer `search_replace` over `patch_content`.
- **Dataview queries**: Only `TABLE` queries are supported by the Obsidian Local REST API. `LIST` queries are not supported — this is an API limitation, not a server limitation.
- **Cache rebuild contention**: During cache rebuilds on large vaults, graph tools wait up to 5 seconds for the build to complete instead of failing immediately. The cache stampede test confirmed 20 concurrent callers sharing 1 build with zero redundant builds.

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
