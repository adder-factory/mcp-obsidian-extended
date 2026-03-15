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
  readonly targetDelimiter?: string;
  readonly trimTargetWhitespace?: boolean;
  readonly createIfMissing?: boolean;
  readonly contentType?: "markdown" | "json";
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

// --- Tool Result Helpers ---

/** Standard MCP tool response shape. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

/** Wraps a plain text string as an MCP tool result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Wraps an error message as an MCP tool error result. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Serialises data as pretty-printed JSON in an MCP tool result. */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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

  private isConnected = false;
  private lastHealthCheck = 0;
  private readonly healthCheckInterval = 30000;

  // Cache reference (set after construction)
  private cacheRef: VaultCacheInterface | undefined;

  /** Creates an HTTP client configured with the given server settings, TLS options, and timeouts. */
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

  /** Verifies connectivity to Obsidian, re-checking at most once per health check interval. */
  async ensureConnection(): Promise<void> {
    const now = Date.now();
    if (this.isConnected && now - this.lastHealthCheck < this.healthCheckInterval) {
      return;
    }
    try {
      await this.getServerStatus();
      this.isConnected = true;
      this.lastHealthCheck = now;
    } catch (err: unknown) {
      this.isConnected = false;
      if (err instanceof ObsidianAuthError || err instanceof ObsidianApiError) {
        throw err;
      }
      throw new ObsidianConnectionError(
        "Cannot reach Obsidian. Ensure it is running with Local REST API enabled.",
        err instanceof Error ? { cause: err } : undefined,
      );
    }
  }

  /** Returns whether the last health check succeeded. */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  // --- Core HTTP ---

  /** Normalises raw Node.js response headers (which may be string or string[]) into a plain string record. */
  private normalizeResponseHeaders(rawHeaders: Record<string, string | readonly string[] | undefined>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") {
        normalized[key] = value;
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
    const url = new URL(path, this.baseUrl);

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

  /** Safely parses a JSON response body, validating Content-Type and throwing structured errors. */
  private parseJsonResponse<T>(body: string, path: string, headers?: Record<string, string>): T {
    const ct = headers?.["content-type"] ?? "";
    if (ct && !ct.includes("json")) {
      throw new ObsidianApiError(`Unexpected Content-Type "${ct}" from ${path} (expected JSON)`, 200);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new ObsidianApiError(`Invalid JSON response from ${path}`, 200);
    }
  }

  /** Parses an error response body and throws the appropriate custom error type. */
  private handleErrorResponse(statusCode: number, body: string, _path: string): never {
    if (statusCode === 401 || statusCode === 403) {
      throw new ObsidianAuthError();
    }

    let message = body;
    let errorCode: number | undefined;
    try {
      const parsed = JSON.parse(body) as { message?: string; errorCode?: number };
      if (parsed.message) {
        message = parsed.message;
      }
      errorCode = parsed.errorCode;
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
   * Serialises concurrent writes to the same file path.
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

  // --- Helpers ---

  /** Builds HTTP headers for PATCH operations from PatchOptions. */
  private buildPatchHeaders(options: PatchOptions): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": options.contentType === "json" ? "application/json" : "text/markdown",
      "Operation": options.operation,
      "Target-Type": options.targetType,
      "Target": encodeURIComponent(options.target),
    };
    if (options.targetDelimiter !== undefined) {
      headers["Target-Delimiter"] = options.targetDelimiter;
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

  /** Sends a GET request and retries with a lowercased path on 404 (case-insensitive fallback). Only safe for read-only methods — mutating fallback could corrupt data. */
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
      // Try case-insensitive fallback
      const lowerPath = filePath.toLowerCase();
      if (lowerPath !== filePath) {
        const lowerEncoded = this.encodePath(lowerPath);
        const lowerFullPath = `${basePath}${lowerEncoded}`;
        const fallbackRes = await this.request(method, lowerFullPath, options);
        if (fallbackRes.statusCode !== 404) {
          return fallbackRes;
        }
      }
    }

    return res;
  }

  // --- System ---

  /** Fetches the Obsidian REST API server status (no auth required). */
  async getServerStatus(): Promise<ServerStatus> {
    const res = await this.request("GET", "/", { auth: false });
    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "/");
    }
    return this.parseJsonResponse<ServerStatus>(res.body, "/", res.headers);
  }

  // --- Vault Files ---

  /** Lists all files and directories in the vault root. */
  async listFilesInVault(): Promise<{ files: string[] }> {
    const res = await this.request("GET", "/vault/");
    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "/vault/");
    }
    return this.parseJsonResponse<{ files: string[] }>(res.body, "/vault/", res.headers);
  }

  /** Lists files in a vault directory, returning an empty list for empty dirs that 404. */
  async listFilesInDir(dirPath: string): Promise<{ files: string[] }> {
    const encoded = this.encodePath(dirPath);
    const res = await this.request("GET", `/vault/${encoded}/`);

    if (res.statusCode === 404) {
      // Check if dir exists in vault listing
      const vault = await this.listFilesInVault();
      const normalizedDir = sanitizeFilePath(dirPath).replace(/\/+$/, "");
      const dirExists = vault.files.some((f) => f.startsWith(`${normalizedDir}/`) || f === `${normalizedDir}/`);
      if (dirExists) {
        return { files: [] };
      }
      this.handleErrorResponse(404, res.body, dirPath);
    }

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, dirPath);
    }
    return this.parseJsonResponse<{ files: string[] }>(res.body, dirPath, res.headers);
  }

  /** Reads a vault file in the specified format (markdown, JSON, or document map). */
  async getFileContents(filePath: string, format: FileFormat = "markdown"): Promise<FileContentsResult> {
    const res = await this.requestWithFallback("GET", "/vault/", filePath, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, filePath);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
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
        this.handleErrorResponse(res.statusCode, res.body, filePath);
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
        this.handleErrorResponse(res.statusCode, res.body, filePath);
      }

      this.cacheRef?.invalidate(sanitizeFilePath(filePath));
    });
  }

  /** Patches a vault file at a specific heading, block, or frontmatter target (not idempotent). */
  async patchContent(filePath: string, content: string, options: PatchOptions): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("PATCH", `/vault/${encoded}`, {
        body: content,
        headers: this.buildPatchHeaders(options),
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body, filePath);
      }

      this.cacheRef?.invalidate(sanitizeFilePath(filePath));
    });
  }

  /** Deletes a vault file to Obsidian trash (idempotent, 404 is silently ignored). */
  async deleteFile(filePath: string): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("DELETE", `/vault/${encoded}`);

      if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
        this.handleErrorResponse(res.statusCode, res.body, filePath);
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
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, "/active/", res.headers);
  }

  /** Replaces the content of the currently open file (idempotent). */
  async putActiveFile(content: string): Promise<void> {
    const res = await this.request("PUT", "/active/", {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
    // Active file path is unknown — invalidate all to ensure cache consistency
    this.cacheRef?.invalidateAll();
  }

  /** Appends content to the currently open file (not idempotent). */
  async appendActiveFile(content: string): Promise<void> {
    const res = await this.request("POST", "/active/", {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
    this.cacheRef?.invalidateAll();
  }

  /** Patches the currently open file at a specific target (not idempotent). Active file does not support createIfMissing. */
  async patchActiveFile(content: string, options: PatchOptions): Promise<void> {
    const headers = this.buildPatchHeaders(options);
    // Active file PATCH does not support Create-Target-If-Missing (vault PATCH only)
    delete headers["Create-Target-If-Missing"];
    const res = await this.request("PATCH", "/active/", {
      body: content,
      headers,
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
    this.cacheRef?.invalidateAll();
  }

  /** Deletes the currently open file (idempotent). */
  async deleteActiveFile(): Promise<void> {
    const res = await this.request("DELETE", "/active/");

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
    this.cacheRef?.invalidateAll();
  }

  // --- Commands ---

  /** Lists all available Obsidian command palette commands. */
  async listCommands(): Promise<{ commands: Array<{ id: string; name: string }> }> {
    const res = await this.request("GET", "/commands/");

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "/commands/");
    }

    return this.parseJsonResponse<{ commands: Array<{ id: string; name: string }> }>(res.body, "/commands/", res.headers);
  }

  /** Executes an Obsidian command by its ID. */
  async executeCommand(commandId: string): Promise<void> {
    const encoded = encodeURIComponent(commandId);
    const res = await this.request("POST", `/commands/${encoded}/`);

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, commandId);
    }
  }

  // --- Open ---

  /** Opens a file in the Obsidian UI, optionally in a new leaf/tab. */
  async openFile(filePath: string, newLeaf?: boolean): Promise<void> {
    const encoded = this.encodePath(filePath);
    const query = newLeaf ? "?newLeaf=true" : "";
    const res = await this.request("POST", `/open/${encoded}${query}`);

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, filePath);
    }
  }

  // --- Search ---

  /** Performs a full-text search across all vault files with configurable context length. */
  async simpleSearch(query: string, contextLength = 100): Promise<readonly SearchResult[]> {
    const params = new URLSearchParams({ query, contextLength: String(contextLength) });
    const res = await this.request("POST", `/search/simple/?${params.toString()}`, {
      body: "",
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(search)");
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
      this.handleErrorResponse(res.statusCode, res.body, "(search)");
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
      this.handleErrorResponse(res.statusCode, res.body, "(dataview search)");
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
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, `/periodic/${period}/`, res.headers);
  }

  /** Replaces the current periodic note content (idempotent). */
  async putPeriodicNote(period: string, content: string): Promise<void> {
    const res = await this.request("PUT", `/periodic/${encodeURIComponent(period)}/`, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
    // Periodic note path is resolved by Obsidian — invalidate all
    this.cacheRef?.invalidateAll();
  }

  /** Appends content to the current periodic note (not idempotent). */
  async appendPeriodicNote(period: string, content: string): Promise<void> {
    const res = await this.request("POST", `/periodic/${encodeURIComponent(period)}/`, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
    this.cacheRef?.invalidateAll();
  }

  /** Patches the current periodic note at a specific target (not idempotent). */
  async patchPeriodicNote(period: string, content: string, options: PatchOptions): Promise<void> {
    const res = await this.request("PATCH", `/periodic/${encodeURIComponent(period)}/`, {
      body: content,
      headers: this.buildPatchHeaders(options),
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
    this.cacheRef?.invalidateAll();
  }

  /** Deletes the current periodic note (idempotent). */
  async deletePeriodicNote(period: string): Promise<void> {
    const res = await this.request("DELETE", `/periodic/${encodeURIComponent(period)}/`);

    if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
    this.cacheRef?.invalidateAll();
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
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} ${String(year)}-${String(month)}-${String(day)})`);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return this.parseJsonResponse<NoteJson | DocumentMap>(res.body, path, res.headers);
  }

  /** Replaces the periodic note for a specific date (idempotent). */
  async putPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string): Promise<void> {
    const path = this.periodicDatePath(period, year, month, day);
    const res = await this.request("PUT", path, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
    this.cacheRef?.invalidateAll();
  }

  /** Appends content to the periodic note for a specific date (not idempotent). */
  async appendPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string): Promise<void> {
    const path = this.periodicDatePath(period, year, month, day);
    const res = await this.request("POST", path, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
    this.cacheRef?.invalidateAll();
  }

  /** Patches the periodic note for a specific date at a target (not idempotent). */
  async patchPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string, options: PatchOptions): Promise<void> {
    const path = this.periodicDatePath(period, year, month, day);
    const res = await this.request("PATCH", path, {
      body: content,
      headers: this.buildPatchHeaders(options),
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
    this.cacheRef?.invalidateAll();
  }

  /** Deletes the periodic note for a specific date (idempotent). */
  async deletePeriodicNoteForDate(period: string, year: number, month: number, day: number): Promise<void> {
    const path = this.periodicDatePath(period, year, month, day);
    const res = await this.request("DELETE", path);

    if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
    this.cacheRef?.invalidateAll();
  }
}

// --- Cache Interface (to avoid circular imports) ---

/** Minimal cache interface used by ObsidianClient for write-through invalidation. */
export interface VaultCacheInterface {
  invalidate(path: string): void;
  invalidateAll(): void;
}
