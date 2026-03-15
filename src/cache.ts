import type { ObsidianClient, VaultCacheInterface } from "./obsidian.js";
import { log } from "./config.js";

// --- Types ---

/** A parsed link extracted from note content, with resolved target and context. */
export interface ParsedLink {
  readonly target: string;
  readonly type: "wikilink" | "markdown";
  readonly context: string;
}

/** A cached vault note with parsed content, frontmatter, tags, stat, and links. */
export interface CachedNote {
  readonly path: string;
  readonly content: string;
  readonly frontmatter: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly stat: { readonly ctime: number; readonly mtime: number; readonly size: number };
  readonly links: readonly ParsedLink[];
  readonly cachedAt: number;
}

// --- Link Parser ---

/**
 * Parses `[[wikilinks]]` and `[text](path.md)` links from note content.
 * Wikilinks are stored as short names (e.g. `NoteName.md`) without directory —
 * graph queries use suffix matching to resolve them to full vault paths.
 *
 * @param content - The markdown content to parse.
 * @param currentPath - The vault path of the note containing the links.
 */
export function parseLinks(content: string, currentPath: string): ParsedLink[] {
  const currentDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
  return [
    ...parseWikilinks(content),
    ...parseMarkdownLinks(content, currentDir),
  ];
}

/** Scans content for [[wikilink]] patterns using string scanning (no regex). Handles unclosed [[ by skipping to the next [[ instead of consuming a later ]] greedily. */
function parseWikilinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  let pos = 0;
  while (pos < content.length) {
    const start = content.indexOf("[[", pos);
    if (start === -1) break;
    const end = content.indexOf("]]", start + 2);
    if (end === -1) break;
    // Check for a nested [[ between start and end — if found, the outer [[ is unclosed
    const nestedOpen = content.indexOf("[[", start + 2);
    if (nestedOpen !== -1 && nestedOpen < end) {
      // Skip this unclosed [[ and restart from the nested one
      pos = nestedOpen;
      continue;
    }
    const inner = content.slice(start + 2, end);
    const rawTarget = extractWikilinkTarget(inner);
    if (rawTarget.length > 0) {
      const target = resolveWikilink(rawTarget);
      const contextStart = Math.max(0, start - 25);
      const contextEnd = Math.min(content.length, end + 2 + 25);
      links.push({
        target,
        type: "wikilink",
        context: content.slice(contextStart, contextEnd).replaceAll("\n", " "),
      });
    }
    pos = end + 2;
  }
  return links;
}

/** Extracts the note name from a wikilink inner text, stripping #heading and |alias. */
function extractWikilinkTarget(inner: string): string {
  const hashIdx = inner.indexOf("#");
  const pipeIdx = inner.indexOf("|");
  let raw = inner;
  if (hashIdx !== -1 && (pipeIdx === -1 || hashIdx < pipeIdx)) {
    raw = inner.slice(0, hashIdx);
  } else if (pipeIdx !== -1) {
    raw = inner.slice(0, pipeIdx);
  }
  return raw.trim();
}

/** Finds the closing `)` that matches the `(` at `openPos`, accounting for nested parentheses. Returns -1 if unmatched. */
function findMatchingParen(content: string, openPos: number): number {
  let depth = 1;
  for (let i = openPos + 1; i < content.length; i++) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
    // Stop at newline — markdown links don't span lines
    if (content[i] === "\n") return -1;
  }
  return -1;
}

/** Scans content for [text](path.md) patterns using string scanning (no regex). Handles parentheses in paths by matching balanced parens. */
function parseMarkdownLinks(content: string, currentDir: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  let pos = 0;
  while (pos < content.length) {
    const bracketOpen = content.indexOf("[", pos);
    if (bracketOpen === -1) break;
    const bracketClose = content.indexOf("]", bracketOpen + 1);
    if (bracketClose === -1) break;
    if (content[bracketClose + 1] !== "(") { pos = bracketClose + 1; continue; }
    const parenClose = findMatchingParen(content, bracketClose + 1);
    if (parenClose === -1) { pos = bracketClose + 2; continue; }
    const rawUrl = content.slice(bracketClose + 2, parenClose);
    // Decode URL-encoded paths (e.g. %20 → space) before extraction
    let url: string;
    try { url = decodeURIComponent(rawUrl); } catch { url = rawUrl; }
    const urlPath = extractMdLinkPath(url);
    if (urlPath !== undefined) {
      const target = resolveRelativePath(urlPath, currentDir);
      const contextStart = Math.max(0, bracketOpen - 25);
      const contextEnd = Math.min(content.length, parenClose + 1 + 25);
      links.push({
        target,
        type: "markdown",
        context: content.slice(contextStart, contextEnd).replaceAll("\n", " "),
      });
    }
    pos = parenClose + 1;
  }
  return links;
}

/** Extracts the .md path from a markdown link URL, stripping #fragment, ?query, and "title". Returns undefined for non-.md or external links. */
function extractMdLinkPath(url: string): string | undefined {
  // Reject absolute URLs (http://, https://, obsidian://, etc.)
  if (/^[a-z][a-z0-9+\-.]*:/i.test(url)) {
    return undefined;
  }
  const hashPos = url.indexOf("#");
  const queryPos = url.indexOf("?");
  let pathEnd = url.length;
  if (hashPos !== -1 && hashPos < pathEnd) pathEnd = hashPos;
  if (queryPos !== -1 && queryPos < pathEnd) pathEnd = queryPos;
  let path = url.slice(0, pathEnd).trim();
  // Strip optional title: [text](path.md "title") or [text](path.MD 'title')
  const titleMatch = /^(.+\.md)\s+["']/i.exec(path);
  if (titleMatch?.[1]) {
    path = titleMatch[1];
  }
  return path.toLowerCase().endsWith(".md") && path.length > 3 ? path : undefined;
}

/** Normalises a wikilink target to a short `.md` filename for later index-based resolution. */
function resolveWikilink(target: string): string {
  let resolved = target;
  if (!resolved.toLowerCase().endsWith(".md")) {
    resolved = `${resolved}.md`;
  }
  // Wikilinks are vault-wide; keep as short name — resolved at graph-query time via suffix match
  return resolved.replaceAll("\\", "/");
}

/** Resolves a relative markdown link path against the directory of the containing note. */
function resolveRelativePath(target: string, currentDir: string): string {
  const normalized = target.replaceAll("\\", "/");
  // For absolute paths, strip the leading slash; for relative, prepend currentDir
  let raw: string;
  if (normalized.startsWith("/")) {
    raw = normalized.slice(1);
  } else {
    const base = currentDir ? `${currentDir}/` : "";
    raw = `${base}${normalized}`;
  }
  const parts = raw.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== "." && part !== "") {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

// --- Vault Cache ---

/**
 * In-memory cache of all vault markdown notes with parsed links and graph queries.
 * Provides backlink resolution, orphan detection, and connectivity analysis.
 */
export class VaultCache implements VaultCacheInterface {
  private readonly notes = new Map<string, CachedNote>();
  private readonly client: ObsidianClient;
  private readonly cacheTtl: number;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private isInitialized = false;
  private isRefreshing = false;
  /** Generation counter: incremented on invalidateAll(), checked after builds to discard stale results. */
  private generation = 0;
  /** Maps normalised short filename (e.g. "notename.md") → Set of full vault paths. */
  private readonly shortNameIndex = new Map<string, Set<string>>();

  /** Creates a new vault cache backed by the given Obsidian client and refresh interval. */
  constructor(client: ObsidianClient, cacheTtl: number) {
    this.client = client;
    this.cacheTtl = cacheTtl;
  }

  // --- Initialization ---

  /**
   * Performs a full cache build by fetching all markdown files from the vault.
   * Builds into a fresh snapshot then swaps atomically. Discards results if
   * invalidateAll() was called during the build (generation mismatch).
   * @throws {Error} On network failure or when the vault listing cannot be retrieved.
   */
  async initialize(): Promise<void> {
    const startTime = Date.now();
    const buildGeneration = this.generation;
    try {
      const { files } = await this.client.listFilesInVault();
      const mdFiles = files.filter((f) => f.toLowerCase().endsWith(".md"));

      log("info", `Cache: indexing ${String(mdFiles.length)} markdown files...`);

      // Build into a temporary map so stale entries from previous runs don't persist
      const freshNotes = new Map<string, CachedNote>();
      const batchSize = 20;
      for (let i = 0; i < mdFiles.length; i += batchSize) {
        const batch = mdFiles.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (filePath) => {
            const result = await this.client.getFileContents(filePath, "json");
            if (typeof result === "string" || !("content" in result)) {
              throw new Error(`Expected NoteJson for ${filePath}, got unexpected format`);
            }
            const noteJson = result;
            const links = parseLinks(noteJson.content, filePath);
            const cached: CachedNote = {
              path: filePath,
              content: noteJson.content,
              frontmatter: noteJson.frontmatter,
              tags: noteJson.tags,
              stat: noteJson.stat,
              links,
              cachedAt: Date.now(),
            };
            freshNotes.set(filePath, cached);
          }),
        );

        for (const result of results) {
          if (result.status === "rejected") {
            log("debug", `Cache: failed to fetch a file: ${String(result.reason)}`);
          }
        }
      }

      // Discard if invalidateAll() was called while we were building
      if (this.generation !== buildGeneration) {
        log("debug", "Cache build discarded: vault was invalidated during build");
        return;
      }
      // Swap atomically: clear old entries and copy fresh ones in
      this.notes.clear();
      for (const [key, value] of freshNotes) {
        this.notes.set(key, value);
      }
      this.rebuildIndex();
      const elapsed = Date.now() - startTime;
      if (this.notes.size > 0 || mdFiles.length === 0) {
        // Mark initialized if we got some notes, or if the vault is genuinely empty
        this.isInitialized = true;
        log("info", `Cache: ready (${String(this.notes.size)} notes, ${String(this.linkCount)} links) in ${String(elapsed)}ms`);
      } else {
        log("warn", `Cache: all ${String(mdFiles.length)} file fetches failed (${String(elapsed)}ms). Will retry on next refresh.`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Cache initialization failed: ${message}`);
      throw err;
    }
  }

  /**
   * Refreshes the cache by re-fetching all notes and only updating those
   * whose mtime has changed. Note: the Obsidian REST API does not expose
   * stat info on the listing endpoint, so each note must be fetched individually
   * to check mtime. For large vaults this means N HTTP requests per refresh cycle.
   * The comparison itself is incremental (only changed notes are re-parsed),
   * but the network cost is proportional to vault size.
   * Errors are caught and logged — never throws.
   */
  async refresh(): Promise<void> {
    if (this.isRefreshing) {
      return;
    }
    this.isRefreshing = true;
    const refreshGeneration = this.generation;
    try {
      if (!this.isInitialized) {
        await this.initialize();
        return;
      }

      const { files } = await this.client.listFilesInVault();
      const mdFiles = new Set(files.filter((f) => f.toLowerCase().endsWith(".md")));

      const deleted = this.pruneDeletedNotes(mdFiles);
      const updated = await this.fetchChangedNotes([...mdFiles], refreshGeneration);

      if (this.generation !== refreshGeneration) {
        log("debug", "Cache refresh discarded: vault was invalidated during refresh");
        return;
      }

      if (updated > 0 || deleted > 0) {
        this.rebuildIndex();
        log("debug", `Cache refreshed: ${String(updated)} updated, ${String(deleted)} deleted`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Cache refresh failed: ${message}`);
    } finally {
      this.isRefreshing = false;
    }
  }

  /** Removes cached notes that no longer exist in the vault file list. */
  private pruneDeletedNotes(currentFiles: Set<string>): number {
    let deleted = 0;
    for (const cachedPath of this.notes.keys()) {
      if (!currentFiles.has(cachedPath)) {
        this.invalidate(cachedPath);
        deleted++;
      }
    }
    return deleted;
  }

  /** Fetches notes in batches and updates cache entries whose mtime has changed. */
  private async fetchChangedNotes(filesToCheck: readonly string[], expectedGeneration: number): Promise<number> {
    let updated = 0;
    const batchSize = 20;

    for (let i = 0; i < filesToCheck.length; i += batchSize) {
      const batch = filesToCheck.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          const result = await this.client.getFileContents(filePath, "json");
          if (typeof result === "string" || !("content" in result)) {
            throw new Error(`Expected NoteJson for ${filePath}, got unexpected format`);
          }
          const existing = this.notes.get(filePath);
          if (existing?.stat.mtime !== result.stat.mtime) {
            if (this.generation !== expectedGeneration) return;
            const links = parseLinks(result.content, filePath);
            this.notes.set(filePath, {
              path: filePath,
              content: result.content,
              frontmatter: result.frontmatter,
              tags: result.tags,
              stat: result.stat,
              links,
              cachedAt: Date.now(),
            });
            updated++;
          }
        }),
      );

      for (const r of results) {
        if (r.status === "rejected") {
          log("debug", `Cache refresh: failed to fetch a file: ${String(r.reason)}`);
        }
      }
    }
    return updated;
  }

  /** Starts a background timer that periodically refreshes the cache. */
  startAutoRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    const MIN_TTL = 10_000;
    const interval = Math.max(this.cacheTtl, MIN_TTL);
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, interval);
    // Allow Node.js to exit when the MCP transport closes
    this.refreshTimer.unref();
  }

  /** Stops the background auto-refresh timer if running. */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  // --- Accessors ---

  /** Returns a cached note by exact path, falling back to filename-based lookup. */
  getNote(path: string): CachedNote | undefined {
    return this.notes.get(path) ?? this.findByName(path);
  }

  /** Returns all cached notes as an array. */
  getAllNotes(): readonly CachedNote[] {
    return [...this.notes.values()];
  }

  /** Returns all cached file paths. */
  getFileList(): readonly string[] {
    return [...this.notes.keys()];
  }

  get noteCount(): number {
    return this.notes.size;
  }

  get linkCount(): number {
    let count = 0;
    for (const note of this.notes.values()) {
      count += note.links.length;
    }
    return count;
  }

  /** Returns whether the cache has completed its initial build. */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  // --- Invalidation ---

  /** Removes a single note from the cache and updates the short-name index. */
  invalidate(path: string): void {
    this.notes.delete(path);
    const shortName = path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
    const bucket = this.shortNameIndex.get(shortName);
    if (bucket) {
      bucket.delete(path);
      if (bucket.size === 0) {
        this.shortNameIndex.delete(shortName);
      }
    }
  }

  /**
   * Clears the entire cache, index, and resets the initialised flag.
   * Increments the generation counter so that any in-flight build discards its stale results.
   */
  invalidateAll(): void {
    this.generation++;
    this.notes.clear();
    this.shortNameIndex.clear();
    this.isInitialized = false;
  }

  // --- Graph Queries ---

  /** Returns all notes that link to the given file path, with surrounding context. */
  getBacklinks(path: string): Array<{ source: string; context: string }> {
    const results: Array<{ source: string; context: string }> = [];

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        if (this.resolveLinkToFullPath(link.target) === path) {
          results.push({ source: note.path, context: link.context });
        }
      }
    }

    return results;
  }

  /** Returns all outbound links from the given note. */
  getForwardLinks(path: string): readonly ParsedLink[] {
    const note = this.getNote(path);
    return note?.links ?? [];
  }

  /** Returns paths of notes with zero inbound links (orphans). */
  getOrphanNotes(): readonly string[] {
    // Build set of all note paths that have at least one inbound link
    const notesWithInbound = new Set<string>();
    for (const note of this.notes.values()) {
      for (const link of note.links) {
        const resolved = this.resolveLinkToFullPath(link.target);
        if (this.notes.has(resolved)) {
          notesWithInbound.add(resolved);
        }
      }
    }

    // Orphan = no inbound links (standard Obsidian definition), regardless of outbound links
    const orphans: string[] = [];
    for (const note of this.notes.values()) {
      if (!notesWithInbound.has(note.path)) {
        orphans.push(note.path);
      }
    }

    return orphans;
  }

  /** Returns the most connected notes sorted by total link count (inbound + outbound). */
  getMostConnectedNotes(limit: number): Array<{ path: string; inbound: number; outbound: number }> {
    const inboundCounts = new Map<string, number>();

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        const resolved = this.resolveLinkToFullPath(link.target);
        if (this.notes.has(resolved)) {
          inboundCounts.set(resolved, (inboundCounts.get(resolved) ?? 0) + 1);
        }
      }
    }

    const results: Array<{ path: string; inbound: number; outbound: number }> = [];

    for (const note of this.notes.values()) {
      // Count only outbound links that resolve to existing notes (consistent with inbound)
      const resolvedOutbound = note.links.filter((link) => {
        const resolved = this.resolveLinkToFullPath(link.target);
        return this.notes.has(resolved);
      }).length;
      results.push({
        path: note.path,
        inbound: inboundCounts.get(note.path) ?? 0,
        outbound: resolvedOutbound,
      });
    }

    results.sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound));
    return results.slice(0, limit);
  }

  /** Returns the full vault link graph as nodes (file paths) and edges (source-target pairs). */
  getVaultGraph(): { nodes: readonly string[]; edges: ReadonlyArray<{ source: string; target: string }> } {
    const nodes: string[] = [...this.notes.keys()];
    const edges: Array<{ source: string; target: string }> = [];

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        const resolvedTarget = this.resolveLinkToFullPath(link.target);
        // Only include edges to notes that exist in the cache — skip unresolved/external links
        if (this.notes.has(resolvedTarget)) {
          edges.push({ source: note.path, target: resolvedTarget });
        }
      }
    }

    return { nodes, edges };
  }

  // --- Helpers ---

  /** Searches for a cached note by short-name index (O(1)) with fallback for case-insensitive full-path match. */
  private findByName(nameOrPath: string): CachedNote | undefined {
    const lower = nameOrPath.toLowerCase();

    // O(1) lookup via shortNameIndex: try exact short name first, then with .md appended
    const shortNameCandidates = this.shortNameIndex.get(lower) ?? this.shortNameIndex.get(`${lower}.md`);
    if (shortNameCandidates) {
      for (const candidate of shortNameCandidates) {
        const note = this.notes.get(candidate);
        if (note) {
          return note;
        }
      }
    }

    // Fallback: case-insensitive full-path match
    for (const note of this.notes.values()) {
      if (note.path.toLowerCase() === lower) {
        return note;
      }
    }

    return undefined;
  }

  /** Normalises a link target to lowercase with forward slashes and a `.md` extension. */
  private normalizeLinkTarget(path: string): string {
    let normalized = path.toLowerCase().replaceAll("\\", "/");
    if (!normalized.endsWith(".md")) {
      normalized = `${normalized}.md`;
    }
    return normalized;
  }

  /** Rebuilds the short-name index for O(1) wikilink resolution. */
  private rebuildIndex(): void {
    this.shortNameIndex.clear();
    for (const path of this.notes.keys()) {
      const shortName = path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
      let bucket = this.shortNameIndex.get(shortName);
      if (!bucket) {
        bucket = new Set<string>();
        this.shortNameIndex.set(shortName, bucket);
      }
      bucket.add(path);
    }
  }

  /**
   * Resolves a link target to a full vault path using the short-name index.
   * Returns the first matching full path, or the original target if unresolved.
   * Note: the exact-match fast-path is case-sensitive; case-insensitive resolution
   * falls through to the O(1) short-name index lookups below.
   */
  private resolveLinkToFullPath(linkTarget: string): string {
    const normalized = this.normalizeLinkTarget(linkTarget);
    // Fast-path: exact case-sensitive match — already a full path
    if (this.notes.has(linkTarget)) {
      return linkTarget;
    }
    // Normalized exact match — covers case-insensitive full paths without index scan
    if (this.notes.has(normalized)) {
      return normalized;
    }
    // Short-name lookup via index (handles short-name wikilinks and remaining case variants)
    const shortName = normalized.split("/").pop() ?? normalized;
    const candidates = this.shortNameIndex.get(shortName);
    if (candidates) {
      // Pass 1: exact normalized path match (also covers root-level notes like "notename.md")
      for (const candidate of candidates) {
        if (this.normalizeLinkTarget(candidate) === normalized) {
          return candidate;
        }
      }
      // Pass 2: suffix fallback for short-name wikilinks in subdirectories
      // Require a `/` boundary to prevent partial directory segment matches
      // (e.g. "bar/note.md" should not match "foobar/note.md")
      for (const candidate of candidates) {
        const candidateNorm = this.normalizeLinkTarget(candidate);
        if (candidateNorm.endsWith(`/${normalized}`) || candidateNorm === normalized) {
          return candidate;
        }
      }
    }
    return linkTarget;
  }
}
