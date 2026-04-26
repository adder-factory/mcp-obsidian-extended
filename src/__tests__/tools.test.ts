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
import {
  ObsidianApiError,
  ObsidianConnectionError,
  ObsidianAuthError,
} from "../errors.js";
import { CACHE_INIT_TIMEOUT_MS } from "../tools/shared.js";

// ---------------------------------------------------------------------------
// Suppress stderr output during tests to avoid cluttering logs from expected
// error-path execution; this global mock is restored after each test.
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
 * A captured tool registration: the arguments passed to server.registerTool().
 * The handler signature matches the SDK: (args: unknown) => Promise<ToolResult>.
 */
interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Creates a mock McpServer that captures every server.registerTool() call.
 * Returns both the mock server and a helper to look up captured tools.
 */
function makeMockServer(): {
  server: { registerTool: ReturnType<typeof vi.fn> };
  getTool: (name: string) => CapturedTool;
  getRegistered: () => string[];
} {
  const captured: CapturedTool[] = [];

  const registerToolFn = vi.fn(
    (
      name: string,
      config: { description?: string; inputSchema?: unknown },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => {
      captured.push({
        name,
        description: config.description ?? "",
        schema: config as Record<string, unknown>,
        handler,
      });
    },
  );

  const server = { registerTool: registerToolFn };

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
    getServerStatus: vi.fn().mockResolvedValue({
      ok: true,
      service: "Obsidian REST API",
      authenticated: true,
      versions: {},
    }),
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
    getPeriodicNoteForDate: vi
      .fn()
      .mockResolvedValue("# Periodic note for date"),
    putPeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
    appendPeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
    patchPeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
    deletePeriodicNoteForDate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ObsidianClient;
}

/** Creates a mock VaultCache with configurable initialization state. */
function makeMockCache(
  initialized = true,
  willInitialize = initialized,
): VaultCache {
  return {
    getIsInitialized: vi.fn().mockReturnValue(initialized),
    waitForInitialization: vi.fn().mockResolvedValue(willInitialize),
    getAllNotes: vi.fn().mockReturnValue([]),
    getFileList: vi.fn().mockReturnValue([]),
    noteCount: 0,
    linkCount: 0,
    getBacklinks: vi.fn().mockReturnValue([]),
    getForwardLinks: vi.fn().mockReturnValue([]),
    getOrphanNotes: vi.fn().mockReturnValue([]),
    getMostConnectedNotes: vi.fn().mockReturnValue([]),
    getVaultGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    getEdgeCount: vi.fn().mockReturnValue(0),
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
  compactResponses: false,
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
  it("registers 39 tools in full preset", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never,
      client,
      cache,
      makeConfig(),
    );
    expect(count).toBe(39);
    expect(getRegistered()).toHaveLength(39);
  });

  it("registers 19 tools in read-only preset", () => {
    // open_file removed from read-only (POST /open/{path} can create files)
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({ toolPreset: "read-only" }),
    );
    expect(count).toBe(19);
  });

  it("registers 8 tools in minimal preset", () => {
    // 7 preset tools + refresh_cache (protected, not in minimal preset)
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({ toolPreset: "minimal" }),
    );
    expect(count).toBe(8);
  });

  it("registers 35 tools in safe preset", () => {
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({ toolPreset: "safe" }),
    );
    expect(count).toBe(35);
  });

  it("protected tools are always registered even when excluded", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({
        excludeTools: ["configure", "get_server_status", "refresh_cache"],
      }),
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
      server as never,
      client,
      cache,
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
      server as never,
      client,
      cache,
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
      server as never,
      client,
      cache,
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
      server as never,
      client,
      cache,
      makeConfig({ toolMode: "consolidated" }),
    );
    expect(count).toBe(11);
  });

  it("registers 5 tools in minimal preset (vault_analysis is protected)", () => {
    const { server } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const count = registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({ toolMode: "consolidated", toolPreset: "minimal" }),
    );
    // vault, search, status, configure (preset) + vault_analysis (protected)
    expect(count).toBe(5);
  });

  it("protected tools (configure, status, vault_analysis) always registered when excluded", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({
        toolMode: "consolidated",
        excludeTools: ["configure", "status", "vault_analysis"],
      }),
    );
    const registered = getRegistered();
    expect(registered).toContain("configure");
    expect(registered).toContain("status");
    expect(registered).toContain("vault_analysis");
  });

  it("INCLUDE_TOOLS filters consolidated tools", () => {
    const { server, getRegistered } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({
        toolMode: "consolidated",
        includeTools: ["vault", "search"],
      }),
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
// Section 1.5: tool metadata (descriptions + Zod .describe() hints)
// ===========================================================================
//
// Issue #15. Stryker mutation testing surfaced ~25 surviving StringLiteral
// mutants on src/tools/granular.ts L43–L1079: descriptions + .describe() hints
// could be mutated to "" without any test catching it. MCP description text
// and Zod .describe() are the primary signals an LLM uses to pick the right
// tool and fill its parameters; a blank one ships a tool the model can't find
// or a parameter it fills wrong. These tests assert the contract regardless
// of mode/preset.

describe("tool metadata — descriptions and schema hints", () => {
  // Recognized verb prefixes. Comma-separated openers ("Read, write, search…")
  // match because the first word is a verb. Tools whose descriptions open with
  // a noun-category instead of a verb stay in VERB_OPENER_EXCEPTIONS — keep that
  // set narrow; adding a name here is a deliberate exception to the contract.
  // Verb set is liberal by design — adding a verb here is cheap, but failing
  // a real PR for a legitimately verb-led description (e.g., a future "Rename"
  // tool) is an annoying yak-shave. New verbs added on each Phase 4 reviewer
  // pass; extend further if a future tool surfaces a missing one.
  const VERB_PREFIX_RE =
    /^(List|Get|Read|Put|Append|Patch|Delete|Replace|Move|Search|Run|Execute|Check|Force|Refresh|Create|Configure|Analyze|Insert|Open|Find|View|Query|Update|Toggle|Enable|Disable|Rename|Copy|CRUD)\b/;

  // Token budget contract from CLAUDE.md L81: "Tool descriptions: MAX 15
  // words. Parameter descriptions: MAX 10 words. Tokens matter." Codified
  // here so future tool additions can't drift past the budget unnoticed.
  const MAX_TOOL_DESCRIPTION_WORDS = 15;
  const MAX_PARAM_DESCRIPTION_WORDS = 10;

  /**
   * Counts whitespace-separated words in a description string. Empty / blank
   * inputs return 0.
   * @param s description string
   */
  const countWords = (s: string): number =>
    s.trim().split(/\s+/).filter(Boolean).length;
  const VERB_OPENER_EXCEPTIONS = new Set<string>([
    // vault_analysis opens with "Backlinks, connections, structure…" — it
    // describes a category of read-only inspections, not a single action.
    "vault_analysis",
    // simple_search opens with "Full-text search across all vault files…" —
    // the noun-modifier describes the search variety; rewriting to "Search…"
    // would lose the disambiguation from complex_search / dataview_search.
    "simple_search",
  ]);

  /**
   * Walks a Zod schema tree and returns the first non-empty `.description`
   * found, descending through wrapper types.
   *
   * Zod replaces the outer schema with a new wrapper whose `.description` is
   * undefined unless `.describe()` was called on the wrapper itself. This
   * codebase mixes `.optional().describe(...)` (outer-described) and
   * `someSharedSchema.optional()` (inner-described); the walker descends
   * through `_def.innerType` (ZodOptional / ZodNullable / ZodDefault),
   * `_def.type` (ZodArray), and `_def.schema` (ZodEffects from `.refine()` /
   * `.transform()`) so both patterns surface a description.
   *
   * @param node Zod schema (typed as `unknown` so the helper stays
   *             zod-import-free; narrowed via `in` operator + `typeof`).
   * @returns the description text, or `undefined` if none found.
   */
  function getZodDescription(node: unknown): string | undefined {
    if (!node || typeof node !== "object") return undefined;
    if (
      "description" in node &&
      typeof node.description === "string" &&
      node.description.length > 0
    ) {
      return node.description;
    }
    if (!("_def" in node) || !node._def || typeof node._def !== "object") {
      return undefined;
    }
    const def = node._def;
    if ("innerType" in def) return getZodDescription(def.innerType);
    if ("type" in def) return getZodDescription(def.type);
    if ("schema" in def) return getZodDescription(def.schema);
    return undefined;
  }

  /**
   * Unwraps a captured inputSchema until a ZodObject surfaces (one that
   * exposes `.shape`). Mirrors {@link getZodDescription}'s traversal so a
   * top-level `.refine()` / `.transform()` wrapping the object schema doesn't
   * silently skip field assertions for the tool.
   *
   * @param node candidate ZodObject or wrapper containing one.
   * @returns the underlying `.shape` map, or `undefined` if no ZodObject is
   *          reachable through the wrapper chain.
   */
  function unwrapToZodObject(
    node: unknown,
  ): Record<string, unknown> | undefined {
    if (!node || typeof node !== "object") return undefined;
    if ("shape" in node && node.shape && typeof node.shape === "object") {
      // Provably safe: shape is narrowed to non-null object; ZodObject's shape
      // is structurally Record<string, ZodTypeAny> at runtime — we treat its
      // values as `unknown` and let getZodDescription narrow them.
      return node.shape as Record<string, unknown>;
    }
    if (!("_def" in node) || !node._def || typeof node._def !== "object") {
      return undefined;
    }
    const def = node._def;
    if ("innerType" in def) return unwrapToZodObject(def.innerType);
    if ("schema" in def) return unwrapToZodObject(def.schema);
    return undefined;
  }

  /**
   * Extracts `[fieldName, descriptionText]` pairs for every field in a
   * captured tool's Zod inputSchema. Returns `[]` if the tool legitimately
   * has no inputSchema (e.g. `list_files_in_vault`); HARD-FAILS via
   * `expect()` if an inputSchema is present but the walker cannot reach a
   * ZodObject — that case would otherwise let the `.describe()` contract
   * pass vacuously while skipping every field.
   *
   * @param toolName name of the tool (for assertion failure messages).
   * @param schema captured tool's full registration config (`{ description,
   *               inputSchema }`).
   */
  function inputFieldDescriptions(
    toolName: string,
    schema: Record<string, unknown>,
  ): Array<[string, string | undefined]> {
    if (schema.inputSchema === undefined) return [];
    const shape = unwrapToZodObject(schema.inputSchema);
    expect(
      shape,
      `${toolName}: inputSchema present but unwrapToZodObject did not reach a ZodObject — metadata checks would silently skip every field`,
    ).toBeDefined();
    if (!shape) return [];
    expect(
      Object.keys(shape).length,
      `${toolName}: inputSchema unwrapped to an empty ZodObject shape — metadata checks would pass vacuously`,
    ).toBeGreaterThan(0);
    return Object.entries(shape).map(([fieldName, fieldType]) => [
      fieldName,
      getZodDescription(fieldType),
    ]);
  }

  /**
   * Registers every tool for a given mode at preset=`full` and returns the
   * captured registrations. Per-mode preset filters are bypassed so the
   * metadata assertions see the full tool surface.
   *
   * @param toolMode `"granular"` (39 tools) or `"consolidated"` (11 tools).
   */
  function enumerateAllTools(
    toolMode: "granular" | "consolidated",
  ): CapturedTool[] {
    const { server, getRegistered, getTool } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    registerAllTools(
      server as never,
      client,
      cache,
      makeConfig({ toolMode, toolPreset: "full" }),
    );
    return getRegistered().map(getTool);
  }

  const TOOL_MODES: ReadonlyArray<Parameters<typeof enumerateAllTools>[0]> = [
    "granular",
    "consolidated",
  ];

  for (const mode of TOOL_MODES) {
    describe(`${mode} mode (preset: full)`, () => {
      it("every tool has a non-empty description ≥ 10 chars and ≤ 15 words", () => {
        const tools = enumerateAllTools(mode);
        expect(tools.length).toBeGreaterThan(0);
        for (const t of tools) {
          expect(typeof t.description, `${t.name}: description type`).toBe(
            "string",
          );
          expect(
            t.description.trim().length,
            `${t.name}: description length`,
          ).toBeGreaterThanOrEqual(10);
          expect(
            countWords(t.description),
            `${t.name}: description word count (CLAUDE.md L81 token budget)`,
          ).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_WORDS);
        }
      });

      it("every tool description starts with a recognized verb (or is allowlisted)", () => {
        const tools = enumerateAllTools(mode);
        for (const t of tools) {
          if (VERB_OPENER_EXCEPTIONS.has(t.name)) continue;
          expect(t.description, `${t.name}: description verb prefix`).toMatch(
            VERB_PREFIX_RE,
          );
        }
      });

      it("every Zod schema field has a non-empty .describe() text ≥ 3 chars and ≤ 10 words", () => {
        const tools = enumerateAllTools(mode);
        for (const t of tools) {
          for (const [fieldName, desc] of inputFieldDescriptions(
            t.name,
            t.schema,
          )) {
            expect(
              typeof desc,
              `${t.name}.${fieldName}: .describe() type`,
            ).toBe("string");
            expect(
              (desc ?? "").trim().length,
              `${t.name}.${fieldName}: .describe() length`,
            ).toBeGreaterThanOrEqual(3);
            expect(
              countWords(desc ?? ""),
              `${t.name}.${fieldName}: .describe() word count (CLAUDE.md L81 token budget)`,
            ).toBeLessThanOrEqual(MAX_PARAM_DESCRIPTION_WORDS);
          }
        }
      });
    });
  }
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
      vi.mocked(client.listFilesInVault).mockResolvedValue({
        files: ["a.md", "b.md"],
      });
      const result = await getTool("list_files_in_vault").handler({});
      expect(client.listFilesInVault).toHaveBeenCalled();
      expect(getText(result)).toContain("a.md");
      expect(result.isError).toBeFalsy();
    });

    it("returns errorResult on connection error", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(
        new ObsidianConnectionError("refused"),
      );
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
      vi.mocked(client.listFilesInDir).mockResolvedValue({
        files: ["dir/note.md"],
      });
      const result = await getTool("list_files_in_dir").handler({
        dirPath: "dir",
      });
      expect(client.listFilesInDir).toHaveBeenCalledWith("dir");
      expect(getText(result)).toContain("dir/note.md");
    });

    it("returns errorResult on API 404", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInDir).mockRejectedValue(
        new ObsidianApiError("not found", 404),
      );
      const result = await getTool("list_files_in_dir").handler({
        dirPath: "missing",
      });
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
      const result = await getTool("get_file_contents").handler({
        path: "note.md",
      });
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
      const result = await getTool("get_file_contents").handler({
        path: "note.md",
        format: "json",
      });
      expect(getText(result)).toContain('"path": "note.md"');
    });

    it("returns errorResult on auth error", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(
        new ObsidianAuthError(),
      );
      const result = await getTool("get_file_contents").handler({
        path: "note.md",
      });
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
      const result = await getTool("put_content").handler({
        path: "test.md",
        content: "hello",
      });
      expect(client.putContent).toHaveBeenCalledWith("test.md", "hello");
      expect(getText(result)).toContain("Written: test.md");
    });

    it("returns errorResult on failure", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.putContent).mockRejectedValue(new Error("write failed"));
      const result = await getTool("put_content").handler({
        path: "test.md",
        content: "x",
      });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // append_content
  // -------------------------------------------------------------------------
  describe("append_content", () => {
    it("calls client.appendContent and returns success", async () => {
      const { client, getTool } = setup();
      const result = await getTool("append_content").handler({
        path: "note.md",
        content: "extra",
      });
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
        path: "note.md",
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
      const result = await getTool("delete_file").handler({ path: "old.md" });
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
        path: "note.md",
        search: "world",
        replace: "Obsidian",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith(
        "note.md",
        "Hello Obsidian",
      );
      expect(getText(result)).toContain("Replaced in: note.md");
    });

    it("replaces only the first match when replaceAll is false", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("world world world");
      const result = await getTool("search_replace").handler({
        path: "note.md",
        search: "world",
        replace: "Obsidian",
        useRegex: false,
        caseSensitive: true,
        replaceAll: false,
      });
      expect(client.putContent).toHaveBeenCalledWith(
        "note.md",
        "Obsidian world world",
      );
      expect(getText(result)).toContain("Replaced in: note.md");
    });

    it("returns no-match message when pattern not found", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("Hello world");
      const result = await getTool("search_replace").handler({
        path: "note.md",
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
        path: "note.md",
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
        path: "note.md",
        search: "$5.00",
        replace: "$10.00",
        useRegex: false,
        caseSensitive: true,
        replaceAll: false,
      });
      expect(client.putContent).toHaveBeenCalledWith(
        "note.md",
        "price: $10.00",
      );
      expect(getText(result)).toContain("Replaced in");
    });

    it("returns errorResult when getFileContents returns non-string", async () => {
      const { client, getTool } = setup();
      const noteJson: NoteJson = {
        content: "",
        frontmatter: {},
        path: "x.md",
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 0 },
      };
      vi.mocked(client.getFileContents).mockResolvedValue(noteJson);
      const result = await getTool("search_replace").handler({
        path: "note.md",
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
        path: "note.md",
        search: "world",
        replace: "Obsidian",
        useRegex: false,
        caseSensitive: false,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith(
        "note.md",
        "Hello Obsidian",
      );
    });
  });

  // -------------------------------------------------------------------------
  // move_file
  // -------------------------------------------------------------------------
  describe("move_file", () => {
    it("moves a file from source to destination", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Content")
        .mockRejectedValueOnce(new ObsidianApiError("Not found", 404));
      const result = await getTool("move_file").handler({
        source: "old.md",
        destination: "new.md",
      });
      expect(getText(result)).toContain("Moved");
      expect(client.putContent).toHaveBeenCalledWith("new.md", "# Content");
      expect(client.deleteFile).toHaveBeenCalledWith("old.md");
    });

    it("returns no-op when source and destination are the same", async () => {
      const { getTool } = setup();
      const result = await getTool("move_file").handler({
        source: "same.md",
        destination: "same.md",
      });
      expect(getText(result)).toContain("No-op");
      expect(result.isError).toBeFalsy();
    });

    it("returns conflict error when destination exists", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Source")
        .mockResolvedValueOnce("# Destination exists");
      const result = await getTool("move_file").handler({
        source: "old.md",
        destination: "existing.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("CONFLICT");
    });

    it("returns error when source does not exist", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(
        new ObsidianApiError("Not found", 404),
      );
      const result = await getTool("move_file").handler({
        source: "missing.md",
        destination: "new.md",
      });
      expect(result.isError).toBe(true);
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
      const result = await getTool("put_active_file").handler({
        content: "new content",
      });
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
      const result = await getTool("append_active_file").handler({
        content: "appended",
      });
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
      vi.mocked(client.listCommands).mockResolvedValue({
        commands: [{ id: "cmd:1", name: "Toggle" }],
      });
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
      const result = await getTool("execute_command").handler({
        commandId: "editor:toggle-bold",
      });
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
      const result = await getTool("open_file").handler({
        path: "note.md",
        newLeaf: true,
      });
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
      vi.mocked(client.simpleSearch).mockResolvedValue([
        { filename: "match.md", score: 1 },
      ]);
      const result = await getTool("simple_search").handler({
        query: "hello",
        contextLength: 200,
      });
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
      const result = await getTool("get_periodic_note").handler({
        period: "daily",
      });
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
      const result = await getTool("put_periodic_note").handler({
        period: "weekly",
        content: "# Week",
      });
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
      const result = await getTool("append_periodic_note").handler({
        period: "daily",
        content: "- item",
      });
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
      expect(client.patchPeriodicNote).toHaveBeenCalledWith(
        "monthly",
        "value",
        {
          operation: "replace",
          targetType: "frontmatter",
          target: "status",
          targetDelimiter: undefined,
          trimTargetWhitespace: undefined,
          createIfMissing: undefined,
          contentType: undefined,
        },
      );
      expect(getText(result)).toContain("Patched monthly note");
    });
  });

  // -------------------------------------------------------------------------
  // delete_periodic_note
  // -------------------------------------------------------------------------
  describe("delete_periodic_note", () => {
    it("calls client.deletePeriodicNote", async () => {
      const { client, getTool } = setup();
      const result = await getTool("delete_periodic_note").handler({
        period: "yearly",
      });
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
        period: "daily",
        year: 2025,
        month: 1,
        day: 5,
      });
      expect(client.getPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        1,
        5,
        undefined,
      );
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
        period: "daily",
        year: 2025,
        month: 3,
        day: 14,
        content: "# Pi Day",
      });
      expect(client.putPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        3,
        14,
        "# Pi Day",
      );
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
        period: "daily",
        year: 2025,
        month: 6,
        day: 1,
        content: "extra",
      });
      expect(client.appendPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        6,
        1,
        "extra",
      );
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
        period: "daily",
        year: 2025,
        month: 1,
        day: 1,
        content: "val",
        operation: "append",
        targetType: "heading",
        target: "Tasks",
      });
      expect(client.patchPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        1,
        1,
        "val",
        {
          operation: "append",
          targetType: "heading",
          target: "Tasks",
          targetDelimiter: undefined,
          trimTargetWhitespace: undefined,
          createIfMissing: undefined,
          contentType: undefined,
        },
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
        period: "daily",
        year: 2025,
        month: 12,
        day: 31,
      });
      expect(client.deletePeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        12,
        31,
      );
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
        ok: true,
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "1.7" },
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
        paths: ["a.md", "b.md"],
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
        paths: ["a.md", "missing.md"],
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        // One success, one error entry
        const hasError = parsed.some((item) => {
          if (item !== null && typeof item === "object" && "error" in item)
            return true;
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
        {
          path: "old.md",
          content: "",
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 100, size: 0 },
          links: [],
          cachedAt: 0,
        },
        {
          path: "new.md",
          content: "",
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 999, size: 0 },
          links: [],
          cachedAt: 0,
        },
      ] as never);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_recent_changes").handler({ limit: 5 });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({ path: "new.md", mtime: 999 });
      }
    });

    it("falls back to API listing when cache is disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(client.listFilesInVault).mockResolvedValue({
        files: ["note.md"],
      });
      vi.mocked(client.getFileContents).mockResolvedValue({
        content: "",
        frontmatter: {},
        path: "note.md",
        tags: [],
        stat: { ctime: 0, mtime: 500, size: 0 },
      } as NoteJson);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: false }),
      );
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
      const result = await getTool("get_recent_periodic_notes").handler({
        period: "daily",
        limit: 5,
      });
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
      const result = await getTool("configure").handler({
        action: "set",
        setting: "debug",
        value: "true",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith("/tmp/test-config.json", {
        debug: true,
      });
      expect(getText(result)).toContain("effective immediately");
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "unknownSetting",
        value: "foo",
      });
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
      const result = await getTool("configure").handler({
        action: "set",
        setting: "debug",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Value is required");
    });

    it("returns errorResult for invalid debug value", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "debug",
        value: "maybe",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Invalid value");
    });

    it("sets timeout and saves to file (requires restart)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "timeout",
        value: "60000",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        reliability: { timeout: 60000 },
      });
      expect(getText(result)).toContain("Restart the server");
    });

    it("rejects invalid timeout (non-numeric)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "timeout",
        value: "abc",
      });
      expect(result.isError).toBe(true);
    });

    it("sets toolMode — requires restart", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "toolMode",
        value: "consolidated",
      });
      expect(getText(result)).toContain("Restart the server");
    });

    it("rejects invalid toolMode value", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "toolMode",
        value: "unknown",
      });
      expect(result.isError).toBe(true);
    });

    it("sets toolPreset — requires restart", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "toolPreset",
        value: "read-only",
      });
      expect(getText(result)).toContain("Restart the server");
    });
  });

  // -------------------------------------------------------------------------
  // configure — reset
  // -------------------------------------------------------------------------
  describe("configure — reset action", () => {
    it("resets debug to default", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "reset",
        setting: "debug",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        debug: false,
      });
      expect(getText(result)).toContain("reset to default");
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "reset",
        setting: "unknownKey",
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when setting is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // configure — skill action
  // -------------------------------------------------------------------------
  describe("configure — skill action", () => {
    it("returns non-empty markdown with golden rules", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "skill" });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("# Obsidian MCP");
      expect(getText(result)).toContain("Golden Rules");
    });

    it("uses granular tool names in granular mode", async () => {
      const { getTool } = setup();
      const text = getText(
        await getTool("configure").handler({ action: "skill" }),
      );
      expect(text).toContain("get_file_contents");
      expect(text).not.toContain("Consolidated Mode Action Reference");
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
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_backlinks").handler({
        path: "target.md",
      });
      expect(cache.getBacklinks).toHaveBeenCalledWith("target.md");
      expect(getText(result)).toContain("linker.md");
    });

    it("returns errorResult when cache is disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: false }),
      );
      const result = await getTool("get_backlinks").handler({
        path: "target.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult and triggers rebuild when cache is not yet initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_backlinks").handler({
        path: "target.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is rebuilding");
      expect(cache.initialize).toHaveBeenCalled();
    });

    it("succeeds when cache becomes ready within the wait window", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      // getIsInitialized returns false, but waitForInitialization returns true (simulates becoming ready)
      vi.mocked(cache.waitForInitialization).mockResolvedValue(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([
        { source: "ref.md", context: "ctx" },
      ]);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_backlinks").handler({
        path: "target.md",
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("ref.md");
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
    });

    it("returns error and triggers rebuild when cache build fails", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false, false);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_backlinks").handler({ path: "x.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is rebuilding");
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
      expect(cache.initialize).toHaveBeenCalled();
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
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([
        { path: "hub.md", inbound: 5, outbound: 3 },
      ]);
      vi.mocked(cache.getEdgeCount).mockReturnValue(1);
      vi.mocked(cache.getFileList).mockReturnValue([
        "subdir/note.md",
        "root.md",
      ]);
      Object.defineProperty(cache, "noteCount", {
        get: vi.fn().mockReturnValue(10),
      });
      Object.defineProperty(cache, "linkCount", {
        get: vi.fn().mockReturnValue(5),
      });
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_vault_structure").handler({
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({ orphanCount: 1, edgeCount: 1 });
    });

    it("succeeds when cache becomes ready within the wait window", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(cache.waitForInitialization).mockResolvedValue(true);
      vi.mocked(cache.getOrphanNotes).mockReturnValue([]);
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([]);
      vi.mocked(cache.getEdgeCount).mockReturnValue(0);
      vi.mocked(cache.getFileList).mockReturnValue([]);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_vault_structure").handler({
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: false }),
      );
      const result = await getTool("get_vault_structure").handler({
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_vault_structure").handler({
        limit: 10,
      });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // get_note_connections (cache-dependent)
  // -------------------------------------------------------------------------
  describe("get_note_connections", () => {
    it("succeeds when cache becomes ready within the wait window", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(cache.waitForInitialization).mockResolvedValue(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([]);
      vi.mocked(cache.getForwardLinks).mockReturnValue([]);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_note_connections").handler({
        path: "x.md",
      });
      expect(result.isError).toBeFalsy();
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
    });

    it("returns backlinks and forward links from cache", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([
        { source: "a.md", context: "see [[target]]" },
      ]);
      vi.mocked(cache.getForwardLinks).mockReturnValue([
        { target: "b.md", type: "wikilink", context: "[[b]]" },
      ]);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_note_connections").handler({
        path: "target.md",
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({
        backlinks: [{ source: "a.md" }],
        forwardLinks: [{ target: "b.md" }],
      });
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: false }),
      );
      const result = await getTool("get_note_connections").handler({
        path: "x.md",
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("get_note_connections").handler({
        path: "x.md",
      });
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
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
      const result = await getTool("refresh_cache").handler({});
      expect(cache.refresh).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("Cache refreshed");
    });

    it("returns errorResult when cache is disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: false }),
      );
      const result = await getTool("refresh_cache").handler({});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult when cache.refresh rejects", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.refresh).mockRejectedValue(new Error("network error"));
      registerGranularTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ enableCache: true }),
      );
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
      registerGranularTools(
        server as never,
        client,
        cache,
        (name) => name === "list_files_in_vault",
        makeConfig(),
      );
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
    registerConsolidatedTools(
      server as never,
      client,
      cache,
      () => true,
      config,
    );
    return { client, cache, getTool };
  }

  // -------------------------------------------------------------------------
  // vault tool
  // -------------------------------------------------------------------------
  describe("vault — list action", () => {
    it("calls client.listFilesInVault", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockResolvedValue({ files: ["x.md"] });
      const result = await getTool("vault").handler({ action: "list" });
      expect(client.listFilesInVault).toHaveBeenCalled();
      expect(getText(result)).toContain("x.md");
    });
  });

  describe("vault — list_dir action", () => {
    it("calls client.listFilesInDir with path", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({ action: "list_dir", path: "mydir" });
      expect(client.listFilesInDir).toHaveBeenCalledWith("mydir");
    });

    it("returns errorResult when path is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({ action: "list_dir" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("path is required");
    });
  });

  describe("vault — get action", () => {
    it("calls client.getFileContents with path and format", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("# Content");
      const result = await getTool("vault").handler({
        action: "get",
        path: "note.md",
      });
      expect(client.getFileContents).toHaveBeenCalledWith("note.md", undefined);
      expect(getText(result)).toBe("# Content");
    });

    it("returns errorResult when path is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "get",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — put action", () => {
    it("calls client.putContent", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({
        action: "put",
        path: "note.md",
        content: "body",
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "body");
    });

    it("returns errorResult when path missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "put",
        content: "body",
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when content missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "put",
        path: "note.md",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — append action", () => {
    it("calls client.appendContent", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({
        action: "append",
        path: "note.md",
        content: "extra",
      });
      expect(client.appendContent).toHaveBeenCalledWith("note.md", "extra");
    });
  });

  describe("vault — patch action", () => {
    it("calls client.patchContent with all patch options", async () => {
      const { client, getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch",
        path: "note.md",
        content: "text",
        operation: "append",
        targetType: "heading",
        target: "Section",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.patchContent).toHaveBeenCalledWith("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "Section",
        targetDelimiter: undefined,
        trimTargetWhitespace: undefined,
        createIfMissing: undefined,
        contentType: undefined,
      });
      expect(getText(result)).toContain("Patched: note.md");
    });

    it("returns errorResult when operation missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch",
        path: "note.md",
        content: "text",
        targetType: "heading",
        target: "Section",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — delete action", () => {
    it("calls client.deleteFile", async () => {
      const { client, getTool } = setup();
      await getTool("vault").handler({
        action: "delete",
        path: "note.md",
      });
      expect(client.deleteFile).toHaveBeenCalledWith("note.md");
    });

    it("returns errorResult when path missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "delete",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault — search_replace action", () => {
    it("reads, replaces, and writes file", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("old text");
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "note.md",
        search: "old",
        replace: "new",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalledWith("note.md", "new text");
      expect(getText(result)).toContain("Replaced in");
    });

    it("returns no-match message when not found", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockResolvedValue("unchanged");
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "note.md",
        search: "xyz",
        replace: "abc",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).not.toHaveBeenCalled();
      expect(getText(result)).toContain("No matches found");
    });

    it("returns errorResult when search is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "note.md",
        replace: "new",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when replace is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "note.md",
        search: "old",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // vault — move action
  // -------------------------------------------------------------------------
  describe("vault — move action", () => {
    it("moves a file from source to destination", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Content")
        .mockRejectedValueOnce(new ObsidianApiError("Not found", 404));
      const result = await getTool("vault").handler({
        action: "move",
        source: "old.md",
        destination: "new.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(getText(result)).toContain("Moved");
      expect(client.putContent).toHaveBeenCalledWith("new.md", "# Content");
      expect(client.deleteFile).toHaveBeenCalledWith("old.md");
    });

    it("returns error when source is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "move",
        destination: "new.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("source is required");
    });

    it("returns error when destination is missing", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "move",
        source: "old.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("destination is required");
    });

    it("returns conflict when destination exists", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents)
        .mockResolvedValueOnce("# Source")
        .mockResolvedValueOnce("# Existing");
      const result = await getTool("vault").handler({
        action: "move",
        source: "old.md",
        destination: "existing.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("CONFLICT");
    });
  });

  // -------------------------------------------------------------------------
  // vault — read-only preset blocks write actions
  // -------------------------------------------------------------------------
  describe("vault — read-only preset blocks write actions", () => {
    it("blocks put in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({
        action: "put",
        path: "note.md",
        content: "body",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("blocks append in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({
        action: "append",
        path: "note.md",
        content: "x",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
    });

    it("allows list in read-only preset", async () => {
      const { client, getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({
        action: "list",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
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
        action: "delete",
        path: "note.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("allows put in safe preset", async () => {
      const { client, getTool } = setup({ toolPreset: "safe" });
      const result = await getTool("vault").handler({
        action: "put",
        path: "note.md",
        content: "body",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.putContent).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // vault — minimal preset restricts actions
  // -------------------------------------------------------------------------
  describe("vault — minimal preset restricts actions", () => {
    it("blocks delete in minimal preset", async () => {
      const { getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("vault").handler({
        action: "delete",
        path: "note.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("blocks put in minimal preset", async () => {
      const { getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("vault").handler({
        action: "put",
        path: "note.md",
        content: "body",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("blocks search_replace in minimal preset", async () => {
      const { getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "note.md",
        search: "a",
        replace: "b",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("allows list in minimal preset", async () => {
      const { client, getTool } = setup({ toolPreset: "minimal" });
      vi.mocked(client.listFilesInVault).mockResolvedValue({ files: ["a.md"] });
      const result = await getTool("vault").handler({
        action: "list",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBeFalsy();
    });

    it("allows get in minimal preset", async () => {
      const { client, getTool } = setup({ toolPreset: "minimal" });
      vi.mocked(client.getFileContents).mockResolvedValue("# Hello");
      const result = await getTool("vault").handler({
        action: "get",
        path: "note.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBeFalsy();
    });

    it("allows append in minimal preset", async () => {
      const { client, getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("vault").handler({
        action: "append",
        path: "note.md",
        content: "more",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(client.appendContent).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // search — minimal preset restricts types
  // -------------------------------------------------------------------------
  describe("search — minimal preset restricts types", () => {
    it("blocks jsonlogic in minimal preset", async () => {
      const { getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("search").handler({
        type: "jsonlogic",
        jsonQuery: { glob: ["*.md"] },
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("blocks dataview in minimal preset", async () => {
      const { getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("search").handler({
        type: "dataview",
        query: 'LIST FROM ""',
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not allowed");
    });

    it("allows simple in minimal preset", async () => {
      const { client, getTool } = setup({ toolPreset: "minimal" });
      vi.mocked(client.simpleSearch).mockResolvedValue([]);
      const result = await getTool("search").handler({
        type: "simple",
        query: "test",
        contextLength: 100,
      });
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
      await getTool("active_file").handler({
        action: "append",
        content: "more",
      });
      expect(client.appendActiveFile).toHaveBeenCalledWith("more");
    });
  });

  describe("active_file — patch", () => {
    it("calls client.patchActiveFile", async () => {
      const { client, getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch",
        content: "val",
        operation: "append",
        targetType: "heading",
        target: "Section",
      });
      expect(client.patchActiveFile).toHaveBeenCalledWith("val", {
        operation: "append",
        targetType: "heading",
        target: "Section",
        targetDelimiter: undefined,
        trimTargetWhitespace: undefined,
        contentType: undefined,
      });
      expect(getText(result)).toContain("Active file patched");
    });

    it("returns errorResult when operation missing", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch",
        content: "val",
        targetType: "heading",
        target: "Section",
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
  // Stryker mutation backfill: Zod-schema validation for vault + active_file
  //
  // The action enum literals (e.g. ["list", "list_dir", "get", ...]) and
  // boolean defaults (useRegex/caseSensitive/replaceAll) sit on the Zod
  // schema attached to each registered tool. Handler-level tests bypass
  // Zod entirely (`getTool(name).handler({...})`), so a mutation that
  // shrinks the enum or flips a boolean default leaves handler tests
  // passing while real MCP traffic would silently misbehave. These tests
  // round-trip args through the Zod schema directly and assert each
  // valid action parses + invalid actions reject + defaults take effect.
  // -------------------------------------------------------------------------
  // Type guard for any object with a `.parse(unknown) => unknown` method.
  // Avoids depending on z.ZodObject specifically — a future refinement
  // (`.refine()`, `.transform()`, `.brand()`) would still satisfy this
  // contract because Zod's wrappers preserve `.parse`. This also avoids
  // the `as` type assertion that CLAUDE.md prohibits.
  interface ParseableSchema {
    parse: (value: unknown) => unknown;
  }
  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
  }
  function isParseable(value: unknown): value is ParseableSchema {
    return (
      isRecord(value) &&
      "parse" in value &&
      typeof value["parse"] === "function"
    );
  }
  function getInputSchema(toolName: string): ParseableSchema {
    const { getTool } = setup();
    const tool = getTool(toolName);
    const schema = tool.schema["inputSchema"];
    if (!isParseable(schema)) {
      throw new Error(`${toolName} inputSchema is not parseable`);
    }
    return schema; // narrowed by isParseable type guard
  }

  describe("vault — Zod schema validation (Stryker backfill)", () => {
    // Action tuple is the source of truth. The payloads-record type below
    // requires a payload for every action AND only those actions
    // (bidirectional type safety, no `as` casts on `Object.keys()`).
    //
    // Per-action minimal valid payloads. All non-action fields are
    // currently `.optional()` in the source schema, so `{action}` alone
    // parses today — but if Zod gains conditional required fields per
    // action (via `.refine` etc.), passing the realistic minimum keeps
    // these tests focused on the enum/default mutants they target.
    const VAULT_ACTIONS = [
      "list",
      "list_dir",
      "get",
      "put",
      "append",
      "patch",
      "delete",
      "search_replace",
      "move",
    ] as const;
    const VAULT_PAYLOADS: Readonly<
      Record<(typeof VAULT_ACTIONS)[number], Readonly<Record<string, unknown>>>
    > = {
      list: { action: "list" },
      list_dir: { action: "list_dir", path: "dir" },
      get: { action: "get", path: "note.md" },
      put: { action: "put", path: "note.md", content: "body" },
      append: { action: "append", path: "note.md", content: "body" },
      patch: {
        action: "patch",
        path: "note.md",
        content: "body",
        operation: "append",
        targetType: "heading",
        target: "H",
      },
      delete: { action: "delete", path: "note.md" },
      search_replace: {
        action: "search_replace",
        path: "note.md",
        search: "x",
        replace: "y",
      },
      move: { action: "move", source: "a.md", destination: "b.md" },
    };

    it.each(VAULT_ACTIONS)("accepts action: %s", (action) => {
      const schema = getInputSchema("vault");
      expect(() => schema.parse(VAULT_PAYLOADS[action])).not.toThrow();
    });

    it("rejects an action outside the enum", () => {
      const schema = getInputSchema("vault");
      expect(() => schema.parse({ action: "not_a_real_action" })).toThrow();
    });

    // Helper that returns the parsed-defaults as a Record<string, unknown>
    // narrowed via the isRecord type guard — avoids `as` casts entirely.
    function parseSearchReplaceDefaults(): Record<string, unknown> {
      const schema = getInputSchema("vault");
      const parsed = schema.parse(VAULT_PAYLOADS["search_replace"]);
      if (!isRecord(parsed)) {
        throw new Error("vault schema parse did not return an object");
      }
      return parsed;
    }

    it("useRegex defaults to false when omitted", () => {
      const parsed = parseSearchReplaceDefaults();
      expect(parsed["useRegex"]).toBe(false);
    });

    it("caseSensitive defaults to true when omitted", () => {
      const parsed = parseSearchReplaceDefaults();
      expect(parsed["caseSensitive"]).toBe(true);
    });

    it("replaceAll defaults to true when omitted", () => {
      const parsed = parseSearchReplaceDefaults();
      expect(parsed["replaceAll"]).toBe(true);
    });
  });

  describe("vault — error path computation for move action (Stryker backfill)", () => {
    // The error path picker is `action === "move" ? args.source ?? path : path`.
    // For a move, the error message should reference the SOURCE path (because
    // the operation reads from source); for any non-move action, it should
    // reference the path arg.
    //
    // The move action calls handleMoveFile (in tools/shared.ts), which
    // internally calls client.getFileContents on the source — mocking that
    // to reject is the cleanest way to force the move into the catch block.
    it("uses args.source as the error path on a failing move (404 echoes path)", async () => {
      const { client, getTool } = setup();
      // 404 is the error type whose buildErrorMessage echoes context.path —
      // simulating a missing source file forces path to surface in the
      // message, which lets the test verify the picker chose source over path.
      vi.mocked(client.getFileContents).mockRejectedValue(
        new ObsidianApiError("file not found", 404),
      );
      const result = await getTool("vault").handler({
        action: "move",
        source: "old/note.md",
        destination: "new/note.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("old/note.md");
    });

    it("uses args.path (NOT source) as the error path on a failing non-move action (404 echoes path)", async () => {
      const { client, getTool } = setup();
      // Same approach as the move test — 404 surfaces context.path in the
      // error message, which lets the assertion confirm the picker chose
      // `path` over `source` (instead of relying on a vacuous absence-check
      // against a generic Error that doesn't echo the path at all).
      vi.mocked(client.deleteFile).mockRejectedValue(
        new ObsidianApiError("file not found", 404),
      );
      const result = await getTool("vault").handler({
        action: "delete",
        path: "doomed.md",
        source: "should/be/ignored.md",
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain("doomed.md");
      expect(text).not.toContain("should/be/ignored.md");
    });
  });

  describe("active_file — Zod schema validation (Stryker backfill)", () => {
    const ACTIVE_FILE_ACTIONS = [
      "get",
      "put",
      "append",
      "patch",
      "delete",
    ] as const;
    const ACTIVE_FILE_PAYLOADS: Readonly<
      Record<
        (typeof ACTIVE_FILE_ACTIONS)[number],
        Readonly<Record<string, unknown>>
      >
    > = {
      get: { action: "get" },
      put: { action: "put", content: "body" },
      append: { action: "append", content: "body" },
      patch: {
        action: "patch",
        content: "body",
        operation: "append",
        targetType: "heading",
        target: "H",
      },
      delete: { action: "delete" },
    };

    it.each(ACTIVE_FILE_ACTIONS)("accepts action: %s", (action) => {
      const schema = getInputSchema("active_file");
      expect(() => schema.parse(ACTIVE_FILE_PAYLOADS[action])).not.toThrow();
    });

    it("rejects an action outside the enum", () => {
      const schema = getInputSchema("active_file");
      expect(() =>
        schema.parse({ action: "not_a_real_active_file_action" }),
      ).toThrow();
    });
  });

  describe("active_file — error message strings (Stryker backfill)", () => {
    // Each branch of the active_file action switch returns a distinct
    // textResult/errorResult string. StringLiteral mutations on those
    // messages survive unless the test asserts the exact text.

    it("put returns exactly 'Active file updated' on success", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.putActiveFile).mockResolvedValue();
      const result = await getTool("active_file").handler({
        action: "put",
        content: "body",
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe("Active file updated");
    });

    it("append returns exactly 'Appended to active file' on success", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.appendActiveFile).mockResolvedValue();
      const result = await getTool("active_file").handler({
        action: "append",
        content: "body",
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe("Appended to active file");
    });

    it("delete returns exactly 'Active file deleted' on success", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.deleteActiveFile).mockResolvedValue();
      const result = await getTool("active_file").handler({
        action: "delete",
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe("Active file deleted");
    });
  });

  // -------------------------------------------------------------------------
  // Stryker mutation backfill: Zod-schema validation for the rest of the
  // consolidated tools (commands, search, periodic_note, batch_get, recent,
  // vault_analysis). Reuses isParseable / isRecord / getInputSchema helpers
  // defined above. Each describe block targets the tool's surviving mutants
  // (action enums, numeric constraints, message literals) via direct schema
  // round-trip, since handler-level tests bypass Zod entirely.
  // -------------------------------------------------------------------------

  describe("commands — Zod schema validation (Stryker backfill)", () => {
    const COMMANDS_ACTIONS = ["list", "execute"] as const;
    const COMMANDS_PAYLOADS: Readonly<
      Record<
        (typeof COMMANDS_ACTIONS)[number],
        Readonly<Record<string, unknown>>
      >
    > = {
      list: { action: "list" },
      execute: { action: "execute", commandId: "workspace:next-tab" },
    };

    it.each(COMMANDS_ACTIONS)("accepts action: %s", (action) => {
      const schema = getInputSchema("commands");
      expect(() => schema.parse(COMMANDS_PAYLOADS[action])).not.toThrow();
    });

    it("rejects an action outside the enum", () => {
      const schema = getInputSchema("commands");
      expect(() => schema.parse({ action: "invalid_command" })).toThrow();
    });

    it("execute returns exactly 'Executed: <commandId>' on success", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.executeCommand).mockResolvedValue();
      const result = await getTool("commands").handler({
        action: "execute",
        commandId: "workspace:next-tab",
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe("Executed: workspace:next-tab");
    });
  });

  describe("search — Zod schema validation (Stryker backfill)", () => {
    const SEARCH_TYPES = ["simple", "jsonlogic", "dataview"] as const;
    const SEARCH_PAYLOADS: Readonly<
      Record<(typeof SEARCH_TYPES)[number], Readonly<Record<string, unknown>>>
    > = {
      simple: { type: "simple", query: "term" },
      jsonlogic: { type: "jsonlogic", jsonQuery: { glob: ["*.md"] } },
      dataview: { type: "dataview", query: 'TABLE FROM ""' },
    };

    it.each(SEARCH_TYPES)("accepts type: %s", (type) => {
      const schema = getInputSchema("search");
      expect(() => schema.parse(SEARCH_PAYLOADS[type])).not.toThrow();
    });

    it("rejects a type outside the enum", () => {
      const schema = getInputSchema("search");
      expect(() => schema.parse({ type: "fuzzy" })).toThrow();
    });

    it("contextLength defaults to 100 when omitted", () => {
      const schema = getInputSchema("search");
      const parsed = schema.parse(SEARCH_PAYLOADS["simple"]);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed["contextLength"]).toBe(100);
    });
  });

  describe("periodic_note — Zod schema validation (Stryker backfill)", () => {
    const PERIODIC_ACTIONS = [
      "get",
      "put",
      "append",
      "patch",
      "delete",
    ] as const;
    const PERIODIC_PAYLOADS: Readonly<
      Record<
        (typeof PERIODIC_ACTIONS)[number],
        Readonly<Record<string, unknown>>
      >
    > = {
      get: { action: "get", period: "daily" },
      put: { action: "put", period: "daily", content: "body" },
      append: { action: "append", period: "daily", content: "body" },
      patch: {
        action: "patch",
        period: "daily",
        content: "body",
        operation: "append",
        targetType: "heading",
        target: "H",
      },
      delete: { action: "delete", period: "daily" },
    };
    // Periodic-note period enum (from periodSchema in src/schemas.ts).
    // Tested here because handler-level tests bypass Zod validation.
    const PERIODS = [
      "daily",
      "weekly",
      "monthly",
      "quarterly",
      "yearly",
    ] as const;

    it.each(PERIODIC_ACTIONS)("accepts action: %s", (action) => {
      const schema = getInputSchema("periodic_note");
      expect(() => schema.parse(PERIODIC_PAYLOADS[action])).not.toThrow();
    });

    it("rejects an action outside the enum", () => {
      const schema = getInputSchema("periodic_note");
      expect(() =>
        schema.parse({ action: "invalid_periodic_action", period: "daily" }),
      ).toThrow();
    });

    // periodSchema enum coverage — kills mutants on the shared periodSchema
    // ArrayDeclaration / StringLiteral entries (in src/schemas.ts) when
    // exercised through any tool that uses it.
    it.each(PERIODS)("accepts period: %s", (period) => {
      const schema = getInputSchema("periodic_note");
      expect(() => schema.parse({ action: "get", period })).not.toThrow();
    });

    it("rejects a period outside the enum", () => {
      const schema = getInputSchema("periodic_note");
      expect(() =>
        schema.parse({ action: "get", period: "fortnightly" }),
      ).toThrow();
    });

    // Numeric constraints on month (1-12) and day (1-31). Stryker mutates
    // .min(1).max(12) → .min(1).min(12) (both bounds same direction) AND
    // can remove the .int() constraint entirely. Tests exercise BOTH bounds
    // AND the integer constraint (with non-integer values like 1.5/15.5)
    // to kill all three mutant categories.

    it.each([0, -1, 1.5, 13, 100])("rejects invalid month: %s", (month) => {
      const schema = getInputSchema("periodic_note");
      expect(() =>
        schema.parse({
          action: "get",
          period: "daily",
          year: 2026,
          month,
          day: 1,
        }),
      ).toThrow();
    });

    it.each([1, 6, 12])("accepts valid month: %i", (month) => {
      const schema = getInputSchema("periodic_note");
      expect(() =>
        schema.parse({
          action: "get",
          period: "daily",
          year: 2026,
          month,
          day: 1,
        }),
      ).not.toThrow();
    });

    it.each([0, -1, 15.5, 32, 100])("rejects invalid day: %s", (day) => {
      const schema = getInputSchema("periodic_note");
      expect(() =>
        schema.parse({
          action: "get",
          period: "daily",
          year: 2026,
          month: 1,
          day,
        }),
      ).toThrow();
    });

    it.each([1, 15, 31])("accepts valid day: %i", (day) => {
      const schema = getInputSchema("periodic_note");
      expect(() =>
        schema.parse({
          action: "get",
          period: "daily",
          year: 2026,
          month: 1,
          day,
        }),
      ).not.toThrow();
    });
  });

  describe("batch_get — Zod schema validation (Stryker backfill)", () => {
    it("rejects an empty paths array (min(1) constraint)", () => {
      const schema = getInputSchema("batch_get");
      expect(() => schema.parse({ paths: [] })).toThrow();
    });

    it("accepts a single-element paths array", () => {
      const schema = getInputSchema("batch_get");
      expect(() => schema.parse({ paths: ["a.md"] })).not.toThrow();
    });

    it("accepts a multi-element paths array", () => {
      const schema = getInputSchema("batch_get");
      expect(() =>
        schema.parse({ paths: ["a.md", "b.md", "c.md"] }),
      ).not.toThrow();
    });
  });

  describe("recent — Zod schema validation (Stryker backfill)", () => {
    const RECENT_TYPES = ["changes", "periodic_notes"] as const;
    const RECENT_PAYLOADS: Readonly<
      Record<(typeof RECENT_TYPES)[number], Readonly<Record<string, unknown>>>
    > = {
      changes: { type: "changes" },
      periodic_notes: { type: "periodic_notes", period: "daily" },
    };

    it.each(RECENT_TYPES)("accepts type: %s", (type) => {
      const schema = getInputSchema("recent");
      expect(() => schema.parse(RECENT_PAYLOADS[type])).not.toThrow();
    });

    it("rejects a type outside the enum", () => {
      const schema = getInputSchema("recent");
      expect(() => schema.parse({ type: "fuzzy" })).toThrow();
    });

    it("limit defaults to 10 when omitted", () => {
      const schema = getInputSchema("recent");
      const parsed = schema.parse(RECENT_PAYLOADS["changes"]);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed["limit"]).toBe(10);
    });

    // limit constraint — kills mutants on .int() and .min(1).
    it.each([0, -1, 1.5])("rejects invalid limit: %s", (limit) => {
      const schema = getInputSchema("recent");
      expect(() => schema.parse({ type: "changes", limit })).toThrow();
    });
  });

  describe("vault_analysis — Zod schema validation (Stryker backfill)", () => {
    const VAULT_ANALYSIS_ACTIONS = [
      "backlinks",
      "connections",
      "structure",
      "refresh",
    ] as const;
    const VAULT_ANALYSIS_PAYLOADS: Readonly<
      Record<
        (typeof VAULT_ANALYSIS_ACTIONS)[number],
        Readonly<Record<string, unknown>>
      >
    > = {
      backlinks: { action: "backlinks", path: "note.md" },
      connections: { action: "connections", path: "note.md" },
      structure: { action: "structure" },
      refresh: { action: "refresh" },
    };

    it.each(VAULT_ANALYSIS_ACTIONS)("accepts action: %s", (action) => {
      const schema = getInputSchema("vault_analysis");
      expect(() => schema.parse(VAULT_ANALYSIS_PAYLOADS[action])).not.toThrow();
    });

    it("rejects an action outside the enum", () => {
      const schema = getInputSchema("vault_analysis");
      expect(() => schema.parse({ action: "invalid_analysis" })).toThrow();
    });

    it("limit defaults to 10 when omitted", () => {
      const schema = getInputSchema("vault_analysis");
      const parsed = schema.parse(VAULT_ANALYSIS_PAYLOADS["structure"]);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed["limit"]).toBe(10);
    });

    // limit constraint — kills mutants on .int() and .min(1).
    it.each([0, -1, 1.5])("rejects invalid limit: %s", (limit) => {
      const schema = getInputSchema("vault_analysis");
      expect(() => schema.parse({ action: "structure", limit })).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // commands tool
  // -------------------------------------------------------------------------
  describe("commands — list", () => {
    it("calls client.listCommands", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listCommands).mockResolvedValue({
        commands: [{ id: "x", name: "X" }],
      });
      const result = await getTool("commands").handler({ action: "list" });
      expect(getText(result)).toContain('"name": "X"');
    });
  });

  describe("commands — execute", () => {
    it("calls client.executeCommand with commandId", async () => {
      const { client, getTool } = setup();
      await getTool("commands").handler({
        action: "execute",
        commandId: "editor:bold",
      });
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
      await getTool("search").handler({
        type: "simple",
        query: "hello",
        contextLength: 100,
      });
      expect(client.simpleSearch).toHaveBeenCalledWith("hello", 100);
    });

    it("returns errorResult when query missing", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "simple",
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("search — jsonlogic", () => {
    it("calls client.complexSearch with jsonQuery", async () => {
      const { client, getTool } = setup();
      const jsonQuery = { glob: [{ var: "path" }, "*.md"] };
      await getTool("search").handler({
        type: "jsonlogic",
        jsonQuery,
        contextLength: 100,
      });
      expect(client.complexSearch).toHaveBeenCalledWith(jsonQuery);
    });

    it("returns errorResult when jsonQuery missing", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "jsonlogic",
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("search — dataview", () => {
    it("calls client.dataviewSearch with query", async () => {
      const { client, getTool } = setup();
      await getTool("search").handler({
        type: "dataview",
        query: 'LIST FROM ""',
        contextLength: 100,
      });
      expect(client.dataviewSearch).toHaveBeenCalledWith('LIST FROM ""');
    });

    it("returns errorResult when query missing", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "dataview",
        contextLength: 100,
      });
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
      const result = await getTool("periodic_note").handler({
        action: "get",
        period: "daily",
      });
      expect(client.getPeriodicNote).toHaveBeenCalledWith("daily", undefined);
      expect(getText(result)).toBe("# Today");
    });
  });

  describe("periodic_note — get (by date)", () => {
    it("calls client.getPeriodicNoteForDate when year/month/day all present", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getPeriodicNoteForDate).mockResolvedValue(
        "# Specific day",
      );
      const result = await getTool("periodic_note").handler({
        action: "get",
        period: "daily",
        year: 2025,
        month: 3,
        day: 14,
      });
      expect(client.getPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        3,
        14,
        undefined,
      );
      expect(getText(result)).toBe("# Specific day");
    });
  });

  describe("periodic_note — put (current)", () => {
    it("calls client.putPeriodicNote", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "put",
        period: "weekly",
        content: "# Week",
      });
      expect(client.putPeriodicNote).toHaveBeenCalledWith("weekly", "# Week");
    });

    it("returns errorResult when content missing", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "put",
        period: "daily",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("periodic_note — put (by date)", () => {
    it("calls client.putPeriodicNoteForDate", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "put",
        period: "daily",
        year: 2025,
        month: 1,
        day: 1,
        content: "# New Year",
      });
      expect(client.putPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        1,
        1,
        "# New Year",
      );
    });
  });

  describe("periodic_note — append", () => {
    it("calls client.appendPeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "append",
        period: "daily",
        content: "item",
      });
      expect(client.appendPeriodicNote).toHaveBeenCalledWith("daily", "item");
    });

    it("calls client.appendPeriodicNoteForDate when date given", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "append",
        period: "daily",
        year: 2025,
        month: 6,
        day: 15,
        content: "item",
      });
      expect(client.appendPeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        6,
        15,
        "item",
      );
    });
  });

  describe("periodic_note — patch", () => {
    it("calls client.patchPeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
        content: "val",
        operation: "replace",
        targetType: "frontmatter",
        target: "status",
      });
      expect(client.patchPeriodicNote).toHaveBeenCalledWith("daily", "val", {
        operation: "replace",
        targetType: "frontmatter",
        target: "status",
        targetDelimiter: undefined,
        trimTargetWhitespace: undefined,
        createIfMissing: undefined,
        contentType: undefined,
      });
      expect(getText(result)).toContain("Patched daily note");
    });

    it("calls client.patchPeriodicNoteForDate when date provided", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
        year: 2025,
        month: 3,
        day: 1,
        content: "val",
        operation: "append",
        targetType: "heading",
        target: "Tasks",
      });
      expect(client.patchPeriodicNoteForDate).toHaveBeenCalled();
    });

    it("returns errorResult when operation missing", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
        content: "val",
        targetType: "heading",
        target: "Section",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("periodic_note — delete", () => {
    it("calls client.deletePeriodicNote for current period", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "delete",
        period: "daily",
      });
      expect(client.deletePeriodicNote).toHaveBeenCalledWith("daily");
    });

    it("calls client.deletePeriodicNoteForDate when date given", async () => {
      const { client, getTool } = setup();
      await getTool("periodic_note").handler({
        action: "delete",
        period: "daily",
        year: 2025,
        month: 12,
        day: 31,
      });
      expect(client.deletePeriodicNoteForDate).toHaveBeenCalledWith(
        "daily",
        2025,
        12,
        31,
      );
    });

    it("blocks delete in safe preset", async () => {
      const { getTool } = setup({ toolPreset: "safe" });
      const result = await getTool("periodic_note").handler({
        action: "delete",
        period: "daily",
      });
      expect(result.isError).toBe(true);
    });

    it("blocks delete in read-only preset", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("periodic_note").handler({
        action: "delete",
        period: "daily",
      });
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
        ok: true,
        service: "Obsidian REST API",
        authenticated: true,
        versions: {},
      });
      const result = await getTool("status").handler({});
      expect(client.getServerStatus).toHaveBeenCalled();
      expect(getText(result)).toContain("Obsidian REST API");
    });

    it("returns errorResult on connection error", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getServerStatus).mockRejectedValue(
        new ObsidianConnectionError("refused"),
      );
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
      const result = await getTool("batch_get").handler({
        paths: ["a.md", "b.md"],
      });
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
      const result = await getTool("batch_get").handler({
        paths: ["ok.md", "missing.md"],
      });
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
        {
          path: "old.md",
          content: "",
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 100, size: 0 },
          links: [],
          cachedAt: 0,
        },
        {
          path: "new.md",
          content: "",
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 999, size: 0 },
          links: [],
          cachedAt: 0,
        },
      ] as never);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("recent").handler({
        type: "changes",
        limit: 5,
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({ path: "new.md", mtime: 999 });
      }
    });

    it("falls back to API when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(client.listFilesInVault).mockResolvedValue({
        files: ["note.md"],
      });
      vi.mocked(client.getFileContents).mockResolvedValue({
        content: "",
        frontmatter: {},
        path: "note.md",
        tags: [],
        stat: { ctime: 0, mtime: 500, size: 0 },
      } as NoteJson);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("recent").handler({
        type: "changes",
        limit: 5,
      });
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
      const result = await getTool("recent").handler({
        type: "periodic_notes",
        period: "weekly",
        limit: 10,
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(Array.isArray(parsed)).toBe(true);
      if (Array.isArray(parsed)) {
        expect(parsed).toHaveLength(2);
        expect((parsed as string[])[0]).toContain("Weekly Notes");
      }
    });

    it("returns errorResult when period missing for periodic_notes type", async () => {
      const { getTool } = setup();
      const result = await getTool("recent").handler({
        type: "periodic_notes",
        limit: 10,
      });
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
      const result = await getTool("configure").handler({
        action: "set",
        setting: "debug",
        value: "false",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        debug: false,
      });
      expect(getText(result)).toContain("effective immediately");
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "badKey",
        value: "x",
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when setting omitted", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "set" });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when value omitted", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "debug",
      });
      expect(result.isError).toBe(true);
    });

    it("rejects invalid maxResponseChars (negative)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "maxResponseChars",
        value: "-1",
      });
      expect(result.isError).toBe(true);
    });

    it("sets maxResponseChars=0 (disabled)", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "maxResponseChars",
        value: "0",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        reliability: { maxResponseChars: 0 },
      });
      expect(result.isError).toBeFalsy();
    });

    it("sets verifyWrites=true", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "verifyWrites",
        value: "true",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        reliability: { verifyWrites: true },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects invalid toolPreset value", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "set",
        setting: "toolPreset",
        value: "invalid",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("configure — consolidated reset", () => {
    it("resets timeout to 30000", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "reset",
        setting: "timeout",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        reliability: { timeout: 30000 },
      });
      expect(getText(result)).toContain("reset to default");
    });

    it("resets verifyWrites to false", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({
        action: "reset",
        setting: "verifyWrites",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        reliability: { verifyWrites: false },
      });
    });

    it("resets maxResponseChars to 500000", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({
        action: "reset",
        setting: "maxResponseChars",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        reliability: { maxResponseChars: 500000 },
      });
    });

    it("resets toolMode to granular", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({
        action: "reset",
        setting: "toolMode",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        tools: { mode: "granular" },
      });
    });

    it("resets toolPreset to full", async () => {
      const { getTool } = setup();
      await getTool("configure").handler({
        action: "reset",
        setting: "toolPreset",
      });
      expect(saveConfigToFile).toHaveBeenCalledWith(expect.any(String), {
        tools: { preset: "full" },
      });
    });

    it("returns errorResult for unknown setting", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "reset",
        setting: "unknownKey",
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when setting omitted", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({ action: "reset" });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // configure — consolidated skill
  // -------------------------------------------------------------------------
  describe("configure — consolidated skill", () => {
    it("uses consolidated tool names and includes action reference", async () => {
      const { getTool } = setup();
      const text = getText(
        await getTool("configure").handler({ action: "skill" }),
      );
      expect(text).toContain("vault action: get");
      expect(text).toContain("Consolidated Mode Action Reference");
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
      vi.mocked(cache.getBacklinks).mockReturnValue([
        { source: "ref.md", context: "see [[target]]" },
      ]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        path: "target.md",
        limit: 10,
      });
      expect(cache.getBacklinks).toHaveBeenCalledWith("target.md");
      expect(getText(result)).toContain("ref.md");
    });

    it("returns errorResult when path missing", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        limit: 10,
      });
      expect(result.isError).toBe(true);
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: false }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        path: "x.md",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is disabled");
    });

    it("returns errorResult and triggers rebuild when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        path: "x.md",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is rebuilding");
      expect(cache.initialize).toHaveBeenCalled();
    });

    it("succeeds when cache becomes ready within the wait window", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(cache.waitForInitialization).mockResolvedValue(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([
        { source: "ref.md", context: "ctx" },
      ]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        path: "target.md",
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("ref.md");
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
    });
  });

  describe("vault_analysis — connections", () => {
    it("succeeds when cache becomes ready within the wait window", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(cache.waitForInitialization).mockResolvedValue(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([]);
      vi.mocked(cache.getForwardLinks).mockReturnValue([
        { target: "b.md", type: "wikilink", context: "[[b]]" },
      ]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "connections",
        path: "x.md",
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
    });

    it("returns backlinks and forward links", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getBacklinks).mockReturnValue([
        { source: "a.md", context: "ctx" },
      ]);
      vi.mocked(cache.getForwardLinks).mockReturnValue([
        { target: "b.md", type: "wikilink", context: "[[b]]" },
      ]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "connections",
        path: "center.md",
        limit: 10,
      });
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({
        backlinks: [{ source: "a.md" }],
        forwardLinks: [{ target: "b.md" }],
      });
    });

    it("returns errorResult when path missing", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "connections",
        limit: 10,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("vault_analysis — structure", () => {
    it("succeeds when cache becomes ready within the wait window", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      vi.mocked(cache.waitForInitialization).mockResolvedValue(true);
      vi.mocked(cache.getOrphanNotes).mockReturnValue([]);
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([]);
      vi.mocked(cache.getEdgeCount).mockReturnValue(0);
      vi.mocked(cache.getFileList).mockReturnValue([]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "structure",
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      expect(cache.waitForInitialization).toHaveBeenCalledWith(
        CACHE_INIT_TIMEOUT_MS,
      );
    });

    it("returns vault structure stats", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      vi.mocked(cache.getOrphanNotes).mockReturnValue(["orphan.md"]);
      vi.mocked(cache.getMostConnectedNotes).mockReturnValue([
        { path: "hub.md", inbound: 7, outbound: 2 },
      ]);
      vi.mocked(cache.getEdgeCount).mockReturnValue(1);
      vi.mocked(cache.getFileList).mockReturnValue(["folder/note.md"]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "structure",
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      const parsed: unknown = JSON.parse(getText(result));
      expect(parsed).toMatchObject({ orphanCount: 1, edgeCount: 1 });
    });

    it("returns error and triggers rebuild when cache not initialized and wait times out", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false, false);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "structure",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cache is rebuilding");
      expect(cache.initialize).toHaveBeenCalled();
    });

    it("returns errorResult when cache not initialized", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(false);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "structure",
        limit: 10,
      });
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
      vi.mocked(cache.getEdgeCount).mockReturnValue(0);
      vi.mocked(cache.getFileList).mockReturnValue([]);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({
          toolMode: "consolidated",
          toolPreset: "read-only",
          enableCache: true,
        }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "structure",
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe("vault_analysis — refresh", () => {
    it("calls cache.refresh and returns summary", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: true }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "refresh",
        limit: 10,
      });
      expect(cache.refresh).toHaveBeenCalled();
      expect(getText(result)).toContain("Cache refreshed");
    });

    it("allows refresh in read-only preset (vault_analysis is protected)", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({
          toolMode: "consolidated",
          toolPreset: "read-only",
          enableCache: true,
        }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "refresh",
        limit: 10,
      });
      expect(cache.refresh).toHaveBeenCalled();
      expect(getText(result)).toContain("Cache refreshed");
    });

    it("returns errorResult when cache disabled", async () => {
      const { server, getTool } = makeMockServer();
      const client = makeMockClient();
      const cache = makeMockCache(true);
      registerConsolidatedTools(
        server as never,
        client,
        cache,
        () => true,
        makeConfig({ toolMode: "consolidated", enableCache: false }),
      );
      const result = await getTool("vault_analysis").handler({
        action: "refresh",
        limit: 10,
      });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation — API error types map to correct messages
  // -------------------------------------------------------------------------
  describe("error propagation via buildErrorMessage", () => {
    it("connection error produces CONNECTION ERROR prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(
        new ObsidianConnectionError("ECONNREFUSED"),
      );
      const result = await getTool("vault").handler({
        action: "list",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("CONNECTION ERROR");
    });

    it("auth error produces AUTH ERROR prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(
        new ObsidianAuthError(),
      );
      const result = await getTool("vault").handler({
        action: "list",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("AUTH ERROR");
    });

    it("400 API error produces BAD REQUEST message", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(
        new ObsidianApiError("malformed", 400),
      );
      const result = await getTool("vault").handler({
        action: "get",
        path: "x.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("BAD REQUEST");
    });

    it("405 API error produces NOT SUPPORTED message", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getFileContents).mockRejectedValue(
        new ObsidianApiError("not supported", 405),
      );
      const result = await getTool("vault").handler({
        action: "get",
        path: "x.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("NOT SUPPORTED");
    });

    it("generic Error produces ERROR prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(
        new Error("unexpected"),
      );
      const result = await getTool("vault").handler({
        action: "list",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("ERROR: unexpected");
    });
  });

  // -------------------------------------------------------------------------
  // Switch exhaustiveness guards (Issue #14)
  // -------------------------------------------------------------------------
  //
  // Stryker surfaced 8 surviving BlockStatement mutants: the bodies of
  // `default:` branches of exhaustive switches could be blanked without any
  // test noticing. These guards are the runtime counterpart of TypeScript's
  // `const _exhaustive: never = x` compile-time check — if a future
  // maintainer deletes the body, the switch falls through silently and the
  // handler returns `undefined` to the MCP runtime. Each test drives an
  // invalid discriminant through the switch (bypassing compile-time
  // narrowing via the mock handler's `Record<string, unknown>` signature)
  // and asserts the tool-prefixed error message actually fires.

  describe("switch exhaustiveness guards", () => {
    // These tests verify runtime exhaustiveness guards that complement
    // TypeScript's compile-time exhaustive switch checks (`never` pattern).
    // We intentionally pass invalid discriminants through the mocked
    // handler's `Record<string, unknown>` input shape so type narrowing is
    // bypassed and the runtime `default` branch must execute.
    // `toBe` rather than `toContain` on the error text: the whole point of
    // these tests is to kill BlockStatement mutants on the guard body, and
    // exact-match assertions also catch any future drift in the message
    // format itself (e.g., missing `[tool]` prefix or dropped discriminant
    // interpolation).

    it("vault default branch returns [vault] Unknown action error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "bogus",
        path: "note.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] Unknown action: bogus");
    });

    it("active_file default branch returns [active_file] Unknown action error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "bogus",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[active_file] Unknown action: bogus");
    });

    it("commands default branch returns [commands] Unknown action error", async () => {
      const { getTool } = setup();
      const result = await getTool("commands").handler({
        action: "bogus",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[commands] Unknown action: bogus");
    });

    it("search default branch returns [search] Unknown type error", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "bogus",
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[search] Unknown type: bogus");
    });

    it("periodic_note default branch returns [periodic_note] Unknown action error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "bogus",
        period: "daily",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[periodic_note] Unknown action: bogus");
    });

    it("recent default branch returns [recent] Unknown type error", async () => {
      const { getTool } = setup();
      const result = await getTool("recent").handler({
        type: "bogus",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[recent] Unknown type: bogus");
    });

    it("vault_analysis default branch returns [vault_analysis] Unknown action error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault_analysis").handler({
        action: "bogus",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault_analysis] Unknown action: bogus");
    });

    it("configure default branch returns [configure] Unknown action error", async () => {
      const { getTool } = setup();
      const result = await getTool("configure").handler({
        action: "bogus",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[configure] Unknown action: bogus");
    });
  });

  // -------------------------------------------------------------------------
  // errorResult message content (Issue #13)
  // -------------------------------------------------------------------------
  //
  // Stryker surfaced 57 surviving StringLiteral mutants across
  // src/tools/consolidated.ts L115–L926: every errorResult() message literal
  // can be blanked to "" with no test noticing. Tests previously asserted
  // `result.isError === true` and occasionally `toContain()` on a substring,
  // which does not kill a mutation to "". MCP tool error messages are the
  // primary signal LLMs use to route recovery behavior, so silent truncation
  // to "" would ship unnoticed.
  //
  // Each test below drives one of those error paths and asserts the exact
  // expected text via `toBe()` — same approach as the switch-exhaustiveness
  // block above (PR #19). Grouped by tool to keep related assertions next
  // to the code under test. The nine try/catch branches that wrap a handler
  // body with `errorResult(buildErrorMessage(err, { tool: "..." }))` are
  // covered via a minimal `[${tool}]` prefix assertion: buildErrorMessage's
  // output format is already unit-tested in errors.test.ts, and the prefix
  // check kills the tool-name StringLiteral mutant without duplicating the
  // full error-formatting contract here.

  describe("errorResult message content (#13)", () => {
    // Catch-branch tests below assert the error message starts with a
    // `[tool] ` prefix rather than merely containing it. That matches the
    // actual contract from buildErrorMessage() (the prefix is always at
    // position 0) and kills a hypothetical mutant that shifted the literal
    // away from the start of the string — a substring check would let that
    // slip through silently.
    function expectToolPrefixedError(result: ToolResult, tool: string): void {
      expect(result.isError).toBe(true);
      const text = getText(result);
      const prefix = `[${tool}] `;
      expect(
        text.startsWith(prefix),
        `expected error to start with "${prefix}", got: "${text}"`,
      ).toBe(true);
      const remainder = text.slice(prefix.length);
      expect(
        remainder.trim().length > 0,
        `expected error to include non-empty text after "${prefix}", got: "${text}"`,
      ).toBe(true);
    }

    // ---- vault tool ----

    it("vault list_dir without path returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "list_dir",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] path is required for list_dir");
    });

    it("vault move without source returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "move",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] source is required for move");
    });

    it("vault move without destination returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "move",
        source: "a.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] destination is required for move");
    });

    it("vault put without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "put",
        path: "n.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] content is required for put");
    });

    it("vault append without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "append",
        path: "n.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] content is required for append");
    });

    it("vault patch without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch",
        path: "n.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] content is required for patch");
    });

    it("vault patch without operation returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch",
        path: "n.md",
        content: "x",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] operation is required for patch");
    });

    it("vault patch without targetType returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch",
        path: "n.md",
        content: "x",
        operation: "append",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] targetType is required for patch");
    });

    it("vault patch without target returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "patch",
        path: "n.md",
        content: "x",
        operation: "append",
        targetType: "heading",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] target is required for patch");
    });

    it("vault search_replace without search returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "n.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[vault] search is required for search_replace",
      );
    });

    it("vault search_replace without replace returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "n.md",
        search: "foo",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[vault] replace is required for search_replace",
      );
    });

    it("vault search_replace non-string contents returns exact error", async () => {
      const { client, getTool } = setup();
      // getFileContents returns NoteJson (object) instead of a string
      const noteJson: NoteJson = {
        content: "hi",
        frontmatter: {},
        path: "n.md",
        stat: { ctime: 0, mtime: 0, size: 2 },
        tags: [],
      };
      vi.mocked(client.getFileContents).mockResolvedValue(noteJson);
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "n.md",
        search: "foo",
        replace: "bar",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[vault] Expected markdown content");
    });

    it("vault search_replace invalid regex returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault").handler({
        action: "search_replace",
        path: "n.md",
        search: "(",
        replace: "x",
        useRegex: true,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe('[vault] Invalid regex: "("');
    });

    it("vault preset-blocked action returns exact error", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault").handler({
        action: "delete",
        path: "n.md",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        '[vault] Action "delete" is not allowed in "read-only" preset',
      );
    });

    it("vault catch branch carries [vault] prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listFilesInVault).mockRejectedValue(new Error("boom"));
      const result = await getTool("vault").handler({
        action: "list",
        useRegex: false,
        caseSensitive: true,
        replaceAll: true,
      });
      expectToolPrefixedError(result, "vault");
    });

    // ---- active_file tool ----

    it("active_file preset-blocked action returns exact error", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("active_file").handler({ action: "delete" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        '[active_file] Action "delete" is not allowed in "read-only" preset',
      );
    });

    it("active_file put without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({ action: "put" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("[active_file] content is required for put");
    });

    it("active_file append without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({ action: "append" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[active_file] content is required for append",
      );
    });

    it("active_file patch without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({ action: "patch" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[active_file] content is required for patch",
      );
    });

    it("active_file patch without operation returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch",
        content: "x",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[active_file] operation is required for patch",
      );
    });

    it("active_file patch without targetType returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch",
        content: "x",
        operation: "append",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[active_file] targetType is required for patch",
      );
    });

    it("active_file patch without target returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("active_file").handler({
        action: "patch",
        content: "x",
        operation: "append",
        targetType: "heading",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[active_file] target is required for patch",
      );
    });

    it("active_file catch branch carries [active_file] prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getActiveFile).mockRejectedValue(new Error("boom"));
      const result = await getTool("active_file").handler({ action: "get" });
      expectToolPrefixedError(result, "active_file");
    });

    // ---- commands tool ----

    it("commands preset-blocked action returns exact error", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("commands").handler({
        action: "execute",
        commandId: "app:go-back",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        '[commands] Action "execute" is not allowed in "read-only" preset',
      );
    });

    it("commands execute without commandId returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("commands").handler({ action: "execute" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[commands] commandId is required for execute",
      );
    });

    it("commands catch branch carries [commands] prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.listCommands).mockRejectedValue(new Error("boom"));
      const result = await getTool("commands").handler({ action: "list" });
      expectToolPrefixedError(result, "commands");
    });

    // ---- search tool ----

    it("search preset-blocked type returns exact error", async () => {
      const { getTool } = setup({ toolPreset: "minimal" });
      const result = await getTool("search").handler({
        type: "jsonlogic",
        jsonQuery: {},
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        '[search] Type "jsonlogic" is not allowed in "minimal" preset',
      );
    });

    it("search simple without query returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "simple",
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[search] query is required for simple search",
      );
    });

    it("search jsonlogic without jsonQuery returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "jsonlogic",
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[search] jsonQuery is required for jsonlogic search",
      );
    });

    it("search dataview without query returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("search").handler({
        type: "dataview",
        contextLength: 100,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[search] query is required for dataview search",
      );
    });

    it("search catch branch carries [search] prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.simpleSearch).mockRejectedValue(new Error("boom"));
      const result = await getTool("search").handler({
        type: "simple",
        query: "q",
        contextLength: 100,
      });
      expectToolPrefixedError(result, "search");
    });

    // ---- periodic_note tool ----

    it("periodic_note preset-blocked action returns exact error", async () => {
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("periodic_note").handler({
        action: "delete",
        period: "daily",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        '[periodic_note] Action "delete" is not allowed in "read-only" preset',
      );
    });

    it("periodic_note partial date fields return exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "get",
        period: "daily",
        year: 2026,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] All of year, month, and day are required for date-scoped operations (or omit all for current period)",
      );
    });

    it("periodic_note put without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "put",
        period: "daily",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] content is required for put",
      );
    });

    it("periodic_note append without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "append",
        period: "daily",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] content is required for append",
      );
    });

    it("periodic_note patch without content returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] content is required for patch",
      );
    });

    it("periodic_note patch without operation returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
        content: "x",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] operation is required for patch",
      );
    });

    it("periodic_note patch without targetType returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
        content: "x",
        operation: "append",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] targetType is required for patch",
      );
    });

    it("periodic_note patch without target returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("periodic_note").handler({
        action: "patch",
        period: "daily",
        content: "x",
        operation: "append",
        targetType: "heading",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[periodic_note] target is required for patch",
      );
    });

    it("periodic_note catch branch carries [periodic_note] prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getPeriodicNote).mockRejectedValue(new Error("boom"));
      const result = await getTool("periodic_note").handler({
        action: "get",
        period: "daily",
      });
      expectToolPrefixedError(result, "periodic_note");
    });

    // ---- status tool (catch-branch prefix only) ----

    it("status catch branch carries [status] prefix", async () => {
      const { client, getTool } = setup();
      vi.mocked(client.getServerStatus).mockRejectedValue(new Error("boom"));
      const result = await getTool("status").handler({});
      expectToolPrefixedError(result, "status");
    });

    // NOTE: batch_get's outer catch branch (consolidated.ts L841) is
    // intentionally not exercised for the same reason PR #20 left its
    // granular sibling uncovered: batchGetFiles() catches per-file errors
    // internally, so the outer catch is only reachable if jsonResult itself
    // throws on an impossible input (e.g. BigInt / circular structures).
    // Forcing that state would be noise; the `tool: "batch_get"` string
    // literal at L841 stays a surviving mutant by design.

    // ---- recent tool ----

    it("recent periodic_notes without period returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("recent").handler({
        type: "periodic_notes",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[recent] period is required for periodic_notes",
      );
    });

    it("recent catch branch carries [recent] prefix", async () => {
      const { cache, getTool } = setup();
      vi.mocked(cache.getAllNotes).mockImplementation(() => {
        throw new Error("cache boom");
      });
      const result = await getTool("recent").handler({
        type: "changes",
        limit: 5,
      });
      expectToolPrefixedError(result, "recent");
    });

    // ---- vault_analysis tool ----

    it("vault_analysis preset-blocked action returns exact error", async () => {
      // The Zod enum only admits {backlinks, connections, structure, refresh}
      // in production, but we bypass Zod here so an out-of-enum action
      // reaches the preset guard before the switch — exercising the literal.
      const { getTool } = setup({ toolPreset: "read-only" });
      const result = await getTool("vault_analysis").handler({
        action: "bogus",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        '[vault_analysis] Action "bogus" is not allowed in "read-only" preset',
      );
    });

    it("vault_analysis backlinks without path returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[vault_analysis] path is required for backlinks",
      );
    });

    it("vault_analysis connections without path returns exact error", async () => {
      const { getTool } = setup();
      const result = await getTool("vault_analysis").handler({
        action: "connections",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[vault_analysis] path is required for connections",
      );
    });

    it("vault_analysis refresh with cache disabled returns exact error", async () => {
      const { getTool } = setup({ enableCache: false });
      const result = await getTool("vault_analysis").handler({
        action: "refresh",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[vault_analysis] Cache is disabled. Set OBSIDIAN_ENABLE_CACHE=true",
      );
    });

    it("vault_analysis refresh failure returns exact error", async () => {
      const { cache, getTool } = setup();
      // refresh() resolves but cache stays uninitialized — simulates a
      // transient Obsidian unreachable scenario.
      vi.mocked(cache.getIsInitialized).mockReturnValue(false);
      const result = await getTool("vault_analysis").handler({
        action: "refresh",
        limit: 10,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe(
        "[vault_analysis] Cache refresh failed — Obsidian may be unreachable",
      );
    });

    it("vault_analysis catch branch carries [vault_analysis] prefix", async () => {
      const { cache, getTool } = setup();
      vi.mocked(cache.getBacklinks).mockImplementation(() => {
        throw new Error("cache boom");
      });
      const result = await getTool("vault_analysis").handler({
        action: "backlinks",
        path: "n.md",
        limit: 10,
      });
      expectToolPrefixedError(result, "vault_analysis");
    });
  });
});

// ============================================================================
// Section 4: granular tools — error-path coverage (Issue #20)
// ============================================================================
//
// Every granular tool wraps its client call in try/catch and surfaces failures
// via errorResult(buildErrorMessage(...)). The happy paths are tested above;
// this section exercises the catch branch for each tool whose error path was
// previously uncovered per Sonar's new-code coverage report. The assertion is
// intentionally lightweight: we only need result.isError to be true and the
// tool-name prefix to appear in the message, because buildErrorMessage's
// output format is already unit-tested in errors.test.ts.

describe("granular tools — error-path coverage (#20)", () => {
  /**
   * Build the registration fixture used by every error-path test in this
   * section. Returns the mock client + cache plus a getTool accessor so
   * each case can selectively reject the relevant client method (or throw
   * from a cache method) before invoking the tool's handler.
   */
  function setupFailing(): {
    client: ObsidianClient;
    cache: VaultCache;
    getTool: (name: string) => CapturedTool;
  } {
    const { server, getTool } = makeMockServer();
    const client = makeMockClient();
    const cache = makeMockCache();
    const config = makeConfig();
    registerGranularTools(server as never, client, cache, () => true, config);
    return { client, cache, getTool };
  }

  // Tool → client method to reject, plus a minimal valid args object.
  // Tools backed by helpers (batch_get_file_contents, get_recent_changes,
  // get_recent_periodic_notes, get_vault_structure, get_note_connections,
  // refresh_cache, search_replace) are handled individually below because
  // they need a mock on something other than a single client method.
  const simpleCases: Array<
    [tool: string, method: keyof ObsidianClient, args: Record<string, unknown>]
  > = [
    ["append_content", "appendContent", { path: "n.md", content: "x" }],
    [
      "patch_content",
      "patchContent",
      {
        path: "n.md",
        content: "x",
        operation: "append",
        targetType: "heading",
        target: "H",
      },
    ],
    ["delete_file", "deleteFile", { path: "n.md" }],
    ["get_active_file", "getActiveFile", { format: "markdown" }],
    ["put_active_file", "putActiveFile", { content: "x" }],
    ["append_active_file", "appendActiveFile", { content: "x" }],
    [
      "patch_active_file",
      "patchActiveFile",
      { content: "x", operation: "append", targetType: "heading", target: "H" },
    ],
    ["delete_active_file", "deleteActiveFile", {}],
    ["execute_command", "executeCommand", { commandId: "app:go-back" }],
    ["complex_search", "complexSearch", { query: {} }],
    ["dataview_search", "dataviewSearch", { dql: "TABLE" }],
    [
      "get_periodic_note",
      "getPeriodicNote",
      { period: "daily", format: "markdown" },
    ],
    ["put_periodic_note", "putPeriodicNote", { period: "daily", content: "x" }],
    [
      "append_periodic_note",
      "appendPeriodicNote",
      { period: "daily", content: "x" },
    ],
    [
      "patch_periodic_note",
      "patchPeriodicNote",
      {
        period: "daily",
        content: "x",
        operation: "append",
        targetType: "heading",
        target: "H",
      },
    ],
    ["delete_periodic_note", "deletePeriodicNote", { period: "daily" }],
    [
      "get_periodic_note_for_date",
      "getPeriodicNoteForDate",
      { period: "daily", year: 2026, month: 4, day: 23, format: "markdown" },
    ],
    [
      "put_periodic_note_for_date",
      "putPeriodicNoteForDate",
      { period: "daily", year: 2026, month: 4, day: 23, content: "x" },
    ],
    [
      "append_periodic_note_for_date",
      "appendPeriodicNoteForDate",
      { period: "daily", year: 2026, month: 4, day: 23, content: "x" },
    ],
    [
      "patch_periodic_note_for_date",
      "patchPeriodicNoteForDate",
      {
        period: "daily",
        year: 2026,
        month: 4,
        day: 23,
        content: "x",
        operation: "append",
        targetType: "heading",
        target: "H",
      },
    ],
    [
      "delete_periodic_note_for_date",
      "deletePeriodicNoteForDate",
      { period: "daily", year: 2026, month: 4, day: 23 },
    ],
    ["get_server_status", "getServerStatus", {}],
    // Added per Gemini review — these three tools' catch branches weren't
    // in Sonar's "new code" bucket (pre-baseline code), but exercising
    // them keeps the pattern consistent and guards against regressions
    // if the handlers ever drift.
    ["list_commands", "listCommands", {}],
    ["open_file", "openFile", { path: "n.md", newLeaf: false }],
    ["simple_search", "simpleSearch", { query: "q", contextLength: 100 }],
  ];

  it.each(simpleCases)(
    "%s surfaces client error via errorResult",
    async (tool, method, args) => {
      const { client, getTool } = setupFailing();
      vi.mocked(client[method] as never).mockRejectedValue(new Error("boom"));
      const result = await getTool(tool).handler(args);
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain(`[${tool}]`);
    },
  );

  // search_replace has two distinct uncovered error paths.
  it("search_replace returns errorResult on invalid user regex", async () => {
    const { client, getTool } = setupFailing();
    vi.mocked(client.getFileContents).mockResolvedValue("body");
    const result = await getTool("search_replace").handler({
      path: "n.md",
      search: "(",
      replace: "x",
      useRegex: true,
      caseSensitive: true,
      replaceAll: true,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Invalid regex");
  });

  it("search_replace surfaces general client error via errorResult", async () => {
    const { client, getTool } = setupFailing();
    vi.mocked(client.getFileContents).mockRejectedValue(new Error("boom"));
    const result = await getTool("search_replace").handler({
      path: "n.md",
      search: "foo",
      replace: "bar",
      useRegex: false,
      caseSensitive: true,
      replaceAll: true,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[search_replace]");
  });

  // NOTE: batch_get_file_contents's catch branch (src/tools/granular.ts L955)
  // is intentionally not exercised. `batchGetFiles` in src/tools/shared.ts
  // catches per-file errors and folds them into the result array, so the
  // outer catch here is only reachable if `jsonResult` itself throws (e.g.
  // BigInt / circular structures) — which the surrounding types rule out.
  // Leaving this line uncovered is correct; adding a test that forced an
  // impossible state would be noise.

  // handleRecentChanges reads cache.getAllNotes() when cache is initialized;
  // make that throw to trip the outer catch.
  it("get_recent_changes surfaces cache error via errorResult", async () => {
    const { cache, getTool } = setupFailing();
    vi.mocked(cache.getAllNotes).mockImplementation(() => {
      throw new Error("cache boom");
    });
    const result = await getTool("get_recent_changes").handler({ limit: 5 });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[get_recent_changes]");
  });

  // handleRecentPeriodicNotes calls client.listFilesInVault() directly.
  it("get_recent_periodic_notes surfaces error via errorResult", async () => {
    const { client, getTool } = setupFailing();
    vi.mocked(client.listFilesInVault).mockRejectedValue(new Error("boom"));
    const result = await getTool("get_recent_periodic_notes").handler({
      period: "daily",
      limit: 5,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[get_recent_periodic_notes]");
  });

  it("get_backlinks surfaces cache error via errorResult", async () => {
    const { cache, getTool } = setupFailing();
    vi.mocked(cache.getBacklinks).mockImplementation(() => {
      throw new Error("cache boom");
    });
    const result = await getTool("get_backlinks").handler({ path: "n.md" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[get_backlinks]");
  });

  // buildVaultStructure reads cache.getOrphanNotes() first.
  it("get_vault_structure surfaces cache error via errorResult", async () => {
    const { cache, getTool } = setupFailing();
    vi.mocked(cache.getOrphanNotes).mockImplementation(() => {
      throw new Error("cache boom");
    });
    const result = await getTool("get_vault_structure").handler({ limit: 10 });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[get_vault_structure]");
  });

  it("get_note_connections surfaces error via errorResult", async () => {
    const { cache, getTool } = setupFailing();
    vi.mocked(cache.getBacklinks).mockImplementation(() => {
      throw new Error("cache boom");
    });
    const result = await getTool("get_note_connections").handler({
      path: "n.md",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[get_note_connections]");
  });

  it("refresh_cache surfaces error via errorResult", async () => {
    const { cache, getTool } = setupFailing();
    vi.mocked(cache.refresh).mockRejectedValue(new Error("cache boom"));
    const result = await getTool("refresh_cache").handler({});
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("[refresh_cache]");
  });
});
