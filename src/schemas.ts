import { z } from "zod";

/** Zod schema for file content response format (markdown, json, or map). */
export const formatSchema = z
  .enum(["markdown", "json", "map"])
  .default("markdown")
  .describe("Response format");

/** Zod schema for periodic note type (daily, weekly, monthly, quarterly, yearly). */
export const periodSchema = z
  .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
  .describe("Periodic note type");

/** Zod schema for PATCH operation type (append, prepend, replace). */
export const patchOperationSchema = z
  .enum(["append", "prepend", "replace"])
  .describe("Patch operation");

/** Zod schema for PATCH target type (heading, block, frontmatter). */
export const patchTargetTypeSchema = z
  .enum(["heading", "block", "frontmatter"])
  .describe("Target type");

/** Zod schema for PATCH content type (markdown or json). */
export const patchContentTypeSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Content type");
