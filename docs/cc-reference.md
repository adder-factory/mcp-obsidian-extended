# CC Reference — API, Types & Tool Specs

Lookup document. Use during implementation. See `cc-instructions-final.md` for decisions, `cc-phase-guide.md` for build steps.

---

## Obsidian REST API — Endpoint Reference

Base URL: `${scheme}://${host}:${port}` (default `https://127.0.0.1:27124`)
Auth: `Authorization: Bearer ${apiKey}` on all endpoints except `GET /`

### System

| Method | Path | Auth | Response                                   |
| ------ | ---- | ---- | ------------------------------------------ |
| GET    | `/`  | No   | `{ ok, service, authenticated, versions }` |

### Vault Files

| Method | Path            | Headers                     | Body     | Response                   |
| ------ | --------------- | --------------------------- | -------- | -------------------------- |
| GET    | `/vault/`       | —                           | —        | `{ files: string[] }`      |
| GET    | `/vault/{dir}/` | —                           | —        | `{ files: string[] }`      |
| GET    | `/vault/{path}` | Accept: see below           | —        | content (varies by Accept) |
| PUT    | `/vault/{path}` | Content-Type: text/markdown | markdown | 204                        |
| POST   | `/vault/{path}` | Content-Type: text/markdown | markdown | 204                        |
| PATCH  | `/vault/{path}` | PATCH headers (see below)   | content  | 204                        |
| DELETE | `/vault/{path}` | —                           | —        | 204                        |

**Accept header for GET:**

- `text/markdown` → raw markdown string
- `application/vnd.olrapi.note+json` → NoteJson object
- `application/vnd.olrapi.document-map+json` → DocumentMap object

### Active File

Same operations as vault files but on `/active/` (no path parameter).

| Method | Path       | Notes                                                   |
| ------ | ---------- | ------------------------------------------------------- |
| GET    | `/active/` | Same Accept headers as vault GET                        |
| PUT    | `/active/` | Replace content                                         |
| POST   | `/active/` | Append content                                          |
| PATCH  | `/active/` | Same PATCH headers (except no Create-Target-If-Missing) |
| DELETE | `/active/` | Delete active file                                      |

### Commands

| Method | Path                     | Response                                       |
| ------ | ------------------------ | ---------------------------------------------- |
| GET    | `/commands/`             | `{ commands: [{ id: string, name: string }] }` |
| POST   | `/commands/{commandId}/` | 204 on success, 404 if not found               |

### Open

| Method | Path               | Query               | Notes                         |
| ------ | ------------------ | ------------------- | ----------------------------- |
| POST   | `/open/{filename}` | `newLeaf` (boolean) | Creates file if doesn't exist |

### Search

| Method | Path              | Content-Type                              | Body                                   | Response                         |
| ------ | ----------------- | ----------------------------------------- | -------------------------------------- | -------------------------------- |
| POST   | `/search/simple/` | —                                         | Query params: `query`, `contextLength` | `[{ filename, score, matches }]` |
| POST   | `/search/`        | `application/vnd.olrapi.jsonlogic+json`   | JsonLogic object                       | `[{ filename, result }]`         |
| POST   | `/search/`        | `application/vnd.olrapi.dataview.dql+txt` | DQL string (plain text)                | `[{ filename, result }]`         |

### Periodic Notes

Period values: `daily`, `weekly`, `monthly`, `quarterly`, `yearly`

| Method | Path                              | Notes                                 |
| ------ | --------------------------------- | ------------------------------------- |
| GET    | `/periodic/{period}/`             | Current period. Same Accept headers   |
| PUT    | `/periodic/{period}/`             | Replace current                       |
| POST   | `/periodic/{period}/`             | Append to current (creates if needed) |
| PATCH  | `/periodic/{period}/`             | Patch current                         |
| DELETE | `/periodic/{period}/`             | Delete current                        |
| GET    | `/periodic/{period}/{y}/{m}/{d}/` | Specific date                         |
| PUT    | `/periodic/{period}/{y}/{m}/{d}/` |                                       |
| POST   | `/periodic/{period}/{y}/{m}/{d}/` |                                       |
| PATCH  | `/periodic/{period}/{y}/{m}/{d}/` |                                       |
| DELETE | `/periodic/{period}/{y}/{m}/{d}/` |                                       |

### PATCH Headers

| Header                     | Required | Values                                          |
| -------------------------- | -------- | ----------------------------------------------- |
| `Operation`                | yes      | `append`, `prepend`, `replace`                  |
| `Target-Type`              | yes      | `heading`, `block`, `frontmatter`               |
| `Target`                   | yes      | URL-encoded string. Headings use `::` delimiter |
| `Target-Delimiter`         | no       | string (default `::`)                           |
| `Trim-Target-Whitespace`   | no       | `true`/`false` (default `false`)                |
| `Create-Target-If-Missing` | no       | boolean (vault PATCH only, not active)          |
| `Content-Type`             | yes      | `text/markdown` or `application/json`           |

---

## TypeScript Types

```typescript
interface NoteJson {
  content: string;
  frontmatter: Record<string, unknown>;
  path: string;
  tags: string[];
  stat: { ctime: number; mtime: number; size: number };
}

interface DocumentMap {
  headings: string[];
  blocks: string[];
  frontmatterFields: string[];
}

interface PatchOptions {
  operation: "append" | "prepend" | "replace";
  targetType: "heading" | "block" | "frontmatter";
  target: string;
  targetDelimiter?: string; // default "::"
  trimTargetWhitespace?: boolean; // default false
  createIfMissing?: boolean; // vault PATCH only
  contentType?: "markdown" | "json"; // default "markdown"
}

interface SearchMatch {
  match: { start: number; end: number };
  context: string;
}

interface SearchResult {
  filename: string;
  score?: number;
  matches?: SearchMatch[];
  result?: unknown;
}
```

---

## ObsidianClient Method Signatures

```typescript
class ObsidianClient {
  constructor(config: Config);

  // System
  getServerStatus(): Promise<{
    ok: boolean;
    service: string;
    authenticated: boolean;
    versions: Record<string, unknown>;
  }>;

  // Vault Files
  listFilesInVault(): Promise<{ files: string[] }>;
  listFilesInDir(dirPath: string): Promise<{ files: string[] }>; // handles empty dir 404
  getFileContents(
    filePath: string,
    format?: "markdown" | "json" | "map",
  ): Promise<string | NoteJson | DocumentMap>;
  putContent(
    filePath: string,
    content: string,
    options?: { verify?: boolean },
  ): Promise<void>;
  appendContent(filePath: string, content: string): Promise<void>;
  patchContent(
    filePath: string,
    content: string,
    options: PatchOptions,
  ): Promise<void>;
  deleteFile(filePath: string): Promise<void>;

  // Active File
  getActiveFile(
    format?: "markdown" | "json" | "map",
  ): Promise<string | NoteJson | DocumentMap>;
  putActiveFile(content: string, options?: { verify?: boolean }): Promise<void>;
  appendActiveFile(content: string): Promise<void>;
  patchActiveFile(content: string, options: PatchOptions): Promise<void>;
  deleteActiveFile(): Promise<void>;

  // Commands
  listCommands(): Promise<{ commands: Array<{ id: string; name: string }> }>;
  executeCommand(commandId: string): Promise<void>;

  // Open
  openFile(filePath: string, newLeaf?: boolean): Promise<void>;

  // Search
  simpleSearch(query: string, contextLength?: number): Promise<SearchResult[]>;
  complexSearch(query: Record<string, unknown>): Promise<SearchResult[]>;
  dataviewSearch(dql: string): Promise<SearchResult[]>;

  // Periodic Notes — Current
  getPeriodicNote(
    period: string,
    format?: "markdown" | "json" | "map",
  ): Promise<string | NoteJson | DocumentMap>;
  putPeriodicNote(period: string, content: string): Promise<void>;
  appendPeriodicNote(period: string, content: string): Promise<void>;
  patchPeriodicNote(
    period: string,
    content: string,
    options: PatchOptions,
  ): Promise<void>;
  deletePeriodicNote(period: string): Promise<void>;

  // Periodic Notes — By Date
  getPeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
    format?: "markdown" | "json" | "map",
  ): Promise<string | NoteJson | DocumentMap>;
  putPeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
    content: string,
  ): Promise<void>;
  appendPeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
    content: string,
  ): Promise<void>;
  patchPeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
    content: string,
    options: PatchOptions,
  ): Promise<void>;
  deletePeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
  ): Promise<void>;
}
```

---

## MCP Tool Helper Functions

```typescript
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
```

---

## Granular Tool Descriptions (all 38)

Format: `name` — "description (max 15 words)" — inputs

1. `list_files_in_vault` — "List all files and directories in vault root" — none
2. `list_files_in_dir` — "List files in a vault directory" — dirPath
3. `get_file_contents` — "Read a vault file as markdown, JSON, or document map" — filePath, format?
4. `put_content` — "Create or overwrite a vault file (idempotent)" — filePath, content
5. `append_content` — "Append to a vault file (not idempotent, do not retry)" — filePath, content
6. `patch_content` — "Insert content at a heading, block, or frontmatter target (not idempotent)" — filePath, content, operation, targetType, target, targetDelimiter?, trimTargetWhitespace?, createIfMissing?, contentType?
7. `delete_file` — "Delete a vault file to Obsidian trash (idempotent)" — filePath
8. `search_replace` — "Find and replace text in a vault file (not idempotent)" — filePath, search, replace, useRegex?(false), caseSensitive?(true), replaceAll?(true)
9. `get_active_file` — "Read the currently open file in Obsidian" — format?
10. `put_active_file` — "Replace content of the currently open file (idempotent)" — content
11. `append_active_file` — "Append to the currently open file (not idempotent)" — content
12. `patch_active_file` — "Patch the active file at a target (not idempotent)" — content, operation, targetType, target, targetDelimiter?, trimTargetWhitespace?, contentType?
13. `delete_active_file` — "Delete the currently open file (idempotent)" — none
14. `list_commands` — "List all Obsidian command palette commands" — none
15. `execute_command` — "Run an Obsidian command by ID" — commandId
16. `open_file` — "Open a file in the Obsidian UI" — filePath, newLeaf?(false)
17. `simple_search` — "Full-text search across all vault files" — query, contextLength?(100)
18. `complex_search` — "Search vault with JsonLogic queries (glob, regexp)" — query (object)
19. `dataview_search` — "Query vault using Dataview DQL (requires Dataview plugin)" — dql
20. `get_periodic_note` — "Get the current periodic note" — period, format?
21. `put_periodic_note` — "Replace current periodic note content (idempotent)" — period, content
22. `append_periodic_note` — "Append to current periodic note (not idempotent)" — period, content
23. `patch_periodic_note` — "Patch current periodic note at a target (not idempotent)" — period, content, + patch fields
24. `delete_periodic_note` — "Delete current periodic note (idempotent)" — period
25. `get_periodic_note_for_date` — "Get periodic note for a specific date" — period, year, month, day, format?
26. `put_periodic_note_for_date` — "Replace periodic note for a date (idempotent)" — period, year, month, day, content
27. `append_periodic_note_for_date` — "Append to periodic note for a date (not idempotent)" — period, year, month, day, content
28. `patch_periodic_note_for_date` — "Patch periodic note for a date (not idempotent)" — period, year, month, day, content, + patch fields
29. `delete_periodic_note_for_date` — "Delete periodic note for a date (idempotent)" — period, year, month, day
30. `get_server_status` — "Check Obsidian API connection and version" — none **[PROTECTED]**
31. `batch_get_file_contents` — "Read multiple vault files in one call" — filePaths (array), format?
32. `get_recent_changes` — "Get recently modified files sorted by date" — limit?(10)
33. `get_recent_periodic_notes` — "Get recent periodic notes for a period type" — period, limit?(5)
34. `configure` — "View or change server settings" — action (show/set/reset), setting?, value? **[PROTECTED]**

---

## Consolidated Tool Schemas (all 10)

### 1. `vault`

```
action: enum [list, list_dir, get, put, append, patch, delete, search_replace]
path: string (optional for list, required otherwise)
content: string (required for put/append/patch, search part of search_replace)
format: enum [markdown, json, map] (for get)
operation: enum [append, prepend, replace] (for patch)
targetType: enum [heading, block, frontmatter] (for patch)
target: string (for patch)
targetDelimiter: string (for patch, default "::")
trimTargetWhitespace: boolean (for patch)
createIfMissing: boolean (for patch)
contentType: enum [markdown, json] (for patch)
search: string (for search_replace)
replace: string (for search_replace)
useRegex: boolean (for search_replace, default false)
caseSensitive: boolean (for search_replace, default true)
replaceAll: boolean (for search_replace, default true)
```

### 2. `active_file`

```
action: enum [get, put, append, patch, delete]
content: string (for put/append/patch)
format: enum [markdown, json, map] (for get)
+ patch fields (minus path, minus createIfMissing)
```

### 3. `commands`

```
action: enum [list, execute]
commandId: string (required for execute)
```

### 4. `open_file`

```
path: string (required)
newLeaf: boolean (default false)
```

### 5. `search`

```
type: enum [simple, jsonlogic, dataview]
query: string (for simple and dataview)
jsonQuery: object (for jsonlogic)
contextLength: number (for simple, default 100)
```

### 6. `periodic_note`

```
action: enum [get, put, append, patch, delete]
period: enum [daily, weekly, monthly, quarterly, yearly]
year: number (optional — omit for current period)
month: number (optional)
day: number (optional)
content: string (for put/append/patch)
format: enum [markdown, json, map] (for get)
+ patch fields
```

### 7. `status` [PROTECTED]

No inputs.

### 8. `batch_get`

```
paths: string[] (required)
format: enum [markdown, json, map] (default markdown)
```

### 9. `recent`

```
type: enum [changes, periodic_notes]
period: enum (required when type=periodic_notes)
limit: number (default 10)
```

### 10. `configure` [PROTECTED]

```
action: enum [show, set, reset]
setting: string (for set — e.g. "debug", "timeout", "toolMode")
value: string (for set — the new value)
```

---

## Config File Format

`obsidian-mcp.config.json`:

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

Note: `apiKey` should be in env var or Claude Desktop config — not in a file that might be committed.

---

## MCPB Manifest

```json
{
  "mcpb_version": "0.1",
  "name": "mcp-obsidian-extended",
  "version": "1.0.0",
  "description": "Full-featured MCP server for Obsidian — 38 tools covering 100% of the Local REST API",
  "author": { "name": "adder-factory" },
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js"],
      "env": {
        "OBSIDIAN_API_KEY": "${user_config.api_key}",
        "TOOL_MODE": "${user_config.tool_mode}",
        "TOOL_PRESET": "${user_config.tool_preset}"
      }
    }
  },
  "user_config": {
    "api_key": {
      "type": "string",
      "title": "Obsidian API Key",
      "description": "Found in Obsidian Settings → Local REST API → API Key",
      "sensitive": true,
      "required": true
    },
    "tool_mode": {
      "type": "string",
      "title": "Tool Mode",
      "description": "granular = 38 individual tools. consolidated = 11 combined tools (saves tokens)",
      "default": "granular",
      "enum": ["granular", "consolidated"]
    },
    "tool_preset": {
      "type": "string",
      "title": "Tool Preset",
      "description": "full = all tools. read-only = no writes. minimal = essentials. safe = no deletes",
      "default": "full",
      "enum": ["full", "read-only", "minimal", "safe"]
    }
  }
}
```

---

## Path Sanitization Function

---

## VaultCache Interface

```typescript
interface CachedNote {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  stat: { ctime: number; mtime: number; size: number };
  links: ParsedLink[];
  cachedAt: number;
}

interface ParsedLink {
  target: string; // resolved note path
  type: "wikilink" | "markdown";
  context: string; // ~50 chars surrounding the link
}

class VaultCache {
  async initialize(): Promise<void>; // Full cache build (background)
  async refresh(): Promise<void>; // Incremental (only changed mtime)
  startAutoRefresh(): void; // Background timer
  stopAutoRefresh(): void;

  getNote(path: string): CachedNote | undefined;
  getAllNotes(): CachedNote[];
  getFileList(): string[];
  get noteCount(): number;
  get linkCount(): number;

  invalidate(path: string): void; // After writes
  invalidateAll(): void;

  // Graph queries
  getBacklinks(path: string): Array<{ source: string; context: string }>;
  getForwardLinks(path: string): ParsedLink[];
  getOrphanNotes(): string[]; // Notes with zero inbound + outbound links
  getMostConnectedNotes(
    limit: number,
  ): Array<{ path: string; inbound: number; outbound: number }>;
  getVaultGraph(): {
    nodes: string[];
    edges: Array<{ source: string; target: string }>;
  };
}
```

### Link Parser

```typescript
function parseLinks(content: string, currentPath: string): ParsedLink[] {
  // Wikilinks: [[note]], [[note|alias]], [[note#heading]]
  const wikiRegex = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
  // Markdown links to .md files: [text](path.md)
  const mdRegex = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  // Extract with ~50 char context, resolve relative paths, normalize
}
```

---

## Analysis Tool Descriptions (Granular #35-38)

35. `get_backlinks` — "Get all notes that link to a file (from cache)" — filePath
36. `get_vault_structure` — "Get vault stats: note count, links, orphans, most connected" — none
37. `get_note_connections` — "Get backlinks and forward links for a note" — filePath
38. `refresh_cache` — "Force refresh vault cache and link graph" — none **[PROTECTED]**

## Analysis Tool (Consolidated #11)

`vault_analysis`:

```
action: enum [backlinks, connections, structure, refresh]
path: string (required for backlinks/connections)
limit: number (optional, for structure's most-connected list, default 10)
```

---

## Path Sanitization Function

```typescript
function sanitizeFilePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Absolute paths not allowed");
  }
  return normalized;
}
```

Apply to every file path before passing to HTTP client.

---

## Structured Error Builder

```typescript
function buildErrorMessage(
  error: Error,
  context: { tool: string; path?: string },
): string {
  if (error instanceof ObsidianConnectionError) {
    return `CONNECTION ERROR: Cannot reach Obsidian. Ensure Obsidian is running with Local REST API enabled.`;
  }
  if (error instanceof ObsidianAuthError) {
    return `AUTH ERROR: API key rejected. Check OBSIDIAN_API_KEY.`;
  }
  if (error instanceof ObsidianApiError) {
    if (error.statusCode === 404) {
      return `NOT FOUND: ${context.path ?? "Resource"} does not exist. Use list_files_in_vault to find valid paths.`;
    }
    if (error.statusCode === 400) return `BAD REQUEST: ${error.message}`;
    if (error.statusCode === 405)
      return `NOT SUPPORTED: ${error.message}. May require a specific plugin.`;
    return `API ERROR (${error.statusCode}): ${error.message}`;
  }
  return `ERROR: ${error.message}`;
}
```
