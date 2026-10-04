---
title: '{title}'
type: 'feature' # feature | bugfix | refactor | chore
created: '{date}'
status: 'draft' # draft | approved | in-progress | in-review | done | blocked
base: '' # git revision the plan was written against
context: [] # repo paths the implementer must load; keep short, only what the body does not distill
---

<!-- Target: 900–1600 tokens. Never over-specify "how": use boundaries and examples instead.
     Cohesive cross-layer changes (DB + API + UI) stay in ONE file.
     Remove all HTML comments when filling this template. -->

## Intent

**Problem:** ONE_TO_TWO_SENTENCES

**Approach:** ONE_TO_TWO_SENTENCES

## Boundaries & Constraints

**Always:** INVARIANT_RULES

**Never:** NON_GOALS_AND_FORBIDDEN_APPROACHES

## I/O & Edge-Case Matrix

<!-- Delete this section if no meaningful I/O scenarios exist. Do not write "N/A". -->

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | INPUT | OUTCOME | No error expected |
| ERROR_CASE | INPUT | OUTCOME | ERROR_HANDLING |

## Code Map

<!-- Annotated paths so the implementer does not search blind. -->

- `FILE` -- ROLE_OR_RELEVANCE

## Tasks & Acceptance

<!-- One task per file where natural. If an I/O Matrix exists, include a task that unit-tests its edge cases.
     Acceptance criteria cover system-level behavior the matrix does not. -->

**Execution:**
- [ ] `FILE` -- ACTION -- RATIONALE

**Acceptance Criteria:**
- Given PRECONDITION, when ACTION, then EXPECTED_RESULT

## Verification

**Commands:**
- `COMMAND` -- expected: SUCCESS_CRITERIA

**Manual checks (only when no CLI check applies):**
- WHAT_TO_INSPECT_AND_EXPECTED_STATE

## Design Notes

<!-- Delete if the approach is straightforward. Golden examples of 5–10 lines only when non-obvious. -->

## Implementation Notes

<!-- Implementer-owned, append-only: decisions made, files touched, surprises. Empty at planning time. -->

## Plan Change Log

<!-- Append-only. What finding triggered the change, what was amended, what must survive. -->

## Review Triage Log

<!-- Append-only, one entry per review pass: each finding with verdict (fixed / deferred / refuted) and evidence. -->
