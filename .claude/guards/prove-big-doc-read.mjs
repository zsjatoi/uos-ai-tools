#!/usr/bin/env node
/**
 * Fixture proof for big-doc-read.mjs.
 *
 * A guard produces no symptom of its own when it is wrong: one that denies
 * nothing and one that denies everything both look like "no findings". So this
 * feeds it cases whose expected disposition is known, in BOTH directions, and an
 * inversion sweep proves every row can actually fail.
 *
 * SIZES AND THE THRESHOLD ARE INJECTED, NEVER READ FROM DISK. Every row passes
 * its own `sizeOf` and `threshold`, so no row depends on a real file's length or
 * on whatever `bigDocThresholdBytes` the local config happens to hold. Only the
 * T rows touch the filesystem, and only temp files they create themselves.
 *
 * Run:        node .claude/guards/prove-big-doc-read.mjs
 * Inversions: node .claude/guards/prove-big-doc-read.mjs --inversions
 * Exit: 0 all rows matched · 1 a row failed · 2 a row is bound by no inversion.
 *
 * See the README section 'Guards'.
 */

import {
  judgeRead,
  judgeCommand,
  reason,
  loadThreshold,
  DEFAULT_THRESHOLD_BYTES,
} from "./big-doc-read.mjs";

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const GUARD_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "big-doc-read.mjs"),
  "utf8",
);

/** A private temp directory for the config files the T rows write. */
const SCRATCH = join(tmpdir(), `bdr-prove-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

function scratchFile(name, content) {
  const path = join(SCRATCH, name);
  writeFileSync(path, content, "utf8");
  return path;
}

/**
 * How many stdin `end` listeners does this guard source install when it is
 * IMPORTED BY A FILE NAMED LIKE THIS FIXTURE? Zero is the correct answer.
 *
 * THE PROBE MUST BE NAMED `prove-big-doc-read.mjs` OR IT MEASURES NOTHING: the
 * property under test is a string test against `process.argv[1]`, so a probe run
 * through `node -e` or under any other filename comes back clean on BOTH the
 * broken and the fixed form. stdin is `ignore` so the child cannot inherit a pipe
 * that never closes (the broken form then hangs).
 */
function stdinListenersOnImport(source) {
  const dir = join(tmpdir(), `bdr-arm-probe-${process.pid}`);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "big-doc-read.mjs"), source, "utf8");
    writeFileSync(
      join(dir, "prove-big-doc-read.mjs"),
      'import "./big-doc-read.mjs";\n' +
        'process.stdout.write(String(process.stdin.listenerCount("end")));\n',
      "utf8",
    );
    const r = spawnSync(process.execPath, [join(dir, "prove-big-doc-read.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    const n = Number.parseInt((r.stdout || "").trim(), 10);
    return Number.isNaN(n) ? -1 : n; // -1: could not measure, which must not read as clean
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A path containing spaces, as the Read tool supplies absolute paths. */
const SPACED = "/home/some user/My Notes/repo/docs/big-ledger.md";

const BIG = 1_316_778;
const SMALL = 4_096;

/** Injected stat: any path containing "big" is over the default threshold. */
const sizeOf = (path) => {
  if (/missing/.test(path)) throw new Error("ENOENT");
  return { size: /big/i.test(path) ? BIG : SMALL };
};

const SHIPPED = {
  judgeRead,
  judgeCommand,
  reason,
  loadThreshold,
  sizeOf,
  threshold: DEFAULT_THRESHOLD_BYTES,
  guardSource: GUARD_SOURCE,
  stdinListenersOnImport,
};

// [id, side, what it defends, (f) -> violation|null]
const ROWS = [
  // --- DENY: the reads this guard exists to stop ---
  ["D1-read-whole", "DENY", "a Read of a big .md with no offset and no limit", (f) => f.judgeRead({ file_path: "docs/big-ledger.md" }, f.sizeOf, f.threshold)],
  ["D2-cat", "DENY", "cat of a big .md", (f) => f.judgeCommand("cat docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["D3-get-content", "DENY", "PowerShell Get-Content of a big .md", (f) => f.judgeCommand("Get-Content docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["D4-bat", "DENY", "bat of a big .md", (f) => f.judgeCommand("bat docs/big-ledger.md", f.sizeOf, f.threshold)],
  // `-n` on cat is not a bound: it numbers the lines and prints the whole file.
  ["D5-cat-dash-n", "DENY", "cat -n NUMBERS the lines and still prints the whole file", (f) => f.judgeCommand("cat -n docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["D6-second-segment", "DENY", "a reader in the SECOND segment of a chained command", (f) => f.judgeCommand("echo hello && cat docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["D7-quoted-path", "DENY", "a quoted path is unwrapped before the extension test", (f) => f.judgeCommand('cat "docs/big-ledger.md"', f.sizeOf, f.threshold)],
  ["D8-path-prefixed-verb", "DENY", "/usr/bin/cat is still cat", (f) => f.judgeCommand("/usr/bin/cat docs/big-ledger.md", f.sizeOf, f.threshold)],

  // --- ALLOW: the escape hatch, and everything that is not this guard's business ---
  ["A1-offset", "ALLOW", "a Read with an offset is NEVER blocked, at any size - the escape hatch", (f) => f.judgeRead({ file_path: "docs/big-ledger.md", offset: 100 }, f.sizeOf, f.threshold)],
  ["A2-limit", "ALLOW", "a Read with a limit is never blocked either", (f) => f.judgeRead({ file_path: "docs/big-ledger.md", limit: 60 }, f.sizeOf, f.threshold)],
  ["A3-small-md", "ALLOW", "a small .md read whole", (f) => f.judgeRead({ file_path: "docs/small-note.md" }, f.sizeOf, f.threshold)],
  ["A4-not-markdown", "ALLOW", "a big NON-markdown file is a different problem, not this guard's", (f) => f.judgeRead({ file_path: "src/big-definitions.js" }, f.sizeOf, f.threshold)],
  ["A5-missing-file", "ALLOW", "a file that does not exist is not ours to judge (fail-open)", (f) => f.judgeRead({ file_path: "docs/big-missing.md" }, f.sizeOf, f.threshold)],
  ["A6-head", "ALLOW", "head is bounded and is not a whole-file reader", (f) => f.judgeCommand("head -50 docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["A7-sed-range", "ALLOW", "sed -n '1,50p' is already bounded", (f) => f.judgeCommand("sed -n '1,50p' docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["A8-grep", "ALLOW", "grep over a big .md returns matching lines, not the file", (f) => f.judgeCommand("grep -n foo docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["A9-piped", "ALLOW", "cat piped into head is bounded by the pipe", (f) => f.judgeCommand("cat docs/big-ledger.md | head -20", f.sizeOf, f.threshold)],
  ["A10-total-count", "ALLOW", "Get-Content -TotalCount is bounded", (f) => f.judgeCommand("Get-Content docs/big-ledger.md -TotalCount 20", f.sizeOf, f.threshold)],
  ["A11-not-command-position", "ALLOW", "cat as an ARGUMENT is not a read - the first-token rule", (f) => f.judgeCommand("echo cat docs/big-ledger.md", f.sizeOf, f.threshold)],
  ["A12-small-cat", "ALLOW", "cat of a small .md", (f) => f.judgeCommand("cat docs/small-note.md", f.sizeOf, f.threshold)],
  ["A13-empty-command", "ALLOW", "an empty command allows rather than throwing", (f) => f.judgeCommand("", f.sizeOf, f.threshold)],
  ["A14-outline-itself", "ALLOW", "the tool this guard recommends must never be blocked by it", (f) => f.judgeCommand("node .claude/digest/outline.mjs docs/big-ledger.md --depth 2", f.sizeOf, f.threshold)],

  // M1/M2 assert the REFUSAL TEXT, not a disposition: the refusal's whole job is
  // to hand back a runnable command, and a disposition row cannot see a bad one.
  ["M1-quotes-spaced-path", "DENY", "a path containing spaces is quoted in the suggested commands, so they can be pasted", (f) => {
    const text = f.reason("Read of x (1 bytes, ~1 tokens)", SPACED);
    return text.includes(`outline.mjs "${SPACED}" --depth 2`) ? "quoted" : null;
  }],
  ["M2-leaves-plain-path-bare", "ALLOW", "a path with no spaces is NOT quoted - the fix must not add noise to the common case", (f) => {
    const text = f.reason("cat of x (1 bytes, ~1 tokens)", "docs/big-ledger.md");
    return text.includes('"docs/big-ledger.md"') ? "wrongly quoted" : null;
  }],

  // A15 is not a disposition row. It asserts that importing the guard does not
  // arm its own CLI half - the property that decides whether THIS FIXTURE CAN
  // REPORT AT ALL, which no row about cat or Read can reach.
  ["A15-does-not-arm-stdin", "ALLOW", "importing the guard must not install a stdin handler that can overwrite this proof's exit code", (f) => {
    const n = f.stdinListenersOnImport(f.guardSource);
    if (n === -1) return "could not measure whether the guard arms stdin";
    return n > 0 ? `the guard armed ${n} stdin end-listener(s) on import` : null;
  }],

  // --- T: the configurable threshold (bigDocThresholdBytes) ---
  // T1: a configured threshold LOWER than SMALL turns a small file into a deny.
  ["T1-config-lowers-threshold", "DENY", "bigDocThresholdBytes read from the config applies at runtime: a 1000-byte limit blocks a 4096-byte .md", (f) => {
    const cfg = scratchFile("t1.json", JSON.stringify({ bigDocThresholdBytes: 1000 }));
    const threshold = f.loadThreshold(cfg);
    return f.judgeRead({ file_path: "docs/small-note.md" }, f.sizeOf, threshold);
  }],
  ["T2-missing-config-defaults", "ALLOW", "a missing config file falls back to the 100000 default (fail-open)", (f) => {
    const threshold = f.loadThreshold(join(SCRATCH, "does-not-exist.json"));
    return threshold === DEFAULT_THRESHOLD_BYTES ? null : `threshold was ${threshold}`;
  }],
  ["T3-unparseable-config-defaults", "ALLOW", "an unparseable config file falls back to the default", (f) => {
    const cfg = scratchFile("t3.json", "{ this is not json");
    const threshold = f.loadThreshold(cfg);
    return threshold === DEFAULT_THRESHOLD_BYTES ? null : `threshold was ${threshold}`;
  }],
  ["T4-invalid-value-defaults", "ALLOW", "a non-positive or non-numeric value is ignored, not used", (f) => {
    const bad = [-5, 0, "abc", null];
    for (const [i, value] of bad.entries()) {
      const cfg = scratchFile(`t4-${i}.json`, JSON.stringify({ bigDocThresholdBytes: value }));
      const threshold = f.loadThreshold(cfg);
      if (threshold !== DEFAULT_THRESHOLD_BYTES) return `value ${JSON.stringify(value)} gave threshold ${threshold}`;
    }
    return null;
  }],
  ["T5-config-raises-threshold", "ALLOW", "a configured threshold HIGHER than BIG lets a big .md through whole", (f) => {
    const cfg = scratchFile("t5.json", JSON.stringify({ bigDocThresholdBytes: 5_000_000 }));
    const threshold = f.loadThreshold(cfg);
    return f.judgeRead({ file_path: "docs/big-ledger.md" }, f.sizeOf, threshold);
  }],
];

/** A sizeOf that reports everything as exactly at the default threshold. */
const allBig = () => ({ size: DEFAULT_THRESHOLD_BYTES });

/** loadThreshold that ignores the file entirely. */
const ignoreConfig = () => DEFAULT_THRESHOLD_BYTES;

/** loadThreshold that does not fail open: lets read/parse errors escape. */
const throwingLoad = (p) => JSON.parse(readFileSync(p, "utf8")).bigDocThresholdBytes;

/** loadThreshold that fails open on errors but trusts whatever value it finds. */
const unvalidatedLoad = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8")).bigDocThresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  } catch {
    return DEFAULT_THRESHOLD_BYTES;
  }
};

const INVERSIONS = [
  {
    id: "INV-ALWAYS-ALLOW",
    faithful: false,
    what: "stand-in: the guard decides nothing - what an inert or mis-wired hook produces",
    reddens: ["D1-read-whole", "D2-cat", "D3-get-content", "D4-bat", "D5-cat-dash-n", "D6-second-segment", "D7-quoted-path", "D8-path-prefixed-verb", "T1-config-lowers-threshold"],
    fns: { ...SHIPPED, judgeRead: () => null, judgeCommand: () => null },
  },
  {
    id: "INV-ALWAYS-DENY",
    faithful: false,
    what: "stand-in: the guard blocks everything - the failure that stops work, which only an ALLOW row catches",
    reddens: ["A1-offset", "A2-limit", "A3-small-md", "A4-not-markdown", "A5-missing-file", "A6-head", "A7-sed-range", "A8-grep", "A9-piped", "A10-total-count", "A11-not-command-position", "A12-small-cat", "A13-empty-command", "A14-outline-itself", "T5-config-raises-threshold"],
    fns: { ...SHIPPED, judgeRead: () => "blocked", judgeCommand: () => "blocked" },
  },
  {
    id: "INV-IGNORE-BOUNDS",
    faithful: true,
    what: "the shipped judgeRead with offset/limit stripped - the escape hatch removed, which would make the guard unusable",
    reddens: ["A1-offset", "A2-limit"],
    fns: { ...SHIPPED, judgeRead: (input, s, t) => judgeRead({ file_path: input.file_path }, s, t) },
  },
  {
    id: "INV-DASH-N-IS-A-BOUND",
    faithful: true,
    what: "-n treated as a bounding flag - the bypass that makes `cat -n <big file>` sail through",
    reddens: ["D5-cat-dash-n"],
    fns: { ...SHIPPED, judgeCommand: (c, s, t) => (/(^|\s)-n(\s|$)/.test(String(c)) ? null : judgeCommand(c, s, t)) },
  },
  {
    id: "INV-ANY-EXTENSION",
    faithful: true,
    what: "the shipped judgeRead with the path renamed to .md - the markdown test dropped",
    reddens: ["A4-not-markdown"],
    fns: { ...SHIPPED, judgeRead: (input, s, t) => judgeRead({ ...input, file_path: String(input.file_path).replace(/\.[^.]+$/, ".md") }, s, t) },
  },
  {
    id: "INV-ANY-TOKEN-POSITION",
    faithful: true,
    what: "the shipped judgeCommand with the leading echo stripped - a reader anywhere counts, not just in command position",
    reddens: ["A11-not-command-position"],
    fns: { ...SHIPPED, judgeCommand: (c, s, t) => judgeCommand(String(c).replace(/^echo\s+/, ""), s, t) },
  },
  {
    id: "INV-NO-RANGE-FLAGS",
    faithful: true,
    what: "the shipped judgeCommand with pipes and bounding flags stripped - an already-bounded read gets blocked",
    reddens: ["A9-piped", "A10-total-count"],
    fns: { ...SHIPPED, judgeCommand: (c, s, t) => judgeCommand(String(c).replace(/\s*\|.*$/, "").replace(/\s-TotalCount\s+\d+/, ""), s, t) },
  },
  {
    id: "INV-NEVER-QUOTE",
    faithful: false,
    what: "stand-in for the unquoted-path defect: the path interpolated raw",
    reddens: ["M1-quotes-spaced-path"],
    fns: { ...SHIPPED, reason: (v, p) => `Blocked: ${v}.\n  node .claude/digest/outline.mjs ${p} --depth 2\n` },
  },
  {
    id: "INV-ALWAYS-QUOTE",
    faithful: false,
    what: "stand-in: every path quoted, space-free ones included - the over-correction M2 exists to catch",
    reddens: ["M2-leaves-plain-path-bare"],
    fns: { ...SHIPPED, reason: (v, p) => `Blocked: ${v}.\n  node .claude/digest/outline.mjs "${p}" --depth 2\n` },
  },
  {
    id: "INV-THRESHOLD-ZERO",
    faithful: true,
    what: "the shipped predicates over a stat that calls everything big - the cost floor removed",
    // A5 is a legitimate red from a stand-in that reaches further than its name
    // suggests: it replaces sizeOf wholesale, so the ENOENT throw that makes A5 an
    // ALLOW row no longer happens.
    reddens: ["A3-small-md", "A5-missing-file", "A12-small-cat"],
    fns: { ...SHIPPED, sizeOf: allBig, threshold: DEFAULT_THRESHOLD_BYTES },
  },
  {
    id: "INV-IGNORE-CONFIG",
    faithful: true,
    what: "loadThreshold ignores the config file: the configurable threshold is not configurable",
    // T1 (a lowered limit stops blocking) and T5 (a raised limit stops allowing)
    // are the two directions of the same defect.
    reddens: ["T1-config-lowers-threshold", "T5-config-raises-threshold"],
    fns: { ...SHIPPED, loadThreshold: ignoreConfig },
  },
  {
    id: "INV-CONFIG-NOT-FAIL-OPEN",
    faithful: true,
    what: "loadThreshold lets a missing or unparseable config throw instead of falling back to the default",
    // T4's invalid values parse fine and come back raw, so T4 reddens too.
    reddens: ["T2-missing-config-defaults", "T3-unparseable-config-defaults", "T4-invalid-value-defaults"],
    fns: { ...SHIPPED, loadThreshold: throwingLoad },
  },
  {
    id: "INV-CONFIG-UNVALIDATED",
    faithful: true,
    what: "loadThreshold fails open on errors but trusts any value it finds, including 0, a negative or a string",
    reddens: ["T4-invalid-value-defaults"],
    fns: { ...SHIPPED, loadThreshold: unvalidatedLoad },
  },
  {
    id: "INV-ENDSWITH-ENTRY-POINT",
    faithful: true,
    what: "the entry-point test by endsWith, which matches this fixture's own filename and arms the guard inside the proof",
    reddens: ["A15-does-not-arm-stdin"],
    fns: {
      ...SHIPPED,
      guardSource: (() => {
        const fixed = `const isEntryPoint =\n  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;`;
        const broken = `const isEntryPoint = process.argv[1] && process.argv[1].endsWith("big-doc-read.mjs");`;
        const hits = GUARD_SOURCE.split(fixed).length - 1;
        if (hits !== 1) {
          // Refuse loudly rather than hand back unpatched source: a drifted anchor
          // patches nothing, reddens nothing, and reads like a row that cannot fail.
          throw new Error(
            `INV-ENDSWITH-ENTRY-POINT anchor matched ${hits} times, expected exactly 1`,
          );
        }
        return GUARD_SOURCE.replace(fixed, broken);
      })(),
    },
  },
];

function runRows(fns) {
  return ROWS.map(([id, side, what, assertion]) => {
    let violation;
    try {
      violation = assertion(fns);
    } catch {
      return { id, side, what, ok: false }; // a throw is a failed row, not a crashed sweep
    }
    const blocked = violation !== null && violation !== undefined;
    return { id, side, what, ok: side === "DENY" ? blocked : !blocked };
  });
}

function main() {
  const sweep = process.argv.includes("--inversions");
  const results = runRows(SHIPPED);
  const failed = results.filter((r) => !r.ok);
  const deny = results.filter((r) => r.side === "DENY").length;
  const allow = results.filter((r) => r.side === "ALLOW").length;

  for (const r of failed) process.stdout.write(`  FAIL  ${r.id.padEnd(30)} ${r.what}\n`);
  process.stdout.write(`\nbig-doc-read proof: ${results.length - failed.length}/${results.length} rows passed (${deny} DENY, ${allow} ALLOW)\n`);

  if (deny === 0 || allow === 0) {
    process.stdout.write("REFUSING: a one-sided row set proves nothing.\n");
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

  const rowIds = new Set(ROWS.map(([id]) => id));
  const named = new Set(INVERSIONS.flatMap((i) => i.reddens));
  const unbound = [...rowIds].filter((id) => !named.has(id));
  const unknown = [...named].filter((id) => !rowIds.has(id));

  process.stdout.write(`\n--- inversion sweep: ${INVERSIONS.length} inversions ---\n`);
  let sweepFailed = 0;
  for (const inv of INVERSIONS) {
    const got = runRows(inv.fns).filter((r) => !r.ok).map((r) => r.id);
    const missing = inv.reddens.filter((id) => !got.includes(id));
    const surprise = got.filter((id) => !inv.reddens.includes(id));
    process.stdout.write(`  ${inv.id.padEnd(28)} [${inv.faithful ? "faithful" : "STAND-IN"}] reddened ${got.length}: ${inv.what}\n`);
    if (missing.length) {
      process.stdout.write(`      DID NOT REDDEN (row cannot fail as named): ${missing.join(", ")}\n`);
      sweepFailed += 1;
    }
    if (surprise.length) {
      process.stdout.write(`      also reddened, unpredicted: ${surprise.join(", ")}\n`);
      sweepFailed += 1;
    }
  }

  if (unknown.length) {
    process.stdout.write(`\nREFUSING: an inversion names a row that does not exist: ${unknown.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (unbound.length) {
    process.stdout.write(`\nREFUSING: ${unbound.length} row(s) named by no inversion - an unbindable row is not a passing row:\n  ${unbound.join("\n  ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (sweepFailed) {
    process.stdout.write(`\n${sweepFailed} inversion(s) failed to redden exactly what they name.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nsweep: ${INVERSIONS.length} inversions, every row bound, 0 that did not redden exactly what they name.\n`);
}

try {
  main();
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
