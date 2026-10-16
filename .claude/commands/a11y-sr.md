---
description: On-demand screen-reader (virtual) test of a page. Voices it through the simulated reader and flags controls with no accessible name. Never automatic.
allowed-tools: Bash(node:*), Read
---

Run the **on-demand** virtual screen-reader test against a single page.

The argument typed is: `$ARGUMENTS`

## What this is (say so in your summary)

- It drives a real browser (a Playwright-cached Chromium, launched by explicit
  path) and reads the page through the Guidepup **virtual screen reader, which is
  a simulation**, not real NVDA. It checks accessible **name, role, state and
  reading order**.
- It is not real NVDA speech, and a clean run does not mean the page is usable
  with a screen reader. Real NVDA is a separate, Windows-only escalation,
  `/a11y-nvda <page>`. It takes over the screen reader and the desktop, so it is
  never run automatically: offer it, do not launch it.
- It is on-demand only and is not wired into the edit hook.

## Run it

- If the argument is empty, ask which page (a path relative to the web root, for
  example `index.html` or `a11y-fixtures/fixture-broken.html`). Do not guess.
- Otherwise run: `node .claude/a11y/sr/sr-audit.mjs $ARGUMENTS`
  (an optional second argument caps the printed reading-order lines, default 80).

The script reads its toolchain from outside the project (see
`.claude/a11y/sr/SETUP.md`) and prints the reading order (one pass), the headings,
the interactive controls (each marked `[NO NAME]` if unnamed), the image count,
and a list of any interactive control voiced without an accessible name.

## Report back

- **What was voiced:** the reading order at a glance (landmarks, headings,
  controls), and whether it matches the intended structure.
- **Controls without a name:** list each `[NO NAME]` control. These are the
  clearest problems. Suggest the semantic-HTML-first fix: a real `<label for>`,
  visible link text, or a text name for an icon button. Never the `title`
  attribute.
- **Images with no name:** note them, but do not assume they are wrong. An empty
  name is correct for decorative images and wrong for meaningful ones.

## If the preview server is down

If the script prints "Preview server is not running", tell the person to start
their preview server and retry. Do not try to fix anything.

## Honesty rule (every time)

End by stating plainly that this checked name, role and reading order through a
**simulated** reader. It did not verify real NVDA behaviour, live-region
announcements, focus management in custom widgets, or whether the page is usable.
Those need a person listening to a real screen reader. See
`.claude/skills/a11y-audit-loop/references/manual-checks.md`.

If the toolchain is not installed on this machine, the script says so and exits
with an error. Tell the person, and point them at `.claude/a11y/sr/SETUP.md`.
