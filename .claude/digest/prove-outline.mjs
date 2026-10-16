#!/usr/bin/env node
/**
 * Fixture proof for outline.mjs.
 *
 * This tool's failure mode is SILENT and it reads as success. A Markdown parser
 * that invents one heading shifts every line range after it, and the outline it
 * prints is still well-formed, still plausible, and still tiles a file - just
 * the wrong one. The reader follows a range, finds the wrong text, and has no
 * way to tell a parser fault from their own mistake.
 *
 * So the rows below are two-sided on purpose: a parser that treats nothing as a
 * heading and one that treats everything as a heading both produce "no
 * findings" from the outside, and only cases with a known expected disposition
 * in BOTH directions can tell them apart.
 *
 * Run:        node .claude/digest/prove-outline.mjs
 * Inversions: node .claude/digest/prove-outline.mjs --inversions
 * Corpus:     node .claude/digest/prove-outline.mjs --corpus <file-or-dir> [--min-files N]
 * Exit: 0 every row matched · 1 a row failed · 2 the sweep found an unbound row
 *       (or a corpus run refused).
 *
 * ON THE INVERSIONS
 * The faithful ones - INV-NO-FENCE, INV-LOOSE-HEADING, INV-SETEXT-AS-HEADING -
 * drive the SHIPPED `parseMarkdown` through its own `strict` / `headingRe` /
 * `setextAsHeading` seams, so the code under test is the code that runs. The
 * others are local re-implementations of a named defect, swapped in for a shipped
 * function; they exercise the row's assertion rather than the shipped code, and
 * say so. A stand-in that reddens the row it names still proves that row can
 * fail, which is the only claim an inversion makes. The sweep prints which is
 * which on every row; do not quote a faithful/stand-in count from memory.
 *
 * The sweep REFUSES to report success if any row is named by no inversion. An
 * unbindable row is not a passing row; it is a row nobody has shown can fail.
 *
 * See the README section 'Guards'.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown, rollUp, checkCoverage } from "./outline.mjs";

// --- fixtures -------------------------------------------------------------
// Built in memory. Nothing is written to disk, so a failed run leaves no residue.

const FENCED = [
  "# Real H1",
  "",
  "Some prose.",
  "",
  "```sh",
  "# NOT a heading - a shell comment",
  "## also not a heading",
  "```",
  "",
  "## Real H2",
  "",
  "~~~python",
  "# NOT a heading - inside a tilde fence",
  "~~~",
  "",
  "### Real H3",
  "",
  "````",
  "```",
  "# NOT a heading - inside a four-backtick fence, and that inner ``` does not close it",
  "````",
  "",
  "#### Real H4 ####",
  "",
  "   ##### Real H5 indented three spaces",
  "",
  "###### Real H6",
  "",
  "####### not a heading - seven hashes",
  "#nospace is not a heading",
  "",
].join("\n");

const FRONT_MATTER = ["---", "title: thing", "# not a heading - inside front matter", "---", "", "# Real H1", "body", ""].join("\n");

const SETEXT = ["# Real H1", "", "A paragraph title", "-----------------", "", "body", ""].join("\n");

const NO_HEADINGS = ["just", "some", "prose", ""].join("\n");

const CRLF = FENCED.replace(/\n/g, "\r\n");

// --- rows -----------------------------------------------------------------
// [id, side, what it defends, assertion(fns) -> boolean]
// `side` is DENY when the row defends something being EXCLUDED, ALLOW when it
// defends something being INCLUDED or preserved.

const titles = (fns, text) => fns.parseMarkdown(text).sections.map((s) => s.title);

const ROWS = [
  // --- DENY: things that must not be read as headings ---
  ["D1-fence-backtick", "DENY", "a # inside a ``` fence is a shell comment", (f) => !titles(f, FENCED).some((t) => t.includes("shell comment"))],
  ["D2-fence-tilde", "DENY", "a # inside a ~~~ fence is not a heading", (f) => !titles(f, FENCED).some((t) => t.includes("tilde fence"))],
  ["D3-fence-nested", "DENY", "an inner ``` does not close a ```` fence", (f) => !titles(f, FENCED).some((t) => t.includes("four-backtick"))],
  ["D4-fence-h2", "DENY", "a ## inside a fence is not a heading either", (f) => !titles(f, FENCED).some((t) => t === "also not a heading")],
  ["D5-seven-hashes", "DENY", "seven hashes is not a heading (max is six)", (f) => !titles(f, FENCED).some((t) => t.includes("seven hashes"))],
  ["D6-no-space", "DENY", "#nospace is not a heading", (f) => !titles(f, FENCED).some((t) => t.includes("nospace"))],
  ["D7-front-matter", "DENY", "a # inside YAML front matter is not a heading", (f) => !titles(f, FRONT_MATTER).some((t) => t.includes("front matter"))],
  ["D8-setext-not-parsed", "DENY", "a setext underline is not parsed as a heading", (f) => !titles(f, SETEXT).some((t) => t.includes("paragraph title"))],

  // --- ALLOW: things that must be found, so an always-deny parser reddens ---
  ["A1-h1", "ALLOW", "a plain # heading is found", (f) => titles(f, FENCED).includes("Real H1")],
  ["A2-after-fence", "ALLOW", "a heading immediately after a fence closes is found", (f) => titles(f, FENCED).includes("Real H2")],
  // Asserts the LEVELS, not the titles: a title such as `Real H5` would redden on
  // the fixture's "Real H5 indented three spaces" - the expectation, not the parser.
  ["A3-all-six-levels", "ALLOW", "every heading level 1-6 is found exactly once", (f) => {
    const levels = f.parseMarkdown(FENCED).sections.map((s) => s.level);
    return JSON.stringify(levels) === JSON.stringify([1, 2, 3, 4, 5, 6]);
  }],
  ["A4-closing-hashes", "ALLOW", "a trailing #### closing sequence is stripped, not kept", (f) => titles(f, FENCED).includes("Real H4")],
  ["A5-indented-three", "ALLOW", "a heading indented up to three spaces is still a heading", (f) => titles(f, FENCED).includes("Real H5 indented three spaces")],
  ["A6-after-front-matter", "ALLOW", "the first real heading after front matter is found", (f) => titles(f, FRONT_MATTER).includes("Real H1")],
  ["A7-count", "ALLOW", "the fixture yields exactly six headings, no more and no fewer", (f) => f.parseMarkdown(FENCED).sections.length === 6],

  // --- the binding disagreement row ---
  [
    "X1-strict-differs-from-naive",
    "DENY",
    "the strict and naive parses DISAGREE on a fence-bearing fixture (asserting the disagreement, not the correctness - a correct parser on a fence-free file proves nothing)",
    (f) => f.parseMarkdown(FENCED).sections.length < f.parseMarkdown(FENCED, { strict: false }).sections.length,
  ],

  // --- coverage canaries: a parse that loses a region must not read as clean ---
  ["C1-tiles-fenced", "ALLOW", "the sections tile the fenced fixture with no gap or overlap", (f) => f.checkCoverage(f.parseMarkdown(FENCED)).length === 0],
  ["C2-bytes-sum", "ALLOW", "section bytes plus preamble equal the file size exactly", (f) => {
    const p = f.parseMarkdown(FENCED);
    return p.sections.reduce((n, s) => n + s.bytes, 0) + p.preambleBytes === p.totalBytes;
  }],
  ["C3-no-headings-file", "ALLOW", "a file with no headings is all preamble and still tiles", (f) => {
    const p = f.parseMarkdown(NO_HEADINGS);
    return p.sections.length === 0 && p.preambleBytes === p.totalBytes && f.checkCoverage(p).length === 0;
  }],
  ["C4-crlf", "ALLOW", "a CRLF file parses to the same sections and still tiles", (f) => {
    const p = f.parseMarkdown(CRLF);
    return p.sections.length === 6 && f.checkCoverage(p).length === 0 && p.sections.every((s, i) => s.title === f.parseMarkdown(FENCED).sections[i].title);
  }],
  ["C5-setext-warned", "ALLOW", "a setext underline is COUNTED as a suspect, so a doc using them cannot be silently mis-outlined", (f) => f.parseMarkdown(SETEXT).setextSuspects.length === 1],

  // C6/C7: a file ending in a newline yields a phantom final element from
  // split("\n"), which would inflate totalLines and the last section's endLine by
  // one. Both sides are asserted - with and without the trailing newline -
  // because a fix that simply always subtracts one is wrong in the other
  // direction and would pass C6 alone.
  ["C6-trailing-newline", "ALLOW", "a file ending in \\n reports its real line count, and the last section ends on it (no phantom line)", (f) => {
    const p = f.parseMarkdown(FENCED); // FENCED ends with a newline
    const real = FENCED.split("\n").length - 1;
    return p.totalLines === real && p.sections[p.sections.length - 1].endLine === real;
  }],
  ["C7-no-trailing-newline", "ALLOW", "a file NOT ending in \\n keeps its final line (the over-correction in the other direction)", (f) => {
    const noEol = FENCED.replace(/\n$/, "");
    const p = f.parseMarkdown(noEol);
    const real = noEol.split("\n").length;
    return p.totalLines === real && p.sections[p.sections.length - 1].endLine === real;
  }],

  // --- roll-up: a depth view must not under-report a parent ---
  ["R1-rollup-preserves-bytes", "ALLOW", "rolling up to depth 1 preserves the total byte count", (f) => {
    const p = f.parseMarkdown(FENCED);
    const all = p.sections.reduce((n, s) => n + s.bytes, 0);
    return f.rollUp(p.sections, 1).reduce((n, s) => n + s.bytes, 0) === all;
  }],
  ["R2-rollup-extends-range", "ALLOW", "a rolled-up parent's line range covers its children (a parent with little text of its own must not report a tiny range)", (f) => {
    const p = f.parseMarkdown(FENCED);
    const [top] = f.rollUp(p.sections, 1);
    return top.endLine === p.sections[p.sections.length - 1].endLine && top.children === 5;
  }],
  ["R3-rollup-depth6-is-identity", "ALLOW", "rolling up to depth 6 changes nothing on a six-level fixture", (f) => {
    const p = f.parseMarkdown(FENCED);
    return f.rollUp(p.sections, 6).length === p.sections.length;
  }],
];

// --- inversions -----------------------------------------------------------
// Each names the rows it must redden. The sweep refuses if a row is named by none.

const SHIPPED = { parseMarkdown, rollUp, checkCoverage };

/**
 * Notes that explain the shape of this set:
 *
 * 1. A canary row cannot be reddened by switching the canary off (coverage blinded
 *    makes C1/C3 assert "coverage is clean" against a function that always says
 *    clean). It is reddened by breaking the thing the canary watches, with the
 *    canary live: INV-PARSE-DROPS-SECTION and INV-PREAMBLE-ZERO.
 * 2. `D7-front-matter` is not bound by the fence inversion, correctly: front-matter
 *    skipping sits outside the `strict` branch on purpose, so `--audit` isolates
 *    the FENCE effect and nothing else. It gets its own inversion.
 * 3. Unpredicted reds are reported, never silently accepted: a parser broken one
 *    way reddens rows named for another, because they read the same parse.
 * 4. Predictions are re-pointed only after the behaviour they missed has been
 *    measured and found legitimate. For example, the FENCED fixture opens on a
 *    heading, so forcing its preamble to 0 is a no-op (C2 is bound by
 *    INV-PARSE-DROPS-SECTION instead), and R1's two sides derive from the SAME
 *    parse, so only an inversion that breaks one side (INV-ROLLUP-DROPS-CHILDREN)
 *    can redden it.
 */
const INVERSIONS = [
  {
    id: "INV-NO-FENCE",
    faithful: true,
    what: "the shipped naive path - heading matching with no fence state at all",
    reddens: ["D1-fence-backtick", "D2-fence-tilde", "D3-fence-nested", "D4-fence-h2", "A3-all-six-levels", "A7-count", "X1-strict-differs-from-naive", "C4-crlf", "C5-setext-warned", "R2-rollup-extends-range"],
    fns: { ...SHIPPED, parseMarkdown: (t, o) => parseMarkdown(t, { ...o, strict: false }) },
  },
  {
    id: "INV-LOOSE-HEADING",
    faithful: true,
    what: "the shipped parse driven through a sloppy ATX pattern that accepts 7+ hashes and needs no space",
    reddens: ["D5-seven-hashes", "D6-no-space", "A3-all-six-levels", "A7-count", "C4-crlf", "R2-rollup-extends-range", "R3-rollup-depth6-is-identity"],
    fns: { ...SHIPPED, parseMarkdown: (t, o) => parseMarkdown(t, { ...o, headingRe: /^ {0,3}(#+) *(.*?) *#* *$/ }) },
  },
  {
    id: "INV-SETEXT-AS-HEADING",
    faithful: true,
    what: "the shipped parse told to treat a setext underline as a heading instead of counting it",
    reddens: ["D8-setext-not-parsed", "C5-setext-warned"],
    fns: { ...SHIPPED, parseMarkdown: (t, o) => parseMarkdown(t, { ...o, setextAsHeading: true }) },
  },
  {
    id: "INV-NO-FRONT-MATTER",
    faithful: false,
    what: "stand-in: front-matter skipping removed, so a # between the --- fences becomes a heading",
    reddens: ["D7-front-matter"],
    fns: {
      ...SHIPPED,
      parseMarkdown: (t, o) => parseMarkdown(t.startsWith("---") ? t.replace(/^---\n/, "\n") : t, o),
    },
  },
  {
    id: "INV-NEVER-A-HEADING",
    faithful: false,
    what: "stand-in: a parser that finds no headings anywhere - the always-deny failure an ALLOW row exists to catch",
    reddens: ["A1-h1", "A2-after-fence", "A3-all-six-levels", "A4-closing-hashes", "A5-indented-three", "A6-after-front-matter", "A7-count", "X1-strict-differs-from-naive", "C4-crlf", "C6-trailing-newline", "C7-no-trailing-newline", "R2-rollup-extends-range"],
    fns: {
      ...SHIPPED,
      parseMarkdown: (t, o) => {
        const p = parseMarkdown(t, o);
        return { ...p, sections: [], preambleBytes: p.totalBytes, preambleEndLine: p.totalLines };
      },
    },
  },
  {
    id: "INV-PARSE-DROPS-SECTION",
    faithful: false,
    what: "stand-in: the parse loses its last section while checkCoverage stays LIVE - the tiling break a canary must catch",
    reddens: ["A3-all-six-levels", "A6-after-front-matter", "A7-count", "C1-tiles-fenced", "C2-bytes-sum", "C4-crlf", "C6-trailing-newline", "C7-no-trailing-newline", "R2-rollup-extends-range"],
    fns: {
      ...SHIPPED,
      parseMarkdown: (t, o) => {
        const p = parseMarkdown(t, o);
        return { ...p, sections: p.sections.slice(0, -1) };
      },
    },
  },
  {
    id: "INV-PREAMBLE-ZERO",
    faithful: false,
    what: "stand-in: preamble bytes forced to zero - the byte total stops equalling the file",
    reddens: ["C3-no-headings-file"],
    fns: {
      ...SHIPPED,
      parseMarkdown: (t, o) => ({ ...parseMarkdown(t, o), preambleBytes: 0 }),
    },
  },
  {
    id: "INV-PHANTOM-LINE",
    faithful: false,
    what: "stand-in: the trailing-newline bug restored - totalLines and the last endLine inflated by one",
    reddens: ["C6-trailing-newline"],
    fns: {
      ...SHIPPED,
      parseMarkdown: (t, o) => {
        const p = parseMarkdown(t, o);
        if (!t.endsWith("\n") || !p.sections.length) return p;
        const sections = p.sections.map((s, i) => (i === p.sections.length - 1 ? { ...s, endLine: s.endLine + 1 } : s));
        return { ...p, totalLines: p.totalLines + 1, sections };
      },
    },
  },
  {
    id: "INV-ALWAYS-DROP-LAST-LINE",
    faithful: false,
    what: "stand-in: over-correction - always subtract one, which is wrong on a file with no trailing newline",
    reddens: ["C7-no-trailing-newline"],
    fns: {
      ...SHIPPED,
      parseMarkdown: (t, o) => {
        const p = parseMarkdown(t, o);
        if (t.endsWith("\n") || !p.sections.length) return p;
        const sections = p.sections.map((s, i) => (i === p.sections.length - 1 ? { ...s, endLine: s.endLine - 1 } : s));
        return { ...p, totalLines: p.totalLines - 1, sections };
      },
    },
  },
  {
    id: "INV-ROLLUP-DROPS-CHILDREN",
    faithful: false,
    what: "stand-in: rollUp filters by depth without absorbing children - the under-reporting parent",
    reddens: ["R1-rollup-preserves-bytes", "R2-rollup-extends-range"],
    fns: { ...SHIPPED, rollUp: (sections, depth) => sections.filter((s) => s.level <= depth).map((s) => ({ ...s, children: 0 })) },
  },
  {
    id: "INV-ROLLUP-IGNORES-DEPTH",
    faithful: false,
    what: "stand-in: rollUp always collapses to level 1 whatever depth is asked for",
    reddens: ["R3-rollup-depth6-is-identity"],
    fns: { ...SHIPPED, rollUp: (sections) => rollUp(sections, 1) },
  },
];

// --- corpus mode ----------------------------------------------------------
/**
 * The fixtures prove the parser discriminates. They cannot prove it works on real
 * prose, and the tool's one promise is that a printed line range can be handed to
 * Read and will contain what the outline said. So `--corpus <file-or-dir>` runs
 * every .md under the path (skipping .git and node_modules) through four
 * assertions, of which the second is the load-bearing one.
 *
 *   1 COVERAGE   checkCoverage is clean.
 *   2 LANDING    every section's startLine, used as a Read offset, LANDS ON A
 *                HEADING LINE. This is the off-by-one detector, and it is not
 *                circular: it takes the integer the tool would print, indexes
 *                the raw line array with it, and asks whether that line is
 *                actually a heading.
 *   3 REASSEMBLY preamble + every section text, concatenated, is BYTE-IDENTICAL
 *                to the file. Stronger than the byte-sum canary, which a
 *                double-count and an omission of the same size would satisfy.
 *   4 SPAN       the section's own line count equals endLine - startLine + 1,
 *                i.e. the `limit` the tool prints fetches exactly the section.
 *
 * CANARIES, because a corpus run that scanned nothing reads identically to a
 * clean one: it refuses unless it scanned at least `--min-files` files (default
 * 1), and unless at least one contained a fence and at least one is a file where
 * the fence handling changes the answer - otherwise a parser with no fence
 * handling at all would score identically.
 */
const DEFAULT_MIN_FILES = 1;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function collectMarkdown(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let info;
    try {
      info = statSync(current);
    } catch {
      continue;
    }
    if (info.isFile()) {
      if (/\.md$/i.test(current)) found.push(current);
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      stack.push(join(current, entry.name));
    }
  }
  return found.sort();
}

function runCorpus() {
  const at = process.argv.indexOf("--corpus");
  const root = process.argv[at + 1];
  if (!root || root.startsWith("--")) {
    process.stdout.write("corpus: REFUSING - give a file or directory: --corpus <path> [--min-files N]\n");
    process.exitCode = 2;
    return;
  }
  const minAt = process.argv.indexOf("--min-files");
  const minFiles = minAt === -1 ? DEFAULT_MIN_FILES : Number(process.argv[minAt + 1]) || DEFAULT_MIN_FILES;

  const files = collectMarkdown(root);
  const failures = [];
  let scanned = 0;
  let withFences = 0;
  let sectionsChecked = 0;
  let bytesScanned = 0;
  let fenceEffect = 0; // files where strict and naive disagree

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable (a sync conflict mid-write); not a parser finding
    }
    scanned += 1;
    bytesScanned += Buffer.byteLength(text, "utf8");

    const lines = text.split("\n");
    const parsed = parseMarkdown(text);
    if (/^ {0,3}(```|~~~)/m.test(text)) withFences += 1;
    if (parseMarkdown(text, { strict: false }).sections.length !== parsed.sections.length) fenceEffect += 1;

    for (const problem of checkCoverage(parsed)) failures.push(`${file}: COVERAGE ${problem}`);

    let reassembled = "";
    const firstStart = parsed.sections.length ? parsed.sections[0].startLine - 1 : lines.length;
    reassembled += lines.slice(0, firstStart).join("\n");
    if (parsed.sections.length && firstStart > 0) reassembled += "\n";

    for (const s of parsed.sections) {
      sectionsChecked += 1;

      // 2 LANDING - the assertion the whole tool rests on.
      const landed = lines[s.startLine - 1] ?? "";
      if (!/^ {0,3}#{1,6}[ \t]/.test(landed.replace(/\r$/, ""))) {
        failures.push(`${file}: LANDING §${s.index} startLine L${s.startLine} is not a heading line - got: ${landed.slice(0, 60)}`);
      }

      // 4 SPAN - the `limit` the tool prints fetches exactly this section.
      const ownLines = s.text.endsWith("\n") ? s.text.split("\n").length - 1 : s.text.split("\n").length;
      if (ownLines !== s.endLine - s.startLine + 1) {
        failures.push(`${file}: SPAN §${s.index} L${s.startLine}-L${s.endLine} spans ${s.endLine - s.startLine + 1} lines but holds ${ownLines}`);
      }

      reassembled += s.text;
    }

    // 3 REASSEMBLY
    if (reassembled !== text) {
      failures.push(`${file}: REASSEMBLY concatenated sections are not byte-identical to the file (${Buffer.byteLength(reassembled)} vs ${Buffer.byteLength(text)} bytes)`);
    }
  }

  for (const f of failures.slice(0, 25)) process.stdout.write(`  FAIL  ${f}\n`);
  if (failures.length > 25) process.stdout.write(`  ... and ${failures.length - 25} more\n`);

  const mb = (bytesScanned / 1048576).toFixed(1);
  process.stdout.write(`\ncorpus: ${scanned} .md files under ${root}, ${mb} MB, ${sectionsChecked} sections - ${failures.length} failure(s)\n`);
  process.stdout.write(`  canaries: ${withFences} file(s) contain a fence · ${fenceEffect} file(s) where the fence handling CHANGES the answer\n`);

  if (scanned < minFiles) {
    process.stdout.write(`REFUSING: scanned ${scanned} files, below the floor of ${minFiles}. A corpus run that scanned nothing reads exactly like a clean one.\n`);
    process.exitCode = 2;
    return;
  }
  if (withFences === 0) {
    process.stdout.write("REFUSING: no file in the corpus contains a fence, so this run says nothing about the fence handling.\n");
    process.exitCode = 2;
    return;
  }
  if (fenceEffect === 0) {
    process.stdout.write("REFUSING: the fence handling changed the answer on ZERO files, so a parser with none at all would score identically here.\n");
    process.exitCode = 2;
    return;
  }
  if (failures.length) process.exitCode = 1;
}

// --- runner ---------------------------------------------------------------

function runRows(fns) {
  return ROWS.map(([id, side, what, assertion]) => {
    let ok;
    try {
      ok = assertion(fns) === true;
    } catch {
      ok = false; // a throw is a failed row, not a crashed sweep
    }
    return { id, side, what, ok };
  });
}

function main() {
  if (process.argv.includes("--corpus")) return runCorpus();
  const sweep = process.argv.includes("--inversions");
  const results = runRows(SHIPPED);
  const failed = results.filter((r) => !r.ok);
  const deny = results.filter((r) => r.side === "DENY").length;
  const allow = results.filter((r) => r.side === "ALLOW").length;

  for (const r of results) {
    if (!r.ok) process.stdout.write(`  FAIL  ${r.id.padEnd(30)} ${r.what}\n`);
  }
  process.stdout.write(`\noutline proof: ${results.length - failed.length}/${results.length} rows passed (${deny} DENY, ${allow} ALLOW)\n`);

  if (deny === 0 || allow === 0) {
    process.stdout.write("REFUSING to report success: a one-sided row set proves nothing.\n");
    process.exitCode = 1;
    return;
  }
  if (failed.length) {
    process.exitCode = 1;
    return;
  }
  if (!sweep) {
    process.stdout.write("Run with --inversions to check every row can actually fail.\n");
    return;
  }

  // --- the binding sweep ---
  const named = new Set(INVERSIONS.flatMap((i) => i.reddens));
  const unbound = ROWS.map(([id]) => id).filter((id) => !named.has(id));
  const unknown = [...named].filter((id) => !ROWS.some(([rid]) => rid === id));

  process.stdout.write(`\n--- inversion sweep: ${INVERSIONS.length} inversions ---\n`);
  let sweepFailed = 0;
  for (const inv of INVERSIONS) {
    const got = runRows(inv.fns).filter((r) => !r.ok).map((r) => r.id);
    const missing = inv.reddens.filter((id) => !got.includes(id));
    const surprise = got.filter((id) => !inv.reddens.includes(id));
    const tag = inv.faithful ? "faithful" : "STAND-IN";
    process.stdout.write(`  ${inv.id.padEnd(28)} [${tag}] reddened ${got.length}: ${inv.what}\n`);
    if (missing.length) {
      process.stdout.write(`      DID NOT REDDEN (row cannot fail as named): ${missing.join(", ")}\n`);
      sweepFailed += 1;
    }
    if (surprise.length) {
      // Reported, never treated as a pass: an unpredicted red is a finding about
      // the structure of the instrument.
      process.stdout.write(`      also reddened, unpredicted: ${surprise.join(", ")}\n`);
    }
  }

  if (unknown.length) {
    process.stdout.write(`\nREFUSING: inversion names a row that does not exist: ${unknown.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (unbound.length) {
    process.stdout.write(`\nREFUSING: ${unbound.length} row(s) named by no inversion - unbindable rows are not passing rows:\n  ${unbound.join("\n  ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (sweepFailed) {
    process.stdout.write(`\n${sweepFailed} inversion(s) failed to redden what they name.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nsweep: ${INVERSIONS.length} inversions, every row bound, 0 that did not redden exactly what they name.\n`);
}

main();
