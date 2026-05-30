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

- STRICT MODE: `strict: true` with the following flags enabled:
  - `noUncheckedIndexedAccess`
  - `exactOptionalPropertyTypes`
  - `noPropertyAccessFromIndexSignature`
  - `noImplicitOverride`
  - `isolatedModules`
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

- **CRITICAL: stdout is the MCP transport.** NEVER use `console.log()`. Biome `noConsole` is error (scoped to `src/` in biome.json).
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
- Default to `async/await`; exception: `.then(onSuccess, onError)` two-argument form is allowed only for fire-and-forget background tasks where you intentionally catch only the original promise rejection, not errors thrown in the success handler

## Git Workflow

- NEVER commit to `main` directly — feature branch per phase
- Branch naming: `feat/phase-1-scaffold-client-cache`, `feat/phase-2-tools-server-cli`, `feat/phase-3-test-readme-publish`
- Open PR to `main` after each phase — CodeRabbitAI + Greptile review automatically
- Fix ALL review feedback before requesting merge
- Do NOT merge without user approval

## Mutation Testing — Ratchet Policy (active, post-floor)

Stryker `thresholds.break` is currently set to **80** in
`stryker.conf.mjs` (the hard floor, held for one cycle before the
first ratchet bump above the floor — see the score-history comment
in `stryker.conf.mjs` for the rationale). The pipeline
(`npm run pre-pr`) blocks any push whose mutation score drops below
the current threshold. Aggregate score crossed 80 on 2026-04-26 with
PR #68 merged; a fresh full Stryker run confirmed **81.34%**. The
Stage 1/2 bootstrap+backfill series is complete and the ratchet
policy is now in effect.

### Standing rules

- **Ratchet on improvement.** When a PR raises the aggregate above
  the current `thresholds.break + 1pp`, raise `thresholds.break` to
  `(new_score − 1pp)` so it always sits ~1pp below the current kill
  rate — tight enough to catch a regression, loose enough to tolerate
  incremental-cache noise. Hard floor: never drop below 80.
  **Stryker invariant `high >= low >= break` must hold.** When
  bumping `break` above 80, also bump `low` and `high` so the
  inequality stays valid (e.g. all three to the new value, or
  `low = break` and `high = 100` if you want a high-band signal).
  Failing to do so produces a Stryker config error at gate time.
- **Tests-only for kill-rate work.** Hard Rule 8 applies: PRs that
  exist primarily to raise the mutation score add tests, not
  production code, unless a minimal change is genuinely required to
  make code testable (justify in PR body). See **Reviewer Triage
  Rules** below for codified dismissal patterns (the auto-dismiss
  list is the operational enforcement of Hard Rule 8 during
  reviewer cycles — e.g. empty-string-as-undefined suggestions on
  mutation-kill tests are auto-dismiss because they would silently
  drop the kill that the test was designed to catch). See
  [Reviewer Triage Rules](#reviewer-triage-rules) below for the
  full codified list.
- **Per-file carve-outs allowed but justified.** Some files truly
  cannot hit 80 (entry-point wiring, content-heavy modules whose
  mutants are static-initialized at module load and Vitest worker
  caching defeats Stryker's mutation injection). Exclude them from
  the Stryker `mutate` glob and document the reason in the PR body.
  The file's mutants are removed from the aggregate denominator.
  Example carve-out in `stryker.conf.mjs`:

  ```javascript
  // Excluding entry-point wiring that can't be unit-tested without
  // spinning up the full MCP transport. Justified in PR #N body.
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts"],
  ```

  More than 5 carve-outs ⇒ escalate for human policy review. Current
  count is tracked in `stryker.conf.mjs` via grep-able
  `// Carve-out N/5: <path>` comments.

- **Re-baseline after each merge that moves the score.** Update the
  score-history comment in `stryker.conf.mjs` (the in-repo
  authoritative record) and bump the entire `thresholds` object per
  the ratchet formula above — remember `high >= low >= break` so
  `low` and `high` move with `break` whenever `break` exceeds the
  current `low` value.
- **Beware incremental-cache staleness.** Stryker's `--incremental`
  cache invalidates on source-file changes but NOT on test-file
  changes — meaning test-only PRs may report a stale aggregate that
  doesn't reflect newly-added kills. Periodically run a fresh
  (non-incremental) Stryker pass to confirm the true score, especially
  before a ratchet bump or threshold adjustment.

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

## Systematic Debugging

When a test fails, gate regresses, or unexpected behavior surfaces, follow
this 4-phase process. Do NOT skip to fix.

**Phase 1 — Reproduce.** Confirm the failure is reproducible. If
intermittent, capture frequency. No fix without reliable repro.

**Phase 2 — Narrow scope.** Bisect to smallest input/file/commit that
triggers the failure. Don't theorize on full system.

**Phase 3 — Hypothesize with evidence.** State the hypothesis explicitly.
List evidence supporting it. Distinguish "this would explain it" from "I
have proof."

**Phase 4 — Verify fix targets cause, not symptom.** After applying a fix,
confirm: (a) original repro now passes, (b) the fix matches the hypothesis,
not a workaround that masks it.

Skipping phases produces silent-pass bugs (e.g., Sonar gate verifying
upload not verdict — Issue #7).

## Verification Before Completion

Before reporting a task complete, verify ALL the following:

1. The relevant gate or check actually ran (not skipped)
2. Exit code was checked, not just process completion
3. The specific outcome or metric the task targeted actually changed (not
   just "tests pass")
4. Downstream consumers not broken (run dependent tests if changes touch
   shared code)
5. The reported state matches the actual state (no hallucinated "all green")

Reporting "done" without these checks creates the silent-pass class of
bug. Sonar Issue #7 (every PR silently passing since #12) is the reference
example.

## Multi-Stage Task Verification

When a task is broken into stages (e.g., "Stage 1 → Stage 2 → Stage 3"),
each stage gets an explicit verification step before proceeding to the
next. Format per stage:

1. Action — what the stage does
2. Expected outcome — what success looks like, measurable
3. Verification command/check — how to confirm the outcome
4. Escalation trigger — what triggers stopping for human help vs. proceeding

Do NOT batch verification at end of all stages. A failed early stage that
propagates is harder to diagnose than one caught immediately.

## Spec Drift Prevention

Any addition or removal of a gate, reviewer, or pipeline step must be
recorded in `~/projects/code-review-pipeline/pipeline-state.md`. Because
`pipeline-state.md` lives in a separate filesystem location from this
repo (it is vault-adjacent, not part of any repo's diff), the rule is:
**update `pipeline-state.md` in its own location and commit that change
alongside or immediately before the implementing PR in this repo**. "Alongside" means in the same working session;
"immediately before" means no other implementing PR lands between the
state-doc update and the change it documents. The state document must
always reflect what `main` actually runs.

Drift erodes trust. Every drift item caught in the 2026-04-26 audit (Q5
in `~/projects/code-review-pipeline/build-log.md`) happened because this
rule didn't exist. CodeAnt was dropped on 2026-04-23 and the docs took
three days to catch up; CodeQL, the reviewer subagent, the
JSDoc-coverage gate, and the Stryker hard-floor were all added without
ever updating the spec. The cost was real: the audit had to reconstruct
live state from PR history because no single document reflected reality.

`pipeline-state.md` is the live-state document. `pipeline-spec.md` is
now marked superseded and preserved for the design-intent record only.

## When to Use Subagents

Subagents are not free — each burns its own context window, and
coordination has overhead. Use them when work fits ALL three:

1. **Parallel-safe** — independent files, no shared state, results don't
   depend on each other
2. **Naturally splits 3+ ways** — fewer than 3 splits = overhead exceeds
   benefit
3. **Mechanical or templated** — each subtask follows the same pattern
   with different inputs

Examples:

- ✅ JSDoc backfill across 60 files
- ✅ Bulk test additions across independent modules
- ✅ Multi-repo template propagation
- ❌ Single-file refactor
- ❌ Sequential multi-stage task
- ❌ Small PR (<50 LOC, <3 files)

Default to single-agent for everything else. The cost of a subagent that
isn't pulling its weight is real.

<!-- ADDER-PIPELINE:v2 -->

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

The gate invokes `npm test -- --coverage`. Your project's `test` script
must be plain (e.g. `"test": "vitest run"`), without a hardcoded
`--coverage` flag — otherwise the runner sees a duplicate flag and fails.
Coverage thresholds belong in `vitest.config.ts` / `jest.config.js`.

### Branch strategy

- Feature branches only — never commit directly to `main`
- One logical change per branch. If the task has multiple parts, multiple branches.
- Branch name format: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`
- PR title matches branch purpose — write it for the reviewer, not for yourself

### Pre-PR semantic review (two reviewer subagents)

Before pushing a branch and opening a PR, **invoke BOTH review subagents** on
the same diff/refs: the constructive `reviewer`
(`.claude/agents/reviewer.md`) and the `reviewer-adversary`
(`.claude/agents/reviewer-adversary.md`). They are independent (no shared
state) — spawn them in parallel so wall-clock stays ~120 s, not ~240 s. Both
read the diff with fresh context and return the **same** structured JSON
verdict (`APPROVE` | `REQUEST_CHANGES` | `BLOCK`), but from opposite priors:
the reviewer assesses "is this good?", the adversary assumes "this is broken,
prove me wrong." Two stances tuned to opposite optima catch more than one
prompt tuned to a compromise.

**Recompute each verdict from its findings — don't trust the top-level field.**
For each agent's JSON, derive the verdict from the highest `severity` in its
`findings` (`block` → BLOCK, `request_changes` → REQUEST_CHANGES, all `info`
or empty → APPROVE). If the model's stated `verdict` disagrees with its own
findings, use the findings-derived value (fail toward the stricter).

**Combining the two verdicts** (apply after deriving each):

- **reviewer APPROVE + adversary APPROVE** → proceed to push + open the PR.
- **either REQUEST_CHANGES, neither BLOCK** → REQUEST_CHANGES: address the
  union of both agents' findings, then re-run BOTH; do not open the PR until
  the combined result is APPROVE.
- **adversary BLOCK + reviewer APPROVE or REQUEST_CHANGES** → **escalate to
  the human.** Do NOT silently proceed and do NOT silently block. Surface the
  adversary's block-finding(s) verbatim — this disagreement (the skeptic
  caught what the optimist missed) is the single highest-value case the
  two-agent design exists for, and it must reach a human.
- **reviewer BLOCK** (any adversary verdict) → BLOCK and escalate; the
  adversary's APPROVE does not override a constructive BLOCK (fail toward the
  block).
- **both BLOCK** → BLOCK and escalate. Treat as a strong signal, but **do NOT
  count it as independent "convergent ≥2 reviewers"** the way the post-PR
  triage rule does — both agents are the same model (Sonnet) and share its
  blind spots, so their agreement is correlated, not independent. The genuine
  independent-convergence signal is the post-PR multi-vendor roster
  (CodeRabbit / Gemini / Greptile / CodeQL), not these two.

**Bake-in circuit-breaker (first 30 logged adversary invocations per repo).**
Until the adversary's false-positive rate is measured, an
**adversary-BLOCK-only** result resolves to **REQUEST_CHANGES** (fix-and-rerun)
rather than a mandatory human escalation — this prevents a noisy new adversary
from training humans to rubber-stamp escalations before its signal quality is
known. **Escape hatch (avoids a deadlock on a false positive):** if main CC
judges the adversary's surviving finding to be a false positive it cannot
legitimately "fix" (e.g. an unreachable case, an invented requirement, a
finding that contradicts CLAUDE.md), it must **escalate to the human with an
override request** — quoting the finding and the reason it's believed wrong —
rather than looping fix-and-rerun forever. The human then either confirms the
override (proceed) or upholds the block. So during bake-in the resolution is:
fixable → fix-and-rerun; believed-false-positive → escalate-with-override;
never an unbreakable loop. After 30 logged adversary verdicts, switch to the
escalation behavior above. (Count from `.adder-pipeline/reviewer-verdicts.jsonl`
records where `agent` is `reviewer-adversary`.) A constructive-reviewer BLOCK
always escalates regardless of the bake-in window.

**Fail-closed rule (covers BOTH agents).** If EITHER agent times out, errors,
or returns output that is not parseable as the documented JSON schema, treat
the combined verdict as `BLOCK` and escalate. Do **not** default to
proceeding — a silent reviewer failure must not become a silent push. With two
agents the combined fail-closed surface is larger; "at least one agent failed
to return parseable JSON" is itself a BLOCK, never a proceed. Include a short
diagnostic excerpt or error class in the escalation, but **sanitize first**:
redact API keys, tokens, `.env` paths, and any line that looks secret-like
before posting to PR artifacts or logs. If unsure whether output is safe to
include, escalate with just the error class — the human can re-run locally.

Both reviewers are **complementary** to (not a replacement for)
`npm run pre-pr` (deterministic local gate, runs before push) and the PR-stage
AI reviewers configured for this repo (CodeRabbit Pro Plus required; Gemini,
Greptile on public repos, and CodeQL advisory — run after the PR is open).
Their job is the layer those miss: intent vs. implementation, missing edge
cases, scope drift, silently-weakened gates — surfaced before code goes
public.

Time budget: ~120 seconds **each** (run in parallel). If either reviewer
consistently exceeds it, log the run-times and revisit its prompt or model.

**Verdict logging (orchestrator-side, mandatory).** The reviewer
subagents are read-only by design — they can't write their own verdict
log. After receiving EACH agent's verdict, **append one JSONL record per
agent** to `.adder-pipeline/reviewer-verdicts.jsonl`. JSONL requires exactly
one compact JSON object per line, terminated by a newline; no pretty-printing
inside a record. Each record looks like:

```text
{"timestamp":"2026-04-26T15:00:00Z","pr_number":42,"agent":"reviewer","verdict":"APPROVE","wall_clock_seconds":18}
{"timestamp":"2026-04-26T15:00:00Z","pr_number":42,"agent":"reviewer-adversary","verdict":"BLOCK","wall_clock_seconds":22}
```

- One record per agent per invocation, append-only. Create the directory
  `.adder-pipeline/` and the file if absent. The exact setup command (kept on
  a single line so copy-paste runs as a unit):

  ```bash
  mkdir -p .adder-pipeline && touch .adder-pipeline/reviewer-verdicts.jsonl
  ```

  Then append the JSONL records.

- `timestamp` ISO-8601 UTC, `pr_number` is the GitHub PR number (use `0` if
  logging a pre-PR dry-run with no PR open yet), `agent` is `reviewer` or
  `reviewer-adversary`, `verdict` is one of `APPROVE` / `REQUEST_CHANGES` /
  `BLOCK`, `wall_clock_seconds` is the integer seconds the agent took.
- The log feeds the weekly distribution check that drives the prompt-tightness
  re-evaluation and the adversary's bake-in counter; see
  `~/projects/code-review-pipeline/pipeline-state.md` "Post-PR reviewers" /
  reviewer-subagent criteria. Grouping is by `agent`.
- Do this even when the verdict is `APPROVE`. The denominator is as important
  as the numerator.

### Pull request workflow

1. Open PR against `main`
2. **CodeRabbit Pro Plus** (required) auto-reviews. **Gemini**, **Greptile**
   (public repos only), and **CodeQL** also post advisory findings. The
   live reviewer roster is recorded in
   `~/projects/code-review-pipeline/pipeline-state.md` (internal
   maintainer configuration — not accessible or editable by external
   contributors; the required-vs-advisory split above is the effective
   roster external contributors should treat as authoritative).
3. Dependabot runs on dep-related PRs
4. Iterate on every comment from CodeRabbit (the required reviewer). Resolve
   advisory-reviewer threads with the same rigor — nitpicks count. When an
   advisory reviewer disagrees with CodeRabbit or with this CLAUDE.md, the
   summary triage rule is:
   - **Convergent finding** (≥ 2 reviewers flag the same issue):
     auto-apply, unless the finding falls under an auto-dismiss rule
     in [Reviewer Triage Rules](#reviewer-triage-rules) below.
   - **CodeRabbit vs. advisory disagreement**: prefer CodeRabbit (the
     required reviewer); auto-dismiss the advisory finding with a one-line
     reason in the PR body.
   - **Advisory finding contradicts an explicit rule in this CLAUDE.md**:
     auto-dismiss; cite the CLAUDE.md section in the dismissal note.
   - **Substantive disagreement that doesn't fit the above** (e.g. two
     incompatible fixes, both defensible): stop and ask the human — do not
     oscillate between the two reviewers' preferred approaches.

   See **Reviewer Triage Rules** below for codified dismissal patterns
   (specific named cases derived from `run-log.md`).

5. Ask the human to merge only when all the following are true:
   - All CI checks green
   - All CodeRabbit threads resolved
   - All advisory-reviewer threads resolved or explicitly auto-dismissed in
     the PR body
   - `npm run pre-pr` passes locally on the branch head

   **There is no human code review.** The pipeline spec is explicit: "No
   human code review — pipeline must be thorough enough that human only
   tests functionality." The human's pre-merge role is confirming that
   CI + AI reviewers are clean and clicking merge — not inspecting the
   diff. Branch protection intentionally sets
   `required_pull_request_reviews: null` to match this principle;
   reviewer approval at the GitHub level is not required and not
   configured. Human functional testing happens post-merge.

### Never do

- Force-push to `main` (branch protection blocks it anyway)
- Bypass the gate with `--no-verify` on commits
- Disable a Biome lint rule (via `biome.json` or a `// biome-ignore` comment),
  or a type-aware ESLint rule (via `eslint.config.mjs` or an
  `// eslint-disable` comment), to make the gate pass — fix the underlying
  code instead
- Add files to `.gitignore` to hide them from Semgrep/SonarQube
- Commit secrets — Gitleaks will catch them, but don't make it do that
- Change `package.json` scripts `pre-pr`, `verify:all`,
  `security:all` without asking the user first — these are pipeline interfaces

### When a session ends or context saturates

Log progress in `.adder-pipeline/session-log.md` with:

- What you were doing
- Current branch
- What's left to do
- Anything the next session needs to know

This survives context restarts.

## Reviewer Triage Rules

When reviewers contradict each other or suggest defensive changes that
conflict with mutation-test intent, apply these rules. Each is grounded
in a real example logged in
`~/projects/code-review-pipeline/run-log.md`; the audit (2026-04-26
Q3) lifted them from tribal knowledge into codified policy so triage
doesn't have to be rediscovered every PR.

### Auto-dismiss (post a rationale comment, then `resolveReviewThread`)

1. **Empty-string-as-undefined on mutation-kill tests** — when a
   reviewer suggests treating empty string the same as undefined
   inside a test designed to kill a string-literal mutant. The
   test's exact-match behavior IS the kill mechanism; the
   "defensive" merge would silently drop the kill.
2. **Transient-error retry suggestions in CI gate scripts** — when a
   reviewer suggests adding `curl`/network retry logic to a gate
   script. Fail-loud-then-rerun is the correct retry layer; gate
   scripts should be deterministic single-shot. Wrapping in retry
   masks the failure mode the gate is supposed to surface.
3. **API-style preference vs. existing pattern consistency** — when
   a reviewer suggests switching to a "more idiomatic" API (e.g.
   Zod `.unwrap()` over the in-place pattern, or `.then()` over
   `async/await` in code that already uses one) where a different
   pattern is used consistently across the codebase. Consistency
   wins; one-off "improvements" become inconsistency tax for every
   future reader.
4. **Documented decisions self-defense** — when a reviewer (e.g. a
   tool that was demoted in `pipeline-state.md`) suggests reverting
   its own demotion. Doc-aligned action wins; cite the
   `pipeline-state.md` entry in the dismissal note.

### Auto-apply (high confidence)

5. **Convergent ≥ 2 reviewers** — when 2 or more reviewers
   independently flag the same issue, treat it as auto-apply unless
   either (a) it conflicts with an auto-dismiss rule above, or (b)
   the suggested change would violate an explicit rule defined
   elsewhere in this CLAUDE.md (e.g. TypeScript Rules, Code Style,
   security non-negotiables). Convergent findings have empirically
   been correct in every Phase-4 PR logged in `run-log.md`, but
   reviewer agreement does not override project standards.

### Always escalate

6. **Hallucinated diff content** — when a reviewer claims a file is
   missing or present in a way that contradicts the actual diff
   (e.g., a reviewer claiming a file is absent when it is clearly
   present in the diff, or vice versa). Escalate to the human; this
   indicates a reviewer FP-rate concern, not a PR concern, and the
   human needs to know if the reviewer's signal quality is degrading.

For the substantive-disagreement case (two reviewers propose
incompatible fixes, both defensible), the existing PR-workflow
step 4 sub-bullet still applies: stop and ask the human — do not
oscillate between the two reviewers' preferred approaches.

<!-- /ADDER-PIPELINE:v2 -->
