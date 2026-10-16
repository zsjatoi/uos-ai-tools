---
description: Turn the accessibility PostToolUse hook back ON (deletes .claude/a11y/hook.off)
allowed-tools: Bash(*)
---

Delete the toggle file `.claude/a11y/hook.off` from the project root if it exists.
Removing it re-enables the accessibility hook so audits run again after edits.

If the file does not exist, the hook is already on.

Then confirm in exactly ONE line:
`Accessibility hook ON — .claude/a11y/hook.off removed. Audits run after HTML/CSS/JS edits.`
