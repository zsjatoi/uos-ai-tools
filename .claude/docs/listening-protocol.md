# How to run a listening test with a real screen reader

**Snapshot taken on 8 October 2026.**

Only a person can tell you what a screen reader really said. In a listening test, a
person uses a screen reader, such as NVDA, on a real browser window. Claude Code gets
the page ready and reads back what it can.

To start one, type `/a11y-listen`. Claude Code then helps you choose between two ways
of working:

- Claude Code opens and controls a browser window for you
- Claude Code gives you a short piece of code to paste into your own browser

## When you need a listening test

You need one when you change something a screen reader says that the page does not
show on screen:

- a **live region**: the part of a page that announces changes, such as "Saved"
- a button that becomes **disabled** or enabled
- where **keyboard focus** lands after a dialogue box closes
- text written **only for screen readers**

You do not need one for text that is visible on screen. Claude Code can check that
directly in the page.

One test tells you what one person heard, with one screen reader, one browser and one
set of settings. It does not prove the page works for everyone.

## The rules

1. **One action and one question in each test.** Never ask the person to do a whole
   journey and also report on one control. Never ask them to remember two results. We
   once asked for both in one test, and the person could not answer either. If you
   need a second reading, run a second test.
2. **Make no sound until the person says GO.** The page can have focus while nobody is
   at the desk. If you play an announcement before the person is ready, you waste it,
   and the silence tells you nothing.
3. **Write down the screen reader's settings every time.** At least these:
   - **NVDA's "Automatic Say All on page load"** setting, found in Browse Mode settings.
     It is on unless someone turns it off. While it is on, NVDA can skip saying what
     kind of thing has focus. So a dialogue box can be announced correctly, but you
     never hear the word "dialogue".
   - **The reduced-motion setting.** Some timing problems only happen when animations
     are on. So a page can pass on a computer with reduced motion turned on, and be
     silent for everyone else. If the result depends on timing, test with the setting
     both on and off.
   - The screen reader and its version, the browser, and whether you used a START
     button (see rule 4).

   If you do not record the settings, nobody can make sense of the result later.
4. **Start the screen reader inside the page.** When the person switches from another
   window to the browser, the screen reader may read the whole page aloud, which
   drowns out the result. To stop this, Claude Code adds a START button to the page
   and puts focus on it. Pressing START begins the test. The screen reader is then
   already in the page, and what it says is about the test, not the window switch.
5. **Claude Code does the setting up. The person does the key action.** Claude Code
   can load test data, clear stored settings, open panels and open a dialogue box,
   because none of that depends on timing. But a click made by a script and a real
   key press can behave differently, and focus problems hide exactly there. So if the
   question is about focus, the person must make the key press.
6. **Claude Code stays quiet while the person works.** Anything Claude Code does to the
   page during the test could be mixed up with what the page did itself. Claude Code
   should not hide or shrink the browser window while the person is still working,
   because a hidden page can pause or delay its updates.

## What silence can mean

If the person hears nothing, there are several possible reasons. The result alone
cannot tell them apart.

- **The screen reader was not following the browser window.** Bringing a window to
  the front does not always make the screen reader follow it. A mouse click often does
  not move the screen reader; a key press usually does. Always ask "Did you hear the
  page at all?" as well as "Did you hear the message?" If the screen reader was not
  following the window, the test tells you nothing about the page.
- **The live region was hidden from the screen reader.** A hidden parent element, a
  closed panel or an open dialogue box can all hide a region from screen readers, even
  when the code looks fine. Check what the screen reader can reach (the
  accessibility tree), not just the page's code.
- **The live region was created at the same moment as its message.** Screen readers
  often miss a region that appears milliseconds before it speaks. Use a region that
  exists from the moment the page loads.
- **The message arrived just as focus moved.** A message that arrives within a few
  milliseconds of focus moving can be lost. That is a real fault if the page does it.
  It is not a fault in the page if Claude Code moved the focus.
- **The message appeared where nobody was looking or listening,** or other speech
  talked over it.

If the screen reader was following the window, the region was reachable and the person
was listening, silence is a real finding. Anything less than that is "not sure", and
the record should say so rather than guess.

A region the screen reader can reach *might* speak. It is not certain to. Two messages
can be spoken as one, and a reachable region can stay silent. So the code can tell you
the most a screen reader could say, and the listening test tells you what it did say.

## The steps

When Claude Code starts the action (for example, one announcement):

1. Claude Code gets the page ready, empties the live region and checks it is empty. It
   keeps its own messages short.
2. The person clears the screen reader's speech history, says GO, and takes their
   hands off the keyboard.
3. Claude Code brings the browser to the front, does the one action, and waits for the
   speech to finish.
4. Claude Code reads back what it can, then asks one question about what the person
   heard.

When the person presses the control:

1. The person switches to the browser **first**, then clears the speech history, then
   presses. If they clear the history first, the window switch is left alone in the
   history, where it looks like the page being read.
2. Claude Code says exactly what to press, once, then leaves the page alone.
3. The person comes back and says DONE. Claude Code reads back the result.

Give each test's message a label that is easy to spot, such as "Test A, seven eight
nine", so you can find it in the speech history at a glance.

## A test sheet you can copy

Fill this in, and check it against
[the test sheet checklist](../.claude/skills/a11y-audit-loop/references/listen-sheet-checklist.md)
before you hand it over. Keep it to about eight steps.

```
LISTENING TEST: <short name>

What this test is for (one plain sentence):
  <for example: "To find out whether you hear a message after you close the dialogue.">

Settings (Claude Code fills these in; do not ask the listener):
  Screen reader and version:         <for example: NVDA 2025.3>
  Automatic Say All on page load:    <on / off>
  Reduced motion:                    <on / off>
  Browser:                           <name and version>
  Started with a START button:       <yes / no>

Before you start:
  1. Paste this one line into the browser console. It prints READY, NOT READY (with a
     reason) or FAILED (with the error). If it prints nothing, that counts as a failure.
       <setup line>
  2. Clear your speech history. Then say GO.

The test:
  3. Where: <the control, using the words on screen>
     Press: <one key or one click>
  4. Copy the speech history text and paste it here.

If a count suddenly drops or a list empties at step 3, that is expected.

Your one answer:
  Did you hear "<expected sentence>" once, more than once, or not at all?
  Once  /  More than once  /  Not at all  /  I did not hear the page at all
```

The last answer matters. Without it, a screen reader that never followed the window
looks the same as a silent page.

After the test, Claude Code compares the answer with what it expected, and marks it
SAME or DIFFERENT. The expected answer stays off the sheet, so the listener never has
to judge their own answer.

## Limits

A listening test involves small numbers. One test is one reading, and you may have to
rest a decision on a single try. Record a "no" as carefully as a "yes". Record what you
heard, not what you think caused it, and test your explanation before you write it
down as fact. Do not assume a result holds for another screen reader, browser version
or computer until someone has listened there too.
