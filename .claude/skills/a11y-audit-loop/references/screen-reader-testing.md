# Screen-reader and behaviour testing: what each layer proves

The kit has several on-demand layers beside the static audit engines. Each answers a narrow question. None is automatic, and none is a statement of WCAG 2.2 AA conformance. A clean automated run is not conformance.

## When to use them

A broad "is this page accessible?" goes to the static audit (`/a11y-audit`) and does not start a screen reader. Use the layers below when the question is about what a screen reader would say, how a control behaves, or whether a message is announced. They are worth offering after changes to document structure, ARIA, custom widgets, dialogues, live regions or focus management. Do not run them on every edit.

## The layers

| Layer | Command | Proves | Does not prove |
| --- | --- | --- | --- |
| Virtual screen reader | `/a11y-sr <page>` | A simulated reader, driven through a real browser, voices each item with a role, accessible name and state, in reading order. Catches absent names, wrong roles and reading-order problems. | Real speech. Browse and focus modes, live-region timing and browser-reader quirks are not reproduced. An absent name is flagged; a wrong name is not. Content behind a mode switch, a lazy mount or `display: none` is not in the tree, so a clean run covers the page as loaded and nothing more. |
| Real NVDA | `/a11y-nvda <page>` | Windows only. Drives a pinned portable NVDA (2021.3.1, installed through Guidepup) and captures what the focused control is announced as: name, role, state and description. Falls back to the virtual reader where it is not permitted. | What your users hear. The pinned build is older than a current NVDA, so wording differs. It takes over the machine's screen reader and the foreground window, so it needs a quiet desktop. It never runs in the background, headless or in CI. It does not reliably capture polite live-region announcements. |
| Behaviour test | `/a11y-behaviour <page>` | Drives the page headless and asserts dynamic behaviour at the DOM level: empty-submit blocking, focus moving to the first invalid field, `aria-invalid` and `aria-describedby` ties, live clearing of errors, a status region populating. Needs no screen reader. | That a screen reader announced anything, or that the flow is usable. |
| Label in Name | `/a11y-label-in-name <page>` | Compares each control's accessible name with its visible label text (SC 2.5.3) and flags `aria-label` values that override visible text. Reaches controls inside hidden panels that other layers cannot see. | Whether the name is good, only whether it contains the visible words. |
| Human listen | `/a11y-listen` | What a person with a real screen reader heard, once, for one gesture. It is the only layer that measures speech. | Anything beyond that one reader, browser and setting. See [docs/listening-protocol.md](../../../../docs/listening-protocol.md). |

## Reading the results honestly

- **A passing run covers only what was asserted.** Names, roles and order for the virtual reader; DOM state for the behaviour test; text comparison for Label in Name.
- **An announcement reaching an exposed live region is not the same as speech.** Exposure in the accessibility tree is a ceiling on what can be spoken, not a count of utterances. A region can be exposed and still stay silent, and two writes to two regions can produce one utterance.
- **A silent result needs a second look before it is a finding.** Check that the reader was attached to the window, and that the region was not hidden by an ancestor. See the listening protocol.
- **Prefer the cheapest layer that can fail on your question.** Names and order are cheap. Behaviour is cheap. Speech needs a person.
- **Record the environment.** Reader and version, browser, and the settings that change what is spoken (see the protocol).
- **Every layer ends with a list of what still needs manual checking.** Keyboard operation, focus visibility, zoom and reflow, forced colours and real assistive-technology use are not settled by any of these.
