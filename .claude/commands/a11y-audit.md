---
description: Audit a page (or all key pages) for WCAG 2.2 AA with both engines, showing violations and potentials separately
allowed-tools: Bash(node:*), Read
---

Run an on-demand accessibility audit using the shared runner.

The argument typed is: `$ARGUMENTS`

Decide what to run:

- If the argument is `all` (or empty), audit the configured key pages:
  `node .claude/a11y/audit.mjs --all`
- Otherwise treat the argument as a page path relative to the web root and run:
  `node .claude/a11y/audit.mjs $ARGUMENTS`

The runner reads the pinned engine versions from `.claude/a11y/a11y.config.json`
and works from any current directory.

Then summarise the result in chat. For each page, show BOTH levels as SEPARATE
counts, per engine:

- **violations** (hard failures: IBM `FAIL`, pa11y `error`) with up to five rule ids
- **potentials** (manual-review worklist: IBM `POTENTIAL`, pa11y `warning`) with up to five rule ids

Keep it close to the runner's own compact output. Potentials are wanted here:
they are the manual-review worklist, even though the edit-time hook ignores them.

Token discipline:

- Do not paste full JSON reports into chat.
- Open the full report files (paths are printed under `.claude/a11y/reports/`)
  only if the person asks you to fix the findings.

If the runner prints "Preview server is not running", tell the person to start
their preview server (the address is `previewBase` in
`.claude/a11y/a11y.config.json`) and retry. Do not try to fix anything.

End by reminding the person that a clean automated run is not full WCAG 2.2 AA
conformance, and point them at
`.claude/skills/a11y-audit-loop/references/manual-checks.md` for what still needs
manual testing.
