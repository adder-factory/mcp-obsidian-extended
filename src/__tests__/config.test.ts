import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// We need to mock fs before importing config.ts
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
});

import {
  loadConfig,
  getRedactedConfig,
  saveConfigToFile,
  log,
  setDebugEnabled,
  getDebugEnabled,
} from "../config.js";
import type { Config } from "../config.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedExistsSync = vi.mocked(existsSync);

// Suppress stderr output
beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

// Save and restore env between tests
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear all OBSIDIAN_* and TOOL_* env vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OBSIDIAN_") || key.startsWith("TOOL_") || key === "INCLUDE_TOOLS" || key === "EXCLUDE_TOOLS") {
      delete process.env[key];
    }
  }
  mockedExistsSync.mockReturnValue(false);
  mockedReadFileSync.mockReset();
  mockedWriteFileSync.mockReset();
});

afterEach(() => {
  process.env = savedEnv;
  setDebugEnabled(false);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------
describe("loadConfig — defaults", () => {
  it("loads correct defaults when no env vars or config file", () => {
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(27124);
    expect(config.scheme).toBe("https");
    expect(config.timeout).toBe(30000);
    expect(config.certPath).toBeUndefined();
    expect(config.verifySsl).toBe(false);
    expect(config.verifyWrites).toBe(false);
    expect(config.maxResponseChars).toBe(500000);
    expect(config.debug).toBe(false);
    expect(config.toolMode).toBe("granular");
    expect(config.toolPreset).toBe("full");
    expect(config.includeTools).toEqual([]);
    expect(config.excludeTools).toEqual([]);
    expect(config.cacheTtl).toBe(600000);
    expect(config.enableCache).toBe(true);
  });

  it("returns empty string for apiKey when OBSIDIAN_API_KEY not set", () => {
    const config = loadConfig();
    expect(config.apiKey).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Env var overrides
// ---------------------------------------------------------------------------
describe("loadConfig — env overrides", () => {
  it("overrides host from OBSIDIAN_HOST", () => {
    process.env["OBSIDIAN_HOST"] = "192.168.1.100";
    expect(loadConfig().host).toBe("192.168.1.100");
  });

  it("overrides port from OBSIDIAN_PORT", () => {
    process.env["OBSIDIAN_PORT"] = "8080";
    expect(loadConfig().port).toBe(8080);
  });

  it("overrides scheme from OBSIDIAN_SCHEME", () => {
    process.env["OBSIDIAN_SCHEME"] = "http";
    expect(loadConfig().scheme).toBe("http");
  });

  it("overrides timeout from OBSIDIAN_TIMEOUT", () => {
    process.env["OBSIDIAN_TIMEOUT"] = "5000";
    expect(loadConfig().timeout).toBe(5000);
  });

  it("overrides certPath from OBSIDIAN_CERT_PATH", () => {
    process.env["OBSIDIAN_CERT_PATH"] = "/some/cert.pem";
    expect(loadConfig().certPath).toBe("/some/cert.pem");
  });

  it("overrides verifySsl from OBSIDIAN_VERIFY_SSL", () => {
    process.env["OBSIDIAN_VERIFY_SSL"] = "true";
    expect(loadConfig().verifySsl).toBe(true);
  });

  it("overrides verifyWrites from OBSIDIAN_VERIFY_WRITES", () => {
    process.env["OBSIDIAN_VERIFY_WRITES"] = "true";
    expect(loadConfig().verifyWrites).toBe(true);
  });

  it("overrides maxResponseChars from OBSIDIAN_MAX_RESPONSE_CHARS", () => {
    process.env["OBSIDIAN_MAX_RESPONSE_CHARS"] = "1000";
    expect(loadConfig().maxResponseChars).toBe(1000);
  });

  it("overrides debug from OBSIDIAN_DEBUG", () => {
    process.env["OBSIDIAN_DEBUG"] = "true";
    expect(loadConfig().debug).toBe(true);
  });

  it("overrides toolMode from TOOL_MODE", () => {
    process.env["TOOL_MODE"] = "consolidated";
    expect(loadConfig().toolMode).toBe("consolidated");
  });

  it("overrides toolPreset from TOOL_PRESET", () => {
    process.env["TOOL_PRESET"] = "read-only";
    expect(loadConfig().toolPreset).toBe("read-only");
  });

  it("overrides includeTools from INCLUDE_TOOLS", () => {
    process.env["INCLUDE_TOOLS"] = "search, vault, status";
    expect(loadConfig().includeTools).toEqual(["search", "vault", "status"]);
  });

  it("overrides excludeTools from EXCLUDE_TOOLS", () => {
    process.env["EXCLUDE_TOOLS"] = "delete_file,delete_active_file";
    expect(loadConfig().excludeTools).toEqual(["delete_file", "delete_active_file"]);
  });

  it("overrides cacheTtl from OBSIDIAN_CACHE_TTL", () => {
    process.env["OBSIDIAN_CACHE_TTL"] = "120000";
    expect(loadConfig().cacheTtl).toBe(120000);
  });

  it("overrides enableCache from OBSIDIAN_ENABLE_CACHE", () => {
    process.env["OBSIDIAN_ENABLE_CACHE"] = "false";
    expect(loadConfig().enableCache).toBe(false);
  });

  it("overrides compactResponses from OBSIDIAN_COMPACT_RESPONSES", () => {
    process.env["OBSIDIAN_COMPACT_RESPONSES"] = "true";
    expect(loadConfig().compactResponses).toBe(true);
  });

  it("defaults compactResponses to false", () => {
    expect(loadConfig().compactResponses).toBe(false);
  });

  it("reads OBSIDIAN_API_KEY", () => {
    process.env["OBSIDIAN_API_KEY"] = "my-secret-key";
    expect(loadConfig().apiKey).toBe("my-secret-key");
  });
});

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------
describe("loadConfig — config file", () => {
  it("loads values from a config file", () => {
    const configPath = resolve("./obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation((p) => String(p) === configPath);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      host: "10.0.0.1",
      port: 9999,
      scheme: "http",
      debug: true,
      tools: { mode: "consolidated", preset: "safe" },
      reliability: { timeout: 5000, verifyWrites: true, maxResponseChars: 1000 },
      tls: { verifySsl: true },
      cache: { ttl: 30000, enabled: false },
    }));

    const config = loadConfig();
    expect(config.host).toBe("10.0.0.1");
    expect(config.port).toBe(9999);
    expect(config.scheme).toBe("http");
    expect(config.debug).toBe(true);
    expect(config.toolMode).toBe("consolidated");
    expect(config.toolPreset).toBe("safe");
    expect(config.timeout).toBe(5000);
    expect(config.verifyWrites).toBe(true);
    expect(config.maxResponseChars).toBe(1000);
    expect(config.verifySsl).toBe(true);
    expect(config.cacheTtl).toBe(30000);
    expect(config.enableCache).toBe(false);
  });

  it("env vars override config file values", () => {
    const configPath = resolve("./obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation((p) => String(p) === configPath);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      host: "10.0.0.1",
      port: 9999,
    }));

    process.env["OBSIDIAN_HOST"] = "override-host";
    const config = loadConfig();
    expect(config.host).toBe("override-host");
    expect(config.port).toBe(9999); // from file, not overridden
  });

  it("warns and uses empty config on invalid config file JSON types", () => {
    const configPath = resolve("./obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation((p) => String(p) === configPath);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      port: "not-a-number", // should be number
    }));

    const config = loadConfig();
    // Falls back to default since validation failed
    expect(config.port).toBe(27124);
  });

  it("warns when OBSIDIAN_CONFIG path does not exist", () => {
    process.env["OBSIDIAN_CONFIG"] = "/nonexistent/config.json";
    mockedExistsSync.mockReturnValue(false);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    loadConfig();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("OBSIDIAN_CONFIG path does not exist"))).toBe(true);
  });

  it("handles corrupted config file gracefully", () => {
    const configPath = resolve("./obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation((p) => String(p) === configPath);
    mockedReadFileSync.mockReturnValue("not valid json{{{");

    const config = loadConfig();
    // Should fall back to defaults
    expect(config.host).toBe("127.0.0.1");
  });

  it("searches config file in standard locations", () => {
    // The second search path (home dir)
    const homePath = join(homedir(), ".obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation((p) => String(p) === homePath);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ host: "from-home" }));

    const config = loadConfig();
    expect(config.host).toBe("from-home");
    expect(config.configFilePath).toBe(homePath);
  });
});

// ---------------------------------------------------------------------------
// getRedactedConfig
// ---------------------------------------------------------------------------
describe("getRedactedConfig", () => {
  it("masks API key as [SET] when present", () => {
    const config: Config = {
      apiKey: "super-secret",
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

    const redacted = getRedactedConfig(config);
    expect(redacted["apiKey"]).toBe("[SET]");
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
  });

  it("masks API key as [NOT SET] when empty", () => {
    const config: Config = {
      apiKey: "",
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

    const redacted = getRedactedConfig(config);
    expect(redacted["apiKey"]).toBe("[NOT SET]");
  });

  it("shows null for undefined certPath and configFilePath", () => {
    const config = loadConfig();
    const redacted = getRedactedConfig(config);
    expect(redacted["certPath"]).toBeNull();
    expect(redacted["configFilePath"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseBoolean (tested through loadConfig env overrides)
// ---------------------------------------------------------------------------
describe("parseBoolean — via env vars", () => {
  const booleanTrueValues = ["true", "1", "yes", "on", "TRUE", "True", "YES", "ON"];
  const booleanFalseValues = ["false", "0", "no", "off", "FALSE", "False", "NO", "OFF"];

  for (const val of booleanTrueValues) {
    it(`parses "${val}" as true`, () => {
      process.env["OBSIDIAN_DEBUG"] = val;
      expect(loadConfig().debug).toBe(true);
    });
  }

  for (const val of booleanFalseValues) {
    it(`parses "${val}" as false`, () => {
      process.env["OBSIDIAN_VERIFY_WRITES"] = val;
      expect(loadConfig().verifyWrites).toBe(false);
    });
  }

  it("falls back to default for unrecognised boolean value", () => {
    process.env["OBSIDIAN_DEBUG"] = "maybe";
    // Default for debug is false
    expect(loadConfig().debug).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseNumber (tested through loadConfig env overrides)
// ---------------------------------------------------------------------------
describe("parseNumber — via env vars", () => {
  it("parses valid number strings", () => {
    process.env["OBSIDIAN_PORT"] = "3000";
    expect(loadConfig().port).toBe(3000);
  });

  it("falls back to default for NaN", () => {
    process.env["OBSIDIAN_PORT"] = "abc";
    expect(loadConfig().port).toBe(27124);
  });

  it("falls back to default when undefined", () => {
    expect(loadConfig().port).toBe(27124);
  });

  it("handles zero", () => {
    process.env["OBSIDIAN_MAX_RESPONSE_CHARS"] = "0";
    expect(loadConfig().maxResponseChars).toBe(0);
  });

  it("rejects negative numbers and uses default", () => {
    process.env["OBSIDIAN_TIMEOUT"] = "-100";
    expect(loadConfig().timeout).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// parseCommaSeparated (tested through loadConfig env overrides)
// ---------------------------------------------------------------------------
describe("parseCommaSeparated — via env vars", () => {
  it("splits comma-separated values and trims whitespace", () => {
    process.env["INCLUDE_TOOLS"] = " vault , search , status ";
    expect(loadConfig().includeTools).toEqual(["vault", "search", "status"]);
  });

  it("returns empty array for empty string", () => {
    process.env["INCLUDE_TOOLS"] = "";
    expect(loadConfig().includeTools).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    process.env["INCLUDE_TOOLS"] = "   ";
    expect(loadConfig().includeTools).toEqual([]);
  });

  it("handles single value without comma", () => {
    process.env["INCLUDE_TOOLS"] = "vault";
    expect(loadConfig().includeTools).toEqual(["vault"]);
  });

  it("filters out empty segments from trailing commas", () => {
    process.env["INCLUDE_TOOLS"] = "vault,,search,";
    expect(loadConfig().includeTools).toEqual(["vault", "search"]);
  });
});

// ---------------------------------------------------------------------------
// validateScheme / validateToolMode / validateToolPreset (via env)
// ---------------------------------------------------------------------------
describe("validation helpers — via env vars", () => {
  it("returns default for invalid scheme", () => {
    process.env["OBSIDIAN_SCHEME"] = "ftp";
    expect(loadConfig().scheme).toBe("https");
  });

  it("accepts http scheme", () => {
    process.env["OBSIDIAN_SCHEME"] = "http";
    expect(loadConfig().scheme).toBe("http");
  });

  it("returns default for invalid tool mode", () => {
    process.env["TOOL_MODE"] = "turbo";
    expect(loadConfig().toolMode).toBe("granular");
  });

  it("accepts consolidated tool mode", () => {
    process.env["TOOL_MODE"] = "consolidated";
    expect(loadConfig().toolMode).toBe("consolidated");
  });

  it("returns default for invalid tool preset", () => {
    process.env["TOOL_PRESET"] = "ultra";
    expect(loadConfig().toolPreset).toBe("full");
  });

  it("accepts read-only preset", () => {
    process.env["TOOL_PRESET"] = "read-only";
    expect(loadConfig().toolPreset).toBe("read-only");
  });

  it("accepts minimal preset", () => {
    process.env["TOOL_PRESET"] = "minimal";
    expect(loadConfig().toolPreset).toBe("minimal");
  });

  it("accepts safe preset", () => {
    process.env["TOOL_PRESET"] = "safe";
    expect(loadConfig().toolPreset).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// saveConfigToFile
// ---------------------------------------------------------------------------
describe("saveConfigToFile", () => {
  it("creates a new file when none exists", () => {
    mockedExistsSync.mockReturnValue(false);
    saveConfigToFile("/tmp/test.json", { host: "new-host" });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0]?.[1]));
    expect(written.host).toBe("new-host");
  });

  it("deep-merges into existing config file", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      host: "old-host",
      tools: { mode: "granular", preset: "full" },
    }));

    saveConfigToFile("/tmp/test.json", {
      tools: { preset: "safe" },
    });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0]?.[1]));
    expect(written.host).toBe("old-host"); // preserved
    expect(written.tools.mode).toBe("granular"); // preserved
    expect(written.tools.preset).toBe("safe"); // updated
  });

  it("handles corrupted existing file by starting fresh", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json");

    saveConfigToFile("/tmp/test.json", { debug: true });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0]?.[1]));
    expect(written.debug).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setDebugEnabled + log
// ---------------------------------------------------------------------------
describe("setDebugEnabled and log", () => {
  it("suppresses debug messages by default", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("debug", "should not appear");
    // The spy was already set up, check that no debug call was made
    const debugCalls = spy.mock.calls.filter((c) => String(c[0]).includes("should not appear"));
    expect(debugCalls).toHaveLength(0);
  });

  it("outputs debug messages after setDebugEnabled(true)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setDebugEnabled(true);
    log("debug", "visible debug");
    const debugCalls = spy.mock.calls.filter((c) => String(c[0]).includes("visible debug"));
    expect(debugCalls).toHaveLength(1);
  });

  it("always outputs info, warn, and error messages", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("info", "info-msg");
    log("warn", "warn-msg");
    log("error", "error-msg");

    const output = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("info-msg");
    expect(output).toContain("warn-msg");
    expect(output).toContain("error-msg");
  });

  it("formats log messages with level prefix", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("warn", "test message");
    expect(spy).toHaveBeenCalledWith("[warn] test message\n");
  });
});

// ---------------------------------------------------------------------------
// getDebugEnabled
// ---------------------------------------------------------------------------
describe("getDebugEnabled", () => {
  it("reflects live debug state after setDebugEnabled", () => {
    expect(getDebugEnabled()).toBe(false);
    setDebugEnabled(true);
    expect(getDebugEnabled()).toBe(true);
    setDebugEnabled(false);
    expect(getDebugEnabled()).toBe(false);
  });

  it("is reflected in getRedactedConfig", () => {
    const config = loadConfig();
    setDebugEnabled(true);
    const redacted = getRedactedConfig(config);
    expect(redacted["debug"]).toBe(true);
    setDebugEnabled(false);
    const redacted2 = getRedactedConfig(config);
    expect(redacted2["debug"]).toBe(false);
  });
});
