#!/usr/bin/env tsx
/**
 * JSDoc coverage gate.
 *
 * Walks `src/**∕*.ts` (excluding `src/__tests__/**`) via ts-morph and counts
 * the fraction of exported declarations that carry a leading JSDoc block.
 * Exits non-zero when the overall percentage is below the threshold.
 */

import { Project, Node, SyntaxKind } from "ts-morph";
import { globSync } from "glob";
import path from "node:path";
import process from "node:process";

interface Args {
  threshold: number;
  pattern: string;
  exclude: string[];
  perFile: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    threshold: 85,
    pattern: "src/**/*.ts",
    exclude: ["src/__tests__/**", "**/*.d.ts"],
    perFile: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--pattern") args.pattern = String(argv[++i]);
    else if (a === "--exclude") args.exclude.push(String(argv[++i]));
    else if (a === "--per-file") args.perFile = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/jsdoc-coverage.ts [--threshold N] [--pattern GLOB] [--exclude GLOB] [--per-file] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

interface FileStats {
  file: string;
  total: number;
  documented: number;
  missing: string[];
}

/**
 * Decide whether a declaration is "exported" for coverage purposes.
 * Covers `export` modifiers and re-exports via `export { ... }` / `export default`.
 */
function isExported(node: Node): boolean {
  if (Node.isExportable(node) && node.isExported()) return true;
  if (Node.isExportAssignment(node)) return true;
  if (Node.isExportDeclaration(node)) return true;
  return false;
}

/**
 * Yield every top-level declaration we want to score. A VariableStatement with
 * multiple declarators counts as one entry if any declarator is exported; we
 * check JSDoc on the statement, matching how developers annotate `export const`.
 */
function collectTopLevel(sourceFile: import("ts-morph").SourceFile): Node[] {
  const results: Node[] = [];
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(stmt) && isExported(stmt))
      results.push(stmt);
    else if (Node.isClassDeclaration(stmt) && isExported(stmt))
      results.push(stmt);
    else if (Node.isInterfaceDeclaration(stmt) && isExported(stmt))
      results.push(stmt);
    else if (Node.isTypeAliasDeclaration(stmt) && isExported(stmt))
      results.push(stmt);
    else if (Node.isEnumDeclaration(stmt) && isExported(stmt))
      results.push(stmt);
    else if (Node.isVariableStatement(stmt) && stmt.isExported())
      results.push(stmt);
    else if (Node.isExportAssignment(stmt)) results.push(stmt);
  }
  return results;
}

/**
 * Yield class members (methods, accessors) that count toward coverage.
 * Private / protected members and the constructor are skipped — only the
 * public contract is part of the documented surface.
 */
function collectClassMembers(cls: import("ts-morph").ClassDeclaration): Node[] {
  const members: Node[] = [];
  for (const m of cls.getMembers()) {
    if (Node.isConstructorDeclaration(m)) continue;
    if (
      Node.isMethodDeclaration(m) ||
      Node.isGetAccessorDeclaration(m) ||
      Node.isSetAccessorDeclaration(m)
    ) {
      const mods = m.getModifiers().map((mod) => mod.getKind());
      if (mods.includes(SyntaxKind.PrivateKeyword)) continue;
      if (mods.includes(SyntaxKind.ProtectedKeyword)) continue;
      if (m.getName().startsWith("#")) continue;
      members.push(m);
    }
  }
  return members;
}

/** A node is documented if it has at least one attached JSDoc block. */
function hasJSDoc(node: Node): boolean {
  if (!Node.isJSDocable(node)) return false;
  return node.getJsDocs().length > 0;
}

/**
 * Produce a short human-readable label for a node, used to list missing
 * declarations in the report.
 */
function labelFor(node: Node): string {
  if (Node.isFunctionDeclaration(node))
    return `function ${node.getName() ?? "<anon>"}`;
  if (Node.isClassDeclaration(node))
    return `class ${node.getName() ?? "<anon>"}`;
  if (Node.isInterfaceDeclaration(node)) return `interface ${node.getName()}`;
  if (Node.isTypeAliasDeclaration(node)) return `type ${node.getName()}`;
  if (Node.isEnumDeclaration(node)) return `enum ${node.getName()}`;
  if (Node.isVariableStatement(node)) {
    const names = node
      .getDeclarations()
      .map((d) => d.getName())
      .join(", ");
    return `const/let ${names}`;
  }
  if (Node.isExportAssignment(node)) return "export default";
  if (Node.isMethodDeclaration(node)) return `method ${node.getName()}`;
  if (Node.isGetAccessorDeclaration(node)) return `get ${node.getName()}`;
  if (Node.isSetAccessorDeclaration(node)) return `set ${node.getName()}`;
  return node.getKindName();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const files = globSync(args.pattern, {
    ignore: args.exclude,
    nodir: true,
  }).sort();

  if (files.length === 0) {
    console.error(`No files matched pattern ${args.pattern}`);
    process.exit(2);
  }

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  for (const f of files) project.addSourceFileAtPath(f);

  const stats: FileStats[] = [];
  let totalAll = 0;
  let documentedAll = 0;

  for (const sf of project.getSourceFiles()) {
    const rel = path.relative(process.cwd(), sf.getFilePath());
    const fileStat: FileStats = {
      file: rel,
      total: 0,
      documented: 0,
      missing: [],
    };

    const decls = collectTopLevel(sf);
    for (const d of decls) {
      fileStat.total++;
      if (hasJSDoc(d)) fileStat.documented++;
      else fileStat.missing.push(labelFor(d));

      if (Node.isClassDeclaration(d)) {
        for (const m of collectClassMembers(d)) {
          fileStat.total++;
          if (hasJSDoc(m)) fileStat.documented++;
          else fileStat.missing.push(`${labelFor(d)}#${labelFor(m)}`);
        }
      }
    }

    stats.push(fileStat);
    totalAll += fileStat.total;
    documentedAll += fileStat.documented;
  }

  const pct = totalAll === 0 ? 100 : (documentedAll / totalAll) * 100;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          threshold: args.threshold,
          total: totalAll,
          documented: documentedAll,
          pct,
          files: stats,
        },
        null,
        2,
      ),
    );
  } else {
    if (args.perFile) {
      for (const s of stats) {
        const p = s.total === 0 ? 100 : (s.documented / s.total) * 100;
        console.log(
          `${p.toFixed(1).padStart(5)}%  ${s.documented}/${s.total}  ${s.file}`,
        );
        if (s.missing.length > 0) {
          for (const miss of s.missing) console.log(`         - ${miss}`);
        }
      }
      console.log("");
    }
    console.log(
      `JSDoc coverage: ${pct.toFixed(2)}% (${documentedAll}/${totalAll}) — threshold ${args.threshold}%`,
    );
  }

  if (pct < args.threshold) {
    console.error(
      `FAIL: coverage ${pct.toFixed(2)}% is below threshold ${args.threshold}%`,
    );
    process.exit(1);
  }
}

main();
