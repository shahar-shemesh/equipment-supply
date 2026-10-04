---
name: task
description: 'Open a Jira task in project ES (Equipment Supply) from a one-line description, under a parent epic, in the current sprint, for Dror Musai''s Dev Team; with "build" also run the whole delivery chain: branch, /build, /pre-push, push, PR, then wait for "merge" and finish with squash, branch cleanup and the Pending QA transition. Use when the user types "/task <desc>", "/task build <desc>", "/task-build", "open a ticket for X", "צור משימה", "פתח טיקט", or asks to turn a request into a Jira task.'
---

# Task: Jira ticket, optionally the whole delivery chain

**Goal:** the user describes work in one line from chat; the ticket exists in Jira the way the team's tickets look, and in build mode the work ships through one PR with a single human gate before the irreversible merge.

Read `AGENTS.md` as binding. All ids come from `references/jira.md` in this skill's directory; read it first. The Atlassian tools are deferred: load them once with ToolSearch `select:mcp__claude_ai_Atlassian_MCP__createJiraIssue,mcp__claude_ai_Atlassian_MCP__searchJiraIssuesUsingJql,mcp__claude_ai_Atlassian_MCP__executeRead,mcp__claude_ai_Atlassian_MCP__transitionJiraIssue,mcp__claude_ai_Atlassian_MCP__addOrEditJiraIssueComment`. If they are missing, the connector is not authorized: say so and stop.

## Step 0: parse the request

- `/task <desc>` → **create** mode: steps 1 and 2 only. The default.
- `/task build <desc>` or `/task-build <desc>` → **build** mode: steps 1 to 6.
- No description → ask for it in one line and stop until it arrives.
- An `ES-<n>` in the text that refers to an existing task means "work on that ticket": skip step 2, read the ticket with `getJiraIssue`, continue from step 3 in build mode.

## Step 1: the epic gate

A parent epic is mandatory. Take it from the text (`ES-<n>` of an Epic, or "epic ES-3"). If none is given:

1. Search `project = ES AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC`.
2. Ask the user with AskUserQuestion, one option per epic (key and summary), plus the free-text "Other" for a key.
3. No key, "none", "later", or anything that is not an epic key → **stop. Create nothing, do not continue.** Say in one sentence that the task was not created because no epic was given.

Verify the key is an Epic in ES before using it. A Task or Story key is not an epic; go back to the question once.

## Step 2: create the ticket

Compose, in Hebrew, matching the board's style (short imperative summaries, see any IZKOR or RISHSAP ticket):

- **Summary**: under 80 characters, what changes for whom. Not the user's sentence verbatim if it is long.
- **Description**: two to six lines. What, why, where in the code (`client/`, `server/`, `shared/`), and anything the user said about scope. No invented requirements.
- **Acceptance Criteria** (`customfield_10539`): two to four lines of observable outcomes, only when the request implies them. Otherwise leave it empty.

Resolve the active sprint id (`getJiraBoardSprintData`, board 714). Then one `createJiraIssue` call:

```
projectKey ES, issueType Task, summary, description, parent <epic key>,
assignee <current user accountId>, assignToSprint "<active sprint id>",
additional_fields { "customfield_10364": {"name": "Dror Musai's Dev Team"} }
```

Add `priority` only when the user said urgent, high, low or similar; `customfield_10053` only when a tester was named (resolve with `listJiraIssueAssignableUsers`). On a rejected field follow the repairHint once; if the ticket was created but `sprintAssignment.assigned` is false, do not create it again, say the sprint was not set.

Report: key, link `https://mod-malan.atlassian.net/browse/<KEY>`, epic, sprint. In create mode this is the final message.

## Step 3: branch (build mode)

1. `git status --porcelain`. If it is not empty, list the dirty paths and ask whether to go on. Another session's work may be there; never stash, reset or commit it. On a yes, continue with the dirty files left alone and never stage them.
2. `git fetch origin --quiet` then `git checkout -b ES-<n>-<slug> origin/main`. The slug is three to five English words from the technical or business meaning (`ES-812-courier-qr-scan`), not a transliteration of the Hebrew summary.
3. Transition the ticket to In Progress (transition 4).

## Step 4: implement and verify

Invoke the `build` skill with the ticket's summary and description as the request and the key as context. Let it take its own route (oneshot or full). When it returns, its verification has run; if it reported a failure, fix it before going on.

Commit only the files of the task (`git add <paths>`, never `-A` or `.`), message:

```
ES-<n>: <summary>

<two or three lines on what changed and why>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

## Step 5: scan, push, PR

1. Invoke the `pre-push` skill. On `FIX FIRST`, fix the blockers it named, amend nothing: add a commit, run it again. Do not push until it says `PUSH`; the hook `.claude/hooks/pre-push-guard.sh` blocks the push anyway.
2. `git push -u origin ES-<n>-<slug>`.
3. `gh pr create --base main --head ES-<n>-<slug> --title "ES-<n>: <summary>" --body-file <scratchpad file>`. The body: one paragraph of what and why, the verification that ran, the ticket link `https://mod-malan.atlassian.net/browse/ES-<n>`, and the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
4. Comment the PR URL on the ticket (`addOrEditJiraIssueComment`).
5. Refresh `.claude/handoff.md` with the `handoff` skill: ticket, branch, PR, "waiting for merge".
6. **Stop.** Final message: ticket link, PR link, the one-line verdict from pre-push, and "say merge to finish". Do not merge on your own, whatever the mode said.

## Step 6: merge (only after the user says "merge")

1. `gh pr merge <number> --squash --delete-branch`. This also switches to main and deletes the local branch. If the PR has conflicts, say so and stop; do not resolve them under this skill.
2. `git pull --ff-only origin main`. Confirm the local branch is gone (`git branch --list ES-<n>-*`); delete it if `gh` left it.
3. Transition the ticket with transition 6 (status "Pending QA version"; the workflow has no plain "Pending QA").
4. Comment on the ticket: merged, PR link, merge commit sha.
5. Set `.claude/handoff.md` to "nothing in progress".

Final message: ticket link, its new status, the merge commit. Nothing else.

## Guard rails

- One ticket per invocation. A request that is really two tasks gets two invocations; say so.
- Never create an issue of another type or in another project from this skill.
- Never commit or push outside steps 4 to 6, and never on `main`.
- A failed Jira write after the ticket exists (sprint, transition, comment) is reported with the key, not retried blindly more than once.
