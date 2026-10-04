---
name: task
description: 'Open a Jira task in project ES (Equipment Supply) from a one-line description, under a parent epic, in the current sprint; "/task build <desc>" also runs the delivery chain (branch, /build, /pre-push, push, PR) and waits for "merge". Use when the user types "/task", says "open a ticket for X", "צור משימה", "פתח טיקט", or asks to turn a request into a Jira task.'
---

# Task: Jira ticket, optionally the whole delivery chain

**Goal:** the user describes work in one line from chat; the ticket exists in Jira the way the team's tickets look, and in build mode the work ships through one PR. The merge is the only irreversible step and always waits for the user's explicit "merge".

Read `AGENTS.md` as binding. Every id (cloudId, field ids, transition ids, board) lives in `references/jira.md` in this skill's directory; read it first and never copy a number from memory.

**Tools.** The Atlassian tools are deferred. Load them once with ToolSearch:
`select:mcp__claude_ai_Atlassian_MCP__createJiraIssue,mcp__claude_ai_Atlassian_MCP__getJiraIssue,mcp__claude_ai_Atlassian_MCP__searchJiraIssuesUsingJql,mcp__claude_ai_Atlassian_MCP__transitionJiraIssue,mcp__claude_ai_Atlassian_MCP__addOrEditJiraIssueComment,mcp__claude_ai_Atlassian_MCP__atlassianUserInfo,mcp__claude_ai_Atlassian_MCP__executeRead,mcp__claude_ai_Atlassian_MCP__discover`.
If ToolSearch finds none of them, the connector is not authorized: say so and stop. Lookups that are not primary tools (active sprint, assignable users, transitions, issue type metadata) run through `executeRead` with `name: "<operation>"`, the cloudId as a top-level argument and the inputs `references/jira.md` lists; `discover` is only for an operation that file does not name.

## Step 0: parse the request

- `/task <desc>` → **create** mode: steps 1 and 2 only. The default.
- `/task build <desc>` → **build** mode: steps 1 to 6.
- No description → ask for it in one line and stop until it arrives.
- The description is exactly an existing `ES-<n>` key, or "work on ES-<n>": read it with `getJiraIssue`. In create mode just report it; in build mode skip steps 1 and 2 and continue from step 3. It must be a Task (the transition ids in `references/jira.md` are the Task workflow's); for another type list its transitions at run time instead. An `ES-<n>` mentioned inside a longer description is context, not a target.

## Step 1: the epic gate

A parent epic is mandatory. Take it from the text (`ES-<n>` of an Epic, or "epic ES-3"). If none is given:

1. Search `project = ES AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC`.
2. Ask the user with AskUserQuestion, one option per epic (key and summary), plus the free-text "Other" for a key.
3. No key, "none", "later", or anything that is not an epic key → **stop. Create nothing, do not continue.** Say in one sentence that the task was not created because no epic was given.

Verify the key is an Epic in ES before using it. A Task or Story key is not an epic; go back to the question once.

## Step 2: create the ticket

Compose in Hebrew, matching the team's style: short imperative summaries. If unsure of the style, read the three newest tickets (`project = ES ORDER BY created DESC`, 3 results) and nothing more.

- **Summary**: under 80 characters, what changes for whom. Not the user's sentence verbatim if it is long.
- **Description**: two to six lines. What, why, where in the code (`client/`, `server/`, `shared/`), and anything the user said about scope. No invented requirements.
- **Acceptance Criteria** field: two to four lines of observable outcomes, only when the request implies them. Otherwise leave it empty.

Resolve at run time: the current user's accountId (`atlassianUserInfo`) and the active sprint id of board 714 (the sprint lookup in `references/jira.md`). Then one `createJiraIssue` call with: project ES, type Task, summary, description, `parent` = the epic key, `assignee` = the current user, `assignToSprint` = the sprint id, and in `additional_fields` the team field set to the team name as `references/jira.md` shows, plus the Acceptance Criteria field when written.

Add `priority` only when the user said urgent, high, low or similar; the QA tester field only when a tester was named (resolve with the assignable-users lookup). On a rejected field follow the repairHint once; if the ticket was created but `sprintAssignment.assigned` is false, do not create it again, say the sprint was not set.

Report: key, link `https://mod-malan.atlassian.net/browse/<KEY>`, epic, sprint. In create mode this is the final message.

## Step 3: branch (build mode)

1. `git status --porcelain`. If it is not empty, list the dirty paths and ask whether to go on. Another session's work may be there; never stash, reset or commit it. On a yes, continue with the dirty files left alone and never stage them. If `git diff --cached --name-only` lists anything, another session has it staged: stop, do not commit on top of it.
2. `git fetch origin --quiet` then `git checkout -b ES-<n>-<slug> origin/main`. If a branch `ES-<n>-*` already exists from an aborted run, check it out and rebase it on `origin/main` instead. The slug is three to five English words from the technical or business meaning (`ES-812-courier-qr-scan`), not a transliteration of the Hebrew summary.
3. Move the ticket to In Progress (its transition id is in `references/jira.md`).

## Step 4: implement and verify

Invoke the `build` skill with the ticket's summary and description as the request and the key as context. Let it take its own route; on the full route it still stops for the user's plan approval, so a `/task build` run can pause there. When it returns, its verification has run; if it reported a failure, fix it before going on.

Commit only the files of the task (`git add <paths>`, never `-A` or `.`). Message: first line `ES-<n>: <summary>`, then two or three lines on what changed and why, then the attribution lines the session's instructions give for commits.

## Step 5: scan, push, PR

1. Invoke the `pre-push` skill. On `FIX FIRST`, fix the blockers it named, amend nothing: add a commit, run it again. Do not push until it says `PUSH`; the hook `.claude/hooks/pre-push-guard.sh` blocks the push anyway.
2. `git push -u origin ES-<n>-<slug>`.
3. `gh pr create --base main --head ES-<n>-<slug> --title "ES-<n>: <summary>" --body-file <scratchpad file>`. The body: one paragraph of what and why, the verification that ran, the ticket link `https://mod-malan.atlassian.net/browse/ES-<n>`, and the attribution line the session's instructions give for pull requests.
4. Comment the PR URL on the ticket (`addOrEditJiraIssueComment`).
5. Refresh `.claude/handoff.md` with the `handoff` skill: ticket, branch, PR, "waiting for merge".
6. **Stop.** Final message: ticket link, PR link, the one-line verdict from pre-push, and "say merge to finish". Do not merge on your own, whatever the mode said.

## Step 6: merge (only after the user says "merge")

1. `gh pr merge <number> --squash --delete-branch`. This switches to main, pulls and deletes the local branch. If the PR has conflicts, say so and stop; do not resolve them under this skill.
2. `git pull --ff-only origin main`. If it refuses, local main carries a commit that is not on origin (another session's); say so and stop, do not reset. If `git branch --list ES-<n>-*` still shows the branch, `git branch -D` it (a squash-merged branch is never "merged" for `-d`).
3. Move the ticket to "Pending QA version" (transition in `references/jira.md`; the workflow has no plain "Pending QA").
4. Comment on the ticket: merged, PR link, merge commit sha.
5. Set `.claude/handoff.md` to "nothing in progress".

Final message: ticket link, its new status, the merge commit. Nothing else.

## Guard rails

- One ticket per invocation. A request that is really two tasks gets two invocations; say so.
- Never create an issue of another type or in another project from this skill.
- Never commit or push outside steps 4 to 6, and never on `main`.
- A failed Jira write after the ticket exists (sprint, transition, comment) is reported with the key, not retried blindly more than once.
