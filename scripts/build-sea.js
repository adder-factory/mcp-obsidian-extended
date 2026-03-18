#!/usr/bin/env node

/**
 * Builds a Node.js Single Executable Application (SEA) binary.
 * Bundles the server into a standalone binary that doesn't require Node.js.
 *
 * Usage: node scripts/build-sea.js
 * Prerequisites: npm run build (compiles TypeScript to dist/)
 */

import { execSync } from "node:child_process";
import { writeFileSync, copyFileSync, unlinkSync, existsSync } from "node:fs";

const BINARY_NAME = "mcp-obsidian-extended";
const BLOB_FILE = "sea-prep.blob";
const CONFIG_FILE = "sea-config.json";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd) {
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function cleanup() {
  for (const f of [CONFIG_FILE, BLOB_FILE]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

if (process.platform === "win32") {
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.error("SEA build is not supported on Windows. Use macOS or Linux.");
  process.exit(1);
}

const nodeVersion = parseInt(process.version.slice(1), 10);
if (nodeVersion < 20) {
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.error(`SEA requires Node.js >= 20 (current: ${process.version}).`);
  process.exit(1);
}

try {
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.log(`\nBuilding SEA binary: ${BINARY_NAME}\n`);

  // 1. Bundle dist/ into a single file with esbuild
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.log("Step 1: Bundling with esbuild...");
  run("npx esbuild dist/index.js --bundle --platform=node --format=cjs --outfile=sea-entry.cjs --external:node:*");

  // 2. Write SEA config
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.log("Step 2: Generating SEA blob...");
  const seaConfig = {
    main: "sea-entry.cjs",
    output: BLOB_FILE,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(seaConfig));

  // 3. Generate blob (use same Node binary that will host the SEA)
  run(`"${process.execPath}" --experimental-sea-config ${CONFIG_FILE}`);

  // 4. Copy node binary
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.log("Step 3: Creating binary...");
  copyFileSync(process.execPath, BINARY_NAME);

  // 5. Inject blob (platform-specific)
  if (process.platform === "darwin") {
    run(`codesign --remove-signature ${BINARY_NAME}`);
    run(`npx postject ${BINARY_NAME} NODE_SEA_BLOB ${BLOB_FILE} --sentinel-fuse ${SEA_FUSE} --macho-segment-name NODE_SEA`);
    run(`codesign --sign - ${BINARY_NAME}`);
  } else {
    run(`npx postject ${BINARY_NAME} NODE_SEA_BLOB ${BLOB_FILE} --sentinel-fuse ${SEA_FUSE}`);
  }

  // 6. Cleanup
  cleanup();
  if (existsSync("sea-entry.cjs")) unlinkSync("sea-entry.cjs");

  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.log(`\nBuilt: ./${BINARY_NAME}\n`);
} catch (err) {
  try { cleanup(); } catch { /* best-effort */ }
  try { if (existsSync("sea-entry.cjs")) unlinkSync("sea-entry.cjs"); } catch { /* best-effort */ }
  try { if (existsSync(BINARY_NAME)) unlinkSync(BINARY_NAME); } catch { /* best-effort */ }
  // eslint-disable-next-line no-console -- build script, not MCP transport
  console.error("SEA build failed:", err.message);
  process.exit(1);
}
