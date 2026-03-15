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

## Optional Plugins

| Plugin | Required For |
|--------|-------------|
| [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | **All functionality** (required) |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | `dataview_search` tool |
| [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) | Periodic note tools (daily/weekly/monthly/quarterly/yearly) |

## Comparison

| Feature | mcp-obsidian-extended | cyanheads (363★) | mcpvault (~50★) | ToKiDoO (6★) |
|---------|----------------------|-------------------|-----------------|--------------|
| 100% REST API | 38 tools | 8 | 14 (filesystem) | ~15 |
| Tool filtering | INCLUDE/EXCLUDE + presets | — | — | INCLUDE only |
| Dual mode | granular + consolidated | — | — | — |
| Dataview DQL | Yes | — | — | — |
| Periodic notes CRUD | Full (+ by date) | — | — | — |
| Self-config tool | Yes | — | — | — |
| Setup wizard | Yes | — | — | — |
| Configurable timeouts | Yes | — | N/A | — |
| Vault cache + graph | REST-only | Yes | — | Filesystem |

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
