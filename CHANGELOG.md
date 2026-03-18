# Changelog

## 1.1.1 (2026-03-18)

### New
- **configure skill action:** `configure({ action: "skill" })` returns the LLM usage guide as tool output — workaround for Claude.ai where MCP resources are not exposed to conversations
- **Skill packaging:** `npm run build:skill` generates `.zip` (Claude.ai) and `.skill` (Claude Code) distributable archives

### Changed
- configure tool description updated to mention LLM usage guide
- Consolidated action reference lists `skill` action for configure

## 1.1.0 (2026-03-18)

### New
- **LLM Skill resource:** MCP resource (`obsidian://skill`) that teaches LLMs how to use tools effectively — includes workflow patterns, safe editing tips, error recovery, and token optimization guidance. Adapts content based on tool mode and compact responses setting. Also ships as `.claude/skills/obsidian-mcp/SKILL.md` for Claude Code users.
- **Compact responses:** `OBSIDIAN_COMPACT_RESPONSES=true` maps verbose field names to short abbreviations (e.g. `content`→`c`, `frontmatter`→`fm`, `path`→`p`) and removes JSON whitespace — reduces token usage for large vault operations. Configurable at runtime via the `configure` tool.
- **move_file tool:** Move or rename vault files (granular tool #39, consolidated `vault` action `move`). Copies content to destination, deletes source to Obsidian trash (recoverable). Detects conflicts when destination already exists. Available in `full` and `safe` presets.
- **SEA binary build:** `npm run build:sea` compiles the server into a standalone binary using Node.js Single Executable Applications — no Node.js installation required. macOS code-signing included.

### Changed
- Granular full preset: 38→39 tools (added move_file)
- Granular safe preset: 34→35 tools (added move_file)
- New env var: `OBSIDIAN_COMPACT_RESPONSES` (default: `false`), total env vars: 18

## 1.0.1 (2026-03-17)

### Fixed
- Vault cache now recursively discovers all `.md` files in subdirectories — previously only root-level files were indexed, making graph analysis, backlinks, and vault structure incomplete for vaults with folders
- Obsidian REST API returns relative paths from `listFilesInDir` — cache now correctly prepends the parent directory prefix
- Added cycle detection (visited set + max depth 20) to prevent infinite recursion from symlinked directories
- Path sanitization: reject `..` traversal, absolute paths, normalize `.` and empty segments from consecutive slashes
- `ObsidianAuthError` and `ObsidianConnectionError` are now rethrown from subdirectory traversal instead of being silently swallowed

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
