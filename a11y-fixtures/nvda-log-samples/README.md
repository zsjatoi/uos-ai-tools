# NVDA speech-log fixtures

Inputs for `node .claude/a11y/sr/nvda-speech-prove.mjs`, which proves the parser in
[`.claude/a11y/sr/nvda-speech-log.mjs`](../../.claude/a11y/sr/nvda-speech-log.mjs).

**Privacy rule for this folder: only lines containing our own probe strings may be committed.**
At Input/output level NVDA logs everything spoken machine-wide — mail, chat, window titles, the
agent's own transcript — so an unfiltered capture is a record of somebody's screen-reader day. Never
paste raw log content in here.

## `real-io-capture-2026-08-09.log`

Four utterances, **verbatim** from a real capture. Provenance: **NVDA 2026.1**
(2026.1.0.55743), Chrome in a headed Playwright window, 9 August 2026, `nvda.exe -l 12 -f <path>`.
(Capturing a log like this needs real NVDA: Windows-only, and it takes over the screen reader,
so run it only on a quiet desktop. The parser proof itself runs offline anywhere Node runs.)
Extracted by filtering the capture to lines carrying strings from our own probe page
(`sierra6690`, `tango5028`, the page title and heading) — nothing else was copied.

This is the fixture that answers "does the parser work on genuine NVDA output", and it is what you
can re-check against each machine's own NVDA. It carries three measured facts:

| Utterance | What it pins down |
| --- | --- |
| page load, `'…', 'document', CancellableSpeech (still valid)` | a marker IS present sometimes — the positive canary for marker detection |
| `sierra6690 …` (143 chars) | a polite live-region write, captured with no human in the loop |
| `tango5028 …, 'button'` | an **object** announcement with a role token and **no marker** |

That last row is the measured refutation of an early assumption —
that the marker distinguishes object announcements from live-region writes. It does not. `parts[]`
is the reliable surface; the name/role split is a labelled heuristic that no analyser may depend on.

Both `sierra6690` and `tango5028` were **deliberately interrupted** ~150 ms in, and both logged
identically to speech delivered in full. That is why interruption detection was not built.

## `synthetic-shapes.log`

Hand-built, not captured — shapes the real capture cannot legally supply, written in the exact
observed format with invented probe strings. Seven utterances, one gesture, two non-speech records:

- spoken text containing commas (the tokeniser must not split on them);
- a `CancellableSpeech` marker **mid-list**, ahead of a description (measured shape, from a record
  that could not be committed because it was read from the user's own agent window);
- a double-quoted repr, which is what Python emits when the text contains an apostrophe;
- an escaped newline, and separately an utterance spanning two **physical** lines;
- a 19,600-character single utterance — the page-read shape;
- a keystroke line, which must stay out of the speech stream;
- a truncated tail with no closing quote or bracket, as produced by reading mid-write;
- timestamps crossing **midnight**, so the rollover rule is exercised.

The page-read *shape* is exercised here; the page-read **threshold** is not set from it. A real page
read measured 425,677 characters, and the detector's threshold must be calibrated from real captures
of both outcomes and ship with its provenance — a guessed number here would manufacture exactly the
kind of figure that reads as measured and is not.
