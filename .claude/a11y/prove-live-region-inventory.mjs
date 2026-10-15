#!/usr/bin/env node
/**
 * Fixture proof for live-region-inventory.mjs.
 *
 * WHY THIS EXISTS
 * ----------------
 * A static scanner produces no symptom of its own when it is wrong — one that
 * finds nothing and one that finds everything both look like "clean" or
 * "always red" from the outside. This is the first static check of its kind
 * in .claude/a11y/, so this proof carries the weight: it feeds the REAL
 * findLiveRegionCreators() and isExcludedPath() (imported, never
 * re-implemented) cases with a known expected disposition in BOTH
 * directions, plus two rows that pin down line-number reporting specifically
 * (a comment-stripper that mis-tracks newlines would pass every DENY/ALLOW
 * row and still misreport WHERE the problem is).
 *
 * Run:  node .claude/a11y/prove-live-region-inventory.mjs
 * Exit: 0 when every row matches its expected disposition.
 */

import { findLiveRegionCreators, isExcludedPath } from "./live-region-inventory.mjs";

const DEFAULT_REL_PATH = "js/x.js";

// [sourceSnippet, relPath, expected ("DENY" | "ALLOW"), whatTheRowDefends]
const CASES = [
  // --- DENY: the four signatures, each form ---
  [
    'el.setAttribute("aria-live", "polite");',
    DEFAULT_REL_PATH,
    "DENY",
    "setAttribute aria-live=polite creates a live region",
  ],
  [
    'el.setAttribute("aria-live", "assertive");',
    DEFAULT_REL_PATH,
    "DENY",
    "setAttribute aria-live=assertive creates a live region",
  ],
  [
    'el.setAttribute("role", "status");',
    DEFAULT_REL_PATH,
    "DENY",
    "setAttribute role=status creates a live region",
  ],
  [
    'el.setAttribute("role", "alert");',
    DEFAULT_REL_PATH,
    "DENY",
    "setAttribute role=alert creates a live region",
  ],
  [
    'el.setAttribute("role", "log");',
    DEFAULT_REL_PATH,
    "DENY",
    "setAttribute role=log creates a live region",
  ],
  [
    'c.innerHTML = \'<div role="status">x</div>\';',
    DEFAULT_REL_PATH,
    "DENY",
    "HTML string-literal role=status",
  ],
  [
    'c.innerHTML = "<span aria-live=\\"polite\\"></span>";',
    DEFAULT_REL_PATH,
    "DENY",
    "escaped-quote HTML aria-live form",
  ],
  [
    "const t = `<div aria-live=\"polite\">`;",
    DEFAULT_REL_PATH,
    "DENY",
    "template-literal HTML aria-live form",
  ],
  [
    'el.setAttribute("aria-live", politeness);',
    DEFAULT_REL_PATH,
    "DENY",
    "dynamic aria-live value is conservatively counted (false positive beats a silent live region)",
  ],
  [
    'host.insertAdjacentHTML("beforeend", \'<p role="alert">boom</p>\');',
    DEFAULT_REL_PATH,
    "DENY",
    "insertAdjacentHTML role=alert",
  ],

  // --- DENY: hazards that must NOT be treated as exclusions ---
  [
    'el.setAttribute("aria-live", "polite");',
    "js/latest-model.js",
    "DENY",
    "'latest' must not be treated as 'test' — tokenised filename check, not a substring match",
  ],
  [
    'const u = "https://example.com/docs";\nel.setAttribute("aria-live", "polite");',
    DEFAULT_REL_PATH,
    "DENY",
    "https:// inside a string must not be mistaken for a line comment by the stripper",
  ],

  // --- ALLOW: the sanctioned silencer ---
  [
    'el.setAttribute("aria-live", "off");',
    DEFAULT_REL_PATH,
    "ALLOW",
    'aria-live="off" is the sanctioned silencer',
  ],

  // --- ALLOW: comments must not be treated as code ---
  [
    '// el.setAttribute("aria-live", "polite");',
    DEFAULT_REL_PATH,
    "ALLOW",
    "a live-region creator behind a line comment is not live code",
  ],
  [
    '/* el.setAttribute("aria-live", "polite"); */',
    DEFAULT_REL_PATH,
    "ALLOW",
    "a live-region creator inside a block comment is not live code",
  ],

  // --- ALLOW: role nuances ---
  [
    'el.setAttribute("role", "region");',
    DEFAULT_REL_PATH,
    "ALLOW",
    "role=region is not a live role",
  ],
  [
    "el.setAttribute(\"role\", roleName);",
    DEFAULT_REL_PATH,
    "ALLOW",
    "dynamic role is deliberately NOT counted — role is set dynamically to many non-live values",
  ],

  // --- ALLOW: a read is not a creator ---
  [
    'const s = document.querySelector(\'[aria-live]\').getAttribute("aria-live");',
    DEFAULT_REL_PATH,
    "ALLOW",
    "reading aria-live back is not creating a live region",
  ],

  // --- ALLOW: word-boundary case ---
  [
    'c.innerHTML = \'<div role="statusbar">x</div>\';',
    DEFAULT_REL_PATH,
    "ALLOW",
    'role="statusbar" must not match role="status" — word-boundary required',
  ],
  [
    "const el = surfaceEl.querySelector('[data-role=\"status-text\"]');",
    DEFAULT_REL_PATH,
    "ALLOW",
    'data-role="status-text" must not match role="status" — LEFT boundary required',
  ],
  [
    'c.innerHTML = \'<div role="status-text">x</div>\';',
    DEFAULT_REL_PATH,
    "ALLOW",
    'role="status-text" is not the status role — a hyphen must not continue the matched word',
  ],

  // --- ALLOW: the URL alone, isolated from the DENY combination above ---
  [
    'const u = "https://example.com/docs";',
    DEFAULT_REL_PATH,
    "ALLOW",
    "a bare https:// URL string, with no creator nearby, must find nothing",
  ],

  // --- ALLOW: path exclusions ---
  [
    'el.setAttribute("aria-live", "polite");',
    ".claude/a11y/thing.js",
    "ALLOW",
    "excluded path prefix: .claude/",
  ],
  [
    'el.setAttribute("aria-live", "polite");',
    "a11y-fixtures/thing.js",
    "ALLOW",
    "excluded path prefix: a11y-fixtures/",
  ],
  [
    'el.setAttribute("aria-live", "polite");',
    "app/testing/foo.js",
    "ALLOW",
    "excluded path SEGMENT: testing",
  ],
  [
    'el.setAttribute("aria-live", "polite");',
    "src/testing/bar-tests.js",
    "ALLOW",
    "excluded path segment AND excluded filename (belt and braces)",
  ],
];

// [sourceSnippet, relPath, expectedLine, whatTheRowDefends]
const LINE_CASES = [
  [
    'el.setAttribute("aria-live", "polite");',
    DEFAULT_REL_PATH,
    1,
    "baseline: a single-line creator reports line 1",
  ],
  [
    '/* comment line one\n   comment line two */\nel.setAttribute("aria-live", "polite");',
    DEFAULT_REL_PATH,
    3,
    "a two-line block comment must not shift the creator's reported line — proves stripComments preserves newlines",
  ],
];

let pass = 0;
let fail = 0;
const rows = [];

for (const [source, relPath, expected, why] of CASES) {
  const actual = findLiveRegionCreators(source, relPath).length > 0 ? "DENY" : "ALLOW";
  const ok = actual === expected;
  ok ? pass++ : fail++;
  rows.push(`${ok ? "  ok  " : " FAIL "} ${expected.padEnd(5)} ${actual.padEnd(5)} ${relPath}`);
  if (!ok) rows.push(`         defending: ${why}\n         source: ${source}`);
}

console.log("exp   got   relPath");
console.log(rows.join("\n"));

const denies = CASES.filter(([, , e]) => e === "DENY").length;
const allows = CASES.length - denies;
console.log(
  `\n${pass} passed, ${fail} failed  —  ${denies} DENY rows and ${allows} ALLOW rows, so neither an always-deny nor an always-allow classifier can pass this.`
);

// The sentence above is a CLAIM about this row set, so it is enforced rather than
// merely printed: with every ALLOW row deleted it would otherwise still announce
// "0 ALLOW rows, so neither classifier can pass this" and exit 0. Two-sidedness is
// over-determined here (the line-number rows below also catch both an always-deny
// and an always-allow classifier), so this refusal defends the SENTENCE.
if (denies === 0 || allows === 0) {
  console.error(
    `\nREFUSING TO REPORT SUCCESS: one side is empty (DENY ${denies}, ALLOW ${allows}). ` +
      `A one-sided row set cannot tell a working classifier from an always-deny or an always-allow one.`
  );
  process.exit(2);
}

// --- line-number precondition rows ------------------------------------------
let linePass = 0;
let lineFail = 0;
const lineRows = [];

for (const [source, relPath, expectedLine, why] of LINE_CASES) {
  const findings = findLiveRegionCreators(source, relPath);
  const actualLine = findings.length > 0 ? findings[0].line : "no-finding";
  const ok = actualLine === expectedLine;
  ok ? linePass++ : lineFail++;
  lineRows.push(`${ok ? "  ok  " : " FAIL "} line ${String(expectedLine).padEnd(3)} got ${String(actualLine).padEnd(3)} — ${why}`);
}

console.log("\nline-number preconditions:");
console.log(lineRows.join("\n"));
console.log(`\n${linePass} passed, ${lineFail} failed`);

// --- isExcludedPath is exercised directly too, since it is imported and part
// of the public contract this proof is required to defend.
const excludedDirectChecks = [
  [".claude/a11y/thing.js", true],
  ["a11y-fixtures/thing.js", true],
  ["app/testing/foo.js", true],
  ["src/testing/bar-tests.js", true],
  ["js/latest-model.js", false],
  [DEFAULT_REL_PATH, false],
];
let excludedPass = 0;
let excludedFail = 0;
const excludedRows = [];
for (const [relPath, expected] of excludedDirectChecks) {
  const actual = isExcludedPath(relPath);
  const ok = actual === expected;
  ok ? excludedPass++ : excludedFail++;
  excludedRows.push(`${ok ? "  ok  " : " FAIL "} ${String(expected).padEnd(5)} ${String(actual).padEnd(5)} ${relPath}`);
}
console.log("\nisExcludedPath() direct checks:");
console.log(excludedRows.join("\n"));
console.log(`\n${excludedPass} passed, ${excludedFail} failed`);

const totalFail = fail + lineFail + excludedFail;
process.exit(totalFail ? 1 : 0);
