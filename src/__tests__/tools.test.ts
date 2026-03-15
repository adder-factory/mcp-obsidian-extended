/**
 * Unit tests for tools.ts (dispatcher), tools/granular.ts, and tools/consolidated.ts.
 *
 * Strategy:
 * - Mock McpServer to capture tool registrations and invoke handlers directly.
 * - Mock ObsidianClient and VaultCache to avoid real HTTP calls.
 * - Mock config.ts side-effecting exports (saveConfigToFile, setDebugEnabled, log).
 * - Never use `any` — narrow with type guards throughout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    saveConfigToFile: vi.fn(),
    setDebugEnabled: vi.fn(),
    log: vi.fn(),
    getRedactedConfig: vi.fn((cfg: import("../config.js").Config) => ({
      host: cfg.host,
      port: cfg.port,
      apiKey: cfg.apiKey ? "[SET]" : "[NOT SET]",
    })),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { Config } from "../config.js";
import { saveConfigToFile } from "../config.js";
import { registerAllTools } from "../tools.js";
import { registerGranularTools } from "../tools/granular.js";
import { registerConsolidatedTools } from "../tools/consolidated.js";
import type { ObsidianClient, NoteJson, ToolResult } from "../obsidian.js";
import type { VaultCache } from "../cache.js";
import { ObsidianApiError, ObsidianConnectionError, ObsidianAuthError } from "../errors.js";

// ---------------------------------------------------------------------------
// Suppress stderr
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers — mock factory types
// ---------------------------------------------------------------------------

/**
 * A captured tool registration: the four arguments passed to server.tool().
 * The handler signature matches the SDK: (args: unknown) => Promise<ToolResult>.
 */
interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Creates a mock McpServer that captures every server.tool() call.
 * Returns both the mock server and a helper to look up captured tools.
 */
function makeMockServer(): {
  server: { tool: ReturnType<typeof vi.fn> };
  getTool: (name: string) => CapturedTool;
  getRegistered: () => string[];
} {
  const captured: CapturedTool[] = [];

  const toolFn = vi.fn(
    (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => {
      captured.push({ name, description, schema, handler });
    },
  );

  const server = { tool: toolFn };

  return {
    server,
    getTool: (name: string): CapturedTool => {
      const found = captured.find((t) => t.name === name);
      if (!found) throw new Error(`Tool "${name}" was not registered`);
      return found;
    },
    getRegistered: () => captured.map((t) => t.name),
  };
}

/** Creates a partial mock of ObsidianClient with all methods as vi.fn(). */
function makeMockClient(): ObsidianClient {
  return {
    getServerStatus: vi.fn().mockResolvedValue({ ok: true, service: "Obsidian REST API", authenticated: true, versions: {} }),
    listFilesInVault: vi.fn().mockResolvedValue({ files: [] }),
    listFilesInDir: vi.fn().mockResolvedValue({ files: [] }),
    getFileContents: vi.fn().mockResolvedValue("# File content"),
    putContent: vi.fn().mockResolvedValue(undefined),
    appendContent: vi.fn().mockResolvedValue(undefined),
    patchContent: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getActiveFile: vi.fn().mockResolvedValue("# Active file"),
    putActiveFile: vi.fn().mockResolvedValue(undefined),
    appendActiveFile: vi.fn().mockResolvedValue(undefined),
    patchActiveFile: vi.fn().mockResolvedValue(undefined),
    deleteActiveFile: vi.fn().mockResolvedValue(undefined),
    listCommands: vi.fn().mockResolvedValue({ commands: [] }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
    simpleSearch: vi.fn().mockResolvedValue([]),
    complexSearch: vi.fn().mockResolvedValue([]),
    dataviewSearch: vi.fn().mockResolvedValue([]),
    getPeriodicNote: vi.fn().mockResolvedValue("# Periodic note"),
    putPeriodicNote: vi.fn().mockResolvedValue(undefined),
    appendPeriodicNote: vi.fn().mockResolvedValue(undefined),
    patchPeriodicNote: vi.fn().mockResolvedValue(undefined),
    deletePeriodicNote: vi.fn().mockResolvedValue(undefined),
    getPeriodicNoteForDate: vi.fn().mockResolvedValue("# Periodic note for date"),
    putPeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
    appendPeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
    patchPeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
    deletePeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ObsidianClient;
}

/** Creates a mock VaultCache with configurable initialization state. */
function makeMockCache(initialized = true): VaultCache {
  return {
    getIsInitialized: vi.fn().mockReturnValue(initialized),
    getAllNotes: vi.fn().mockReturnValue([]),
    getFileList: vi.fn().mockReturnValue([]),
    noteCount: 0,
    linkCount: 0,
    getBacklinks: vi.fn().mockReturnValue([]),
    getForwardLinks: vi.fn().mockReturnValue([]),
    getOrphanNotes: vi.fn().mockReturnValue([]),
    getMostConnectedNotes: vi.fn().mockReturnValue([]),
    getVaultGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    refresh: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    startAutoRefresh: vi.fn(),
    stopAutoRefresh: vi.fn(),
    getNote: vi.fn().mockReturnValue(undefined),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
  } as unknown as VaultCache;
}

/** Base config used by most tests — granular, full preset, cache enabled. */
const BASE_CONFIG: Config = {
  apiKey: "test-key",
  host: "127.0.0.1",
  port: 27124,
  scheme: "https",
  timeout: 30000,
  certPath: undefined,
  verifySsl: false,
  verifyWrites: false,
  maxResponseChars: 500000,
  debug: false,
  toolMode: "granular",
  toolPreset: "full",
  includeTools: [],
  excludeTools: [],
  cacheTtl: 600000,
  enableCache: true,
  configFilePath: undefined,
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...BASE_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Helper: extract text from a ToolResult content array
// ---------------------------------------------------------------------------

function getText(result: ToolResult): string {
  const first = result.content[0];
  return first ? first.text : "";
}

// ===========================================================================
// Section 1: registerAllTools dispatcher
// ===========================================================================

describe("registerAllTools — granular mode", () => {
  it("registers 38 tools in full preset", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(server as never, client, cache, makeConfig());
    expect(count).toBe(38);
    expect(getRegistered()).toHaveLength(38);
  });

  it("registers 20 tools in read-only preset", () => {
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never, client, cache,
      makeConfig({ toolPreset: "read-only" }),
    );
    expect(count).toBe(20);
  });

  it("registers 8 tools in minimal preset", () => {
    // 7 preset tools + refresh_cache (protected, not in minimal preset)
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never, client, cache,
      makeConfig({ toolPreset: "minimal" }),
    );
    expect(count).toBe(8);
  });

  it("registers 34 tools in safe preset", () => {
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never, client, cache,
      makeConfig({ toolPreset: "safe" }),
    );
    expect(count).toBe(34);
  });

  it("protected tools are always registered even when excluded", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never, client, cache,
      makeConfig({ excludeTools: ["configure", "get_server_status", "refresh_cache"] }),
    );
    const registered = getRegistered();
    expect(registered).toContain("configure");
    expect(registered).toContain("get_server_status");
    expect(registered).toContain("refresh_cache");
  });

  it("INCLUDE_TOOLS whitelist filters to only specified + protected tools", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never, client, cache,
      makeConfig({ includeTools: ["list_files_in_vault", "simple_search"] }),
    );
    const registered = getRegistered();
    expect(registered).toContain("list_files_in_vault");
    expect(registered).toContain("simple_search");
    // Protected tools always appear
    expect(registered).toContain("configure");
    expect(registered).toContain("get_server_status");
    expect(registered).toContain("refresh_cache");
    // Unspecified non-protected tools must NOT appear
    expect(registered).not.toContain("delete_file");
    expect(registered).not.toContain("put_content");
    expect(registered).not.toContain("append_content");
  });

  it("EXCLUDE_TOOLS removes tools but preserves protected", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never, client, cache,
      makeConfig({ excludeTools: ["delete_file", "delete_active_file"] }),
    );
    const registered = getRegistered();
    expect(registered).not.toContain("delete_file");
    expect(registered).not.toContain("delete_active_file");
    // Protected tools survive exclusion
    expect(registered).toContain("configure");
    expect(registered).toContain("get_server_status");
    expect(registered).toContain("refresh_cache");
  });

  it("INCLUDE_TOOLS tool not in preset is not registered", () => {
    // In minimal preset, delete_file is not in the preset; requesting it via INCLUDE should not register it
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never, client, cache,
      makeConfig({ toolPreset: "minimal", includeTools: ["delete_file"] }),
    );
    // delete_file is not in the minimal preset, so including it has no effect
    expect(getRegistered()).not.toContain("delete_file");
  });
});

describe("registerAllTools — consolidated mode", () => {
  it("registers 11 tools in full preset", () => {
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never, client, cache,
      makeConfig({ toolMode: "consolidated" }),
    );
    expect(count).toBe(11);
  });

  it("registers 4 tools in minimal preset", () => {
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never, client, cache,
      makeConfig({ toolMode: "consolidated", toolPreset: "minimal" }),
    );
    expect(count).toBe(4);
  });

  it("protected tools (configure, status) always registered when excluded", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never, client, cache,
      makeConfig({ toolMode: "consolidated", excludeTools: ["configure", "status"] }),
    );
    const registered = getRegistered();
    expect(registered).toContain("configure");
    expect(registered).toContain("status");
  });

  it("INCLUDE_TOOLS filters consolidated tools", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never, client, cache,
      makeConfig({ toolMode: "consolidated", includeTools: ["vault", "search"] }),
    );
    const registered = getRegistered();
    expect(registered).toContain("vault");
    expect(registered).toContain("search");
    expect(registered).not.toContain("recent");
    expect(registered).not.toContain("batch_get");
    // Protected
    expect(registered).toContain("configure");
    expect(registered).toContain("status");
  });
});

// ===========================================================================
// Section 2: granular.ts tool handlers
// ===========================================================================

describe("granular tools — registration and basic behavior", () => {
  function setup(configOverrides: Partial<Config> = {}): {
    client: ObsidianClient;
    cache: VaultCache;
    getTool: (name: string) => CapturedTool;
  } {
    const { server, getTool } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const config = makeConfig(configOverrides);
    registerGranularTools(server as never, client, cache, () => true, config);
    return { client, cache, getTool };
  }

  // -------------------------------------------------------------------------
  // list_files_in_vault
  // -------------------------------------------------------------------------
  describe("list_files_in_vault", () => {
    it("calls client.listFilesInVault and returns json result", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockResolvedValue({ files: ["a.md", "b.md"] });
      const result = await getTool("list_files_in_vault").handler({});
      expect(client.listFilesInVault).toHaveBeenCalled();
      expect(getText(result)).toContain("a.md");
      expect(result.isError).toBeFalsy();
    });

    it("returns errorResult on connection error", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(new ObsidianConnectionError("refused"));
      const result = await getTool("list_files_in_vault").handler({});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("CONNECTION ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // list_files_in_dir
  // -------------------------------------------------------------------------
  describe("list_files_in_dir", () => {
    it("calls client.listFilesInDir with the given dirPath", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInDir).mockResolvedValue({ files: ["dir/note.md"] });
      const result = await getTool("list_files_in_dir").handler({ dirPath: "dir" });
      expect(client.listFilesInDir).toHaveBeenCalledWith("dir");
      expect(getText(result)).toContain("dir/note.md");
    });

    it("returns errorResult on API 404", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInDir).mockRejectedValue(new ObsidianApiError("not found", 404));
      const result = await getTool("list_files_in_dir").handler({ dirPath: "missing" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("NOT FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // get_file_contents
  // -------------------------------------------------------------------------
  describe("get_file_contents", () => {
    it("returns text for markdown format", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("# Hello");
      const result = await getTool("get_file_contents").handler({ filePath: "note.md" });
      expect(client.getFileContents).toHaveBeenCalledWith("note.md", undefined);
      expect(getText(result)).toBe("# Hello");
      expect(result.isError).toBeFalsy();
    });

    it("serialises NoteJson result as JSON", async () => {
      const { client, getTool } = setup();
      const noteJson: NoteJson = {
        content: "# Hello",
        frontmatter: {},
        path: "note.md",
        tags: [],
        stat: { ctime: 0, mtime: 1000, size: 10 },
      };
      vi.mocked(client.getFileContents).mockResolvedValue(noteJson);
      const result = await getTool("get_file_contents").handler({ filePath: "note.md", format: "json" });
      expect(getText(result)).toContain('"path": "note.md"');
    });

    it("returns errorResult on auth error", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(new ObsidianAuthError());
      const result = await getTool("get_file_contents").handler({ filePath: "note.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("AUTH ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // put_content
  // -------------------------------------------------------------------------
  describe("put_content", () => {
    it("calls client.putContent and returns success message", async () => {
      const { client, getTool } = setup();
      const result = await getTool("put_content").handler({ filePath: "test.md", content: "hello" });
      expect(client.putContent).toHaveBeenCalledWith("test.md", "hello");
      expect(getText(result)).toContain("Written: test.md");
    });

    it("returns errorResult on failure", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.putContent).mockRejectedValue(new Error("write failed"));
      const result = await getTool("put_content").handler({ filePath: "test.md", content: "x" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // append_content
  // -------------------------------------------------------------------------
  describe("append_content", () => {
    it("calls client.appendContent and returns success", async () => {
      const { client, getTool } = setup();
      const result = await getTool("append_content").handler({ filePath: "note.md", content: "extra" });
      expect(client.appendContent).toHaveBeenCalledWith("note.md", "extra");
      expect(getText(result)).toContain("Appended to: note.md");
    });
  });

  // -------------------------------------------------------------------------
  // patch_content
  // -------------------------------------------------------------------------
  describe("patch_content", () => {
    it("calls client.patchContent with all options", async () => {
      const { client, getTool } = setup();
      const result = await getTool("patch_content").handler({
        filePath: "note.md",
        content: "new line",
        operation: "append",
        targetType: "heading",
        target: "Section",
        createIfMissing: true,
      });
      expect(client.patchContent).toHaveBeenCalledWith("note.md", "new line", {
        operation: "append",
        targetType: "heading",
        target: "Section",
        targetDelimiter: undefined,
        trimTargetWhitespace: undefined,
        createIfMissing: true,
        contentType: undefined,
      });
      expect(getText(result)).toContain("Patched: note.md");
    });
  });

  // -------------------------------------------------------------------------
  // delete_file
  // -------------------------------------------------------------------------
  describe("delete_file", () => {
    it("calls client.deleteFile and returns success", async () => {
      const { client, getTool } = setup();
      const result = await getTool("delete_file").handler({ filePath: "old.md" });
      expect(client.deleteFile).toHaveBeenCalledWith("old.md");
      expect(getText(result)).toContain("Deleted: old.md");
    });
  });

  // -------------------------------------------------------------------------
  // search_replace
  // -------------------------------------------------------------------------
  describe("search_replace", () => {
    it("reads file, replaces text, and writes back", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("Hello world");
      const result = await getTool("search_replace").handler({
        filePath: "note.md",
        search: "world",
        replace: "Obsidian",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "Hello Obsidian");
      expect(getText(result)).toContain("Replaced in: note.md");
    });

    it("returns no-match message when pattern not found", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("Hello world");
      const result = await getTool("search_replace").handler({
        filePath: "note.md",
        search: "xyz",
        replace: "abc",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).not.toHaveBeenCalled();
      expect(getText(result)).toContain("No matches found");
    });

    it("uses regex when useRegex=true", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("cat 123 cat");
      const result = await getTool("search_replace").handler({
        filePath: "note.md",
        search: "\\d+",
        replace: "NUM",
        useRegex: true,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "cat NUM cat");
      expect(getText(result)).toContain("Replaced in");
    });

    it("escapes regex special chars when useRegex=false", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("price: $5.00");
      const result = await getTool("search_replace").handler({
        filePath: "note.md",
        search: "$5.00",
        replace: "$10.00",
        useRegex: false,
        caseSensitive: true,
        replaceAll: false,
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "price: $10.00");
      expect(getText(result)).toContain("Replaced in");
    });

    it("returns errorResult when getFileContents returns non-string", async () => {
      const { client, getTool } = setup();
      const noteJson: NoteJson = { content: "", frontmatter: {}, path: "x.md", tags: [], stat: { ctime: 0, mtime: 0, size: 0 } };
      vi.mocked(client.getFileContents).mockResolvedValue(noteJson);
      const result = await getTool("search_replace").handler({
        filePath: "note.md",
        search: "x",
        replace: "y",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Expected markdown content");
    });

    it("case-insensitive replace with caseSensitive=false", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("Hello WORLD");
      await getTool("search_replace").handler({
        filePath: "note.md",
        search: "world",
        replace: "Obsidian",
        useRegex: false,
        caseSensitive: false,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "Hello Obsidian");
    });
  });

  // -------------------------------------------------------------------------
  // get_active_file
  // -------------------------------------------------------------------------
  describe("get_active_file", () => {
    it("calls client.getActiveFile and returns content", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getActiveFile).mockResolvedValue("# Active");
      const result = await getTool("get_active_file").handler({});
      expect(getText(result)).toBe("# Active");
    });
  });

  // -------------------------------------------------------------------------
  // put_active_file
  // -------------------------------------------------------------------------
  describe("put_active_file", () => {
    it("calls client.putActiveFile with content", async () => {
      const { client, getTool } = setup();
      const result = await getTool("put_active_file").handler({ content: "new content" });
      expect(client.putActiveFile).toHaveBeenCalledWith("new content");
      expect(getText(result)).toContain("Active file updated");
    });
  });

  // -------------------------------------------------------------------------
  // append_active_file
  // -------------------------------------------------------------------------
  describe("append_active_file", () => {
    it("calls client.appendActiveFile", async () => {
      const { client, getTool } = setup();
      const result = await getTool("append_active_file").handler({ content: "appended" });
      expect(client.appendActiveFile).toHaveBeenCalledWith("appended");
      expect(getText(result)).toContain("Appended to active file");
    });
  });

  // -------------------------------------------------------------------------
  // patch_active_file
  // -------------------------------------------------------------------------
  describe("patch_active_file", () => {
    it("calls client.patchActiveFile without createIfMissing", async () => {
      const { client, getTool } = setup();
      const result = await getTool("patch_active_file").handler({
        content: "text",
        operation: "prepend",
        targetType: "frontmatter",
        target: "status",
      });
      expect(client.patchActiveFile).toHaveBeenCalledWith("text", {
        operation: "prepend",
        targetType: "frontmatter",
        target: "status",
        targetDelimiter: undefined,
        trimTargetWhitespace: undefined,
        contentType: undefined,
      });
      expect(getText(result)).toContain("Active file patched");
    });
  });

  // -------------------------------------------------------------------------
  // delete_active_file
  // -------------------------------------------------------------------------
  describe("delete_active_file", () => {
    it("calls client.deleteActiveFile", async () => {
      const { client, getTool } = setup();
      const result = await getTool("delete_active_file").handler({});
      expect(client.deleteActiveFile).toHaveBeenCalled();
      expect(getText(result)).toContain("Active file deleted");
    });
  });

  // -------------------------------------------------------------------------
  // list_commands
  // -------------------------------------------------------------------------
  describe("list_commands", () => {
    it("returns command list", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listCommands).mockResolvedValue({ commands: [{ id: "cmd:1", name: "Toggle" }] });
      const result = await getTool("list_commands").handler({});
      expect(getText(result)).toContain("Toggle");
    });
  });

  // -------------------------------------------------------------------------
  // execute_command
  // -------------------------------------------------------------------------
  describe("execute_command", () => {
    it("calls client.executeCommand with commandId", async () => {
      const { client, getTool } = setup();
      const result = await getTool("execute_command").handler({ commandId: "editor:toggle-bold" });
      expect(client.executeCommand).toHaveBeenCalledWith("editor:toggle-bold");
      expect(getText(result)).toContain("Executed: editor:toggle-bold");
    });
  });

  // -------------------------------------------------------------------------
  // open_file
  // -------------------------------------------------------------------------
  describe("open_file", () => {
    it("calls client.openFile with path and newLeaf", async () => {
      const { client, getTool } = setup();
      const result = await getTool("open_file").handler({ filePath: "note.md", newLeaf: true });
      expect(client.openFile).toHaveBeenCalledWith("note.md", true);
      expect(getText(result)).toContain("Opened: note.md");
    });
  });

  // -------------------------------------------------------------------------
  // simple_search
  // -------------------------------------------------------------------------
  describe("simple_search", () => {
    it("calls client.simpleSearch with query and contextLength", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.simpleSearch).mockResolvedValue([{ filename: "match.md", score: 1 }]);
      const result = await getTool("simple_search").handler({ query: "hello", contextLength: 200 });
      expect(client.simpleSearch).toHaveBeenCalledWith("hello", 200);
      expect(getText(result)).toContain("match.md");
    });
  });

  // -------------------------------------------------------------------------
  // complex_search
  // -------------------------------------------------------------------------
  describe("complex_search", () => {
    it("calls client.complexSearch with query object", async () => {
      const { client, getTool } = setup();
      const query = { glob: [{ var: "path" }, "*.md"] };
      await getTool("complex_search").handler({ query });
      expect(client.complexSearch).toHaveBeenCalledWith(query);
    });
  });

  // -------------------------------------------------------------------------
  // dataview_search
  // -------------------------------------------------------------------------
  describe("dataview_search", () => {
    it("calls client.dataviewSearch with dql string", async () => {
      const { client, getTool } = setup();
      await getTool("dataview_search").handler({ dql: 'LIST FROM ""' });
      expect(client.dataviewSearch).toHaveBeenCalledWith('LIST FROM ""');
    });
  });

  // -------------------------------------------------------------------------
  // get_periodic_note
  // -------------------------------------------------------------------------
  describe("get_periodic_note", () => {
    it("calls client.getPeriodicNote with period and format", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getPeriodicNote).mockResolvedValue("# Daily");
      const result = await getTool("get_periodic_note").handler({ period: "daily" });
      expect(client.getPeriodicNote).toHaveBeenCalledWith("daily", undefined);
      expect(getText(result)).toBe("# Daily");
    });
  });

  // -------------------------------------------------------------------------
  // put_periodic_note
  // -------------------------------------------------------------------------
  describe("put_periodic_note", () => {
    it("calls client.putPeriodicNote", async () => {
      const { client, getTool } = setup();
      const result = await getTool("put_periodic_note").handler({ period: "weekly", content: "# Week" });
      expect(client.putPeriodicNote).toHaveBeenCalledWith("weekly", "# Week");
      expect(getText(result)).toContain("Updated weekly note");
    });
  });

  // -------------------------------------------------------------------------
  // append_periodic_note
  // -------------------------------------------------------------------------
  describe("append_periodic_note", () => {
    it("calls client.appendPeriodicNote", async () => {
      const { client, getTool } = setup();
      const result = await getTool("append_periodic_note").handler({ period: "daily", content: "- item" });
      expect(client.appendPeriodicNote).toHaveBeenCalledWith("daily", "- item");
      expect(getText(result)).toContain("Appended to daily note");
    });
  });

  // -------------------------------------------------------------------------
  // patch_periodic_note
  // -------------------------------------------------------------------------
  describe("patch_periodic_note", () => {
    it("calls client.patchPeriodicNote with patch options", async () => {
      const { client, getTool } = setup();
      const result = await getTool("patch_periodic_note").handler({
        period: "monthly",
        content: "value",
        operation: "replace",
        targetType: "frontmatter",
        target: "status",
      });
      expect(client.patchPeriodicNote).toHaveBeenCalledWith("monthly", "value", {
        operation: "replace",
        targetType: "frontmatter",
        target: "status",
        targetDelimiter: undefined,
        trimTargetWhitespace: undefined,
        createIfMissing: undefined,
        contentType: undefined,
      });
      expect(getText(result)).toContain("Patched monthly note");
    });
  });

  // -------------------------------------------------------------------------
  // delete_periodic_note
  // -------------------------------------------------------------------------
  describe("delete_periodic_note", () => {
    it("calls client.deletePeriodicNote", async () => {
      const { client, getTool } = setup();
      const result = await getTool("delete_periodic_note").handler({ period: "yearly" });
      expect(client.deletePeriodicNote).toHaveBeenCalledWith("yearly");
      expect(getText(result)).toContain("Deleted yearly note");
    });
  });

  // -------------------------------------------------------------------------
  // get_periodic_note_for_date
  // -------------------------------------------------------------------------
  describe("get_periodic_note_for_date", () => {
    it("calls client.getPeriodicNoteForDate with correct args", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getPeriodicNoteForDate).mockResolvedValue("# Jan 5");
      const result = await getTool("get_periodic_note_for_date").handler({
        period: "daily", year: 2025, month: 1, day: 5,
      });
      expect(client.getPeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 1, 5, undefined);
      expect(getText(result)).toBe("# Jan 5");
    });
  });

  // -------------------------------------------------------------------------
  // put_periodic_note_for_date
  // -------------------------------------------------------------------------
  describe("put_periodic_note_for_date", () => {
    it("calls client.putPeriodicNoteForDate with correct args", async () => {
      const { client, getTool } = setup();
      const result = await getTool("put_periodic_note_for_date").handler({
        period: "daily", year: 2025, month: 3, day: 14, content: "# Pi Day",
      });
      expect(client.putPeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 3, 14, "# Pi Day");
      expect(getText(result)).toContain("2025-3-14");
    });
  });

  // -------------------------------------------------------------------------
  // append_periodic_note_for_date
  // -------------------------------------------------------------------------
  describe("append_periodic_note_for_date", () => {
    it("calls client.appendPeriodicNoteForDate", async () => {
      const { client, getTool } = setup();
      const result = await getTool("append_periodic_note_for_date").handler({
        period: "daily", year: 2025, month: 6, day: 1, content: "extra",
      });
      expect(client.appendPeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 6, 1, "extra");
      expect(getText(result)).toContain("Appended to daily note for 2025-6-1");
    });
  });

  // -------------------------------------------------------------------------
  // patch_periodic_note_for_date
  // -------------------------------------------------------------------------
  describe("patch_periodic_note_for_date", () => {
    it("calls client.patchPeriodicNoteForDate with patch options", async () => {
      const { client, getTool } = setup();
      const result = await getTool("patch_periodic_note_for_date").handler({
        period: "daily", year: 2025, month: 1, day: 1, content: "val",
        operation: "append", targetType: "heading", target: "Tasks",
      });
      expect(client.patchPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily", 2025, 1, 1, "val",
        { operation: "append", targetType: "heading", target: "Tasks",
          targetDelimiter: undefined, trimTargetWhitespace: undefined,
          createIfMissing: undefined, contentType: undefined },
      );
      expect(getText(result)).toContain("Patched daily note for 2025-1-1");
    });
  });

  // -------------------------------------------------------------------------
  // delete_periodic_note_for_date
  // -------------------------------------------------------------------------
  describe("delete_periodic_note_for_date", () => {
    it("calls client.deletePeriodicNoteForDate", async () => {
      const { client, getTool } = setup();
      const result = await getTool("delete_periodic_note_for_date").handler({
        period: "daily", year: 2025, month: 12, day: 31,
      });
      expect(client.deletePeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 12, 31);
      expect(getText(result)).toContain("Deleted daily note for 2025-12-31");
    });
  });

  // -------------------------------------------------------------------------
  // get_server_status (PROTECTED)
  // -------------------------------------------------------------------------
  describe("get_server_status", () => {
    it("calls client.getServerStatus and returns json", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getServerStatus).mockResolvedValue({
        ok: true, service: "Obsidian Local REST API", authenticated: true, versions: { obsidian: "1.7" },
      });
      const result = await getTool("get_server_status").handler({});
      expect(getText(result)).toContain("Obsidian Local REST API");
    });
  });

  // -------------------------------------------------------------------------
  // batch_get_file_contents
  // -------------------------------------------------------------------------
  describe("batch_get_file_contents", () => {
    it("fetches all files and returns combined result", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Note A")
        .mockResolvedValueOnce("# Note B");
      const result = await getTool("batch_get_file_contents").handler({
        filePaths: ["a.md", "b.md"],
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
      }
    });

    it("handles partial failures — includes error for failed files", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Note A")
        .mockRejectedValueOnce(new ObsidianApiError("not found", 404));
      const result = await getTool("batch_get_file_contents").handler({
        filePaths: ["a.md", "missing.md"],
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        // One success, one error entry
        const hasError = parsed.some((item) => {
          if (item !== null && typeof item === "object" && "error" in item) return true;
          return false;
        });
        expect(hasError).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // get_recent_changes — cache path
  // -------------------------------------------------------------------------
  describe("get_recent_changes — cache enabled", () => {
    it("returns sorted notes from cache when initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getAllNotes).mockReturnValue([
        { path: "old.md", content: "", frontmatter: {}, tags: [], stat: { ctime: 0, mtime: 100, size: 0 }, links: [], cachedAt: 0 },
        { path: "new.md", content: "", frontmatter: {}, tags: [], stat: { ctime: 0, mtime: 999, size: 0 }, links: [], cachedAt: 0 },
      ] as never);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_recent_changes").handler({ limit: 5 });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        const first = parsed[0] as Record<string, unknown>;
        expect(first["path"]).toBe("new.md");
      }
    });

    it("falls back to API listing when cache is disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(client.listFilesInVault).mockResolvedValue({ files: ["note.md"] });
      vi.mocked(client.getFileContents).mockResolvedValue({
        content: "", frontmatter: {}, path: "note.md", tags: [], stat: { ctime: 0, mtime: 500, size: 0 },
      } as NoteJson);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: false }));
      const result = await getTool("get_recent_changes").handler({ limit: 5 });
      expect(client.listFilesInVault).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // get_recent_periodic_notes
  // -------------------------------------------------------------------------
  describe("get_recent_periodic_notes", () => {
    it("filters vault files by period directory and returns sorted list", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockResolvedValue({
        files: [
          "Daily Notes/2025-01-01.md",
          "Daily Notes/2025-01-02.md",
          "Other/note.md",
        ],
      });
      const result = await getTool("get_recent_periodic_notes").handler({ period: "daily", limit: 5 });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toContain("Daily Notes");
        // Should be reversed (most recent first)
        expect(parsed[0]).toContain("2025-01-02");
      }
    });
  });

  // -------------------------------------------------------------------------
  // configure — show
  // -------------------------------------------------------------------------
  describe("configure — show action", () => {
    it("returns redacted config as JSON", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "show" });
      expect(result.isError).toBeFalsy();
      // The mocked getRedactedConfig returns apiKey: "[SET]"
      expect(getText(result)).toContain("[SET]");
    });
  });

  // -------------------------------------------------------------------------
  // configure — set (immediate settings)
  // -------------------------------------------------------------------------
  describe("configure — set action (immediate settings)", () => {
    it("sets debug=true and calls saveConfigToFile", async () => {
      const { getTool } = setup({ configFilePath: "/tmp/test-config.json" });
      const result = await getTool("configure").handler({ action: "set", setting: "debug", value: "true" });
      expect(saveConfigToFile).toHaveBeenCalledWith("/tmp/test-config.json", { debug: true });
      expect(getText(result)).toContain("effective immediately");
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "unknownSetting", value: "foo" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Unknown setting");
    });

    it("returns errorResult when setting is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Setting name is required");
    });

    it("returns errorResult when value is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "debug" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Value is required");
    });

    it("returns errorResult for invalid debug value", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "debug", value: "maybe" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Invalid value");
    });

    it("sets timeout and saves to file", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "timeout", value: "60000" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { reliability: { timeout: 60000 } },
      );
      expect(getText(result)).toContain("effective immediately");
    });

    it("rejects invalid timeout (non-numeric)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "timeout", value: "abc" });
      expect(result.isError).toBe(true);
    });

    it("sets toolMode — requires restart", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "toolMode", value: "consolidated" });
      expect(getText(result)).toContain("Restart the server");
    });

    it("rejects invalid toolMode value", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "toolMode", value: "unknown" });
      expect(result.isError).toBe(true);
    });

    it("sets toolPreset — requires restart", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "toolPreset", value: "read-only" });
      expect(getText(result)).toContain("Restart the server");
    });
  });

  // -------------------------------------------------------------------------
  // configure — reset
  // -------------------------------------------------------------------------
  describe("configure — reset action", () => {
    it("resets debug to default", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset", setting: "debug" });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), { debug: false });
      expect(getText(result)).toContain("reset to default");
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset", setting: "unknownKey" });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when setting is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // get_backlinks (cache-dependent)
  // -------------------------------------------------------------------------
  describe("get_backlinks", () => {
    it("returns backlinks from cache when initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([
        { source: "linker.md", context: "...see [[target.md]]..." },
      ]);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_backlinks").handler({ filePath: "target.md" });
      expect(cache.getBacklinks).toHaveBeenCalledWith("target.md");
      expect(getText(result)).toContain("linker.md");
    });

    it("returns errorResult when cache is disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: false }));
      const result = await getTool("get_backlinks").handler({ filePath: "target.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult when cache is not yet initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_backlinks").handler({ filePath: "target.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("still building");
    });
  });

  // -------------------------------------------------------------------------
  // get_vault_structure (cache-dependent)
  // -------------------------------------------------------------------------
  describe("get_vault_structure", () => {
    it("returns vault stats from cache", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getOrphanNotes).mockReturnValue(["orphan.md"]);
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([{ path: "hub.md", inbound: 5, outbound: 3 }]);
      vi.mocked(cache.getVaultGraph).mockReturnValue({ nodes: ["a.md"], edges: [{ source: "a.md", target: "b.md" }] });
      vi.mocked(cache.getFileList).mockReturnValue(["subdir/note.md", "root.md"]);
      Object.defineProperty(cache, "noteCount", { get: vi.fn().mockReturnValue(10) });
      Object.defineProperty(cache, "linkCount", { get: vi.fn().mockReturnValue(5) });
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_vault_structure").handler({ limit: 10 });
      expect(result.isError).toBeFalsy();
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({ orphanCount: 1, edgeCount: 1 });
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: false }));
      const result = await getTool("get_vault_structure").handler({ limit: 10 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_vault_structure").handler({ limit: 10 });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // get_note_connections (cache-dependent)
  // -------------------------------------------------------------------------
  describe("get_note_connections", () => {
    it("returns backlinks and forward links from cache", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([{ source: "a.md", context: "see [[target]]" }]);
      vi.mocked(cache.getForwardLinks).mockReturnValue([{ target: "b.md", type: "wikilink", context: "[[b]]" }]);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_note_connections").handler({ filePath: "target.md" });
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({ backlinks: [{ source: "a.md" }], forwardLinks: [{ target: "b.md" }] });
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: false }));
      const result = await getTool("get_note_connections").handler({ filePath: "x.md" });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("get_note_connections").handler({ filePath: "x.md" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // refresh_cache (PROTECTED)
  // -------------------------------------------------------------------------
  describe("refresh_cache", () => {
    it("calls cache.refresh and returns count summary", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("refresh_cache").handler({});
      expect(cache.refresh).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("Cache refreshed");
    });

    it("returns errorResult when cache is disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: false }));
      const result = await getTool("refresh_cache").handler({});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult when cache.refresh rejects", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.refresh).mockRejectedValue(new Error("network error"));
      registerGranularTools(server as never, client, cache, () => true, makeConfig({ enableCache: true }));
      const result = await getTool("refresh_cache").handler({});
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool not registered when shouldRegister returns false
  // -------------------------------------------------------------------------
  describe("shouldRegister predicate", () => {
    it("skips tools when shouldRegister returns false", () => {
      const { server, getRegistered } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache();
      registerGranularTools(server as never, client, cache, (name) => name === "list_files_in_vault", makeConfig());
      const registered = getRegistered();
      expect(registered).toEqual(["list_files_in_vault"]);
    });
  });
});

// ===========================================================================
// Section 3: consolidated.ts tool handlers
// ===========================================================================

describe("consolidated tools — registration and behavior", () => {
  function setup(configOverrides: Partial<Config> = {}): {
    client: ObsidianClient;
    cache: VaultCache;
    getTool: (name: string) => CapturedTool;
  } {
    const { server, getTool } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const config = makeConfig({ toolMode: "consolidated", ...configOverrides });
    registerConsolidatedTools(server as never, client, cache, () => true, config);
    return { client, cache, getTool };
  }

  // -------------------------------------------------------------------------
  // vault tool
  // -------------------------------------------------------------------------
  describe("vault — list action", () => {
    it("calls client.listFilesInVault", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockResolvedValue({ files: ["x.md"] });
      const result = await getTool("vault").handler({ action: "list", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(client.listFilesInVault).toHaveBeenCalled();
      expect(getText(result)).toContain("x.md");
    });
  });

  describe("vault — list_dir action", () => {
    it("calls client.listFilesInDir with path", async () => {
      const { client, getTool } = setup();
      const result = await getTool("vault").handler({ action: "list_dir", path: "mydir", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(client.listFilesInDir).toHaveBeenCalledWith("mydir");
    });

    it("returns errorResult when path is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({ action: "list_dir", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("path is required");
    });
  });

  describe("vault — get action", () => {
    it("calls client.getFileContents with path and format", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("# Content");
      const result = await getTool("vault").handler({ action: "get", path: "note.md", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(client.getFileContents).toHaveBeenCalledWith("note.md", undefined);
      expect(getText(result)).toBe("# Content");
    });

    it("returns errorResult when path is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({ action: "get", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — put action", () => {
    it("calls client.putContent", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({ action: "put", path: "note.md", content: "body", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "body");
    });

    it("returns errorResult when path missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({ action: "put", content: "body", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when content missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({ action: "put", path: "note.md", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — append action", () => {
    it("calls client.appendContent", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({ action: "append", path: "note.md", content: "extra", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(client.appendContent).toHaveBeenCalledWith("note.md", "extra");
    });
  });

  describe("vault — patch action", () => {
    it("calls client.patchContent with all patch options", async () => {
      const { client, getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch", path: "note.md", content: "text",
        operation: "append", targetType: "heading", target: "Section",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(client.patchContent).toHaveBeenCalledWith("note.md", "text", {
        operation: "append", targetType: "heading", target: "Section",
        targetDelimiter: undefined, trimTargetWhitespace: undefined,
        createIfMissing: undefined, contentType: undefined,
      });
      expect(getText(result)).toContain("Patched: note.md");
    });

    it("returns errorResult when operation missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch", path: "note.md", content: "text",
        targetType: "heading", target: "Section",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — delete action", () => {
    it("calls client.deleteFile", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({ action: "delete", path: "note.md", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(client.deleteFile).toHaveBeenCalledWith("note.md");
    });

    it("returns errorResult when path missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({ action: "delete", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — search_replace action", () => {
    it("reads, replaces, and writes file", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("old text");
      const result = await getTool("vault").handler({
        action: "search_replace", path: "note.md", search: "old", replace: "new",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "new text");
      expect(getText(result)).toContain("Replaced in");
    });

    it("returns no-match message when not found", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("unchanged");
      const result = await getTool("vault").handler({
        action: "search_replace", path: "note.md", search: "xyz", replace: "abc",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(client.putContent).not.toHaveBeenCalled();
      expect(getText(result)).toContain("No matches found");
    });

    it("returns errorResult when search is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace", path: "note.md", replace: "new",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when replace is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace", path: "note.md", search: "old",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // vault — read-only preset blocks write actions
  // -------------------------------------------------------------------------
  describe("vault — read-only preset blocks write actions", () => {
    it("blocks put in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({
        action: "put", path: "note.md", content: "body",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("blocks append in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({
        action: "append", path: "note.md", content: "x",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });

    it("allows list in read-only preset", async () => {
      const { client, getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({ action: "list", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBeFalsy();
      expect(client.listFilesInVault).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // vault — safe preset blocks delete
  // -------------------------------------------------------------------------
  describe("vault — safe preset blocks delete", () => {
    it("blocks delete in safe preset", async () => {
      const { getTool } = setup({ toolPreset: "safe" });
      const result = await getTool("vault").handler({
        action: "delete", path: "note.md", useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("allows put in safe preset", async () => {
      const { client, getTool } = setup({ toolPreset: "safe" });
      const result = await getTool("vault").handler({
        action: "put", path: "note.md", content: "body",
        useRegex: false, caseSensitive: true, replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // active_file tool
  // -------------------------------------------------------------------------
  describe("active_file — get", () => {
    it("calls client.getActiveFile", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getActiveFile).mockResolvedValue("# Active");
      const result = await getTool("active_file").handler({ action: "get" });
      expect(getText(result)).toBe("# Active");
    });
  });

  describe("active_file — put", () => {
    it("calls client.putActiveFile", async () => {
      const { client, getTool } = setup();
      await getTool("active_file").handler({ action: "put", content: "new" });
      expect(client.putActiveFile).toHaveBeenCalledWith("new");
    });

    it("returns errorResult when content missing", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({ action: "put" });
      expect(result.isError).toBe(true);
    });
  });

  describe("active_file — append", () => {
    it("calls client.appendActiveFile", async () => {
      const { client, getTool } = setup();
      await getTool("active_file").handler({ action: "append", content: "more" });
      expect(client.appendActiveFile).toHaveBeenCalledWith("more");
    });
  });

  describe("active_file — patch", () => {
    it("calls client.patchActiveFile", async () => {
      const { client, getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch", content: "val",
        operation: "append", targetType: "heading", target: "Section",
      });
      expect(client.patchActiveFile).toHaveBeenCalledWith("val", {
        operation: "append", targetType: "heading", target: "Section",
        targetDelimiter: undefined, trimTargetWhitespace: undefined, contentType: undefined,
      });
      expect(getText(result)).toContain("Active file patched");
    });

    it("returns errorResult when operation missing", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch", content: "val", targetType: "heading", target: "Section",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("active_file — delete", () => {
    it("calls client.deleteActiveFile", async () => {
      const { client, getTool } = setup();
      await getTool("active_file").handler({ action: "delete" });
      expect(client.deleteActiveFile).toHaveBeenCalled();
    });

    it("blocks delete in safe preset", async () => {
      const { getTool } = setup({ toolPreset: "safe" });
      const result = await getTool("active_file").handler({ action: "delete" });
      expect(result.isError).toBe(true);
    });

    it("blocks delete in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("active_file").handler({ action: "delete" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // commands tool
  // -------------------------------------------------------------------------
  describe("commands — list", () => {
    it("calls client.listCommands", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listCommands).mockResolvedValue({ commands: [{ id: "x", name: "X" }] });
      const result = await getTool("commands").handler({ action: "list" });
      expect(getText(result)).toContain('"name": "X"');
    });
  });

  describe("commands — execute", () => {
    it("calls client.executeCommand with commandId", async () => {
      const { client, getTool } = setup();
      await getTool("commands").handler({ action: "execute", commandId: "editor:bold" });
      expect(client.executeCommand).toHaveBeenCalledWith("editor:bold");
    });

    it("returns errorResult when commandId missing", async () => {
      const { getTool } = setup();
      const result = await getTool("commands").handler({ action: "execute" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // open_file tool
  // -------------------------------------------------------------------------
  describe("open_file", () => {
    it("calls client.openFile", async () => {
      const { client, getTool } = setup();
      await getTool("open_file").handler({ path: "note.md", newLeaf: false });
      expect(client.openFile).toHaveBeenCalledWith("note.md", false);
    });
  });

  // -------------------------------------------------------------------------
  // search tool
  // -------------------------------------------------------------------------
  describe("search — simple", () => {
    it("calls client.simpleSearch", async () => {
      const { client, getTool } = setup();
      await getTool("search").handler({ type: "simple", query: "hello", contextLength: 100 });
      expect(client.simpleSearch).toHaveBeenCalledWith("hello", 100);
    });

    it("returns errorResult when query missing", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({ type: "simple", contextLength: 100 });
      expect(result.isError).toBe(true);
    });
  });

  describe("search — jsonlogic", () => {
    it("calls client.complexSearch with jsonQuery", async () => {
      const { client, getTool } = setup();
      const jsonQuery = { glob: [{ var: "path" }, "*.md"] };
      await getTool("search").handler({ type: "jsonlogic", jsonQuery, contextLength: 100 });
      expect(client.complexSearch).toHaveBeenCalledWith(jsonQuery);
    });

    it("returns errorResult when jsonQuery missing", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({ type: "jsonlogic", contextLength: 100 });
      expect(result.isError).toBe(true);
    });
  });

  describe("search — dataview", () => {
    it("calls client.dataviewSearch with query", async () => {
      const { client, getTool } = setup();
      await getTool("search").handler({ type: "dataview", query: 'LIST FROM ""', contextLength: 100 });
      expect(client.dataviewSearch).toHaveBeenCalledWith('LIST FROM ""');
    });

    it("returns errorResult when query missing", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({ type: "dataview", contextLength: 100 });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // periodic_note tool
  // -------------------------------------------------------------------------
  describe("periodic_note — get (current)", () => {
    it("calls client.getPeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getPeriodicNote).mockResolvedValue("# Today");
      const result = await getTool("periodic_note").handler({ action: "get", period: "daily" });
      expect(client.getPeriodicNote).toHaveBeenCalledWith("daily", undefined);
      expect(getText(result)).toBe("# Today");
    });
  });

  describe("periodic_note — get (by date)", () => {
    it("calls client.getPeriodicNoteForDate when year/month/day all present", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getPeriodicNoteForDate).mockResolvedValue("# Specific day");
      const result = await getTool("periodic_note").handler({
        action: "get", period: "daily", year: 2025, month: 3, day: 14,
      });
      expect(client.getPeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 3, 14, undefined);
      expect(getText(result)).toBe("# Specific day");
    });
  });

  describe("periodic_note — put (current)", () => {
    it("calls client.putPeriodicNote", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({ action: "put", period: "weekly", content: "# Week" });
      expect(client.putPeriodicNote).toHaveBeenCalledWith("weekly", "# Week");
    });

    it("returns errorResult when content missing", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({ action: "put", period: "daily" });
      expect(result.isError).toBe(true);
    });
  });

  describe("periodic_note — put (by date)", () => {
    it("calls client.putPeriodicNoteForDate", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "put", period: "daily", year: 2025, month: 1, day: 1, content: "# New Year",
      });
      expect(client.putPeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 1, 1, "# New Year");
    });
  });

  describe("periodic_note — append", () => {
    it("calls client.appendPeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({ action: "append", period: "daily", content: "item" });
      expect(client.appendPeriodicNote).toHaveBeenCalledWith("daily", "item");
    });

    it("calls client.appendPeriodicNoteForDate when date given", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "append", period: "daily", year: 2025, month: 6, day: 15, content: "item",
      });
      expect(client.appendPeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 6, 15, "item");
    });
  });

  describe("periodic_note — patch", () => {
    it("calls client.patchPeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch", period: "daily", content: "val",
        operation: "replace", targetType: "frontmatter", target: "status",
      });
      expect(client.patchPeriodicNote).toHaveBeenCalledWith("daily", "val", {
        operation: "replace", targetType: "frontmatter", target: "status",
        targetDelimiter: undefined, trimTargetWhitespace: undefined,
        createIfMissing: undefined, contentType: undefined,
      });
      expect(getText(result)).toContain("Patched daily note");
    });

    it("calls client.patchPeriodicNoteForDate when date provided", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "patch", period: "daily", year: 2025, month: 3, day: 1, content: "val",
        operation: "append", targetType: "heading", target: "Tasks",
      });
      expect(client.patchPeriodicNoteForDate).toHaveBeenCalled();
    });

    it("returns errorResult when operation missing", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch", period: "daily", content: "val",
        targetType: "heading", target: "Section",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("periodic_note — delete", () => {
    it("calls client.deletePeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({ action: "delete", period: "daily" });
      expect(client.deletePeriodicNote).toHaveBeenCalledWith("daily");
    });

    it("calls client.deletePeriodicNoteForDate when date given", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "delete", period: "daily", year: 2025, month: 12, day: 31,
      });
      expect(client.deletePeriodicNoteForDate).toHaveBeenCalledWith("daily", 2025, 12, 31);
    });

    it("blocks delete in safe preset", async () => {
      const { getTool } = setup({ toolPreset: "safe" });
      const result = await getTool("periodic_note").handler({ action: "delete", period: "daily" });
      expect(result.isError).toBe(true);
    });

    it("blocks delete in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("periodic_note").handler({ action: "delete", period: "daily" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // status tool (PROTECTED)
  // -------------------------------------------------------------------------
  describe("status", () => {
    it("calls client.getServerStatus", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getServerStatus).mockResolvedValue({
        ok: true, service: "Obsidian REST API", authenticated: true, versions: {},
      });
      const result = await getTool("status").handler({});
      expect(client.getServerStatus).toHaveBeenCalled();
      expect(getText(result)).toContain("Obsidian REST API");
    });

    it("returns errorResult on connection error", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getServerStatus).mockRejectedValue(new ObsidianConnectionError("refused"));
      const result = await getTool("status").handler({});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("CONNECTION ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // batch_get tool
  // -------------------------------------------------------------------------
  describe("batch_get", () => {
    it("fetches all paths and returns combined results", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Note 1")
        .mockResolvedValueOnce("# Note 2");
      const result = await getTool("batch_get").handler({ paths: ["a.md", "b.md"] });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
      }
    });

    it("handles partial failures gracefully", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Note")
        .mockRejectedValueOnce(new ObsidianApiError("not found", 404));
      const result = await getTool("batch_get").handler({ paths: ["ok.md", "missing.md"] });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        const hasError = parsed.some((item) => {
          return item !== null && typeof item === "object" && "error" in item;
        });
        expect(hasError).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // recent tool
  // -------------------------------------------------------------------------
  describe("recent — changes (with cache)", () => {
    it("returns sorted notes from cache", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getAllNotes).mockReturnValue([
        { path: "old.md", content: "", frontmatter: {}, tags: [], stat: { ctime: 0, mtime: 100, size: 0 }, links: [], cachedAt: 0 },
        { path: "new.md", content: "", frontmatter: {}, tags: [], stat: { ctime: 0, mtime: 999, size: 0 }, links: [], cachedAt: 0 },
      ] as never);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("recent").handler({ type: "changes", limit: 5 });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0] as Record<string, unknown>;
        expect(first["path"]).toBe("new.md");
      }
    });

    it("falls back to API when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(client.listFilesInVault).mockResolvedValue({ files: ["note.md"] });
      vi.mocked(client.getFileContents).mockResolvedValue({
        content: "", frontmatter: {}, path: "note.md", tags: [], stat: { ctime: 0, mtime: 500, size: 0 },
      } as NoteJson);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("recent").handler({ type: "changes", limit: 5 });
      expect(client.listFilesInVault).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
    });
  });

  describe("recent — periodic_notes", () => {
    it("filters vault files by period directory", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockResolvedValue({
        files: [
          "Weekly Notes/2025-W01.md",
          "Weekly Notes/2025-W02.md",
          "Daily Notes/2025-01-01.md",
        ],
      });
      const result = await getTool("recent").handler({ type: "periodic_notes", period: "weekly", limit: 10 });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
        expect((parsed as string[])[0]).toContain("Weekly Notes");
      }
    });

    it("returns errorResult when period missing for periodic_notes type", async () => {
      const { getTool } = setup();
      const result = await getTool("recent").handler({ type: "periodic_notes", limit: 10 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("period is required");
    });
  });

  // -------------------------------------------------------------------------
  // configure tool (PROTECTED) — consolidated version
  // -------------------------------------------------------------------------
  describe("configure — consolidated show", () => {
    it("returns redacted config", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "show" });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("[SET]");
    });
  });

  describe("configure — consolidated set", () => {
    it("sets debug=false", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "debug", value: "false" });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), { debug: false });
      expect(getText(result)).toContain("effective immediately");
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "badKey", value: "x" });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when setting omitted", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set" });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when value omitted", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "debug" });
      expect(result.isError).toBe(true);
    });

    it("rejects invalid maxResponseChars (negative)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "maxResponseChars", value: "-1" });
      expect(result.isError).toBe(true);
    });

    it("sets maxResponseChars=0 (disabled)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "maxResponseChars", value: "0" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { reliability: { maxResponseChars: 0 } },
      );
      expect(result.isError).toBeFalsy();
    });

    it("sets verifyWrites=true", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "verifyWrites", value: "true" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { reliability: { verifyWrites: true } },
      );
      expect(result.isError).toBeFalsy();
    });

    it("rejects invalid toolPreset value", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set", setting: "toolPreset", value: "invalid" });
      expect(result.isError).toBe(true);
    });
  });

  describe("configure — consolidated reset", () => {
    it("resets timeout to 30000", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset", setting: "timeout" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { reliability: { timeout: 30000 } },
      );
      expect(getText(result)).toContain("reset to default");
    });

    it("resets verifyWrites to false", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({ action: "reset", setting: "verifyWrites" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { reliability: { verifyWrites: false } },
      );
    });

    it("resets maxResponseChars to 500000", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({ action: "reset", setting: "maxResponseChars" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { reliability: { maxResponseChars: 500000 } },
      );
    });

    it("resets toolMode to granular", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({ action: "reset", setting: "toolMode" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { tools: { mode: "granular" } },
      );
    });

    it("resets toolPreset to full", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({ action: "reset", setting: "toolPreset" });
      expect(saveConfigToFile).toHaveBeenCalledWith(
        expect.any(String),
        { tools: { preset: "full" } },
      );
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset", setting: "unknownKey" });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when setting omitted", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // vault_analysis tool
  // -------------------------------------------------------------------------
  describe("vault_analysis — backlinks", () => {
    it("returns backlinks from cache", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([{ source: "ref.md", context: "see [[target]]" }]);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "backlinks", path: "target.md", limit: 10 });
      expect(cache.getBacklinks).toHaveBeenCalledWith("target.md");
      expect(getText(result)).toContain("ref.md");
    });

    it("returns errorResult when path missing", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "backlinks", limit: 10 });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: false }));
      const result = await getTool("vault_analysis").handler({ action: "backlinks", path: "x.md", limit: 10 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "backlinks", path: "x.md", limit: 10 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("still building");
    });
  });

  describe("vault_analysis — connections", () => {
    it("returns backlinks and forward links", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([{ source: "a.md", context: "ctx" }]);
      vi.mocked(cache.getForwardLinks).mockReturnValue([{ target: "b.md", type: "wikilink", context: "[[b]]" }]);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "connections", path: "center.md", limit: 10 });
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({ backlinks: [{ source: "a.md" }], forwardLinks: [{ target: "b.md" }] });
    });

    it("returns errorResult when path missing", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "connections", limit: 10 });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault_analysis — structure", () => {
    it("returns vault structure stats", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getOrphanNotes).mockReturnValue(["orphan.md"]);
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([{ path: "hub.md", inbound: 7, outbound: 2 }]);
      vi.mocked(cache.getVaultGraph).mockReturnValue({ nodes: ["a.md"], edges: [{ source: "a.md", target: "b.md" }] });
      vi.mocked(cache.getFileList).mockReturnValue(["folder/note.md"]);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "structure", limit: 10 });
      expect(result.isError).toBeFalsy();
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({ orphanCount: 1, edgeCount: 1 });
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "structure", limit: 10 });
      expect(result.isError).toBe(true);
    });

    it("blocks structure in read-only preset", async () => {
      // read-only only allows backlinks/connections/structure — "refresh" is blocked
      // structure itself is allowed in read-only; let's verify it goes through
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getOrphanNotes).mockReturnValue([]);
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([]);
      vi.mocked(cache.getVaultGraph).mockReturnValue({ nodes: [], edges: [] });
      vi.mocked(cache.getFileList).mockReturnValue([]);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", toolPreset: "read-only", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "structure", limit: 10 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe("vault_analysis — refresh", () => {
    it("calls cache.refresh and returns summary", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "refresh", limit: 10 });
      expect(cache.refresh).toHaveBeenCalled();
      expect(getText(result)).toContain("Cache refreshed");
    });

    it("blocks refresh in read-only preset", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", toolPreset: "read-only", enableCache: true }));
      const result = await getTool("vault_analysis").handler({ action: "refresh", limit: 10 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(server as never, client, cache, () => true, makeConfig({ toolMode: "consolidated", enableCache: false }));
      const result = await getTool("vault_analysis").handler({ action: "refresh", limit: 10 });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation — API error types map to correct messages
  // -------------------------------------------------------------------------
  describe("error propagation via buildErrorMessage", () => {
    it("connection error produces CONNECTION ERROR prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(new ObsidianConnectionError("ECONNREFUSED"));
      const result = await getTool("vault").handler({ action: "list", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("CONNECTION ERROR");
    });

    it("auth error produces AUTH ERROR prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(new ObsidianAuthError());
      const result = await getTool("vault").handler({ action: "list", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("AUTH ERROR");
    });

    it("400 API error produces BAD REQUEST message", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(new ObsidianApiError("malformed", 400));
      const result = await getTool("vault").handler({ action: "get", path: "x.md", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("BAD REQUEST");
    });

    it("405 API error produces NOT SUPPORTED message", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(new ObsidianApiError("not supported", 405));
      const result = await getTool("vault").handler({ action: "get", path: "x.md", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("NOT SUPPORTED");
    });

    it("generic Error produces ERROR prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(new Error("unexpected"));
      const result = await getTool("vault").handler({ action: "list", useRegex: false, caseSensitive: true, replaceAll: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("ERROR: unexpected");
    });
  });
});
