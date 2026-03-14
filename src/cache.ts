import type { ObsidianClient, NoteJson, VaultCacheInterface } from "./obsidian.js";
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
  const links: ParsedLink[] = [];
  const currentDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";

  // Wikilinks: [[note]], [[note|alias]], [[note#heading]]
  // eslint-disable-next-line security/detect-unsafe-regex -- regex is safe: no nested quantifiers, character classes are bounded
  const wikiRegex = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null = null;
  while ((match = wikiRegex.exec(content)) !== null) {
    const rawTarget = match[1];
    if (!rawTarget) continue;
    const target = resolveWikilink(rawTarget.trim(), currentDir);
    const contextStart = Math.max(0, match.index - 25);
    const contextEnd = Math.min(content.length, match.index + match[0].length + 25);
    links.push({
      target,
      type: "wikilink",
      context: content.slice(contextStart, contextEnd).replace(/\n/g, " "),
    });
  }

  // Markdown links: [text](path.md)
  const mdRegex = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  while ((match = mdRegex.exec(content)) !== null) {
    const rawTarget = match[2];
    if (!rawTarget) continue;
    const target = resolveRelativePath(rawTarget.trim(), currentDir);
    const contextStart = Math.max(0, match.index - 25);
    const contextEnd = Math.min(content.length, match.index + match[0].length + 25);
    links.push({
      target,
      type: "markdown",
      context: content.slice(contextStart, contextEnd).replace(/\n/g, " "),
    });
  }

  return links;
}

/** Normalises a wikilink target to a short `.md` filename for later index-based resolution. */
function resolveWikilink(target: string, _currentDir: string): string {
  let resolved = target;
  if (!resolved.endsWith(".md")) {
    resolved = `${resolved}.md`;
  }
  // Wikilinks are vault-wide; keep as short name — resolved at graph-query time via suffix match
  return resolved.replace(/\\/g, "/");
}

/** Resolves a relative markdown link path against the directory of the containing note. */
function resolveRelativePath(target: string, currentDir: string): string {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return normalized.slice(1);
  }
  // Resolve relative paths (including ../) against the current directory
  const base = currentDir ? `${currentDir}/` : "";
  const parts = `${base}${normalized}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
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
  /** Maps normalised short filename (e.g. "notename.md") → Set of full vault paths. */
  private readonly shortNameIndex = new Map<string, Set<string>>();

  /** Creates a new vault cache backed by the given Obsidian client and refresh interval. */
  constructor(client: ObsidianClient, cacheTtl: number) {
    this.client = client;
    this.cacheTtl = cacheTtl;
  }

  // --- Initialization ---

  /** Performs a full cache build by fetching all markdown files from the vault. */
  async initialize(): Promise<void> {
    const startTime = Date.now();
    try {
      const { files } = await this.client.listFilesInVault();
      const mdFiles = files.filter((f) => f.endsWith(".md"));

      log("info", `Cache: indexing ${String(mdFiles.length)} markdown files...`);

      // Fetch in batches to avoid overwhelming the server
      const batchSize = 20;
      for (let i = 0; i < mdFiles.length; i += batchSize) {
        const batch = mdFiles.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (filePath) => {
            const noteJson = await this.client.getFileContents(filePath, "json") as NoteJson;
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
            this.notes.set(filePath, cached);
          }),
        );

        for (const result of results) {
          if (result.status === "rejected") {
            log("debug", `Cache: failed to fetch a file: ${String(result.reason)}`);
          }
        }
      }

      this.rebuildIndex();
      this.isInitialized = true;
      const elapsed = Date.now() - startTime;
      log("info", `Cache: ready (${String(this.notes.size)} notes, ${String(this.linkCount)} links) in ${String(elapsed)}ms`);
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
   */
  async refresh(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
      return;
    }

    try {
      const { files } = await this.client.listFilesInVault();
      const mdFiles = new Set(files.filter((f) => f.endsWith(".md")));

      // Remove deleted notes from cache (uses invalidate to also update shortNameIndex)
      for (const cachedPath of [...this.notes.keys()]) {
        if (!mdFiles.has(cachedPath)) {
          this.invalidate(cachedPath);
        }
      }

      // Re-fetch all notes; only update cache entries whose mtime changed
      let updated = 0;
      const batchSize = 20;
      const filesToCheck = [...mdFiles];

      for (let i = 0; i < filesToCheck.length; i += batchSize) {
        const batch = filesToCheck.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (filePath) => {
            const noteJson = await this.client.getFileContents(filePath, "json") as NoteJson;
            const existing = this.notes.get(filePath);

            if (!existing || existing.stat.mtime !== noteJson.stat.mtime) {
              const links = parseLinks(noteJson.content, filePath);
              this.notes.set(filePath, {
                path: filePath,
                content: noteJson.content,
                frontmatter: noteJson.frontmatter,
                tags: noteJson.tags,
                stat: noteJson.stat,
                links,
                cachedAt: Date.now(),
              });
              updated++;
            }
          }),
        );

        for (const result of results) {
          if (result.status === "rejected") {
            log("debug", `Cache refresh: failed to fetch a file: ${String(result.reason)}`);
          }
        }
      }

      if (updated > 0) {
        this.rebuildIndex();
        log("debug", `Cache refreshed: ${String(updated)} notes updated`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Cache refresh failed: ${message}`);
    }
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

  /** Clears the entire cache, index, and resets the initialised flag. */
  invalidateAll(): void {
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
      results.push({
        path: note.path,
        inbound: inboundCounts.get(note.path) ?? 0,
        outbound: note.links.length,
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
        edges.push({ source: note.path, target: resolvedTarget });
      }
    }

    return { nodes, edges };
  }

  // --- Helpers ---

  /** Searches for a cached note by case-insensitive filename match. */
  private findByName(nameOrPath: string): CachedNote | undefined {
    // Support looking up by just the filename (without path)
    const lower = nameOrPath.toLowerCase();
    for (const note of this.notes.values()) {
      if (note.path.toLowerCase() === lower) {
        return note;
      }
      const filename = note.path.split("/").pop()?.toLowerCase();
      if (filename === lower || filename === `${lower}.md`) {
        return note;
      }
    }
    return undefined;
  }

  /** Normalises a link target to lowercase with forward slashes and a `.md` extension. */
  private normalizeLinkTarget(path: string): string {
    let normalized = path.toLowerCase().replace(/\\/g, "/");
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
   */
  private resolveLinkToFullPath(linkTarget: string): string {
    const normalized = this.normalizeLinkTarget(linkTarget);
    // Exact match — already a full path
    if (this.notes.has(linkTarget)) {
      return linkTarget;
    }
    // Short-name lookup via index
    const shortName = normalized.split("/").pop() ?? normalized;
    const candidates = this.shortNameIndex.get(shortName);
    if (candidates) {
      for (const candidate of candidates) {
        const normalizedCandidate = this.normalizeLinkTarget(candidate);
        if (normalizedCandidate === normalized || normalizedCandidate.endsWith(`/${normalized}`)) {
          return candidate;
        }
      }
    }
    return linkTarget;
  }
}
