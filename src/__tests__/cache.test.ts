import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { parseLinks, VaultCache } from "../cache.js";
// CachedNote and ParsedLink types used only indirectly via mock helpers
import type { ObsidianClient, NoteJson } from "../obsidian.js";

// Suppress stderr output
beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseLinks — wikilinks
// ---------------------------------------------------------------------------
describe("parseLinks — wikilinks", () => {
  it("extracts simple [[wikilink]]", () => {
    const links = parseLinks("See [[MyNote]] for details", "folder/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("MyNote.md");
    expect(links[0]?.type).toBe("wikilink");
  });

  it("extracts [[wikilink|alias]]", () => {
    const links = parseLinks("See [[MyNote|display text]] here", "current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("MyNote.md");
  });

  it("extracts [[wikilink#heading]]", () => {
    const links = parseLinks("See [[MyNote#Section 1]] here", "current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("MyNote.md");
  });

  it("extracts [[wikilink#heading|alias]]", () => {
    const links = parseLinks("See [[MyNote#heading|alias]] here", "current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("MyNote.md");
  });

  it("extracts multiple wikilinks", () => {
    const links = parseLinks("[[A]] and [[B]] and [[C]]", "test.md");
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.target)).toEqual(["A.md", "B.md", "C.md"]);
  });

  it("adds .md extension if missing", () => {
    const links = parseLinks("[[NoteName]]", "test.md");
    expect(links[0]?.target).toBe("NoteName.md");
  });

  it("does not double-add .md extension", () => {
    const links = parseLinks("[[NoteName.md]]", "test.md");
    expect(links[0]?.target).toBe("NoteName.md");
  });

  it("provides context around the link", () => {
    const content = "Some text before [[TargetNote]] some text after";
    const links = parseLinks(content, "test.md");
    expect(links[0]?.context).toContain("[[TargetNote]]");
    expect(links[0]?.context.length).toBeGreaterThan(0);
    expect(links[0]?.context.length).toBeLessThanOrEqual(content.length);
  });

  it("normalises backslashes in wikilink target", () => {
    const links = parseLinks(String.raw`[[folder\note]]`, "test.md");
    expect(links[0]?.target).toBe("folder/note.md");
  });
});

// ---------------------------------------------------------------------------
// parseLinks — markdown links
// ---------------------------------------------------------------------------
describe("parseLinks — markdown links", () => {
  it("extracts [text](path.md) links", () => {
    const links = parseLinks("See [my link](notes/target.md) here", "folder/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/notes/target.md");
    expect(links[0]?.type).toBe("markdown");
  });

  it("resolves relative paths with ../", () => {
    const links = parseLinks("See [link](../other/note.md) here", "folder/sub/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/other/note.md");
  });

  it("resolves leading / as vault root", () => {
    const links = parseLinks("[link](/root-note.md)", "deep/nested/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("root-note.md");
  });

  it("handles paths with no directory component", () => {
    const links = parseLinks("[link](sibling.md)", "folder/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/sibling.md");
  });

  it("handles file at vault root", () => {
    const links = parseLinks("[link](other.md)", "current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("other.md");
  });

  it("extracts link with #heading anchor", () => {
    const links = parseLinks("[text](note.md#heading)", "folder/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/note.md");
    expect(links[0]?.type).toBe("markdown");
  });

  it("extracts link with ?query parameter", () => {
    const links = parseLinks("[text](note.md?param=1)", "folder/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/note.md");
  });

  it("extracts link with both #anchor and relative path", () => {
    const links = parseLinks("[text](../sibling/note.md#section)", "folder/sub/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/sibling/note.md");
  });

  it("does not match links to non-md files", () => {
    const links = parseLinks("[img](photo.png) [doc](file.pdf)", "test.md");
    expect(links).toHaveLength(0);
  });

  it("extracts both wikilinks and markdown links from same content", () => {
    const content = "[[WikiTarget]] and [text](markdown-target.md)";
    const links = parseLinks(content, "test.md");
    expect(links).toHaveLength(2);
    expect(links[0]?.type).toBe("wikilink");
    expect(links[1]?.type).toBe("markdown");
  });
});

// ---------------------------------------------------------------------------
// resolveRelativePath — tested through parseLinks with markdown links
// ---------------------------------------------------------------------------
describe("resolveRelativePath — via parseLinks", () => {
  it("collapses ../ correctly", () => {
    const links = parseLinks("[x](../../root.md)", "a/b/c/file.md");
    expect(links[0]?.target).toBe("a/root.md");
  });

  it("handles multiple ../ segments", () => {
    const links = parseLinks("[x](../../../top.md)", "a/b/c/file.md");
    expect(links[0]?.target).toBe("top.md");
  });

  it("handles leading /", () => {
    const links = parseLinks("[x](/absolute.md)", "any/path/file.md");
    expect(links[0]?.target).toBe("absolute.md");
  });

  it("resolves . segments by ignoring them", () => {
    const links = parseLinks("[x](./same-dir.md)", "folder/file.md");
    expect(links[0]?.target).toBe("folder/same-dir.md");
  });

  it("handles empty segments", () => {
    // Double slashes result in empty segments which should be skipped
    const links = parseLinks("[x](sub//note.md)", "folder/file.md");
    expect(links[0]?.target).toBe("folder/sub/note.md");
  });
});

// ---------------------------------------------------------------------------
// Mock ObsidianClient for VaultCache tests
// ---------------------------------------------------------------------------
function createMockClient(
  files: string[] = [],
  noteContents: Record<string, NoteJson> = {},
): ObsidianClient {
  return {
    listFilesInVault: vi.fn(async () => ({ files })),
    getFileContents: vi.fn(async (path: string) => {
      const note = noteContents[path];
      if (!note) {
        throw new Error(`File not found: ${path}`);
      }
      return note;
    }),
  } as unknown as ObsidianClient;
}

function makeNoteJson(path: string, content: string, mtime = 1000): NoteJson {
  return {
    content,
    frontmatter: {},
    path,
    tags: [],
    stat: { ctime: 1000, mtime, size: content.length },
  };
}

// ---------------------------------------------------------------------------
// VaultCache — initialization
// ---------------------------------------------------------------------------
describe("VaultCache — initialize", () => {
  it("fetches all .md files and builds cache", async () => {
    const client = createMockClient(
      ["note1.md", "note2.md", "image.png"],
      {
        "note1.md": makeNoteJson("note1.md", "Content of note1 [[note2]]"),
        "note2.md": makeNoteJson("note2.md", "Content of note2"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    expect(cache.noteCount).toBe(2);
    expect(cache.getIsInitialized()).toBe(true);
  });

  it("skips non-md files", async () => {
    const client = createMockClient(
      ["note.md", "image.png", "data.json"],
      {
        "note.md": makeNoteJson("note.md", "hello"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
  });

  it("handles individual file fetch failures gracefully", async () => {
    const client = createMockClient(
      ["good.md", "bad.md"],
      {
        "good.md": makeNoteJson("good.md", "good content"),
        // "bad.md" is not in noteContents, so getFileContents will throw
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1); // only good.md
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getNote
// ---------------------------------------------------------------------------
describe("VaultCache — getNote", () => {
  it("returns cached note by exact path", async () => {
    const client = createMockClient(
      ["folder/note.md"],
      { "folder/note.md": makeNoteJson("folder/note.md", "hello") },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const note = cache.getNote("folder/note.md");
    expect(note).toBeDefined();
    expect(note?.path).toBe("folder/note.md");
    expect(note?.content).toBe("hello");
  });

  it("returns undefined for non-existent path", async () => {
    const client = createMockClient(["note.md"], {
      "note.md": makeNoteJson("note.md", "content"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getNote("nonexistent.md")).toBeUndefined();
  });

  it("falls back to filename-based lookup", async () => {
    const client = createMockClient(
      ["deep/folder/MyNote.md"],
      { "deep/folder/MyNote.md": makeNoteJson("deep/folder/MyNote.md", "content") },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // Lookup by just filename (case-insensitive)
    const note = cache.getNote("mynote");
    expect(note?.path).toBe("deep/folder/MyNote.md");
  });

  it("finds note by case-insensitive full path", async () => {
    const client = createMockClient(
      ["Folder/MyNote.md"],
      { "Folder/MyNote.md": makeNoteJson("Folder/MyNote.md", "content") },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const note = cache.getNote("folder/mynote.md");
    expect(note?.path).toBe("Folder/MyNote.md");
  });

  it("finds note by filename with .md extension appended", async () => {
    const client = createMockClient(
      ["folder/note.md"],
      { "folder/note.md": makeNoteJson("folder/note.md", "content") },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // Lookup by "note" should match "note.md"
    const note = cache.getNote("note");
    expect(note?.path).toBe("folder/note.md");
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getAllNotes / getFileList
// ---------------------------------------------------------------------------
describe("VaultCache — accessors", () => {
  it("getAllNotes returns all cached notes", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "aa"),
        "b.md": makeNoteJson("b.md", "bb"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getAllNotes()).toHaveLength(2);
  });

  it("getFileList returns all cached paths", async () => {
    const client = createMockClient(
      ["x.md", "y.md"],
      {
        "x.md": makeNoteJson("x.md", ""),
        "y.md": makeNoteJson("y.md", ""),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getFileList()).toEqual(expect.arrayContaining(["x.md", "y.md"]));
  });

  it("linkCount returns total number of links", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "[[b]] [[c]]"),
        "b.md": makeNoteJson("b.md", "[[a]]"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.linkCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — invalidate / invalidateAll
// ---------------------------------------------------------------------------
describe("VaultCache — invalidate", () => {
  it("removes a single note from cache", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "aa"),
        "b.md": makeNoteJson("b.md", "bb"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(2);

    cache.invalidate("a.md");
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("a.md")).toBeUndefined();
    expect(cache.getNote("b.md")).toBeDefined();
  });

  it("updates shortNameIndex after invalidation", async () => {
    const client = createMockClient(
      ["folder/note.md"],
      { "folder/note.md": makeNoteJson("folder/note.md", "content") },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // Before invalidation, should find by name
    expect(cache.getNote("note")).toBeDefined();

    cache.invalidate("folder/note.md");

    // After invalidation, should no longer find by full path or short name
    expect(cache.getNote("folder/note.md")).toBeUndefined();
    expect(cache.getNote("note")).toBeUndefined();
  });
});

describe("VaultCache — invalidateAll", () => {
  it("clears the entire cache", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "aa"),
        "b.md": makeNoteJson("b.md", "bb"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(2);
    expect(cache.getIsInitialized()).toBe(true);

    cache.invalidateAll();
    expect(cache.noteCount).toBe(0);
    expect(cache.getIsInitialized()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getBacklinks
// ---------------------------------------------------------------------------
describe("VaultCache — getBacklinks", () => {
  it("returns all notes linking to a given file", async () => {
    const client = createMockClient(
      ["a.md", "b.md", "c.md"],
      {
        "a.md": makeNoteJson("a.md", "Link to [[b]]"),
        "b.md": makeNoteJson("b.md", "No links here"),
        "c.md": makeNoteJson("c.md", "Also links to [[b]]"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("b.md");
    expect(backlinks).toHaveLength(2);
    const sources = backlinks.map((bl) => bl.source);
    expect(sources).toContain("a.md");
    expect(sources).toContain("c.md");
  });

  it("returns empty array when no backlinks exist", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "No links"),
        "b.md": makeNoteJson("b.md", "Also no links"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getBacklinks("b.md")).toHaveLength(0);
  });

  it("resolves wikilinks from subdirectories via short-name index", async () => {
    // Note in subfolder linking to another note in subfolder via wikilink
    const client = createMockClient(
      ["folder/a.md", "folder/b.md"],
      {
        "folder/a.md": makeNoteJson("folder/a.md", "Link to [[b]]"),
        "folder/b.md": makeNoteJson("folder/b.md", "Target note"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // [[b]] should resolve to folder/b.md via the short-name index
    const backlinks = cache.getBacklinks("folder/b.md");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.source).toBe("folder/a.md");
  });

  it("finds backlinks even for notes not in cache (unresolved targets)", async () => {
    // When a note links to [[nonexistent]], the link target stays unresolved as "nonexistent.md".
    // getBacklinks for that unresolved target should still find the linking note.
    const client = createMockClient(
      ["a.md"],
      {
        "a.md": makeNoteJson("a.md", "Link to [[nonexistent]]"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("nonexistent.md");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.source).toBe("a.md");
  });

  it("includes context from the linking note", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "Important context [[b]] surrounding link"),
        "b.md": makeNoteJson("b.md", "target"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("b.md");
    expect(backlinks[0]?.context).toContain("[[b]]");
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getForwardLinks
// ---------------------------------------------------------------------------
describe("VaultCache — getForwardLinks", () => {
  it("returns outbound links from a note", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "Links to [[b]] and [[c]]"),
        "b.md": makeNoteJson("b.md", "no links"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const forward = cache.getForwardLinks("a.md");
    expect(forward).toHaveLength(2);
    expect(forward.map((l) => l.target)).toEqual(["b.md", "c.md"]);
  });

  it("returns empty array for note with no links", async () => {
    const client = createMockClient(
      ["a.md"],
      { "a.md": makeNoteJson("a.md", "no links here") },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getForwardLinks("a.md")).toHaveLength(0);
  });

  it("returns empty array for non-existent note", async () => {
    const cache = new VaultCache(createMockClient(), 600000);
    expect(cache.getForwardLinks("missing.md")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getOrphanNotes
// ---------------------------------------------------------------------------
describe("VaultCache — getOrphanNotes", () => {
  it("returns notes with zero inbound links", async () => {
    const client = createMockClient(
      ["a.md", "b.md", "orphan.md"],
      {
        "a.md": makeNoteJson("a.md", "[[b]]"),
        "b.md": makeNoteJson("b.md", "[[a]]"),
        "orphan.md": makeNoteJson("orphan.md", "nobody links to me"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const orphans = cache.getOrphanNotes();
    expect(orphans).toContain("orphan.md");
    expect(orphans).not.toContain("a.md");
    expect(orphans).not.toContain("b.md");
  });

  it("returns all notes when none have inbound links", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "no links"),
        "b.md": makeNoteJson("b.md", "no links either"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getOrphanNotes()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getMostConnectedNotes
// ---------------------------------------------------------------------------
describe("VaultCache — getMostConnectedNotes", () => {
  it("returns notes sorted by total connections (inbound + outbound)", async () => {
    const client = createMockClient(
      ["hub.md", "a.md", "b.md", "c.md"],
      {
        "hub.md": makeNoteJson("hub.md", "[[a]] [[b]] [[c]]"),
        "a.md": makeNoteJson("a.md", "[[hub]]"),
        "b.md": makeNoteJson("b.md", "[[hub]]"),
        "c.md": makeNoteJson("c.md", "no outbound"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const connected = cache.getMostConnectedNotes(10);
    // hub.md has 3 outbound + 2 inbound = 5 total
    expect(connected[0]?.path).toBe("hub.md");
  });

  it("respects the limit parameter", async () => {
    const client = createMockClient(
      ["a.md", "b.md", "c.md"],
      {
        "a.md": makeNoteJson("a.md", "[[b]] [[c]]"),
        "b.md": makeNoteJson("b.md", "[[a]]"),
        "c.md": makeNoteJson("c.md", ""),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const result = cache.getMostConnectedNotes(1);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getVaultGraph
// ---------------------------------------------------------------------------
describe("VaultCache — getVaultGraph", () => {
  it("returns consistent nodes and edges", async () => {
    const client = createMockClient(
      ["a.md", "b.md"],
      {
        "a.md": makeNoteJson("a.md", "[[b]]"),
        "b.md": makeNoteJson("b.md", "[[a]]"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const graph = cache.getVaultGraph();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes).toContain("a.md");
    expect(graph.nodes).toContain("b.md");
    expect(graph.edges).toHaveLength(2);

    const edgePairs = graph.edges.map((e) => `${e.source}->${e.target}`);
    expect(edgePairs).toContain("a.md->b.md");
    expect(edgePairs).toContain("b.md->a.md");
  });

  it("returns empty graph for empty cache", () => {
    const cache = new VaultCache(createMockClient(), 600000);
    const graph = cache.getVaultGraph();
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — startAutoRefresh / stopAutoRefresh
// ---------------------------------------------------------------------------
describe("VaultCache — autoRefresh", () => {
  it("starts and stops auto refresh timer", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "content"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    cache.startAutoRefresh();
    // Calling start again should be a no-op
    cache.startAutoRefresh();

    cache.stopAutoRefresh();
    // Calling stop again should be safe
    cache.stopAutoRefresh();

    // Cache should still be valid after start/stop cycle
    expect(cache.getIsInitialized()).toBe(true);
  });

  it("enforces minimum TTL of 10 seconds", () => {
    // We verify that setInterval is called with at least 10000ms
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const client = createMockClient([], {});
    const cache = new VaultCache(client, 100); // TTL too low

    cache.startAutoRefresh();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10000);

    cache.stopAutoRefresh();
    setIntervalSpy.mockRestore();
  });

  it("calls unref on the timer", () => {
    const mockUnref = vi.fn();
    const mockTimer = { unref: mockUnref } as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(mockTimer);

    const client = createMockClient([], {});
    const cache = new VaultCache(client, 600000);
    cache.startAutoRefresh();

    // The timer.unref() call is made in the source
    // But setInterval returns our mockTimer, so unref won't be called
    // because the code calls this.refreshTimer.unref() which is our mockUnref
    expect(mockUnref).toHaveBeenCalled();

    cache.stopAutoRefresh();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// VaultCache — refresh
// ---------------------------------------------------------------------------
describe("VaultCache — refresh", () => {
  it("calls initialize when not initialized", async () => {
    const client = createMockClient(
      ["a.md"],
      { "a.md": makeNoteJson("a.md", "hello") },
    );

    const cache = new VaultCache(client, 600000);
    expect(cache.getIsInitialized()).toBe(false);

    await cache.refresh();
    expect(cache.getIsInitialized()).toBe(true);
    expect(cache.noteCount).toBe(1);
  });

  it("removes deleted notes from cache", async () => {
    const notes: Record<string, NoteJson> = {
      "a.md": makeNoteJson("a.md", "aa"),
      "b.md": makeNoteJson("b.md", "bb"),
    };

    const fileList = ["a.md", "b.md"];
    const client = {
      listFilesInVault: vi.fn(async () => ({ files: [...fileList] })),
      getFileContents: vi.fn(async (path: string) => {
        const note = notes[path];
        if (!note) throw new Error("not found");
        return note;
      }),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(2);

    // Remove b.md from file list and refresh
    fileList.length = 0;
    fileList.push("a.md");
    delete notes["b.md"];

    await cache.refresh();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("b.md")).toBeUndefined();
  });

  it("updates notes with changed mtime", async () => {
    let noteContent = "original";
    let noteMtime = 1000;

    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["a.md"] })),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", noteContent, noteMtime)),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getNote("a.md")?.content).toBe("original");

    // Change content and mtime
    noteContent = "updated";
    noteMtime = 2000;

    await cache.refresh();
    expect(cache.getNote("a.md")?.content).toBe("updated");
  });

  it("does not update notes with unchanged mtime", async () => {
    const fetchCount = { value: 0 };

    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["a.md"] })),
      getFileContents: vi.fn(async () => {
        fetchCount.value++;
        return makeNoteJson("a.md", "content", 1000);
      }),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    const before = cache.getNote("a.md");

    await cache.refresh();
    // getFileContents is called again to check mtime, but cache entry should be unchanged
    expect(cache.getNote("a.md")).toBe(before);
    expect(cache.getNote("a.md")?.content).toBe("content");
    expect(fetchCount.value).toBe(2); // fetched during init and refresh
  });

  it("handles refresh failure gracefully", async () => {
    const client = {
      listFilesInVault: vi.fn()
        .mockResolvedValueOnce({ files: ["a.md"] })
        .mockRejectedValueOnce(new Error("network error")),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", "content")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);

    // Refresh should not throw, just log a warning
    await cache.refresh();
    // Cache should still have old data
    expect(cache.noteCount).toBe(1);
  });
});
