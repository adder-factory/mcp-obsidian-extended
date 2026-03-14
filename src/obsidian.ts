import { readFileSync } from "node:fs";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";

import { ObsidianApiError, ObsidianAuthError, ObsidianConnectionError } from "./errors.js";
import type { Config } from "./config.js";
import { log } from "./config.js";

// --- Types ---

export interface NoteJson {
  readonly content: string;
  readonly frontmatter: Record<string, unknown>;
  readonly path: string;
  readonly tags: readonly string[];
  readonly stat: { readonly ctime: number; readonly mtime: number; readonly size: number };
}

export interface DocumentMap {
  readonly headings: readonly string[];
  readonly blocks: readonly string[];
  readonly frontmatterFields: readonly string[];
}

export interface PatchOptions {
  readonly operation: "append" | "prepend" | "replace";
  readonly targetType: "heading" | "block" | "frontmatter";
  readonly target: string;
  readonly targetDelimiter?: string;
  readonly trimTargetWhitespace?: boolean;
  readonly createIfMissing?: boolean;
  readonly contentType?: "markdown" | "json";
}

export interface SearchMatch {
  readonly match: { readonly start: number; readonly end: number };
  readonly context: string;
}

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

// --- Path Sanitization ---

export function sanitizeFilePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Absolute paths not allowed");
  }
  return normalized;
}

// --- Accept Header Mapping ---

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

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// --- HTTP Client ---

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

  constructor(config: Config) {
    this.baseUrl = `${config.scheme}://${config.host}:${String(config.port)}`;
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
        agentOptions["ca"] = readFileSync(config.certPath);
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

  setCache(cache: VaultCacheInterface): void {
    this.cacheRef = cache;
  }

  // --- Connection Health ---

  async ensureConnection(): Promise<void> {
    const now = Date.now();
    if (this.isConnected && now - this.lastHealthCheck < this.healthCheckInterval) {
      return;
    }
    try {
      await this.getServerStatus();
      this.isConnected = true;
      this.lastHealthCheck = now;
    } catch {
      this.isConnected = false;
      throw new ObsidianConnectionError("Cannot reach Obsidian. Ensure it is running with Local REST API enabled.");
    }
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  // --- Core HTTP ---

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
    const startTime = Date.now();

    const reqHeaders: Record<string, string> = {
      ...extraHeaders,
    };
    if (auth && this.apiKey) {
      reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) {
      reqHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
    }

    const requestFn = this.isHttps ? httpsRequest : httpRequest;

    const reqOptions: RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders,
      agent: this.agent,
      timeout: this.timeout * timeoutMultiplier,
    };

    return new Promise((resolve, reject) => {
      const req = requestFn(reqOptions, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const elapsed = Date.now() - startTime;
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          const statusCode = res.statusCode ?? 0;

          if (this.debug) {
            log("debug", `${method} ${path} → ${String(statusCode)} (${String(elapsed)}ms)`);
          }

          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") {
              responseHeaders[key] = value;
            }
          }

          resolve({ statusCode, headers: responseHeaders, body: responseBody });
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new ObsidianConnectionError(`Request timed out after ${String(this.timeout * timeoutMultiplier)}ms: ${method} ${path}`));
      });

      req.on("error", (err: Error) => {
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

  private handleErrorResponse(statusCode: number, body: string, _path: string): never {
    if (statusCode === 401 || statusCode === 403) {
      throw new ObsidianAuthError();
    }

    let message = body;
    try {
      const parsed = JSON.parse(body) as { message?: string; errorCode?: number };
      if (parsed.message) {
        message = parsed.message;
      }
    } catch {
      // Use raw body as message
    }

    throw new ObsidianApiError(message, statusCode);
  }

  private truncateResponse(text: string): string {
    if (this.maxResponseChars <= 0 || text.length <= this.maxResponseChars) {
      return text;
    }
    return `${text.slice(0, this.maxResponseChars)}\n\n[TRUNCATED: Response exceeded ${String(this.maxResponseChars)} characters]`;
  }

  // --- Write Lock ---

  private async withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.fileLocks.get(filePath);
    const next = (existing ?? Promise.resolve()).then(fn, fn);
    this.fileLocks.set(filePath, next);
    try {
      return await next;
    } finally {
      if (this.fileLocks.get(filePath) === next) {
        this.fileLocks.delete(filePath);
      }
    }
  }

  // --- Encode Path ---

  private encodePath(filePath: string): string {
    const sanitized = sanitizeFilePath(filePath);
    return sanitized
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  // --- Case-insensitive Fallback ---

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

  async getServerStatus(): Promise<ServerStatus> {
    const res = await this.request("GET", "/", { auth: false });
    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "/");
    }
    return JSON.parse(res.body) as ServerStatus;
  }

  // --- Vault Files ---

  async listFilesInVault(): Promise<{ files: string[] }> {
    const res = await this.request("GET", "/vault/");
    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "/vault/");
    }
    return JSON.parse(res.body) as { files: string[] };
  }

  async listFilesInDir(dirPath: string): Promise<{ files: string[] }> {
    const encoded = this.encodePath(dirPath);
    const res = await this.request("GET", `/vault/${encoded}/`);

    if (res.statusCode === 404) {
      // Check if dir exists in vault listing
      const vault = await this.listFilesInVault();
      const normalizedDir = sanitizeFilePath(dirPath);
      const dirExists = vault.files.some((f) => f.startsWith(`${normalizedDir}/`) || f === `${normalizedDir}/`);
      if (dirExists) {
        return { files: [] };
      }
      this.handleErrorResponse(404, res.body, dirPath);
    }

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, dirPath);
    }
    return JSON.parse(res.body) as { files: string[] };
  }

  async getFileContents(filePath: string, format: FileFormat = "markdown"): Promise<string | NoteJson | DocumentMap> {
    const res = await this.requestWithFallback("GET", "/vault/", filePath, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, filePath);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return JSON.parse(res.body) as NoteJson | DocumentMap;
  }

  async putContent(filePath: string): Promise<void>;
  async putContent(filePath: string, content: string): Promise<void>;
  async putContent(filePath: string, content?: string): Promise<void> {
    const body = content ?? "";
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
      const res = await this.request("PUT", `/vault/${encoded}`, {
        body,
        headers: { "Content-Type": "text/markdown" },
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body, filePath);
      }

      // Invalidate cache
      this.cacheRef?.invalidate(filePath);

      // Optional write verification
      if (this.verifyWrites) {
        const readBack = await this.getFileContents(filePath, "markdown");
        if (typeof readBack === "string" && readBack !== body) {
          log("warn", `Write verification failed for ${filePath}: content mismatch`);
        }
      }
    });
  }

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

      this.cacheRef?.invalidate(filePath);
    });
  }

  async patchContent(filePath: string, content: string, options: PatchOptions): Promise<void> {
    await this.withFileLock(filePath, async () => {
      const encoded = this.encodePath(filePath);
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

      const res = await this.request("PATCH", `/vault/${encoded}`, {
        body: content,
        headers,
      });

      if (res.statusCode !== 204 && res.statusCode !== 200) {
        this.handleErrorResponse(res.statusCode, res.body, filePath);
      }

      this.cacheRef?.invalidate(filePath);
    });
  }

  async deleteFile(filePath: string): Promise<void> {
    const encoded = this.encodePath(filePath);
    const res = await this.request("DELETE", `/vault/${encoded}`);

    if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
      this.handleErrorResponse(res.statusCode, res.body, filePath);
    }

    this.cacheRef?.invalidate(filePath);
  }

  // --- Active File ---

  async getActiveFile(format: FileFormat = "markdown"): Promise<string | NoteJson | DocumentMap> {
    const res = await this.request("GET", "/active/", {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return JSON.parse(res.body) as NoteJson | DocumentMap;
  }

  async putActiveFile(content: string): Promise<void> {
    const res = await this.request("PUT", "/active/", {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
  }

  async appendActiveFile(content: string): Promise<void> {
    const res = await this.request("POST", "/active/", {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
  }

  async patchActiveFile(content: string, options: PatchOptions): Promise<void> {
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

    const res = await this.request("PATCH", "/active/", {
      body: content,
      headers,
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
  }

  async deleteActiveFile(): Promise<void> {
    const res = await this.request("DELETE", "/active/");

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(active file)");
    }
  }

  // --- Commands ---

  async listCommands(): Promise<{ commands: Array<{ id: string; name: string }> }> {
    const res = await this.request("GET", "/commands/");

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "/commands/");
    }

    return JSON.parse(res.body) as { commands: Array<{ id: string; name: string }> };
  }

  async executeCommand(commandId: string): Promise<void> {
    const encoded = encodeURIComponent(commandId);
    const res = await this.request("POST", `/commands/${encoded}/`);

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, commandId);
    }
  }

  // --- Open ---

  async openFile(filePath: string, newLeaf?: boolean): Promise<void> {
    const encoded = this.encodePath(filePath);
    const query = newLeaf ? "?newLeaf=true" : "";
    const res = await this.request("POST", `/open/${encoded}${query}`);

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, filePath);
    }
  }

  // --- Search ---

  async simpleSearch(query: string, contextLength = 100): Promise<readonly SearchResult[]> {
    const params = new URLSearchParams({ query, contextLength: String(contextLength) });
    const res = await this.request("POST", `/search/simple/?${params.toString()}`, {
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(search)");
    }

    return JSON.parse(res.body) as SearchResult[];
  }

  async complexSearch(query: Record<string, unknown>): Promise<readonly SearchResult[]> {
    const res = await this.request("POST", "/search/", {
      body: JSON.stringify(query),
      headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(search)");
    }

    return JSON.parse(res.body) as SearchResult[];
  }

  async dataviewSearch(dql: string): Promise<readonly SearchResult[]> {
    const res = await this.request("POST", "/search/", {
      body: dql,
      headers: { "Content-Type": "application/vnd.olrapi.dataview.dql+txt" },
      timeoutMultiplier: 2,
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, "(dataview search)");
    }

    return JSON.parse(res.body) as SearchResult[];
  }

  // --- Periodic Notes (Current) ---

  async getPeriodicNote(period: string, format: FileFormat = "markdown"): Promise<string | NoteJson | DocumentMap> {
    const res = await this.request("GET", `/periodic/${encodeURIComponent(period)}/`, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return JSON.parse(res.body) as NoteJson | DocumentMap;
  }

  async putPeriodicNote(period: string, content: string): Promise<void> {
    const res = await this.request("PUT", `/periodic/${encodeURIComponent(period)}/`, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
  }

  async appendPeriodicNote(period: string, content: string): Promise<void> {
    const res = await this.request("POST", `/periodic/${encodeURIComponent(period)}/`, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
  }

  async patchPeriodicNote(period: string, content: string, options: PatchOptions): Promise<void> {
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

    const res = await this.request("PATCH", `/periodic/${encodeURIComponent(period)}/`, {
      body: content,
      headers,
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
  }

  async deletePeriodicNote(period: string): Promise<void> {
    const res = await this.request("DELETE", `/periodic/${encodeURIComponent(period)}/`);

    if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period})`);
    }
  }

  // --- Periodic Notes (By Date) ---

  async getPeriodicNoteForDate(
    period: string,
    year: number,
    month: number,
    day: number,
    format: FileFormat = "markdown",
  ): Promise<string | NoteJson | DocumentMap> {
    const path = `/periodic/${encodeURIComponent(period)}/${String(year)}/${String(month)}/${String(day)}/`;
    const res = await this.request("GET", path, {
      headers: { "Accept": acceptHeaderForFormat(format) },
    });

    if (res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} ${String(year)}-${String(month)}-${String(day)})`);
    }

    if (format === "markdown") {
      return this.truncateResponse(res.body);
    }
    return JSON.parse(res.body) as NoteJson | DocumentMap;
  }

  async putPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string): Promise<void> {
    const path = `/periodic/${encodeURIComponent(period)}/${String(year)}/${String(month)}/${String(day)}/`;
    const res = await this.request("PUT", path, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
  }

  async appendPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string): Promise<void> {
    const path = `/periodic/${encodeURIComponent(period)}/${String(year)}/${String(month)}/${String(day)}/`;
    const res = await this.request("POST", path, {
      body: content,
      headers: { "Content-Type": "text/markdown" },
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
  }

  async patchPeriodicNoteForDate(period: string, year: number, month: number, day: number, content: string, options: PatchOptions): Promise<void> {
    const path = `/periodic/${encodeURIComponent(period)}/${String(year)}/${String(month)}/${String(day)}/`;
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

    const res = await this.request("PATCH", path, {
      body: content,
      headers,
    });

    if (res.statusCode !== 204 && res.statusCode !== 200) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
  }

  async deletePeriodicNoteForDate(period: string, year: number, month: number, day: number): Promise<void> {
    const path = `/periodic/${encodeURIComponent(period)}/${String(year)}/${String(month)}/${String(day)}/`;
    const res = await this.request("DELETE", path);

    if (res.statusCode !== 204 && res.statusCode !== 200 && res.statusCode !== 404) {
      this.handleErrorResponse(res.statusCode, res.body, `(periodic: ${period} date)`);
    }
  }
}

// --- Cache Interface (to avoid circular imports) ---

export interface VaultCacheInterface {
  invalidate(path: string): void;
  invalidateAll(): void;
}
