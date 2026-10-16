---
description: On-demand Playwright BEHAVIOUR test of a form's dynamic accessibility behaviour. Covers empty-submit blocking, focus to the first invalid field, live per-field error clearing and a role="status" confirmation. Headless. Never automatic.
allowed-tools: Bash(node:*), Read
---

Run the **on-demand** behaviour test.

The argument typed is: `$ARGUMENTS`

`behaviour-audit.template.mjs` is a template. It runs as shipped against the kit's
own form fixture. To test your forms, copy it to
`.claude/a11y/sr/behaviour-audit.mjs` and change the selectors and assertions.
Prefer the copy if it exists.

## What this is (say so in your summary)

- It drives the page with a headless browser and asserts **behaviour over time**
  that a static audit and a single screen-reader read cannot see: submission
  blocking, focus moving to the first invalid field, `aria-invalid` flipping,
  `aria-describedby` tying to a visible error, live per-field error clearing with
  no re-submit, and a `role="status"` region that is empty and then populated on a
  valid submit.
- It reports DOM and behaviour truth. It is not a screen-reader announcement
  check and not a usability statement.
- It needs no screen reader and no foreground window. On-demand only; not part of
  the edit hook.

## Run it

- Default positive page: `a11y-fixtures/form-demo/after.html` (the correct form).
  Negatives always run against `a11y-fixtures/form-demo/before.html` (a `<div>`
  submit and a `<span>` help control, neither in the tab order).
- Run: `node .claude/a11y/sr/behaviour-audit.template.mjs $ARGUMENTS`
  (or `behaviour-audit.mjs` if you made your own copy). An optional second
  argument overrides the negative-control page, used to prove the negatives can
  fail.
- The preview server must be up. If it is not, tell the person to start it.

## Report back

- Per-assertion pass or fail with the asserted values the script prints.
- What the negatives prove: the falsifiable checks are "submit never receives
  focus via Tab" and "help is not in the tab order".

## Honesty rule (every time)

End by stating that this verified DOM and behaviour properties only. It is not a
screen-reader announcement check, and not WCAG 2.2 AA conformance. For what a
screen-reader user hears, see `/a11y-sr` (simulated) and `/a11y-nvda` (real NVDA,
Windows only), and `.claude/skills/a11y-audit-loop/references/manual-checks.md`.
