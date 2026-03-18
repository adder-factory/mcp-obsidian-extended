import { describe, it, expect } from "vitest";

import { buildSkillContent } from "../skill.js";

describe("buildSkillContent", () => {
  // --- Sections 1-5 always present in both modes ---

  it("includes all 5 core sections for granular non-compact", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("# Obsidian MCP");
    expect(content).toContain("## Golden Rules");
    expect(content).toContain("## Common Workflows");
    expect(content).toContain("## Error Recovery");
    expect(content).toContain("## Tool Selection Guide");
    expect(content).toContain("## Things That Will Break");
  });

  it("includes all 5 core sections for consolidated non-compact", () => {
    const content = buildSkillContent("consolidated", false);
    expect(content).toContain("## Golden Rules");
    expect(content).toContain("## Common Workflows");
    expect(content).toContain("## Error Recovery");
    expect(content).toContain("## Tool Selection Guide");
    expect(content).toContain("## Things That Will Break");
  });

  // --- Section 1: Golden Rules ---

  it("includes key golden rules", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain('ALWAYS get_file_contents(path, format: "map") BEFORE any patch_content');
    expect(content).toContain("NEVER use put_content to edit a section");
    expect(content).toContain("NEVER retry a non-idempotent tool on timeout");
    expect(content).toContain("NEVER assume a path exists");
    expect(content).toContain("batch_get_file_contents for multiple files");
    expect(content).toContain("get_vault_structure at the start of a session");
  });

  // --- Section 2: Common Workflows ---

  it("includes step-by-step workflows", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("Edit under a heading");
    expect(content).toContain("Find and update notes");
    expect(content).toContain("Understand vault structure");
    expect(content).toContain("Create a new linked note");
    expect(content).toContain("Move or rename a file");
    expect(content).toContain("Search strategies");
    expect(content).toContain("Tab control via commands");
  });

  it("includes special character warning for patch", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("special characters (em dashes, parentheses)");
    expect(content).toContain("PATCH can fail silently on special chars");
  });

  it("documents Dataview TABLE-only limitation", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("only supports TABLE queries, not LIST");
  });

  it("includes tab control commands", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("workspace:next-tab");
    expect(content).toContain("workspace:previous-tab");
  });

  // --- Section 3: Error Recovery ---

  it("includes all error recovery scenarios", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("404 NOT FOUND");
    expect(content).toContain("PATCH timeout");
    expect(content).toContain("Connection refused");
    expect(content).toContain("CONFLICT (move_file)");
    expect(content).toContain("Large response truncated");
  });

  it("includes case-insensitive fallback note", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("case-insensitive fallback");
  });

  it("notes cache-based tools work offline", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("Cache-based tools");
    expect(content).toContain("still work offline");
  });

  // --- Section 4: Tool Selection Guide ---

  it("includes tool selection table", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("| I want to...");
    expect(content).toContain("batch_get_file_contents (NOT sequential gets)");
    expect(content).toContain("append_content (NOT put_content)");
    expect(content).toContain("move_file (v1.1.0+)");
  });

  // --- Section 5: Known Pitfalls ---

  it("includes the #1 mistake warning", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("put_content OVERWRITES the entire file");
    expect(content).toContain("This is the #1 mistake");
  });

  it("documents patch replace danger", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("replace operation on a top-level heading replaces EVERYTHING under it");
  });

  it("documents concurrent write failure rate", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("~10.5% failure rate under concurrent writes");
  });

  it("warns about active file depending on user focus", () => {
    const content = buildSkillContent("granular", false);
    expect(content).toContain("active file changes under you");
  });

  // --- Section 6: Consolidated Mode Action Reference ---

  it("includes consolidated action reference in consolidated mode", () => {
    const content = buildSkillContent("consolidated", false);
    expect(content).toContain("## Consolidated Mode Action Reference");
    expect(content).toContain("vault:");
    expect(content).toContain("active_file:");
    expect(content).toContain("commands:");
    expect(content).toContain("search:");
    expect(content).toContain("periodic_note:");
    expect(content).toContain("recent:");
    expect(content).toContain("vault_analysis:");
  });

  it("includes move action in consolidated reference", () => {
    const content = buildSkillContent("consolidated", false);
    expect(content).toContain("move           → source, destination");
  });

  it("omits consolidated action reference in granular mode", () => {
    const content = buildSkillContent("granular", false);
    expect(content).not.toContain("## Consolidated Mode Action Reference");
  });

  // --- Section 7: Compact Response Field Reference ---

  it("includes compact field reference when compact is true", () => {
    const content = buildSkillContent("granular", true);
    expect(content).toContain("## Compact Response Field Reference");
    expect(content).toContain("| c | content |");
    expect(content).toContain("| fm | frontmatter |");
    expect(content).toContain("| p | path |");
    expect(content).toContain("| s | stat |");
    expect(content).toContain("| ctx | context |");
    expect(content).toContain("| tgt | target |");
  });

  it("omits compact field reference when compact is false", () => {
    const content = buildSkillContent("granular", false);
    expect(content).not.toContain("## Compact Response Field Reference");
  });

  // --- Combined modes ---

  it("includes both section 6 and 7 in consolidated compact mode", () => {
    const content = buildSkillContent("consolidated", true);
    expect(content).toContain("## Consolidated Mode Action Reference");
    expect(content).toContain("## Compact Response Field Reference");
  });

  it("omits both section 6 and 7 in granular non-compact mode", () => {
    const content = buildSkillContent("granular", false);
    expect(content).not.toContain("## Consolidated Mode Action Reference");
    expect(content).not.toContain("## Compact Response Field Reference");
  });
});
