#!/usr/bin/env node
/**
 * Fixture proof for nvda-speech-log.mjs.
 *
 * WHY THIS EXISTS
 * ----------------
 * A log parser produces no symptom of its own when it is wrong. One that
 * returns nothing looks exactly like "the page was silent" — and detecting
 * silence is the whole point of the layer, so a broken parser would report the
 * defect it exists to find, on every page, for ever. This proof feeds the REAL
 * exported functions (imported, never re-implemented) known inputs with known
 * expected dispositions in BOTH directions.
 *
 * INVERT PER PREDICATE, NOT PER TOOL. The
 * parser names several constructs — headers, speech vs gesture vs other, repr
 * items, quoting styles, escapes, midnight rollover — and each gets its own
 * positive and negative rows. A proof that only showed "it parsed a real log"
 * would pass while any one predicate was blind, which is exactly how the
 * announce checker stayed blind to role="log" and aria-live="off" for its
 * whole life.
 *
 * POSITIVE CANARIES. Several rows expect non-zero counts (4 real utterances,
 * 7 synthetic ones, a 19,600-character page-read shape), so an always-empty
 * parse cannot read as a pass.
 *
 * Run:  node .claude/a11y/sr/nvda-speech-prove.mjs
 * Exit: 0 when every row matches its expected disposition.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANNOUNCE_VERDICTS,
  assertOnce,
  assignDates,
  classifyPart,
  detectPageRead,
  findNearDuplicates,
  heuristicNameAndRole,
  measureLatency,
  parseHeader,
  parseNvdaLog,
  RECORD_KINDS,
  similarity,
  splitReprParts,
  unescapePythonString,
} from "./nvda-speech-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "a11y-fixtures", "nvda-log-samples");
const REAL_FIXTURE = join(FIXTURE_DIR, "real-io-capture-2026-08-09.log");
const SYNTHETIC_FIXTURE = join(FIXTURE_DIR, "synthetic-shapes.log");

/** Fixed base date so rollover rows are deterministic (no Date.now). */
const BASE_DATE = new Date(2026, 7, 9); // 9 August 2026, the capture's own day

let pass = 0;
let fail = 0;
const groups = [];

function group(title) {
  groups.push({ title, rows: [] });
}
function check(expected, actual, what) {
  const ok = Object.is(expected, actual);
  ok ? pass++ : fail++;
  groups[groups.length - 1].rows.push(
    `${ok ? "  ok  " : " FAIL "} exp=${String(expected).padEnd(9)} got=${String(actual).padEnd(9)} ${what}`,
  );
}

// ---------------------------------------------------------------------------
// 1. Header recognition — DENY/ALLOW on the single most load-bearing predicate.
//    Every utterance boundary depends on it: a pattern loose enough to match a
//    payload line would silently truncate every multi-line utterance, and one
//    too tight would swallow the whole file into a single record.
// ---------------------------------------------------------------------------
group("1. parseHeader — is this line a log header?");

const HEADER_CASES = [
  ["IO - speech.speech.speak (20:25:42.057) - MainThread (27836):", "HEADER", "real IO speech header"],
  ["INFO - __main__ (20:18:51.986) - MainThread (2232):", "HEADER", "INFO startup header"],
  [
    "DEBUGWARNING - characterProcessing._getSpeechSymbolsForLocale (20:22:59.628) - MainThread (27836):",
    "HEADER",
    "DEBUGWARNING header (compound level name)",
  ],
  [
    "IO - inputCore.InputManager.executeGesture (19:46:08.339) - winInputHook (30728):",
    "HEADER",
    "gesture header, non-MainThread",
  ],
  [
    "Speaking [LangChangeCommand ('en_US'), 'probe alpha']",
    "NOT-HEADER",
    "a payload line must NOT match — if it did, every utterance would be cut off at its own text",
  ],
  [
    "IO - speech.speech.speak (20:25:42) - MainThread (27836):",
    "NOT-HEADER",
    "missing milliseconds — the ms field is pinned to exactly three digits",
  ],
  [
    "IO - speech.speech.speak (20:25:42.057) - MainThread (27836)",
    "NOT-HEADER",
    "missing trailing colon",
  ],
  [
    "the meeting starts at 09:30:00.000 tomorrow (20:25:42.057) - MainThread (1):",
    "NOT-HEADER",
    "spoken prose containing a timestamp must not be mistaken for a header",
  ],
  ["", "NOT-HEADER", "empty line"],
  ["falling back to en", "NOT-HEADER", "a plain body line"],
];

for (const [line, expected, why] of HEADER_CASES) {
  check(expected, parseHeader(line) ? "HEADER" : "NOT-HEADER", why);
}

// Field extraction, not just recognition: a header that matches but reports the
// wrong time would corrupt every window filter downstream.
const sampleHeader = parseHeader("IO - speech.speech.speak (20:25:42.057) - MainThread (27836):");
check("IO", sampleHeader.level, "level parsed");
check("speech.speech.speak", sampleHeader.module, "module parsed");
check("20:25:42.057", sampleHeader.time, "time parsed");
check(27836, sampleHeader.pid, "pid parsed as a number");
check("MainThread", sampleHeader.thread, "thread parsed");

// ---------------------------------------------------------------------------
// 2. Record classification — a keystroke must never reach the speech stream.
// ---------------------------------------------------------------------------
group("2. record classification — SPEECH / GESTURE / OTHER");

function classifyOne(logText) {
  const parsed = parseNvdaLog(logText, { baseDate: BASE_DATE });
  return parsed.records.length ? parsed.records[0].kind : "no-record";
}

const CLASSIFY_CASES = [
  [
    "IO - speech.speech.speak (10:00:00.000) - MainThread (1):\nSpeaking [LangChangeCommand ('en_US'), 'probe']",
    RECORD_KINDS.SPEECH,
    "an utterance is speech",
  ],
  [
    "IO - inputCore.InputManager.executeGesture (10:00:00.000) - winInputHook (1):\nInput: kb(desktop):windows+m",
    RECORD_KINDS.GESTURE,
    "a keystroke is a GESTURE and is never folded into the speech stream",
  ],
  [
    "INFO - __main__ (10:00:00.000) - MainThread (1):\nStarting NVDA version 2026.1 AMD64",
    RECORD_KINDS.OTHER,
    "INFO startup chatter is other",
  ],
  [
    "DEBUGWARNING - characterProcessing.x (10:00:00.000) - MainThread (1):\nNo symbol information",
    RECORD_KINDS.OTHER,
    "DEBUGWARNING is other",
  ],
  [
    "IO - speech.speech.speak (10:00:00.000) - MainThread (1):\nCancelling speech",
    RECORD_KINDS.OTHER,
    "a speech-module record whose body is not an utterance is NOT counted as speech",
  ],
];

for (const [text, expected, why] of CLASSIFY_CASES) {
  check(expected, classifyOne(text), why);
}

// ---------------------------------------------------------------------------
// 3. splitReprParts — the tokeniser. Splitting on ", " would break on the
//    commonest possible input: spoken text containing a comma.
// ---------------------------------------------------------------------------
group("3. splitReprParts — top-level item count");

const SPLIT_CASES = [
  ["LangChangeCommand ('en_US'), 'probe alpha'", 2, "baseline: command plus one string"],
  [
    "LangChangeCommand ('en_US'), 'probe alpha, with a comma, and more'",
    2,
    "commas INSIDE a quoted string must not split it",
  ],
  [
    "LangChangeCommand ('en_US'), \"probe charlie's apostrophe\"",
    2,
    "double-quoted repr (Python's choice when the text contains an apostrophe) — quote-style must not be assumed",
  ],
  [
    "LangChangeCommand ('en_US'), 'probe bravo input', 'edit', CancellableSpeech (still valid), 'probe bravo description'",
    5,
    "marker MID-LIST: measured 9 Aug 2026, the marker is not positionally fixed",
  ],
  ["'probe with \\' an escaped quote'", 1, "a backslash-escaped quote does not end the string"],
  [
    "BeepCommand (440, 50), 'probe india'",
    2,
    "a comma INSIDE a command's parentheses must not split — the depth counter, which quote-tracking alone does not cover (found untested by inverting the tokeniser, 9 Aug 2026)",
  ],
  [
    "PitchCommand (offset=10, multiplier=2), 'probe juliet', EndUtteranceCommand()",
    3,
    "two commas at depth 0 split; the one inside parentheses does not",
  ],
  ["", 0, "empty payload yields no parts"],
];

for (const [payload, expected, why] of SPLIT_CASES) {
  check(expected, splitReprParts(payload).length, why);
}

// ---------------------------------------------------------------------------
// 4. classifyPart — text vs command, and the truncation recovery.
// ---------------------------------------------------------------------------
group("4. classifyPart — text vs command");

const PART_CASES = [
  ["'probe alpha'", "text", "single-quoted is spoken text"],
  ['"probe alpha"', "text", "double-quoted is spoken text"],
  ["CancellableSpeech (still valid)", "command", "a cancellable marker is a command, not speech"],
  ["CancellableSpeech (cancelled)", "command", "the cancelled spelling exists in NVDA's own repr — also a command"],
  ["LangChangeCommand ('en_US')", "command", "a language change is a command, not speech"],
  ["EndUtteranceCommand()", "command", "an utterance-end command is not speech"],
  [
    "'probe hotel truncated tail",
    "text",
    "an UNTERMINATED quote is recovered as text — dropping it would read downstream as SILENCE, the worst outcome",
  ],
];

for (const [part, expected, why] of PART_CASES) {
  check(expected, classifyPart(part).kind, why);
}
check(true, classifyPart("'probe hotel").unterminated === true, "truncated part is flagged unterminated");
check(undefined, classifyPart("'probe alpha'").unterminated, "a complete string is NOT flagged unterminated");

// ---------------------------------------------------------------------------
// 5. unescapePythonString — NVDA logs a repr(), so escapes are the norm.
// ---------------------------------------------------------------------------
group("5. unescapePythonString");

check("one\ntwo", unescapePythonString("one\\ntwo"), "\\n becomes a real newline");
check("a\tb", unescapePythonString("a\\tb"), "\\t becomes a tab");
check("back\\slash", unescapePythonString("back\\\\slash"), "\\\\ becomes one backslash");
check("it's", unescapePythonString("it\\'s"), "escaped apostrophe");
check('say "hi"', unescapePythonString('say \\"hi\\"'), "escaped double quote");
check("A", unescapePythonString("\\x41"), "\\xNN hex escape");
check("A", unescapePythonString("\\u0041"), "\\uNNNN unicode escape");
check("plain text", unescapePythonString("plain text"), "text with no escapes is unchanged");

// ---------------------------------------------------------------------------
// 6. assignDates — NVDA's timestamps carry no date. Without rollover handling
//    the layer breaks once a year, at midnight, undiagnosably.
// ---------------------------------------------------------------------------
group("6. assignDates — midnight rollover");

const rollover = assignDates(
  [
    { hh: 23, mm: 59, ss: 58, ms: 100 },
    { hh: 0, mm: 0, ss: 1, ms: 0 },
    { hh: 0, mm: 0, ss: 2, ms: 0 },
  ],
  BASE_DATE,
);
check(9, rollover[0].at.getDate(), "before midnight stays on the base day");
check(10, rollover[1].at.getDate(), "a time going backwards rolls the day forward");
check(10, rollover[2].at.getDate(), "the day does NOT roll again on the next increasing time");

const noRollover = assignDates(
  [
    { hh: 10, mm: 0, ss: 0, ms: 0 },
    { hh: 11, mm: 0, ss: 0, ms: 0 },
  ],
  BASE_DATE,
);
check(9, noRollover[1].at.getDate(), "an increasing time must NOT roll the day (inverts the rule)");

// ---------------------------------------------------------------------------
// 7. Malformed input must not throw. A capture read mid-write is the normal
//    case, not the exceptional one.
// ---------------------------------------------------------------------------
group("7. malformed input never throws");

const MALFORMED_CASES = [
  ["", "empty file"],
  ["Speaking [LangChangeCommand ('en_US'), 'orphan body with no header']", "body with no header"],
  ["IO - speech.speech.speak (10:00:00.000) - MainThread (1):", "header with no body"],
  ["IO - speech.speech.speak (10:00:00.000) - MainThread (1):\nSpeaking [", "opening bracket only"],
  ["  binary noise ÿ", "binary noise"],
];

for (const [text, why] of MALFORMED_CASES) {
  let outcome;
  try {
    parseNvdaLog(text, { baseDate: BASE_DATE });
    outcome = "ok";
  } catch (error) {
    outcome = `threw:${error.message}`;
  }
  check("ok", outcome, why);
}

const orphan = parseNvdaLog("a stray line\nanother stray line", { baseDate: BASE_DATE });
check(2, orphan.orphanBodyLines, "lines before the first header are COUNTED, not silently dropped");
check(0, orphan.speech.length, "and they produce no phantom utterances");

// ---------------------------------------------------------------------------
// 8. The real capture — proof against genuine NVDA 2026.1 output, and the
//    positive canary for the whole tool.
// ---------------------------------------------------------------------------
group("8. real capture fixture (NVDA 2026.1, 9 Aug 2026)");

const realParsed = parseNvdaLog(readFileSync(REAL_FIXTURE, "utf8"), { baseDate: BASE_DATE });
check(4, realParsed.speech.length, "POSITIVE CANARY: four real utterances parse (an empty parse cannot pass)");
check(0, realParsed.gestures.length, "no keystrokes in this fixture");
check(0, realParsed.orphanBodyLines, "every line belongs to a record");

const [pageLoad, heading, liveRegion, objectAnnouncement] = realParsed.speech;
check("nvda cancellation spike document", pageLoad.text, "page-load utterance text");
check(143, liveRegion.charCount, "live-region utterance character count");
check(true, liveRegion.text.startsWith("sierra6690"), "live-region utterance carries its probe tag");
check(true, objectAnnouncement.text.startsWith("tango5028"), "object announcement carries its probe tag");
check("20:25:42.057", liveRegion.time, "millisecond timestamp preserved");
check(34, heading.charCount, "heading utterance character count");

// The measured refutation, encoded as rows. An early write-up
// claimed an object announcement carries a role token AND a cancellation
// marker, and a live-region write carries neither. Measured 9 August 2026:
// the marker is present on some announcements and absent from others,
// including a genuine object announcement. It cannot discriminate the two.
check(1, pageLoad.cancellableMarkers.length, "POSITIVE: a marker IS detected when present");
check(0, liveRegion.cancellableMarkers.length, "a live-region write carries no marker");
check(
  0,
  objectAnnouncement.cancellableMarkers.length,
  "REFUTATION: an OBJECT announcement also carries no marker — the marker cannot tell the two apart",
);
check(
  true,
  objectAnnouncement.texts.includes("button"),
  "the role token is present even though the marker is not — parts[] is the reliable surface",
);

// The name/role split is offered only as a labelled heuristic.
check(true, heuristicNameAndRole(objectAnnouncement).heuristic, "heuristicNameAndRole declares itself a heuristic");
check("button", heuristicNameAndRole(objectAnnouncement).role, "heuristic reads role from the second text");

// ---------------------------------------------------------------------------
// 9. The synthetic fixture — shapes the real capture cannot legally supply.
// ---------------------------------------------------------------------------
group("9. synthetic shapes fixture");

const synth = parseNvdaLog(readFileSync(SYNTHETIC_FIXTURE, "utf8"), { baseDate: BASE_DATE });
check(7, synth.speech.length, "POSITIVE CANARY: seven utterances");
check(1, synth.gestures.length, "POSITIVE CANARY: one gesture — the keystroke stream is populated, not merely empty");
check(2, synth.other.length, "two non-speech records (INFO, DEBUGWARNING)");
check(0, synth.orphanBodyLines, "the two-line DEBUGWARNING body is attached to its header, not orphaned");
check("kb(desktop):control+alt+p", synth.gestures[0].gesture, "gesture payload extracted");

const [comma, midList, apostrophe, escapedNewline, giant, spansLines, truncated] = synth.speech;
check("probe alpha, with a comma, and more", comma.text, "commas inside spoken text survive tokenising");
check(5, midList.parts.length, "marker mid-list: five top-level parts (lang, name, role, marker, description)");
check(1, midList.cancellableMarkers.length, "marker mid-list is still detected");
check("probe bravo input edit probe bravo description", midList.text, "text skips the mid-list marker");
check("probe charlie's apostrophe", apostrophe.text, "double-quoted repr with an apostrophe");
check("probe delta line one\nprobe delta line two", escapedNewline.text, "escaped newline becomes a real newline");
check(19600, giant.charCount, "POSITIVE CANARY: the page-read shape parses as ONE utterance of 19,600 characters");
check(1, giant.texts.length, "the page-read shape is a single text item, not many");
check("probe foxtrot spans\ntwo physical lines", spansLines.text, "an utterance spanning two PHYSICAL lines is joined");
check(true, truncated.truncated, "the truncated tail is flagged");
check("probe hotel truncated tail", truncated.text, "and its text is still recovered — never a false silence");

// Rollover across the fixture's own midnight boundary.
check(9, comma.at.getDate(), "pre-midnight record dated to the base day");
check(10, escapedNewline.at.getDate(), "post-midnight record rolled to the next day");

// ---------------------------------------------------------------------------
// 10. Analysers. Each predicate is inverted: a seeded silence and a seeded
//     double must redden their OWN rows, and the page-read detector must
//     refuse to give a verdict it has not been calibrated for.
// ---------------------------------------------------------------------------
group("10. analysers");

/** Build a speech stream through the REAL parser, from [time, spoken] pairs. */
function makeStream(entries) {
  const text = entries
    .map(
      ([time, spoken]) =>
        `IO - speech.speech.speak (${time}) - MainThread (1):\nSpeaking [LangChangeCommand ('en_US'), '${spoken}']`,
    )
    .join("\n");
  return parseNvdaLog(text, { baseDate: BASE_DATE }).speech;
}
const at = (h, m, s, ms = 0) => new Date(2026, 7, 9, h, m, s, ms);

// --- assertOnce: three outcomes, three rows, never collapsed into "fail" ---
const onceStream = makeStream([["10:00:00.000", "probe papa work saved"]]);
check(ANNOUNCE_VERDICTS.ONCE, assertOnce(onceStream, "probe papa").verdict, "one utterance reads ONCE");
check(1, assertOnce(onceStream, "probe papa").count, "and counts one");

const doubleStream = makeStream([
  ["10:00:00.000", "probe papa work saved"],
  ["10:00:01.000", "probe papa work saved"],
]);
check(ANNOUNCE_VERDICTS.DOUBLED, assertOnce(doubleStream, "probe papa").verdict, "SEEDED DOUBLE reddens its own row");
check(2, assertOnce(doubleStream, "probe papa").count, "and counts two");

check(
  ANNOUNCE_VERDICTS.SILENT,
  assertOnce(onceStream, "probe quebec never spoken").verdict,
  "SEEDED SILENCE reddens its own row — never merged with DOUBLED",
);
check(0, assertOnce(onceStream, "probe quebec never spoken").count, "and counts zero");

// Case sensitivity is a real option, not an accident of the sample.
check(
  ANNOUNCE_VERDICTS.ONCE,
  assertOnce(onceStream, "PROBE PAPA").verdict,
  "matching is case-insensitive by default",
);
check(
  ANNOUNCE_VERDICTS.SILENT,
  assertOnce(onceStream, "PROBE PAPA", {}, { caseSensitive: true }).verdict,
  "and case-sensitive when asked (inverts the previous row)",
);

// --- the time window, which is the defence against agent-window contamination
const windowStream = makeStream([
  ["10:00:05.000", "probe romeo inside the window"],
  ["10:30:00.000", "probe romeo outside the window"],
]);
check(
  1,
  assertOnce(windowStream, "probe romeo", { from: at(10, 0, 0), to: at(10, 0, 10) }).count,
  "the window EXCLUDES an utterance outside it (2 matches exist; 1 is in range)",
);
check(2, assertOnce(windowStream, "probe romeo").count, "and without a window, both are counted (inverts the row above)");

// --- latency ---
const latencyStream = makeStream([["10:00:00.150", "probe sierra announcement"]]);
const latency = measureLatency(latencyStream, at(10, 0, 0, 0), "probe sierra");
check(true, latency.found, "latency: the utterance is found");
check(150, latency.latencyMs, "latency: 150 ms from fire to speak");
check(false, measureLatency(latencyStream, at(10, 0, 0, 0), "probe tango absent").found, "latency: absent pattern reports not-found, not zero");

// --- similarity and near-duplicate suspects ---
check(1, similarity("probe uniform same words", "probe uniform same words"), "similarity: identical is 1");
check(true, similarity("probe victor alpha bravo", "completely different words here") < 0.2, "similarity: unrelated is near 0");

const rewordedStream = makeStream([
  ["10:00:00.000", "probe whisky your changes were saved successfully"],
  ["10:00:00.500", "probe whisky changes were saved successfully now"],
]);
check(
  1,
  findNearDuplicates(rewordedStream).suspects.length,
  "POSITIVE: a REWORDED near-duplicate is surfaced — the case the announcement-channel audit cannot see",
);

check(
  0,
  findNearDuplicates(doubleStream).suspects.length,
  "an EXACT duplicate is NOT a near-duplicate suspect — that belongs to assertOnce",
);

const containsStream = makeStream([
  ["10:00:00.000", "probe xray saved"],
  ["10:00:00.500", "probe xray saved successfully"],
]);
check(0, findNearDuplicates(containsStream).suspects.length, "a CONTAINED duplicate is excluded — the announcement-channel audit already sees it");

const farApartStream = makeStream([
  ["10:00:00.000", "probe yankee your changes were saved successfully"],
  ["10:05:00.000", "probe yankee changes were saved successfully now"],
]);
check(0, findNearDuplicates(farApartStream).suspects.length, "a similar pair OUTSIDE the time window is not a suspect (inverts the positive row)");
check(false, findNearDuplicates(rewordedStream).gated, "near-duplicates are reported UNGATED, as a suspect list");

// --- page read: the detector must refuse a verdict it cannot justify ---
const pageReadStream = makeStream([
  ["10:00:00.000", "probe zulu one"],
  ["10:00:00.100", "probe zulu two"],
  ["10:00:00.200", "probe zulu three"],
  ["10:00:00.300", "probe zulu four"],
  ["10:00:00.400", "probe zulu five"],
]);
const uncalibrated = detectPageRead(pageReadStream);
check(null, uncalibrated.verdict, "THE LOAD-BEARING ROW: with no calibration there is NO verdict, only raw numbers");
check(false, uncalibrated.calibrated, "and it says so");
check(5, uncalibrated.utterances, "raw utterance count is still reported");
check(74, uncalibrated.totalChars, "raw character total is still reported");
check(425677, uncalibrated.provenance.realPageReadChars, "the measured reference point ships as provenance, not as a threshold");

check(
  "PAGE-READ",
  detectPageRead(pageReadStream, { thresholds: { maxUtterances: 3 } }).verdict,
  "a CALLER-SUPPLIED threshold yields a verdict",
);
check(
  "NO-PAGE-READ",
  detectPageRead(pageReadStream, { thresholds: { maxUtterances: 10 } }).verdict,
  "and the opposite threshold yields the opposite verdict (inverts the row above)",
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
for (const { title, rows } of groups) {
  console.log(`\n${title}`);
  console.log(rows.join("\n"));
}

const headerAllow = HEADER_CASES.filter(([, e]) => e === "HEADER").length;
console.log(
  `\n${pass} passed, ${fail} failed across ${groups.length} predicate groups.` +
    `\nHeader recognition alone carries ${headerAllow} HEADER and ${
      HEADER_CASES.length - headerAllow
    } NOT-HEADER rows, so neither an always-match nor a never-match pattern can pass.` +
    `\nPositive canaries: 4 real utterances, 7 synthetic, 1 gesture, 19,600 chars — an empty parse cannot read as clean.`,
);

process.exit(fail ? 1 : 0);
