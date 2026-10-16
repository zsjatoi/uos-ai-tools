# NVDA speech-log samples

These files test the kit's NVDA log reader, `.claude/a11y/sr/nvda-speech-log.mjs`. To
run the test, type `node .claude/a11y/sr/nvda-speech-prove.mjs`. It works offline and
does not need NVDA.

## Keep private things out of this folder

When NVDA records a log, it records **everything** it says on the computer. That
includes emails, chat messages, window titles and Claude Code's own conversation. A
full log is a record of someone's whole day. So **only lines that contain our own test
words may go in this folder.** Never paste a full log here.

## `real-io-capture-2026-08-09.log`

This file holds four things NVDA really said, copied word for word from a real log.
We recorded it with NVDA 2026.1 (build 2026.1.0.55743) and Chrome on 9 August 2026,
using `nvda.exe -l 12 -f <path>`. We kept only the lines containing words from our own
test page (`sierra6690`, `tango5028`, and the page's title and heading), and copied
nothing else.

To record a log like this, you need real NVDA. That means Windows, and it takes over
the screen reader, so only do it when the computer is free.

This file answers the question "does the log reader work on real NVDA output?" It
shows three things:

| What NVDA said | What it shows |
| --- | --- |
| the page loading, ending `'document', CancellableSpeech (still valid)` | a marker that NVDA adds only some of the time |
| `sierra6690 …` (143 characters) | a live-region message, recorded with nobody at the computer |
| `tango5028 …, 'button'` | NVDA naming a button, followed by the word "button", with **no** marker |

The last row matters. We first assumed the marker told us whether NVDA was naming
something or reading a live-region message. It does not, so the log reader does not
rely on it.

We interrupted both `sierra6690` and `tango5028` on purpose, about 150 milliseconds in.
Both appear in the log exactly as if NVDA had finished them. So the log cannot tell you
whether a message was cut short, and the kit does not try.

## `synthetic-shapes.log`

We wrote this file by hand, using made-up test words. It copies the exact format of a
real log, to test shapes that a real recording could not safely provide. It holds seven
things NVDA might say, one key press and two lines that are not speech:

- speech that contains commas, which the reader must not split
- a marker in the middle of a line, before a description
- text in double quotes, which is how NVDA writes text that contains an apostrophe
- a line break written as `\n`, and a message that runs over two lines
- one message 19,600 characters long, which is what reading a whole page looks like
- a key press, which the reader must keep separate from speech
- a line cut off part-way through, as happens when you read a log while NVDA is still
  writing it
- times that cross midnight

This file tests what a whole-page read *looks like*. It does not set the length at
which the reader decides a whole page was read. A real page read we measured was
425,677 characters. That limit needs to come from real recordings of both kinds of
result, not a guess.
