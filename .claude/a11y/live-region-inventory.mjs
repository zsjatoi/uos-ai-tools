// live-region-inventory.mjs — static inventory of live-region CREATORS in
// shipped JavaScript.
//
// WHY THIS EXISTS. A live region manufactured per message, in the same tick as
// its content, can be measured SILENT on NVDA: the reader has not registered
// the region by the time the text arrives. The usual cure is to announce
// through one long-lived region that exists from page load, instead of
// creating a fresh aria-live region each time (README: "Edit-time audit").
//
// This scan finds the STRUCTURAL SIGNATURE of that defect — code that sets
// aria-live, or a live role, either via setAttribute or as an HTML string
// literal — so a second implementation of the pattern is visible at edit time
// rather than weeks later by ear. It finds the signature, never the defect: it
// cannot tell a region built once at start-up from one built per message.
//
// It is an INVENTORY with an allowlist, not a ban. Some creators are
// legitimate (e.g. a region built once at module-init and never rebuilt).
// A file with findings must have a matching or looser entry in
// live-region-allowlist.json; a NEW or GROWN finding is a violation.
//
// Allowlist entry shape (live-region-allowlist.json):
//   {
//     "schemaVersion": 1,
//     "files": [
//       {
//         "file": "<project-relative path, forward slashes>",
//         "count": <integer — findings currently sanctioned for this file>,
//         "status": "sanctioned" | "pending-review",
//         "note": "<why this file is allowed to create live regions>"
//       }
//     ]
//   }
//
// Run:
//   node .claude/a11y/live-region-inventory.mjs                full-tree scan
//   node .claude/a11y/live-region-inventory.mjs --file <path>  one file only
//   node .claude/a11y/live-region-inventory.mjs [--file <p>] --json
//                                                seed mode: JSON array only
// Exit: 0 clean; 1 violation (a file with findings absent from the allowlist,
// or whose count exceeds its allowlisted count).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Logging: configurable levels, British spelling.
// ---------------------------------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
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
// Locate the project. This file sits at <root>/.claude/a11y/, so the project
// root is two directories up (same convention as audit.mjs).
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url)); // <root>/.claude/a11y
export const A11Y_DIR = here;
export const PROJECT_ROOT = resolve(here, "..", "..");

const ALLOWLIST_FILENAME = "live-region-allowlist.json";

// ---------------------------------------------------------------------------
// Comment stripping — a character scanner, not a regex.
//
// An assertion over source text must exclude comments, or prose answers for
// the code; and a naive line filter on "//" silently discards every line
// containing "https://". So this
// walks the source one character at a time, tracking whether it is inside
// code, a string, or a comment, and only blanks out genuine comment bodies.
//
// Strings (single, double, template) are emitted VERBATIM — a "//" inside a
// string is not a comment, and this is exactly the trap a naive filter falls
// into. Comment bodies are blanked to spaces character-for-character, except
// newlines, which are always emitted verbatim so line numbers survive.
//
// Deliberately NOT attempted: regex-literal detection (distinguishing `/x/`
// from a division `a / b`). This is a well-known hard lexing problem without
// full tokenisation, and for THIS scan's purpose (finding "//" or "/*" that
// starts a genuine comment) getting it wrong costs more than leaving it out —
// a regex literal's slashes are never adjacent the way "//"/"/*" are, so this
// scanner's simple two-character check does not misfire on them in practice.
// Template-literal `${...}` interpolations are treated as opaque string
// content (not re-entered as code), which is a known, accepted simplification.
// ---------------------------------------------------------------------------
const SCAN_STATE = Object.freeze({
  CODE: "code",
  SINGLE_QUOTE: "single-quote",
  DOUBLE_QUOTE: "double-quote",
  TEMPLATE: "template",
  LINE_COMMENT: "line-comment",
  BLOCK_COMMENT: "block-comment",
});

/**
 * Strip `//` and `/* *\/` comments from JS source, preserving every other
 * character's position (and all newlines) so line numbers computed on the
 * result match the original file exactly.
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let state = SCAN_STATE.CODE;
  let out = "";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";

    if (state === SCAN_STATE.CODE) {
      if (ch === "/" && next === "/") {
        state = SCAN_STATE.LINE_COMMENT;
        out += "  ";
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = SCAN_STATE.BLOCK_COMMENT;
        out += "  ";
        i++;
        continue;
      }
      if (ch === '"') { state = SCAN_STATE.DOUBLE_QUOTE; out += ch; continue; }
      if (ch === "'") { state = SCAN_STATE.SINGLE_QUOTE; out += ch; continue; }
      if (ch === "`") { state = SCAN_STATE.TEMPLATE; out += ch; continue; }
      out += ch;
      continue;
    }

    if (
      state === SCAN_STATE.SINGLE_QUOTE ||
      state === SCAN_STATE.DOUBLE_QUOTE ||
      state === SCAN_STATE.TEMPLATE
    ) {
      const quote =
        state === SCAN_STATE.SINGLE_QUOTE ? "'" : state === SCAN_STATE.DOUBLE_QUOTE ? '"' : "`";
      // Backslash escapes: consume the escaped character verbatim without
      // interpreting it, so an escaped quote does not end the string early.
      if (ch === "\\" && next !== "") {
        out += ch + next;
        i++;
        continue;
      }
      if (ch === quote) { state = SCAN_STATE.CODE; out += ch; continue; }
      out += ch; // strings are emitted verbatim — a "//" here is not a comment
      continue;
    }

    if (state === SCAN_STATE.LINE_COMMENT) {
      if (ch === "\n") { state = SCAN_STATE.CODE; out += "\n"; continue; }
      out += " ";
      continue;
    }

    // state === SCAN_STATE.BLOCK_COMMENT
    if (ch === "*" && next === "/") {
      state = SCAN_STATE.CODE;
      out += "  ";
      i++;
      continue;
    }
    out += ch === "\n" ? "\n" : " ";
  }

  return out;
}

// ---------------------------------------------------------------------------
// Path exclusions. Segment/filename matching only — never a bare substring
// on the whole path, because a substring check would make "latest" match
// "test" (see filenameLooksLikeTest below, and the js/latest-model.js proof
// row that exists specifically to catch a regression here).
// ---------------------------------------------------------------------------
// Prefixes come from liveRegionExcludePrefixes in a11y.config.json; the default
// applies when the config is missing or unreadable.
const DEFAULT_EXCLUDED_PATH_PREFIXES = [".claude/", "a11y-fixtures/", "node_modules/"];

function loadExcludedPrefixes() {
  try {
    const cfg = JSON.parse(readFileSync(join(A11Y_DIR, "a11y.config.json"), "utf8"));
    if (Array.isArray(cfg.liveRegionExcludePrefixes)) return cfg.liveRegionExcludePrefixes;
  } catch {
    // fall through to the default
  }
  return DEFAULT_EXCLUDED_PATH_PREFIXES;
}
const EXCLUDED_PATH_PREFIXES = Object.freeze(loadExcludedPrefixes());
const EXCLUDED_PATH_SEGMENTS = Object.freeze(["testing", "tests", "test"]);
const TEST_FILENAME_TOKENS = Object.freeze(["test", "tests"]);

/**
 * True when a filename's delimiter-separated tokens include a bare "test"
 * or "tests" token — e.g. "foo-tests.js" and "test-harness.js" match,
 * "latest-model.js" does NOT (its tokens are "latest", "model", "js"; none
 * of them equal "test", even though the substring "test" occurs inside
 * "latest"). Tokenising, rather than a bare /test/i substring check, is
 * exactly what avoids that false exclusion.
 * @param {string} filename
 * @returns {boolean}
 */
function filenameLooksLikeTest(filename) {
  const tokens = filename.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.some((token) => TEST_FILENAME_TOKENS.includes(token));
}

/**
 * @param {string} relPath project-relative path, forward or back slashes
 * @returns {boolean} true when the scan should skip this path entirely
 */
export function isExcludedPath(relPath) {
  const normalised = relPath.replace(/\\/g, "/");
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return true;

  const segments = normalised.split("/");
  const filename = segments[segments.length - 1] || "";
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.some((s) => EXCLUDED_PATH_SEGMENTS.includes(s.toLowerCase()))) return true;

  return filenameLooksLikeTest(filename);
}

// ---------------------------------------------------------------------------
// Signatures. Four kinds, matched on the STRIPPED source. setAttribute forms
// and HTML-string forms are distinguished by the comma vs the equals sign
// (`setAttribute("aria-live", …)` vs `aria-live="…"`), so they cannot
// double-count the same occurrence.
// ---------------------------------------------------------------------------
const KIND = Object.freeze({
  SETATTR_ARIA_LIVE: "setattr-aria-live",
  SETATTR_LIVE_ROLE: "setattr-live-role",
  HTML_ARIA_LIVE: "html-aria-live",
  HTML_LIVE_ROLE: "html-live-role",
});

const OFF_VALUE = "off";
const DYNAMIC_VALUE = "<dynamic>";
const LIVE_ROLE_WORDS = "status|alert|log";
const SNIPPET_MAX_LENGTH = 100;

// Documentation table of the four signatures this scanner looks for. The
// actual matching logic lives in the regexes + collectors below — the
// nuances differ enough per kind (dynamic-value handling in particular)
// that one fully generic driver would obscure more than it saves.
const SIGNATURES = Object.freeze([
  Object.freeze({
    kind: KIND.SETATTR_ARIA_LIVE,
    description: 'setAttribute("aria-live", <value>) where <value> !== "off" (dynamic counts)',
  }),
  Object.freeze({
    kind: KIND.SETATTR_LIVE_ROLE,
    description: 'setAttribute("role", "status"|"alert"|"log") — literal only, dynamic excluded',
  }),
  Object.freeze({
    kind: KIND.HTML_ARIA_LIVE,
    description: 'aria-live="<value>" inside an HTML string literal, <value> !== "off"',
  }),
  Object.freeze({
    kind: KIND.HTML_LIVE_ROLE,
    description: 'role="status|alert|log" inside an HTML string literal, word-bounded',
  }),
]);

// Quote character may be ", ' or ` on either the key or the value argument.
// Value: a quoted literal (captured in full, allowing \-escapes), OR a
// dynamic expression captured conservatively as "everything up to the next
// unescaped ')'". The exact text of a dynamic capture is discarded (reported
// as "<dynamic>") — a false positive here is an allowlist row; a false
// negative is a silent live region, so anything non-literal counts.
const SETATTR_ARIA_LIVE_RE =
  /setAttribute\s*\(\s*(["'`])aria-live\1\s*,\s*(?:(["'`])((?:\\.|(?!\2)[\s\S])*)\2|([^)]*))\s*\)/g;

// role via setAttribute: literal quoted value only. Unlike aria-live, `role`
// is set dynamically to many non-live values throughout this codebase (tabs,
// dialogs, grids…), so a dynamic second argument here would be pure noise —
// deliberately not matched.
const SETATTR_LIVE_ROLE_RE = new RegExp(
  `setAttribute\\s*\\(\\s*(["'\`])role\\1\\s*,\\s*(["'\`])(${LIVE_ROLE_WORDS})\\2\\s*\\)`,
  "g"
);

// HTML string-literal form: aria-live="…" (or '…', possibly backslash-escaped
// as in "<span aria-live=\"polite\">"). \\?(["']) permits an optional leading
// backslash on the opening quote; the lazy body stops at the first matching
// \\?(same quote), which correctly handles both the escaped and unescaped case.
const HTML_ARIA_LIVE_RE = /aria-live\s*=\s*\\?(["'])([\s\S]*?)\\?\1/g;

// HTML string-literal role form, bounded on BOTH sides. Left: a lookbehind so
// the tail of data-role= (or any *-role=/xrole=) cannot match — this fires on
// querySelector('[data-role="status-text"]'). Right: \b alone let a hyphen continue the word, so
// role="status-text" counted as role="status"; (?![-\w]) blocks both
// "statusbar" and "status-text" while still allowing role="status alert"
// fallback lists. Does not need to capture the full attribute value — only
// that the value BEGINS with one of the live-region role words.
const HTML_LIVE_ROLE_RE = new RegExp(
  `(?<![-\\w])role\\s*=\\s*\\\\?(["'])(${LIVE_ROLE_WORDS})(?![-\\w])`,
  "g"
);

/** Build a sorted array of line-start byte offsets for binary-search lookup. */
function buildLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** 1-indexed line number for a character index, via binary search. */
function lineAt(lineOffsets, index) {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function makeFinding(kind, value, match, lineOffsets) {
  const snippet =
    match[0].length > SNIPPET_MAX_LENGTH ? match[0].slice(0, SNIPPET_MAX_LENGTH) : match[0];
  return { line: lineAt(lineOffsets, match.index), kind, value, snippet };
}

/** Run one signature's regex to exhaustion against the stripped source. */
function collectMatches(stripped, regex, mapMatch, findings) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    const finding = mapMatch(match);
    if (finding) findings.push(finding);
    if (match[0].length === 0) regex.lastIndex++; // guard against a zero-length stall
  }
}

/**
 * Find every live-region-creator signature in one file's source.
 * @param {string} source raw file contents
 * @param {string} relPath project-relative path (used only for exclusion)
 * @returns {Array<{line:number, kind:string, value:string, snippet:string}>}
 */
export function findLiveRegionCreators(source, relPath) {
  if (isExcludedPath(relPath)) return [];

  const stripped = stripComments(source);
  const lineOffsets = buildLineOffsets(stripped);
  const findings = [];

  collectMatches(
    stripped,
    SETATTR_ARIA_LIVE_RE,
    (m) => {
      const isLiteral = m[2] !== undefined;
      const value = isLiteral ? m[3] : DYNAMIC_VALUE;
      if (isLiteral && value === OFF_VALUE) return null;
      return makeFinding(KIND.SETATTR_ARIA_LIVE, value, m, lineOffsets);
    },
    findings
  );

  collectMatches(
    stripped,
    SETATTR_LIVE_ROLE_RE,
    (m) => makeFinding(KIND.SETATTR_LIVE_ROLE, m[3], m, lineOffsets),
    findings
  );

  collectMatches(
    stripped,
    HTML_ARIA_LIVE_RE,
    (m) => (m[2] === OFF_VALUE ? null : makeFinding(KIND.HTML_ARIA_LIVE, m[2], m, lineOffsets)),
    findings
  );

  collectMatches(
    stripped,
    HTML_LIVE_ROLE_RE,
    (m) => makeFinding(KIND.HTML_LIVE_ROLE, m[2], m, lineOffsets),
    findings
  );

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
const EMPTY_ALLOWLIST = Object.freeze({ schemaVersion: 1, files: [] });

/**
 * Load and parse live-region-allowlist.json. Never throws — a missing or
 * malformed allowlist logs a warning and is treated as empty, so a fresh
 * checkout without the file fails CLOSED (everything with findings is a
 * violation) rather than silently passing.
 * @returns {{schemaVersion: number, files: Array}}
 */
export function loadAllowlist() {
  const path = join(A11Y_DIR, ALLOWLIST_FILENAME);
  if (!existsSync(path)) {
    logWarn(`Allowlist not found at ${path}; treating as empty.`);
    return { ...EMPTY_ALLOWLIST, files: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || !Array.isArray(parsed.files)) throw new Error("missing files[] array");
    return parsed;
  } catch (e) {
    logWarn(`Allowlist at ${path} could not be parsed (${e.message}); treating as empty.`);
    return { ...EMPTY_ALLOWLIST, files: [] };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Enumerate every tracked *.js file via `git ls-files`. This reads the git
 * INDEX only and never walks the filesystem, so it stays fast on large or
 * network-synced trees. Do not replace this with a recursive directory walk.
 */
function listTrackedJsFiles() {
  const out = execFileSync("git", ["ls-files", "*.js"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function uniqueKinds(findings) {
  return [...new Set(findings.map((f) => f.kind))].sort();
}

function scanFiles(relPaths) {
  const results = [];
  for (const rawPath of relPaths) {
    const relPath = rawPath.replace(/\\/g, "/");
    if (isExcludedPath(relPath)) continue;
    const absPath = resolve(PROJECT_ROOT, relPath);
    if (!existsSync(absPath)) {
      logWarn(`Skipping missing file: ${relPath}`);
      continue;
    }
    const source = readFileSync(absPath, "utf8");
    const findings = findLiveRegionCreators(source, relPath);
    if (findings.length > 0) {
      results.push({ file: relPath, count: findings.length, kinds: uniqueKinds(findings) });
    }
  }
  return results;
}

function printFindingsTable(results) {
  if (results.length === 0) {
    logInfo("No live-region creators found.");
    return;
  }
  logInfo("file  count  kinds");
  for (const r of results) {
    logInfo(`${r.file}  ${r.count}  ${r.kinds.join(", ")}`);
  }
}

/**
 * Compare scan results against the allowlist. Returns violation message
 * strings; logs (but does not fail on) a count that dropped below its
 * allowlisted value — that is progress, and the fix is to tighten the entry,
 * not to block the run.
 */
function compareAgainstAllowlist(results, allowlist) {
  const byFile = new Map(allowlist.files.map((entry) => [entry.file, entry]));
  const violations = [];
  for (const r of results) {
    const entry = byFile.get(r.file);
    if (!entry) {
      violations.push(`${r.file}: ${r.count} finding(s), not present in the allowlist`);
      continue;
    }
    if (r.count > entry.count) {
      violations.push(
        `${r.file}: ${r.count} finding(s) exceeds allowlisted count ${entry.count}`
      );
    } else if (r.count < entry.count) {
      logInfo(
        `${r.file}: count dropped to ${r.count} (allowlisted ${entry.count}) — tighten the allowlist`
      );
    }
  }
  return violations;
}

function parseArgs(argv) {
  const jsonMode = argv.includes("--json");
  const fileFlagIndex = argv.indexOf("--file");
  if (fileFlagIndex === -1) return { jsonMode, singleFile: null };
  const singleFile = argv[fileFlagIndex + 1];
  if (!singleFile) throw new Error("--file requires a path argument");
  return { jsonMode, singleFile };
}

function main() {
  const { jsonMode, singleFile } = parseArgs(process.argv.slice(2));
  const candidates = singleFile ? [singleFile] : listTrackedJsFiles();
  const results = scanFiles(candidates);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results));
    process.exit(0);
  }

  printFindingsTable(results);
  const allowlist = loadAllowlist();
  const violations = compareAgainstAllowlist(results, allowlist);

  if (violations.length > 0) {
    logError("");
    logError(`LIVE-REGION INVENTORY: ${violations.length} violation(s) against the allowlist`);
    violations.forEach((v) => logError(`  ${v}`));
    process.exit(1);
  }

  logInfo("");
  logInfo(
    `LIVE-REGION INVENTORY: clean against ${allowlist.files.length} allowlist entr${
      allowlist.files.length === 1 ? "y" : "ies"
    }`
  );
  process.exit(0);
}

// Guard the CLI behind direct invocation so importing this module (e.g. from
// the proof) never launches a scan as a side effect — same pattern as
// announce-audit.mjs.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    logError(`live-region-inventory failed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}
