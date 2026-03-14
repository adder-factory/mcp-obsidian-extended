import type { ObsidianClient, NoteJson, VaultCacheInterface } from "./obsidian.js";
import { log } from "./config.js";

// --- Types ---

export interface ParsedLink {
  readonly target: string;
  readonly type: "wikilink" | "markdown";
  readonly context: string;
}

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

export function parseLinks(content: string, currentPath: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const currentDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";

  // Wikilinks: [[note]], [[note|alias]], [[note#heading]]
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

function resolveWikilink(target: string, currentDir: string): string {
  // Wikilinks are typically just note names without extension
  let resolved = target;
  if (!resolved.endsWith(".md")) {
    resolved = `${resolved}.md`;
  }
  // If it's a relative path, resolve from current dir
  if (!resolved.includes("/") && currentDir) {
    // Wikilinks are vault-wide — keep as-is (resolved at lookup time)
  }
  return resolved.replace(/\\/g, "/");
}

function resolveRelativePath(target: string, currentDir: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  if (currentDir && !target.includes("/")) {
    return `${currentDir}/${target}`;
  }
  return target.replace(/\\/g, "/");
}

// --- Vault Cache ---

export class VaultCache implements VaultCacheInterface {
  private readonly notes = new Map<string, CachedNote>();
  private readonly client: ObsidianClient;
  private readonly cacheTtl: number;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private isInitialized = false;

  constructor(client: ObsidianClient, cacheTtl: number) {
    this.client = client;
    this.cacheTtl = cacheTtl;
  }

  // --- Initialization ---

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

      this.isInitialized = true;
      const elapsed = Date.now() - startTime;
      log("info", `Cache: ready (${String(this.notes.size)} notes, ${String(this.linkCount)} links) in ${String(elapsed)}ms`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Cache initialization failed: ${message}`);
      throw err;
    }
  }

  async refresh(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
      return;
    }

    try {
      const { files } = await this.client.listFilesInVault();
      const mdFiles = new Set(files.filter((f) => f.endsWith(".md")));

      // Remove deleted notes from cache
      for (const cachedPath of this.notes.keys()) {
        if (!mdFiles.has(cachedPath)) {
          this.notes.delete(cachedPath);
        }
      }

      // Incremental: only re-fetch files with newer mtime
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
        log("debug", `Cache refreshed: ${String(updated)} notes updated`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `Cache refresh failed: ${message}`);
    }
  }

  startAutoRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.cacheTtl);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  // --- Accessors ---

  getNote(path: string): CachedNote | undefined {
    return this.notes.get(path) ?? this.findByName(path);
  }

  getAllNotes(): readonly CachedNote[] {
    return [...this.notes.values()];
  }

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

  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  // --- Invalidation ---

  invalidate(path: string): void {
    this.notes.delete(path);
  }

  invalidateAll(): void {
    this.notes.clear();
    this.isInitialized = false;
  }

  // --- Graph Queries ---

  getBacklinks(path: string): Array<{ source: string; context: string }> {
    const results: Array<{ source: string; context: string }> = [];
    const normalizedTarget = this.normalizeLinkTarget(path);

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        const normalizedLink = this.normalizeLinkTarget(link.target);
        if (normalizedLink === normalizedTarget) {
          results.push({ source: note.path, context: link.context });
        }
      }
    }

    return results;
  }

  getForwardLinks(path: string): readonly ParsedLink[] {
    const note = this.getNote(path);
    return note?.links ?? [];
  }

  getOrphanNotes(): readonly string[] {
    const linkedPaths = new Set<string>();

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        linkedPaths.add(this.normalizeLinkTarget(link.target));
      }
    }

    const orphans: string[] = [];
    for (const note of this.notes.values()) {
      const normalized = this.normalizeLinkTarget(note.path);
      const hasInbound = linkedPaths.has(normalized);
      const hasOutbound = note.links.length > 0;
      if (!hasInbound && !hasOutbound) {
        orphans.push(note.path);
      }
    }

    return orphans;
  }

  getMostConnectedNotes(limit: number): Array<{ path: string; inbound: number; outbound: number }> {
    const inboundCounts = new Map<string, number>();

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        const normalized = this.normalizeLinkTarget(link.target);
        inboundCounts.set(normalized, (inboundCounts.get(normalized) ?? 0) + 1);
      }
    }

    const results: Array<{ path: string; inbound: number; outbound: number }> = [];

    for (const note of this.notes.values()) {
      const normalized = this.normalizeLinkTarget(note.path);
      results.push({
        path: note.path,
        inbound: inboundCounts.get(normalized) ?? 0,
        outbound: note.links.length,
      });
    }

    results.sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound));
    return results.slice(0, limit);
  }

  getVaultGraph(): { nodes: readonly string[]; edges: ReadonlyArray<{ source: string; target: string }> } {
    const nodes: string[] = [...this.notes.keys()];
    const edges: Array<{ source: string; target: string }> = [];

    for (const note of this.notes.values()) {
      for (const link of note.links) {
        edges.push({ source: note.path, target: link.target });
      }
    }

    return { nodes, edges };
  }

  // --- Helpers ---

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

  private normalizeLinkTarget(path: string): string {
    let normalized = path.toLowerCase().replace(/\\/g, "/");
    if (!normalized.endsWith(".md")) {
      normalized = `${normalized}.md`;
    }
    return normalized;
  }
}
