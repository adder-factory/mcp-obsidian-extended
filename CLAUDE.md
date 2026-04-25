# mcp-obsidian-extended

TypeScript MCP server for Obsidian. Wraps 100% of the Local REST API (38 tools granular, 11 consolidated).
Node >=22, ESM, `@modelcontextprotocol/sdk` + Zod.

## Commands

```bash
npm run build          # tsc — must pass with zero errors
npm run lint           # ESLint — zero errors required
npm run test           # vitest run — all unit tests
npm run test:coverage  # vitest run --coverage — must hit 80%+ overall, 70%+ per file
npm run test:smoke     # live tests against Obsidian (Phase 3 only)
npm run verify:all     # build + lint + audit + knip + madge
npm run security:all   # snyk test + snyk code test + semgrep
npm run sonar          # SonarQube scan — zero issues of any severity
```

## Architecture

```
src/
├── index.ts              # Entry + CLI flags + McpServer + StdioServerTransport
├── config.ts             # Three-tier: defaults → config file → env vars
├── cache.ts              # Vault cache + link parser + graph analysis
├── obsidian.ts           # HTTP client — ALL Obsidian REST calls go through here
├── tools.ts              # Mode dispatcher + filtering + presets
├── tools/granular.ts     # 38 individual tool registrations
├── tools/consolidated.ts # 11 combined tool registrations
├── schemas.ts            # Shared Zod schemas
└── errors.ts             # Custom error types (ObsidianApiError, etc.)
```

## Build Instructions

Full specs: @docs/cc-instructions-final.md
Build steps: @docs/cc-phase-guide.md
API reference: @docs/cc-reference.md

## TypeScript Rules

- STRICT MODE: `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noPropertyAccessFromIndexSignature` + `noImplicitOverride` + `isolatedModules`
- ESM only: `"type": "module"` in package.json, use `.js` extensions in import paths
- NEVER use `any` — use `unknown` and narrow with type guards. ESLint `no-explicit-any` is set to error.
- NEVER use `as` type assertions unless provably safe — prefer type narrowing
- Always handle `undefined` from index access (`noUncheckedIndexedAccess` is on)
- Use `readonly` on arrays/objects that shouldn't be mutated
- Prefer `interface` over `type` for object shapes (extendable, better error messages)
- Use discriminated unions with exhaustive switch (add `default: never` check)
- All function return types must be explicit — no implicit inference on exports
- Prefer `async/await` over `.then()` chains
- Destructure function params when >2 params: `({ path, content, format }: PutOptions)`

## Error Handling

- NEVER swallow errors silently — always log or rethrow
- Use custom error classes from `errors.ts`: `ObsidianApiError`, `ObsidianConnectionError`, `ObsidianAuthError`
- Every error message must tell the LLM what to do next (structured errors)
- Wrap all HTTP calls in try/catch — timeout, connection refused, auth failure are separate error types
- Use `Error.cause` for error chaining: `throw new ObsidianApiError("...", { cause: originalError })`
- NEVER use `catch (e: any)` — use `catch (e: unknown)` and narrow

## Logging & Output

- **CRITICAL: stdout is the MCP transport.** NEVER use `console.log()`. ESLint `no-console` is error.
- ALL logging goes to `process.stderr` via a stderr logger utility
- NEVER log the API key — not in debug, not in errors, not in stack traces
- Debug logging (`OBSIDIAN_DEBUG=true`): log HTTP method/path/status/timing — NEVER bodies or auth headers

## Security — Non-Negotiable

- Path sanitization: reject `..` traversal, reject absolute paths, normalize separators
- API key: validate on startup, mask in error messages, redact from stack traces
- TLS: `rejectUnauthorized: false` by default (self-signed), `OBSIDIAN_CERT_PATH` for proper certs
- Per-file write locks: serialize concurrent writes to the same path (Map-based)
- Response validation: check content-type before JSON.parse
- Request timeouts: 30s default, search gets 2x, configurable via `OBSIDIAN_TIMEOUT`

## MCP Tool Conventions

- Tool descriptions: MAX 15 words. Parameter descriptions: MAX 10 words. Tokens matter.
- Non-idempotent tools (POST, PATCH, search_replace): add "do not retry on timeout" to description
- Idempotent tools (PUT, DELETE): note "idempotent" in description
- Protected tools (`configure`, `status`, `refresh_cache`): always registered, immune to INCLUDE/EXCLUDE filters
- Tool results use helper functions: `textResult()`, `errorResult()`, `jsonResult()`
- Zod schemas for all tool inputs — no manual JSON parsing

## Code Style

- No barrel files (`index.ts` re-exports) — direct imports only
- Imports: Node built-ins first, then external packages, then local modules, blank line between groups
- Use `const` by default, `let` only when reassignment is required, NEVER `var`
- Prefer `Map`/`Set` over plain objects for runtime data structures
- NEVER use `==` — always `===`
- Template literals over string concatenation
- Early returns over deep nesting
- Max function length: ~50 lines — extract helpers if longer
- Exception: `withFileLock` uses `.then(fn, fn)` for its mutex-queue pattern — this is intentional and documented in obsidian.ts
- Exception: `.then(onSuccess, onError)` two-argument form is allowed for fire-and-forget background tasks where you need to catch only the promise rejection, not errors in the success handler

## Git Workflow

- NEVER commit to `main` directly — feature branch per phase
- Branch naming: `feat/phase-1-scaffold-client-cache`, `feat/phase-2-tools-server-cli`, `feat/phase-3-test-readme-publish`
- Open PR to `main` after each phase — CodeRabbitAI + Greptile review automatically
- Fix ALL review feedback before requesting merge
- Do NOT merge without user approval

## Testing

- **Framework:** Vitest — native ESM + TypeScript, no config issues
- **Coverage:** 80%+ overall, 70%+ per file minimum. No exceptions.
- **Test file per source file:** errors.test.ts, config.test.ts, obsidian.test.ts, cache.test.ts, schemas.test.ts, etc.
- **Unit tests mock HTTP calls** — do NOT hit real Obsidian in unit tests
- **Smoke tests (test:smoke) hit real Obsidian** — only in Phase 3
- Obsidian is running on this machine with `mcp-test-vault`
- API key is in `.env` or `OBSIDIAN_API_KEY` env var
- ALL file operations via REST API — NEVER filesystem access, NEVER `rm`
- `delete_file` uses `DELETE /vault/{path}` — goes to Obsidian trash, recoverable
- Test against `mcp-test-vault` ONLY — never destructive tests on real vault
- Cannot stop/restart Obsidian — user handles offline fallback testing

## SonarQube

- Running locally at http://localhost:9000
- Credentials in .env: SONAR_HOST_URL, SONAR_TOKEN, SONAR_LOGIN, SONAR_PASSWORD
- Run scan before every PR: `npm run sonar`
- **Zero issues of ANY severity** — not just critical/high, ALL of them including code smells
- Coverage report fed to Sonar via sonar.javascript.lcov.reportPath=coverage/lcov.info
- Security hotspots: review and mark as Safe via Sonar API when intentional (e.g. rejectUnauthorized: false)

## JSDoc

- ALL exported functions, classes, interfaces, and types must have JSDoc comments
- Include @param, @returns, @throws where applicable
- Keep JSDoc concise — one line description, params on separate lines

## Context Management

- Run /compact proactively at 50% context usage — do not wait until degraded
- If you lose track of instructions, re-read CLAUDE.md
- For detailed specs, only read docs/ files when starting a new phase
- Break large review cycles into per-file batches — don't try to fix 50+ comments in one pass

## Verification Checklist (Before Every PR)

```bash
npm run build                              # Zero TS errors
npm run lint                               # Zero ESLint errors
npm run test:coverage                      # All tests pass, 80%+ coverage
npm audit                                  # Zero high/critical
npx knip                                   # Zero unused exports/files
npx madge --circular --extensions ts src/   # Zero circular deps
npx snyk test                              # Zero high/critical deps
npx snyk code test                         # Zero high/critical SAST
npx semgrep --config auto src/             # Zero findings
npm run sonar                              # Zero issues of any severity in SonarQube
```

Iterate with CodeRabbitAI + Greptile on PR until ALL comments resolved — including nitpicks.

<!-- ADDER-PIPELINE:v1 -->

## Adder Code Review Pipeline

This project uses the Adder code review pipeline. Rules Claude Code must
follow:

### Before every push

Run the gate until clean:

```bash
npm run pre-pr
```

All steps must pass (exit 0). Do **not** push until they do. If a gate is
incorrectly failing, fix the gate's config rather than skipping it.
`--skip-qwen` is allowed during fast iteration but the final run before
opening a PR must include Qwen.

The gate invokes `npm test -- --coverage`. Your project's `test` script
must be plain (e.g. `"test": "vitest run"`), without a hardcoded
`--coverage` flag — otherwise the runner sees a duplicate flag and fails.
Keep coverage as a separate script (e.g. `"test:coverage": "vitest run --coverage"`),
which is consistent with the `npm run test:coverage` command above.
Coverage thresholds belong in `vitest.config.ts` / `jest.config.js`.

### Branch strategy

- Feature branches only — never commit directly to `main`
- One logical change per branch. If the task has multiple parts, multiple branches.
- Branch name format: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`
- PR title matches branch purpose — write it for the reviewer, not for yourself

### Pull request workflow

1. Open PR against `main`
2. CodeRabbit Pro Plus AND CodeAnt AI both auto-review — you will see comments
   from both within minutes
3. Dependabot runs on dep-related PRs
4. Iterate on every comment from BOTH reviewers. Nitpicks count. No "will fix later."
5. If CodeRabbit and CodeAnt disagree on something, stop and ask the human — do
   not oscillate between the two reviewers' preferred approaches
6. Ask the human to merge only when all of the following are true:
   - All CI checks green
   - All CodeRabbit threads resolved
   - All CodeAnt threads resolved
   - `npm run pre-pr` passes locally on the branch head

   **Human/user approval is still required before merge.** The pipeline
   spec means there is no mandatory *line-by-line human code review* step:
   AI reviewers + CI provide the formal code-quality gate, and all feedback
   must be resolved before requesting merge. The human's pre-merge role is
   to verify readiness (CI green, AI threads resolved), decide whether to
   approve/merge, and ensure functional validation expectations are met.
   Branch protection intentionally sets
   `required_pull_request_reviews: null`, so GitHub reviewer approval is not
   required/configured even though explicit user approval to merge is.

### Never do

- Force-push to `main` (branch protection blocks it anyway)
- Bypass the gate with `--no-verify` on commits
- Disable an ESLint rule to make the gate pass — fix the underlying code
- Add files to `.gitignore` to hide them from Semgrep/SonarQube
- Commit secrets — Gitleaks will catch them, but don't make it do that
- Change `package.json` scripts `pre-pr`, `qwen-review`, `verify:all`,
  `security:all` without asking the user first — these are pipeline interfaces

### CodeGraph

This project is indexed by CodeGraph. Prefer `mcp__codegraph__codegraph_*`
MCP tools over Read/Grep for codebase navigation:

- Where is X defined? — `mcp__codegraph__codegraph_search`
- Who calls X? — `mcp__codegraph__codegraph_callers`
- What breaks if I change X? — `mcp__codegraph__codegraph_impact`
- What does X call? — `mcp__codegraph__codegraph_callees`
- High-level structure? — `mcp__codegraph__codegraph_files`

File reads are for when you need the actual source to edit. Use the graph for
discovery.

### When a session ends or context saturates

Log progress in `.adder-pipeline/session-log.md` with:

- What you were doing
- Current branch
- What's left to do
- Anything the next session needs to know

This survives context restarts.

<!-- /ADDER-PIPELINE:v1 -->
