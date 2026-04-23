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

/** Shared path + content fields for vault write tools. */
export const pathContentFields = {
  path: z.string().describe("File path"),
  content: z.string().describe("File content"),
} as const;

/** Shared year/month/day fields for date-scoped periodic note tools. */
export const dateFields = {
  year: z.number().int().describe("Year"),
  month: z.number().int().min(1).max(12).describe("Month (1-12)"),
  day: z.number().int().min(1).max(31).describe("Day (1-31)"),
} as const;

/** Shared PATCH option fields for tools that support heading/block/frontmatter targeting. */
export const patchOptionFields = {
  operation: patchOperationSchema,
  targetType: patchTargetTypeSchema,
  target: z.string().describe("Target heading/block/field"),
  targetDelimiter: z.string().optional().describe("Heading delimiter"),
  trimTargetWhitespace: z
    .boolean()
    .optional()
    .describe("Trim target whitespace"),
  createIfMissing: z.boolean().optional().describe("Create target if missing"),
  contentType: patchContentTypeSchema.optional(),
} as const;

/** Shared PATCH option fields without createIfMissing (for active file / periodic note patches). */
export const patchOptionFieldsNoCim = {
  operation: patchOperationSchema,
  targetType: patchTargetTypeSchema,
  target: z.string().describe("Target heading/block/field"),
  targetDelimiter: z.string().optional().describe("Heading delimiter"),
  trimTargetWhitespace: z
    .boolean()
    .optional()
    .describe("Trim target whitespace"),
  contentType: patchContentTypeSchema.optional(),
} as const;

/** Shared period + date + content fields for date-scoped periodic write tools. */
export const periodDateContentFields = {
  period: periodSchema,
  ...dateFields,
  content: z.string().describe("Note content"),
} as const;

/** Formats a date label from year/month/day numbers. */
export function dateLabel(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month)}-${String(day)}`;
}
