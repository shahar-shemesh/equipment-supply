---
name: build
description: 'Turn a feature, bug fix or meaningful change into reviewed, verified code: short plan, implementation, two independent review subagents, report. Use when the user delegates a feature, story, bug or change ("build X", "implement X", "fix X", a pasted issue). Skip for mechanical edits (typo, formatting, one-line config) and for user-directed interactive edits.'
---

# Build: plan, implement, review, present

Standalone adaptation of BMAD's `bmad-build` (MIT) without its runtime. The review prompts under `review-prompts/` and `references/` are BMAD's, unchanged.

**Goal:** working code that an independent reviewer has tried to break, with a plan file that lets a fresh session pick the work up.

Read `AGENTS.md` rules as binding. Never commit or push unless the user asks.

## Step 1: clarify and route

1. Restate the request in two sentences: the problem and the user-visible outcome. If a product decision is needed that `## Open decisions` in `README.md` does not settle, stop and ask; do not decide it in code.
2. Locate the code. If the area is unfamiliar, send one Explore subagent and keep only its conclusion.
3. Route by estimated size, decided now with no further reading:
   - **oneshot**: 100 changed lines or fewer, follows an existing pattern. No plan file. Go to Step 3.
   - **full**: anything else, or more than five files that are not mechanical. Go to Step 2.
   The user can pin a route by saying "oneshot" or "full".

## Step 2: plan (full route)

Write `docs/plans/<slug>.md` from `plan-template.md` in this skill's directory. Rules:

- One user-facing goal per plan. Independent shippable deliverables get separate plans.
- 900 to 1600 tokens. Below that it is ambiguous, above it the implementer loses context.
- `Intent`, `Boundaries` and the `I/O & Edge-Case Matrix` are the human-owned part. `Code Map` and `Tasks & Acceptance` are yours, with a file path on every task and Given/When/Then on every acceptance criterion. No placeholders, no TBD.
- `context:` in the frontmatter lists only files the implementer must load that the plan body does not already distill. Usually `AGENTS.md` plus one or two files.
- `Verification` lists the exact commands from `AGENTS.md` (`npm run test:unit`, `npm run test:e2e` with the database up, `npm test` in `client/`) and what success looks like.

Show the user the Intent, the task list and the acceptance criteria, then stop and wait. Proceed on a yes, amend on anything else. Skip the wait only when the user said up front to run without questions.

## Step 3: implement

- **full**: launch one subagent with no conversation context and this prompt, filling the path:

  > Read `docs/plans/<slug>.md` fully and implement it. The plan is the sole source of truth. Load every file listed in its frontmatter `context:` before you start. Follow `AGENTS.md`. Append decisions, files touched and surprises to the plan's `## Implementation Notes`. When done, report what you changed, how you verified it, and anything left incomplete or risky.

  When it returns, run the plan's Verification commands yourself. Do not trust the report alone.
- **oneshot**: implement directly, then run the relevant package's tests.

A failing verification is fixed before review. If the fix needs a decision the plan did not cover, amend the plan's `## Plan Change Log` and say so.

## Step 4: review

1. Write the change to a file: `git add -N .` for new files, then `git diff > <scratchpad>/build-<slug>.diff`. Reset the intent-to-add afterwards with `git reset` on those paths only; never touch files that are not part of this task.
2. Launch two subagents in parallel, each with no conversation context. Each prompt is the full text of one review file in this skill's directory plus the inputs:
   - `review-prompts/edge-case-hunter.md` with "Review content: <diff path>" and, on the full route, "claims_file: docs/plans/<slug>.md". Its references (`references/deletion-check.md`, `references/claims-check.md`) are inlined at the bottom of the prompt file.
   - `review-prompts/verification-gap.md` with "Review content: <diff path>".
   Tell each: do not invoke skills, do not spawn subagents, return findings as text.
3. Triage every finding yourself against the code, not against the reviewer's wording:
   - real and in scope: fix it, re-run verification;
   - real and out of scope: list it under "deferred" with one sentence;
   - false: record the refutation.
   On the full route append the triage to the plan's `## Review Triage Log`. Loop back to review once at most if fixes were substantial; otherwise present.

## Step 5: present

In the final message, in this order:

1. What changed, file by file, one line each.
2. Verification commands run and their result, verbatim for failures.
3. Review findings: fixed, deferred, refuted. Counts in a short table.
4. What the user has to decide or do next, if anything.

Then update `## Tests` in `README.md` if tests were added or removed, and refresh `.claude/handoff.md` with `/handoff` (or set it to "nothing in progress").

## Scope guard

- Do not refactor beyond the task. Note the temptation under deferred instead.
- Do not change the offline conflict rules, the transition table or the lock order without the plan naming it as the intent.
- Do not add dependencies without the user's yes.
