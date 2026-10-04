---
name: handoff
description: 'Write or refresh .claude/handoff.md, the short resume point a new session or a post-compaction context reads first. Use when the user says "handoff", "save state", "I am stopping", "write where we are", before a long multi-step run, and when a task completes.'
---

# Handoff: write the resume point

`.claude/handoff.md` is printed into context by a SessionStart hook on startup, resume and after every compaction. It is git-ignored and overwritten each time, never appended.

## Write it

Overwrite `.claude/handoff.md` with at most 40 lines in this shape:

```markdown
# Handoff — <date> <time>

**Goal:** one sentence, the user's words where possible.
**Plan:** docs/plans/<slug>.md (or "none, oneshot")
**Branch:** <git branch>  **Base:** <short sha>

## Done
- bullet per completed step, file paths included

## Next step
- the single next action, concrete enough to start without re-deriving it

## Files touched
- path -- what changed (uncommitted unless stated)

## Verify
- exact commands and expected result

## Open questions / blockers
- anything waiting on the user; "none" if none
```

Rules:

- Facts only. No narrative, no restating the plan body. The plan file holds the detail.
- Name the last command that failed with its one-line error, if any.
- Mention other uncommitted work in the tree that is not part of this task, so the next session does not commit it by mistake.
- When nothing is in progress, the whole file is: `# Handoff — <date>` and `Nothing in progress. Last completed: <one line>.`

## After writing

Say in one line that the handoff is written and what the next step is. Nothing else.
