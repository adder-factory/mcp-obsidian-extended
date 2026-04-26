import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  sanitizeFilePath,
  textResult,
  errorResult,
  jsonResult,
  compactify,
  setCompactResponses,
  getCompactResponses,
  ObsidianClient,
} from "../obsidian.js";
import type { ToolResult } from "../obsidian.js";
import { ObsidianApiError, ObsidianAuthError } from "../errors.js";
import { type Config, setDebugEnabled } from "../config.js";

// Suppress stderr output
beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

// ---------------------------------------------------------------------------
// sanitizeFilePath
// ---------------------------------------------------------------------------
describe("sanitizeFilePath", () => {
  it("allows simple relative paths", () => {
    expect(sanitizeFilePath("notes/test.md")).toBe("notes/test.md");
  });

  it("allows nested paths", () => {
    expect(sanitizeFilePath("a/b/c/d.md")).toBe("a/b/c/d.md");
  });

  it("allows filenames without directories", () => {
    expect(sanitizeFilePath("test.md")).toBe("test.md");
  });

  it("normalises backslashes to forward slashes", () => {
    expect(sanitizeFilePath("notes\\sub\\test.md")).toBe("notes/sub/test.md");
  });

  it("rejects paths with .. segments", () => {
    expect(() => sanitizeFilePath("../secret.md")).toThrow(
      "Path traversal not allowed",
    );
    expect(() => sanitizeFilePath("notes/../../etc/passwd")).toThrow(
      "Path traversal not allowed",
    );
    expect(() => sanitizeFilePath("notes/sub/../../../bad")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("allows .. in filenames (not as path segments)", () => {
    // "version..2.md" should be allowed because ".." is part of the filename, not a segment
    expect(sanitizeFilePath("version..2.md")).toBe("version..2.md");
    expect(sanitizeFilePath("notes/file..name.md")).toBe("notes/file..name.md");
  });

  it("rejects absolute Unix paths", () => {
    expect(() => sanitizeFilePath("/etc/passwd")).toThrow(
      "Absolute paths not allowed",
    );
    expect(() => sanitizeFilePath("/notes/test.md")).toThrow(
      "Absolute paths not allowed",
    );
  });

  it("rejects absolute Windows paths", () => {
    expect(() => sanitizeFilePath("C:\\Users\\test")).toThrow(
      "Absolute paths not allowed",
    );
    expect(() => sanitizeFilePath("D:file.md")).toThrow(
      "Absolute paths not allowed",
    );
  });

  it("allows paths with spaces", () => {
    expect(sanitizeFilePath("my notes/test file.md")).toBe(
      "my notes/test file.md",
    );
  });

  it("allows paths with unicode characters", () => {
    expect(sanitizeFilePath("notes/日本語.md")).toBe("notes/日本語.md");
  });

  it("rejects empty string", () => {
    expect(() => sanitizeFilePath("")).toThrow("Empty path not allowed");
  });

  it("rejects dot-only path", () => {
    expect(() => sanitizeFilePath(".")).toThrow("Empty path not allowed");
  });
});

// ---------------------------------------------------------------------------
// textResult / errorResult / jsonResult
// ---------------------------------------------------------------------------
describe("textResult", () => {
  it("produces correct MCP shape", () => {
    const result: ToolResult = textResult("hello");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("hello");
    expect(result.isError).toBeUndefined();
  });
});

describe("errorResult", () => {
  it("produces correct MCP shape with isError true", () => {
    const result: ToolResult = errorResult("something failed");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("something failed");
    expect(result.isError).toBe(true);
  });
});

describe("jsonResult", () => {
  it("serialises object as pretty-printed JSON", () => {
    const data = { key: "value", num: 42 };
    const result: ToolResult = jsonResult(data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(data);
    // Ensure pretty-printed (indented)
    expect(result.content[0]?.text).toContain("\n");
    expect(result.isError).toBeUndefined();
  });

  it("handles arrays", () => {
    const result = jsonResult([1, 2, 3]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([1, 2, 3]);
  });

  it("handles null", () => {
    const result = jsonResult(null);
    expect(result.content[0]?.text).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// compactify
// ---------------------------------------------------------------------------
describe("compactify", () => {
  it("maps known field names to compact abbreviations", () => {
    const data = { content: "hello", path: "test.md", frontmatter: {} };
    const result = compactify(data);
    expect(result).toEqual({ c: "hello", p: "test.md", fm: {} });
  });

  it("maps nested stat fields", () => {
    const data = { stat: { mtime: 100, ctime: 50, size: 200 } };
    const result = compactify(data);
    expect(result).toEqual({ s: { m: 100, ct: 50, sz: 200 } });
  });

  it("preserves null values and strips undefined", () => {
    const data = { content: "hello", path: null, tags: undefined };
    const result = compactify(data);
    expect(result).toEqual({ c: "hello", p: null });
  });

  it("handles arrays recursively", () => {
    const data = [{ path: "a.md" }, { path: "b.md" }];
    const result = compactify(data);
    expect(result).toEqual([{ p: "a.md" }, { p: "b.md" }]);
  });

  it("preserves unmapped keys", () => {
    const data = { unknownField: "value", path: "x.md" };
    const result = compactify(data);
    expect(result).toEqual({ unknownField: "value", p: "x.md" });
  });

  it("handles primitives unchanged", () => {
    expect(compactify(42)).toBe(42);
    expect(compactify("hello")).toBe("hello");
    expect(compactify(true)).toBe(true);
  });

  it("preserves null, returns undefined for undefined", () => {
    expect(compactify(null)).toBeNull();
    expect(compactify(undefined)).toBeUndefined();
  });

  it("does not recurse into opaque keys (frontmatter)", () => {
    const data = {
      frontmatter: { path: "/real/path", tags: ["a"] },
      path: "note.md",
    };
    const result = compactify(data);
    // frontmatter internals should NOT be renamed
    expect(result).toEqual({
      fm: { path: "/real/path", tags: ["a"] },
      p: "note.md",
    });
  });

  it("does not recurse into opaque keys (result)", () => {
    const data = { result: { content: "raw", matches: [1] }, path: "note.md" };
    const result = compactify(data);
    // result internals should NOT be renamed
    expect(result).toEqual({
      result: { content: "raw", matches: [1] },
      p: "note.md",
    });
  });

  it("handles deeply nested objects", () => {
    const data = { matches: [{ context: "some text", score: 0.9 }] };
    const result = compactify(data);
    expect(result).toEqual({ mt: [{ ctx: "some text", sc: 0.9 }] });
  });
});

// ---------------------------------------------------------------------------
// setCompactResponses / getCompactResponses + jsonResult compact mode
// ---------------------------------------------------------------------------
describe("compact responses", () => {
  let savedCompactState: boolean;
  beforeEach(() => {
    savedCompactState = getCompactResponses();
    setCompactResponses(false);
  });
  afterEach(() => {
    setCompactResponses(savedCompactState);
  });

  it("defaults to disabled", () => {
    expect(getCompactResponses()).toBe(false);
  });

  it("can be toggled", () => {
    setCompactResponses(true);
    expect(getCompactResponses()).toBe(true);
    setCompactResponses(false);
    expect(getCompactResponses()).toBe(false);
  });

  it("jsonResult uses compact field names when enabled", () => {
    setCompactResponses(true);
    const data = { content: "hello", path: "test.md" };
    const result = jsonResult(data);
    const parsed: unknown = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed).toEqual({ c: "hello", p: "test.md" });
  });

  it("jsonResult omits whitespace when compact", () => {
    setCompactResponses(true);
    const result = jsonResult({ content: "hello" });
    // Compact mode uses no indentation
    expect(result.content[0]?.text).not.toContain("\n");
  });

  it("jsonResult uses pretty-print when not compact", () => {
    setCompactResponses(false);
    const result = jsonResult({ key: "value" });
    expect(result.content[0]?.text).toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — constructor and handleErrorResponse / parseJsonResponse
// (tested via public methods with mocked HTTP)
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Config for testing. We avoid making actual HTTP requests
 * by testing the error-handling and path-encoding logic through the public
 * utility functions and by exercising the client constructor.
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test-key",
    host: "127.0.0.1",
    port: 27124,
    scheme: "http", // Use http to avoid TLS agent issues in tests
    timeout: 5000,
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
    ...overrides,
  };
}

describe("ObsidianClient — constructor", () => {
  it("creates client with http scheme without error", () => {
    const client = new ObsidianClient(makeConfig({ scheme: "http" }));
    expect(client).toBeInstanceOf(ObsidianClient);
  });

  it("creates client with https scheme without error", () => {
    const client = new ObsidianClient(makeConfig({ scheme: "https" }));
    expect(client).toBeInstanceOf(ObsidianClient);
  });

  it("throws when cert file does not exist", () => {
    expect(() => {
      new ObsidianClient(
        makeConfig({
          scheme: "https",
          certPath: "/nonexistent/cert.pem",
        }),
      );
    }).toThrow("Failed to read TLS certificate");
  });

  it("creates client with verifySsl=true (no certPath)", () => {
    const client = new ObsidianClient(
      makeConfig({ scheme: "https", verifySsl: true }),
    );
    expect(client).toBeInstanceOf(ObsidianClient);
  });

  it("creates client with verifySsl=false and no certPath (self-signed)", () => {
    const client = new ObsidianClient(
      makeConfig({ scheme: "https", verifySsl: false }),
    );
    expect(client).toBeInstanceOf(ObsidianClient);
  });

  it("creates client with debug=true", () => {
    const client = new ObsidianClient(makeConfig({ debug: true }));
    expect(client).toBeInstanceOf(ObsidianClient);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — handleErrorResponse and parseJsonResponse
// We use reflection to test private methods since they are critical
// ---------------------------------------------------------------------------
describe("ObsidianClient — parseJsonResponse", () => {
  it("returns parsed JSON for valid input", () => {
    const client = new ObsidianClient(makeConfig());
    // Access private method via bracket notation
    const parse = (
      client as unknown as Record<
        string,
        (body: string, path: string) => unknown
      >
    )["parseJsonResponse"];
    const result = parse.call(client, '{"ok":true}', "/test");
    expect(result).toEqual({ ok: true });
  });

  it("throws ObsidianApiError on invalid JSON", () => {
    const client = new ObsidianClient(makeConfig());
    const parse = (
      client as unknown as Record<
        string,
        (body: string, path: string) => unknown
      >
    )["parseJsonResponse"];
    expect(() => parse.call(client, "not json", "/test")).toThrow(
      ObsidianApiError,
    );
  });
});

describe("ObsidianClient — handleErrorResponse", () => {
  it("throws ObsidianAuthError for 401", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (
      client as unknown as Record<string, (code: number, body: string) => never>
    )["handleErrorResponse"];
    expect(() => handle.call(client, 401, "")).toThrow(ObsidianAuthError);
  });

  it("throws ObsidianAuthError for 403", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (
      client as unknown as Record<string, (code: number, body: string) => never>
    )["handleErrorResponse"];
    expect(() => handle.call(client, 403, "")).toThrow(ObsidianAuthError);
  });

  it("throws ObsidianApiError for other codes", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (
      client as unknown as Record<string, (code: number, body: string) => never>
    )["handleErrorResponse"];
    try {
      handle.call(client, 500, '{"message":"Internal error","errorCode":99}');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ObsidianApiError);
      const apiErr = err as ObsidianApiError;
      expect(apiErr.statusCode).toBe(500);
      expect(apiErr.message).toBe("Internal error");
      expect(apiErr.errorCode).toBe(99);
      return;
    }
    expect.fail("should have thrown");
  });

  it("uses raw body as message when JSON parsing fails", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (
      client as unknown as Record<string, (code: number, body: string) => never>
    )["handleErrorResponse"];
    try {
      handle.call(client, 500, "raw error text");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ObsidianApiError);
      expect((err as ObsidianApiError).message).toBe("raw error text");
      return;
    }
    expect.fail("should have thrown");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — truncateResponse
// ---------------------------------------------------------------------------
describe("ObsidianClient — truncateResponse", () => {
  it("does not truncate short text", () => {
    const client = new ObsidianClient(makeConfig({ maxResponseChars: 100 }));
    const truncate = (
      client as unknown as Record<string, (text: string) => string>
    )["truncateResponse"];
    expect(truncate.call(client, "short")).toBe("short");
  });

  it("truncates text exceeding maxResponseChars", () => {
    const client = new ObsidianClient(makeConfig({ maxResponseChars: 10 }));
    const truncate = (
      client as unknown as Record<string, (text: string) => string>
    )["truncateResponse"];
    const result = truncate.call(client, "a".repeat(100));
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("[TRUNCATED");
    expect(result).toContain("10 characters");
  });

  it("does not truncate when maxResponseChars is 0 (disabled)", () => {
    const client = new ObsidianClient(makeConfig({ maxResponseChars: 0 }));
    const truncate = (
      client as unknown as Record<string, (text: string) => string>
    )["truncateResponse"];
    const long = "x".repeat(1000000);
    expect(truncate.call(client, long)).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — write lock serialization
// ---------------------------------------------------------------------------
describe("ObsidianClient — withFileLock", () => {
  it("serialises concurrent operations on the same file path", async () => {
    const client = new ObsidianClient(makeConfig());
    const withFileLock = (
      client as unknown as Record<
        string,
        <T>(path: string, fn: () => Promise<T>) => Promise<T>
      >
    )["withFileLock"];

    const order: number[] = [];

    const op1 = withFileLock.call(client, "test.md", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });

    const op2 = withFileLock.call(client, "test.md", async () => {
      order.push(2);
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]);
  });

  it("allows concurrent operations on different paths", async () => {
    const client = new ObsidianClient(makeConfig());
    const withFileLock = (
      client as unknown as Record<
        string,
        <T>(path: string, fn: () => Promise<T>) => Promise<T>
      >
    )["withFileLock"];

    const order: string[] = [];

    const op1 = withFileLock.call(client, "file-a.md", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("a");
    });

    const op2 = withFileLock.call(client, "file-b.md", async () => {
      order.push("b");
    });

    await Promise.all([op1, op2]);
    // b should complete before a since they are on different paths
    expect(order[0]).toBe("b");
    expect(order[1]).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — encodePath (path encoding with segments)
// ---------------------------------------------------------------------------
describe("ObsidianClient — encodePath", () => {
  it("URL-encodes path segments", () => {
    const client = new ObsidianClient(makeConfig());
    const encodePath = (
      client as unknown as Record<string, (path: string) => string>
    )["encodePath"];
    const result = encodePath.call(client, "my notes/test file.md");
    expect(result).toBe("my%20notes/test%20file.md");
  });

  it("handles paths with special characters", () => {
    const client = new ObsidianClient(makeConfig());
    const encodePath = (
      client as unknown as Record<string, (path: string) => string>
    )["encodePath"];
    const result = encodePath.call(client, "notes/hello world (1).md");
    expect(result).toContain("hello%20world%20(1).md");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — buildPatchHeaders
// ---------------------------------------------------------------------------
describe("ObsidianClient — buildPatchHeaders", () => {
  /** Helper: calls buildPatchHeaders with the given options and returns the full headers record. */
  function buildHeaders(opts: Record<string, unknown>): Record<string, string> {
    const client = new ObsidianClient(makeConfig());
    const build = (
      client as unknown as Record<
        string,
        (o: Record<string, unknown>) => Record<string, string>
      >
    )["buildPatchHeaders"];
    return build.call(client, opts);
  }

  /** Helper: builds patch headers for a given target and returns the Target header value. */
  function targetHeader(target: string): string {
    return (
      buildHeaders({
        operation: "append",
        targetType: "heading",
        target,
        contentType: "markdown",
      })["Target"] ?? ""
    );
  }

  it("sets required headers", () => {
    const headers = buildHeaders({
      operation: "append",
      targetType: "heading",
      target: "My Heading",
      contentType: "markdown",
    });
    expect(headers["Operation"]).toBe("append");
    expect(headers["Target-Type"]).toBe("heading");
    expect(headers["Target"]).toBe("My Heading");
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("preserves + and & in Target header", () => {
    expect(targetHeader("Q&A + Notes")).toBe("Q&A + Notes");
  });

  it("preserves :: delimiter in Target header", () => {
    expect(targetHeader("Parent::Child")).toBe("Parent::Child");
  });

  it("encodes non-ASCII unicode in Target header for HTTP safety", () => {
    expect(targetHeader("Notizen über Bücher")).toBe(
      "Notizen %C3%BCber B%C3%BCcher",
    );
  });

  it("encodes emoji in Target header for HTTP safety", () => {
    expect(targetHeader("📝 Notes")).toBe("%F0%9F%93%9D Notes");
  });

  it("preserves spaces in Target header", () => {
    expect(targetHeader("My Long Heading")).toBe("My Long Heading");
  });

  it("encodes fully non-ASCII heading (CJK)", () => {
    expect(targetHeader("日本語の見出し")).toBe(
      "%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%AE%E8%A6%8B%E5%87%BA%E3%81%97",
    );
  });

  it("escapes literal % so Obsidian does not decode %HH sequences", () => {
    // A heading literally containing "%C3%BC" must have % escaped to %25
    // so Obsidian decodes %25→% and preserves the literal string.
    expect(targetHeader("50%C3%BC off")).toBe("50%25C3%25BC off");
  });

  it("handles % and non-ASCII combined in the same heading", () => {
    // Both encoding steps interact: % → %25, then ü → %C3%BC
    expect(targetHeader("50% über")).toBe("50%25 %C3%BCber");
  });

  it("escapes literal % in simple heading names", () => {
    // "100% Complete" → "100%25 Complete" — Obsidian decodes %25→%
    expect(targetHeader("100% Complete")).toBe("100%25 Complete");
  });

  it("handles unpaired surrogates without throwing", () => {
    // Unpaired surrogate \uD800 would crash encodeURIComponent — should be stripped
    expect(() => targetHeader("test\uD800heading")).not.toThrow();
    expect(targetHeader("test\uD800heading")).toBe("testheading");
  });

  it("uses application/json when contentType is json", () => {
    const headers = buildHeaders({
      operation: "replace",
      targetType: "frontmatter",
      target: "tags",
      contentType: "json",
    });
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes optional headers when provided", () => {
    const headers = buildHeaders({
      operation: "append",
      targetType: "heading",
      target: "Test",
      targetDelimiter: "|",
      trimTargetWhitespace: true,
      createIfMissing: true,
    });
    expect(headers["Target-Delimiter"]).toBe("|");
    expect(headers["Trim-Target-Whitespace"]).toBe("true");
    expect(headers["Create-Target-If-Missing"]).toBe("true");
  });

  it("omits optional headers when not provided", () => {
    const headers = buildHeaders({
      operation: "append",
      targetType: "heading",
      target: "Test",
    });
    expect(headers["Target-Delimiter"]).toBeUndefined();
    expect(headers["Trim-Target-Whitespace"]).toBeUndefined();
    expect(headers["Create-Target-If-Missing"]).toBeUndefined();
  });

  it("encodes non-ASCII Target-Delimiter header", () => {
    const headers = buildHeaders({
      operation: "append",
      targetType: "heading",
      target: "Test",
      targetDelimiter: "→",
    });
    expect(headers["Target-Delimiter"]).toBe("%E2%86%92");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — periodicDatePath
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodicDatePath", () => {
  it("builds correct path with zero-padded month and day", () => {
    const client = new ObsidianClient(makeConfig());
    const buildPath = (
      client as unknown as Record<
        string,
        (period: string, y: number, m: number, d: number) => string
      >
    )["periodicDatePath"];
    expect(buildPath.call(client, "daily", 2026, 3, 5)).toBe(
      "/periodic/daily/2026/03/05/",
    );
  });

  it("does not pad already two-digit month/day", () => {
    const client = new ObsidianClient(makeConfig());
    const buildPath = (
      client as unknown as Record<
        string,
        (period: string, y: number, m: number, d: number) => string
      >
    )["periodicDatePath"];
    expect(buildPath.call(client, "weekly", 2026, 12, 25)).toBe(
      "/periodic/weekly/2026/12/25/",
    );
  });
});

// ---------------------------------------------------------------------------
// FileContentsResult type alias — compile-time check
// ---------------------------------------------------------------------------
describe("FileContentsResult type", () => {
  it("accepts string values", () => {
    // This is a compile-time check; if it compiles, the type alias works
    const _: Parameters<typeof textResult>[0] = "markdown content";
    expect(_).toBe("markdown content");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — connection health
// ---------------------------------------------------------------------------
describe("ObsidianClient — getIsConnected", () => {
  it("returns false initially", () => {
    const client = new ObsidianClient(makeConfig());
    expect(client.getIsConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — setCache
// ---------------------------------------------------------------------------
describe("ObsidianClient — setCache", () => {
  it("accepts a cache interface without error", () => {
    const client = new ObsidianClient(makeConfig());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    expect(() => client.setCache(mockCache)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helper: create a client with mocked request()
// ---------------------------------------------------------------------------
type RequestResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

/** Extracts HTTP headers from a mock request call's third argument. */
function getCallHeaders(call: unknown[] | undefined): Record<string, string> {
  if (!call) return {};
  const opts = call[2];
  if (opts !== null && typeof opts === "object" && "headers" in opts) {
    return (opts as { headers: Record<string, string> }).headers;
  }
  return {};
}

function createMockedClient(overrides: Partial<Config> = {}): {
  client: ObsidianClient;
  mockRequest: ReturnType<
    typeof vi.fn<(...args: unknown[]) => Promise<RequestResult>>
  >;
} {
  const client = new ObsidianClient(makeConfig(overrides));
  const mockRequest = vi.fn<(...args: unknown[]) => Promise<RequestResult>>();
  (client as unknown as Record<string, unknown>)["request"] = mockRequest;
  return { client, mockRequest };
}

/** Installs a no-op spy on process.stderr.write and returns it for assertions. */
function spyOnStderr(): ReturnType<
  typeof vi.spyOn<typeof process.stderr, "write">
> {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function okJson(data: unknown): RequestResult {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}

function ok204(): RequestResult {
  return { statusCode: 204, headers: {}, body: "" };
}

function notFound(msg = "Not found"): RequestResult {
  return {
    statusCode: 404,
    headers: {},
    body: JSON.stringify({ message: msg }),
  };
}

// ---------------------------------------------------------------------------
// ObsidianClient — getServerStatus
// ---------------------------------------------------------------------------
describe("ObsidianClient — getServerStatus", () => {
  it("returns server status on success", async () => {
    const { client, mockRequest } = createMockedClient();
    const status = {
      ok: true,
      service: "obsidian",
      authenticated: true,
      versions: {},
    };
    mockRequest.mockResolvedValue(okJson(status));

    const result = await client.getServerStatus();
    expect(result).toEqual(status);
    expect(mockRequest).toHaveBeenCalledWith("GET", "/", { auth: false });
  });

  it("throws on non-200 status", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: '{"message":"error"}',
    });

    await expect(client.getServerStatus()).rejects.toThrow(ObsidianApiError);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — listFilesInVault
// ---------------------------------------------------------------------------
describe("ObsidianClient — listFilesInVault", () => {
  it("returns file list on success", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson({ files: ["note.md", "folder/"] }));

    const result = await client.listFilesInVault();
    expect(result.files).toEqual(["note.md", "folder/"]);
  });

  it("throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.listFilesInVault()).rejects.toThrow(ObsidianApiError);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — listFilesInDir
// ---------------------------------------------------------------------------
describe("ObsidianClient — listFilesInDir", () => {
  it("returns files for a directory", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson({ files: ["folder/a.md"] }));

    const result = await client.listFilesInDir("folder");
    expect(result.files).toEqual(["folder/a.md"]);
  });

  it("returns empty list for empty dir that 404s but exists", async () => {
    const { client, mockRequest } = createMockedClient();
    // First call: 404 for the dir
    mockRequest.mockResolvedValueOnce(notFound());
    // Second call: listFilesInVault shows the dir exists
    mockRequest.mockResolvedValueOnce(
      okJson({ files: ["emptydir/nested.md"] }),
    );

    const result = await client.listFilesInDir("emptydir");
    expect(result.files).toEqual([]);
  });

  it("throws 404 for non-existent dir", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce(notFound());
    mockRequest.mockResolvedValueOnce(okJson({ files: ["other/note.md"] }));

    await expect(client.listFilesInDir("nonexistent")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("throws on non-200, non-404 error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: '{"message":"error"}',
    });

    await expect(client.listFilesInDir("folder")).rejects.toThrow(
      ObsidianApiError,
    );
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — getFileContents
// ---------------------------------------------------------------------------
describe("ObsidianClient — getFileContents", () => {
  it("returns markdown content by default", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "# Hello",
    });

    const result = await client.getFileContents("note.md");
    expect(result).toBe("# Hello");
  });

  it("returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = {
      content: "hello",
      frontmatter: {},
      path: "note.md",
      tags: [],
      stat: { ctime: 0, mtime: 0, size: 5 },
    };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getFileContents("note.md", "json");
    expect(result).toEqual(noteJson);
  });

  it("returns document map for map format", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["# Title"],
      blocks: [],
      frontmatterFields: ["date"],
    };
    mockRequest.mockResolvedValue(okJson(docMap));

    const result = await client.getFileContents("note.md", "map");
    expect(result).toEqual(docMap);
  });

  it("truncates long markdown responses", async () => {
    const { client, mockRequest } = createMockedClient({
      maxResponseChars: 50,
    });
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "x".repeat(200),
    });

    const result = await client.getFileContents("note.md", "markdown");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("[TRUNCATED");
  });

  it("throws on error status", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.getFileContents("missing.md")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("tries case-insensitive fallback on 404", async () => {
    const { client, mockRequest } = createMockedClient();
    // First request: 404
    mockRequest.mockResolvedValueOnce(notFound());
    // Directory listing for case-insensitive fallback
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ files: ["Notes/myfile.md"] }),
    });
    // Retry with corrected path: 200
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "found it",
    });

    const result = await client.getFileContents("Notes/MyFile.md");
    expect(result).toBe("found it");
    // 3 calls: original 404 → directory listing → corrected path
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — putContent
// ---------------------------------------------------------------------------
describe("ObsidianClient — putContent", () => {
  // Restore vi.spyOn-installed mocks (notably the file-level
  // process.stderr.write spy) between tests so .mock.calls history
  // doesn't leak from a "warns" test into a subsequent "does NOT warn"
  // assertion. The file-level beforeEach re-installs the spy, but
  // vi.spyOn on the same property returns the same mock reference and
  // does not auto-clear call history.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes content successfully", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putContent("note.md", "# New content");
    expect(mockRequest).toHaveBeenCalledWith(
      "PUT",
      "/vault/note.md",
      expect.objectContaining({ body: "# New content" }),
    );
  });

  it("invalidates cache after write", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.putContent("note.md", "content");
    expect(mockCache.invalidate).toHaveBeenCalledWith("note.md");
  });

  it("performs write verification when enabled", async () => {
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    // First call: PUT succeeds
    mockRequest.mockResolvedValueOnce(ok204());
    // Second call: GET for verification
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "correct content",
    });

    await client.putContent("note.md", "correct content");
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("warns on write verification mismatch", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "different content",
    });

    await client.putContent("note.md", "expected content");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Write verification failed"))).toBe(
      true,
    );
  });

  it("warns on write verification read failure", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockRejectedValueOnce(new Error("read failed"));

    await client.putContent("note.md", "content");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((c) => c.includes("Write verification could not read back")),
    ).toBe(true);
  });

  it("throws on error status", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: '{"message":"fail"}',
    });

    await expect(client.putContent("note.md", "content")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("works with default empty content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putContent("note.md");
    expect(mockRequest).toHaveBeenCalledWith(
      "PUT",
      "/vault/note.md",
      expect.objectContaining({ body: "" }),
    );
  });

  // --- Stryker mutation backfill: header shape, status acceptance, verify branches ---

  it("sends Content-Type: text/markdown on the PUT request", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putContent("note.md", "body");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("accepts 200 OK in addition to 204 No Content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(client.putContent("note.md", "body")).resolves.toBeUndefined();
  });

  it("does NOT call verify-read when verifyWrites is disabled (default)", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putContent("note.md", "body");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("verify-read sends Accept: text/markdown header", async () => {
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "matching",
    });

    await client.putContent("note.md", "matching");
    const verifyHeaders = getCallHeaders(mockRequest.mock.calls[1]);
    expect(verifyHeaders["Accept"]).toBe("text/markdown");
    // The verify call must be a GET to the same path
    expect(mockRequest.mock.calls[1]?.[0]).toBe("GET");
    expect(mockRequest.mock.calls[1]?.[1]).toBe("/vault/note.md");
  });

  it("does NOT warn when verify-read content matches written content", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "exact match",
    });

    await client.putContent("note.md", "exact match");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Write verification failed"))).toBe(
      false,
    );
    expect(
      calls.some((c) => c.includes("Write verification inconclusive")),
    ).toBe(false);
  });

  it("considers content matched when only surrounding whitespace differs", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "  body  \n",
    });

    await client.putContent("note.md", "body");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Write verification failed"))).toBe(
      false,
    );
  });

  it("warns 'inconclusive' when verify-read returns non-200 status", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({
      statusCode: 503,
      headers: {},
      body: "service unavailable",
    });

    await client.putContent("note.md", "body");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const inconclusive = calls.find((c) =>
      c.includes("Write verification inconclusive"),
    );
    expect(inconclusive).toBeDefined();
    expect(inconclusive).toContain("note.md");
    expect(inconclusive).toContain("503");
    // Must NOT also emit the mismatch warning when status was non-200
    expect(calls.some((c) => c.includes("Write verification failed"))).toBe(
      false,
    );
  });

  it("warning text 'failed' includes 'content mismatch' explanation", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: "different",
    });

    await client.putContent("note.md", "expected");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const failed = calls.find((c) => c.includes("Write verification failed"));
    expect(failed).toContain("note.md");
    expect(failed).toContain("content mismatch");
  });

  it("read-failure warning includes the underlying error message", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockRejectedValueOnce(new Error("ECONNRESET"));

    await client.putContent("note.md", "body");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const readFailed = calls.find((c) =>
      c.includes("Write verification could not read back"),
    );
    expect(readFailed).toContain("note.md");
    expect(readFailed).toContain("ECONNRESET");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — appendContent
// ---------------------------------------------------------------------------
describe("ObsidianClient — appendContent", () => {
  it("appends content successfully", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendContent("note.md", "appended");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/vault/note.md",
      expect.objectContaining({ body: "appended" }),
    );
  });

  it("invalidates cache after append", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.appendContent("note.md", "text");
    expect(mockCache.invalidate).toHaveBeenCalledWith("note.md");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — patchContent
// ---------------------------------------------------------------------------
describe("ObsidianClient — patchContent", () => {
  it("patches content with correct headers", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.patchContent("note.md", "new text", {
      operation: "append",
      targetType: "heading",
      target: "Section",
    });

    expect(mockRequest).toHaveBeenCalledWith(
      "PATCH",
      "/vault/note.md",
      expect.objectContaining({ body: "new text" }),
    );
  });

  it("invalidates cache after patch", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.patchContent("note.md", "text", {
      operation: "replace",
      targetType: "block",
      target: "block-id",
    });
    expect(mockCache.invalidate).toHaveBeenCalledWith("note.md");
  });

  it("retries with corrected heading on 400 for heading target", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Introduction", "Tasks List", "Conclusion"],
      blocks: [],
      frontmatterFields: [],
    };
    // First PATCH returns 400 (heading not found), then GET returns doc map, then retry PATCH returns 204
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "new text", {
      operation: "append",
      targetType: "heading",
      target: "tasks list", // case mismatch — should match "Tasks List"
    });

    // Verify 3 requests: original PATCH, GET for map, retry PATCH
    expect(mockRequest).toHaveBeenCalledTimes(3);
    // Step 1: original PATCH
    expect(mockRequest.mock.calls[0]?.[0]).toBe("PATCH");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/vault/note.md");
    // Step 2: GET for document map
    expect(mockRequest.mock.calls[1]?.[0]).toBe("GET");
    expect(mockRequest.mock.calls[1]?.[1]).toBe("/vault/note.md");
    // Step 3: retry PATCH with corrected heading
    expect(mockRequest.mock.calls[2]?.[0]).toBe("PATCH");
    expect(mockRequest.mock.calls[2]?.[1]).toBe("/vault/note.md");
    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Target"]).toBe("Tasks List");
  });

  it("throws original 400 error when retry finds no matching heading", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Introduction", "Conclusion"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      });

    const err = await client
      .patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "Nonexistent Heading",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObsidianApiError);
    expect((err as ObsidianApiError).statusCode).toBe(400);
    expect((err as ObsidianApiError).message).toContain("heading not found");
    expect(mockRequest).toHaveBeenCalledTimes(2); // original PATCH + GET for document map
  });

  it("surfaces original error when retry PATCH fails with 500", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce({
        statusCode: 500,
        headers: {},
        body: '{"message":"internal error"}',
      });

    const err = await client
      .patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "tasks",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObsidianApiError);
    expect((err as { statusCode: number }).statusCode).toBe(400);

    expect(mockRequest).toHaveBeenCalledTimes(3);
    // Cache should NOT be invalidated since retry failed
    expect(mockCache.invalidate).not.toHaveBeenCalled();
  });

  it("retries with progressive suffix match when parent heading was renamed", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["NewParent::Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "Parent::Tasks",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = getCallHeaders(retryCall);
    expect(retryHeaders["Target"]).toBe("NewParent::Tasks");
  });

  it("retries via leaf match when flat heading gains a parent", async () => {
    const { client, mockRequest } = createMockedClient();
    // Target "Tasks" (flat) was restructured to "New Section::Tasks" (hierarchical)
    // Stage 4 leaf match should find it
    const docMap = {
      headings: ["New Section::Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "Tasks",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Target"]).toBe("New Section::Tasks");
  });

  it("does not retry when leaf match is ambiguous", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Project A::Tasks", "Project B::Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "Tasks",
      }),
    ).rejects.toThrow(ObsidianApiError);

    // Only 2 requests: original PATCH + GET for map (no retry PATCH due to ambiguity)
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("returns error when all matching stages are ambiguous", async () => {
    const { client, mockRequest } = createMockedClient();
    // "Tasks" and "TASKS" both match case-insensitively (stage 2 ambiguous)
    // Both have same leaf (stage 4 ambiguous too) — no unique match possible
    const docMap = {
      headings: ["Tasks", "TASKS"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "tasks",
      }),
    ).rejects.toThrow(ObsidianApiError);

    // 2 requests: PATCH + GET map (no retry due to ambiguity)
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400 for non-heading targets", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"bad request"}',
    });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "replace",
        targetType: "block",
        target: "block-id",
      }),
    ).rejects.toThrow(ObsidianApiError);

    // Should only have made 1 request (no retry)
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("does not retry when 400 body is not a heading-not-found error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"bad request"}',
    });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "Tasks",
      }),
    ).rejects.toThrow(ObsidianApiError);

    // Only 1 request — no retry because body doesn't match heading-not-found pattern
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache after successful retry", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    expect(mockCache.invalidate).toHaveBeenCalledWith("note.md");
  });

  // --- Stryker mutation backfill: status acceptance, log shapes, retry guards ---

  // Restore vi.spyOn-installed mocks between tests so log-text assertions
  // don't accumulate writes from other patchContent tests above. Also reset
  // debug-logging state — some tests below enable debug logs to assert on
  // the auto-correct trace; the flag is module-level and would otherwise leak.
  afterEach(() => {
    vi.restoreAllMocks();
    setDebugEnabled(false);
  });

  it("accepts 200 OK in addition to 204 No Content on first PATCH", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.patchContent("note.md", "x", {
        operation: "append",
        targetType: "heading",
        target: "H",
      }),
    ).resolves.toBeUndefined();
  });

  it("retry accepts 200 OK in addition to 204 No Content on retry PATCH", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: "" });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "tasks",
      }),
    ).resolves.toBeUndefined();
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it("retry strips Create-Target-If-Missing header before re-PATCH", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
      createIfMissing: true,
    });

    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Create-Target-If-Missing"]).toBeUndefined();
    // Original PATCH did include the header
    const originalHeaders = getCallHeaders(mockRequest.mock.calls[0]);
    expect(originalHeaders["Create-Target-If-Missing"]).toBe("true");
  });

  it("auto-correct success log includes both old and new heading values", async () => {
    setDebugEnabled(true);
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient({ debug: true });
    const docMap = {
      headings: ["Tasks List"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "tasks list",
    });

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const correctedLog = calls.find((c) =>
      c.includes("PATCH heading auto-corrected"),
    );
    expect(correctedLog).toContain("tasks list");
    expect(correctedLog).toContain("Tasks List");
    expect(correctedLog).toContain("note.md");
  });

  it("retry-failed warn log includes the failing status code", async () => {
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce({
        statusCode: 503,
        headers: {},
        body: "service unavailable",
      });

    await client
      .patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "tasks",
      })
      .catch(() => undefined);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const retryFailed = calls.find((c) => c.includes("PATCH retry failed"));
    expect(retryFailed).toContain("note.md");
    expect(retryFailed).toContain("503");
  });

  it("retry returns false when getFileContents returns a markdown string (not a map)", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "text/markdown" },
        body: "# Some markdown content",
      });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "anything",
      }),
    ).rejects.toThrow(ObsidianApiError);
    // Only 2 calls: original PATCH + GET for map (which returned a string, so no retry)
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("retry returns false when map result has no 'headings' key", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        // valid object but missing "headings" key
        body: JSON.stringify({ blocks: [], frontmatterFields: [] }),
      });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "anything",
      }),
    ).rejects.toThrow(ObsidianApiError);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("retry returns false when 'headings' is present but not an Array", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        // headings is a string, not an array
        body: JSON.stringify({
          headings: "oops",
          blocks: [],
          frontmatterFields: [],
        }),
      });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "anything",
      }),
    ).rejects.toThrow(ObsidianApiError);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("trims whitespace on options.target before findClosestHeading", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "  tasks  ", // surrounding whitespace must be trimmed for the lookup
    });

    // Retry succeeded (3 calls), proving trim() worked — without trim,
    // findClosestHeading would not match "Tasks" and the retry would fail.
    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Target"]).toBe("Tasks");
  });

  it("uses '::' as default targetDelimiter when caller omits it", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Parent::Child"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "parent::child", // case-mismatch lookup uses default "::" delimiter
      // targetDelimiter intentionally omitted — must default to "::"
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Target"]).toBe("Parent::Child");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — deleteFile
// ---------------------------------------------------------------------------
describe("ObsidianClient — deleteFile", () => {
  it("deletes file successfully", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deleteFile("note.md");
    expect(mockRequest).toHaveBeenCalledWith("DELETE", "/vault/note.md");
  });

  it("silently handles 404 (already deleted)", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    // Should not throw — 404 means file already gone
    await expect(client.deleteFile("note.md")).resolves.toBeUndefined();
  });

  it("invalidates cache after delete", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.deleteFile("note.md");
    expect(mockCache.invalidate).toHaveBeenCalledWith("note.md");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — Active File operations
// ---------------------------------------------------------------------------
describe("ObsidianClient — active file", () => {
  it("getActiveFile returns markdown", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "active content",
    });

    const result = await client.getActiveFile();
    expect(result).toBe("active content");
  });

  it("getActiveFile returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = {
      content: "x",
      frontmatter: {},
      path: "x.md",
      tags: [],
      stat: { ctime: 0, mtime: 0, size: 1 },
    };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getActiveFile("json");
    expect(result).toEqual(noteJson);
  });

  it("getActiveFile returns document map for map format", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["h1"], blocks: [], frontmatterFields: [] };
    mockRequest.mockResolvedValue(okJson(docMap));

    const result = await client.getActiveFile("map");
    expect(result).toEqual(docMap);
  });

  it("getActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 404,
      headers: {},
      body: '{"message":"no active file"}',
    });

    await expect(client.getActiveFile()).rejects.toThrow(ObsidianApiError);
  });

  it("putActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.putActiveFile("content")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("appendActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.appendActiveFile("content")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("patchActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(
      client.patchActiveFile("text", {
        operation: "append",
        targetType: "heading",
        target: "Test",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("deleteActiveFile throws on error (non-204/200)", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.deleteActiveFile()).rejects.toThrow(ObsidianApiError);
  });

  it("deleteActiveFile silently handles 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());
    await expect(client.deleteActiveFile()).resolves.toBeUndefined();
  });

  it("appendActiveFile invalidates all cache", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.appendActiveFile("text");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchActiveFile invalidates all cache", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.patchActiveFile("text", {
      operation: "append",
      targetType: "heading",
      target: "Test",
    });
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("putActiveFile replaces content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putActiveFile("new content");
    expect(mockRequest).toHaveBeenCalledWith(
      "PUT",
      "/active/",
      expect.objectContaining({ body: "new content" }),
    );
  });

  it("putActiveFile invalidates all cache", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.putActiveFile("content");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("appendActiveFile appends content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendActiveFile("appended");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/active/",
      expect.objectContaining({ body: "appended" }),
    );
  });

  it("patchActiveFile patches with headers", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.patchActiveFile("text", {
      operation: "append",
      targetType: "heading",
      target: "Test",
    });
    expect(mockRequest).toHaveBeenCalledWith(
      "PATCH",
      "/active/",
      expect.any(Object),
    );
  });

  it("patchActiveFile retries with corrected heading on 400", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = {
      headings: ["My Heading"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchActiveFile("text", {
      operation: "append",
      targetType: "heading",
      target: "my heading",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = getCallHeaders(retryCall);
    expect(retryHeaders["Target"]).toBe("My Heading");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchActiveFile throws original error when retry finds no match", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Unrelated"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      });

    await expect(
      client.patchActiveFile("text", {
        operation: "append",
        targetType: "heading",
        target: "Missing",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("deleteActiveFile deletes", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deleteActiveFile();
    expect(mockRequest).toHaveBeenCalledWith("DELETE", "/active/");
  });

  it("deleteActiveFile invalidates all cache", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.deleteActiveFile();
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  // --- Stryker mutation backfill: request shape, status acceptance, retry logic ---

  // Reset spies + debug flag between tests so log-text and call-count
  // assertions don't accumulate state from earlier active-file tests.
  afterEach(() => {
    vi.restoreAllMocks();
    setDebugEnabled(false);
  });

  it("getActiveFile sends GET to /active/ with Accept header for markdown", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "# active",
    });

    await client.getActiveFile("markdown");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("GET");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/active/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Accept"]).toBe("text/markdown");
  });

  it("getActiveFile sends Accept header for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", path: "n.md", tags: [], stat: {} }),
    });

    await client.getActiveFile("json");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Accept"]).toBe("application/vnd.olrapi.note+json");
  });

  it("putActiveFile sends PUT to /active/ with Content-Type: text/markdown", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putActiveFile("body");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("PUT");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/active/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("putActiveFile accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(client.putActiveFile("body")).resolves.toBeUndefined();
  });

  it("appendActiveFile sends POST to /active/ with Content-Type: text/markdown", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendActiveFile("body");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/active/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("appendActiveFile accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(client.appendActiveFile("body")).resolves.toBeUndefined();
  });

  it("patchActiveFile sends PATCH to /active/ and strips Create-Target-If-Missing even when buildPatchHeaders would set it", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    // Seed the header by patching buildPatchHeaders to include it. Without this
    // seeding, the strip mutant survives because nothing produces the header in
    // the first place (the active-file public API has Omit<PatchOptions, "createIfMissing">).
    const originalBuild = (
      client as unknown as Record<
        string,
        (options: unknown) => Record<string, string>
      >
    )["buildPatchHeaders"]?.bind(client);
    if (!originalBuild) throw new Error("buildPatchHeaders not found");
    (
      client as unknown as Record<
        string,
        (options: unknown) => Record<string, string>
      >
    )["buildPatchHeaders"] = (options: unknown) => {
      const h = originalBuild(options);
      h["Create-Target-If-Missing"] = "true";
      return h;
    };

    await client.patchActiveFile("body", {
      operation: "append",
      targetType: "heading",
      target: "H",
    });
    expect(mockRequest.mock.calls[0]?.[0]).toBe("PATCH");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/active/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    // Active file PATCH must never include Create-Target-If-Missing (REST API doesn't support it).
    // Seeded above, then patchActiveFile's `delete headers[...]` should remove it.
    expect(headers["Create-Target-If-Missing"]).toBeUndefined();
  });

  it("patchActiveFile accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.patchActiveFile("body", {
        operation: "append",
        targetType: "heading",
        target: "H",
      }),
    ).resolves.toBeUndefined();
  });

  it("patchActiveFile invalidates cache on success", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.patchActiveFile("body", {
      operation: "append",
      targetType: "heading",
      target: "H",
    });
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchActiveFile retry passes '(active file)' as the label arg to retryPatchWithMapLookup (visible in retry debug log)", async () => {
    setDebugEnabled(true);
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchActiveFile("body", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    // The label arg is rendered by retryPatchWithMapLookup's debug log
    // (`PATCH retry: heading "..." → "..." in ${label}`), not the
    // caller-side auto-corrected log (which has "(active file)" hardcoded).
    // Asserting on the retry log proves the label parameter is actually plumbed.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const retryLog = calls.find((c) => c.includes("PATCH retry: heading"));
    expect(retryLog).toContain("(active file)");
  });

  it("patchActiveFile retry passes /active/ as the patch path (not a vault path)", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchActiveFile("body", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    // Third call (retry PATCH) must hit /active/, not a /vault/* path
    expect(mockRequest.mock.calls[2]?.[0]).toBe("PATCH");
    expect(mockRequest.mock.calls[2]?.[1]).toBe("/active/");
  });

  it("patchActiveFile does NOT retry when targetType is not 'heading'", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"heading not found"}',
    });

    await expect(
      client.patchActiveFile("body", {
        operation: "append",
        targetType: "block",
        target: "block-id",
      }),
    ).rejects.toThrow(ObsidianApiError);

    // Only 1 call — no retry because targetType is "block"
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("patchActiveFile does NOT retry when 400 body is not a heading-not-found error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      // 400 with a body that doesn't match the heading-not-found pattern
      body: '{"message":"invalid frontmatter"}',
    });

    await expect(
      client.patchActiveFile("body", {
        operation: "append",
        targetType: "heading",
        target: "Some Heading",
      }),
    ).rejects.toThrow(ObsidianApiError);

    // Only 1 call — no retry because the 400 body isn't a heading-not-found error
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("deleteActiveFile sends DELETE to /active/", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deleteActiveFile();
    expect(mockRequest.mock.calls[0]?.[0]).toBe("DELETE");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/active/");
  });

  it("deleteActiveFile accepts 200 OK in addition to 204 and 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(client.deleteActiveFile()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — Commands
// ---------------------------------------------------------------------------
describe("ObsidianClient — commands", () => {
  it("listCommands returns command list", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(
      okJson({ commands: [{ id: "cmd:test", name: "Test" }] }),
    );

    const result = await client.listCommands();
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.id).toBe("cmd:test");
  });

  it("executeCommand calls correct endpoint", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.executeCommand("editor:toggle-bold");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/commands/editor%3Atoggle-bold/",
    );
  });

  it("listCommands throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.listCommands()).rejects.toThrow(ObsidianApiError);
  });

  it("executeCommand throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.executeCommand("nonexistent:cmd")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  // --- Stryker mutation backfill: commands ---

  it("listCommands sends GET to /commands/", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson({ commands: [] }));

    await client.listCommands();
    expect(mockRequest.mock.calls[0]?.[0]).toBe("GET");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/commands/");
  });

  it("executeCommand accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.executeCommand("editor:toggle-bold"),
    ).resolves.toBeUndefined();
  });

  it("executeCommand invalidates the cache after success", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.executeCommand("editor:toggle-bold");
    // Commands may modify any vault file → invalidateAll, not invalidate(path).
    expect(mockCache.invalidateAll).toHaveBeenCalled();
    expect(mockCache.invalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — openFile
// ---------------------------------------------------------------------------
describe("ObsidianClient — openFile", () => {
  it("opens file without newLeaf", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.openFile("note.md");
    expect(mockRequest).toHaveBeenCalledWith("POST", "/open/note.md");
  });

  it("opens file with newLeaf query param", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.openFile("note.md", true);
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/open/note.md?newLeaf=true",
    );
  });

  it("throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.openFile("note.md")).rejects.toThrow(ObsidianApiError);
  });

  // --- Stryker mutation backfill: openFile ---

  it("openFile accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(client.openFile("note.md")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — Search
// ---------------------------------------------------------------------------
describe("ObsidianClient — search", () => {
  it("simpleSearch calls correct endpoint with 2x timeout", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([{ filename: "note.md", score: 1 }]));

    const result = await client.simpleSearch("test");
    expect(result).toHaveLength(1);
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/search/simple/"),
      expect.objectContaining({ timeoutMultiplier: 2 }),
    );
  });

  it("complexSearch sends JsonLogic body", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    const query = { glob: [{ var: "path" }, "*.md"] };
    await client.complexSearch(query);
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/search/",
      expect.objectContaining({
        body: JSON.stringify(query),
        timeoutMultiplier: 2,
      }),
    );
  });

  it("dataviewSearch sends DQL body", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.dataviewSearch('LIST FROM ""');
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/search/",
      expect.objectContaining({
        body: 'LIST FROM ""',
        timeoutMultiplier: 2,
      }),
    );
  });

  it("simpleSearch throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.simpleSearch("test")).rejects.toThrow(ObsidianApiError);
  });

  it("complexSearch throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.complexSearch({})).rejects.toThrow(ObsidianApiError);
  });

  it("dataviewSearch throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.dataviewSearch("LIST")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("simpleSearch passes contextLength parameter", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.simpleSearch("test", 200);
    const calledPath = mockRequest.mock.calls[0]?.[1] as string;
    expect(calledPath).toContain("contextLength=200");
  });

  // --- Stryker mutation backfill: search trio + getServerStatus ---

  it("simpleSearch sends Content-Type: text/plain with empty body", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.simpleSearch("test");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/search/simple/"),
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "text/plain" }),
        body: "",
      }),
    );
  });

  it("simpleSearch defaults contextLength to 100 when omitted", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.simpleSearch("test");
    const calledPath = mockRequest.mock.calls[0]?.[1] as string;
    expect(calledPath).toContain("contextLength=100");
  });

  it("simpleSearch URL-encodes the query parameter", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.simpleSearch("hello world & foo");
    const calledPath = mockRequest.mock.calls[0]?.[1] as string;
    // URLSearchParams encodes space as "+" and "&" as "%26"
    expect(calledPath).toContain("query=hello+world+%26+foo");
  });

  it("complexSearch sends Content-Type: application/vnd.olrapi.jsonlogic+json", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.complexSearch({ glob: ["*.md"] });
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/search/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/vnd.olrapi.jsonlogic+json",
        }),
      }),
    );
  });

  it("dataviewSearch sends Content-Type: application/vnd.olrapi.dataview.dql+txt", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.dataviewSearch('LIST FROM ""');
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/search/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/vnd.olrapi.dataview.dql+txt",
        }),
      }),
    );
  });

  it("dataviewSearch passes the DQL string verbatim as the body", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    const dql = 'TABLE status FROM "folder" WHERE status = "active"';
    await client.dataviewSearch(dql);
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/search/",
      expect.objectContaining({ body: dql }),
    );
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — Periodic Notes (Current)
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodic notes (current)", () => {
  it("getPeriodicNote returns content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "daily note content",
    });

    const result = await client.getPeriodicNote("daily");
    expect(result).toBe("daily note content");
  });

  it("getPeriodicNote returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = {
      content: "x",
      frontmatter: {},
      path: "x.md",
      tags: [],
      stat: { ctime: 0, mtime: 0, size: 1 },
    };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getPeriodicNote("daily", "json");
    expect(result).toEqual(noteJson);
  });

  it("getPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.getPeriodicNote("daily")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("putPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.putPeriodicNote("daily", "content")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("appendPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.appendPeriodicNote("daily", "content")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("patchPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(
      client.patchPeriodicNote("daily", "text", {
        operation: "append",
        targetType: "heading",
        target: "Test",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("deletePeriodicNote throws on non-204/200/404 error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(client.deletePeriodicNote("daily")).rejects.toThrow(
      ObsidianApiError,
    );
  });

  it("putPeriodicNote writes content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putPeriodicNote("daily", "new content");
    expect(mockRequest).toHaveBeenCalledWith(
      "PUT",
      "/periodic/daily/",
      expect.objectContaining({ body: "new content" }),
    );
  });

  it("appendPeriodicNote appends", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendPeriodicNote("weekly", "appended");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/periodic/weekly/",
      expect.objectContaining({ body: "appended" }),
    );
  });

  it("patchPeriodicNote patches", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.patchPeriodicNote("monthly", "text", {
      operation: "append",
      targetType: "heading",
      target: "Summary",
    });
    expect(mockRequest).toHaveBeenCalledWith(
      "PATCH",
      "/periodic/monthly/",
      expect.any(Object),
    );
  });

  it("patchPeriodicNote retries with corrected heading on 400", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Summary"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchPeriodicNote("monthly", "text", {
      operation: "append",
      targetType: "heading",
      target: "summary",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = getCallHeaders(retryCall);
    expect(retryHeaders["Target"]).toBe("Summary");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchPeriodicNote throws original error when retry finds no match", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Unrelated"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      });

    await expect(
      client.patchPeriodicNote("daily", "text", {
        operation: "append",
        targetType: "heading",
        target: "Missing",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("deletePeriodicNote deletes", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deletePeriodicNote("daily");
    expect(mockRequest).toHaveBeenCalledWith("DELETE", "/periodic/daily/");
  });

  it("deletePeriodicNote silently handles 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.deletePeriodicNote("daily")).resolves.toBeUndefined();
  });

  it("periodic note operations invalidate all cache", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.putPeriodicNote("daily", "content");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — Periodic Notes (By Date)
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodic notes (by date)", () => {
  it("getPeriodicNoteForDate returns content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "date note",
    });

    const result = await client.getPeriodicNoteForDate("daily", 2026, 3, 14);
    expect(result).toBe("date note");
    expect(mockRequest).toHaveBeenCalledWith(
      "GET",
      "/periodic/daily/2026/03/14/",
      expect.any(Object),
    );
  });

  it("getPeriodicNoteForDate returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = {
      content: "x",
      frontmatter: {},
      path: "x.md",
      tags: [],
      stat: { ctime: 0, mtime: 0, size: 1 },
    };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getPeriodicNoteForDate(
      "daily",
      2026,
      1,
      1,
      "json",
    );
    expect(result).toEqual(noteJson);
  });

  it("getPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(
      client.getPeriodicNoteForDate("daily", 2026, 1, 1),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("putPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(
      client.putPeriodicNoteForDate("daily", 2026, 1, 1, "content"),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("appendPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(
      client.appendPeriodicNoteForDate("daily", 2026, 1, 1, "text"),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("patchPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(
      client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "text", {
        operation: "append",
        targetType: "heading",
        target: "Test",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("deletePeriodicNoteForDate throws on non-204/200/404 error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: "error",
    });

    await expect(
      client.deletePeriodicNoteForDate("daily", 2026, 1, 1),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("putPeriodicNoteForDate invalidates all cache", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.putPeriodicNoteForDate("daily", 2026, 1, 1, "content");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("putPeriodicNoteForDate writes", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putPeriodicNoteForDate("daily", 2026, 1, 5, "content");
    expect(mockRequest).toHaveBeenCalledWith(
      "PUT",
      "/periodic/daily/2026/01/05/",
      expect.objectContaining({ body: "content" }),
    );
  });

  it("appendPeriodicNoteForDate appends", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendPeriodicNoteForDate("weekly", 2026, 12, 31, "appended");
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/periodic/weekly/2026/12/31/",
      expect.objectContaining({ body: "appended" }),
    );
  });

  it("patchPeriodicNoteForDate patches", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.patchPeriodicNoteForDate("monthly", 2026, 6, 15, "text", {
      operation: "replace",
      targetType: "frontmatter",
      target: "status",
    });
    expect(mockRequest).toHaveBeenCalledWith(
      "PATCH",
      "/periodic/monthly/2026/06/15/",
      expect.any(Object),
    );
  });

  it("patchPeriodicNoteForDate retries with corrected heading on 400", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchPeriodicNoteForDate("daily", 2026, 3, 16, "text", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = getCallHeaders(retryCall);
    expect(retryHeaders["Target"]).toBe("Tasks");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchPeriodicNoteForDate throws original error when retry finds no match", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Unrelated"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      });

    await expect(
      client.patchPeriodicNoteForDate("daily", 2026, 3, 16, "text", {
        operation: "append",
        targetType: "heading",
        target: "Missing",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("deletePeriodicNoteForDate deletes", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deletePeriodicNoteForDate("yearly", 2026, 1, 1);
    expect(mockRequest).toHaveBeenCalledWith(
      "DELETE",
      "/periodic/yearly/2026/01/01/",
    );
  });

  it("deletePeriodicNoteForDate silently handles 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(
      client.deletePeriodicNoteForDate("daily", 2026, 1, 1),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — periodic notes (by date) — Stryker backfill
// (separate describe block so the afterEach hook here does not interfere
// with the existing "(by date)" describe block above — Greptile P2 on PR #55)
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodic notes (by date) — Stryker backfill", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDebugEnabled(false);
  });

  it("getPeriodicNoteForDate sends GET to /periodic/<period>/<y>/<m>/<d>/ with Accept: text/markdown for markdown format", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "body",
    });

    await client.getPeriodicNoteForDate("daily", 2026, 1, 1, "markdown");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("GET");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/periodic/daily/2026/01/01/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Accept"]).toBe("text/markdown");
  });

  it("getPeriodicNoteForDate sends Accept: vnd.olrapi.note+json for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", path: "n.md", tags: [], stat: {} }),
    });

    await client.getPeriodicNoteForDate("daily", 2026, 1, 1, "json");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Accept"]).toBe("application/vnd.olrapi.note+json");
  });

  it("putPeriodicNoteForDate sends Content-Type: text/markdown", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putPeriodicNoteForDate("daily", 2026, 1, 1, "body");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("putPeriodicNoteForDate accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.putPeriodicNoteForDate("daily", 2026, 1, 1, "body"),
    ).resolves.toBeUndefined();
  });

  it("appendPeriodicNoteForDate sends Content-Type: text/markdown", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendPeriodicNoteForDate("daily", 2026, 1, 1, "body");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("appendPeriodicNoteForDate accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.appendPeriodicNoteForDate("daily", 2026, 1, 1, "body"),
    ).resolves.toBeUndefined();
  });

  it("patchPeriodicNoteForDate accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "body", {
        operation: "append",
        targetType: "heading",
        target: "H",
      }),
    ).resolves.toBeUndefined();
  });

  it("patchPeriodicNoteForDate invalidates all cache on success", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "body", {
      operation: "append",
      targetType: "heading",
      target: "H",
    });
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchPeriodicNoteForDate retry rebuilds full request (PATCH + date path + corrected Target) and label '(periodic: daily date)' is rendered", async () => {
    setDebugEnabled(true);
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "body", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    // Retry request shape — kills mutants on the retry path/method/Target args
    // independently of the log assertion (per Gemini feedback on PR #55).
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(mockRequest.mock.calls[2]?.[0]).toBe("PATCH");
    expect(mockRequest.mock.calls[2]?.[1]).toBe("/periodic/daily/2026/01/01/");
    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Target"]).toBe("Tasks");

    // Label is rendered in the retryPatchWithMapLookup debug log (not the
    // caller-side auto-corrected log which has the string hardcoded).
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const retryLog = calls.find((c) => c.includes("PATCH retry: heading"));
    expect(retryLog).toContain("(periodic: daily date)");
  });

  it("patchPeriodicNoteForDate does NOT retry when targetType is not 'heading'", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"heading not found"}',
    });

    await expect(
      client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "body", {
        operation: "append",
        targetType: "block",
        target: "block-id",
      }),
    ).rejects.toThrow(ObsidianApiError);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("patchPeriodicNoteForDate does NOT retry when 400 body is not heading-not-found", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"invalid frontmatter"}',
    });

    await expect(
      client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "body", {
        operation: "append",
        targetType: "heading",
        target: "Some Heading",
      }),
    ).rejects.toThrow(ObsidianApiError);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("deletePeriodicNoteForDate accepts 200 OK in addition to 204 and 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.deletePeriodicNoteForDate("daily", 2026, 1, 1),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — periodic notes (current) — Stryker backfill
// (separate describe block so the afterEach hook here does not interfere
// with the existing "periodic notes (current)" describe at line ~2660)
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodic notes (current) — Stryker backfill", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDebugEnabled(false);
  });

  it("getPeriodicNote sends Accept: text/markdown header for markdown format", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "body",
    });

    await client.getPeriodicNote("daily", "markdown");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Accept"]).toBe("text/markdown");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("GET");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/periodic/daily/");
  });

  it("getPeriodicNote sends Accept: vnd.olrapi.note+json for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", path: "n.md", tags: [], stat: {} }),
    });

    await client.getPeriodicNote("daily", "json");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Accept"]).toBe("application/vnd.olrapi.note+json");
  });

  it("putPeriodicNote sends Content-Type: text/markdown to /periodic/<period>/", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.putPeriodicNote("daily", "body");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("PUT");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/periodic/daily/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("putPeriodicNote accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.putPeriodicNote("daily", "body"),
    ).resolves.toBeUndefined();
  });

  it("appendPeriodicNote sends Content-Type: text/markdown via POST", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.appendPeriodicNote("daily", "body");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/periodic/daily/");
    const headers = getCallHeaders(mockRequest.mock.calls[0]);
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("appendPeriodicNote accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.appendPeriodicNote("daily", "body"),
    ).resolves.toBeUndefined();
  });

  it("patchPeriodicNote accepts 200 OK in addition to 204", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(
      client.patchPeriodicNote("daily", "body", {
        operation: "append",
        targetType: "heading",
        target: "H",
      }),
    ).resolves.toBeUndefined();
  });

  it("patchPeriodicNote invalidates all cache on success", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);

    await client.patchPeriodicNote("daily", "body", {
      operation: "append",
      targetType: "heading",
      target: "H",
    });
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("patchPeriodicNote retry rebuilds full request (PATCH + current-period path + corrected Target) and label '(periodic: daily)' is rendered", async () => {
    setDebugEnabled(true);
    const stderrSpy = spyOnStderr();
    const { client, mockRequest } = createMockedClient();
    const docMap = {
      headings: ["Tasks"],
      blocks: [],
      frontmatterFields: [],
    };
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: '{"message":"heading not found"}',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docMap),
      })
      .mockResolvedValueOnce(ok204());

    await client.patchPeriodicNote("daily", "body", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    // Retry request shape (per Gemini feedback on PR #55) — kills mutants
    // on the retry path/method/Target args independently of the log line.
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(mockRequest.mock.calls[2]?.[0]).toBe("PATCH");
    expect(mockRequest.mock.calls[2]?.[1]).toBe("/periodic/daily/");
    const retryHeaders = getCallHeaders(mockRequest.mock.calls[2]);
    expect(retryHeaders["Target"]).toBe("Tasks");

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const retryLog = calls.find((c) => c.includes("PATCH retry: heading"));
    expect(retryLog).toContain("(periodic: daily)");
  });

  it("patchPeriodicNote does NOT retry when targetType is not 'heading'", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"heading not found"}',
    });

    await expect(
      client.patchPeriodicNote("daily", "body", {
        operation: "append",
        targetType: "block",
        target: "block-id",
      }),
    ).rejects.toThrow(ObsidianApiError);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("patchPeriodicNote does NOT retry when 400 body is not heading-not-found", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: '{"message":"invalid frontmatter"}',
    });

    await expect(
      client.patchPeriodicNote("daily", "body", {
        operation: "append",
        targetType: "heading",
        target: "Some Heading",
      }),
    ).rejects.toThrow(ObsidianApiError);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("deletePeriodicNote sends DELETE to /periodic/<period>/", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deletePeriodicNote("daily");
    expect(mockRequest.mock.calls[0]?.[0]).toBe("DELETE");
    expect(mockRequest.mock.calls[0]?.[1]).toBe("/periodic/daily/");
  });

  it("deletePeriodicNote accepts 200 OK in addition to 204 and 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: "",
    });

    await expect(client.deletePeriodicNote("daily")).resolves.toBeUndefined();
  });
});
