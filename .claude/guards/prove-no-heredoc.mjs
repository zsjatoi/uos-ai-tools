#!/usr/bin/env node
/**
 * Fixture proof for no-heredoc.mjs.
 *
 * A guard produces no symptom of its own when it is wrong: one that denies
 * nothing and one that denies everything both look like "no findings". So this
 * feeds it cases whose expected disposition is known, in BOTH directions, and an
 * inversion sweep proves every row can actually fail.
 *
 * This guard's characteristic trap is `<<<`: a herestring contains `<<`, so a
 * naive match eats every one of them. A1 and INV-HERESTRING-NOT-EXCLUDED exist
 * for that.
 *
 * TWO KINDS OF INVERSION. A `fns` inversion wraps the shipped predicate - good
 * for the stand-ins that model an inert or over-broad hook. A `patch` inversion
 * SUBSTITUTES TEXT IN THE REAL SOURCE, writes the patched copy to the temp
 * directory (never into the project), and imports that. Only the second can reach
 * a regex baked into the module, which is where this guard's discrimination lives.
 *
 * EVERY PATCH ASSERTS ITS OWN MATCH COUNT AND REFUSES ON ANYTHING BUT 1: a find
 * matching zero leaves the inversion inert and every row it names green. Patches
 * are anchored on the construct itself, never on a neighbouring line.
 *
 * Run:        node .claude/guards/prove-no-heredoc.mjs
 * Inversions: node .claude/guards/prove-no-heredoc.mjs --inversions
 * Exit: 0 all rows matched · 1 a row failed · 2 a row is bound by no inversion.
 *
 * Add a row whenever you touch the guard - including an ALLOW row, so a future
 * over-broad rule reddens instead of silently costing everyone a tool.
 *
 * See the README section 'Guards'.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { judgeCommand, reason, inQuoteAt } from "./no-heredoc.mjs";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "no-heredoc.mjs");
const SOURCE = readFileSync(GUARD, "utf8");

/**
 * How many stdin `end` listeners does this guard source install when it is
 * IMPORTED BY A FILE NAMED LIKE THIS FIXTURE? Zero is the correct answer.
 *
 * If the guard's entry-point test were `endsWith("no-heredoc.mjs")`, it would
 * match "prove-no-heredoc.mjs" too, arm a stdin handler inside the proof, and its
 * `process.exit(0)` could overwrite a failing exit code (a false pass) or hang.
 * This fixture IMPORTS the guard, so the exposure is real.
 *
 * THE PROBE MUST BE NAMED `prove-no-heredoc.mjs` OR IT MEASURES NOTHING: the
 * property is a string test against `process.argv[1]`, so a probe under any other
 * filename comes back clean on BOTH the broken and the fixed form. stdin is
 * `ignore` so the child cannot inherit a pipe that never closes.
 */
function stdinListenersOnImport(source) {
  const dir = join(tmpdir(), `nh-arm-probe-${process.pid}`);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "no-heredoc.mjs"), source, "utf8");
    writeFileSync(
      join(dir, "prove-no-heredoc.mjs"),
      'import "./no-heredoc.mjs";\n' +
        'process.stdout.write(String(process.stdin.listenerCount("end")));\n',
      "utf8",
    );
    const r = spawnSync(process.execPath, [join(dir, "prove-no-heredoc.mjs")], {
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

const SHIPPED = { judgeCommand, reason, inQuoteAt, stdinListenersOnImport, guardSource: SOURCE };

/* ------------------------------------------------------------------ *
 * The cases. `\n` is used deliberately: a heredoc IS a multi-line
 * construct, so every DENY body here has to really span lines.
 * ------------------------------------------------------------------ */

const D1 = "cat > f.md << 'EOF'\nline one\nline two\nEOF";
const D2 = "cat > f.md <<EOF\nline one\nline two\nEOF";
const D3 = "cat > f.md <<-EOF\nline one\nline two\nEOF";
const D4 = "echo start && cat > f.md << 'EOF'\nline one\nline two\nEOF";
const D5 = "git commit -F - << 'EOF'\nsubject line\n\nbody line\nEOF";
const D6 = "$x = @'\nline one\nline two\n'@";
const D7 = '$x = @"\nline one\nline two\n"@';
const D8 = "cat > f.md << 'EOF'\nline one\nline two";
const D9 = 'cat > f.md << "EOF"\nline one\nline two\nEOF';

// A1 must be the shape that DISCRIMINATES. A quoted herestring (`<<<"$x"`) is not
// matched even by the naive regex, because the character after the quote is not a
// delimiter start. A BARE-WORD herestring can be, and only when lines follow it,
// since an operator with nothing after it has a zero-line body.
const A1 = "grep -q y <<<yes\necho next\necho more";
const A2 = "node <<< 'console.log(1)'";
// Likewise A3 needs a body for the quote check to be the thing under test.
const A3 = 'echo "<<EOF"\necho next\necho more';
const A4 = "cat << 'EOF'\nsingle line\nEOF";
const A5 = "git commit -F /tmp/msg.md";
const A6 = "git status";
const A7 = "";
const A8 = "$x = @'\nonly one line\n'@";
const A9 = "cat < f.md";
const A10 = "echo $((1 << 3))";
const A11 = "echo $((count << shift))";

// Inline eval. Bodies really span lines, as above.
const E1 = "node -e '\nconsole.log(1);\nconsole.log(2);\n'";
// The escaped quote sits on the FIRST line on purpose: a scanner that stops at `\"`
// then ends the argument before any newline, so only this placement can redden it.
const E2 = 'node -e "console.log(\\"x\\");\nconsole.log(2);\nconsole.log(3);"';
const E3 = "python -c '\nimport sys\nprint(1)\n'";
const E4 = 'python3 -c "\nimport sys\nprint(1)\n"';
const E5 = "pwsh -Command '\n$x = 1\nWrite-Output $x\n'";
const E6 = 'powershell -Command "\n$x = 1\nWrite-Output $x\n"';
const E7 = "cd x && node -e '\nconsole.log(1);\nconsole.log(2);\n'";
const E8 = "cmd /c \"node -e '\nconsole.log(1);\nconsole.log(2);\n'\"";
const E9 = "python - <<'X'\nX\nnode -e '\nconsole.log(1);\nconsole.log(2);\n'";

const B1 = 'node -e "console.log(1)"';
const B2 = String.raw`python -c "import re; print(re.sub(r'\\s','',x))"`;
const B3 = 'node -p "1+1"';
const B4 = 'cd x &&\nnode -e "console.log(1)"';
const B6 = "for f in a b; do\n  echo $f\ndone";
const B7 = 'grep -n "node -e" notes.md';
// A quoted eval head whose text spans lines is data, not a command.
const B8 = "grep -n \"node -e 'one\ntwo'\" notes.md";
// The argument ends at its own close quote; a later line carrying a quote is not part of it.
const B9 = "node -e \"console.log(1)\"\necho 'a\nb'";

// [id, side, what it defends, (f) -> violation|null]
const ROWS = [
  // --- DENY: the commands this guard exists to stop ---
  ["D1-quoted-delim", "DENY", "the commonest form of all: a quoted delimiter must still fire", (f) => f.judgeCommand(D1)],
  ["D2-bare-delim", "DENY", "an unquoted delimiter", (f) => f.judgeCommand(D2)],
  ["D3-dash-form", "DENY", "<<- strips leading tabs and is still a heredoc", (f) => f.judgeCommand(D3)],
  ["D4-second-segment", "DENY", "a heredoc in the SECOND segment of a chained command", (f) => f.judgeCommand(D4)],
  ["D5-commit-stdin", "DENY", "git commit -F - << EOF, a commit message inlined", (f) => f.judgeCommand(D5)],
  ["D6-powershell-single", "DENY", "a PowerShell @'...'@ here-string, the spelling that corrupts SILENTLY", (f) => f.judgeCommand(D6)],
  ["D7-powershell-double", "DENY", 'a PowerShell @"..."@ here-string', (f) => f.judgeCommand(D7)],
  ["D8-unterminated", "DENY", "a missing closing delimiter must not hide a body", (f) => f.judgeCommand(D8)],
  ["D9-double-quoted-delim", "DENY", 'a <<"EOF" delimiter', (f) => f.judgeCommand(D9)],

  ["E1-node-e-single-quote", "DENY", "node -e '...' with a multi-line body", (f) => f.judgeCommand(E1)],
  ["E2-node-e-escaped-quote", "DENY", 'node -e "..." three lines, \\" on the first line', (f) => f.judgeCommand(E2)],
  ["E3-python-c-single", "DENY", "python -c '...' two-plus lines", (f) => f.judgeCommand(E3)],
  ["E4-python3-c-double", "DENY", 'python3 -c "..." multi-line', (f) => f.judgeCommand(E4)],
  ["E5-pwsh-command", "DENY", "pwsh -Command '...' multi-line", (f) => f.judgeCommand(E5)],
  ["E6-powershell-command", "DENY", 'powershell -Command "..." multi-line', (f) => f.judgeCommand(E6)],
  ["E7-eval-second-segment", "DENY", "a multi-line eval after `cd x &&`", (f) => f.judgeCommand(E7)],
  ["E8-eval-in-cmd-c", "DENY", "a multi-line eval inside cmd /c \"...\" - the wrapper unwrap", (f) => f.judgeCommand(E8)],
  ["E9-empty-heredoc-then-eval", "DENY", "an empty heredoc followed by a multi-line eval", (f) => f.judgeCommand(E9)],

  // --- ALLOW: the escape hatches, and everything that is not this guard's business ---
  ["A1-herestring-bare", "ALLOW", "a bare-word <<< herestring with lines after it - THE trap row", (f) => f.judgeCommand(A1)],
  ["A2-herestring-quoted", "ALLOW", "an ordinary quoted <<< herestring", (f) => f.judgeCommand(A2)],
  ["A3-quoted-operator", "ALLOW", "<<EOF inside a quoted string is data, not an operator", (f) => f.judgeCommand(A3)],
  ["A4-single-line-body", "ALLOW", "a one-line body is not multi-line content - the rule's own scope", (f) => f.judgeCommand(A4)],
  ["A5-commit-by-path", "ALLOW", "git commit -F <path> is the remedy this guard prescribes", (f) => f.judgeCommand(A5)],
  ["A6-ordinary", "ALLOW", "an ordinary command with no heredoc anywhere", (f) => f.judgeCommand(A6)],
  ["A7-empty", "ALLOW", "an empty command allows rather than throwing", (f) => f.judgeCommand(A7)],
  ["A8-powershell-single-line", "ALLOW", "a one-line PowerShell here-string, for consistency with A4", (f) => f.judgeCommand(A8)],
  ["A9-plain-redirect", "ALLOW", "a single < is a redirect, not a heredoc", (f) => f.judgeCommand(A9)],
  ["A10-arith-shift", "ALLOW", "<< as an arithmetic left shift on a numeric operand", (f) => f.judgeCommand(A10)],
  ["A11-arith-shift-var", "ALLOW", "<< shifting a NAMED variable, which does look like a delimiter", (f) => f.judgeCommand(A11)],

  ["B1-eval-single-line", "ALLOW", "a single-line node -e", (f) => f.judgeCommand(B1)],
  ["B2-eval-single-backslash", "ALLOW", "a single-line python -c carrying backslashes - allowed", (f) => f.judgeCommand(B2)],
  ["B3-node-p-single", "ALLOW", "node -p with a one-line expression", (f) => f.judgeCommand(B3)],
  ["B4-multiline-cmd-single-eval", "ALLOW", "a command spanning two lines whose eval argument is one line", (f) => f.judgeCommand(B4)],
  ["B6-multiline-no-eval", "ALLOW", "a multi-line for loop with no inline eval at all", (f) => f.judgeCommand(B6)],
  ["B7-grep-for-eval-text", "ALLOW", "grep for the literal text `node -e` is not an eval", (f) => f.judgeCommand(B7)],
  ["B8-quoted-eval-is-data", "ALLOW", "a multi-line quoted string that contains an eval head is data", (f) => f.judgeCommand(B8)],
  ["B9-arg-ends-at-close-quote", "ALLOW", "a later line carrying a quote is not part of a one-line eval argument", (f) => f.judgeCommand(B9)],

  // M rows assert the REFUSAL TEXT, not a disposition. A refusal's job is to hand
  // back the action, and a guard that blocks correctly while saying nothing useful
  // still costs somebody a tool. A DISPOSITION ROW CANNOT SEE THIS.
  ["M1-names-the-write-tool", "DENY", "the refusal names the Write tool, so the block hands back a route", (f) => {
    const text = f.reason("a heredoc (<<EOF) inlining 2 lines");
    return text.includes("Write tool") ? "named" : null;
  }],
  ["M2-names-the-commit-remedy", "DENY", "the refusal names git commit -F <path>, the case that motivated this rule", (f) => {
    const text = f.reason("a heredoc (<<EOF) inlining 2 lines");
    return text.includes("git commit -F <path>") ? "named" : null;
  }],
  ["M3-names-the-escape-hatch", "DENY", "the refusal says what is STILL ALLOWED, or it reads as a blanket ban", (f) => {
    const text = f.reason("a heredoc (<<EOF) inlining 2 lines");
    return /<<<|single-line/.test(text) ? "named" : null;
  }],

  // A12 is not a disposition row. It asserts that importing the guard does not
  // arm its own CLI half - the property that decides whether THIS FIXTURE CAN
  // REPORT AT ALL. It never calls judgeCommand, so INV-ALWAYS-DENY leaves it green.
  ["A12-does-not-arm-stdin", "ALLOW", "importing the guard must not install a stdin handler that can overwrite this proof's exit code", (f) => {
    const n = f.stdinListenersOnImport(f.guardSource);
    if (n === -1) return "could not measure whether the guard arms stdin";
    return n > 0 ? `the guard armed ${n} stdin end-listener(s) on import` : null;
  }],
];

/* ------------------------------------------------------------------ *
 * Source-patching machinery.
 * ------------------------------------------------------------------ */

const TEMP_FILES = [];

/**
 * Apply [find, replace] pairs to the real guard source, asserting each matches
 * EXACTLY once, and import the result from the temp directory (never the project).
 */
async function loadPatched(id, pairs) {
  let patched = SOURCE;
  for (const [find, replace] of pairs) {
    const hits = patched.split(find).length - 1;
    if (hits !== 1) {
      throw new Error(
        `patch anchor matched ${hits} times, expected exactly 1, in ${id}:\n  ${find}\n` +
          "An anchor that matches 0 leaves the inversion INERT and every row it names green.",
      );
    }
    patched = patched.replace(find, replace);
  }
  const file = join(tmpdir(), `no-heredoc-${id}-${process.pid}-${TEMP_FILES.length}.mjs`);
  writeFileSync(file, patched, "utf8");
  TEMP_FILES.push(file);
  const mod = await import(pathToFileURL(file).href);
  return { ...SHIPPED, judgeCommand: mod.judgeCommand, reason: mod.reason };
}

const INVERSIONS = [
  {
    id: "INV-ALWAYS-ALLOW",
    faithful: false,
    what: "stand-in: the guard decides nothing - what an inert or mis-wired hook produces",
    reddens: ["D1-quoted-delim", "D2-bare-delim", "D3-dash-form", "D4-second-segment", "D5-commit-stdin", "D6-powershell-single", "D7-powershell-double", "D8-unterminated", "D9-double-quoted-delim", "E1-node-e-single-quote", "E2-node-e-escaped-quote", "E3-python-c-single", "E4-python3-c-double", "E5-pwsh-command", "E6-powershell-command", "E7-eval-second-segment", "E8-eval-in-cmd-c", "E9-empty-heredoc-then-eval"],
    fns: { ...SHIPPED, judgeCommand: () => null },
  },
  {
    id: "INV-ALWAYS-DENY",
    faithful: false,
    what: "stand-in: the guard blocks everything - the failure that stops work, which only an ALLOW row catches",
    reddens: ["A1-herestring-bare", "A2-herestring-quoted", "A3-quoted-operator", "A4-single-line-body", "A5-commit-by-path", "A6-ordinary", "A7-empty", "A8-powershell-single-line", "A9-plain-redirect", "A10-arith-shift", "A11-arith-shift-var", "B1-eval-single-line", "B2-eval-single-backslash", "B3-node-p-single", "B4-multiline-cmd-single-eval", "B6-multiline-no-eval", "B7-grep-for-eval-text", "B8-quoted-eval-is-data", "B9-arg-ends-at-close-quote"],
    fns: { ...SHIPPED, judgeCommand: () => "blocked" },
  },
  {
    id: "INV-HERESTRING-NOT-EXCLUDED",
    faithful: true,
    what: "the real regex with both <<< lookarounds removed - the naive match that eats every herestring",
    reddens: ["A1-herestring-bare"],
    patch: [["/(?<!<)<<(?!<)-?[ \\t]*", "/<<-?[ \\t]*"]],
  },
  {
    id: "INV-ONLY-BARE-DELIM",
    faithful: true,
    what: "the real regex with the optional delimiter quotes dropped - the family of mistakes that cannot see << 'EOF'",
    // D4 and D8 also use `<< 'EOF'`, so dropping the optional quotes stops
    // matching them too: five rows, not only the ones whose ids mention a quote.
    reddens: ["D1-quoted-delim", "D4-second-segment", "D5-commit-stdin", "D8-unterminated", "D9-double-quoted-delim"],
    patch: [["(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\\1/g", "()([A-Za-z_][A-Za-z0-9_]*)/g"]],
  },
  {
    id: "INV-NO-DASH-FORM",
    faithful: true,
    what: "the real regex without the optional `-`, so <<-EOF stops matching",
    reddens: ["D3-dash-form"],
    patch: [["<<(?!<)-?[ \\t]*", "<<(?!<)[ \\t]*"]],
  },
  {
    id: "INV-IGNORE-LINE-COUNT",
    faithful: true,
    what: "the threshold lowered to one line - the escape hatch removed, which would block every heredoc including the harmless ones",
    reddens: ["A4-single-line-body", "A8-powershell-single-line"],
    patch: [["export const MULTILINE_BODY_LINES = 2;", "export const MULTILINE_BODY_LINES = 1;"]],
  },
  {
    id: "INV-NO-QUOTE-STRIP",
    faithful: true,
    what: "the quote check bypassed - prose about a heredoc counted as one",
    reddens: ["A3-quoted-operator"],
    patch: [["if (inQuoteAt(text, match.index)) continue;", "if (false) continue;"]],
  },
  {
    id: "INV-REQUIRE-TERMINATOR",
    faithful: true,
    what: "an unterminated heredoc counted as empty - a missing delimiter then hides any body at all",
    reddens: ["D8-unterminated"],
    patch: [["const body = close === -1 ? lines : lines.slice(0, close);", "const body = close === -1 ? [] : lines.slice(0, close);"]],
  },
  {
    id: "INV-NO-POWERSHELL",
    faithful: true,
    what: "the PowerShell here-string loop emptied - the spelling that corrupts silently",
    reddens: ["D6-powershell-single", "D7-powershell-double"],
    patch: [["for (const match of text.matchAll(PS_HERESTRING))", "for (const match of [])"]],
  },
  {
    id: "INV-FIRST-SEGMENT-ONLY",
    faithful: true,
    what: "only the text before the first && examined - a heredoc later in a chain goes unseen",
    reddens: ["D4-second-segment", "E7-eval-second-segment"],
    patch: [["const text = String(command);", "const text = String(command).split(/&&/)[0];"]],
  },
  {
    id: "INV-EVAL-NO-NEWLINE-TEST",
    faithful: true,
    what: "the newline test on the eval argument removed - every inline eval then passes",
    reddens: ["E1-node-e-single-quote", "E2-node-e-escaped-quote", "E3-python-c-single", "E4-python3-c-double", "E5-pwsh-command", "E6-powershell-command", "E7-eval-second-segment", "E8-eval-in-cmd-c", "E9-empty-heredoc-then-eval"],
    patch: [['if (arg.includes("\\n")) {', "if (false) {"]],
  },
  {
    id: "INV-EVAL-NO-QUOTE-SKIP",
    faithful: true,
    what: "the quote-state check on an eval head removed - text ABOUT an eval, inside a string, then counts as one",
    reddens: ["B8-quoted-eval-is-data"],
    patch: [["const quoted = inQuoteAt(src, head.index);", "const quoted = false;"]],
  },
  {
    id: "INV-EVAL-DQ-STOPS-AT-ESCAPE",
    faithful: true,
    what: "the double-quote scanner no longer skips an escaped quote, so the argument ends at the first \\\" and the body goes unseen",
    reddens: ["E2-node-e-escaped-quote"],
    patch: [['if (src[i] === "\\\\" && quote === \'"\') {', "if (false) {"]],
  },
  {
    id: "INV-EVAL-NO-WRAPPER",
    faithful: true,
    what: "the cmd /c, sh -c wrapper recursion emptied - an eval inside a wrapper's quotes is never judged",
    reddens: ["E8-eval-in-cmd-c"],
    patch: [["for (const wrap of src.matchAll(EVAL_WRAPPER))", "for (const wrap of [])"]],
  },
  {
    id: "INV-NEVER-NAME-A-ROUTE",
    faithful: false,
    what: "stand-in: a refusal that forbids without naming the remedy or the escape hatch",
    reddens: ["M1-names-the-write-tool", "M2-names-the-commit-remedy", "M3-names-the-escape-hatch"],
    fns: { ...SHIPPED, reason: (v) => `Blocked: ${v}.` },
  },
  {
    id: "INV-ENDSWITH-ENTRY-POINT",
    faithful: true,
    what: "the entry-point test written with endsWith, which matches THIS FIXTURE'S OWN FILENAME and arms the guard's stdin handler inside the proof",
    reddens: ["A12-does-not-arm-stdin"],
    fns: {
      ...SHIPPED,
      guardSource: (() => {
        const fixed =
          "const isEntryPoint =\n  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;";
        const broken =
          'const isEntryPoint = process.argv[1] && process.argv[1].endsWith("no-heredoc.mjs");';
        const hits = SOURCE.split(fixed).length - 1;
        if (hits !== 1) {
          // Refuse loudly rather than hand back unpatched source: a drifted anchor
          // patches nothing, reddens nothing, and reads like a row that cannot fail.
          throw new Error(
            `INV-ENDSWITH-ENTRY-POINT anchor matched ${hits} times, expected exactly 1`,
          );
        }
        return SOURCE.replace(fixed, broken);
      })(),
    },
  },
];

/* ------------------------------------------------------------------ *
 * Runner.
 * ------------------------------------------------------------------ */

function evaluate(fns) {
  const red = [];
  for (const [id, side, , run] of ROWS) {
    const violation = run(fns);
    const blocked = Boolean(violation);
    if (blocked !== (side === "DENY")) red.push(id);
  }
  return red;
}

function cleanup() {
  for (const f of TEMP_FILES) {
    try {
      rmSync(f);
    } catch {
      /* a leftover temp file is not worth failing a proof over */
    }
  }
}

const out = (s) => process.stdout.write(s);

const baseRed = evaluate(SHIPPED);
for (const [id, side, what, run] of ROWS) {
  const violation = run(SHIPPED);
  const got = violation ? "DENY " : "ALLOW";
  const ok = got.trim() === side ? "ok  " : "FAIL";
  out(`${ok} ${id.padEnd(28)} ${got} ${what}\n`);
}

const denies = ROWS.filter((r) => r[1] === "DENY").length;
const allows = ROWS.length - denies;
out(`\n${ROWS.length} rows - ${denies} DENY, ${allows} ALLOW.\n`);

if (denies === 0 || allows === 0) {
  out("REFUSING: a one-sided row set proves nothing about discrimination.\n");
  cleanup();
  process.exit(1);
}

if (baseRed.length) {
  out(`\n${baseRed.length} row(s) failed: ${baseRed.join(", ")}\n`);
  cleanup();
  process.exit(1);
}

if (!process.argv.includes("--inversions")) {
  out("Run with --inversions to check every row can actually fail.\n");
  cleanup();
  process.exit(0);
}

const ids = new Set(ROWS.map((r) => r[0]));
const named = new Set(INVERSIONS.flatMap((i) => i.reddens));
const unknown = [...named].filter((n) => !ids.has(n));
const unbound = [...ids].filter((i) => !named.has(i));

out(`\n--- inversion sweep: ${INVERSIONS.length} inversions ---\n`);

let sweepFailed = 0;
for (const inv of INVERSIONS) {
  let fns;
  try {
    fns = inv.patch ? await loadPatched(inv.id, inv.patch) : inv.fns;
  } catch (err) {
    out(`FAIL ${inv.id.padEnd(30)} ${err.message}\n`);
    sweepFailed += 1;
    continue;
  }
  const red = evaluate(fns).sort();
  const want = [...inv.reddens].sort();
  const same = red.length === want.length && red.every((r, i) => r === want[i]);
  if (!same) sweepFailed += 1;
  const tag = inv.faithful ? "faithful" : "stand-in";
  out(`${same ? "ok  " : "FAIL"} ${inv.id.padEnd(30)} ${tag}  reddened ${red.length}: ${red.join(", ") || "(none)"}\n`);
  if (!same) out(`     expected exactly: ${want.join(", ")}\n`);
}

if (unknown.length) {
  out(`\nREFUSING: an inversion names a row that does not exist: ${unknown.join(", ")}\n`);
  cleanup();
  process.exit(2);
}

if (unbound.length) {
  out(
    `\nREFUSING: ${unbound.length} row(s) named by no inversion - an unbindable row is not a passing row:\n  ${unbound.join("\n  ")}\n`,
  );
  cleanup();
  process.exit(2);
}

cleanup();

if (sweepFailed) {
  out(`\n${sweepFailed} inversion(s) failed to redden exactly what they name.\n`);
  process.exit(1);
}

out(`\nsweep: ${INVERSIONS.length} inversions, every row bound, 0 that did not redden exactly what they name.\n`);
process.exit(0);
