#!/usr/bin/env bash
# PreToolUse hook on Bash: block a push of a HEAD that /pre-push has not passed.
# the skill writes the HEAD sha to .claude/pre-push-ok on a PUSH verdict;
# a fresh commit makes the marker stale and the next push is blocked again.
# exit 0 lets the command run, exit 2 blocks it and sends stderr to the model.

input=$(cat)

# only a push at a command position: start of the command or after ; && |
# a mention inside quoted text or an echo does not count
pattern='"command":"([^"]*[;&|] *)?git +push\b'
printf '%s' "$input" | grep -qE "$pattern" || exit 0

root="${CLAUDE_PROJECT_DIR:-.}"
head=$(git -C "$root" rev-parse HEAD 2>/dev/null)
marker="$root/.claude/pre-push-ok"

if [ -f "$marker" ] && [ "$(cat "$marker")" = "$head" ]; then
    exit 0
fi

echo "git push blocked: HEAD $head has not passed /pre-push (.claude/pre-push-ok missing or stale). Run the pre-push skill first; on PUSH it writes the marker." >&2
exit 2
