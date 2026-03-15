# Changelog

## 1.0.0 (2026-03-15)

Initial release — TypeScript rewrite of mcp-obsidian with full API coverage.

### New
- 38 MCP tools covering 100% of Obsidian Local REST API
- Dual tool mode: granular (38 tools) and consolidated (11 tools)
- Tool presets: full, read-only, minimal, safe
- Tool filtering: INCLUDE_TOOLS / EXCLUDE_TOOLS
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
- Batch file retrieval

### Fixed (from upstream)
- Empty directory returns 404 instead of empty list (MarkusPfundstein/mcp-obsidian#98)
- PATCH hangs on invalid target (coddingtonbear/obsidian-local-rest-api#3) — mitigated with timeouts
- Search timeout on large vaults (MarkusPfundstein/mcp-obsidian#88)
- Broken recent periodic notes (MarkusPfundstein/mcp-obsidian#92)
- Environment variable defaults ignored (MarkusPfundstein/mcp-obsidian#86)
- Python/pydantic build failures (MarkusPfundstein/mcp-obsidian#100, MarkusPfundstein/mcp-obsidian#9, MarkusPfundstein/mcp-obsidian#45)
