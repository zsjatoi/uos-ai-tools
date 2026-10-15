// nvda-speech-log.mjs — parse an NVDA log captured at Input/output level into
// a stream of utterances.
//
// WHY THIS EXISTS. Every other screen-reader layer in .claude/a11y/sr/ measures
// the accessibility TREE — whether a message reached an exposed region. None of
// them measures SPEECH. NVDA at logging level Input/output (-l 12) writes every
// utterance it sends to the synthesiser, with a millisecond timestamp, and a
// polite live-region announcement was captured verbatim this way with no human
// in the loop. Real NVDA capture is Windows-only and takes over the screen
// reader, so run it only on a quiet desktop (see nvda-log-control.mjs).
//
// This file is pure parsing: no NVDA, no browser, no filesystem side effects.
// It runs anywhere Node runs, which makes it easy to check against each
// machine's own NVDA log (a parser that silently returns nothing on an older log
// format is indistinguishable from "the page was silent" — the exact failure
// this layer exists to detect).
//
// FORMAT, measured on NVDA 2026.1:
//
//   IO - speech.speech.speak (20:25:42.057) - MainThread (27836):
//   Speaking [LangChangeCommand ('en_US'), 'sierra6690 one two three ']
//
// A header line carries level, module, HH:MM:SS.mmm, thread and pid; the body
// is everything up to the next header. Do NOT assume a one-line body — a page
// read is a single enormous utterance, and non-speech records (tracebacks,
// DEBUGWARNING detail) genuinely span lines.
//
// TWO MEASURED FACTS THAT CONTRADICT THE ORIGINAL WRITE-UP, and which is why
// parts[] is exposed verbatim and no analyser is allowed to depend on the
// name/role split (see heuristicNameAndRole below):
//
//   1. An object announcement does NOT always carry a CancellableSpeech
//      marker. Observed: ['Alpha', 'button'] with no marker at all.
//   2. When the marker IS present it is not positionally fixed — observed
//      mid-list, ahead of a description:
//      ['Message input', 'edit', CancellableSpeech (still valid), 'Queue…']
//
// Run:
//   node .claude/a11y/sr/nvda-speech-log.mjs <logPath> [--json] [--limit N]
// Exit: 0 when the file parsed; 1 when it could not be read.

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Logging (project house style: configurable, British spelling).
// ---------------------------------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.WARN;
const ENABLE_ALL_LOGGING = false;
const DISABLE_ALL_LOGGING = false;

function shouldLog(level) {
  if (DISABLE_ALL_LOGGING) return false;
  if (ENABLE_ALL_LOGGING) return true;
  return level <= DEFAULT_LOG_LEVEL;
}
function logError(message, ...args) {
  if (shouldLog(LOG_LEVELS.ERROR)) console.error(message, ...args);
}
function logWarn(message, ...args) {
  if (shouldLog(LOG_LEVELS.WARN)) console.warn(message, ...args);
}
function logInfo(message, ...args) {
  if (shouldLog(LOG_LEVELS.INFO)) console.log(message, ...args);
}
function logDebug(message, ...args) {
  if (shouldLog(LOG_LEVELS.DEBUG)) console.log(message, ...args);
}

// ---------------------------------------------------------------------------
// Constants — no magic strings.
// ---------------------------------------------------------------------------

/** Record kinds. A gesture is NEVER folded into the speech stream. */
export const RECORD_KINDS = Object.freeze({
  SPEECH: "speech",
  GESTURE: "gesture",
  OTHER: "other",
});

/** The module NVDA logs an utterance under, and the body's opening token. */
const SPEECH_MODULE_PREFIX = "speech.";
const SPEAKING_PREFIX = "Speaking [";
const GESTURE_MODULE = "inputCore.InputManager.executeGesture";
const GESTURE_BODY_PREFIX = "Input: ";

/** How much of an utterance the CLI prints before eliding. */
const CLI_TEXT_PREVIEW_CHARS = 120;

/**
 * A log header. Deliberately anchored and fully specified: the "read to the
 * next header" rule is only as good as this pattern, and a loose one would let
 * a line of spoken text terminate an utterance early.
 *
 * Groups: level, module, hh, mm, ss, ms, thread, pid.
 */
export const LOG_HEADER_RE =
  /^([A-Za-z]+) - (\S+) \((\d{2}):(\d{2}):(\d{2})\.(\d{3})\) - (\S+) \((\d+)\):\s*$/;

// ---------------------------------------------------------------------------
// Python repr helpers
// ---------------------------------------------------------------------------

/**
 * Undo Python's string escaping. NVDA logs the utterance as a repr(), so an
 * embedded newline arrives as a literal backslash-n rather than a real one —
 * which is why a giant page-read utterance can still occupy one physical line.
 */
export function unescapePythonString(source) {
  return source.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g,
    (match, escape) => {
      if (escape[0] === "x" && escape.length === 3) {
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      }
      if (escape[0] === "u" && escape.length === 5) {
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      }
      switch (escape) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "\\":
          return "\\";
        case "'":
          return "'";
        case '"':
          return '"';
        default:
          return escape;
      }
    },
  );
}

/**
 * Split the inside of `Speaking [...]` into its top-level items.
 *
 * Splitting on ", " would be wrong in the commonest possible case: spoken text
 * containing a comma. This walks the payload tracking quote state and bracket
 * depth instead, so "one, two, three" stays one item.
 *
 * Python's repr picks the quote character based on the content, so a string
 * containing an apostrophe arrives double-quoted. Both spellings are handled
 * deliberately, not by whichever happened to appear in the sample capture.
 */
export function splitReprParts(payload) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buffer = "";

  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];

    if (quote) {
      // A backslash escapes the next character, including the closing quote.
      if (ch === "\\" && i + 1 < payload.length) {
        buffer += ch + payload[i + 1];
        i += 1;
        continue;
      }
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      buffer += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      buffer += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += ch;
  }

  if (buffer.trim() !== "") parts.push(buffer.trim());
  return parts;
}

/**
 * Classify one top-level item as spoken text or as a speech command.
 * Anything quoted is text NVDA sent to the synthesiser; anything else is a
 * command object (LangChangeCommand, CancellableSpeech, EndUtteranceCommand…).
 */
export function classifyPart(part) {
  const opensWithQuote = part.startsWith("'") || part.startsWith('"');
  const isQuoted =
    part.length >= 2 &&
    ((part.startsWith("'") && part.endsWith("'")) ||
      (part.startsWith('"') && part.endsWith('"')));

  if (isQuoted) {
    return { kind: "text", value: unescapePythonString(part.slice(1, -1)) };
  }

  // An unterminated quote means the file was read mid-write. Recover the text
  // best-effort rather than dropping it: a dropped utterance reads downstream
  // as SILENCE, and a false silence is the worst outcome this layer can
  // produce (a silent event is a worse outcome than a doubled one). The record still carries truncated: true.
  if (opensWithQuote) {
    return {
      kind: "text",
      value: unescapePythonString(part.slice(1)),
      unterminated: true,
    };
  }

  return { kind: "command", value: part };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a single header line, or return null if it is not one. */
export function parseHeader(line) {
  const m = LOG_HEADER_RE.exec(line);
  if (!m) return null;
  return {
    level: m[1],
    module: m[2],
    hh: Number(m[3]),
    mm: Number(m[4]),
    ss: Number(m[5]),
    ms: Number(m[6]),
    time: `${m[3]}:${m[4]}:${m[5]}.${m[6]}`,
    thread: m[7],
    pid: Number(m[8]),
  };
}

/**
 * Assign a calendar date to each record.
 *
 * NVDA's timestamps carry no date. Without this the whole layer breaks once a
 * year, at midnight, in a way nobody would diagnose. Records are in file order,
 * so a time going backwards means the day rolled over.
 *
 * Day arithmetic is done on date COMPONENTS rather than by adding 86,400,000 ms
 * — the latter shifts by an hour across a DST boundary and would silently
 * mis-date every record after it.
 */
export function assignDates(records, baseDate) {
  let year = baseDate.getFullYear();
  let month = baseDate.getMonth();
  let day = baseDate.getDate();
  let previousMsIntoDay = -1;

  for (const record of records) {
    const msIntoDay =
      ((record.hh * 60 + record.mm) * 60 + record.ss) * 1000 + record.ms;

    if (previousMsIntoDay >= 0 && msIntoDay < previousMsIntoDay) {
      const rolled = new Date(year, month, day + 1);
      year = rolled.getFullYear();
      month = rolled.getMonth();
      day = rolled.getDate();
    }
    previousMsIntoDay = msIntoDay;

    record.at = new Date(
      year,
      month,
      day,
      record.hh,
      record.mm,
      record.ss,
      record.ms,
    );
  }
  return records;
}

/**
 * Build the speech-specific fields of a record from its body.
 * Returns null when the body is not an utterance.
 */
function buildSpeechFields(body) {
  if (!body.startsWith(SPEAKING_PREFIX)) return null;

  let payload = body.slice(SPEAKING_PREFIX.length);
  const truncated = !payload.trimEnd().endsWith("]");
  if (!truncated) payload = payload.trimEnd().slice(0, -1);

  const parts = splitReprParts(payload);
  const classified = parts.map(classifyPart);
  const texts = classified.filter((p) => p.kind === "text").map((p) => p.value);
  const commands = classified
    .filter((p) => p.kind === "command")
    .map((p) => p.value);
  const text = texts.join(" ");

  return {
    parts,
    texts,
    commands,
    text,
    charCount: text.length,
    // Kept as a list, not a boolean: the marker's presence and position are
    // both unreliable (see the header comment), so callers get the raw facts.
    cancellableMarkers: commands.filter((c) => c.startsWith("CancellableSpeech")),
    truncated,
  };
}

/**
 * Parse a captured NVDA log.
 *
 * @param {string} text     Whole log contents.
 * @param {object} [options]
 * @param {number} [options.fromLine=0]  Skip this many leading lines (baselining).
 * @param {Date}   [options.baseDate]    Calendar day of the first record.
 * @returns {{records, speech, gestures, other, malformed, lineCount}}
 */
export function parseNvdaLog(text, options = {}) {
  const { fromLine = 0, baseDate = new Date() } = options;

  const allLines = text.split(/\r\n|\n|\r/);
  const lines = fromLine > 0 ? allLines.slice(fromLine) : allLines;

  const records = [];
  // Lines before the first header — a tail read that starts mid-record, or a
  // truncated file. Counted, never thrown on, never guessed at.
  let orphanBodyLines = 0;
  let current = null;
  let bodyLines = [];

  const flush = () => {
    if (!current) return;
    current.body = bodyLines.join("\n").trim();
    records.push(current);
    current = null;
    bodyLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const header = parseHeader(lines[i]);
    if (header) {
      flush();
      current = {
        ...header,
        lineNumber: fromLine + i + 1,
        kind: RECORD_KINDS.OTHER,
        body: "",
        at: null,
      };
      continue;
    }
    if (current) {
      bodyLines.push(lines[i]);
    } else if (lines[i].trim() !== "") {
      orphanBodyLines += 1;
    }
  }
  flush();

  for (const record of records) {
    if (record.module === GESTURE_MODULE) {
      record.kind = RECORD_KINDS.GESTURE;
      record.gesture = record.body.startsWith(GESTURE_BODY_PREFIX)
        ? record.body.slice(GESTURE_BODY_PREFIX.length).trim()
        : record.body;
      continue;
    }
    if (record.module.startsWith(SPEECH_MODULE_PREFIX)) {
      const speech = buildSpeechFields(record.body);
      if (speech) {
        record.kind = RECORD_KINDS.SPEECH;
        Object.assign(record, speech);
      }
    }
  }

  assignDates(records, baseDate);

  return {
    records,
    speech: records.filter((r) => r.kind === RECORD_KINDS.SPEECH),
    gestures: records.filter((r) => r.kind === RECORD_KINDS.GESTURE),
    other: records.filter((r) => r.kind === RECORD_KINDS.OTHER),
    orphanBodyLines,
    lineCount: lines.length,
  };
}

/**
 * The name/role split, as a HEURISTIC and labelled as one.
 *
 * NVDA does not document a field order, and two measurements on 9 August 2026
 * contradict the obvious reading: an object announcement appeared with no
 * CancellableSpeech marker, and elsewhere the marker sat mid-list ahead of a
 * description. So this guesses, and says so.
 *
 * No analyser in this layer may depend on it. Use record.text or record.parts.
 */
export function heuristicNameAndRole(record) {
  const texts = record.texts || [];
  return {
    name: texts[0] ?? null,
    role: texts.length > 1 ? texts[1] : null,
    heuristic: true,
    caveat:
      "Field order is undocumented; measured counter-examples exist. Prefer parts[].",
  };
}

// ---------------------------------------------------------------------------
// Analysers
//
// Each takes a parsed speech stream and, usually, a time window. They measure
// WHAT NVDA SENT TO THE SYNTHESISER. That is not conformance, and it does not
// retire the human listen — a person still judges ordering, interruption, and
// whether the message arrived where their attention actually was.
//
// INTERRUPTION DETECTION IS DELIBERATELY ABSENT. The spike on 9 August 2026
// interrupted a live-region write and an object announcement ~150 ms in, and
// both logged identically to speech delivered in full: the log line is written
// at speak() time, when the command is still valid. NVDA's own repr does carry
// a "CancellableSpeech (cancelled)" spelling, but no instance of it has been
// observed, and this kit does not build on an unobserved mechanism.
// ---------------------------------------------------------------------------

/** Verdicts for assertOnce. Silence and doubling are NOT the same failure. */
export const ANNOUNCE_VERDICTS = Object.freeze({
  SILENT: "SILENT",
  ONCE: "ONCE",
  DOUBLED: "DOUBLED",
});

/**
 * Restrict a stream to a time window.
 *
 * WHY A WINDOW MATTERS MORE HERE THAN IT LOOKS. At Input/output level NVDA logs
 * everything spoken machine-wide, including NVDA reading the agent's own
 * window — measured at 425,677 characters in a single utterance, matching a
 * probe string that had been named in the agent's visible text. Filtering by
 * the fire timestamp is the most reliable of the available defences (the
 * others being unique probe strings and the length filter below).
 *
 * @param {Array}  speech
 * @param {{from?: Date, to?: Date}} [window]
 */
export function selectWindow(speech, window = {}) {
  const { from, to } = window;
  return speech.filter((record) => {
    if (!record.at) return false;
    if (from && record.at < from) return false;
    if (to && record.at > to) return false;
    return true;
  });
}

function matches(record, pattern, { caseSensitive = false } = {}) {
  if (pattern instanceof RegExp) return pattern.test(record.text);
  const haystack = caseSensitive ? record.text : record.text.toLowerCase();
  const needle = caseSensitive ? pattern : String(pattern).toLowerCase();
  return haystack.includes(needle);
}

/**
 * Did this announcement happen exactly once?
 *
 * The three outcomes are reported separately and must stay separate: a silent
 * event is a worse outcome than a doubled one, and collapsing 0 and 2 into a single "fail" loses the
 * distinction that decides what to do next. Deleting both halves of a
 * duplicate is the easy mistake, and nothing in a count alone tells you the
 * fix produced silence rather than correctness.
 *
 * CAVEAT — PHANTOM ANNOUNCEMENTS. A deferred announce still in flight when a
 * later window opens is attributed to that window (measured at parcel g-8,
 * where a 1500 ms settle outlived the suite that caused it). Any window here
 * must outlast every deferred announce the code under test can have in flight,
 * and that bound should be derived FROM the settle constant, never copied.
 */
export function assertOnce(speech, pattern, window = {}, options = {}) {
  const scoped = selectWindow(speech, window);
  const hits = scoped.filter((record) => matches(record, pattern, options));

  let verdict = ANNOUNCE_VERDICTS.ONCE;
  if (hits.length === 0) verdict = ANNOUNCE_VERDICTS.SILENT;
  else if (hits.length > 1) verdict = ANNOUNCE_VERDICTS.DOUBLED;

  return {
    verdict,
    count: hits.length,
    matches: hits.map((r) => ({ time: r.time, at: r.at, text: r.text, charCount: r.charCount })),
    searched: scoped.length,
  };
}

/** Word bigrams, for similarity. Falls back to unigrams on short strings. */
function tokenGrams(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 2) return new Set(words);
  const grams = new Set();
  for (let i = 0; i < words.length - 1; i += 1) grams.add(`${words[i]} ${words[i + 1]}`);
  return grams;
}

/** Sørensen–Dice coefficient over word bigrams, 0..1. */
export function similarity(a, b) {
  const left = tokenGrams(a);
  const right = tokenGrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Near-duplicate SUSPECTS — utterances close in time that say much the same
 * thing in different words.
 *
 * This closes a limit of the announcement-channel audit: it matches on
 * equality or containment, so a toast and an announcement describing one event
 * in different words read as two legitimate messages. Exact and containing
 * pairs are therefore EXCLUDED here — that is the other tool's job, and this
 * one exists for what it cannot see.
 *
 * Reported as an UNGATED SUSPECT LIST, matching how same-region repeat writes
 * are already handled. It is worth a listen, not a bug report.
 *
 * The similarity threshold is NOT calibrated. It is a starting point for a
 * suspect list, chosen so that obviously-reworded pairs surface; nothing gates
 * on it, and it is a parameter precisely so it never hardens into a number
 * somebody mistakes for a measurement.
 */
export function findNearDuplicates(speech, options = {}) {
  const { withinMs = 3000, minSimilarity = 0.6, window = {} } = options;
  const scoped = selectWindow(speech, window);
  const suspects = [];

  for (let i = 0; i < scoped.length; i += 1) {
    for (let j = i + 1; j < scoped.length; j += 1) {
      const a = scoped[i];
      const b = scoped[j];
      if (!a.at || !b.at) continue;
      const gapMs = b.at - a.at;
      if (gapMs > withinMs) break;

      const aText = a.text.trim();
      const bText = b.text.trim();
      if (!aText || !bText) continue;
      // Equality and containment belong to the announcement-channel audit, not here.
      if (aText === bText) continue;
      if (aText.includes(bText) || bText.includes(aText)) continue;

      const score = similarity(aText, bText);
      if (score >= minSimilarity) {
        suspects.push({ gapMs, similarity: Number(score.toFixed(3)), a: aText, b: bText, aTime: a.time, bTime: b.time });
      }
    }
  }
  return { suspects, minSimilarity, withinMs, searched: scoped.length, gated: false };
}

/**
 * Whole-page-read detection — the Finding 2 detector, deliberately UNCALIBRATED.
 *
 * A park failure made NVDA read the whole page; in the log that is a large
 * utterance count and character total in a short window. But the threshold
 * that separates "read the page" from "said several things" has NOT been
 * measured, because that needs real captures of BOTH outcomes and the failure
 * reproduces only when a human performs the gesture (0 in 8 driven, ~1 in 3
 * human).
 *
 * So this returns the raw count and total and NO verdict. A verdict appears
 * only when the caller passes thresholds it has calibrated, and the reference
 * points below are provenance, not a threshold:
 *
 *   - a real page read, agent's own window:  425,677 characters, ONE utterance
 *   - ordinary browser utterances, same run:      98–143 characters each
 *
 * Shipping a guessed number here would manufacture exactly the kind of figure
 * that has burned people before: a guessed constant that reads as measured.
 */
export function detectPageRead(speech, options = {}) {
  const { window = {}, thresholds = null } = options;
  const scoped = selectWindow(speech, window);

  const totalChars = scoped.reduce((sum, r) => sum + r.charCount, 0);
  const largest = scoped.reduce(
    (best, r) => (best && best.charCount >= r.charCount ? best : r),
    null,
  );

  const measurement = {
    utterances: scoped.length,
    totalChars,
    largestUtteranceChars: largest ? largest.charCount : 0,
    largestUtteranceText: largest ? largest.text.slice(0, 200) : null,
    spanMs:
      scoped.length > 1 && scoped[0].at && scoped[scoped.length - 1].at
        ? scoped[scoped.length - 1].at - scoped[0].at
        : 0,
    verdict: null,
    calibrated: false,
    provenance: {
      realPageReadChars: 425677,
      ordinaryUtteranceChars: [98, 143],
      note: "Reference points measured on NVDA 2026.1, 9 August 2026. NOT thresholds.",
    },
  };

  if (!thresholds) return measurement;

  measurement.calibrated = true;
  measurement.thresholds = thresholds;
  const overCount = thresholds.maxUtterances != null && scoped.length > thresholds.maxUtterances;
  const overChars = thresholds.maxTotalChars != null && totalChars > thresholds.maxTotalChars;
  measurement.verdict = overCount || overChars ? "PAGE-READ" : "NO-PAGE-READ";
  return measurement;
}

/**
 * Milliseconds from firing to NVDA speaking.
 *
 * This is how an announcement settle delay can be bracketed from the SPEECH
 * side rather than only the DOM side — a delay recorded as "a value known to
 * work" is not a threshold unless values below it have been tested.
 *
 * Two reference measurements, NVDA 2026.1, 9 August 2026, n=1 each:
 * a live-region DOM write reached speak() in 21 ms; a focus change in 36 ms.
 */
export function measureLatency(speech, firedAt, pattern, options = {}) {
  const after = speech.filter((r) => r.at && r.at >= firedAt);
  const hit = after.find((r) => matches(r, pattern, options));
  if (!hit) return { found: false, latencyMs: null, firedAt, searched: after.length };
  return {
    found: true,
    latencyMs: hit.at - firedAt,
    firedAt,
    spokenAt: hit.at,
    time: hit.time,
    text: hit.text,
  };
}

/**
 * Read a capture from disk.
 *
 * NVDA holds the active capture file open for writing. .NET's File.ReadAllText
 * takes a sharing violation on it; Node's fs opens with shared read/write on
 * Windows, so this works while capture is live. That difference is measured
 * behaviour of the two runtimes, and the reason this helper exists rather than
 * callers rolling their own read.
 */
export function readNvdaLog(path, options = {}) {
  const text = readFileSync(path, "utf8");
  let baseDate = options.baseDate;
  if (!baseDate) {
    // Timestamps carry no date; the file's own birth time is the best anchor.
    const stats = statSync(path);
    baseDate = stats.birthtime && stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime;
  }
  return parseNvdaLog(text, { ...options, baseDate });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMainModule() {
  if (!process.argv[1]) return false;
  // pathToFileURL, not string concatenation: a Windows path needs drive-letter
  // and backslash handling that "file://" + path does not do.
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

function runCli() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    logError("Usage: node .claude/a11y/sr/nvda-speech-log.mjs <logPath> [--json] [--limit N]");
    process.exit(1);
  }

  let parsed;
  try {
    parsed = readNvdaLog(path);
  } catch (error) {
    logError(`Could not read ${path}: ${error.message}`);
    process.exit(1);
  }

  const limitFlag = args.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : 20;

  if (args.includes("--json")) {
    console.log(JSON.stringify(parsed.speech.slice(-limit), null, 2));
    process.exit(0);
  }

  console.log(`lines: ${parsed.lineCount}   records: ${parsed.records.length}`);
  console.log(
    `speech: ${parsed.speech.length}   gestures: ${parsed.gestures.length}   other: ${parsed.other.length}   orphan body lines: ${parsed.orphanBodyLines}`,
  );
  const totalChars = parsed.speech.reduce((sum, r) => sum + r.charCount, 0);
  console.log(`spoken characters: ${totalChars}`);
  console.log(`\nlast ${Math.min(limit, parsed.speech.length)} utterances:`);
  for (const record of parsed.speech.slice(-limit)) {
    const flag = record.truncated ? " [TRUNCATED]" : "";
    // A page read is a single utterance of hundreds of thousands of
    // characters; printing it whole floods the terminal and hides the row.
    const shown =
      record.text.length > CLI_TEXT_PREVIEW_CHARS
        ? `${record.text.slice(0, CLI_TEXT_PREVIEW_CHARS).replace(/\n/g, "\\n")}…`
        : record.text.replace(/\n/g, "\\n");
    console.log(`  ${record.time}  (${record.charCount} chars)${flag}  ${shown}`);
  }
  process.exit(0);
}

if (isMainModule()) runCli();
