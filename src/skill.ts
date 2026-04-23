/**
 * Builds the LLM skill content — a dynamic usage guide for Obsidian MCP tools.
 * Registered as an MCP resource and also shipped as a static SKILL.md for Claude Code.
 *
 * Every rule in this file prevents a specific mistake that actually happened
 * during 3 days of real-world LLM usage against this server.
 */

// --- Tool name resolver ---

/** Maps granular tool names to consolidated equivalents. */
const CONSOLIDATED_NAMES: ReadonlyMap<string, string> = new Map([
  ["get_file_contents", "vault action: get"],
  ["patch_content", "vault action: patch"],
  ["put_content", "vault action: put"],
  ["append_content", "vault action: append"],
  ["search_replace", "vault action: search_replace"],
  ["move_file", "vault action: move"],
  ["delete_file", "vault action: delete"],
  ["batch_get_file_contents", "batch_get"],
  ["simple_search", "search type: simple"],
  ["dataview_search", "search type: dataview"],
  ["complex_search", "search type: jsonlogic"],
  ["get_vault_structure", "vault_analysis action: structure"],
  ["get_backlinks", "vault_analysis action: backlinks"],
  ["get_note_connections", "vault_analysis action: connections"],
  ["refresh_cache", "vault_analysis action: refresh"],
  ["get_server_status", "status"],
  ["list_files_in_dir", "vault action: list_dir"],
  ["list_files_in_vault", "vault action: list"],
  ["list_commands", "commands action: list"],
  ["execute_command", "commands action: execute"],
  ["append_active_file", "active_file action: append"],
  ["patch_active_file", "active_file action: patch"],
]);

/** Resolves a granular tool name to the correct name for the active mode. */
function t(mode: "granular" | "consolidated", granularName: string): string {
  if (mode === "granular") return granularName;
  return CONSOLIDATED_NAMES.get(granularName) ?? granularName;
}

// --- Section builders (extracted to keep buildSkillContent under 50 lines) ---

/** Section 1: Golden rules that always apply. */
function goldenRules(mode: "granular" | "consolidated"): string {
  const get = t(mode, "get_file_contents");
  const patch = t(mode, "patch_content");
  const put = t(mode, "put_content");
  const append = t(mode, "append_content");
  const sr = t(mode, "search_replace");
  const batch = t(mode, "batch_get_file_contents");
  const structure = t(mode, "get_vault_structure");
  const move = t(mode, "move_file");
  const listDir = t(mode, "list_files_in_dir");
  const search = t(mode, "simple_search");
  const appendActive = t(mode, "append_active_file");
  const patchActive = t(mode, "patch_active_file");
  return `## Golden Rules

- ALWAYS ${get}(path, format: "map") BEFORE any ${patch} — verify the heading exists first. Never patch a heading you haven't confirmed.
- ALWAYS ${get}(path, format: "json") BEFORE modifying frontmatter — see the current state.
- Use ${sr} for precise text changes — safer than ${put} which overwrites the entire file.
- Use ${batch} for multiple files — never sequential ${get} calls.
- Use ${structure} at the start of a session to understand the vault layout (note count, links, orphans, most connected).
- NEVER use ${put} to edit a section — it replaces the ENTIRE file. Use ${append}, ${patch}, or ${sr} instead.
- NEVER retry a non-idempotent tool on timeout: ${append}, ${patch}, ${sr}, ${move}, ${appendActive}, ${patchActive}, all append/patch periodic note tools.
- NEVER assume a path exists — verify with ${listDir} or ${search} first.`;
}

/** Section 2: Step-by-step common workflows. */
function commonWorkflows(mode: "granular" | "consolidated"): string {
  const get = t(mode, "get_file_contents");
  const patch = t(mode, "patch_content");
  const put = t(mode, "put_content");
  const sr = t(mode, "search_replace");
  const batch = t(mode, "batch_get_file_contents");
  const move = t(mode, "move_file");
  const search = t(mode, "simple_search");
  const dataview = t(mode, "dataview_search");
  const complex = t(mode, "complex_search");
  const structure = t(mode, "get_vault_structure");
  const backlinks = t(mode, "get_backlinks");
  const connections = t(mode, "get_note_connections");
  const refresh = t(mode, "refresh_cache");
  const exec = t(mode, "execute_command");
  return `## Common Workflows

### Edit under a heading
1. ${get}(path, format: "map") — see all headings with :: hierarchy
2. ${get}(path, format: "markdown") — read current content under target heading
3. ${patch}(path, content, operation: "append", targetType: "heading", target: "Parent::Child")

If heading has special characters (em dashes, parentheses), use ${sr} instead — PATCH can fail silently on special chars.

### Find and update notes
1. ${search}(query) — find relevant files by keyword
2. ${batch}(paths from results) — read them all in one call
3. ${sr}(path, search, replace) — targeted edit in each file

### Understand vault structure
1. ${structure}() — note count, link count, orphans, most connected notes
2. ${backlinks}(path) — all notes that link TO this note
3. ${connections}(path) — both backlinks AND forward links for a note

### Create a new linked note
1. ${put}(path, content) — create note (include [[wikilinks]] to other notes)
2. ${refresh}() — update the link graph with the new note
3. ${backlinks}(path) — verify links were detected

### Move or rename a file (v1.1.0+)
1. ${move}(source, destination) — copies content + deletes source (wikilinks from other notes are NOT updated automatically)

### Search strategies
- ${search}(query) — keyword search, fast, good for finding files by content
- ${dataview}(dql) — structured queries on frontmatter: TABLE status, type FROM "folder" WHERE status = "active"
- ${complex}(query) — JsonLogic for glob/regex patterns
- Dataview only supports TABLE queries, not LIST — this is an API limitation

### Tab control via commands
- open_file(path) — open in current tab
- open_file(path, newLeaf: true) — open in new tab
- ${exec}("workspace:next-tab") — switch to next tab
- ${exec}("workspace:previous-tab") — switch to previous tab
- ${exec}("workspace:goto-tab-1") — jump to specific tab`;
}

/** Section 3: Error recovery guidance. */
function errorRecovery(mode: "granular" | "consolidated"): string {
  const get = t(mode, "get_file_contents");
  const sr = t(mode, "search_replace");
  const listDir = t(mode, "list_files_in_dir");
  const status = t(mode, "get_server_status");
  const search = t(mode, "simple_search");
  const move = t(mode, "move_file");
  return `## Error Recovery

**404 NOT FOUND** — File doesn't exist.
- Try adding .md extension if not present
- Use ${listDir} to find the correct path
- Server has case-insensitive fallback — but path must be close

**PATCH 400 error** — Heading/block target not found (returned as a bad request, not a timeout).
- Get the document map first: ${get}(path, format: "map")
- Check heading uses :: delimiter for nested headings: "Parent::Child"
- If heading has special characters, use ${sr} instead

**Connection refused** — Obsidian might not be running.
- ${status}() to check connection
- Cache-based tools (backlinks, vault_structure, note_connections) still work offline

**CONFLICT (${move})** — Destination already exists.
- Delete destination first, or choose a different path

**Large response truncated** — Note exceeds 500K character limit.
- Use ${search} to find specific sections instead of reading the whole file
- Use ${get} with format: "map" to see structure without full content`;
}

/** Section 4: Tool selection guide. */
function toolSelectionGuide(mode: "granular" | "consolidated"): string {
  const get = t(mode, "get_file_contents");
  const batch = t(mode, "batch_get_file_contents");
  const append = t(mode, "append_content");
  const put = t(mode, "put_content");
  const patch = t(mode, "patch_content");
  const sr = t(mode, "search_replace");
  const search = t(mode, "simple_search");
  const dataview = t(mode, "dataview_search");
  const structure = t(mode, "get_vault_structure");
  const backlinks = t(mode, "get_backlinks");
  const connections = t(mode, "get_note_connections");
  const exec = t(mode, "execute_command");
  const move = t(mode, "move_file");
  return `## Tool Selection Guide

| I want to... | Use this tool |
|---|---|
| Read a file | ${get} (format: "json" for metadata, "map" for structure) |
| Read multiple files | ${batch} (NOT sequential gets) |
| Add to end of file | ${append} (NOT ${put}) |
| Edit a specific section | get map first, then ${patch} or ${sr} |
| Replace entire file | ${put} (careful — overwrites everything) |
| Find files by keyword | ${search} |
| Query by frontmatter | ${dataview} with TABLE query |
| Check vault health | ${structure} — shows orphans, most connected |
| Who links to this note? | ${backlinks} |
| Full link analysis | ${connections} (backlinks + forward links) |
| Run an Obsidian command | ${t(mode, "list_commands")}, find ID, then ${exec} |
| Open file in Obsidian | open_file (newLeaf: true for new tab) |
| Move/rename a file | ${move} (v1.1.0+) |`;
}

/** Section 5: Known pitfalls from real-world usage. */
function knownPitfalls(mode: "granular" | "consolidated"): string {
  const put = t(mode, "put_content");
  const patch = t(mode, "patch_content");
  const sr = t(mode, "search_replace");
  return `## Things That Will Break If You Ignore Them

- ${put} OVERWRITES the entire file. If you use it to "edit a section" you will destroy all other content. This is the #1 mistake.
- ${patch} with replace operation on a top-level heading replaces EVERYTHING under it — including all sub-headings.
- PATCH with :: heading delimiter has ~10.5% failure rate under concurrent writes. For concurrent editing, prefer ${sr}.
- Dataview LIST queries are not supported — only TABLE. This is the REST API plugin's limitation.
- Active file operations (${mode === "consolidated" ? "active_file" : "get_active_file, put_active_file, etc."}) depend on what the USER has open in Obsidian — if they switch files, the active file changes under you.`;
}

/** Section 6: Consolidated mode action → required params mapping. */
function consolidatedActionReference(): string {
  return `## Consolidated Mode Action Reference

\`\`\`
vault:
  list           → (no params)
  list_dir       → path (directory)
  get            → path, format?
  put            → path, content
  append         → path, content
  patch          → path, content, operation, targetType, target, createIfMissing?
  delete         → path
  search_replace → path, search, replace
  move           → source, destination

active_file:
  get            → format?
  put            → content
  append         → content
  patch          → content, operation, targetType, target
  delete         → (no params)

commands:
  list           → (no params)
  execute        → commandId

search:
  simple         → query, contextLength?
  jsonlogic      → jsonQuery (object)
  dataview       → query

periodic_note:
  get            → period, year?, month?, day?, format?
  put            → period, content, year?, month?, day?
  append         → period, content, year?, month?, day?
  patch          → period, content, operation, targetType, target, year?, month?, day?
  delete         → period, year?, month?, day?

status:              → (no params)

batch_get:           → paths, format?

recent:
  changes        → limit?
  periodic_notes → period, limit?

configure:
  show           → (no params)
  set            → setting, value
  reset          → setting
  skill          → (no params, returns LLM usage guide)

vault_analysis:
  backlinks      → path
  connections    → path
  structure      → limit?
  refresh        → (no params)
\`\`\``;
}

/** Section 7: Compact response field name mapping table. */
function compactFieldReference(): string {
  return `## Compact Response Field Reference

Responses use abbreviated field names to save tokens:

| Short | Full |
|-------|------|
| c | content |
| fm | frontmatter |
| p | path |
| t | tags |
| s | stat |
| m | mtime (flat, e.g. recent changes) |
| s.m | stat.mtime (nested in stat) |
| s.ct | stat.ctime (nested in stat) |
| s.sz | stat.size (nested in stat) |
| h | headings |
| b | blocks |
| fmf | frontmatterFields |
| q | query |
| ctx | context |
| sc | score |
| mt | matches |
| svc | service |
| auth | authenticated |
| v | versions |
| cnt | count |
| n | notes |
| src | source |
| tgt | target |
| in | inbound |
| out | outbound |
| st | start |
| en | end |
| fn | filename |`;
}

// --- Public API ---

/**
 * Builds the skill content markdown tailored to the active tool mode and compact setting.
 * Sections 1-5 are always included. Section 6 only in consolidated mode. Section 7 only when compact.
 * @param mode - The active tool mode (granular or consolidated).
 * @param compact - Whether compact responses are enabled.
 * @returns Complete markdown skill document.
 */
export function buildSkillContent(
  mode: "granular" | "consolidated",
  compact: boolean,
): string {
  const sections = [
    "# Obsidian MCP — Tool Usage Guide",
    goldenRules(mode),
    commonWorkflows(mode),
    errorRecovery(mode),
    toolSelectionGuide(mode),
    knownPitfalls(mode),
  ];

  if (mode === "consolidated") {
    sections.push(consolidatedActionReference());
  }

  if (compact) {
    sections.push(compactFieldReference());
  }

  return `${sections.join("\n\n")}\n`;
}
