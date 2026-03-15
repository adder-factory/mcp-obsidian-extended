import { describe, it, expect } from "vitest";

import {
  formatSchema,
  periodSchema,
  patchOperationSchema,
  patchTargetTypeSchema,
  patchContentTypeSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// formatSchema
// ---------------------------------------------------------------------------
describe("formatSchema", () => {
  it('accepts "markdown"', () => {
    expect(formatSchema.parse("markdown")).toBe("markdown");
  });

  it('accepts "json"', () => {
    expect(formatSchema.parse("json")).toBe("json");
  });

  it('accepts "map"', () => {
    expect(formatSchema.parse("map")).toBe("map");
  });

  it('defaults to "markdown" when undefined', () => {
    expect(formatSchema.parse(undefined)).toBe("markdown");
  });

  it("rejects invalid values", () => {
    expect(() => formatSchema.parse("xml")).toThrow();
    expect(() => formatSchema.parse("")).toThrow();
    expect(() => formatSchema.parse(123)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// periodSchema
// ---------------------------------------------------------------------------
describe("periodSchema", () => {
  const validPeriods = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

  for (const period of validPeriods) {
    it(`accepts "${period}"`, () => {
      expect(periodSchema.parse(period)).toBe(period);
    });
  }

  it("rejects invalid values", () => {
    expect(() => periodSchema.parse("hourly")).toThrow();
    expect(() => periodSchema.parse("")).toThrow();
    expect(() => periodSchema.parse(42)).toThrow();
  });

  it("rejects undefined (no default)", () => {
    expect(() => periodSchema.parse(undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// patchOperationSchema
// ---------------------------------------------------------------------------
describe("patchOperationSchema", () => {
  it('accepts "append"', () => {
    expect(patchOperationSchema.parse("append")).toBe("append");
  });

  it('accepts "prepend"', () => {
    expect(patchOperationSchema.parse("prepend")).toBe("prepend");
  });

  it('accepts "replace"', () => {
    expect(patchOperationSchema.parse("replace")).toBe("replace");
  });

  it("rejects invalid values", () => {
    expect(() => patchOperationSchema.parse("insert")).toThrow();
    expect(() => patchOperationSchema.parse("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// patchTargetTypeSchema
// ---------------------------------------------------------------------------
describe("patchTargetTypeSchema", () => {
  it('accepts "heading"', () => {
    expect(patchTargetTypeSchema.parse("heading")).toBe("heading");
  });

  it('accepts "block"', () => {
    expect(patchTargetTypeSchema.parse("block")).toBe("block");
  });

  it('accepts "frontmatter"', () => {
    expect(patchTargetTypeSchema.parse("frontmatter")).toBe("frontmatter");
  });

  it("rejects invalid values", () => {
    expect(() => patchTargetTypeSchema.parse("paragraph")).toThrow();
    expect(() => patchTargetTypeSchema.parse("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// patchContentTypeSchema
// ---------------------------------------------------------------------------
describe("patchContentTypeSchema", () => {
  it('accepts "markdown"', () => {
    expect(patchContentTypeSchema.parse("markdown")).toBe("markdown");
  });

  it('accepts "json"', () => {
    expect(patchContentTypeSchema.parse("json")).toBe("json");
  });

  it('defaults to "markdown" when undefined', () => {
    expect(patchContentTypeSchema.parse(undefined)).toBe("markdown");
  });

  it("rejects invalid values", () => {
    expect(() => patchContentTypeSchema.parse("xml")).toThrow();
    expect(() => patchContentTypeSchema.parse("html")).toThrow();
  });
});
