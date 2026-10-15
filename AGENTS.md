# AGENTS.md

<!-- From the Claude Code accessibility starter kit, snapshot of 8 October 2026.
     Shared as it is, with no warranty. Change it to suit your project. -->

These are the ground rules for any AI coding agent working in this project. Claude
Code reads this file through `CLAUDE.md`. Other agents can read it directly.

## About this project

<!-- Fill this in. Agents follow instructions literally, so be specific. -->

- **What the project is:** University of Southampton AI resources for staff: an AI
  Prompt Library (`UoS_AI_Prompt_Library_130.html`) and an AI Tool Evaluation
  Framework (`UoS_AI_Tool_Evaluation_Framework.html`).
- **What it is built with:** Two standalone HTML pages with inline CSS and
  JavaScript, and Google Fonts (DM Serif Display, DM Sans). No build step and no
  framework.
- **How to preview it:** `npx http-server -p 8080 -c-1` from the project root, then
  open http://localhost:8080/UoS_AI_Prompt_Library_130.html
- **Things you must never do:** never install packages without asking; never add a
  build step or framework without asking; write in plain British English.

## Accessibility is required

Every page and component must meet WCAG 2.2 AA. Treat an accessibility problem as a
bug, not a nice-to-have.

### Build with plain HTML first

1. **Use the HTML element made for the job.** Use `<button>` for buttons, `<a href>`
   for links, `<label>` for form labels and real headings for headings. Add ARIA only
   when HTML cannot do what you need.
2. **Never change what an element is.** Do not put `role="tab"` on an `<h2>`. Wrap
   it instead.
3. **Everything you can click must work with a keyboard.** That means Tab to reach
   it, Enter or Space to use it, and Escape to close it.
4. **Never hide something that can take focus.** Do not use `aria-hidden="true"` or
   `role="presentation"` on anything focusable. Keyboard users would land on
   something screen readers cannot see.
5. **Give every control a name.** A button with only an icon needs words, either
   visible text or an `aria-label`.

### Names and labels

- **Do not use the `title` attribute** for information people need. Many screen
  readers ignore it, keyboard and touch users cannot reach it, and it vanishes when
  the mouse moves. The only exception is `<iframe>`, which needs one.
- **Make the name include the words on screen.** If a button shows "Find records",
  its accessible name must contain "Find records". People who use voice control say
  what they see.
- **Do not give several controls the same name.** Ten buttons all called "Download"
  cannot be told apart. Add what each one downloads.
- **Write alt text that says what an image is for,** not just what it looks like.
  Use `alt=""` for a decorative image.

### What people see

- **Text needs a contrast of at least 4.5 to 1** against its background. Large text,
  icons and the parts of charts people need to see need at least 3 to 1.
- **Keyboard focus must always be visible.** Before you write a new focus style,
  check what the element already does when focused. A new `box-shadow` replaces the
  old one rather than adding to it, so a custom style often makes focus *harder* to
  see.
- **Respect people's settings:** `prefers-reduced-motion` and `prefers-color-scheme`.
- **Do not use colour alone** to show meaning, for example red for an error.
  Add words or an icon.

### Announcing changes to screen-reader users

A *live region* is the part of a page that tells screen-reader users about changes,
such as "Saved". Most announcement bugs are found by a person listening, not by any
automated check, so follow these rules closely.

1. **Make one announcement for each event.** If a visible message (a toast) already
   announces something, do not announce it a second time.
2. **Never create a live region at the moment you write its message.** Screen readers
   often miss a region that appears milliseconds before it speaks. Write into a region
   that exists from the moment the page loads.
3. **Never put a live region on a button or other control.** Its state changes, such
   as becoming disabled, then get announced as well.
4. **Announce changes, not starting values.** A control that announces its own value
   when the page loads is noise.
5. **Default to silence.** If a function can announce, its default should be not to.
6. **To quieten a region without removing it, use `aria-live="off"`.**
7. **Check the region can be reached.** A hidden parent, a closed `<details>` or an
   open dialogue box can hide a region from screen readers even when the code looks
   right. Check the accessibility tree, not just the HTML.
8. **Messages written while a dialogue box closes can be lost.** Wait until the dialogue
   has closed and focus has moved before you announce.
9. **A missing announcement is worse than a doubled one.** When you remove a duplicate,
   make sure the event still announces once.

## How to work

### Say what you saw, separately from what you think

- Write down what you observed and what you inferred as separate things. "The test
  printed 0" is an observation. "So the page is fine" is an inference.
- Before you name a cause, name the test that would tell it apart from other causes.
- A correction is a claim too. Test it before you write it down.

### Prove a test can fail before you trust it

Many wrong results come from the agent's own quick test scripts, not from the page. A
broken script often reports "0 problems" instead of an error.

- Before you believe a number, show the check catching a problem you planted on
  purpose, then remove the plant.
- A result that is a "short list" can be as wrong as an empty one. Count what the
  check should have found.
- Never conclude "none found" from a command that limits its output, such as `head`.

### A clean result is not a pass

Automated engines find only the problems a machine can test. A page with no
violations still needs a person to check it with a keyboard, a screen reader and zoom.
Never describe a clean automated run as WCAG conformance.

### Keep shell commands simple

- Run one operation per command. Do not chain many steps with `&&`.
- Do not put several lines of text inside a shell command. Write the text to a file,
  then use the file.
- Never search every folder at once. Search one folder, or use the agent's own search
  tools.

### Spend nothing without asking

Never make a call that costs money, such as a paid AI service, without asking first and
saying what it will cost. Never print API keys, passwords or tokens.
