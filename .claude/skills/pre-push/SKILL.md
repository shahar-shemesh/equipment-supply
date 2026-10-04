---
name: pre-push
description: 'Scan everything that is about to be pushed before it leaves the machine: type-check, tests, dependency audit, secrets and debug leftovers, then two independent review subagents for bugs and bad practice. Use when the user says "pre-push", "scan before push", "check the code before I push", "is it safe to push", or asks to push and the current HEAD has not been scanned. The PreToolUse hook `.claude/hooks/pre-push-guard.sh` blocks a push until this skill has passed on the current HEAD.'
---

# Pre-push: scan what is about to leave the machine

**Goal:** a verdict, `PUSH` or `FIX FIRST`, with every blocker named by file and line, before any commit reaches GitHub.

Three layers, cheapest first. A layer that fails does not stop the next one; the report shows all of them at once so the user fixes everything in one round.

| Layer | What | Cost |
|---|---|---|
| A | deterministic checks: tsc, tests, `npm audit`, secrets and debug leftovers | tokens only for the tails |
| B | two review subagents on the diff: bugs, bad practice | two subagents, parallel |
| C | triage and report | this context |

Read `AGENTS.md` as binding. Never push unless the user asked for it in the same message (`/pre-push push` or "scan and push").

## Step 0: scope

```sh
git fetch origin --quiet
base=$(git merge-base HEAD origin/main)
git log --oneline $base..HEAD
git status --porcelain
```

- Nothing in the range and a clean tree: say "nothing to push" and stop.
- Untracked files are part of the scan: `git add -N <paths>` before the diff, `git reset <paths>` right after. Only those paths, never a blanket reset.
- Write the review diff once, without lockfiles, generated docs and design exports:

```sh
out=<scratchpad>/pre-push/$(git rev-parse --short HEAD); mkdir -p $out
git diff $base -- . ':!*package-lock.json' ':!design' ':!docs/README.he.md' > $out/review.diff
```

- Touched packages: `client/` if the diff has `client/` or `shared/` paths, `server/` likewise. Layer A runs per touched package only.

## Layer A: deterministic checks

Run inside each touched package, output to `$out/<check>.log`, only `tail -15` into context. Collect results; do not stop on the first failure.

1. **Types**: `npx tsc --noEmit -p tsconfig.json`. Blocker on non-zero exit.
2. **Tests**: `npm test` in `client/`; `npm run test:unit` in `server/`. If the diff touches `server/src` outside tests and `docker compose ps` shows the database up, also `npm run test:e2e`; otherwise write "e2e skipped: database down" in the report. Blocker on any failing spec; read only that spec's block from the log.
3. **Dependency audit**, both packages regardless of what the diff touched, since `package-lock.json` changes hide in merges:
   - `npm audit --omit=dev --audit-level=high`: non-zero exit is a **blocker**. Runtime code with a known high or critical hole does not ship.
   - `npm audit --json` summarised by severity with the top-level package names: **informational**, listed under "dev tooling" in the report. Today's baseline (2026-10-04): client 7 (vite, vitest), server 53 (jest, nest-cli). Only a rise above the last report is worth a line.
   - `npm outdated` on direct dependencies that are a **major** version behind: informational, one line per package, no recommendation to upgrade inside this skill.
   - Offline (`npm audit` fails with ENOTFOUND or similar): write "audit skipped: offline" and treat as a warning, not a pass.
4. **Secrets and leftovers** over added lines only (`grep '^+' $out/review.diff | grep -v '^+++'`):
   - blocker: anything matching `(password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}`, `BEGIN (RSA|EC|OPENSSH) PRIVATE KEY`, `AKIA[0-9A-Z]{16}`, `ghp_[A-Za-z0-9]{36}`, a connection string with a password, or a new `.env` file that is not `.env.example`. A hit inside a `*.spec.ts`, `seed/` or `docs/` path with an obviously fake value is a warning; say why you downgraded it.
   - warning: `console.log` outside `server/src/main.ts` and test files, `debugger`, `it.only` / `describe.only` / `test.only` / `fit(` / `fdescribe(`, `@ts-ignore` without a comment, `eslint-disable`, `TODO` / `FIXME` / `XXX` added in this range.
5. **Repo rules that a grep can check**:
   - a change under `server/src/**/*.entity.ts` without a new file in `server/src/migrations/`: blocker (AGENTS.md: every entity change needs a migration).
   - a spec file added or deleted without a change to `README.md`: warning (the `## Tests` counts must follow).
   - a string literal with Hebrew characters added in `client/src` outside `shared/i18n/he.ts`: warning (every UI string goes through `t()`).

## Layer B: two review subagents

Launch both in parallel, each with no conversation context, each told: "Do not invoke skills, do not spawn subagents, return findings as text." Each prompt is the full text of one file in this skill's `review-prompts/` directory plus the line `Diff: $out/review.diff` and the line `Repo rules: <absolute path>/AGENTS.md`.

- `review-prompts/bugs.md`: correctness. Things that produce a wrong result, a crash, a lost write, a race, a broken offline sync rule.
- `review-prompts/practices.md`: bad practice and security hygiene against `AGENTS.md` conventions and the project's security model.

Both return at most 10 findings, each with severity (`blocker`, `warning`, `nit`), `file:line`, one sentence on the defect and one on how to confirm it.

## Layer C: triage and report

1. Verify every subagent finding against the code, not against the reviewer's wording. A finding the code refutes is dropped with a one-line refutation; keep it in the report under "refuted" so the user sees it was considered.
2. Write `$out/report.md`:

```markdown
# Pre-push report — <date> — <range: base..HEAD, N commits, M files>

**Verdict:** PUSH | FIX FIRST

## Blockers
- file:line — defect — how to confirm

## Warnings
- ...

## Dependencies
- runtime audit: client clean / server clean (or the advisory)
- dev tooling: client N (top packages), server N (top packages); baseline 2026-10-04: 7 / 53
- major versions behind: ...

## Refuted
- finding — why it does not hold

## Checks run
- tsc client ok / server ok; tests client 72 ok / server unit 47 ok / e2e skipped (reason); audit ok
```

3. Verdict rule: any blocker is `FIX FIRST`. Warnings alone are `PUSH`, listed so the user can decide.
4. On `PUSH`, write the marker the hook checks: `git rev-parse HEAD > .claude/pre-push-ok`. On `FIX FIRST`, do not write it. If the user later says "push anyway", say which blockers are being pushed, write the marker, then push.
5. Fixing a blocker changes HEAD; the marker is stale by design. Re-run Layer A for the touched package and only the reviewer whose finding was fixed, then write the marker.

## In chat

Under 15 lines: the verdict, the blockers as a list, a count of warnings with the two most important, one line on dependencies, and the report path. Nothing from the logs. If the user asked to push and the verdict is `PUSH`, push and show the `git push` output line.
