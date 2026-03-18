#!/usr/bin/env node

/**
 * Generates distributable skill archives for Claude.ai (.zip) and Claude Code (.skill).
 *
 * Output files (project root):
 *   mcp-obsidian-extended.zip   — Upload to Claude.ai via Customize → Skills → "+" → Upload
 *   mcp-obsidian-extended.skill — Claude Code marketplace format (gzipped tar)
 */

import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SKILL_SRC = join(PROJECT_ROOT, ".claude", "skills", "obsidian-mcp", "SKILL.md");
const FOLDER_NAME = "mcp-obsidian-extended";

const tmpDir = mkdtempSync(join(tmpdir(), "skill-build-"));
const stageDir = join(tmpDir, FOLDER_NAME);

try {
  // Stage the skill file inside a folder (required by Claude.ai ZIP format)
  cpSync(SKILL_SRC, join(stageDir, "SKILL.md"), { recursive: true });

  // Generate .zip (Claude.ai)
  const zipOut = join(PROJECT_ROOT, `${FOLDER_NAME}.zip`);
  execFileSync("zip", ["-r", zipOut, FOLDER_NAME], { cwd: tmpDir, stdio: "pipe" });
  process.stderr.write(`Created: ${zipOut}\n`);

  // Generate .skill (gzipped tar for Claude Code)
  const skillOut = join(PROJECT_ROOT, `${FOLDER_NAME}.skill`);
  execFileSync("tar", ["czf", skillOut, FOLDER_NAME], { cwd: tmpDir, stdio: "pipe" });
  process.stderr.write(`Created: ${skillOut}\n`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
