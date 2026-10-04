#!/usr/bin/env bash
# PreToolUse hook on Bash and PowerShell: block a push of a HEAD that /pre-push has not passed.
# the skill writes the HEAD sha to .claude/pre-push-ok on a PUSH verdict;
# a fresh commit makes the marker stale and the next push is blocked again.
# exit 0 lets the command run, exit 2 blocks it and sends stderr to the model.
#
# the command is extracted by parsing the hook json with node, not by regex over the raw
# json: an escaped quote or newline inside the command would otherwise hide the push.
# the guard fails closed: no node, unreadable json or no HEAD all block.

input=$(cat)

if ! command -v node >/dev/null 2>&1; then
    echo "git push blocked: pre-push-guard needs node on PATH to inspect the command." >&2
    exit 2
fi

# a push is a command segment that starts with git (any path, any number of -x / --x
# options with an optional value) followed by push. segments split on newlines, ; && || |
# parentheses and the then / do / else keywords. a quoted mention like 'note; git push'
# still blocks: a false block costs a retry, a false pass costs an unscanned push.
printf '%s' "$input" | node -e '
const fs = require("fs");
let cmd;
try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    cmd = input && input.tool_input && input.tool_input.command;
} catch (e) {
    process.exit(3);
}
if (typeof cmd !== "string") process.exit(0);
const segments = cmd.split(/\n|;|&&|\|\||\||\(|\)|\bthen\b|\bdo\b|\belse\b/);
const push = /^\s*(\S*[\/\\])?git(\.exe)?(\s+--?\S+(\s+[^-\s]\S*)?)*\s+push\b/i;
process.exit(segments.some((s) => push.test(s)) ? 1 : 0);
'
case $? in
    0) exit 0 ;;
    1) ;;
    *) echo "git push blocked: pre-push-guard could not parse the hook input." >&2; exit 2 ;;
esac

root="${CLAUDE_PROJECT_DIR:-.}"
head=$(git -C "$root" rev-parse HEAD 2>/dev/null)
marker="$root/.claude/pre-push-ok"

if [ -n "$head" ] && [ -f "$marker" ] && [ "$(cat "$marker")" = "$head" ]; then
    exit 0
fi

echo "git push blocked: HEAD ${head:-unknown} has not passed /pre-push (.claude/pre-push-ok missing or stale). Run the pre-push skill first; on PUSH it writes the marker." >&2
exit 2
