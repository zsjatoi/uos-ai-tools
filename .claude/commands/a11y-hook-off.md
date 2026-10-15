---
description: Turn the accessibility PostToolUse hook OFF (creates .claude/a11y/hook.off)
allowed-tools: Bash(*), Write
---

Create an empty toggle file at `.claude/a11y/hook.off` in the project root. While
this file exists, the accessibility hook skips all audits after edits.

If the file already exists, leave it as is.

Then confirm in exactly ONE line:
`Accessibility hook OFF — .claude/a11y/hook.off created. Run /a11y-hook-on to re-enable.`
