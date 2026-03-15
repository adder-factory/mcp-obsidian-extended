import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  ObsidianApiError,
  ObsidianConnectionError,
  ObsidianAuthError,
  buildErrorMessage,
} from "../errors.js";

// Suppress stderr output during tests
beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

// ---------------------------------------------------------------------------
// ObsidianApiError
// ---------------------------------------------------------------------------
describe("ObsidianApiError", () => {
  it("stores message and statusCode", () => {
    const err = new ObsidianApiError("Not found", 404);
    expect(err.message).toBe("Not found");
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe("ObsidianApiError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObsidianApiError);
  });

  it("stores optional errorCode", () => {
    const err = new ObsidianApiError("Bad request", 400, 42);
    expect(err.errorCode).toBe(42);
  });

  it("errorCode is undefined when omitted", () => {
    const err = new ObsidianApiError("oops", 500);
    expect(err.errorCode).toBeUndefined();
  });

  it("chains with Error.cause via options", () => {
    const cause = new Error("root");
    const err = new ObsidianApiError("wrapper", 500, undefined, { cause });
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// ObsidianConnectionError
// ---------------------------------------------------------------------------
describe("ObsidianConnectionError", () => {
  it("stores message and name", () => {
    const err = new ObsidianConnectionError("timeout");
    expect(err.message).toBe("timeout");
    expect(err.name).toBe("ObsidianConnectionError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObsidianConnectionError);
  });

  it("chains with Error.cause via options", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new ObsidianConnectionError("cannot connect", { cause });
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when omitted", () => {
    const err = new ObsidianConnectionError("network");
    expect(err.cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ObsidianAuthError
// ---------------------------------------------------------------------------
describe("ObsidianAuthError", () => {
  it("has fixed message", () => {
    const err = new ObsidianAuthError();
    expect(err.message).toBe("Authentication failed. Check OBSIDIAN_API_KEY.");
    expect(err.name).toBe("ObsidianAuthError");
  });

  it("is an instance of Error", () => {
    expect(new ObsidianAuthError()).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// buildErrorMessage
// ---------------------------------------------------------------------------
describe("buildErrorMessage", () => {
  const ctx = { tool: "get_file_contents", path: "notes/test.md" };

  it("returns CONNECTION ERROR for ObsidianConnectionError", () => {
    const err = new ObsidianConnectionError("refused");
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toContain("[get_file_contents]");
    expect(msg).toContain("CONNECTION ERROR");
    expect(msg).toContain("Ensure Obsidian is running");
  });

  it("returns AUTH ERROR for ObsidianAuthError", () => {
    const err = new ObsidianAuthError();
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toContain("[get_file_contents]");
    expect(msg).toContain("AUTH ERROR");
    expect(msg).toContain("Check OBSIDIAN_API_KEY");
  });

  it("returns NOT FOUND for 404 ObsidianApiError with path", () => {
    const err = new ObsidianApiError("nope", 404);
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toContain("[get_file_contents]");
    expect(msg).toContain("NOT FOUND");
    expect(msg).toContain("notes/test.md");
    expect(msg).toContain("list_files_in_vault");
  });

  it("returns NOT FOUND with 'Resource' when no path in context", () => {
    const err = new ObsidianApiError("nope", 404);
    const msg = buildErrorMessage(err, { tool: "search" });
    expect(msg).toContain("NOT FOUND: Resource does not exist");
  });

  it("returns BAD REQUEST for 400", () => {
    const err = new ObsidianApiError("invalid JSON body", 400);
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toContain("BAD REQUEST");
    expect(msg).toContain("invalid JSON body");
  });

  it("returns NOT SUPPORTED for 405", () => {
    const err = new ObsidianApiError("method not allowed", 405);
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toContain("NOT SUPPORTED");
    expect(msg).toContain("May require a specific plugin");
  });

  it("returns generic API ERROR for other status codes", () => {
    const err = new ObsidianApiError("server error", 500);
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toContain("API ERROR (500)");
    expect(msg).toContain("server error");
  });

  it("returns ERROR for generic Error", () => {
    const err = new Error("something broke");
    const msg = buildErrorMessage(err, ctx);
    expect(msg).toBe("[get_file_contents] ERROR: something broke");
  });

  it("returns ERROR with String() for non-Error values", () => {
    const msg = buildErrorMessage("string error", ctx);
    expect(msg).toBe("[get_file_contents] ERROR: string error");
  });

  it("handles number as error value", () => {
    const msg = buildErrorMessage(42, ctx);
    expect(msg).toBe("[get_file_contents] ERROR: 42");
  });

  it("handles null as error value", () => {
    const msg = buildErrorMessage(null, ctx);
    expect(msg).toBe("[get_file_contents] ERROR: null");
  });

  it("includes tool name prefix in all messages", () => {
    const errors = [
      new ObsidianConnectionError("x"),
      new ObsidianAuthError(),
      new ObsidianApiError("x", 404),
      new ObsidianApiError("x", 400),
      new ObsidianApiError("x", 405),
      new ObsidianApiError("x", 500),
      new Error("x"),
      "raw string",
    ];

    for (const err of errors) {
      const msg = buildErrorMessage(err, { tool: "my_tool" });
      expect(msg).toMatch(/^\[my_tool\] /);
    }
  });
});
