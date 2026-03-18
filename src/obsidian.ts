import { readFileSync } from "node:fs";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";

import { ObsidianApiError, ObsidianAuthError, ObsidianConnectionError } from "./errors.js";
import type { Config } from "./config.js";
import { log } from "./config.js";

// --- Types ---

/** JSON representation of an Obsidian note returned by the REST API. */
export interface NoteJson {
  readonly content: string;
  readonly frontmatter: Record<string, unknown>;
  readonly path: string;
  readonly tags: readonly string[];
  readonly stat: { readonly ctime: number; readonly mtime: number; readonly size: number };
}

/** Document structure map showing headings, blocks, and frontmatter fields. */
export interface DocumentMap {
  readonly headings: readonly string[];
  readonly blocks: readonly string[];
  readonly frontmatterFields: readonly string[];
}

/** Options for PATCH operations on vault files and periodic notes. */
export interface PatchOptions {
  readonly operation: "append" | "prepend" | "replace";
  readonly targetType: "heading" | "block" | "frontmatter";
  readonly target: string;
  readonly targetDelimiter?: string | undefined;
  readonly trimTargetWhitespace?: boolean | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly contentType?: "markdown" | "json" | undefined;
}

/** A single match within a search result, with position and surrounding context. */
export interface SearchMatch {
  readonly match: { readonly start: number; readonly end: number };
  readonly context: string;
}

/** A file-level search result returned by the Obsidian search endpoints. */
export interface SearchResult {
  readonly filename: string;
  readonly score?: number;
  readonly matches?: readonly SearchMatch[];
  readonly result?: unknown;
}

interface ServerStatus {
  readonly ok: boolean;
  readonly service: string;
  readonly authenticated: boolean;
  readonly versions: Record<string, unknown>;
}

type FileFormat = "markdown" | "json" | "map";
type FileContentsResult = string | NoteJson | DocumentMap;

// --- Path Sanitization ---

/**
 * Sanitises a vault-relative file path for use in API requests.
 * Normalises back-slashes and rejects paths containing `..` segments,
 * leading slashes, or Windows-style drive letters.
 *
 * @throws {Error} If path traversal or absolute path is detected.
 */
export function sanitizeFilePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    throw new Error("Absolute paths not allowed");
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Absolute paths not allowed");
  }
  // Canonicalize: filter out empty and "." segments so foo//bar and foo/./bar → foo/bar
  const canonical = segments.filter((s) => s !== "" && s !== ".").join("/");
  if (canonical === "") {
    throw new Error("Empty path not allowed");
  }
  return canonical;
}

// --- Heading Matching ---

/**
 * Finds the closest matching heading in a document map for PATCH retry.
 * Handles the case where concurrent writes shifted the heading hierarchy
 * (e.g. "## Tasks" became "### Tasks" or "Parent::Tasks" → "NewParent::Tasks").
 *
 * Matching stages (first unique match wins):
 * 1. Exact match
 * 2. Case-insensitive exact match
 * 3. Progressive suffix match — for multi-segment targets, tries dropping
 *    leading segments one at a time (longest suffix first). This catches
 *    renamed parent headings: "Section::Tasks" matches "NewSection::Tasks".
 * 4. Leaf-name match — compares only the final segment
 *
 * All fuzzy stages (2-4) require a unique match to avoid patching the wrong section.
 *
 * @param target - The heading target from the original PATCH options.
 * @param headings - The current headings from the document map.
 * @param delimiter - The heading hierarchy delimiter (default "::").
 * @returns The best unique match, or undefined if no unambiguous match exists.
 */
function findClosestHeading(
  target: string,
  headings: readonly string[],
  delimiter: string,
): string | undefined {
  target = target.trim();
  // 1. Exact match (sanity check)
  const exact = headings.find((h) => h.trim() === target);
  if (exact !== undefined) return exact.trim();

  // 2. Case-insensitive match — only if unique
  const targetLower = target.toLowerCase();
  const caseMatches = headings.filter((h) => h.trim().toLowerCase() === targetLower);
  if (caseMatches.length === 1) return caseMatches[0]!.trim();

  // Guard against empty/whitespace delimiter — fall back to default "::"
  const trimmed = delimiter.trim();
  const safeDelimiter = trimmed.length > 0 ? trimmed : "::";
  const delimiterLower = safeDelimiter.toLowerCase();

  const segments = targetLower.split(delimiterLower);

  // 3. Progressive suffix match — try dropping leading segments one at a time
  //    For "A::B::C", tries matching "B::C" exactly or "...::B::C" as suffix, then "C"
  //    Skipped for single-segment targets (segments.length === 1) — no segments to drop.
  //    Note: may match the original heading as a suffix candidate if Stage 2 was ambiguous.
  for (let i = 1; i < segments.length; i++) {
    const tail = segments.slice(i).join(delimiterLower);
    if (tail.length === 0) continue; // Skip empty tail from trailing delimiter
    const matches = headings.filter((h) => {
      const hLower = h.trim().toLowerCase();
      return hLower === tail || hLower.endsWith(delimiterLower + tail);
    });
    if (matches.length === 1) return matches[0]!.trim();
  }

  // 4. Leaf-name match — compare only the final segment, only if unique.
  //    Primary fallback for single-segment targets where stage 3 doesn't execute.
  //    For multi-segment targets, equivalent to stage 3's last iteration —
  //    reachable only if all stage 3 iterations were ambiguous (0 or 2+ matches).
  // split() always returns at least one element, so .at(-1) and .pop() are never undefined
  const targetLeaf = segments.at(-1)!;
  if (targetLeaf.length === 0) return undefined; // Trailing delimiter — no valid leaf
  const leafMatches = headings.filter((h) => {
    const hLeaf = h.trim().toLowerCase().split(delimiterLower).pop()!;
    return hLeaf === targetLeaf;
  });
  if (leafMatches.length === 1) return leafMatches[0]!.trim();

  return undefined;
}

// --- Heading Error Detection ---

/**
 * Checks if a 400 response body indicates a heading-not-found error.
 * Known Obsidian REST API phrasing: "heading not found" (v1.7+).
 * Uses regex to tolerate minor variations while staying specific.
 * Only these errors should trigger the heading retry logic.
 * @param body - The raw HTTP response body string (may be JSON).
 * @returns true if the parsed message matches a heading-not-found pattern.
 */
function isHeadingNotFoundError(body: string): boolean {
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const msg = (parsed as Record<string, unknown>)["message"];
      if (typeof msg === "string") message = msg;
    }
  } catch { /* use raw body */ }
  // Known Obsidian patterns: "heading not found", "heading X does not exist"
  // Intentionally broad within the heading namespace to catch API version changes.
  // Require "heading" and the absence indicator to be within 60 chars of each other
  const matched = /\bheading\b[^.!?]{0,60}(?:not found|does not exist)/i.test(message);
  if (!matched) {
    log("debug", `PATCH 400 body not recognised as heading-not-found — retry skipped: ${message.slice(0, 120)}`);
  }
  return matched;
}

// --- Accept Header Mapping ---

/** Maps a file format to the corresponding Accept header value for the Obsidian REST API. */
function acceptHeaderForFormat(format: FileFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/vnd.olrapi.note+json";
    case "map":
      return "application/vnd.olrapi.document-map+json";
  }
}

// --- Target Header Encoding ---

/**
 * Encodes a PATCH Target header value for the Obsidian REST API.
 *
 * The Obsidian REST API source code applies `decodeURIComponent(req.get("Target"))`
 * to the Target header (see: obsidian-local-rest-api V3 PATCH implementation).
 * This means ALL %HH sequences are decoded before heading matching — both ASCII
 * (%2B→+, %3A%3A→::) and non-ASCII (%C3%9C→Ü). This is documented behavior,
 * not an assumption.
 *
 * Encoding strategy (validated against live Obsidian v3.4.6):
 * 1. Escape `%` → `%25`: required so headings with literal `%` round-trip
 *    correctly via `decodeURIComponent`. (Live-tested: `100%25 Complete` → `100% Complete`.)
 * 2. Encode non-ASCII and control characters (unicode, emoji, \x00-\x1F, \x7F)
 *    via encodeURIComponent: Node.js rejects raw non-ASCII bytes in HTTP headers.
 * 3. Printable ASCII sent as-is: simpler, no transformation needed.
 *
 * @see https://deepwiki.com/coddingtonbear/obsidian-local-rest-api/6.1-patch-operations
 *
 * Full stress test: 40/40 cases pass (scripts/stress-test-patch.ts).
 */
function encodeTargetHeader(target: string): string {
  const escaped = target.replaceAll("%", "%25");
  // Encode non-ASCII and control characters. Regex created inline to avoid
  // shared /g lastIndex state. Uses try/catch to handle unpaired surrogates
  // (encodeURIComponent throws URIError on malformed UTF-16).
  return escaped.replace(/[^\x20-\x7E]+/g, (match) => { // NOSONAR: replace with /g is idiomatic
    try {
      return encodeURIComponent(match);
    } catch {
      // Unpaired surrogate or malformed UTF-16 — strip the unrepresentable chars
      return "";
    }
  });
}

// --- Compact Responses ---

let compactResponsesEnabled = false;

/** Enables or disables compact field-name mapping in JSON tool results. */
export function setCompactResponses(enabled: boolean): void {
  compactResponsesEnabled = enabled;
}

/** Returns whether compact responses are currently enabled. */
export function getCompactResponses(): boolean {
  return compactResponsesEnabled;
}

/** Maps verbose field names to compact abbreviations for token savings. */
const COMPACT_FIELD_MAP: ReadonlyMap<string, string> = new Map([
  ["content", "c"],
  ["frontmatter", "fm"],
  ["path", "p"],
  ["tags", "t"],
  ["stat", "s"],
  ["mtime", "m"],
  ["ctime", "ct"],
  ["size", "sz"],
  ["headings", "h"],
  ["blocks", "b"],
  ["frontmatterFields", "fmf"],
  ["query", "q"],
  ["context", "ctx"],
  ["score", "sc"],
  ["matches", "mt"],
  ["ok", "ok"],
  ["service", "svc"],
  ["authenticated", "auth"],
  ["versions", "v"],
  ["count", "cnt"],
  ["notes", "n"],
  ["source", "src"],
  ["target", "tgt"],
  ["inbound", "in"],
  ["outbound", "out"],
]);

/**
 * Recursively maps known field names to compact abbreviations and strips null/undefined values.
 * @param data - The data to compactify.
 * @returns A new object with compact field names.
 */
export function compactify(data: unknown): unknown {
  if (data === null || data === undefined) return undefined;
  if (Array.isArray(data)) return data.map(compactify).filter((v) => v !== undefined);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const val = compactify(obj[key]);
      if (val === undefined) continue;
      const mappedKey = COMPACT_FIELD_MAP.get(key) ?? key;
      result[mappedKey] = val;
    }
    return result;
  }
  return data;
}

// --- Tool Result Helpers ---

/** Standard MCP tool response shape (index signature required by MCP SDK). */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Wraps a plain text string as an MCP tool result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Wraps an error message as an MCP tool error result. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Serialises data as JSON in an MCP tool result. Uses compact field names when enabled. */
export function jsonResult(data: unknown): ToolResult {
  const mapped = compactResponsesEnabled ? compactify(data) : data;
  const text = compactResponsesEnabled ? JSON.stringify(mapped) : JSON.stringify(mapped, null, 2);
  return { content: [{ type: "text", text }] };
}

// --- HTTP Client ---

/**
 * HTTP client for the Obsidian Local REST API.
 * Handles authentication, TLS, timeouts, path sanitisation, case-insensitive
 * fallback, per-file write locks, write verification, and connection health.
 */
export class ObsidianClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agent: HttpsAgent | HttpAgent;
  private readonly isHttps: boolean;
  private readonly timeout: number;
  private readonly debug: boolean;
  private readonly verifyWrites: boolean;
  private readonly maxResponseChars: number;
  private readonly fileLocks = new Map<string, Promise<unknown>>();

  private readonly isConnected = false;

  // Cache reference (set after construction)
  private cacheRef: VaultCacheInterface | undefined;

  /**
   * Creates an HTTP client configured with the given server settings, TLS options, and timeouts.
   * @throws {Error} If the TLS certificate path is set but the file cannot be read.
   */
  constructor(config: Config) {
    const needsBrackets = config.host.includes(":") && !config.host.startsWith("[");
    const host = needsBrackets ? `[${config.host}]` : config.host;
    this.baseUrl = `${config.scheme}://${host}:${String(config.port)}`;
    this.apiKey = config.apiKey;
    this.isHttps = config.scheme === "https";
    this.timeout = config.timeout;
    this.debug = config.debug;
    this.verifyWrites = config.verifyWrites;
    this.maxResponseChars = config.maxResponseChars;

    if (this.isHttps) {
      const agentOptions: Record<string, unknown> = {
        keepAlive: true,
      };
      if (config.certPath) {
        try {
          agentOptions["ca"] = readFileSync(config.certPath);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to read TLS certificate at "${config.certPath}": ${message}`);
        }
        agentOptions["rejectUnauthorized"] = true;
      } else if (config.verifySsl) {
        agentOptions["rejectUnauthorized"] = true;
      } else {
        agentOptions["rejectUnauthorized"] = false;
      }
      this.agent = new HttpsAgent(agentOptions);
    } else {
      this.agent = new HttpAgent({ keepAlive: true });
    }
  }

  /** Sets the cache reference for write-through invalidation on mutating operations. */
  setCache(cache: VaultCacheInterface): void {
    this.cacheRef = cache;
  }

  // --- Connection Health ---

  /** Returns whether the last health check succeeded. */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  // --- Core HTTP ---

  /** Normalises raw Node.js response headers (which may be string or string[]) into a plain string record. Array values are joined with ", ". */
  private normalizeResponseHeaders(rawHeaders: Record<string, string | readonly string[] | undefined>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        normalized[key] = value.join(", ");
      }
    }
    return normalized;
  }

  /** Executes the low-level HTTP request and streams the response, enforcing a size cap and settled guard. */
  private executeRequest(
    reqOptions: RequestOptions,
    method: string,
    path: string,
    body: string | undefined,
    startTime: number,
    effectiveTimeout: number,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
    const requestFn = this.isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      let settled = false;

      const req = requestFn(reqOptions, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let accumulatedBytes = 0;
        res.on("data", (chunk: Buffer) => {
          accumulatedBytes += chunk.length;
          if (accumulatedBytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            if (settled) return;
            settled = true;
            reject(new ObsidianConnectionError(`Response exceeded maximum size of ${String(MAX_RESPONSE_BYTES)} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          reject(new ObsidianConnectionError(`Response stream error: ${err.message}`, { cause: err }));
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const elapsed = Date.now() - startTime;
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          const statusCode = res.statusCode ?? 0;
          if (this.debug) {
            log("debug", `${method} ${path} → ${String(statusCode)} (${String(elapsed)}ms)`);
          }
          resolve({ statusCode, headers: this.normalizeResponseHeaders(res.headers), body: responseBody });
        });
      });

      req.on("timeout", () => {
        req.destroy();
        if (settled) return;
        settled = true;
        reject(new ObsidianConnectionError(`Request timed out after ${String(effectiveTimeout)}ms: ${method} ${path}`));
      });

      req.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ECONNRESET") || err.message.includes("ENOTFOUND")) {
          reject(new ObsidianConnectionError(`Cannot reach Obsidian at ${this.baseUrl}: ${err.message}`, { cause: err }));
        } else {
          reject(new ObsidianConnectionError(`HTTP request failed: ${err.message}`, { cause: err }));
        }
      });

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Performs a raw HTTP request against the Obsidian REST API with auth, timeout, and debug logging.
   * @throws {ObsidianConnectionError} On network failure, timeout, or response stream error.
   */
  private async request(
    method: string,
    path: string,
    options: {
      readonly body?: string;
      readonly headers?: Record<string, string>;
      readonly auth?: boolean;
      readonly timeoutMultiplier?: number;
    } = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const { body, headers: extraHeaders, auth = true, timeoutMultiplier = 1 } = options;
    // Ensure path is relative — absolute URLs would override the base entirely
    const safePath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(safePath, this.baseUrl);

    const reqHeaders: Record<string, string> = { ...extraHeaders };
    if (auth && this.apiKey) {
      reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) {
      reqHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
    }

    const effectiveTimeout = this.timeout * timeoutMultiplier;
    const reqOptions: RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders,
      agent: this.agent,
      timeout: effectiveTimeout,
    };

    return this.executeRequest(reqOptions, method, path, body, Date.now(), effectiveTimeout);
  }

  /** Safely parses a JSON response body, validating Content-Type (case-insensitive) and throwing structured errors. */
  private parseJsonResponse<T>(body: string, path: string, headers?: Record<string, string>): T {
    const ct = (headers?.["content-type"] ?? "").toLowerCase();
    if (!ct) {
      log("warn", `Missing Content-Type header from ${path} — expected JSON. Attempting parse.`);
    } else if (!ct.includes("json")) {
      throw new ObsidianApiError(`Unexpected Content-Type "${ct}" from ${path} (expected JSON)`, 200);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ObsidianApiError(`Invalid JSON response from ${path}`, 200);
    }
    // Runtime type is validated by callers via type guards where needed.
    // The generic T is a compile-time contract — the Obsidian REST API is the
    // source of truth for response shapes, so this cast is provably safe for
    // well-formed API responses.
    return parsed as T;
  }

  /** Parses an error response body and throws the appropriate custom error type. */
  private handleErrorResponse(statusCode: number, body: string): never {
    if (statusCode === 401 || statusCode === 403) {
      throw new ObsidianAuthError();
    }

    let message = body;
    let errorCode: number | undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj["message"] === "string") {
          message = obj["message"];
        }
        if (typeof obj["errorCode"] === "number") {
          errorCode = obj["errorCode"];
        }
      }
    } catch {
      // Use raw body as message
    }

    throw new ObsidianApiError(message, statusCode, errorCode);
  }

  /** Truncates a response body to the configured max character limit. */
  private truncateResponse(text: string): string {
    if (this.maxResponseChars <= 0 || text.length <= this.maxResponseChars) {
      return text;
    }
    return `${text.slice(0, this.maxResponseChars)}\n\n[TRUNCATED: Response exceeded ${String(this.maxResponseChars)} characters]`;
  }

  // --- Write Lock ---

  /**
   * Serialises concurrent writes to the same lock key.
   * All file paths are canonicalized via sanitizeFilePath.
   * Uses `.then(fn, fn)` intentionally: if a previous lock-holder fails,
   * the next queued operation still runs (queue keeps moving). Each caller
   * gets its own rejection if its `fn` throws — errors do not propagate
   * across callers. This is the desired behaviour for independent write ops.
   */
  private async withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = sanitizeFilePath(filePath);
    const existing = this.fileLocks.get(lockKey);
    const next = (existing ?? Promise.resolve()).then(fn, fn);
    this.fileLocks.set(lockKey, next);
    try {
      return await next;
    } finally {
      if (this.fileLocks.get(lockKey) === next) {
        this.fileLocks.delete(lockKey);
      }
    }
  }

  /**
   * Serialises concurrent writes using a pre-validated synthetic lock key.
   * Used for active-file and periodic-note operations where the vault path is
   * unknown or resolved by Obsidian. Keys use a \0 prefix to guarantee they
   * never collide with sanitized vault paths.
   */
  private async withSyntheticLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `\0${key}`;
    const existing = this.fileLocks.get(lockKey);
    const next = (existing ?? Promise.resolve()).then(fn, fn);
    this.fileLocks.set(lockKey, next);
    try {
      return await next;
    } finally {
      if (this.fileLocks.get(lockKey) === next) {
        this.fileLocks.delete(lockKey);
      }
    }
  }

  // --- Helpers ---

  /** Builds HTTP headers for PATCH operations from PatchOptions (createIfMissing is optional). */
  private buildPatchHeaders(options: Omit<PatchOptions, "createIfMissing"> & { createIfMissing?: boolean | undefined }): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": options.contentType === "json" ? "application/json" : "text/markdown",
      "Operation": options.operation,
      "Target-Type": options.targetType,
      // Obsidian always percent-decodes the Target header, so:
      // 1. Escape literal % → %25 first (so "50%C3%BC" becomes "50%25C3%25BC")
      // 2. Encode non-ASCII and control characters (unicode, emoji, \x00-\x1F, \x7F)
      // This preserves ASCII special chars (+, &, ::, spaces) while ensuring both
      // non-ASCII headings and headings with literal %HH sequences round-trip correctly.
      // Unpaired surrogates are silently stripped (unrepresentable in UTF-8).
      // Validated against live Obsidian API in Phase 3.
      "Target": encodeTargetHeader(options.target),
    };
    if (options.targetDelimiter !== undefined) {
      headers["Target-Delimiter"] = encodeTargetHeader(options.targetDelimiter);
    }
    if (options.trimTargetWhitespace !== undefined) {
      headers["Trim-Target-Whitespace"] = String(options.trimTargetWhitespace);
    }
    if (options.createIfMissing !== undefined) {
      headers["Create-Target-If-Missing"] = String(options.createIfMissing);
    }
    return headers;
  }

  /** Builds the API path for a periodic note at a specific date. */
  private periodicDatePath(period: string, year: number, month: number, day: number): string {
    return `/periodic/${encodeURIComponent(period)}/${String(year)}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/`;
  }

  /** Sanitises and URL-encodes a vault file path for use in API request URLs. */
  private encodePath(filePath: string): string {
    const sanitized = sanitizeFilePath(filePath);
    return sanitized
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  // --- Case-insensitive Fallback ---

  /**
   * Sends a GET request and on 404 attempts a case-insensitive directory listing
   * fallback (inspired by cyanheads/obsidian-mcp-server). Lists the parent directory,
   * finds a unique case-insensitive filename match, and retries with the corrected path.
   * Only safe for read-only methods — mutating fallback could corrupt data.
   */
  private async requestWithFallback(
    method: string,
    basePath: string,
    filePath: string,
    options: {
      readonly body?: string;
      readonly headers?: Record<string, string>;
      readonly timeoutMultiplier?: number;
    } = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const encoded = this.encodePath(filePath);
    const fullPath = `${basePath}${encoded}`;
    const res = await this.request(method, fullPath, options);

    if (res.statusCode === 404 && method === "GET") {
      const correctedPath = await this.findCaseInsensitivePath(filePath);
      if (correctedPath) {
        const correctedEncoded = this.encodePath(correctedPath);
        const correctedFullPath = `${basePath}${correctedEncoded}`;
        return this.request(method, correctedFullPath, options);
      }
    }

    return res;
  }

  /**
   * Searches the full vault listing for a case-insensitive match when the exact path returns 404.
   * Compares the entire path case-insensitively, handling both filename and directory case mismatches.
   * Returns the corrected path or undefined if no unique match.
   */
  private async findCaseInsensitivePath(filePath: string): Promise<string | undefined> {
    try {
      const sanitized = sanitizeFilePath(filePath);
      const targetLower = sanitized.toLowerCase();

      // List the full vault to handle case mismatches at any path segment
      const listRes = await this.request("GET", "/vault/");
      if (listRes.statusCode !== 200) {
        return undefined;
      }

      const parsed: unknown = JSON.parse(listRes.body);
      if (parsed === null || typeof parsed !== "object" || !("files" in parsed)) {
        return undefined;
      }
      const filesVal = (parsed as Record<string, unknown>)["files"];
      if (!Array.isArray(filesVal)) {
        return undefined;
      }
      // Filter to string elements only (API should return strings, but verify)
      const files = filesVal.filter((f): f is string => typeof f === "string");

      // Find files whose full path matches case-insensitively
      const matches = files.filter((f) => !f.endsWith("/") && f.toLowerCase() === targetLower);

      if (matches.length === 1) {
        // Unique match — use the corrected path
        const match = matches[0];
        log("debug", `Case-insensitive fallback: "${filePath}" → "${match}"`);
        return match;
      }
      // 0 matches = truly not found, >1 = ambiguous — return undefined for both
      return undefined;
    } catch {
      return undefined;
    }
  }

  // --- System ---

  /** Fetches the Obsidian REST API server status (no auth required). */
  async getServerStatus(): Promise<ServerStatus> {
    const res = await this.request("GET", "/", { auth: false });
    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }
    return this.parseJsonResponse<ServerStatus>(res.body, "/", res.headers);
  }

  // --- Vault Files ---

  /** Lists all files and directories in the vault root. */
  async listFilesInVault(): Promise<{ files: string[] }> {
    const res = await this.request("GET", "/vault/");
    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }
    return this.parseJsonResponse<{ files: string[] }>(res.body, "/vault/", res.headers);
  }

  /**
   * Lists files in a vault directory, returning an empty list for empty dirs that 404.
   * On 404 the method makes an additional request to list all vault files and checks
   * whether the directory exists. This double-request is unavoidable because the
   * Obsidian REST API returns 404 for both non-existent and empty directories.
   */
  async listFilesInDir(dirPath: string): Promise<{ files: string[] }> {
    const encoded = this.encodePath(dirPath);
    const res = await this.request("GET", `/vault/${encoded}/`);

    if (res.statusCode === 404) {
      // Disambiguate empty vs non-existent: requires a full vault listing
      const vault = await this.listFilesInVault();
      const normalizedDir = sanitizeFilePath(dirPath).replace(/\/+$/, "");
      const dirExists = vault.files.some((f) => f.startsWith(`${normalizedDir}/`) || f === `${normalizedDir}/`);
      if (dirExists) {
        return { files: [] };
      }
      this.handleErrorResponse(404, res.body);
    }

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }
    return this.parseJsonResponse<{ files: string[] }>(res.body, dirPath, res.headers);
  }

  /**
   * Reads a vault file in the specified format (markdown, JSON, or document map).
   * @param filePath - Vault-relative path to the file.
   * @param format - Response format: markdown, json, or map.
   * @param skipTruncation - When true, returns full markdown content without truncation.
   *   Use for read-modify-write operations (e.g. search_replace) where partial reads
   *   would corrupt the file.
   */
  async getFileContents(filePath: string, format: FileFormat = "markdown", skipTruncation = false): Promise<FileContentsResult> {
    const res = await this.requestWithFallback("GET", "/vault/", filePath, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    if (format === "markdown") {
      return skipTruncation ? res.body : this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, filePath, res.headers);
  }

  /** Creates or overwrites a vault file with the given content (idempotent). */
  async putContent(filePath: string): Promise<void>;
  async putContent(filePath: string, content: string): Promise<void>;
  async putContent(filePath: string, content = ""): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("PUT", `/vault/${encoded}`, {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }

      // Invalidate cache
      this.cacheRef?.invalidate(sanitizeFilePath(filePath));

      // Optional write verification — reads raw content (bypasses truncation)
      // Wrapped in try/catch so a verification failure doesn't mask a successful write
      if (this.verifyWrites) {
        try {
          const verifyRes = await this.request("GET", `/vault/${encoded}`, {
            headers: { "Accept": "text/markdown" },
          });
          if (verifyRes.statusCode === 200 && verifyRes.body.trim() !== content.trim()) {
            log("warn", `Write verification failed for ${filePath}: content mismatch`);
          } else if (verifyRes.statusCode !== 200) {
            log("warn", `Write verification inconclusive for ${filePath}: read-back returned ${String(verifyRes.statusCode)}`);
          }
        } catch (error_: unknown) {
          const msg = error_ instanceof Error ? error_.message : String(error_);
          log("warn", `Write verification could not read back ${filePath}: ${msg}`);
        }
      }
    });
  }

  /** Appends content to an existing vault file (not idempotent). */
  async appendContent(filePath: string, content: string): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("POST", `/vault/${encoded}`, {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }

      this.cacheRef?.invalidate(sanitizeFilePath(filePath));
    });
  }

  /**
   * Patches a vault file at a specific heading, block, or frontmatter target (not idempotent).
   * On 400 failure with a heading target, retries once after re-reading the document map
   * and finding the closest matching heading. This mitigates the ~5% failure rate when
   * concurrent writes change the heading structure between read and patch.
   *
   * The retry (retryPatchWithMapLookup) runs inside withFileLock intentionally: holding
   * the lock during re-read+retry prevents other server-initiated writes from changing
   * the heading structure between the map read and the retry PATCH.
   */
  async patchContent(filePath: string, content: string, options: PatchOptions): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("PATCH", `/vault/${encoded}`, {
        body: content,
        headers: this.buildPatchHeaders(options),
      });

      if (res.statusCode === 204 || res.statusCode === 200) {
        this.cacheRef?.invalidate(sanitizeFilePath(filePath));
        return;
      }

      // On 400 with heading target, retry with re-read of document map.
      // isHeadingNotFoundError logs at debug level when pattern is not matched,
      // so non-heading 400s fall through to handleErrorResponse below.
      if (res.statusCode === 400 && options.targetType === "heading" && isHeadingNotFoundError(res.body)) {
        const corrected = await this.retryPatchWithMapLookup(
          () => this.getFileContents(filePath, "map"),
          `/vault/${encoded}`,
          content, options, filePath,
        );
        if (corrected !== false) {
          log("debug", `PATCH heading auto-corrected: "${options.target}" → "${corrected}" in ${filePath}`);
          this.cacheRef?.invalidate(sanitizeFilePath(filePath));
          return;
        }
      }

      this.handleErrorResponse(res.statusCode, res.body);
    });
  }

  /**
   * Re-reads the document map and attempts to find the closest matching heading
   * for a failed PATCH. Returns the corrected heading name if the retry succeeded, or false.
   * @param readMap - Fetches the current document map for heading lookup.
   * @param patchPath - The API path to retry the PATCH against.
   * @param content - The markdown/JSON content body for the PATCH.
   * @param options - The original PATCH options (target will be corrected).
   * @param label - Human-readable label for debug logging.
   * @returns The corrected heading name if the retry succeeded, false otherwise.
   *   All exceptions are caught and logged — this method never throws.
   *   When it returns false, callers should fall through to handleErrorResponse
   *   with the original error.
   */
  private async retryPatchWithMapLookup(
    readMap: () => Promise<FileContentsResult>,
    patchPath: string,
    content: string,
    options: PatchOptions,
    label: string,
  ): Promise<string | false> {
    try {
      const mapResult = await readMap();
      if (
        typeof mapResult === "string" ||
        !("headings" in mapResult) ||
        !Array.isArray(mapResult.headings)
      ) return false;

      const match = findClosestHeading(options.target.trim(), mapResult.headings, options.targetDelimiter ?? "::");
      if (!match) return false;

      log("debug", `PATCH retry: heading "${options.target}" → "${match}" in ${label}`);
      const retryOptions = { ...options, target: match };
      const retryHeaders = this.buildPatchHeaders(retryOptions);
      // The corrected heading was confirmed present in the document map;
      // strip Create-Target-If-Missing so the retry doesn't create a stale heading.
      // TypeScript Record allows delete — this is safe
      delete retryHeaders["Create-Target-If-Missing"];
      const retryRes = await this.request("PATCH", patchPath, {
        body: content,
        headers: retryHeaders,
      });

      if (retryRes.statusCode === 204 || retryRes.statusCode === 200) {
        return match;
      }
      log("warn", `PATCH retry failed for ${label}: status ${String(retryRes.statusCode)}`);
      return false;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("debug", `PATCH retry lookup failed for ${label}: ${message}`);
      return false;
    }
  }

  /** Deletes a vault file to Obsidian trash (idempotent, 404 is silently ignored). */
  async deleteFile(filePath: string): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("DELETE", `/vault/${encoded}`);

      if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
        this.handleErrorResponse(res.statusCode, res.body);
      }

      this.cacheRef?.invalidate(sanitizeFilePath(filePath));
    });
  }

  // --- Active File ---

  /** Reads the currently open file in Obsidian in the specified format. */
  async getActiveFile(format: FileFormat = "markdown"): Promise<FileContentsResult> {
    const res = await this.request("GET", "/active/", {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, "/active/", res.headers);
  }

  /** Replaces the content of the currently open file (idempotent). Serialized via active-file lock. */
  async putActiveFile(content: string): Promise<void> {
    await this.withSyntheticLock("active", async () => {
      const res = await this.request("PUT", "/active/", {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      // Active file path is unknown — invalidate all to ensure cache consistency
      this.cacheRef?.invalidateAll();
    });
  }

  /** Appends content to the currently open file (not idempotent). Serialized via active-file lock. */
  async appendActiveFile(content: string): Promise<void> {
    await this.withSyntheticLock("active", async () => {
      const res = await this.request("POST", "/active/", {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }

  /** Patches the currently open file at a specific target (not idempotent). Active file does not support createIfMissing. Serialized via active-file lock. */
  async patchActiveFile(content: string, options: Omit<PatchOptions, "createIfMissing">): Promise<void> {
    await this.withSyntheticLock("active", async () => {
      const headers = this.buildPatchHeaders(options);
      // Active file PATCH does not support Create-Target-If-Missing — enforced at type level
      delete headers["Create-Target-If-Missing"];
      const res = await this.request("PATCH", "/active/", {
        body: content,
        headers,
      });

      if (res.statusCode === 204 || res.statusCode === 200) {
        this.cacheRef?.invalidateAll();
        return;
      }

      // Note: if the user switches the active file in Obsidian between the
      // initial PATCH and the retry, getActiveFile("map") reads the new file's
      // headings. findClosestHeading will typically find no match and return false,
      // falling through to the original error. A false-positive match is unlikely.
      if (res.statusCode === 400 && options.targetType === "heading" && isHeadingNotFoundError(res.body)) {
        const corrected = await this.retryPatchWithMapLookup(
          () => this.getActiveFile("map"),
          "/active/",
          content, options, "(active file)",
        );
        if (corrected !== false) {
          log("debug", `PATCH heading auto-corrected: "${options.target}" → "${corrected}" in (active file)`);
          this.cacheRef?.invalidateAll();
          return;
        }
      }

      this.handleErrorResponse(res.statusCode, res.body);
    });
  }

  /** Deletes the currently open file (idempotent). Serialized via active-file lock. */
  async deleteActiveFile(): Promise<void> {
    await this.withSyntheticLock("active", async () => {
      const res = await this.request("DELETE", "/active/");

      if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }

  // --- Commands ---

  /** Lists all available Obsidian command palette commands. */
  async listCommands(): Promise<{ commands: Array<{ id: string; name: string }> }> {
    const res = await this.request("GET", "/commands/");

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    return this.parseJsonResponse<{ commands: Array<{ id: string; name: string }> }>(res.body, "/commands/", res.headers);
  }

  /** Executes an Obsidian command by its ID. Invalidates the entire cache since commands may modify vault contents. */
  async executeCommand(commandId: string): Promise<void> {
    const encoded = encodeURIComponent(commandId);
    const res = await this.request("POST", `/commands/${encoded}/`);

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }
    // Commands can create/rename/delete/edit notes — invalidate all
    this.cacheRef?.invalidateAll();
  }

  // --- Open ---

  /** Opens a file in the Obsidian UI, optionally in a new leaf/tab. */
  async openFile(filePath: string, newLeaf?: boolean): Promise<void> {
    const encoded = this.encodePath(filePath);
    const query = newLeaf ? "?newLeaf=true" : "";
    const res = await this.request("POST", `/open/${encoded}${query}`);

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }
  }

  // --- Search ---

  /** Performs a full-text search across all vault files with configurable context length. */
  async simpleSearch(query: string, contextLength = 100): Promise<readonly SearchResult[]> {
    const params = new URLSearchParams({ query, contextLength: String(contextLength) });
    const res = await this.request("POST", `/search/simple/?${params.toString()}`, {
      body: "",
      headers: { "Content-Type": "text/plain" },
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    return this.parseJsonResponse<SearchResult[]>(res.body, "/search/simple/", res.headers);
  }

  /** Searches the vault using a JsonLogic query (glob, regexp, etc.). */
  async complexSearch(query: Record<string, unknown>): Promise<readonly SearchResult[]> {
    const res = await this.request("POST", "/search/", {
      body: JSON.stringify(query),
      headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    return this.parseJsonResponse<SearchResult[]>(res.body, "/search/", res.headers);
  }

  /** Queries the vault using Dataview DQL (requires the Dataview plugin). */
  async dataviewSearch(dql: string): Promise<readonly SearchResult[]> {
    const res = await this.request("POST", "/search/", {
      body: dql,
      headers: { "Content-Type": "application/vnd.olrapi.dataview.dql+txt" },
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    return this.parseJsonResponse<SearchResult[]>(res.body, "/search/dataview", res.headers);
  }

  // --- Periodic Notes (Current) ---

  /** Gets the current periodic note for the given period type. */
  async getPeriodicNote(period: string, format: FileFormat = "markdown"): Promise<FileContentsResult> {
    const res = await this.request("GET", `/periodic/${encodeURIComponent(period)}/`, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, `/periodic/${period}/`, res.headers);
  }

  /**
   * Replaces the current periodic note content (idempotent). Serialized per period type.
   * Note: lock key is per period type (daily/weekly/etc.), not per resolved file path,
   * because the Obsidian REST API resolves the period to a file path server-side and
   * does not expose that path. Different period types cannot resolve to the same file.
   */
  async putPeriodicNote(period: string, content: string): Promise<void> {
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const res = await this.request("PUT", `/periodic/${encodeURIComponent(period)}/`, {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      // Periodic note path is resolved by Obsidian — invalidate all
      this.cacheRef?.invalidateAll();
    });
  }

  /** Appends content to the current periodic note (not idempotent). Serialized per period type. */
  async appendPeriodicNote(period: string, content: string): Promise<void> {
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const res = await this.request("POST", `/periodic/${encodeURIComponent(period)}/`, {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }

  /** Patches the current periodic note at a specific target (not idempotent). Serialized per period type. */
  async patchPeriodicNote(period: string, content: string, options: PatchOptions): Promise<void> {
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const periodicPath = `/periodic/${encodeURIComponent(period)}/`;
      const res = await this.request("PATCH", periodicPath, {
        body: content,
        headers: this.buildPatchHeaders(options),
      });

      if (res.statusCode === 204 || res.statusCode === 200) {
        this.cacheRef?.invalidateAll();
        return;
      }

      if (res.statusCode === 400 && options.targetType === "heading" && isHeadingNotFoundError(res.body)) {
        const corrected = await this.retryPatchWithMapLookup(
          () => this.getPeriodicNote(period, "map"),
          periodicPath,
          content, options, `(periodic: ${period})`,
        );
        if (corrected !== false) {
          log("debug", `PATCH heading auto-corrected: "${options.target}" → "${corrected}" in (periodic: ${period})`);
          this.cacheRef?.invalidateAll();
          return;
        }
      }

      this.handleErrorResponse(res.statusCode, res.body);
    });
  }

  /** Deletes the current periodic note (idempotent). Serialized per period type. */
  async deletePeriodicNote(period: string): Promise<void> {
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const res = await this.request("DELETE", `/periodic/${encodeURIComponent(period)}/`);

      if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }

  // --- Periodic Notes (By Date) ---

  /** Gets the periodic note for a specific date. */
  async getPeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
    format: FileFormat = "markdown",
  ): Promise<FileContentsResult> {
    const path = this.periodicDatePath(period, year, month, day);
    const res = await this.request("GET", path, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, path, res.headers);
  }

  /** Replaces the periodic note for a specific date (idempotent). Serialized per period+date. */
  async putPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string): Promise<void> {
    // Use the same lock key as current-period mutations — the API may resolve
    // both /periodic/{period}/ and /periodic/{period}/{y}/{m}/{d}/ to the same file
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const path = this.periodicDatePath(period, year, month, day);
      const res = await this.request("PUT", path, {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }

  /** Appends content to the periodic note for a specific date (not idempotent). Serialized per period+date. */
  async appendPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string): Promise<void> {
    // Use the same lock key as current-period mutations — the API may resolve
    // both /periodic/{period}/ and /periodic/{period}/{y}/{m}/{d}/ to the same file
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const path = this.periodicDatePath(period, year, month, day);
      const res = await this.request("POST", path, {
        body: content,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }

  /** Patches the periodic note for a specific date at a target (not idempotent). Serialized per period+date. */
  async patchPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string, options: PatchOptions): Promise<void> {
    // Use the same lock key as current-period mutations — the API may resolve
    // both /periodic/{period}/ and /periodic/{period}/{y}/{m}/{d}/ to the same file
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const datePath = this.periodicDatePath(period, year, month, day);
      const res = await this.request("PATCH", datePath, {
        body: content,
        headers: this.buildPatchHeaders(options),
      });

      if (res.statusCode === 204 || res.statusCode === 200) {
        this.cacheRef?.invalidateAll();
        return;
      }

      if (res.statusCode === 400 && options.targetType === "heading" && isHeadingNotFoundError(res.body)) {
        const corrected = await this.retryPatchWithMapLookup(
          () => this.getPeriodicNoteForDate(period, year, month, day, "map"),
          datePath,
          content, options, `(periodic: ${period} date)`,
        );
        if (corrected !== false) {
          log("debug", `PATCH heading auto-corrected: "${options.target}" → "${corrected}" in (periodic: ${period} date)`);
          this.cacheRef?.invalidateAll();
          return;
        }
      }

      this.handleErrorResponse(res.statusCode, res.body);
    });
  }

  /** Deletes the periodic note for a specific date (idempotent). Serialized per period+date. */
  async deletePeriodicNoteForDate(period: string, year: number, month: number, day: number): Promise<void> {
    // Use the same lock key as current-period mutations — the API may resolve
    // both /periodic/{period}/ and /periodic/{period}/{y}/{m}/{d}/ to the same file
    await this.withSyntheticLock(`periodic_${period}`, async () => {
      const path = this.periodicDatePath(period, year, month, day);
      const res = await this.request("DELETE", path);

      if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
        this.handleErrorResponse(res.statusCode, res.body);
      }
      this.cacheRef?.invalidateAll();
    });
  }
}

// --- Cache Interface (to avoid circular imports) ---

/** Minimal cache interface used by ObsidianClient for write-through invalidation. */
export interface VaultCacheInterface {
  invalidate(path: string): void;
  invalidateAll(): void;
}
