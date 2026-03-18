# v1.1.0 Spec — LLM Skill + Compact Responses + move_file + SEA Binary

## 1. LLM Skill (MCP Resource + Skill File)

### What
A dynamic MCP resource that teaches LLMs how to use the tools properly. Also ships as a static `.claude/skills/obsidian-mcp/SKILL.md` for Claude Code users.

### Implementation

```typescript
// In index.ts — register the resource
server.resource("obsidian-skill", "obsidian://skill", async () => {
  const mode = config.toolMode;
  const compact = config.compactResponses;
  const skillContent = buildSkillContent(mode, compact);
  return { contents: [{ uri: "obsidian://skill", text: skillContent, mimeType: "text/markdown" }] };
});
```

### Granular Mode Skill Content
- **Workflow patterns:** "get with format:map before patch", "batch_get over sequential get", "search then act on results", "get_vault_structure first to understand the vault"
- **Safe editing:** "prefer search_replace over put for targeted edits"
- **Error recovery:** 404 → check path + try with .md extension; timeout → check document map first; connection refused → check get_server_status
- **Token tips:** use format:map for structure without full content, use batch_get for multiple files

### Consolidated Mode Skill Content
Everything in granular PLUS action → required params mapping:

```markdown
vault:
  list        → (no params)
  list_dir    → path (directory)
  get         → path, format?
  put         → path, content
  append      → path, content
  patch       → path, content, operation, targetType, target, createIfMissing?
  delete      → path
  search_replace → path, search, replace
  move        → source, destination (NEW in v1.1.0)

active_file:
  get         → format?
  put         → content
  append      → content
  patch       → content, operation, targetType, target
  delete      → (no params)

search:
  simple      → query, contextLength?
  jsonlogic   → query (object)
  dataview    → dql

periodic_note:
  get         → period, year?, month?, day?, format?
  put         → period, content, year?, month?, day?
  append      → period, content, year?, month?, day?
  patch       → period, content, operation, targetType, target, year?, month?, day?
  delete      → period, year?, month?, day?

vault_analysis:
  backlinks   → path
  connections → path
  structure   → limit?
  refresh     → (no params)
```

### Skill File
Ship `.claude/skills/obsidian-mcp/SKILL.md` in the npm package. Add to `"files"` in package.json:
```json
"files": ["dist", ".claude"]
```

---

## 2. Compact Responses

### Config
New env var: `OBSIDIAN_COMPACT_RESPONSES` (default: `false`)

### Field Mapping

| Short | Full | Description |
|-------|------|-------------|
| c | content | Note body text |
| fm | frontmatter | YAML metadata object |
| p | path | File path in vault |
| t | tags | Array of tag strings |
| s | stat | File stats object |
| s.m | stat.mtime | Last modified timestamp |
| s.ct | stat.ctime | Created timestamp |
| s.sz | stat.size | File size in bytes |
| h | headings | Document map headings |
| b | blocks | Document map block references |
| fmf | frontmatterFields | Document map frontmatter fields |
| q | query | Search query |
| ctx | context | Search result context |
| sc | score | Search relevance score |
| mt | matches | Search match locations |
| ok | ok | Status check result |
| svc | service | Service name |
| auth | authenticated | Auth status |
| v | versions | Version info |
| cnt | count | Item count |
| n | notes | Notes array |
| src | source | Backlink source path |
| tgt | target | Link target path |
| in | inbound | Inbound link count |
| out | outbound | Outbound link count |

### Implementation

Update `jsonResult()` helper in tools/shared.ts:

```typescript
function jsonResult(data: unknown): ToolResult {
  const mapped = config.compactResponses ? compactify(data) : data;
  const text = config.compactResponses 
    ? JSON.stringify(mapped)           // no whitespace
    : JSON.stringify(mapped, null, 2); // pretty
  return { content: [{ type: "text", text }] };
}
```

The `compactify()` function recursively maps known field names and strips null/undefined values.

### Skill Integration
The skill's `buildSkillContent()` function includes the field mapping table ONLY when `config.compactResponses` is true. When false, the mapping section is omitted — no wasted tokens.

---

## 3. move_file Tool

### Granular Mode
```typescript
server.tool("move_file", "Move or rename a vault file (not idempotent)", {
  source: z.string().describe("Source file path"),
  destination: z.string().describe("Destination file path"),
}, async ({ source, destination }) => {
  // 1. Validate both paths
  const sanitizedSource = sanitizeFilePath(source);
  const sanitizedDest = sanitizeFilePath(destination);
  
  // 2. Check source exists
  const content = await client.getFileContents(sanitizedSource, "markdown");
  
  // 3. Check destination doesn't exist
  try {
    await client.getFileContents(sanitizedDest, "markdown");
    return errorResult("CONFLICT: Destination already exists. Delete it first or choose a different path.");
  } catch (e) {
    // 404 = good, destination is free
  }
  
  // 4. Write to destination
  await client.putContent(sanitizedDest, content);
  
  // 5. Delete source
  await client.deleteFile(sanitizedSource);
  
  // 6. Update cache
  cache.invalidate(sanitizedSource);
  // Destination will be picked up on next cache refresh
  
  return textResult(`Moved: ${sanitizedSource} → ${sanitizedDest}`);
});
```

### Consolidated Mode
Add `move` action to the `vault` tool. Requires `source` and `destination` params.

### Edge Cases
- Same source and destination → return success (no-op)
- Source not found → NOT FOUND error with suggestion to list files
- Destination exists → CONFLICT error
- Move preserves content exactly (binary-safe via markdown format)

---

## 4. SEA Binary (Node.js Single Executable Application)

### What
Compile the server into a standalone binary. Users don't need Node.js. macOS permission dialog shows "mcp-obsidian-extended" instead of "node".

### Build Script

Add to package.json:
```json
{
  "scripts": {
    "build:sea": "node scripts/build-sea.js"
  }
}
```

### scripts/build-sea.js
```javascript
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, copyFileSync } from 'fs';

// 1. Create SEA config
const seaConfig = {
  main: 'dist/index.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
writeFileSync('sea-config.json', JSON.stringify(seaConfig));

// 2. Generate blob
execSync('node --experimental-sea-config sea-config.json');

// 3. Copy node binary
const nodePath = process.execPath;
const binaryName = 'mcp-obsidian-extended';
copyFileSync(nodePath, binaryName);

// 4. Inject blob (macOS)
if (process.platform === 'darwin') {
  execSync(`codesign --remove-signature ${binaryName}`);
  execSync(`npx postject ${binaryName} NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`);
  execSync(`codesign --sign - ${binaryName}`);
}

// 5. Cleanup
execSync('rm sea-config.json sea-prep.blob');

console.log(`Built: ./${binaryName}`);
```

### GitHub Release
Add to CI workflow — build SEA for macOS (arm64 + x64) and Linux (x64). Attach binaries to GitHub release.

### Claude Desktop Config (binary mode)
```json
{
  "mcpServers": {
    "mcp-obsidian-extended": {
      "command": "/path/to/mcp-obsidian-extended",
      "env": { "OBSIDIAN_API_KEY": "<key>" }
    }
  }
}
```

---

## New Env Vars

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSIDIAN_COMPACT_RESPONSES` | `false` | Enable compact field names in responses |

Total env vars: 18 (was 17)

## New/Modified Files

| File | Change |
|------|--------|
| `src/tools/shared.ts` | Add `compactify()`, update `jsonResult()` |
| `src/tools/granular.ts` | Add `move_file` tool |
| `src/tools/consolidated.ts` | Add `move` action to vault tool |
| `src/config.ts` | Add `compactResponses` to config + DEFAULTS |
| `src/index.ts` | Register MCP resource for skill |
| `.claude/skills/obsidian-mcp/SKILL.md` | New — static skill file |
| `scripts/build-sea.js` | New — SEA build script |
| `package.json` | Add build:sea script, update files array, bump to 1.1.0 |
| `README.md` | Document new features |
| `CHANGELOG.md` | v1.1.0 entry |

## Verification

After building all 4 features:
1. `npm run build` — zero errors
2. `npm run lint` — zero errors/warnings
3. `npm run test` — all pass (add tests for move_file, compact responses, skill resource)
4. `npm run test:coverage` — 80%+ maintained
5. `npm run verify:all`
6. `npm run security:all`
7. `npm run sonar`
8. Test skill resource: verify it returns correct content for both modes
9. Test compact responses: verify field mapping works, verify verbose mode unchanged
10. Test move_file: move a file, verify source gone, destination has content
11. `npm run build:sea` — verify binary works (macOS)
12. `npm run pr:audit`
