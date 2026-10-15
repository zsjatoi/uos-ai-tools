# CLAUDE.md

@AGENTS.md

<!-- From the Claude Code accessibility starter kit, snapshot of 8 October 2026.
     Shared as it is, with no warranty. The line above imports AGENTS.md, which holds
     the accessibility rules. This file covers the kit's Claude Code tools. -->

## The accessibility starter kit

This project uses the Claude Code accessibility starter kit. Its tools live in
`.claude/`. The kit's README explains each one, with examples.

### Hooks: what they do and how to respond

Hooks run on their own. Do not try to avoid them.

- **Guards** run before a shell command or file read. They stop:
  - searches that walk every folder at once
  - reading a very large Markdown file in one go
  - commands that put several lines of text inside the shell

  When a guard stops you, use the alternative it suggests. Do not look for another
  way to run the same thing.
- **The edit-time check** runs after you change an HTML, CSS or JavaScript file. It
  checks the page with IBM Equal Access and axe (through pa11y).
  - **If it reports violations, fix them before you go on.** Fix with plain HTML first.
  - **Do not pause the check to get past it.** Only the person may pause it, with
    `/a11y-hook-off`.
  - **Silence does not always mean the page passed.** The check is also silent when
    the preview server is down, so look at `.claude/a11y/hook.log` if you are unsure.
- **The live-region check** runs after you change JavaScript. If it reports a new live
  region, write into a region that exists from page load instead. Add an allowlist
  entry only if the person agrees.
- **The harness-proof reminder** appears after you write a quick test script. Follow
  it: prove the script can fail before you trust its numbers.
- **The settings check** warns you if you break a settings file. A settings file with
  one mistake switches off every setting in it, so fix it at once.

### Which tool to use

| The person asks | Use |
| --- | --- |
| "Is this page accessible?" or "check this page" | the `a11y-audit-loop` skill (quick mode: the two engines, then fix, then check again) |
| A full or thorough review, or "including a screen-reader pass" | `a11y-audit-loop` in thorough mode: the engines first, then one simulated screen-reader pass |
| Just the engine results | `/a11y-audit <page>` |
| What a screen reader would find | `/a11y-sr <page>` (a simulation: names, roles, reading order) |
| Whether names match visible labels | `/a11y-label-in-name <page>` |
| How a form behaves, such as focus after an error | `/a11y-behaviour` |
| What a real screen reader says | `/a11y-listen` (a person listens), or `/a11y-nvda` on Windows |
| Which CSS rule styles something, or a focus outline's contrast | the `css-cascade-forensics` skill with `tools/css-cascade-audit.js` |
| Writing up accessibility findings | the `a11y-report` skill |
| Finding a section in a very long document | `/digest` |

Always end an accessibility check by listing what a person still has to test. The list
is in `.claude/skills/a11y-audit-loop/references/manual-checks.md`.

### Say what each check cannot prove

- The engines find only the problems a machine can test.
- The simulated screen reader is a simulation. It does not hear speech.
- `/a11y-nvda` uses a fixed 2021 version of NVDA, not the person's own.
- A listening test is one person, one screen reader and one set of settings.

None of these, alone or together, proves WCAG 2.2 AA conformance.

### Browsers

- Use hidden ("headless") browsers by default, so no window opens over the person's
  work.
- Open a visible window (`playwright-headed`) only when a person needs to see or hear
  the page, and tell them first.
- Use Chrome DevTools for dark mode, screen sizes and screenshots saved outside the
  project. Use Firefox DevTools to check a second browser.

### Screen readers and listening tests

- **Never start `/a11y-nvda` or NVDA speech logging on your own.** They take over the
  person's screen reader. Ask first, and wait until the person says the computer is
  free.
- Follow `docs/listening-protocol.md` for any listening test. Ask for one action and
  one question in each test. Make no sound until the person says GO. Record the
  screen reader's settings.
- A listening test is needed only when something a screen reader says changes and the
  page does not show it on screen: a live region, a disabled button, focus after a
  dialogue closes, or text only for screen readers.

### Before you change a guard or hook

Run its proof script afterwards. The commands are in the README's "Proof scripts"
section. After editing any settings file, check it still parses:

```
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"
```
