---
name: refresh-agents-md
description: 'Re-verify AGENTS.md against the current code: drop lines whose subject is gone, fix paths and commands that moved, add observed pitfalls. Use when the user says "refresh AGENTS.md", "update the agent instructions", "record this pitfall", or after a wave of changes.'
---

# Refresh AGENTS.md

Standalone adaptation of BMAD's `bmad-project-context` (MIT). The admission rules are in `references/best-practices.md` in this skill's directory; read it before changing anything.

`AGENTS.md` is loaded into every session of every agent (Claude Code through `CLAUDE.md`, Codex directly). Every line costs context in every session, so a line earns its place only when it stops a mistake that would otherwise repeat.

## Step 1: find the baseline

The first line of `AGENTS.md` says `Verified <date> against <sha>`. Run `git log --oneline <sha>..HEAD` and `git diff --stat <sha>..HEAD` to see what moved. Also `git diff --diff-filter=DR --name-status <sha>..HEAD` for deletions and renames.

## Step 2: verify every line

For each bullet in `AGENTS.md`:

- A path or symbol it names must still exist. Check with Glob or Grep, do not assume.
- A command must still be the right invocation. Check `package.json` scripts and `docker-compose.yml`.
- A caveat ("3h off", "port 5433", "service worker only in the production build") must still hold. Read the config that decides it.
- A pitfall stays unless the thing it guards is gone. "Nothing failed lately" is not a reason to drop it.

Fix what moved. Mark what you could not verify and ask the user instead of guessing.

## Step 3: admit new lines

Candidates come from this session's evidence only:

- a mistake an agent made in this repo and the rule that would have prevented it (the user may name one: "record this pitfall");
- a command whose obvious form is wrong here;
- a convention that differs from the ecosystem default and was confirmed in code;
- a cross-component rule where getting one file wrong breaks another.

Reject: repo overviews, stack lists, style rules a linter could enforce, anything that is merely interesting. Prefer a prohibition with the permitted alternative in the same line.

## Step 4: write and report

- Keep the section structure. Keep the whole file under about 60 lines of bullets.
- Update the first line to `Verified <today> against <HEAD short sha>`.
- Report as a short list: lines changed, lines removed with the reason, lines added with the evidence, lines you could not verify.

Do not commit unless asked.
