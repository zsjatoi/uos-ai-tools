# What automated audits cannot verify

A clean run from the IBM and pa11y engines means the page passed the rules a
machine can check. It is **not** WCAG 2.2 AA conformance. The criteria below
need a human; list the relevant ones at the end of every audit.

## WCAG 2.2 AA criteria automation cannot judge

- **2.4.11 Focus Not Obscured (Minimum)**: when an element receives keyboard
  focus, is it at least partly visible, and not hidden behind a sticky header,
  footer, cookie bar or overlay? Tab through and watch.
- **2.4.7 Focus Visible, and the quality of the indicator**: engines detect only
  its total absence, not whether it is perceivable. Neither engine checks
  focus-indicator contrast. Judge an outline or outset glow against the
  *surrounding* colour (at least 3:1, SC 1.4.11) and an inset ring against the
  element's own fill. Check forced-colors (Windows High Contrast) separately:
  `box-shadow` is dropped there, so a shadow-only indicator can vanish while an
  outline survives. `.claude/tools/css-cascade-audit.js` can report settled focus styles
  and indicator contrast, but not forced-colors, and its output is not a
  conformance result.
- **2.5.3 Label in Name**: does each control's accessible name contain the text a
  user can *see*? A voice-input user says the visible label. Neither pinned
  engine checks this. `/a11y-label-in-name <page>` automates the mechanical
  part. Two things stay human: whether a name is *good* (containment is a
  floor), and whether an `aria-label` that passes containment still hides
  visible description text from screen-reader users.
- **2.5.7 Dragging Movements**: for anything you drag (sliders, reordering), is
  there a single-pointer alternative?
- **3.2.6 Consistent Help**: if a help mechanism exists, does it appear in the
  same relative place on every page that has it?
- **3.3.7 Redundant Entry**: across a multi-step process, is the person asked to
  re-enter something they already provided?
- **3.3.8 Accessible Authentication (Minimum)**: can the person sign in without a
  cognitive function test (memorising, transcribing, puzzles)?

## Evergreen manual checks (every audit)

- **Focus order makes sense** (2.4.3, 2.1.2): tabbing follows a logical order,
  and nothing is skipped or trapped.
- **Alt text quality** (1.1.1): engines flag *missing* alt, never *wrong* alt.
  Decorative images should have `alt=""`.
- **Keyboard operation** (2.1.1): every control is reachable and operable with the
  keyboard alone, including custom widgets, menus and dialogs.
- **Screen-reader pass** (4.1.2, 4.1.3): names, roles, states and live-region
  announcements are correct and neither missing nor duplicated. What the layers
  cover:
  - *Virtual reader (`/a11y-sr`)*: name, role and reading order on the rendered
    page, and lenient on state. A clean run means those hold, nothing more.
  - *Real NVDA (`/a11y-nvda`, Windows only)*: focus-driven announcements on a
    pinned 2021 NVDA build, by verbatim capture. It proves the engine announces
    something, not the exact words your users hear.
  - *Behaviour test (`/a11y-behaviour`)*: the dynamic behaviour around those
    announcements at the DOM level.
  - *A human still has to verify* that a message is actually **spoken** on a
    current screen reader and is worth hearing, plus browse mode versus focus
    mode, and the page on JAWS and VoiceOver. Automation runs a 2021 build and
    hears nothing. `.claude/docs/listening-protocol.md` describes the human listen.
- **Too many announcements is a defect too.** Ask whether the page is quiet
  enough for a person to reach the content.
- **Meaningful sequence and relationships** (1.3.1, 1.3.2): reading order and
  programmatic relationships match the visual structure.
- **Link and button purpose** (2.4.4): the name explains where a link goes or
  what a button does, out of context. `/a11y-label-in-name` lists names shared
  by several controls; that list is evidence, not a verdict.
- **Colour is not the only cue** (1.4.1): engines only raise this as a potential.
- **Reflow, zoom and spacing** (1.4.10, 1.4.4, 1.4.12): content works at 200%
  zoom and 400% reflow, and survives user text-spacing overrides.
- **Motion and animation** (2.3.1, 2.2.2): `prefers-reduced-motion` is
  respected, and nothing auto-plays or flashes.

## How to report

End every audit with three short lists: **fixed** (violations resolved),
**reviewed** (potentials you judged, and the outcome), and **still needs a human**
(the criteria above that apply to this page). Never imply that a clean automated
run equals conformance. Every layer in this kit reads structure or the
accessibility tree; none of them hears anything.
