# Obsidian MCP — Tool Usage Guide

## Golden Rules

- ALWAYS get_file_contents(path, format: "map") BEFORE any patch_content — verify the heading exists first. Never patch a heading you haven't confirmed.
- ALWAYS get_file_contents(path, format: "json") BEFORE modifying frontmatter — see the current state.
- Use search_replace for precise text changes — safer than put_content which overwrites the entire file.
- Use batch_get_file_contents for multiple files — never sequential get_file_contents calls.
- Use get_vault_structure at the start of a session to understand the vault layout (note count, links, orphans, most connected).
- NEVER use put_content to edit a section — it replaces the ENTIRE file. Use append_content, patch_content, or search_replace instead.
- NEVER retry a non-idempotent tool on timeout: append_content, patch_content, search_replace, move_file, append_active_file, patch_active_file, all append/patch periodic note tools.
- NEVER assume a path exists — verify with list_files_in_dir or simple_search first.

## Common Workflows

### Edit under a heading
1. get_file_contents(path, format: "map") — see all headings with :: hierarchy
2. get_file_contents(path, format: "markdown") — read current content under target heading
3. patch_content(path, content, operation: "append", targetType: "heading", target: "Parent::Child")

If heading has special characters (em dashes, parentheses), use search_replace instead — PATCH can fail silently on special chars.

### Find and update notes
1. simple_search(query) — find relevant files by keyword
2. batch_get_file_contents(paths from results) — read them all in one call
3. search_replace(path, search, replace) — targeted edit in each file

### Understand vault structure
1. get_vault_structure() — note count, link count, orphans, most connected notes
2. get_backlinks(path) — all notes that link TO this note
3. get_note_connections(path) — both backlinks AND forward links for a note

### Create a new linked note
1. put_content(path, content) — create note (include [[wikilinks]] to other notes)
2. refresh_cache() — update the link graph with the new note
3. get_backlinks(path) — verify links were detected

### Move or rename a file (v1.1.0+)
1. move_file(source, destination) — compound operation, handles everything

### Search strategies
- simple_search(query) — keyword search, fast, good for finding files by content
- dataview_search(dql) — structured queries on frontmatter: TABLE status, type FROM "folder" WHERE status = "active"
- complex_search(query) — JsonLogic for glob/regex patterns
- Dataview only supports TABLE queries, not LIST — this is an API limitation

### Tab control via commands
- open_file(path) — open in current tab
- open_file(path, newLeaf: true) — open in new tab
- execute_command("workspace:next-tab") — switch to next tab
- execute_command("workspace:previous-tab") — switch to previous tab
- execute_command("workspace:goto-tab-1") — jump to specific tab

## Error Recovery

**404 NOT FOUND** — File doesn't exist.
- Try adding .md extension if not present
- Use list_files_in_dir to find the correct path
- Server has case-insensitive fallback — but path must be close

**PATCH 400 error** — Heading/block target not found (returned as a bad request, not a timeout).
- Get the document map first: get_file_contents(path, format: "map")
- Check heading uses :: delimiter for nested headings: "Parent::Child"
- If heading has special characters, use search_replace instead

**Connection refused** — Obsidian might not be running.
- get_server_status() to check connection
- Cache-based tools (backlinks, vault_structure, note_connections) still work offline

**CONFLICT (move_file)** — Destination already exists.
- Delete destination first, or choose a different path

**Large response truncated** — Note exceeds 500K character limit.
- Use simple_search to find specific sections instead of reading the whole file
- Use get_file_contents with format: "map" to see structure without full content

## Tool Selection Guide

| I want to... | Use this tool |
|---|---|
| Read a file | get_file_contents (format: "json" for metadata, "map" for structure) |
| Read multiple files | batch_get_file_contents (NOT sequential gets) |
| Add to end of file | append_content (NOT put_content) |
| Edit a specific section | get map first, then patch_content or search_replace |
| Replace entire file | put_content (careful — overwrites everything) |
| Find files by keyword | simple_search |
| Query by frontmatter | dataview_search with TABLE query |
| Check vault health | get_vault_structure — shows orphans, most connected |
| Who links to this note? | get_backlinks |
| Full link analysis | get_note_connections (backlinks + forward links) |
| Run an Obsidian command | list_commands, find ID, then execute_command |
| Open file in Obsidian | open_file (newLeaf: true for new tab) |
| Move/rename a file | move_file (v1.1.0+) |

## Things That Will Break If You Ignore Them

- put_content OVERWRITES the entire file. If you use it to "edit a section" you will destroy all other content. This is the #1 mistake.
- patch_content with replace operation on a top-level heading replaces EVERYTHING under it — including all sub-headings.
- PATCH with :: heading delimiter has ~10.5% failure rate under concurrent writes. For concurrent editing, prefer search_replace.
- Dataview LIST queries are not supported — only TABLE. This is the REST API plugin's limitation.
- Active file operations (get_active_file, etc.) depend on what the USER has open in Obsidian — if they switch files, the active file changes under you.
