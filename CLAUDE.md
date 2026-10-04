@AGENTS.md

## Claude Code in this repo

### Context budget

- `README.md` is 56 KB. Never read it whole. Find the heading with grep and read that section only; `AGENTS.md` above already says where things are.
- A search that may touch many files goes to an Explore subagent. Only its conclusion comes back into this context.
- Run test suites with the output piped through `tail -40`. On a failure read only that spec's block, not the whole log.
- Do not re-read a file already in context. Never cat `node_modules`, `dist` or `design/`.
- Anything long (a plan, a test summary, a review) is written to a file and summarized in chat, never pasted twice.

### Continuity across sessions and compactions

- `.claude/handoff.md` is the resume point. A SessionStart hook in `.claude/settings.json` prints it on startup, on resume and after every compaction. It is git-ignored and per machine.
- Write or refresh it with `/handoff`: before a step that will take many tool calls, whenever the user says they are stopping, and when a task completes (then it says "nothing in progress"). Keep it under 40 lines: goal, done, next step, files touched, how to verify, open questions.
- Plans from `/build` live in `docs/plans/<slug>.md` and are committed. Their `## Implementation Notes` section is append-only progress. A fresh session resumes from the plan plus the handoff, not from memory of the conversation.
- When the user types `/compact`, the summary must keep: the active plan path, the last completed step, the next step, and any command that failed with its error.

### Skills

- `/build`: plan, implement, two independent review subagents, present. For any feature, bug or change beyond a mechanical edit.
- `/qa-e2e-tests`: add API and e2e tests for features that already exist.
- `/refresh-agents-md`: re-verify `AGENTS.md` against the code after a wave of changes.
- `/handoff`: write the resume file.
- The built-in `/code-review`, `/security-review` and `/simplify` complement them. Run `/security-review` on anything touching auth, payload validation or the delivery report route.

### Git

- Never commit or push unless asked. When asked, stage only the files of the task; this working tree often holds another session's uncommitted work.
