---
name: a11y-audit-loop
description: >-
  Use this skill whenever the user wants to audit, check, test, review or fix
  the accessibility of a page, component or site: any mention of WCAG, WCAG 2.2,
  AA conformance, screen readers (NVDA, JAWS, VoiceOver), keyboard access, colour
  contrast, focus order, target size or alt text, and any question of the form
  "is this accessible?", "are there a11y issues?" or "make this accessible". It
  runs the two pinned audit engines (IBM Equal Access and pa11y/axe) through the
  shared runner, then drives an audit, read report, fix (semantic HTML first),
  re-audit loop until the page is clean, and always finishes by listing what
  still needs MANUAL checking.
---

# Accessibility audit-and-fix loop

This skill audits pages for WCAG 2.2 AA using npx-only engines and fixes
findings semantic-HTML-first. The engines install nothing into your project.

## Routing: this skill is for pages your project serves

A page the project does not serve (a third-party prototype, a supplier demo, a
live site) cannot be audited here. `.claude/a11y/audit.mjs` builds every URL as
`previewBase` + page and refuses to run unless the local preview server is up.
Do not repoint `previewBase` at someone else's site: it would change what the
edit-time hook audits on every edit.

## Before you start

1. **Confirm the preview server is up.** The engines load pages over HTTP from
   `previewBase` in `.claude/a11y/a11y.config.json`. If the runner prints
   "Preview server is not running", ask the person to start it and retry. Do not
   attempt fixes first.
2. Know the two engines:
   - **IBM Equal Access** (primary): the only engine here with a WCAG 2.2
     target-size (SC 2.5.8) check.
   - **pa11y with axe** (second): a useful cross-check. Its axe runner has no
     `wcag22aa` tag, so it cannot check target size.

## The loop

For each page, one page at a time:

1. **Audit** with the runner:
   - one page: `node .claude/a11y/audit.mjs path/to/page.html`
   - all key pages: `node .claude/a11y/audit.mjs --all`

   The runner prints, per engine, **violations** and **potentials** as separate
   counts with rule ids, and the paths to the full reports.
2. **Read the full report** for the page you are fixing (under
   `.claude/a11y/reports/achecker/` and `.claude/a11y/reports/pa11y/`). Open the
   file with the Read tool. Do not paste it into chat.
3. **Fix, semantic HTML first.** Prefer native elements and attributes over ARIA:
   - missing label: add a real `<label for>`, not `aria-label`, where a visible
     label is possible;
   - icon-only control: give it a visible or visually hidden text name, and never
     rely on the `title` attribute;
   - low contrast: adjust the colour to reach 4.5:1 (3:1 for large text);
   - small target: enlarge to at least 24 by 24 CSS px, or add spacing;
   - missing `lang`, landmarks or headings: add the native markup.

   Change one file at a time.
4. **Re-audit only the affected page.** Confirm the violation is gone and no new
   one appeared.
5. **Repeat** until the page has zero violations. Potentials are a manual-review
   worklist: review each and either fix it or record why it is acceptable. They
   do not have to reach zero for the automated pass to count as clean.

## Token discipline

- Never paste full JSON reports into chat. Summarise: page, engine, violation
  count, potential count and the rule ids that matter.
- Open report files only when you are about to fix something.

## Quick and thorough modes

The static engines read the DOM and CSS. They do not check what a screen reader
voices. Several on-demand layers cover that, and **none of them is part of this
loop or of the edit hook**:

| Layer | Command | Covers | Does not cover |
| --- | --- | --- | --- |
| Virtual screen reader | `/a11y-sr <page>` | Accessible name, role, reading order (a simulation) | Real speech, live-region timing |
| Label in Name | `/a11y-label-in-name <page>` | SC 2.5.3: does each name contain its visible label | Whether a name is good |
| Behaviour test | `/a11y-behaviour` | Form behaviour over time (submit blocking, focus, live error clearing) | Screen-reader output, usability |
| Real NVDA (Windows only) | `/a11y-nvda <page>` | Focus-driven announcements from a real NVDA build | Live-region speech; it runs a pinned 2021 build |

### Quick (default)

A general request ("is this page accessible?", "make this accessible", "check the
contrast") runs the static loop only. No browser, no screen reader.

When the loop reaches zero violations, check what the fixes touched. If they
changed structure, landmarks, ARIA, a custom widget or focus management, the
static engines cannot tell whether the result is voiced correctly, so **offer**
`/a11y-sr <page>` in the same message as the clean result and say briefly why.
Wait for the person to accept. Do not run it unprompted. For cosmetic fixes
(contrast, target size, a `lang` attribute) do not offer; it would be noise.

### Thorough (explicit full review)

Only when the person asks for a thorough or full review, or says "including a
screen-reader pass":

1. Run the static loop to completion first.
2. Then, once, run the virtual reader on the now-clean page:
   `node .claude/a11y/sr/sr-audit.mjs <page>`. Report anything voiced without an
   accessible name, heading reachability and reading order.
3. End with the manual-checks gap, as always.

The screen-reader pass runs once, after the loop completes. Never run it on an
intermediate, half-fixed page.

**If the screen-reader stack is not installed** (no `package.json` in the folder
named by `A11Y_SR_HOME`, or the per-user default in `.claude/a11y/sr/SETUP.md`),
do not fail. Finish the static loop, then report that the screen-reader step was
skipped because the stack is not installed here.

Real NVDA (`/a11y-nvda`) is never run by this skill. It takes over the person's
screen reader and desktop, so it needs an explicit request and a quiet desktop.

A request that mentions both the general audit and the screen reader is
thorough. A request only about what is voiced is standalone: run the virtual
reader alone.

See [references/screen-reader-testing.md](references/screen-reader-testing.md)
for when a screen-reader layer is warranted and how to frame its result.

## Honesty rule: automated is not conformant

A clean automated run finds only a fraction of WCAG 2.2 AA issues. **A
zero-violation audit is not a statement of conformance.** Always end an audit by
listing what still needs manual checking, drawn from
[references/manual-checks.md](references/manual-checks.md).

State plainly which findings you fixed, which potentials you reviewed and what a
human still has to test.
