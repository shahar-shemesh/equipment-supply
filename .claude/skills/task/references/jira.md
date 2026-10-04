# Jira ids for `/task` (discovered 2026-10-04 against the live site)

Looked up once so the skill never has to discover them again. If a call fails with
"field not found" or "transition not available", re-discover with the Atlassian MCP
through `executeRead` (operation names `listJiraProjectIssueTypesMetadata`, `getJiraIssueTypeMetaWithFields`,
`listJiraIssueTransitions`, `getJiraBoardSprintData`) and update this file. SKILL.md names
fields and transitions by role only, so this file is the single copy of every number.

## Site

| What | Value |
|---|---|
| Site | https://mod-malan.atlassian.net |
| cloudId | `41ec62c7-bc0d-4886-8b53-730e95ae5547` |
| Project | Equipment Supply, key `ES`, id `11743` |
| Board | 714 "Dror Dev Team board" (scrum, filed under project AGILE). Its filter 11045 includes Equipment Supply. |
| Current user | resolve at run time with `atlassianUserInfo`; never hard-code an accountId |
| Issue URL | `https://mod-malan.atlassian.net/browse/<KEY>` |

## Issue types in ES

| Type | id |
|---|---|
| Epic | 10000 |
| Story | 10006 |
| Bug | 10019 |
| Task | 10049 (the one `/task` creates) |
| Sub-task | 10050 |
| Test | 10128 |

## Fields on the Task create screen

| Field | id | Shape to send |
|---|---|---|
| Parent (epic) | `parent` | top-level `parent: "ES-<n>"` |
| Sprint | `customfield_10020` | prefer `assignToSprint: "<numeric sprint id>"` |
| צוות (team, group picker) | `customfield_10364` | `{"name": "Dror Musai's Dev Team"}` |
| בודק/ת QA (user picker) | `customfield_10053` | accountId, only when the user names a tester; resolve with `executeRead` name `listJiraIssueAssignableUsers`, inputs `{projectKeyOrId: "ES", query: "<name>"}` |
| Acceptance Criteria | `customfield_10539` | plain text |
| DOD / DOR | `customfield_10537` / `customfield_10538` | plain text |
| Priority | `priority` | `Blocker`, `High`, `Medium` (default), `Low` |

The team field is NOT on the Epic create screen. A task created without it defaults to
whatever the project default is (ES-2 came out as "abra team"), so always set it.

## Sprint

The active sprint changes every two weeks, so resolve it at run time:
`executeRead` with name `getJiraBoardSprintData`, inputs `{boardId: "714", includeIssues: false}` →
`resolvedSprint.id`. Sprint names follow `Dror-YY-MM-DD` (7930 = Dror-26-10-04).

## Transitions (ES Task workflow, ids stable, all available from any status; other issue types may differ)

| Transition | id | Leads to status |
|---|---|---|
| New | 8 | New (10062) |
| To Do | 11 | To Do (10055) |
| In Progress | 4 | In Progress (3) |
| On Hold/Pending Meeting | 7 | On Hold/Pending Meeting (10060) |
| Pending QA version | 6 | Pending QA version (10057) |
| In Testing | 5 | In Testing (10058) |
| Pending Deploy to Prod | 2 | Pending Deploy to Prod (10059) |
| Done | 3 | Done (10026) |

There is no status named "Pending QA" in this workflow. The board column
"Pending QA Version" maps both names, so after merge the skill moves the ticket
with transition 6.

## Epics

Listed at run time: `project = ES AND issuetype = Epic AND statusCategory != Done`.
ES-3 "ניהול אתר וממשק שליחים" is the umbrella epic for the whole system.
