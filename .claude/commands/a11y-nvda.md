---
description: On-demand REAL-NVDA test (Guidepup pinned build, NVDA 2021.3.1) of a form's focus-driven announcements. Windows only. Takes over the screen reader and the desktop. Quiet desktop only. Never automatic.
allowed-tools: Bash(node:*), Read
---

Run the **on-demand** real-NVDA test.

The argument typed is: `$ARGUMENTS`

## What this is (say so in your summary)

- It drives a **real NVDA engine**: Guidepup's pinned **portable build, NVDA
  2021.3.1**, not whatever NVDA is installed on the machine. It reads the speech
  NVDA emits (no audio needed) and checks focus-driven announcements by verbatim
  capture: accessible name, role, native required, `aria-invalid` and the
  `aria-describedby` error on the focused field.
- It does **not** verify a polite `role="status"` live-region announcement. The
  pinned build did not surface one through capture in the original author's
  testing. Use `/a11y-behaviour` for the DOM side, and have a person listen on a
  current NVDA for the spoken side.
- The wording is 2021-era. It proves the engine announces something, not the
  exact words your users hear.
- **Windows only.** On macOS and Linux this layer does not exist.
- It launches a headed browser and forces it to the front. It is **not** safe to
  run while the person is working. Never run it headless, in CI or in the
  background, and never wire it into a hook.

## Before you launch

1. Ask the person to confirm the desktop is quiet.
2. Tell them to stop using the computer (no typing, no mouse, no window
   switching) until you report back. Any interaction can steal focus and corrupt
   the capture.
3. Wait for their confirmation. Do not launch without it.

## Gate and fallback (never error)

Real NVDA also needs the portable NVDA to be installed (see
`.claude/a11y/sr/SETUP.md`). The runner checks this itself; run it and react to
the exit code:

- Run: `node .claude/a11y/sr/nvda-prove.mjs $ARGUMENTS`
  (default page `a11y-fixtures/form-demo/after.html`; the assertions are specific
  to that form, so adapt them for your own page).
- **Exit 4**, or `FALLBACK: real NVDA not permitted here`: the capability is
  absent. Do not treat this as an error. Run the virtual reader instead
  (`node .claude/a11y/sr/sr-audit.mjs $ARGUMENTS`) and say so plainly.
- **Exit 0:** all announcement assertions passed.
- **Exit 1:** the foreground was held but an assertion failed. The script prints
  the exact spoken string per failure. Weigh a 2021-build phrasing difference
  against a page that genuinely did not announce. Do not call it a page bug
  without reading the captured string.
- **Exit 2:** the Win32 foreground helper is blocked (for example by a policy on
  PowerShell). An environment problem, not a page failure.
- **Exit 3:** the browser never held the foreground (a busy desktop). An
  environment problem. Retry on a quiet desktop.

An offline check of the speech-log parser needs no screen reader and no quiet
desktop: `node .claude/a11y/sr/nvda-speech-prove.mjs`.

## Report back

- The captured spoken phrases per step and pass or fail per assertion.
- Label everything "real NVDA engine (Guidepup pinned build, NVDA 2021.3.1)".

## Honesty rule (every time)

End by stating that this proved specific focus-driven announcements on a 2021
build, captured verbatim. It did not verify the live-region announcement, browse
versus focus mode, JAWS or VoiceOver, or usability in the round. A person should
still listen on a current NVDA once. A pass is not WCAG 2.2 AA conformance.
