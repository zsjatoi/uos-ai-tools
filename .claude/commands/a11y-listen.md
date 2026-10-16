---
description: On-demand HUMAN listen. The agent prepares one gesture and one question; a person with a screen reader performs it and reports what was spoken. Never automatic.
allowed-tools: Read, Bash(node:*)
---

Prepare a human listen. A person with a real screen reader is the only
instrument here that measures what is actually *spoken*.

The argument typed is: `$ARGUMENTS` (the page, and ideally the one behaviour to
hear).

Read `.claude/docs/listening-protocol.md` first and follow it. In short:

1. **One gesture, one question per sitting.** Never ask for a journey and a control
   in the same sitting. If you have two questions, schedule two sittings.
2. **Record the settings** that change what is heard: the screen reader and its
   version, NVDA's "Automatic Say All on page load", and the reduced-motion
   setting.
3. **You set up; the person performs the gesture.** Open the page, open any
   disclosure or dialog, and put the page in the starting state. The person
   makes the key press or click under test.
4. **Anchor the reader in the page** with the START button technique so the
   transcript contains the gesture and not the window switch.
5. **Make no sound until the person says GO.**
6. Ask for the result as one paste (for example NVDA's Speech Viewer text) or one
   letter, using the sheet template at the end of the protocol.

You can run this with the person using their own browser: give them a console
snippet or a START button to paste, and ask for the Speech Viewer text back. A
paste-based listen has no automated capture, so say that in the write-up.

Report the result as what was heard, in the person's words, with the settings
beside it. A silent result is not automatically a page defect: the protocol lists
the other explanations to rule out first.
