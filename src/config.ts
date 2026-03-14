import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

/** Fully resolved server configuration. All fields are populated from defaults, config file, or env vars. */
export interface Config {
  readonly apiKey: string;
  readonly host: string;
  readonly port: number;
  readonly scheme: "https" | "http";
  readonly timeout: number;
  readonly certPath: string | undefined;
  readonly verifySsl: boolean;
  readonly verifyWrites: boolean;
  readonly maxResponseChars: number;
  readonly debug: boolean;
  readonly toolMode: "granular" | "consolidated";
  readonly toolPreset: "full" | "read-only" | "minimal" | "safe";
  readonly includeTools: readonly string[];
  readonly excludeTools: readonly string[];
  readonly cacheTtl: number;
  readonly enableCache: boolean;
  readonly configFilePath: string | undefined;
}

interface ConfigFileShape {
  readonly host?: string;
  readonly port?: number;
  readonly scheme?: string;
  readonly tools?: {
    readonly mode?: string;
    readonly preset?: string;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
  readonly reliability?: {
    readonly timeout?: number;
    readonly verifyWrites?: boolean;
    readonly maxResponseChars?: number;
  };
  readonly tls?: {
    readonly certPath?: string | null;
    readonly verifySsl?: boolean;
  };
  readonly cache?: {
    readonly ttl?: number;
    readonly enabled?: boolean;
  };
  readonly debug?: boolean;
}

const DEFAULTS: Omit<Config, "apiKey" | "configFilePath"> = {
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
};

const CONFIG_SEARCH_PATHS: readonly string[] = [
  "./obsidian-mcp.config.json",
  join(homedir(), ".obsidian-mcp.config.json"),
  join(homedir(), ".config", "obsidian-mcp", "config.json"),
];

/** Searches for a config file in the standard locations, returning its resolved path if found. */
function findConfigFile(): string | undefined {
  const envPath = process.env["OBSIDIAN_CONFIG"];
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) {
      return resolved;
    }
    log("warn", `OBSIDIAN_CONFIG path does not exist: ${resolved}`);
    return undefined;
  }

  for (const searchPath of CONFIG_SEARCH_PATHS) {
    const resolved = resolve(searchPath);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

const configFileSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  scheme: z.string().optional(),
  tools: z.object({
    mode: z.string().optional(),
    preset: z.string().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }).optional(),
  reliability: z.object({
    timeout: z.number().positive().optional(),
    verifyWrites: z.boolean().optional(),
    maxResponseChars: z.number().nonnegative().optional(),
  }).optional(),
  tls: z.object({
    certPath: z.string().nullable().optional(),
    verifySsl: z.boolean().optional(),
  }).optional(),
  cache: z.object({
    ttl: z.number().nonnegative().optional(),
    enabled: z.boolean().optional(),
  }).optional(),
  debug: z.boolean().optional(),
});

/** Reads and validates a JSON config file, returning its parsed contents or an empty object on error. */
function loadConfigFile(filePath: string): ConfigFileShape {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    log("warn", `Config file validation errors: ${issues}. Ignoring config file.`);
    return {};
  }
  return result.data as ConfigFileShape;
}

/** Parses a string env var as a boolean, accepting true/false/1/0/yes/no/on/off. */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
    return false;
  }
  log("warn", `Unrecognised boolean env value "${value}", using default ${String(fallback)}`);
  return fallback;
}

/** Parses a string env var as a number, returning the fallback if undefined or NaN. */
function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Splits a comma-separated string into trimmed, non-empty entries. */
function parseCommaSeparated(value: string | undefined): readonly string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Validates the scheme value, returning the default if unrecognised. */
function validateScheme(value: string | undefined): "https" | "http" {
  if (value === "http" || value === "https") {
    return value;
  }
  return DEFAULTS.scheme;
}

/** Validates the tool mode value, returning the default if unrecognised. */
function validateToolMode(value: string | undefined): "granular" | "consolidated" {
  if (value === "granular" || value === "consolidated") {
    return value;
  }
  return DEFAULTS.toolMode;
}

/** Validates the tool preset value, returning the default if unrecognised. */
function validateToolPreset(value: string | undefined): "full" | "read-only" | "minimal" | "safe" {
  if (value === "full" || value === "read-only" || value === "minimal" || value === "safe") {
    return value;
  }
  return DEFAULTS.toolPreset;
}

/** Loads configuration from defaults, config file (auto-discovered), and env vars. Env vars always win. */
export function loadConfig(): Config {
  const configFilePath = findConfigFile();
  let fileConfig: ConfigFileShape = {};

  if (configFilePath) {
    try {
      fileConfig = loadConfigFile(configFilePath);
    } catch {
      log("warn", `Failed to parse config file: ${configFilePath}`);
    }
  }

  const env = process.env;

  const config: Config = {
    apiKey: env["OBSIDIAN_API_KEY"] ?? "",
    host: env["OBSIDIAN_HOST"] ?? fileConfig.host ?? DEFAULTS.host,
    port: parseNumber(env["OBSIDIAN_PORT"], fileConfig.port ?? DEFAULTS.port),
    scheme: validateScheme(env["OBSIDIAN_SCHEME"] ?? fileConfig.scheme),
    timeout: parseNumber(env["OBSIDIAN_TIMEOUT"], fileConfig.reliability?.timeout ?? DEFAULTS.timeout),
    certPath: env["OBSIDIAN_CERT_PATH"] ?? (fileConfig.tls?.certPath === null ? undefined : fileConfig.tls?.certPath) ?? DEFAULTS.certPath,
    verifySsl: parseBoolean(env["OBSIDIAN_VERIFY_SSL"], fileConfig.tls?.verifySsl ?? DEFAULTS.verifySsl),
    verifyWrites: parseBoolean(env["OBSIDIAN_VERIFY_WRITES"], fileConfig.reliability?.verifyWrites ?? DEFAULTS.verifyWrites),
    maxResponseChars: parseNumber(env["OBSIDIAN_MAX_RESPONSE_CHARS"], fileConfig.reliability?.maxResponseChars ?? DEFAULTS.maxResponseChars),
    debug: parseBoolean(env["OBSIDIAN_DEBUG"], fileConfig.debug ?? DEFAULTS.debug),
    toolMode: validateToolMode(env["TOOL_MODE"] ?? fileConfig.tools?.mode),
    toolPreset: validateToolPreset(env["TOOL_PRESET"] ?? fileConfig.tools?.preset),
    includeTools: env["INCLUDE_TOOLS"] !== undefined
      ? parseCommaSeparated(env["INCLUDE_TOOLS"])
      : (fileConfig.tools?.include ?? DEFAULTS.includeTools),
    excludeTools: env["EXCLUDE_TOOLS"] !== undefined
      ? parseCommaSeparated(env["EXCLUDE_TOOLS"])
      : (fileConfig.tools?.exclude ?? DEFAULTS.excludeTools),
    cacheTtl: parseNumber(env["OBSIDIAN_CACHE_TTL"], fileConfig.cache?.ttl ?? DEFAULTS.cacheTtl),
    enableCache: parseBoolean(env["OBSIDIAN_ENABLE_CACHE"], fileConfig.cache?.enabled ?? DEFAULTS.enableCache),
    configFilePath,
  };

  return config;
}

/** Returns a copy of the config safe for display — API key is shown as `[SET]` or `[NOT SET]`. */
export function getRedactedConfig(config: Config): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    scheme: config.scheme,
    apiKey: config.apiKey ? "[SET]" : "[NOT SET]",
    timeout: config.timeout,
    certPath: config.certPath ?? null,
    verifySsl: config.verifySsl,
    verifyWrites: config.verifyWrites,
    maxResponseChars: config.maxResponseChars,
    debug: config.debug,
    toolMode: config.toolMode,
    toolPreset: config.toolPreset,
    includeTools: config.includeTools,
    excludeTools: config.excludeTools,
    cacheTtl: config.cacheTtl,
    enableCache: config.enableCache,
    configFilePath: config.configFilePath ?? null,
  };
}

/** Deep-merges two plain objects recursively (second wins on leaf conflicts). */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal)
      && tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/** Deep-merges updates into an existing config file (or creates a new one). */
export function saveConfigToFile(filePath: string, updates: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    } catch {
      // Start fresh if file is corrupted
    }
  }
  const merged = deepMerge(existing, updates);
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}

/** Writes a log message to stderr. stdout is reserved for the MCP transport. */
export function log(level: "info" | "warn" | "error" | "debug", message: string): void {
  process.stderr.write(`[${level}] ${message}\n`);
}
