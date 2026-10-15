---
name: css-cascade-forensics
description: >-
  Determine which CSS rule actually wins for an element, and measure settled
  rendered styles in a browser without catching a mid-transition frame. Use
  whenever a question is "which rule is setting this?", "why isn't my focus
  style applying?", "is this override doing anything?", or any measurement of
  computed styles, focus indicators, or :focus-visible state via a browser
  tool. Covers the paste-in script tools/css-cascade-audit.js (auditCascade,
  verifyCascadeWinner, auditFocusIndicator), the transition-settling traps,
  and the CSSOM-walker gotchas. Do NOT trigger for ordinary CSS authoring where
  no measurement or cascade attribution is in question.
---

# CSS cascade forensics and rendered-state measurement

Two related problems: measuring what the browser actually renders, and attributing that value to the rule that produced it. Keep what you observed separate from what you inferred, and write both down.

## Getting the helpers onto the page

The helpers live in `tools/css-cascade-audit.js`. It is a plain script with no imports and no dependency on the page, so it works on any site.

- **In a browser console:** paste the whole file and press Enter.
- **Through a browser tool:** read the file, then run its contents with the tool's evaluate or script function. Some tools restrict script evaluation behind a flag; if the call is refused, check the tool's settings before concluding the page is at fault.

It defines `window.auditCascade`, `window.auditCascadeRoot`, `window.verifyCascadeWinner` and `window.auditFocusIndicator`. A reload discards them and any state they touched. Nothing on disk changes.

## Measuring rendered CSS state in a browser

Three traps, each of which wastes a capture round.

- **A single `getComputedStyle` right after focusing can return a mid-transition frame.** If the page applies a `transition` to `:hover` and `:focus-visible`, the first read after focus catches the animation part-way, and a focused control can report its unfocused background. Poll until two consecutive reads are identical.
- **It is worse when the page is not in the foreground.** A backgrounded tab can throttle animation frames, so polling for a second or more may still return pre-transition values. Bring the page to the front and print the settle-iteration count beside the result, so a frozen page shows up as a visible number rather than a quietly half-transitioned reading. `auditFocusIndicator` does both.
- **Assert `:focus-visible`; never assume it, in either direction.** Whether a programmatic `.focus()` matches depends on the last real user interaction, and the answer differs between browsers and between a real pointer click and a synthetic one. Press Tab if you need keyboard modality, then check `el.matches(':focus-visible')` and stop if it is false. `auditFocusIndicator` refuses to report styles otherwise.

## Cascade forensics

Several rules can fight over one element's focus style, so "which rule wins?" is rarely answerable by reading one file. Identical selectors across a base sheet, a theme sheet and a component override have identical specificity, so document order decides.

Use the tools in this order:

1. `auditCascade(selector, ":focus-visible")` lists every matching rule, ranked by `!important`, then specificity, then document order, with its source file, whether it is active for the current media, and the computed value alongside.
2. `verifyCascadeWinner(selector, property, ":focus-visible")` is the discriminating test. It removes the predicted winning declaration, re-measures, and restores. A computed value alone cannot tell you which of two rules declaring the same value won; this can. A result of "not confirmed" means another rule declares the same value or your prediction was wrong, and the verdict says so.
3. `auditFocusIndicator(selector)` reports settled focus styles and indicator contrast, once the element is keyboard-focused.

Notes that save time:

- **Enumerate through the CSSOM, not by searching files.** It reports what the browser parsed and matched, including which sheets are inactive by media. Sheets for light and dark schemes can both expose readable rules even when one does not apply, so a naive walk mixes the two themes.
- **Gotcha for any hand-rolled walker:** since CSS nesting shipped, a style rule also exposes a `cssRules` list, usually empty. Testing `if (rule.cssRules)` to detect an `@media` group therefore matches every style rule and skips the whole document. Test for a string `selectorText` first.
- **Query longhands.** Browsers expand `outline` and similar shorthands into longhands in `rule.style`, so ask for `outline-style`, not `outline`.
- **Cross-origin stylesheets cannot be read.** The script warns and skips them. Rules from a CDN-hosted sheet are therefore invisible to the model, and a missing winner may just be an unreadable sheet.
- **Check in a second browser when the result matters.** The cascade model should be engine-independent, so a disagreement between browsers is a bug in something, not a quirk to explain away. Some browser tools cannot press keys, in which case keyboard-driven focus measurement is only possible in the other browser; `auditCascade` is unaffected because it takes the pseudo-class as an assumption and reports whether the element matches it.

## Limits

`auditCascade` is a model. Specificity is approximate (no `:is()` or `:where()` weighting), nested `&` selectors are skipped, and shorthand versus longhand precedence is shown but not resolved. Anything marginal goes through `verifyCascadeWinner`. Focus-indicator contrast is a judgement about which colours are adjacent, and `box-shadow` is dropped under forced colours, which this does not test. A clean result here is evidence about one element in one state, not WCAG conformance.
