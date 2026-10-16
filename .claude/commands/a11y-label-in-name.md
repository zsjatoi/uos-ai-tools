---
description: On-demand SC 2.5.3 Label in Name check. Compares each control's accessible name with its VISIBLE label text and flags aria-label overrides that hide visible content. Never automatic.
allowed-tools: Bash(node:*), Read
---

Run the **on-demand** Label in Name check against a single page.

The argument typed is: `$ARGUMENTS`

## What this is (say so in your summary)

- It drives a real browser and compares, for every control, the **visible label
  text** with the **accessible name**. SC 2.5.3 asks that the visible text is
  contained in the name; extra text in the name is allowed.
- It fills a real gap: neither IBM Equal Access nor axe checks SC 2.5.3, and the
  virtual reader (`/a11y-sr`) flags only an *absent* name, never a *wrong* one.
- It reaches controls inside `display:none` panels. For rendered controls the
  name comes from the browser's accessibility tree (`source=ax`). For unrendered
  ones it is DOM-derived (`source=dom`) and therefore approximate. The runner
  prints the source per finding; read that before trusting an unrendered row.
- It is not a name or role audit, and a clean run is not WCAG 2.2 AA conformance.
- On-demand only; not part of the edit hook.

## Run it

- If the argument is empty, ask which page. Do not guess.
- Otherwise run: `node .claude/a11y/sr/label-in-name-audit.mjs $ARGUMENTS`
  (add `--all-rows` to list passing controls too).
- To gate on ambiguous names, add `--max-co-rendered=0`. Gate the **co-rendered**
  count, never the total: the same name legitimately appears in panels that are
  never shown together.
- To prove the checker still discriminates, run the fixture proof:
  `node .claude/a11y/sr/label-in-name-prove.mjs`

## Report back

Keep the levels separate:

- **FAIL (SC 2.5.3):** no visible label text is contained in the accessible name.
  A voice-input user cannot activate the control by saying what they see. The fix
  is usually to make the name start from the visible text: use `aria-labelledby`
  pointing at the visible title, or delete the `aria-label` and let the real
  `<label>` name the control. Put extra explanation in `aria-describedby`.
- **REVIEW (name override):** containment passes, but an `aria-label` suppresses
  other visible content. A judgement call, not a failure.
- **REVIEW (ambiguous names):** several controls share one accessible name. This
  is link and button purpose (2.4.6, 2.4.4), not 2.5.3. Read the "rendered now"
  count first: only groups rendered together are likely real. The fix is to name
  the object, not the verb. Do not bulk-fix: a `Cancel` in each of several
  dialogs that never coexist is fine.
- **Out of scope:** icon-only controls and symbol labels such as `×` produce no
  row. `aria-label="Close"` on a `×` is correct.

The check is deliberately lenient: a control passes if any plausible visible label
block is contained in its name, so a name that matches only part of a compound
label can pass.

## Honesty rule (every time)

End by stating that this checked SC 2.5.3 containment only. It says nothing about
whether names are good, whether roles and states are right, or whether the page is
usable. Point at `.claude/skills/a11y-audit-loop/references/manual-checks.md`.
If the preview server or toolchain is missing, say so and stop.
