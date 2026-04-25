#!/usr/bin/env tsx
/**
 * PATCH Target header encoding stress test.
 * Tests encodeTargetHeader against live Obsidian with every edge case:
 * ASCII specials, unicode, emoji, CJK, RTL, mixed scripts, literal %,
 * deeply nested headings, and concurrent PATCH operations.
 * All output goes to stderr. Exit 0 = pass, Exit 1 = fail.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { ObsidianClient } from "../src/obsidian.js";
import { ObsidianApiError } from "../src/errors.js";

// --- Helpers ---

function write(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function loadDotenv(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      let key = trimmed.slice(0, eqIndex).trim();
      if (key.startsWith("export ")) key = key.slice(7).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key.length > 0 && process.env[key] === undefined)
        process.env[key] = value;
    }
  } catch {
    /* ok */
  }
}

const FILE = "_patch_stress.md";

interface TestCase {
  name: string;
  heading: string;
  target: string; // heading path with :: delimiters
  content: string; // full file content
}

// --- Test Cases ---

const CASES: TestCase[] = [
  // ASCII special characters
  {
    name: "Plus sign (+)",
    heading: "Q+A Section",
    target: "Root::Q+A Section",
    content: "# Root\n\n## Q+A Section\n\nContent.\n",
  },
  {
    name: "Ampersand (&)",
    heading: "R&D Notes",
    target: "Root::R&D Notes",
    content: "# Root\n\n## R&D Notes\n\nContent.\n",
  },
  {
    name: "Equals sign (=)",
    heading: "A = B",
    target: "Root::A = B",
    content: "# Root\n\n## A = B\n\nContent.\n",
  },
  {
    name: "Square brackets []",
    heading: "[Important]",
    target: "Root::[Important]",
    content: "# Root\n\n## [Important]\n\nContent.\n",
  },
  {
    name: "Parentheses ()",
    heading: "Notes (Draft)",
    target: "Root::Notes (Draft)",
    content: "# Root\n\n## Notes (Draft)\n\nContent.\n",
  },
  {
    name: "Exclamation and question marks",
    heading: "What?! Really!",
    target: "Root::What?! Really!",
    content: "# Root\n\n## What?! Really!\n\nContent.\n",
  },
  {
    name: "Hash inside heading (#)",
    heading: "Issue #42",
    target: "Root::Issue #42",
    content: "# Root\n\n## Issue #42\n\nContent.\n",
  },
  {
    name: "At sign (@)",
    heading: "@mentions",
    target: "Root::@mentions",
    content: "# Root\n\n## @mentions\n\nContent.\n",
  },
  {
    name: "Tilde and caret (~^)",
    heading: "v1.0~rc1^2",
    target: "Root::v1.0~rc1^2",
    content: "# Root\n\n## v1.0~rc1^2\n\nContent.\n",
  },
  {
    name: "Backtick (`)",
    heading: "`code` heading",
    target: "Root::`code` heading",
    content: "# Root\n\n## `code` heading\n\nContent.\n",
  },

  // Percent sign variations
  {
    name: "Simple percent (100%)",
    heading: "100% Complete",
    target: "Root::100% Complete",
    content: "# Root\n\n## 100% Complete\n\nContent.\n",
  },
  {
    name: "Multiple percent signs",
    heading: "50% off → 75% savings",
    target: "Root::50% off → 75% savings",
    content: "# Root\n\n## 50% off → 75% savings\n\nContent.\n",
  },
  {
    name: "Literal %20 in heading",
    heading: "path%20with%20spaces",
    target: "Root::path%20with%20spaces",
    content: "# Root\n\n## path%20with%20spaces\n\nContent.\n",
  },
  {
    name: "Literal %C3%BC in heading",
    heading: "encoded%C3%BCvalue",
    target: "Root::encoded%C3%BCvalue",
    content: "# Root\n\n## encoded%C3%BCvalue\n\nContent.\n",
  },

  // Unicode — European
  {
    name: "German umlauts (äöüß)",
    heading: "Übersicht über Bücher",
    target: "Root::Übersicht über Bücher",
    content: "# Root\n\n## Übersicht über Bücher\n\nContent.\n",
  },
  {
    name: "French accents (éèêë)",
    heading: "Résumé des études",
    target: "Root::Résumé des études",
    content: "# Root\n\n## Résumé des études\n\nContent.\n",
  },
  {
    name: "Spanish (ñ, ¿, ¡)",
    heading: "¿Qué pasa, señor?",
    target: "Root::¿Qué pasa, señor?",
    content: "# Root\n\n## ¿Qué pasa, señor?\n\nContent.\n",
  },
  {
    name: "Nordic (åæø)",
    heading: "Blåbær og Ørret",
    target: "Root::Blåbær og Ørret",
    content: "# Root\n\n## Blåbær og Ørret\n\nContent.\n",
  },

  // Unicode — CJK
  {
    name: "Japanese (Hiragana + Kanji)",
    heading: "日本語の見出し",
    target: "Root::日本語の見出し",
    content: "# Root\n\n## 日本語の見出し\n\nContent.\n",
  },
  {
    name: "Chinese (Simplified)",
    heading: "中文标题",
    target: "Root::中文标题",
    content: "# Root\n\n## 中文标题\n\nContent.\n",
  },
  {
    name: "Korean (Hangul)",
    heading: "한국어 제목",
    target: "Root::한국어 제목",
    content: "# Root\n\n## 한국어 제목\n\nContent.\n",
  },

  // Unicode — other scripts
  {
    name: "Arabic (RTL)",
    heading: "ملاحظات عربية",
    target: "Root::ملاحظات عربية",
    content: "# Root\n\n## ملاحظات عربية\n\nContent.\n",
  },
  {
    name: "Hebrew (RTL)",
    heading: "כותרת בעברית",
    target: "Root::כותרת בעברית",
    content: "# Root\n\n## כותרת בעברית\n\nContent.\n",
  },
  {
    name: "Cyrillic (Russian)",
    heading: "Заметки на русском",
    target: "Root::Заметки на русском",
    content: "# Root\n\n## Заметки на русском\n\nContent.\n",
  },
  {
    name: "Thai",
    heading: "หัวข้อภาษาไทย",
    target: "Root::หัวข้อภาษาไทย",
    content: "# Root\n\n## หัวข้อภาษาไทย\n\nContent.\n",
  },
  {
    name: "Devanagari (Hindi)",
    heading: "हिंदी शीर्षक",
    target: "Root::हिंदी शीर्षक",
    content: "# Root\n\n## हिंदी शीर्षक\n\nContent.\n",
  },

  // Emoji
  {
    name: "Single emoji prefix",
    heading: "📝 Notes",
    target: "Root::📝 Notes",
    content: "# Root\n\n## 📝 Notes\n\nContent.\n",
  },
  {
    name: "Multiple emoji",
    heading: "🚀 Launch 🎉 Party",
    target: "Root::🚀 Launch 🎉 Party",
    content: "# Root\n\n## 🚀 Launch 🎉 Party\n\nContent.\n",
  },
  {
    name: "Emoji-only heading",
    heading: "🔥🔥🔥",
    target: "Root::🔥🔥🔥",
    content: "# Root\n\n## 🔥🔥🔥\n\nContent.\n",
  },
  {
    name: "Compound emoji (flag)",
    heading: "🇯🇵 Japan Notes",
    target: "Root::🇯🇵 Japan Notes",
    content: "# Root\n\n## 🇯🇵 Japan Notes\n\nContent.\n",
  },
  {
    name: "Emoji with skin tone modifier",
    heading: "👋🏽 Hello",
    target: "Root::👋🏽 Hello",
    content: "# Root\n\n## 👋🏽 Hello\n\nContent.\n",
  },

  // Mixed scripts
  {
    name: "Mixed: ASCII + CJK + Emoji",
    heading: "My 日記 📓",
    target: "Root::My 日記 📓",
    content: "# Root\n\n## My 日記 📓\n\nContent.\n",
  },
  {
    name: "Mixed: percent + unicode + emoji",
    heading: "100% über 🚀",
    target: "Root::100% über 🚀",
    content: "# Root\n\n## 100% über 🚀\n\nContent.\n",
  },

  // Edge cases
  {
    name: "Very long heading (200 chars)",
    heading: "A".repeat(200),
    target: `Root::${"A".repeat(200)}`,
    content: `# Root\n\n## ${"A".repeat(200)}\n\nContent.\n`,
  },
  {
    name: "Heading with only spaces",
    heading: "   ",
    target: "Root::   ",
    content: "# Root\n\n##    \n\nContent.\n",
  },
  {
    name: "Single character heading",
    heading: "X",
    target: "Root::X",
    content: "# Root\n\n## X\n\nContent.\n",
  },
  {
    name: "Numbers only",
    heading: "12345",
    target: "Root::12345",
    content: "# Root\n\n## 12345\n\nContent.\n",
  },

  // Deeply nested headings
  {
    name: "Three-level nesting",
    heading: "Sub",
    target: "Root::Mid::Sub",
    content: "# Root\n\n## Mid\n\n### Sub\n\nContent.\n",
  },
];

// --- Runner ---

async function runCase(
  client: ObsidianClient,
  tc: TestCase,
): Promise<{ passed: boolean; error?: string }> {
  try {
    // 1. Create the file with the heading
    await client.putContent(FILE, tc.content);

    // 2. PATCH under the heading
    const patchContent = `\nPatched: ${tc.name}\n`;
    await client.patchContent(FILE, patchContent, {
      operation: "append",
      targetType: "heading",
      target: tc.target,
    });

    // 3. Read back and verify
    const result = await client.getFileContents(FILE, "markdown");
    if (typeof result !== "string") {
      return { passed: false, error: "Expected string response" };
    }
    if (!result.includes(`Patched: ${tc.name}`)) {
      return {
        passed: false,
        error: `Patch content not found in result. Got: ${result.slice(0, 200)}`,
      };
    }

    return { passed: true };
  } catch (err: unknown) {
    const msg =
      err instanceof ObsidianApiError
        ? `API ${String(err.statusCode)}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { passed: false, error: msg };
  }
}

// --- Concurrent stress ---

async function concurrentPatchStress(
  client: ObsidianClient,
): Promise<{ passed: boolean; error?: string }> {
  // Create file with 5 headings, PATCH all concurrently
  const headings = ["Alpha", "Bêta", "Gämma", "Délta", "📝 Epsilon"];
  const content = `# Root\n\n${headings.map((h) => `## ${h}\n\nContent.\n`).join("\n")}`;
  await client.putContent(FILE, content);

  const results = await Promise.allSettled(
    headings.map((h) =>
      client.patchContent(FILE, `\nConcurrent: ${h}\n`, {
        operation: "append",
        targetType: "heading",
        target: `Root::${h}`,
      }),
    ),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    const reasons = failures
      .map((f) => (f.status === "rejected" ? String(f.reason) : ""))
      .join("; ");
    return {
      passed: false,
      error: `${String(failures.length)}/${String(headings.length)} concurrent patches failed: ${reasons}`,
    };
  }

  // Verify all patches applied
  const final = await client.getFileContents(FILE, "markdown");
  if (typeof final !== "string")
    return { passed: false, error: "Expected string" };

  const missing = headings.filter((h) => !final.includes(`Concurrent: ${h}`));
  if (missing.length > 0) {
    return {
      passed: false,
      error: `Missing patches for: ${missing.join(", ")}`,
    };
  }

  return { passed: true };
}

// --- Rapid PATCH cycle ---

async function rapidPatchCycle(
  client: ObsidianClient,
): Promise<{ passed: boolean; error?: string }> {
  const iterations = 20;
  const headings = ["über", "日本語", "📝 Notes", "100% Done", "Q&A + Tips"];
  let failures = 0;

  for (let i = 0; i < iterations; i++) {
    const heading = headings[i % headings.length];
    if (heading === undefined) continue;
    const content = `# Root\n\n## ${heading}\n\nBase.\n`;
    try {
      await client.putContent(FILE, content);
      await client.patchContent(FILE, `\nRapid ${String(i)}\n`, {
        operation: "append",
        targetType: "heading",
        target: `Root::${heading}`,
      });
    } catch {
      failures++;
    }
  }

  if (failures > 0) {
    return {
      passed: false,
      error: `${String(failures)}/${String(iterations)} rapid cycles failed`,
    };
  }
  return { passed: true };
}

// --- Main ---

async function main(): Promise<void> {
  write("");
  write("=== PATCH Target Header Encoding Stress Test ===");
  write("");

  loadDotenv();
  const config = loadConfig();
  if (!config.apiKey) {
    write("[error] OBSIDIAN_API_KEY not set.");
    process.exit(1);
  }

  const client = new ObsidianClient(config);

  // Safety guard
  const { files } = await client.listFilesInVault();
  if (files.length > 50) {
    write("[error] Too many files — use test vault.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  // Run individual cases
  write(`  Running ${String(CASES.length)} encoding test cases...\n`);

  for (const tc of CASES) {
    const result = await runCase(client, tc);
    if (result.passed) {
      write(`  ✓ ${tc.name}`);
      passed++;
    } else {
      write(`  ✗ ${tc.name} — ${result.error ?? "unknown"}`);
      failed++;
      failures.push(`${tc.name}: ${result.error ?? "unknown"}`);
    }
  }

  // Concurrent stress
  write("\n  Running concurrent PATCH stress...");
  const concResult = await concurrentPatchStress(client);
  if (concResult.passed) {
    write("  ✓ Concurrent PATCH (5 unicode headings)");
    passed++;
  } else {
    write(`  ✗ Concurrent PATCH — ${concResult.error ?? "unknown"}`);
    failed++;
    failures.push(`Concurrent: ${concResult.error ?? "unknown"}`);
  }

  // Rapid cycle
  write("\n  Running rapid PATCH cycle (20 iterations)...");
  const rapidResult = await rapidPatchCycle(client);
  if (rapidResult.passed) {
    write("  ✓ Rapid PATCH cycle (20 iterations, 5 heading types)");
    passed++;
  } else {
    write(`  ✗ Rapid PATCH cycle — ${rapidResult.error ?? "unknown"}`);
    failed++;
    failures.push(`Rapid: ${rapidResult.error ?? "unknown"}`);
  }

  // Cleanup
  write("\n  Cleaning up...");
  try {
    await client.deleteFile(FILE);
  } catch {
    /* ok */
  }

  // Summary
  const total = passed + failed;
  write("");
  write(
    `Results: ${String(passed)} passed, ${String(failed)} failed out of ${String(total)} tests`,
  );

  if (failures.length > 0) {
    write("\nFailures:");
    for (const f of failures) {
      write(`  - ${f}`);
    }
  }

  write("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  write(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
