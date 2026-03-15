import { z } from "zod";

export const formatSchema = z
  .enum(["markdown", "json", "map"])
  .default("markdown")
  .describe("Response format");

export const periodSchema = z
  .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
  .describe("Periodic note type");

export const patchOperationSchema = z
  .enum(["append", "prepend", "replace"])
  .describe("Patch operation");

export const patchTargetTypeSchema = z
  .enum(["heading", "block", "frontmatter"])
  .describe("Target type");

export const patchContentTypeSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Content type");
