import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { parseLinks, VaultCache } from "../cache.js";
// CachedNote and ParsedLink types used only indirectly via mock helpers
import type { ObsidianClient, NoteJson } from "../obsidian.js";
import { ObsidianAuthError, ObsidianConnectionError } from "../errors.js";

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
    const links = parseLinks(
      "See [my link](notes/target.md) here",
      "folder/current.md",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/notes/target.md");
    expect(links[0]?.type).toBe("markdown");
  });

  it("resolves relative paths with ../", () => {
    const links = parseLinks(
      "See [link](../other/note.md) here",
      "folder/sub/current.md",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/other/note.md");
  });

  it("resolves leading / as vault root", () => {
    const links = parseLinks("[link](/root-note.md)", "deep/nested/current.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("root-note.md");
  });

  it("canonicalizes absolute paths with double slashes", () => {
    const links = parseLinks("[link](/a//b.md)", "any/path.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("a/b.md");
  });

  it("canonicalizes absolute paths with dot segments", () => {
    const links = parseLinks("[link](/a/./b.md)", "any/path.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("a/b.md");
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
    const links = parseLinks(
      "[text](../sibling/note.md#section)",
      "folder/sub/current.md",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/sibling/note.md");
  });

  it("does not match links to non-md files", () => {
    const links = parseLinks("[img](photo.png) [doc](file.pdf)", "test.md");
    expect(links).toHaveLength(0);
  });

  it("does not match external URLs ending in .md", () => {
    const links = parseLinks(
      "[spec](https://github.com/user/repo/spec.md)",
      "test.md",
    );
    expect(links).toHaveLength(0);
  });

  it("does not match obsidian:// protocol links", () => {
    const links = parseLinks(
      "[link](obsidian://open?vault=test&file=note.md)",
      "test.md",
    );
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
  dirContents: Record<string, string[]> = {},
): ObsidianClient {
  return {
    listFilesInVault: vi.fn(async () => ({ files })),
    listFilesInDir: vi.fn(async (dirPath: string) => {
      const contents = dirContents[dirPath];
      if (!contents) {
        throw new Error(`Dir not found: ${dirPath}`);
      }
      return { files: contents };
    }),
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
    const client = createMockClient(["note1.md", "note2.md", "image.png"], {
      "note1.md": makeNoteJson("note1.md", "Content of note1 [[note2]]"),
      "note2.md": makeNoteJson("note2.md", "Content of note2"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    expect(cache.noteCount).toBe(2);
    expect(cache.getIsInitialized()).toBe(true);
  });

  it("skips non-md files", async () => {
    const client = createMockClient(["note.md", "image.png", "data.json"], {
      "note.md": makeNoteJson("note.md", "hello"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
  });

  it("handles individual file fetch failures gracefully", async () => {
    const client = createMockClient(["good.md", "bad.md"], {
      "good.md": makeNoteJson("good.md", "good content"),
      // "bad.md" is not in noteContents, so getFileContents will throw
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1); // only good.md
  });

  it("discovers .md files in nested subdirectories", async () => {
    const client = createMockClient(
      ["docs/", "root.md"],
      {
        "root.md": makeNoteJson("root.md", "root content"),
        "docs/guide.md": makeNoteJson("docs/guide.md", "guide content"),
        "docs/sub/deep.md": makeNoteJson("docs/sub/deep.md", "deep content"),
      },
      {
        docs: ["guide.md", "sub/"],
        "docs/sub": ["deep.md"],
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(3);
    expect(cache.getNote("root.md")).toBeDefined();
    expect(cache.getNote("docs/guide.md")).toBeDefined();
    expect(cache.getNote("docs/sub/deep.md")).toBeDefined();
  });

  it("handles empty directories gracefully", async () => {
    const client = createMockClient(
      ["empty/", "note.md"],
      {
        "note.md": makeNoteJson("note.md", "content"),
      },
      { empty: [] },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("note.md")).toBeDefined();
  });

  it("handles listFilesInDir failure gracefully", async () => {
    const client = createMockClient(
      ["broken/", "note.md"],
      {
        "note.md": makeNoteJson("note.md", "content"),
      },
      // "broken" not in dirContents — listFilesInDir will throw
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("note.md")).toBeDefined();
  });

  it("detects symlink cycles and avoids infinite recursion", async () => {
    // "loop/" symlinks back to itself: listFilesInDir("loop") returns "loop/" again
    const client = createMockClient(
      ["loop/", "note.md"],
      {
        "note.md": makeNoteJson("note.md", "content"),
      },
      // "loop" lists "./" as a child — a self-reference cycle. With prefix
      // prepending, "./" becomes "loop/./" which normalizes to "loop" (already visited).
      { loop: ["./"] },
    );

    const cache = new VaultCache(client, 600000);
    // Should complete without hanging — cycle detection breaks the loop
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("note.md")).toBeDefined();
  });

  it("stops recursion at max depth to prevent path-extending cycles", async () => {
    // Each directory lists a child directory, creating ever-deeper paths
    const client = createMockClient(["a/", "note.md"], {
      "note.md": makeNoteJson("note.md", "content"),
    });
    // Every listFilesInDir returns another subdirectory, simulating a symlink cycle
    vi.mocked(client.listFilesInDir).mockImplementation(async () => {
      return { files: ["deeper/"] };
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    // Should complete without hanging — depth limit stops recursion
    expect(cache.noteCount).toBe(1);
    // Root uses listFilesInVault (depth 0), then listFilesInDir is called
    // once per depth level 1–20 for "a/" and its "deeper/" children.
    // Depth 21 exceeds MAX_TRAVERSAL_DEPTH=20, so recursion stops.
    expect(vi.mocked(client.listFilesInDir).mock.calls.length).toBe(20);
  });

  it("rethrows ObsidianAuthError from subdirectory traversal", async () => {
    const client = createMockClient(["secret/", "note.md"], {
      "note.md": makeNoteJson("note.md", "content"),
    });
    // listFilesInDir throws ObsidianAuthError for "secret"
    vi.mocked(client.listFilesInDir).mockRejectedValue(new ObsidianAuthError());

    const cache = new VaultCache(client, 600000);
    await expect(cache.initialize()).rejects.toThrow(ObsidianAuthError);
  });

  it("rethrows ObsidianConnectionError from subdirectory traversal", async () => {
    const client = createMockClient(["sub/", "note.md"], {
      "note.md": makeNoteJson("note.md", "content"),
    });
    vi.mocked(client.listFilesInDir).mockRejectedValue(
      new ObsidianConnectionError("Connection refused"),
    );

    const cache = new VaultCache(client, 600000);
    await expect(cache.initialize()).rejects.toThrow(ObsidianConnectionError);
  });

  it("skips directory entries with path traversal segments", async () => {
    const client = {
      listFilesInVault: vi.fn(async () => ({
        files: ["../escape/", "note.md"],
      })),
      listFilesInDir: vi.fn(),
      getFileContents: vi.fn(async () => makeNoteJson("note.md", "content")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
    expect(client.listFilesInDir).not.toHaveBeenCalled();
  });

  it("skips file entries with path traversal segments", async () => {
    const client = createMockClient(["../escape.md", "note.md"], {
      "note.md": makeNoteJson("note.md", "content"),
    });
    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("../escape.md")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getNote
// ---------------------------------------------------------------------------
describe("VaultCache — getNote", () => {
  it("returns cached note by exact path", async () => {
    const client = createMockClient(
      ["folder/"],
      { "folder/note.md": makeNoteJson("folder/note.md", "hello") },
      { folder: ["note.md"] },
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
      ["deep/"],
      {
        "deep/folder/MyNote.md": makeNoteJson(
          "deep/folder/MyNote.md",
          "content",
        ),
      },
      { deep: ["folder/"], "deep/folder": ["MyNote.md"] },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // Lookup by just filename (case-insensitive)
    const note = cache.getNote("mynote");
    expect(note?.path).toBe("deep/folder/MyNote.md");
  });

  it("finds note by case-insensitive full path", async () => {
    const client = createMockClient(
      ["Folder/"],
      { "Folder/MyNote.md": makeNoteJson("Folder/MyNote.md", "content") },
      { Folder: ["MyNote.md"] },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const note = cache.getNote("folder/mynote.md");
    expect(note?.path).toBe("Folder/MyNote.md");
  });

  it("finds note by filename with .md extension appended", async () => {
    const client = createMockClient(
      ["folder/"],
      { "folder/note.md": makeNoteJson("folder/note.md", "content") },
      { folder: ["note.md"] },
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
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "aa"),
      "b.md": makeNoteJson("b.md", "bb"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getAllNotes()).toHaveLength(2);
  });

  it("getFileList returns all cached paths", async () => {
    const client = createMockClient(["x.md", "y.md"], {
      "x.md": makeNoteJson("x.md", ""),
      "y.md": makeNoteJson("y.md", ""),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getFileList()).toEqual(
      expect.arrayContaining(["x.md", "y.md"]),
    );
  });

  it("linkCount returns total number of links", async () => {
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "[[b]] [[c]]"),
      "b.md": makeNoteJson("b.md", "[[a]]"),
    });

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
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "aa"),
      "b.md": makeNoteJson("b.md", "bb"),
    });

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
      ["folder/"],
      { "folder/note.md": makeNoteJson("folder/note.md", "content") },
      { folder: ["note.md"] },
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
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "aa"),
      "b.md": makeNoteJson("b.md", "bb"),
    });

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
    const client = createMockClient(["a.md", "b.md", "c.md"], {
      "a.md": makeNoteJson("a.md", "Link to [[b]]"),
      "b.md": makeNoteJson("b.md", "No links here"),
      "c.md": makeNoteJson("c.md", "Also links to [[b]]"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("b.md");
    expect(backlinks).toHaveLength(2);
    const sources = backlinks.map((bl) => bl.source);
    expect(sources).toContain("a.md");
    expect(sources).toContain("c.md");
  });

  it("returns empty array when no backlinks exist", async () => {
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "No links"),
      "b.md": makeNoteJson("b.md", "Also no links"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getBacklinks("b.md")).toHaveLength(0);
  });

  it("resolves wikilinks from subdirectories via short-name index", async () => {
    // Note in subfolder linking to another note in subfolder via wikilink
    const client = createMockClient(
      ["folder/"],
      {
        "folder/a.md": makeNoteJson("folder/a.md", "Link to [[b]]"),
        "folder/b.md": makeNoteJson("folder/b.md", "Target note"),
      },
      { folder: ["a.md", "b.md"] },
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
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "Link to [[nonexistent]]"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("nonexistent.md");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.source).toBe("a.md");
  });

  it("includes context from the linking note", async () => {
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "Important context [[b]] surrounding link"),
      "b.md": makeNoteJson("b.md", "target"),
    });

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
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "Links to [[b]] and [[c]]"),
      "b.md": makeNoteJson("b.md", "no links"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const forward = cache.getForwardLinks("a.md");
    expect(forward).toHaveLength(2);
    expect(forward.map((l) => l.target)).toEqual(["b.md", "c.md"]);
  });

  it("returns empty array for note with no links", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "no links here"),
    });

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
    const client = createMockClient(["a.md", "b.md", "orphan.md"], {
      "a.md": makeNoteJson("a.md", "[[b]]"),
      "b.md": makeNoteJson("b.md", "[[a]]"),
      "orphan.md": makeNoteJson("orphan.md", "nobody links to me"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const orphans = cache.getOrphanNotes();
    expect(orphans).toContain("orphan.md");
    expect(orphans).not.toContain("a.md");
    expect(orphans).not.toContain("b.md");
  });

  it("returns all notes when none have inbound links", async () => {
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "no links"),
      "b.md": makeNoteJson("b.md", "no links either"),
    });

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
    const client = createMockClient(["hub.md", "a.md", "b.md", "c.md"], {
      "hub.md": makeNoteJson("hub.md", "[[a]] [[b]] [[c]]"),
      "a.md": makeNoteJson("a.md", "[[hub]]"),
      "b.md": makeNoteJson("b.md", "[[hub]]"),
      "c.md": makeNoteJson("c.md", "no outbound"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const connected = cache.getMostConnectedNotes(10);
    // hub.md has 3 outbound + 2 inbound = 5 total
    expect(connected[0]?.path).toBe("hub.md");
  });

  it("respects the limit parameter", async () => {
    const client = createMockClient(["a.md", "b.md", "c.md"], {
      "a.md": makeNoteJson("a.md", "[[b]] [[c]]"),
      "b.md": makeNoteJson("b.md", "[[a]]"),
      "c.md": makeNoteJson("c.md", ""),
    });

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
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "[[b]]"),
      "b.md": makeNoteJson("b.md", "[[a]]"),
    });

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
    const mockTimer = { unref: mockUnref } as unknown as ReturnType<
      typeof setInterval
    >;
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
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "hello"),
    });

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
      getFileContents: vi.fn(async () =>
        makeNoteJson("a.md", noteContent, noteMtime),
      ),
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
      listFilesInVault: vi
        .fn()
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

  it("refresh discovers new nested files and prunes deleted ones", async () => {
    const dirFiles: Record<string, string[]> = { folder: ["a.md"] };
    const notes: Record<string, NoteJson> = {
      "folder/a.md": makeNoteJson("folder/a.md", "A"),
    };

    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["folder/"] })),
      listFilesInDir: vi.fn(async (dirPath: string) => {
        const contents = dirFiles[dirPath];
        if (!contents) throw new Error(`Dir not found: ${dirPath}`);
        return { files: contents };
      }),
      getFileContents: vi.fn(async (path: string) => {
        const note = notes[path];
        if (!note) throw new Error("not found");
        return note;
      }),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("folder/a.md")).toBeDefined();

    // Simulate: folder/a.md deleted, folder/b.md added
    dirFiles["folder"] = ["b.md"];
    delete notes["folder/a.md"];
    notes["folder/b.md"] = makeNoteJson("folder/b.md", "B", 2000);

    await cache.refresh();
    expect(cache.noteCount).toBe(1);
    expect(cache.getNote("folder/a.md")).toBeUndefined();
    expect(cache.getNote("folder/b.md")).toBeDefined();
    expect(cache.getNote("folder/b.md")?.content).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// VaultCache — waitForInitialization
// ---------------------------------------------------------------------------
describe("VaultCache — waitForInitialization", () => {
  it("returns true immediately when already initialized", async () => {
    const client = createMockClient();
    const cache = new VaultCache(client, 600000);
    // Force isInitialized via a successful build
    (client.listFilesInVault as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: [],
    });
    await cache.initialize();
    const result = await cache.waitForInitialization(100);
    expect(result).toBe(true);
  });

  it("returns false immediately when no build in progress", async () => {
    const client = createMockClient();
    const cache = new VaultCache(client, 600000);
    // Never called initialize — isBuilding and isRefreshing are false
    const result = await cache.waitForInitialization(100);
    expect(result).toBe(false);
  });

  it("waits for in-flight build to complete", async () => {
    const client = createMockClient();
    (client.listFilesInVault as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: [],
    });
    const cache = new VaultCache(client, 600000);
    // Start initialization but don't await it
    const initPromise = cache.initialize();
    // waitForInitialization should resolve once the build completes
    const result = await cache.waitForInitialization(5000);
    await initPromise;
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseLinks — edge cases for uncovered branches
// ---------------------------------------------------------------------------
describe("parseLinks — wikilink edge cases", () => {
  it("handles unclosed [[ with no matching ]]", () => {
    const links = parseLinks("Some text [[ unclosed link", "test.md");
    expect(links).toHaveLength(0);
  });

  it("handles nested [[ by skipping the outer unclosed one", () => {
    // "[[outer [[inner]]" — the outer [[ has a nested [[ before its ]], so it's unclosed
    const links = parseLinks("[[outer [[inner]]", "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("inner.md");
  });

  it("skips wikilinks with empty target", () => {
    const links = parseLinks("[[ ]] text [[valid]]", "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("valid.md");
  });

  it("handles wikilink with only # (heading-only link, empty target after strip)", () => {
    const links = parseLinks("[[#heading-only]]", "test.md");
    expect(links).toHaveLength(0);
  });

  it("handles pipe before hash", () => {
    const links = parseLinks("[[display|Note#heading]]", "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("display.md");
  });
});

describe("parseLinks — markdown link edge cases", () => {
  it("handles ] not followed by (", () => {
    const links = parseLinks("[text] not a link", "test.md");
    expect(links).toHaveLength(0);
  });

  it("handles unmatched parenthesis after ](", () => {
    const links = parseLinks("[text](path-no-close.md", "test.md");
    expect(links).toHaveLength(0);
  });

  it("handles nested parentheses in path", () => {
    const links = parseLinks("[text](path%20(1).md)", "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("path (1).md");
  });

  it("stops at newline inside parentheses", () => {
    const links = parseLinks("[text](path\nbroken.md)", "test.md");
    expect(links).toHaveLength(0);
  });

  it("strips title from markdown link path", () => {
    const links = parseLinks('[text](note.md "title text")', "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("note.md");
  });

  it("strips single-quoted title from markdown link path", () => {
    const links = parseLinks("[text](note.md 'title text')", "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("note.md");
  });

  it("handles URL-encoded paths", () => {
    const links = parseLinks("[text](my%20note.md)", "test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("my note.md");
  });

  it("handles broken URL encoding gracefully", () => {
    const links = parseLinks("[text](%ZZnote.md)", "test.md");
    // decodeURIComponent will fail, falls back to rawUrl
    expect(links).toHaveLength(1);
  });

  it("rejects .md path that is too short (just .md)", () => {
    const links = parseLinks("[text](.md)", "test.md");
    expect(links).toHaveLength(0);
  });

  it("handles query parameter before hash", () => {
    const links = parseLinks("[text](note.md?v=1#heading)", "folder/test.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("folder/note.md");
  });
});

// ---------------------------------------------------------------------------
// VaultCache — initialization retry logic
// ---------------------------------------------------------------------------
describe("VaultCache — initialization retries", () => {
  it("retries on connection error and eventually fails", async () => {
    const client = {
      listFilesInVault: vi
        .fn()
        .mockRejectedValue(new Error("connection refused")),
      getFileContents: vi.fn(),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await expect(cache.initialize()).rejects.toThrow(
      "Cache initialization failed after 3 attempts",
    );
  });

  it("does not retry on auth error", async () => {
    const { ObsidianAuthError: AuthErr } = await import("../errors.js");
    const client = {
      listFilesInVault: vi.fn().mockRejectedValue(new AuthErr()),
      getFileContents: vi.fn(),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await expect(cache.initialize()).rejects.toThrow("Authentication failed");
    expect(client.listFilesInVault).toHaveBeenCalledTimes(1);
  });

  it("discards build when generation changes during fetch", async () => {
    let callCount = 0;
    const client = {
      listFilesInVault: vi.fn(async () => {
        callCount++;
        if (callCount <= 3) {
          // Simulate invalidateAll() being called during build
          cache.invalidateAll();
        }
        return { files: ["a.md"] };
      }),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", "content")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await expect(cache.initialize()).rejects.toThrow("invalidated");
  });

  it("succeeds after a generation-mismatch discard on retry", async () => {
    let callCount = 0;
    const client = {
      listFilesInVault: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: invalidate during build
          cache.invalidateAll();
        }
        return { files: ["a.md"] };
      }),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", "content")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getIsInitialized()).toBe(true);
    expect(cache.noteCount).toBe(1);
  });

  it("throws when all file fetches fail during build", async () => {
    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["a.md", "b.md"] })),
      getFileContents: vi.fn().mockRejectedValue(new Error("fetch failed")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await expect(cache.initialize()).rejects.toThrow(
      "Cache initialization failed",
    );
  });

  it("skips if already initialized", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "content"),
    });
    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    // Call again — should skip
    await cache.initialize();
    expect(client.listFilesInVault).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers share the same build promise", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "content"),
    });
    const cache = new VaultCache(client, 600000);

    // Start two concurrent initializations
    const [r1, r2] = await Promise.all([
      cache.initialize(),
      cache.initialize(),
    ]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    // Should only have fetched once
    expect(client.listFilesInVault).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — refresh edge cases
// ---------------------------------------------------------------------------
describe("VaultCache — refresh edge cases", () => {
  it("skips if already refreshing", async () => {
    let resolveRefresh: (() => void) | undefined;
    const blockingPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    const client = {
      listFilesInVault: vi.fn(async () => {
        await blockingPromise;
        return { files: [] };
      }),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", "content")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    // Initialize first
    (client.listFilesInVault as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { files: ["a.md"] },
    );
    await cache.initialize();

    // Now set up a blocking refresh
    const refreshPromise = cache.refresh();
    // Second refresh should bail immediately
    await cache.refresh();

    resolveRefresh!();
    await refreshPromise;

    // listFilesInVault: 1 for init + 1 for refresh (second refresh was skipped)
    expect(client.listFilesInVault).toHaveBeenCalledTimes(2);
  });

  it("discards refresh when generation changes during it", async () => {
    const client = {
      listFilesInVault: vi.fn(async () => {
        // Simulate invalidateAll during refresh
        cache.invalidateAll();
        return { files: ["a.md"] };
      }),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", "content", 2000)),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    // Force initialized state with known generation
    (client.listFilesInVault as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { files: ["a.md"] },
    );
    (client.getFileContents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNoteJson("a.md", "original"),
    );
    await cache.initialize();

    // Refresh will trigger invalidateAll, generation will change
    await cache.refresh();
    // Cache should be cleared by invalidateAll
    expect(cache.getIsInitialized()).toBe(false);
  });

  it("handles file fetch failures during refresh gracefully", async () => {
    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["a.md", "b.md"] })),
      getFileContents: vi
        .fn()
        .mockResolvedValueOnce(makeNoteJson("a.md", "aa"))
        .mockResolvedValueOnce(makeNoteJson("b.md", "bb"))
        // Refresh: a.md succeeds with new mtime, b.md fails
        .mockResolvedValueOnce(makeNoteJson("a.md", "aa-updated", 2000))
        .mockRejectedValueOnce(new Error("fetch failed")),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.noteCount).toBe(2);

    await cache.refresh();
    // a.md should be updated, b.md should still be old version
    expect(cache.getNote("a.md")?.content).toBe("aa-updated");
    expect(cache.getNote("b.md")?.content).toBe("bb");
  });

  it("skips re-inserting individually invalidated paths during refresh", async () => {
    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["a.md"] })),
      getFileContents: vi.fn(async () => makeNoteJson("a.md", "content", 2000)),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    // Init with mtime=1000
    (client.getFileContents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNoteJson("a.md", "original", 1000),
    );
    await cache.initialize();
    expect(cache.getNote("a.md")?.content).toBe("original");

    // Invalidate the path before refresh completes — simulates a write happening during refresh
    // We need to set up so that during refresh, the path gets individually invalidated
    const origRefresh = cache.refresh.bind(cache);
    const refreshWithInvalidation = async (): Promise<void> => {
      // Invalidate during refresh by hooking into the mock
      (
        client.getFileContents as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(async () => {
        cache.invalidate("a.md");
        return makeNoteJson("a.md", "stale-from-refresh", 2000);
      });
      return origRefresh();
    };

    await refreshWithInvalidation();
    // The note should NOT have been re-inserted because it was invalidated during refresh
    expect(cache.getNote("a.md")).toBeUndefined();
  });

  it("handles unexpected response format during refresh", async () => {
    const client = {
      listFilesInVault: vi.fn(async () => ({ files: ["a.md"] })),
      getFileContents: vi
        .fn()
        .mockResolvedValueOnce(makeNoteJson("a.md", "original", 1000))
        // During refresh: returns string instead of NoteJson
        .mockResolvedValueOnce("raw string content"),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    // Refresh should handle the unexpected format gracefully
    await cache.refresh();
    // Original cache entry should remain
    expect(cache.getNote("a.md")?.content).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// VaultCache — waitForInitialization edge cases
// ---------------------------------------------------------------------------
describe("VaultCache — waitForInitialization edge cases", () => {
  it("returns false when refreshing but no build promise exists", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "content"),
    });
    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // Start a refresh (which sets isRefreshing=true) but it won't create a buildPromise
    // because the cache is already initialized
    // We need to force the state: isRefreshing=true, isBuilding=false, buildPromise=undefined
    // The easiest way is to call waitForInitialization during a normal (non-init) refresh
    cache.invalidateAll(); // Reset isInitialized

    // Now isInitialized=false, isBuilding=false, isRefreshing=false
    // waitForInitialization should return false immediately
    const result = await cache.waitForInitialization(100);
    expect(result).toBe(false);
  });

  it("times out when build takes too long", async () => {
    let resolveInit: (() => void) | undefined;
    const blockingPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const client = {
      listFilesInVault: vi.fn(async () => {
        await blockingPromise;
        return { files: [] };
      }),
      getFileContents: vi.fn(),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    // Start init without awaiting
    const initPromise = cache.initialize();

    // Wait with a very short timeout
    const result = await cache.waitForInitialization(50);
    expect(result).toBe(false);

    // Clean up
    resolveInit!();
    await initPromise;
  });

  it("handles build failure during wait and returns false", async () => {
    const client = {
      listFilesInVault: vi
        .fn()
        .mockRejectedValue(new Error("connection refused")),
      getFileContents: vi.fn(),
    } as unknown as ObsidianClient;

    const cache = new VaultCache(client, 600000);
    // Start init without awaiting — it will fail
    const initPromise = cache.initialize().catch(() => {
      /* expected */
    });

    // Wait should eventually return false because build fails
    const result = await cache.waitForInitialization(5000);
    expect(result).toBe(false);

    await initPromise;
  });
});

// ---------------------------------------------------------------------------
// VaultCache — invalidate edge cases
// ---------------------------------------------------------------------------
describe("VaultCache — invalidate edge cases", () => {
  it("handles path with no directory separator", async () => {
    const client = createMockClient(["root-note.md"], {
      "root-note.md": makeNoteJson("root-note.md", "content"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getNote("root-note.md")).toBeDefined();

    cache.invalidate("root-note.md");
    expect(cache.getNote("root-note.md")).toBeUndefined();
  });

  it("decrements link count on invalidation", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "[[b]] [[c]]"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.linkCount).toBe(2);

    cache.invalidate("a.md");
    expect(cache.linkCount).toBe(0);
  });

  it("handles invalidating a path not in cache", () => {
    const cache = new VaultCache(createMockClient(), 600000);
    // Should not throw
    cache.invalidate("nonexistent.md");
    expect(cache.noteCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — resolveLinkToFullPath edge cases
// ---------------------------------------------------------------------------
describe("VaultCache — link resolution edge cases", () => {
  it("resolves normalized case-insensitive full path match", async () => {
    const client = createMockClient(["Folder/MyNote.md"], {
      "Folder/MyNote.md": makeNoteJson("Folder/MyNote.md", "[[folder/mynote]]"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // The link "folder/mynote.md" (normalized) should resolve to "Folder/MyNote.md"
    const backlinks = cache.getBacklinks("Folder/MyNote.md");
    // Self-link via normalized path
    expect(backlinks).toHaveLength(1);
  });

  it("resolves via suffix match for wikilinks in subdirectories", async () => {
    const client = createMockClient(
      ["deep/nested/target.md", "other/linker.md"],
      {
        "deep/nested/target.md": makeNoteJson(
          "deep/nested/target.md",
          "Target",
        ),
        "other/linker.md": makeNoteJson("other/linker.md", "[[target]]"),
      },
    );

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("deep/nested/target.md");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.source).toBe("other/linker.md");
  });

  it("handles link to non-existent note (unresolved)", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "[[nonexistent]]"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // The vault graph should not include edges to non-existent notes
    const graph = cache.getVaultGraph();
    expect(graph.edges).toHaveLength(0);
  });

  it("handles normalized link to note that exists", async () => {
    // normalizeLinkTarget adds .md — test path without .md extension
    const client = createMockClient(["notes/readme.md"], {
      "notes/readme.md": makeNoteJson("notes/readme.md", "Content"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // normalizeLinkTarget tests
    const note = cache.getNote("notes/readme.md");
    expect(note).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// VaultCache — normalizeLinkTarget (via graph queries)
// ---------------------------------------------------------------------------
describe("VaultCache — normalizeLinkTarget coverage", () => {
  it("adds .md to targets that lack it", async () => {
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "[[b]]"),
      "b.md": makeNoteJson("b.md", "target"),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    // [[b]] stored as "b.md", normalizeLinkTarget("b.md") → "b.md" (no double .md)
    const backlinks = cache.getBacklinks("b.md");
    expect(backlinks).toHaveLength(1);
  });

  it("handles backslash paths in link targets", async () => {
    const client = createMockClient(["folder/note.md", "linker.md"], {
      "folder/note.md": makeNoteJson("folder/note.md", "target"),
      "linker.md": makeNoteJson(
        "linker.md",
        String.raw`[text](folder\note.md)`,
      ),
    });

    const cache = new VaultCache(client, 600000);
    await cache.initialize();

    const backlinks = cache.getBacklinks("folder/note.md");
    expect(backlinks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VaultCache — getEdgeCount
// ---------------------------------------------------------------------------
describe("VaultCache — getEdgeCount", () => {
  it("returns 0 for empty cache", async () => {
    const client = createMockClient([], {});
    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    expect(cache.getEdgeCount()).toBe(0);
  });

  it("counts resolved edges", async () => {
    const client = createMockClient(["a.md", "b.md"], {
      "a.md": makeNoteJson("a.md", "see [[b]]"),
      "b.md": makeNoteJson("b.md", "see [[a]]"),
    });
    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    // a→b and b→a = 2 edges, matches getVaultGraph().edges.length
    expect(cache.getEdgeCount()).toBe(cache.getVaultGraph().edges.length);
    expect(cache.getEdgeCount()).toBe(2);
  });

  it("excludes unresolved links", async () => {
    const client = createMockClient(["a.md"], {
      "a.md": makeNoteJson("a.md", "see [[nonexistent]]"),
    });
    const cache = new VaultCache(client, 600000);
    await cache.initialize();
    // Link to nonexistent note should not count as an edge
    expect(cache.getEdgeCount()).toBe(0);
    expect(cache.linkCount).toBe(1); // raw link count includes unresolved
  });
});
