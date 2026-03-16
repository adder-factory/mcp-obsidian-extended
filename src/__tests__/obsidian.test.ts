import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  sanitizeFilePath,
  textResult,
  errorResult,
  jsonResult,
  ObsidianClient,
} from "../obsidian.js";
import type { ToolResult } from "../obsidian.js";
import { ObsidianApiError, ObsidianAuthError } from "../errors.js";
import type { Config } from "../config.js";

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
    expect(() => sanitizeFilePath("../secret.md")).toThrow("Path traversal not allowed");
    expect(() => sanitizeFilePath("notes/../../etc/passwd")).toThrow("Path traversal not allowed");
    expect(() => sanitizeFilePath("notes/sub/../../../bad")).toThrow("Path traversal not allowed");
  });

  it("allows .. in filenames (not as path segments)", () => {
    // "version..2.md" should be allowed because ".." is part of the filename, not a segment
    expect(sanitizeFilePath("version..2.md")).toBe("version..2.md");
    expect(sanitizeFilePath("notes/file..name.md")).toBe("notes/file..name.md");
  });

  it("rejects absolute Unix paths", () => {
    expect(() => sanitizeFilePath("/etc/passwd")).toThrow("Absolute paths not allowed");
    expect(() => sanitizeFilePath("/notes/test.md")).toThrow("Absolute paths not allowed");
  });

  it("rejects absolute Windows paths", () => {
    expect(() => sanitizeFilePath("C:\\Users\\test")).toThrow("Absolute paths not allowed");
    expect(() => sanitizeFilePath("D:file.md")).toThrow("Absolute paths not allowed");
  });

  it("allows paths with spaces", () => {
    expect(sanitizeFilePath("my notes/test file.md")).toBe("my notes/test file.md");
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
      new ObsidianClient(makeConfig({
        scheme: "https",
        certPath: "/nonexistent/cert.pem",
      }));
    }).toThrow("Failed to read TLS certificate");
  });

  it("creates client with verifySsl=true (no certPath)", () => {
    const client = new ObsidianClient(makeConfig({ scheme: "https", verifySsl: true }));
    expect(client).toBeInstanceOf(ObsidianClient);
  });

  it("creates client with verifySsl=false and no certPath (self-signed)", () => {
    const client = new ObsidianClient(makeConfig({ scheme: "https", verifySsl: false }));
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
    const parse = (client as unknown as Record<string, (body: string, path: string) => unknown>)["parseJsonResponse"];
    const result = parse.call(client, '{"ok":true}', "/test");
    expect(result).toEqual({ ok: true });
  });

  it("throws ObsidianApiError on invalid JSON", () => {
    const client = new ObsidianClient(makeConfig());
    const parse = (client as unknown as Record<string, (body: string, path: string) => unknown>)["parseJsonResponse"];
    expect(() => parse.call(client, "not json", "/test")).toThrow(ObsidianApiError);
  });
});

describe("ObsidianClient — handleErrorResponse", () => {
  it("throws ObsidianAuthError for 401", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (client as unknown as Record<string, (code: number, body: string, path: string) => never>)["handleErrorResponse"];
    expect(() => handle.call(client, 401, "", "/test")).toThrow(ObsidianAuthError);
  });

  it("throws ObsidianAuthError for 403", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (client as unknown as Record<string, (code: number, body: string, path: string) => never>)["handleErrorResponse"];
    expect(() => handle.call(client, 403, "", "/test")).toThrow(ObsidianAuthError);
  });

  it("throws ObsidianApiError for other codes", () => {
    const client = new ObsidianClient(makeConfig());
    const handle = (client as unknown as Record<string, (code: number, body: string, path: string) => never>)["handleErrorResponse"];
    try {
      handle.call(client, 500, '{"message":"Internal error","errorCode":99}', "/test");
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
    const handle = (client as unknown as Record<string, (code: number, body: string, path: string) => never>)["handleErrorResponse"];
    try {
      handle.call(client, 500, "raw error text", "/test");
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
    const truncate = (client as unknown as Record<string, (text: string) => string>)["truncateResponse"];
    expect(truncate.call(client, "short")).toBe("short");
  });

  it("truncates text exceeding maxResponseChars", () => {
    const client = new ObsidianClient(makeConfig({ maxResponseChars: 10 }));
    const truncate = (client as unknown as Record<string, (text: string) => string>)["truncateResponse"];
    const result = truncate.call(client, "a".repeat(100));
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("[TRUNCATED");
    expect(result).toContain("10 characters");
  });

  it("does not truncate when maxResponseChars is 0 (disabled)", () => {
    const client = new ObsidianClient(makeConfig({ maxResponseChars: 0 }));
    const truncate = (client as unknown as Record<string, (text: string) => string>)["truncateResponse"];
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
    const withFileLock = (client as unknown as Record<string, <T>(path: string, fn: () => Promise<T>) => Promise<T>>)["withFileLock"];

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
    const withFileLock = (client as unknown as Record<string, <T>(path: string, fn: () => Promise<T>) => Promise<T>>)["withFileLock"];

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
    const encodePath = (client as unknown as Record<string, (path: string) => string>)["encodePath"];
    const result = encodePath.call(client, "my notes/test file.md");
    expect(result).toBe("my%20notes/test%20file.md");
  });

  it("handles paths with special characters", () => {
    const client = new ObsidianClient(makeConfig());
    const encodePath = (client as unknown as Record<string, (path: string) => string>)["encodePath"];
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
    const build = (client as unknown as Record<string, (o: Record<string, unknown>) => Record<string, string>>)["buildPatchHeaders"];
    return build.call(client, opts);
  }

  /** Helper: builds patch headers for a given target and returns the Target header value. */
  function targetHeader(target: string): string {
    return buildHeaders({ operation: "append", targetType: "heading", target, contentType: "markdown" })["Target"] ?? "";
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
    expect(targetHeader("Notizen über Bücher")).toBe("Notizen %C3%BCber B%C3%BCcher");
  });

  it("encodes emoji in Target header for HTTP safety", () => {
    expect(targetHeader("📝 Notes")).toBe("%F0%9F%93%9D Notes");
  });

  it("preserves spaces in Target header", () => {
    expect(targetHeader("My Long Heading")).toBe("My Long Heading");
  });

  it("encodes fully non-ASCII heading (CJK)", () => {
    expect(targetHeader("日本語の見出し")).toBe("%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%AE%E8%A6%8B%E5%87%BA%E3%81%97");
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
});

// ---------------------------------------------------------------------------
// ObsidianClient — periodicDatePath
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodicDatePath", () => {
  it("builds correct path with zero-padded month and day", () => {
    const client = new ObsidianClient(makeConfig());
    const buildPath = (client as unknown as Record<string, (period: string, y: number, m: number, d: number) => string>)["periodicDatePath"];
    expect(buildPath.call(client, "daily", 2026, 3, 5)).toBe("/periodic/daily/2026/03/05/");
  });

  it("does not pad already two-digit month/day", () => {
    const client = new ObsidianClient(makeConfig());
    const buildPath = (client as unknown as Record<string, (period: string, y: number, m: number, d: number) => string>)["periodicDatePath"];
    expect(buildPath.call(client, "weekly", 2026, 12, 25)).toBe("/periodic/weekly/2026/12/25/");
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
type RequestResult = { statusCode: number; headers: Record<string, string>; body: string };

function createMockedClient(
  overrides: Partial<Config> = {},
): { client: ObsidianClient; mockRequest: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<RequestResult>>> } {
  const client = new ObsidianClient(makeConfig(overrides));
  const mockRequest = vi.fn<(...args: unknown[]) => Promise<RequestResult>>();
  (client as unknown as Record<string, unknown>)["request"] = mockRequest;
  return { client, mockRequest };
}

function okJson(data: unknown): RequestResult {
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
}

function ok204(): RequestResult {
  return { statusCode: 204, headers: {}, body: "" };
}

function notFound(msg = "Not found"): RequestResult {
  return { statusCode: 404, headers: {}, body: JSON.stringify({ message: msg }) };
}

// ---------------------------------------------------------------------------
// ObsidianClient — getServerStatus
// ---------------------------------------------------------------------------
describe("ObsidianClient — getServerStatus", () => {
  it("returns server status on success", async () => {
    const { client, mockRequest } = createMockedClient();
    const status = { ok: true, service: "obsidian", authenticated: true, versions: {} };
    mockRequest.mockResolvedValue(okJson(status));

    const result = await client.getServerStatus();
    expect(result).toEqual(status);
    expect(mockRequest).toHaveBeenCalledWith("GET", "/", { auth: false });
  });

  it("throws on non-200 status", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: '{"message":"error"}' });

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
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

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
    mockRequest.mockResolvedValueOnce(okJson({ files: ["emptydir/nested.md"] }));

    const result = await client.listFilesInDir("emptydir");
    expect(result.files).toEqual([]);
  });

  it("throws 404 for non-existent dir", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce(notFound());
    mockRequest.mockResolvedValueOnce(okJson({ files: ["other/note.md"] }));

    await expect(client.listFilesInDir("nonexistent")).rejects.toThrow(ObsidianApiError);
  });

  it("throws on non-200, non-404 error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: '{"message":"error"}' });

    await expect(client.listFilesInDir("folder")).rejects.toThrow(ObsidianApiError);
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — getFileContents
// ---------------------------------------------------------------------------
describe("ObsidianClient — getFileContents", () => {
  it("returns markdown content by default", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: "# Hello" });

    const result = await client.getFileContents("note.md");
    expect(result).toBe("# Hello");
  });

  it("returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = { content: "hello", frontmatter: {}, path: "note.md", tags: [], stat: { ctime: 0, mtime: 0, size: 5 } };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getFileContents("note.md", "json");
    expect(result).toEqual(noteJson);
  });

  it("returns document map for map format", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["# Title"], blocks: [], frontmatterFields: ["date"] };
    mockRequest.mockResolvedValue(okJson(docMap));

    const result = await client.getFileContents("note.md", "map");
    expect(result).toEqual(docMap);
  });

  it("truncates long markdown responses", async () => {
    const { client, mockRequest } = createMockedClient({ maxResponseChars: 50 });
    mockRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: "x".repeat(200) });

    const result = await client.getFileContents("note.md", "markdown");
    expect(typeof result).toBe("string");
    expect((result as string)).toContain("[TRUNCATED");
  });

  it("throws on error status", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.getFileContents("missing.md")).rejects.toThrow(ObsidianApiError);
  });

  it("tries case-insensitive fallback on 404", async () => {
    const { client, mockRequest } = createMockedClient();
    // First request: 404
    mockRequest.mockResolvedValueOnce(notFound());
    // Directory listing for case-insensitive fallback
    mockRequest.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: JSON.stringify({ files: ["Notes/myfile.md"] }) });
    // Retry with corrected path: 200
    mockRequest.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: "found it" });

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
    mockRequest.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: "correct content" });

    await client.putContent("note.md", "correct content");
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("warns on write verification mismatch", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: "different content" });

    await client.putContent("note.md", "expected content");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Write verification failed"))).toBe(true);
  });

  it("warns on write verification read failure", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client, mockRequest } = createMockedClient({ verifyWrites: true });
    mockRequest.mockResolvedValueOnce(ok204());
    mockRequest.mockRejectedValueOnce(new Error("read failed"));

    await client.putContent("note.md", "content");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Write verification could not read back"))).toBe(true);
  });

  it("throws on error status", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: '{"message":"fail"}' });

    await expect(client.putContent("note.md", "content")).rejects.toThrow(ObsidianApiError);
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
    const docMap = { headings: ["Introduction", "Tasks List", "Conclusion"], blocks: [], frontmatterFields: [] };
    // First PATCH returns 400 (heading not found), then GET returns doc map, then retry PATCH returns 204
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"heading not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "new text", {
      operation: "append",
      targetType: "heading",
      target: "tasks list",  // case mismatch — should match "Tasks List"
    });

    // Verify 3 requests: original PATCH, GET for map, retry PATCH
    expect(mockRequest).toHaveBeenCalledTimes(3);
    // Retry PATCH should use the corrected heading
    const retryCall = mockRequest.mock.calls[2];
    expect(retryCall?.[0]).toBe("PATCH");
    const retryHeaders = (retryCall?.[2] as Record<string, unknown>)?.["headers"] as Record<string, string> | undefined;
    expect(retryHeaders?.["Target"]).toBe("Tasks List");
  });

  it("throws original error when retry finds no matching heading", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["Introduction", "Conclusion"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"heading not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) });

    await expect(
      client.patchContent("note.md", "text", {
        operation: "append",
        targetType: "heading",
        target: "Nonexistent Heading",
      }),
    ).rejects.toThrow(ObsidianApiError);
  });

  it("does not retry when leaf match is ambiguous", async () => {
    const { client, mockRequest } = createMockedClient();
    const docMap = { headings: ["Project A::Tasks", "Project B::Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"heading not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) });

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

  it("does not retry on 400 for non-heading targets", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"bad request"}' });

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

  it("invalidates cache after successful retry", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) })
      .mockResolvedValueOnce(ok204());

    await client.patchContent("note.md", "text", {
      operation: "append",
      targetType: "heading",
      target: "tasks",
    });

    expect(mockCache.invalidate).toHaveBeenCalledWith("note.md");
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
    mockRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: "active content" });

    const result = await client.getActiveFile();
    expect(result).toBe("active content");
  });

  it("getActiveFile returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = { content: "x", frontmatter: {}, path: "x.md", tags: [], stat: { ctime: 0, mtime: 0, size: 1 } };
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
    mockRequest.mockResolvedValue({ statusCode: 404, headers: {}, body: '{"message":"no active file"}' });

    await expect(client.getActiveFile()).rejects.toThrow(ObsidianApiError);
  });

  it("putActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.putActiveFile("content")).rejects.toThrow(ObsidianApiError);
  });

  it("appendActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.appendActiveFile("content")).rejects.toThrow(ObsidianApiError);
  });

  it("patchActiveFile throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.patchActiveFile("text", {
      operation: "append",
      targetType: "heading",
      target: "Test",
    })).rejects.toThrow(ObsidianApiError);
  });

  it("deleteActiveFile throws on error (non-204/200)", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.deleteActiveFile()).rejects.toThrow(ObsidianApiError);
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
    expect(mockRequest).toHaveBeenCalledWith("PATCH", "/active/", expect.any(Object));
  });

  it("patchActiveFile retries with corrected heading on 400", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["My Heading"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) })
      .mockResolvedValueOnce(ok204());

    await client.patchActiveFile("text", { operation: "append", targetType: "heading", target: "my heading" });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = (retryCall?.[2] as Record<string, unknown>)?.["headers"] as Record<string, string> | undefined;
    expect(retryHeaders?.["Target"]).toBe("My Heading");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
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
});

// ---------------------------------------------------------------------------
// ObsidianClient — Commands
// ---------------------------------------------------------------------------
describe("ObsidianClient — commands", () => {
  it("listCommands returns command list", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson({ commands: [{ id: "cmd:test", name: "Test" }] }));

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
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.listCommands()).rejects.toThrow(ObsidianApiError);
  });

  it("executeCommand throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.executeCommand("nonexistent:cmd")).rejects.toThrow(ObsidianApiError);
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
    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/open/note.md",
    );
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
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.openFile("note.md")).rejects.toThrow(ObsidianApiError);
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
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.simpleSearch("test")).rejects.toThrow(ObsidianApiError);
  });

  it("complexSearch throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.complexSearch({})).rejects.toThrow(ObsidianApiError);
  });

  it("dataviewSearch throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.dataviewSearch("LIST")).rejects.toThrow(ObsidianApiError);
  });

  it("simpleSearch passes contextLength parameter", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson([]));

    await client.simpleSearch("test", 200);
    const calledPath = mockRequest.mock.calls[0]?.[1] as string;
    expect(calledPath).toContain("contextLength=200");
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — Periodic Notes (Current)
// ---------------------------------------------------------------------------
describe("ObsidianClient — periodic notes (current)", () => {
  it("getPeriodicNote returns content", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: "daily note content" });

    const result = await client.getPeriodicNote("daily");
    expect(result).toBe("daily note content");
  });

  it("getPeriodicNote returns JSON for json format", async () => {
    const { client, mockRequest } = createMockedClient();
    const noteJson = { content: "x", frontmatter: {}, path: "x.md", tags: [], stat: { ctime: 0, mtime: 0, size: 1 } };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getPeriodicNote("daily", "json");
    expect(result).toEqual(noteJson);
  });

  it("getPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.getPeriodicNote("daily")).rejects.toThrow(ObsidianApiError);
  });

  it("putPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.putPeriodicNote("daily", "content")).rejects.toThrow(ObsidianApiError);
  });

  it("appendPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.appendPeriodicNote("daily", "content")).rejects.toThrow(ObsidianApiError);
  });

  it("patchPeriodicNote throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.patchPeriodicNote("daily", "text", {
      operation: "append",
      targetType: "heading",
      target: "Test",
    })).rejects.toThrow(ObsidianApiError);
  });

  it("deletePeriodicNote throws on non-204/200/404 error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.deletePeriodicNote("daily")).rejects.toThrow(ObsidianApiError);
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
    expect(mockRequest).toHaveBeenCalledWith("PATCH", "/periodic/monthly/", expect.any(Object));
  });

  it("patchPeriodicNote retries with corrected heading on 400", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Summary"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) })
      .mockResolvedValueOnce(ok204());

    await client.patchPeriodicNote("monthly", "text", {
      operation: "append", targetType: "heading", target: "summary",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = (retryCall?.[2] as Record<string, unknown>)?.["headers"] as Record<string, string> | undefined;
    expect(retryHeaders?.["Target"]).toBe("Summary");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
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
    mockRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: "date note" });

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
    const noteJson = { content: "x", frontmatter: {}, path: "x.md", tags: [], stat: { ctime: 0, mtime: 0, size: 1 } };
    mockRequest.mockResolvedValue(okJson(noteJson));

    const result = await client.getPeriodicNoteForDate("daily", 2026, 1, 1, "json");
    expect(result).toEqual(noteJson);
  });

  it("getPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.getPeriodicNoteForDate("daily", 2026, 1, 1)).rejects.toThrow(ObsidianApiError);
  });

  it("putPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.putPeriodicNoteForDate("daily", 2026, 1, 1, "content")).rejects.toThrow(ObsidianApiError);
  });

  it("appendPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.appendPeriodicNoteForDate("daily", 2026, 1, 1, "text")).rejects.toThrow(ObsidianApiError);
  });

  it("patchPeriodicNoteForDate throws on error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.patchPeriodicNoteForDate("daily", 2026, 1, 1, "text", {
      operation: "append",
      targetType: "heading",
      target: "Test",
    })).rejects.toThrow(ObsidianApiError);
  });

  it("deletePeriodicNoteForDate throws on non-204/200/404 error", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 500, headers: {}, body: "error" });

    await expect(client.deletePeriodicNoteForDate("daily", 2026, 1, 1)).rejects.toThrow(ObsidianApiError);
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
    expect(mockRequest).toHaveBeenCalledWith("PATCH", "/periodic/monthly/2026/06/15/", expect.any(Object));
  });

  it("patchPeriodicNoteForDate retries with corrected heading on 400", async () => {
    const { client, mockRequest } = createMockedClient();
    const mockCache = { invalidate: vi.fn(), invalidateAll: vi.fn() };
    client.setCache(mockCache);
    const docMap = { headings: ["Tasks"], blocks: [], frontmatterFields: [] };
    mockRequest
      .mockResolvedValueOnce({ statusCode: 400, headers: {}, body: '{"message":"not found"}' })
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(docMap) })
      .mockResolvedValueOnce(ok204());

    await client.patchPeriodicNoteForDate("daily", 2026, 3, 16, "text", {
      operation: "append", targetType: "heading", target: "tasks",
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    const retryCall = mockRequest.mock.calls[2];
    const retryHeaders = (retryCall?.[2] as Record<string, unknown>)?.["headers"] as Record<string, string> | undefined;
    expect(retryHeaders?.["Target"]).toBe("Tasks");
    expect(mockCache.invalidateAll).toHaveBeenCalled();
  });

  it("deletePeriodicNoteForDate deletes", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(ok204());

    await client.deletePeriodicNoteForDate("yearly", 2026, 1, 1);
    expect(mockRequest).toHaveBeenCalledWith("DELETE", "/periodic/yearly/2026/01/01/");
  });

  it("deletePeriodicNoteForDate silently handles 404", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(notFound());

    await expect(client.deletePeriodicNoteForDate("daily", 2026, 1, 1)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ObsidianClient — ensureConnection
// ---------------------------------------------------------------------------
describe("ObsidianClient — ensureConnection", () => {
  it("sets isConnected to true on success", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson({ ok: true, service: "obsidian", authenticated: true, versions: {} }));

    await client.ensureConnection();
    expect(client.getIsConnected()).toBe(true);
  });

  it("throws ObsidianConnectionError on failure", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockRejectedValue(new Error("network down"));

    await expect(client.ensureConnection()).rejects.toThrow("Cannot reach Obsidian");
    expect(client.getIsConnected()).toBe(false);
  });

  it("rethrows ObsidianAuthError", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue({ statusCode: 401, headers: {}, body: "" });

    await expect(client.ensureConnection()).rejects.toThrow(ObsidianAuthError);
  });

  it("skips health check when recently connected", async () => {
    const { client, mockRequest } = createMockedClient();
    mockRequest.mockResolvedValue(okJson({ ok: true, service: "obsidian", authenticated: true, versions: {} }));

    await client.ensureConnection();
    expect(mockRequest).toHaveBeenCalledTimes(1);

    // Second call should be cached
    await client.ensureConnection();
    expect(mockRequest).toHaveBeenCalledTimes(1); // no additional call
  });
});
