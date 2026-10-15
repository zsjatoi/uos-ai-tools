# Listening protocol: a person with a screen reader, an agent driving the browser

Only a person can tell you whether a screen reader spoke. This is the method for a human listen: someone runs NVDA (or another screen reader) against a real browser window, while the agent prepares the page and reads back what it can. The entry point is `/a11y-listen`, which holds the choice between driving a browser window yourself and handing the person a snippet to paste into their own browser.

Use a listen only when something changes that a screen reader speaks and the page's visible text does not show: a live region, a disabled-button state, where focus lands after a dialogue closes, or text meant only for screen readers. Static visible text is checked in the DOM or the accessibility tree and does not need a sitting.

A clean listen is one person, one reader, one browser, one setting. It is not conformance and not a guarantee for other readers.

## The rules

1. **One gesture, one question per sitting.** Never ask the listener to perform a journey and also report on a control, or to hold two readings in mind. A sitting that asked for both came back with no answer at all. If you need a control reading as well, run it as its own sitting.
2. **Never make a sound before the person says GO.** A flag such as `document.hasFocus()` says the page has focus inside its browser. It does not say that a person is at the desk with a reader running. Firing on it wastes the announcement and produces a silence that means nothing.
3. **Record the screen reader's settings with every listen.** At minimum:
   - NVDA "Automatic Say All on page load" (Browse Mode settings). It is on by default, and while it is on, NVDA can suppress the role announcement of a focused object, so a dialogue can be announced correctly and still not say "dialogue".
   - The reduced-motion preference. A timing race can be invisible under `prefers-reduced-motion: reduce` and audible-or-silent without it, so a listen on a reduced-motion machine can pass while the same code is silent for everyone else. For anything whose correctness depends on timing, listen under both settings.
   - Reader and version, browser, and whether the sitting was anchored (rule 4).
   An unrecorded setting makes a listen impossible to interpret, not just incomplete.
4. **Anchor the reader in the page.** If the listener switches from another window to the browser, the reader re-orients and may read the whole document, swamping the result. Inject a START button into the page, focus it, and have it trigger the real control under test. The reader is then already in the page when the journey begins, and the transcript contains the gesture rather than the window switch.
5. **The agent sets up; the person performs the gesture under test.** Restoring a fixture, clearing stored state, opening disclosures and opening a dialogue can all be automated, because they are tedious and have no timing sensitivity. But a synthetic `click()` and a real key press can differ exactly where focus-timing bugs live. If the question is whether an announcement survives focus churn, the clicks that cause the churn must be the person's.
6. **Keep the agent quiet while the person works.** Any call into the page competes with the gesture under test, and a write the agent makes mid-journey cannot be told apart from one the product made. Do not minimise or occlude the window while the person is still working; a hidden document can suspend animation frames and delay writes.

## What a silent result can and cannot mean

Silence has several causes, and the transcript cannot tell them apart by itself.

- **The reader was not attached to the window.** Raising a window, or focusing an element programmatically, is not the same as the reader following it. Neither "the window is in the foreground" nor `document.hasFocus()` shows that. A mouse click often does not hand the reader over; a key press does. Ask the person whether they heard the page at all, not only whether they heard the announcement under test. An unattached run is inconclusive. It is not a result about the page.
- **The live region was not exposed.** An `aria-hidden` or `display: none` ancestor, a collapsed disclosure, or an open modal dialogue that makes everything outside it inert can all remove a region from the accessibility tree even though the element looks fine in the DOM. Check exposure in the accessibility tree, not the DOM.
- **The region was created just before it was written to.** A live region added milliseconds before its content is often not registered in time and does not speak. Announce through a region that existed at page load.
- **The write landed inside a focus change.** Writes that land within a few milliseconds of focus moving can be dropped. This is a real defect when it is the product's own behaviour, and an artefact when the agent caused the focus change.
- **The announcement was spoken somewhere nobody was listening, or was talked over.** A toast can render perfectly in a corner while the listener's attention and the reader's focus are elsewhere.

A silent result with the reader attached, the region exposed and the person at the desk is a finding. Anything less is inconclusive, and the sheet should say so rather than guess.

Exposure is a ceiling on utterances, not a count. Two exposed writes can be spoken as one, and an exposed region can stay silent. Predict "at most N" from exposure and let the listen settle the rest. Do not treat an identical-text write as certain to be spoken or certain to be ignored; the DOM cannot decide that.

## The sequence

For a listen where the agent starts the thing under test (for example, a single announcement):

1. The agent prepares the page, clears the live region and checks it is empty, and keeps its own message short. Long agent output just before a sitting is noise in the reader's history.
2. The person clears the reader's speech history, says GO, and takes their hands off.
3. The agent raises the browser window, runs the single action and waits long enough for speech to finish.
4. The agent reads back anything it can (the region text, a log), then asks one question about what the person experienced: was it usable, in the right order, where their attention was.

For a hand-over, where the person presses the control:

1. The person switches to the browser first, then clears the speech history, then presses. Clearing before switching leaves the window-switch burst alone in an otherwise empty history, where it looks like a page read.
2. The agent states exactly what to press, once, and then makes no calls into the page.
3. The person returns and says DONE. The agent reads back the result, then hands the window back.

Give each sitting's output a distinctive prefix, such as "Cell A, immediate, seven eight nine", so attribution in the history takes a glance. Distinct strings also avoid any duplicate suppression in the page's own announcer. Give the browser window a distinctive title if the person may have other windows of the same page open.

Read a live region back at about one second and again after any scheduled clear the page performs, because a read after the page has blanked its own region can look like a failed write.

## Listen-sheet template

Copy this, fill it in, and check it against [the listen-sheet checklist](../.claude/skills/a11y-audit-loop/references/listen-sheet-checklist.md) before handing it over. Keep it to about eight steps.

```
LISTEN SHEET: <short name>

What this sitting is for (one sentence, plain words):
  <e.g. "To find out whether you hear a message after you close the dialogue.">

Settings (the agent fills these in, do not ask the listener):
  Reader and version:                <e.g. NVDA 2025.3>
  Automatic Say All on page load:    <on / off>
  Reduced motion:                    <on / off>
  Browser:                           <name and version>
  Anchored with a START button:      <yes / no>

Before you start:
  1. Paste this one line into the browser console. It prints READY, NOT READY (with a
     reason) or FAILED (with the error). If it prints nothing, that counts as a failure.
       <setup line>
  2. Clear your speech history. Then say GO.

The sitting:
  3. Where: <the control, by the words on screen>
     Press: <one key or click>
  4. Copy the speech history text and paste it here.

If you hear a sudden drop in a count, or a list emptying, that is expected at step 3.

Your one answer:
  Did you hear "<expected sentence>" once, more than once, or not at all?
  Once  /  More than once  /  Not at all  /  I did not hear the page at all
```

The last option matters. Without it, a reader that was never attached to the window reads as a silent page.

After the sitting, the agent marks SAME or DIFFERENT against the expected result itself. Expected answers stay out of the sheet, and the listener is never asked to judge their own answer.

## Limits

A listen has small numbers. One sitting is one reading, and several claims will rest on a single trial. Record negative results with the same care as positive ones, record what was measured rather than the mechanism you suspect, and test the explanation before writing it into any document. Do not extend a finding to another reader, browser version or machine without listening there too.
