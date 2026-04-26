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
    if (
      key.startsWith("OBSIDIAN_") ||
      key.startsWith("TOOL_") ||
      key === "INCLUDE_TOOLS" ||
      key === "EXCLUDE_TOOLS"
    ) {
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
    expect(loadConfig().excludeTools).toEqual([
      "delete_file",
      "delete_active_file",
    ]);
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
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        host: "10.0.0.1",
        port: 9999,
        scheme: "http",
        debug: true,
        tools: { mode: "consolidated", preset: "safe" },
        reliability: {
          timeout: 5000,
          verifyWrites: true,
          maxResponseChars: 1000,
        },
        tls: { verifySsl: true },
        cache: { ttl: 30000, enabled: false },
      }),
    );

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
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        host: "10.0.0.1",
        port: 9999,
      }),
    );

    process.env["OBSIDIAN_HOST"] = "override-host";
    const config = loadConfig();
    expect(config.host).toBe("override-host");
    expect(config.port).toBe(9999); // from file, not overridden
  });

  it("warns and uses empty config on invalid config file JSON types", () => {
    const configPath = resolve("./obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation((p) => String(p) === configPath);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        port: "not-a-number", // should be number
      }),
    );

    const config = loadConfig();
    // Falls back to default since validation failed
    expect(config.port).toBe(27124);
  });

  it("warns when OBSIDIAN_CONFIG path does not exist", () => {
    process.env["OBSIDIAN_CONFIG"] = "/nonexistent/config.json";
    mockedExistsSync.mockReturnValue(false);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    loadConfig();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((c) => c.includes("OBSIDIAN_CONFIG path does not exist")),
    ).toBe(true);
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
  const booleanTrueValues = [
    "true",
    "1",
    "yes",
    "on",
    "TRUE",
    "True",
    "YES",
    "ON",
  ];
  const booleanFalseValues = [
    "false",
    "0",
    "no",
    "off",
    "FALSE",
    "False",
    "NO",
    "OFF",
  ];

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
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        host: "old-host",
        tools: { mode: "granular", preset: "full" },
      }),
    );

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
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    log("debug", "should not appear");
    // The spy was already set up, check that no debug call was made
    const debugCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes("should not appear"),
    );
    expect(debugCalls).toHaveLength(0);
  });

  it("outputs debug messages after setDebugEnabled(true)", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    setDebugEnabled(true);
    log("debug", "visible debug");
    const debugCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes("visible debug"),
    );
    expect(debugCalls).toHaveLength(1);
  });

  it("always outputs info, warn, and error messages", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    log("info", "info-msg");
    log("warn", "warn-msg");
    log("error", "error-msg");

    const output = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("info-msg");
    expect(output).toContain("warn-msg");
    expect(output).toContain("error-msg");
  });

  it("formats log messages with level prefix", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
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

// ---------------------------------------------------------------------------
// Stryker mutation backfill — config.ts
// ---------------------------------------------------------------------------

describe("Stryker backfill — deepMerge via saveConfigToFile", () => {
  // deepMerge is private; exercised through saveConfigToFile which reads
  // the existing file, deep-merges updates, and writes the JSON result.
  // Each test asserts the EXACT merged JSON that gets written so mutations
  // affecting recursion, leaf-vs-object discrimination, prototype-pollution
  // guards, or array handling are killed.

  function getWrittenJson(): unknown {
    const lastCall = mockedWriteFileSync.mock.lastCall;
    if (!lastCall) throw new Error("writeFileSync was not called");
    const content = lastCall[1];
    if (typeof content !== "string")
      throw new Error("writeFileSync content must be a string");
    return JSON.parse(content);
  }

  it("creates fresh object when file does not exist (existsSync false)", () => {
    mockedExistsSync.mockReturnValue(false);
    saveConfigToFile("/tmp/cfg.json", { host: "newhost" });
    expect(getWrittenJson()).toEqual({ host: "newhost" });
  });

  it("recursively merges nested objects (target object + source object → recursion)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tools: { mode: "granular", preset: "full" } }),
    );
    saveConfigToFile("/tmp/cfg.json", { tools: { mode: "consolidated" } });
    // Recursion preserves the untouched `preset` key under `tools`.
    expect(getWrittenJson()).toEqual({
      tools: { mode: "consolidated", preset: "full" },
    });
  });

  it("source leaf overwrites target leaf (no merge for primitives)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ port: 27124 }));
    saveConfigToFile("/tmp/cfg.json", { port: 9999 });
    expect(getWrittenJson()).toEqual({ port: 9999 });
  });

  it("source object replaces target leaf (no recursion when target is non-object)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ tools: "wrong" }));
    saveConfigToFile("/tmp/cfg.json", { tools: { mode: "consolidated" } });
    expect(getWrittenJson()).toEqual({ tools: { mode: "consolidated" } });
  });

  it("source leaf replaces target object (no recursion when source is non-object)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tools: { mode: "granular" } }),
    );
    saveConfigToFile("/tmp/cfg.json", { tools: null });
    expect(getWrittenJson()).toEqual({ tools: null });
  });

  it("array source replaces array target (arrays are NOT recursed into)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tools: { include: ["a", "b"] } }),
    );
    saveConfigToFile("/tmp/cfg.json", { tools: { include: ["c"] } });
    // Array gets replaced wholesale, not concatenated/merged.
    expect(getWrittenJson()).toEqual({ tools: { include: ["c"] } });
  });

  it("array source replaces object target (Array.isArray guard prevents recursion)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ data: { a: 1, b: 2 } }),
    );
    saveConfigToFile("/tmp/cfg.json", { data: [1, 2, 3] });
    expect(getWrittenJson()).toEqual({ data: [1, 2, 3] });
  });

  it("preserves keys present in target but missing from source", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ host: "old", port: 27124, debug: true }),
    );
    saveConfigToFile("/tmp/cfg.json", { host: "new" });
    expect(getWrittenJson()).toEqual({ host: "new", port: 27124, debug: true });
  });

  it("blocks __proto__ key (prototype pollution guard)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({}));
    // The object-literal shorthand `{ __proto__: ... }` is special syntax
    // that sets the prototype rather than creating an own enumerable
    // property. Use Object.defineProperty so __proto__ is an own
    // enumerable key Object.keys() will include — otherwise the
    // `key === "__proto__"` guard in deepMerge is never reached and a
    // mutant removing it would survive (Greptile P1 + Gemini medium @ #65).
    const malicious: Record<string, unknown> = { host: "ok" };
    Object.defineProperty(malicious, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    saveConfigToFile("/tmp/cfg.json", malicious);
    const written = getWrittenJson() as Record<string, unknown>;
    expect(written).toEqual({ host: "ok" });
    expect("polluted" in {}).toBe(false);
  });

  it("blocks constructor key (prototype pollution guard)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({}));
    saveConfigToFile("/tmp/cfg.json", {
      constructor: { polluted: true },
      host: "ok",
    });
    expect(getWrittenJson()).toEqual({ host: "ok" });
  });

  it("blocks prototype key (prototype pollution guard)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({}));
    saveConfigToFile("/tmp/cfg.json", {
      prototype: { polluted: true },
      host: "ok",
    });
    expect(getWrittenJson()).toEqual({ host: "ok" });
  });

  it("writes JSON with 2-space indent and trailing newline (exact format)", () => {
    mockedExistsSync.mockReturnValue(false);
    saveConfigToFile("/tmp/cfg.json", { host: "x" });
    const lastCall = mockedWriteFileSync.mock.lastCall;
    expect(lastCall?.[0]).toBe("/tmp/cfg.json");
    expect(lastCall?.[1]).toBe('{\n  "host": "x"\n}\n');
    expect(lastCall?.[2]).toBe("utf-8");
  });

  it("treats existing file content of [] (array) as fresh object", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("[]");
    saveConfigToFile("/tmp/cfg.json", { host: "x" });
    // Array is rejected at the !Array.isArray guard, falls back to {} merge.
    expect(getWrittenJson()).toEqual({ host: "x" });
  });

  it("treats existing file content of null as fresh object", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("null");
    saveConfigToFile("/tmp/cfg.json", { host: "x" });
    expect(getWrittenJson()).toEqual({ host: "x" });
  });
});

describe("Stryker backfill — exact warn message formats", () => {
  it("parseBoolean logs exact warn for unrecognised value (via OBSIDIAN_DEBUG)", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["OBSIDIAN_DEBUG"] = "maybe";
    loadConfig();
    expect(spy).toHaveBeenCalledWith(
      `[warn] Unrecognised boolean env value "maybe", using default false\n`,
    );
  });

  it("parseNumber logs exact warn for invalid numeric value (via OBSIDIAN_PORT)", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["OBSIDIAN_PORT"] = "abc";
    loadConfig();
    expect(spy).toHaveBeenCalledWith(
      `[warn] Invalid numeric value "abc", using default 27124\n`,
    );
  });

  it("parseNumber logs exact warn for non-integer value (via OBSIDIAN_PORT)", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["OBSIDIAN_PORT"] = "1.5";
    loadConfig();
    expect(spy).toHaveBeenCalledWith(
      `[warn] Non-integer value "1.5", using default 27124\n`,
    );
  });

  it("parseNumber logs exact warn for value below minimum (via OBSIDIAN_PORT)", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["OBSIDIAN_PORT"] = "0";
    loadConfig();
    expect(spy).toHaveBeenCalledWith(
      `[warn] Numeric value 0 below minimum 1, using default 27124\n`,
    );
  });

  it("parseNumber logs exact warn for value above maximum (via OBSIDIAN_PORT)", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["OBSIDIAN_PORT"] = "70000";
    loadConfig();
    expect(spy).toHaveBeenCalledWith(
      `[warn] Numeric value 70000 above maximum 65535, using default 27124\n`,
    );
  });

  it("validateScheme logs exact warn for unrecognised scheme", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["OBSIDIAN_SCHEME"] = "ftp";
    const cfg = loadConfig();
    expect(cfg.scheme).toBe("https");
    expect(spy).toHaveBeenCalledWith(
      `[warn] Unrecognised scheme "ftp", using default "https"\n`,
    );
  });

  it("validateToolMode logs exact warn for unrecognised mode", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["TOOL_MODE"] = "weird";
    const cfg = loadConfig();
    expect(cfg.toolMode).toBe("granular");
    expect(spy).toHaveBeenCalledWith(
      `[warn] Unrecognised tool mode "weird", using default "granular"\n`,
    );
  });

  it("validateToolPreset logs exact warn for unrecognised preset", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.env["TOOL_PRESET"] = "weird";
    const cfg = loadConfig();
    expect(cfg.toolPreset).toBe("full");
    expect(spy).toHaveBeenCalledWith(
      `[warn] Unrecognised tool preset "weird", using default "full"\n`,
    );
  });

  it("validateScheme/Mode/Preset are case-insensitive", () => {
    process.env["OBSIDIAN_SCHEME"] = "HTTP";
    process.env["TOOL_MODE"] = "Consolidated";
    process.env["TOOL_PRESET"] = "READ-ONLY";
    const cfg = loadConfig();
    expect(cfg.scheme).toBe("http");
    expect(cfg.toolMode).toBe("consolidated");
    expect(cfg.toolPreset).toBe("read-only");
  });

  it("validateScheme/Mode/Preset do NOT log warn for undefined input", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    loadConfig(); // no env vars set
    const calls = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).not.toContain("Unrecognised scheme");
    expect(calls).not.toContain("Unrecognised tool mode");
    expect(calls).not.toContain("Unrecognised tool preset");
  });
});

describe("Stryker backfill — recoverNestedKeys and recoverConfigFields", () => {
  // These are private helpers exercised through loadConfig() with a config
  // file that has invalid structure. The recovery path is triggered when
  // the top-level Zod parse fails but per-section / per-nested-key parses
  // can salvage valid data.

  it("recovers valid nested keys when parent section has invalid sibling", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    // Top-level fails because tools.mode is wrong type; tools.preset is valid.
    // Via recoverConfigFields → recoverNestedKeys, preset should be salvaged.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        tools: { mode: 12345, preset: "minimal" },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.toolPreset).toBe("minimal");
  });

  it("ignores top-level keys not in schema", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    // unknownTopLevelKey is not in schemaShape → filtered out. host is valid.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        host: "from-file",
        unknownTopLevelKey: { foo: "bar" },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.host).toBe("from-file");
  });

  it("returns empty object when file root is an array (not an object)", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(JSON.stringify(["not", "an", "object"]));
    const cfg = loadConfig();
    expect(cfg.host).toBe("127.0.0.1"); // falls through to default
  });

  it("returns empty object when file root is null", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue("null");
    const cfg = loadConfig();
    expect(cfg.host).toBe("127.0.0.1");
  });
});

describe("Stryker backfill — loadConfig 3-tier precedence", () => {
  // Defaults < config file < env vars. Test each tier explicitly per setting.

  it("env var beats config file (host)", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(JSON.stringify({ host: "from-file" }));
    process.env["OBSIDIAN_HOST"] = "from-env";
    const cfg = loadConfig();
    expect(cfg.host).toBe("from-env");
  });

  it("config file beats default (host)", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(JSON.stringify({ host: "from-file" }));
    const cfg = loadConfig();
    expect(cfg.host).toBe("from-file");
  });

  it("certPath: file null is rewritten to undefined (falls back to DEFAULTS.certPath)", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tls: { certPath: null } }),
    );
    const cfg = loadConfig();
    // tls.certPath === null → undefined → DEFAULTS.certPath (undefined)
    expect(cfg.certPath).toBeUndefined();
  });

  it("certPath: env var overrides file value", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tls: { certPath: "/from/file.crt" } }),
    );
    process.env["OBSIDIAN_CERT_PATH"] = "/from/env.crt";
    const cfg = loadConfig();
    expect(cfg.certPath).toBe("/from/env.crt");
  });

  it("certPath: file value used when env var is unset", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tls: { certPath: "/from/file.crt" } }),
    );
    const cfg = loadConfig();
    expect(cfg.certPath).toBe("/from/file.crt");
  });

  it("includeTools: env undefined → use file value", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tools: { include: ["a", "b"] } }),
    );
    const cfg = loadConfig();
    expect(cfg.includeTools).toEqual(["a", "b"]);
  });

  it("includeTools: env defined → parse env, ignore file", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tools: { include: ["from-file"] } }),
    );
    process.env["INCLUDE_TOOLS"] = "x,y,z";
    const cfg = loadConfig();
    expect(cfg.includeTools).toEqual(["x", "y", "z"]);
  });

  it("excludeTools: empty env string → empty array (NOT file fallback)", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tools: { exclude: ["from-file"] } }),
    );
    process.env["EXCLUDE_TOOLS"] = "";
    const cfg = loadConfig();
    // env is defined but empty → parseCommaSeparated returns []
    expect(cfg.excludeTools).toEqual([]);
  });
});

describe("Stryker backfill — getRedactedConfig overrides", () => {
  it("debug override beats getDebugEnabled state", () => {
    setDebugEnabled(false);
    const cfg = loadConfig();
    const redacted = getRedactedConfig(cfg, { debug: true });
    expect(redacted["debug"]).toBe(true);
  });

  it("compactResponses override beats config value", () => {
    process.env["OBSIDIAN_COMPACT_RESPONSES"] = "false";
    const cfg = loadConfig();
    const redacted = getRedactedConfig(cfg, { compactResponses: true });
    expect(redacted["compactResponses"]).toBe(true);
  });

  it("debug falls back to getDebugEnabled when override is undefined", () => {
    setDebugEnabled(true);
    const cfg = loadConfig();
    const redacted = getRedactedConfig(cfg, { debug: undefined });
    expect(redacted["debug"]).toBe(true);
  });

  it("compactResponses falls back to config value when override is undefined", () => {
    process.env["OBSIDIAN_COMPACT_RESPONSES"] = "true";
    const cfg = loadConfig();
    const redacted = getRedactedConfig(cfg, { compactResponses: undefined });
    expect(redacted["compactResponses"]).toBe(true);
  });

  it("certPath null is preserved in redacted output (not 'undefined')", () => {
    const cfg = loadConfig();
    const redacted = getRedactedConfig(cfg);
    expect(redacted["certPath"]).toBeNull();
  });

  it("configFilePath null is preserved when not provided", () => {
    const cfg = loadConfig();
    const redacted = getRedactedConfig(cfg);
    expect(redacted["configFilePath"]).toBeNull();
  });
});

describe("Stryker backfill — log function exact behaviour", () => {
  it("debug message is suppressed when debugEnabled=false", () => {
    setDebugEnabled(false);
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    log("debug", "secret");
    expect(spy).not.toHaveBeenCalled();
  });

  it("debug message appears with exact '[debug] ...\\n' format when enabled", () => {
    setDebugEnabled(true);
    try {
      const spy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      log("debug", "trace");
      expect(spy).toHaveBeenCalledWith("[debug] trace\n");
    } finally {
      setDebugEnabled(false);
    }
  });

  it.each([
    ["info", "[info] hello\n"],
    ["warn", "[warn] hello\n"],
    ["error", "[error] hello\n"],
  ] as const)("log(%s) writes exact prefix %j", (level, expected) => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    log(level, "hello");
    expect(spy).toHaveBeenCalledWith(expected);
  });
});

// ---------------------------------------------------------------------------
// Stryker mutation backfill — config.ts residual (PR #19)
// ---------------------------------------------------------------------------
//
// Targets surviving mutants in: findConfigFile, loadConfigFile warn-message
// format, recoverConfigFields edge cases, parseNumber options-undefined
// branches, validate* HTTPS path, and saveConfigToFile corrupted-file warn.

describe("Stryker backfill — findConfigFile env path resolution", () => {
  // The file-level beforeEach calls mockedExistsSync.mockReturnValue(false)
  // but does NOT clear .mock.calls (existing tests don't care about call
  // counts). These tests assert exact call counts on the search-path loop,
  // so clear the call history at the start of each test.
  beforeEach(() => {
    mockedExistsSync.mockClear();
  });

  it("OBSIDIAN_CONFIG path that EXISTS is returned (resolves through resolve())", () => {
    process.env["OBSIDIAN_CONFIG"] = "/custom/cfg.json";
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("/custom/cfg.json"),
    );
    mockedReadFileSync.mockReturnValue(JSON.stringify({ host: "from-custom" }));
    const cfg = loadConfig();
    expect(cfg.host).toBe("from-custom");
    expect(cfg.configFilePath).toBe(resolve("/custom/cfg.json"));
  });

  it("OBSIDIAN_CONFIG path that does NOT exist logs exact warn and returns undefined", () => {
    process.env["OBSIDIAN_CONFIG"] = "/missing/cfg.json";
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    mockedExistsSync.mockReturnValue(false);
    const cfg = loadConfig();
    expect(cfg.configFilePath).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      `[warn] OBSIDIAN_CONFIG path does not exist: ${resolve("/missing/cfg.json")}\n`,
    );
  });

  it("OBSIDIAN_CONFIG set short-circuits the search-path loop (only one existsSync call)", () => {
    process.env["OBSIDIAN_CONFIG"] = "/exists/cfg.json";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("{}");
    loadConfig();
    // existsSync called only ONCE (for OBSIDIAN_CONFIG resolved path),
    // NOT 3 times (the standard search paths).
    expect(mockedExistsSync).toHaveBeenCalledTimes(1);
  });

  it("standard search returns first hit (cwd) and does not check later paths", () => {
    const cwdPath = resolve("./obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) => String(p) === cwdPath,
    );
    mockedReadFileSync.mockReturnValue("{}");
    const cfg = loadConfig();
    expect(cfg.configFilePath).toBe(cwdPath);
    // Only the first path was checked because it returned true.
    expect(mockedExistsSync).toHaveBeenCalledTimes(1);
  });

  it("standard search continues to second path if first does not exist", () => {
    const homePath = join(homedir(), ".obsidian-mcp.config.json");
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) => String(p) === homePath,
    );
    mockedReadFileSync.mockReturnValue("{}");
    const cfg = loadConfig();
    expect(cfg.configFilePath).toBe(homePath);
    // Two checks: cwd (false), home (true).
    expect(mockedExistsSync).toHaveBeenCalledTimes(2);
  });

  it("standard search continues to third path if first two do not exist", () => {
    const xdgPath = join(homedir(), ".config", "obsidian-mcp", "config.json");
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) => String(p) === xdgPath,
    );
    mockedReadFileSync.mockReturnValue("{}");
    const cfg = loadConfig();
    expect(cfg.configFilePath).toBe(xdgPath);
    expect(mockedExistsSync).toHaveBeenCalledTimes(3);
  });

  it("standard search returns undefined when no path exists", () => {
    mockedExistsSync.mockReturnValue(false);
    const cfg = loadConfig();
    expect(cfg.configFilePath).toBeUndefined();
    expect(mockedExistsSync).toHaveBeenCalledTimes(3);
  });
});

describe("Stryker backfill — loadConfigFile warn message format", () => {
  it("logs exact warn with comma-joined Zod issues for invalid file", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    // Two invalid fields: port (string instead of number), debug (string
    // instead of boolean). Issues format: "<path>: <message>" joined by ", ".
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ port: "not-a-number", debug: "not-a-bool" }),
    );
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    loadConfig();
    const calls = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).toContain(
      `Config file ${resolve("./obsidian-mcp.config.json")} has invalid fields: `,
    );
    expect(calls).toContain(". Invalid fields ignored.");
    expect(calls).toContain("port:");
    expect(calls).toContain("debug:");
  });
});

describe("Stryker backfill — recoverConfigFields multi-key partial recovery", () => {
  // recoverConfigFields walks Object.keys; for each key it first tries
  // safeParse (whole-section) then falls back to per-nested-key. This
  // test exercises both branches in one pass (host: whole-section pass,
  // tools: nested recovery, port: dropped entirely as non-recoverable).
  it("recovers a mix of whole-section, nested-key, and dropped fields", () => {
    mockedExistsSync.mockImplementation(
      (p: import("node:fs").PathLike) =>
        String(p) === resolve("./obsidian-mcp.config.json"),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        host: "valid-string",
        port: { not: "a number" }, // dropped — neither whole-section nor nested
        tools: {
          mode: 12345, // bad type
          preset: "minimal", // good — recovered via nested
          include: ["a", "b"], // good
        },
        unknownKey: { foo: "bar" }, // not in schema → continue
      }),
    );
    const cfg = loadConfig();
    expect(cfg.host).toBe("valid-string");
    expect(cfg.toolPreset).toBe("minimal");
    expect(cfg.includeTools).toEqual(["a", "b"]);
    // port dropped → falls back to default
    expect(cfg.port).toBe(27124);
  });
});

describe("Stryker backfill — parseNumber options-absent branches", () => {
  // parseNumber takes optional options; when options is omitted entirely
  // the integer/min/max checks are SKIPPED. None of the existing tests
  // exercise the no-options path. Use OBSIDIAN_API_KEY-style test where
  // there's no caller without options today, so we test via cacheTtl
  // (which has min:10000) and OBSIDIAN_TIMEOUT (min:1).
  it("parseNumber accepts large values when only min is set (no max constraint)", () => {
    process.env["OBSIDIAN_TIMEOUT"] = "9999999999"; // huge
    const cfg = loadConfig();
    expect(cfg.timeout).toBe(9999999999);
  });

  it("parseNumber accepts integer values when integer:true (port=27124)", () => {
    process.env["OBSIDIAN_PORT"] = "27124";
    const cfg = loadConfig();
    expect(cfg.port).toBe(27124);
  });

  it("parseNumber accepts the boundary minimum (cacheTtl = 10000)", () => {
    process.env["OBSIDIAN_CACHE_TTL"] = "10000";
    const cfg = loadConfig();
    expect(cfg.cacheTtl).toBe(10000);
  });

  it("parseNumber rejects below-min for cacheTtl (9999) and falls back to default", () => {
    process.env["OBSIDIAN_CACHE_TTL"] = "9999";
    const cfg = loadConfig();
    expect(cfg.cacheTtl).toBe(600000);
  });
});

describe("Stryker backfill — validate* HTTPS path + case insensitivity", () => {
  it("validateScheme returns 'https' for input 'HTTPS' (case-insensitive)", () => {
    process.env["OBSIDIAN_SCHEME"] = "HTTPS";
    const cfg = loadConfig();
    expect(cfg.scheme).toBe("https");
  });

  it("validateScheme returns 'https' for input 'https' (lowercase)", () => {
    process.env["OBSIDIAN_SCHEME"] = "https";
    const cfg = loadConfig();
    expect(cfg.scheme).toBe("https");
  });

  it("validateToolMode returns 'granular' for mixed-case 'GraNular'", () => {
    process.env["TOOL_MODE"] = "GraNular";
    const cfg = loadConfig();
    expect(cfg.toolMode).toBe("granular");
  });

  it.each(["full", "FULL", "Full", "minimal", "MINIMAL", "safe", "Safe"])(
    "validateToolPreset accepts case-variant '%s'",
    (input) => {
      process.env["TOOL_PRESET"] = input;
      const cfg = loadConfig();
      expect(cfg.toolPreset).toBe(input.toLowerCase());
    },
  );
});

describe("Stryker backfill — saveConfigToFile corrupted file branches", () => {
  it("logs exact warn when existing file is not a JSON object (string)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('"just a string"');
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    saveConfigToFile("/tmp/cfg.json", { host: "x" });
    expect(spy).toHaveBeenCalledWith(
      `[warn] Config file /tmp/cfg.json is not a JSON object, starting fresh\n`,
    );
  });

  it("logs exact warn when existing file is invalid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json {{{");
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    saveConfigToFile("/tmp/cfg.json", { host: "x" });
    const calls = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).toContain(
      "Failed to read existing config file at /tmp/cfg.json (",
    );
    expect(calls).toContain("), starting fresh");
  });

  it("logs exact warn when existing file is an array (not an object)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("[1,2,3]");
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    saveConfigToFile("/tmp/cfg.json", { host: "x" });
    expect(spy).toHaveBeenCalledWith(
      `[warn] Config file /tmp/cfg.json is not a JSON object, starting fresh\n`,
    );
  });
});
