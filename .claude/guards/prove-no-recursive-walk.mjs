#!/usr/bin/env node
/**
 * Fixture proof for no-recursive-walk.mjs.
 *
 * A guard produces no symptom of its own when it is wrong: one that denies
 * nothing and one that denies everything both look like "no findings". So this
 * feeds it cases whose expected disposition is known, in BOTH directions, and an
 * inversion sweep proves every row can actually fail.
 *
 * Run:        node .claude/guards/prove-no-recursive-walk.mjs
 * Inversions: node .claude/guards/prove-no-recursive-walk.mjs --inversions
 * Exit: 0 every row matched · 1 a row failed · 2 a row is bound by no inversion.
 *
 * Add a row whenever you touch the guard - including an ALLOW row, so a future
 * over-broad rule reddens instead of silently costing everyone a tool.
 *
 * The guard has no exported surface and is driven over stdin, so each inversion
 * substitutes text in the real source, writes the patched copy to the temp
 * directory (never into the project), and spawns that. EVERY PATCH ASSERTS ITS
 * OWN MATCH COUNT AND REFUSES ON ANYTHING BUT 1: a find matching zero leaves the
 * inversion inert and every row it names green. Anchors sit on the construct
 * itself, never on a neighbouring line.
 *
 * See the README section 'Guards'.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "no-recursive-walk.mjs");
const SOURCE = readFileSync(GUARD, "utf8");

// [id, command, expected disposition, what the row is defending]
const CASES = [
  // --- grep: the walk, and its escape hatch ---
  ["G1-rn-quoted", 'grep -rn "foo" .', "DENY", "recursive over the root, quoted pattern"],
  ["G2-rn-unquoted", "grep -rn foo .", "DENY", "recursive over the root, unquoted pattern"],
  ["G3-rn-multiword", 'grep -rn "foo bar" .', "DENY", "a multi-word quoted pattern must not read as a path list"],
  ["G4-no-path", "grep -r foo", "DENY", "recursive with no path argument searches the cwd"],
  ["G5-capital-R", 'grep -R --include=*.js "x" .', "DENY", "-R over ."],
  ["A1-not-recursive", 'grep -n "foo" README.md', "ALLOW", "not recursive"],
  ["A2-explicit-subtree", 'grep -rn "foo" docs/guides', "ALLOW", "recursive over one explicit subtree"],
  ["A3-help", "grep --help", "ALLOW", "help text"],
  // A10 carries a recursive flag as well, so the help hatch is the only thing
  // standing between it and a denial. A3 alone is over-determined: `--help`
  // contains no recursive flag, so it is allowed for two independent reasons and
  // cannot bind either.
  ["A10-recursive-help", "grep -r --help .", "ALLOW", "help wins even WITH a recursive flag - the row that actually depends on the help hatch"],
  ["A4-rg", "rg -n foo .", "ALLOW", "ripgrep is what the Grep tool runs; never blocked"],
  ["A5-rg-recursive", "rg -rn foo .", "ALLOW", "ripgrep RECURSIVE over the root is still never blocked"],

  // --- find / ls / PowerShell: the original branches ---
  ["F1-find", "find . -name x", "DENY", "find without -maxdepth"],
  ["A6-maxdepth", "find . -maxdepth 2 -name x", "ALLOW", "the depth-limited escape hatch"],
  ["L1-ls-R", "ls -R", "DENY", "ls -R"],
  ["P1-recurse", "Get-ChildItem -Recurse", "DENY", "-Recurse"],
  ["P2-dir-s", "dir /s", "DENY", "the cmd.exe form"],

  // --- things that merely LOOK like walks ---
  ["A7-grep-in-arg", "git log --grep=find", "ALLOW", "the word find inside an argument is not a command"],
  ["A8-not-command-position", "echo grep -r .", "ALLOW", "grep as an argument, not in command position"],
  ["A9-ordinary", "node scripts/build.mjs index.html", "ALLOW", "an ordinary command"],

  // --- wrappers must not launder a walk ---
  ["W1-cmd-grep", 'cmd /c grep -rn "foo" .', "DENY", "cmd /c unwrapping still applies"],
  ["W2-cmd-find", "cmd /c find . -name x", "DENY", "cmd /c unwrapping still applies to find"],
  ["W3-cmd-quoted", 'cmd /c "grep -rn foo ."', "DENY", "a wrapper's QUOTED payload: stripping only the leading quote left `.` as `.\"` and allowed the walk"],

  // --- Q: quoting ---
  // Q1 must carry at least two words before the first pipe: shortened, it still
  // DENIES under a quote-blind splitter, by a route unrelated to the bypass.
  ["Q1-pattern-pipe-and-tick", 'grep -rln "a POSIX heredoc|b or `printf`|c" --include=*.md .', "DENY", "a pipe AND a backtick inside the pattern, over the root (a measured bypass)"],
  ["Q2-real-pipeline", "echo hi | grep -rn foo .", "DENY", "a REAL pipe must still cut - the fix must not simply stop splitting"],
  ["Q3-real-chain", "echo hi && find . -name x", "DENY", "a REAL && must still cut"],
  ["Q4-command-substitution", "echo $(find . -name x)", "DENY", "a REAL $( must still cut - a walk inside a substitution is still a walk"],
  ["Q5-apostrophe-then-chain", `echo "it's fine" ; find . -name x`, "DENY", "an apostrophe inside double quotes must not swallow a later real `;`"],
  ["Q6-apostrophe-in-pattern", `grep -rn "don't" .`, "DENY", "an apostrophe inside double quotes is data, not a quote opener"],
  ["Q7-sh-c", 'sh -c "find . -name x"', "DENY", "sh -c must not launder a walk, the same way cmd /c cannot"],
  ["Q8-bash-c", 'bash -c "grep -rn foo ."', "DENY", "bash -c must not launder a walk either"],
  ["Q9-pipe-pattern-subtree", 'grep -rln "foo|bar" docs', "ALLOW", "a pipe in the pattern left the fragment with no path, so scoped work was refused"],
  ["Q10-semicolon-pattern-subtree", 'grep -rn "a;b" docs/guides', "ALLOW", "a semicolon in the pattern is data too"],
  ["Q11-scoped-then-chain", 'grep -rn "x" docs && echo done', "ALLOW", "a scoped search followed by a real chain stays allowed"],

  // --- X: benign launcher prefixes. Every X row has an XA twin; the twins catch
  // an over-broad fix (a prefix-stripper that reaches too far) that no DENY row can see.
  ["X1-timeout", "timeout 400 find . -name x", "DENY", "the commonest launcher prefix"],
  ["X2-timeout-grep", "timeout 60 grep -rn foo .", "DENY", "the other walker behind the same prefix"],
  ["X3-timeout-flag-operand", "timeout -k 5 400 find . -name x", "DENY", "a flag taking a SEPARATE operand, then the duration, then the walk"],
  ["X4-env", "env find . -name x", "DENY", "env with no assignments at all"],
  ["X5-env-assignment", "env VAR=x find . -name x", "DENY", "the inline VAR=x form is stripped; the env-prefixed one must be too"],
  ["X6-env-value-flag", "env -u FOO find . -name x", "DENY", "-u consumes a separate operand before the command"],
  ["X7-nice", "nice find . -name x", "DENY", "nice"],
  ["X8-nice-value-flag", "nice -n 10 find . -name x", "DENY", "-n consumes a separate operand"],
  ["X9-time", "time find . -name x", "DENY", "time - a shell keyword as well as a binary, and it still runs the walk"],
  ["X10-command", "command find . -name x", "DENY", "command, EXECUTING rather than looking up - see XA6 for the other half"],
  ["X11-stdbuf", "stdbuf -oL find . -name x", "DENY", "a flag with its value ATTACHED, which must not consume the next token"],
  ["X12-ionice", "ionice -c 3 find . -name x", "DENY", "ionice"],
  ["X13-nohup", "nohup find . -name x", "DENY", "nohup"],
  ["X14-wrapper-then-launcher", 'cmd /c "timeout 400 find . -name x"', "DENY", "an interpreter wrapping a launcher - the two must resolve in either order"],
  ["X15-launcher-then-wrapper", "timeout 400 cmd /c find . -name x", "DENY", "a launcher wrapping an interpreter, the same nesting the other way round"],

  ["XA1-timeout-maxdepth", "timeout 60 find . -maxdepth 2 -name x", "ALLOW", "the escape hatch must survive the prefix, or the fix costs a tool"],
  ["XA2-timeout-scoped-grep", 'timeout 60 grep -rn "foo" docs', "ALLOW", "a scoped recursive grep behind a prefix stays allowed"],
  ["XA3-env-maxdepth", "env VAR=x find . -maxdepth 2 -name x", "ALLOW", "the hatch survives env"],
  ["XA4-nice-maxdepth", "nice -n 10 find . -maxdepth 2 -name x", "ALLOW", "the hatch survives nice and its separate operand"],
  ["XA5-time-maxdepth", "time find . -maxdepth 2 -name x", "ALLOW", "the hatch survives time"],
  // XA6 IS THE OVER-STRIP ROW: `command -v find` asks where find lives and runs
  // nothing; a stripper that skipped `-v` as an ordinary flag would deny a safe command.
  ["XA6-command-lookup", "command -v find", "ALLOW", "a LOOKUP is not an execution - the over-strip row, and the direction that costs somebody a tool"],
  ["XA7-stdbuf-maxdepth", "stdbuf -oL find . -maxdepth 2 -name x", "ALLOW", "the hatch survives stdbuf"],
  ["XA8-ionice-maxdepth", "ionice -c 3 find . -maxdepth 2 -name x", "ALLOW", "the hatch survives ionice"],
  ["XA9-nohup-maxdepth", "nohup find . -maxdepth 2 -name x", "ALLOW", "the hatch survives nohup"],
  ["XA10-timeout-help", "timeout --help", "ALLOW", "a launcher asking for its own help runs nothing"],
  ["XA11-launcher-alone", "timeout 400", "ALLOW", "a launcher with nothing after it must not be read as a walk"],
  // XA12 records a deliberate non-fix: xargs takes its paths from stdin, which a
  // static check cannot see, and denying it would refuse scoped work.
  ["XA12-xargs-residual", "echo . | xargs grep -rn foo", "ALLOW", "THE RECORDED RESIDUAL: xargs takes its paths from stdin, so denying it would refuse scoped work"],
  ["XA13-command-maxdepth", "command find . -maxdepth 2 -name x", "ALLOW", "the hatch survives command when it really is executing"],
];

/* ------------------------------------------------------------------ *
 * Driving the guard.
 * ------------------------------------------------------------------ */

/**
 * A guard that cannot run produces EMPTY stdout, which must not be read as
 * "ALLOW" or every ALLOW row passes against a guard that does not exist.
 * CRASH is a third disposition no row expects, so any build that crashes reddens
 * every row at once.
 */
function ask(guardPath, command) {
  const r = spawnSync(process.execPath, [guardPath], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });
  if (r.error || r.status !== 0 || (r.stderr && r.stderr.trim())) {
    const why = (r.stderr || String(r.error || "")).trim().split("\n")[0];
    return { actual: "CRASH", reason: why };
  }
  if (!r.stdout || !r.stdout.trim()) return { actual: "ALLOW", reason: "" };
  try {
    const out = JSON.parse(r.stdout);
    if (out?.hookSpecificOutput?.permissionDecision === "deny") {
      return {
        actual: "DENY",
        reason: (out.hookSpecificOutput.permissionDecisionReason || "").split("\n")[0],
      };
    }
  } catch {
    return { actual: "PARSE-ERROR", reason: "" };
  }
  return { actual: "ALLOW", reason: "" };
}

/** Row ids whose disposition does NOT match expectation, for a given guard build. */
function evaluate(guardPath) {
  const red = [];
  for (const [id, command, expected] of CASES) {
    if (ask(guardPath, command).actual !== expected) red.push(id);
  }
  return red;
}

/* ------------------------------------------------------------------ *
 * Source-patching machinery.
 * ------------------------------------------------------------------ */

const TEMP_FILES = [];

function patchedGuard(id, pairs) {
  let patched = SOURCE;
  for (const [find, replace] of pairs) {
    const hits = patched.split(find).length - 1;
    if (hits !== 1) {
      throw new Error(
        `patch anchor matched ${hits} times, expected exactly 1:\n  ${find.split("\n")[0]}\n` +
          "An anchor matching 0 leaves the inversion INERT and every row it names green.",
      );
    }
    patched = patched.replace(find, replace);
  }
  const file = join(tmpdir(), `no-recursive-walk-${id}-${process.pid}.mjs`);
  writeFileSync(file, patched, "utf8");
  TEMP_FILES.push(file);
  return file;
}

const HITS_LINE = "const hits = segments(command).map(violation).filter(Boolean);";

// Anchored on FUNCTION HEADS, the construct itself, which do not drift.
const SEGMENTS_HEAD = "function segments(command) {";
const NORMALISE_HEAD = "function normalise(segment) {";
const GREP_BRANCH = 'if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep") {';
const GREP_HELP = `${GREP_BRANCH}\n    if (/--help|--version/.test(rest)) return null;`;

const INVERSIONS = [
  {
    id: "INV-ALWAYS-ALLOW",
    faithful: false,
    what: "stand-in: the guard decides nothing - what an inert or mis-wired hook produces",
    reddens: ["G1-rn-quoted", "G2-rn-unquoted", "G3-rn-multiword", "G4-no-path", "G5-capital-R", "F1-find", "L1-ls-R", "P1-recurse", "P2-dir-s", "W1-cmd-grep", "W2-cmd-find", "W3-cmd-quoted", "Q1-pattern-pipe-and-tick", "Q2-real-pipeline", "Q3-real-chain", "Q4-command-substitution", "Q5-apostrophe-then-chain", "Q6-apostrophe-in-pattern", "Q7-sh-c", "Q8-bash-c", "X1-timeout", "X2-timeout-grep", "X3-timeout-flag-operand", "X4-env", "X5-env-assignment", "X6-env-value-flag", "X7-nice", "X8-nice-value-flag", "X9-time", "X10-command", "X11-stdbuf", "X12-ionice", "X13-nohup", "X14-wrapper-then-launcher", "X15-launcher-then-wrapper"],
    patch: [[HITS_LINE, "const hits = [];"]],
  },
  {
    id: "INV-ALWAYS-DENY",
    faithful: false,
    what: "stand-in: the guard blocks everything - the failure that stops work, which only an ALLOW row catches",
    reddens: ["A1-not-recursive", "A2-explicit-subtree", "A3-help", "A4-rg", "A5-rg-recursive", "A6-maxdepth", "A7-grep-in-arg", "A8-not-command-position", "A9-ordinary", "A10-recursive-help", "Q9-pipe-pattern-subtree", "Q10-semicolon-pattern-subtree", "Q11-scoped-then-chain", "XA1-timeout-maxdepth", "XA2-timeout-scoped-grep", "XA3-env-maxdepth", "XA4-nice-maxdepth", "XA5-time-maxdepth", "XA6-command-lookup", "XA7-stdbuf-maxdepth", "XA8-ionice-maxdepth", "XA9-nohup-maxdepth", "XA10-timeout-help", "XA11-launcher-alone", "XA12-xargs-residual", "XA13-command-maxdepth"],
    patch: [[HITS_LINE, 'const hits = ["stand-in"];']],
  },
  {
    id: "INV-FLAG-AT-CLUSTER-END",
    faithful: true,
    what: "the recursive-flag test anchored to the end of the short-flag cluster, so -r and -R match and -rn does not",
    reddens: ["G1-rn-quoted", "G2-rn-unquoted", "G3-rn-multiword", "W1-cmd-grep", "Q1-pattern-pipe-and-tick", "Q2-real-pipeline", "Q6-apostrophe-in-pattern", "Q8-bash-c", "W3-cmd-quoted", "X2-timeout-grep"],
    patch: [["/(^|\\s)-[A-Za-z]*[rR]/.test(rest)", "/(^|\\s)-[A-Za-z]*[rR](\\s|$)/.test(rest)"]],
  },
  {
    id: "INV-LOWERCASE-FLAG-ONLY",
    faithful: true,
    what: "the recursive-flag test made case-sensitive, so grep -R stops being a walk",
    reddens: ["G5-capital-R"],
    patch: [["/(^|\\s)-[A-Za-z]*[rR]/.test(rest)", "/(^|\\s)-[A-Za-z]*[r]/.test(rest)"]],
  },
  {
    id: "INV-NO-PATH-IS-FINE",
    faithful: true,
    what: "the no-path branch removed - `grep -r foo` with no argument searches the cwd and would go unseen",
    reddens: ["G4-no-path"],
    patch: [["if (paths.length === 0) {", "if (false) {"]],
  },
  {
    id: "INV-NO-SUBTREE-HATCH",
    faithful: true,
    what: "every recursive grep denied whatever its path - the escape hatch removed, which would cost a legitimate tool",
    reddens: ["A2-explicit-subtree", "Q9-pipe-pattern-subtree", "Q10-semicolon-pattern-subtree", "Q11-scoped-then-chain", "XA2-timeout-scoped-grep"],
    patch: [['if (paths.some((p) => p === "." || p === "./" || p === ".\\\\")) {', "if (paths.length >= 0) {"]],
  },
  {
    id: "INV-NO-MAXDEPTH-HATCH",
    faithful: true,
    what: "the -maxdepth escape hatch removed",
    reddens: ["A6-maxdepth", "XA1-timeout-maxdepth", "XA3-env-maxdepth", "XA4-nice-maxdepth", "XA5-time-maxdepth", "XA7-stdbuf-maxdepth", "XA8-ionice-maxdepth", "XA9-nohup-maxdepth", "XA13-command-maxdepth"],
    patch: [["if (/(^|\\s)-maxdepth(\\s|$)/.test(rest)) return null;", "if (false) return null;"]],
  },
  {
    id: "INV-NO-HELP-HATCH",
    faithful: true,
    what: "the grep help hatch removed. THE ANCHOR IS LONG ON PURPOSE: the one-line form appears in two branches, and the count assertion refuses it",
    reddens: ["A10-recursive-help"],
    patch: [[GREP_HELP, `${GREP_BRANCH}\n    if (false) return null;`]],
  },
  {
    id: "INV-RG-COUNTS-AS-GREP",
    faithful: true,
    what: "ripgrep folded into the grep branch - blocking the very tool the Grep tool runs, and the one the refusal recommends",
    reddens: ["A5-rg-recursive"],
    patch: [[GREP_BRANCH, 'if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg") {']],
  },
  {
    id: "INV-NO-WRAPPER-UNWRAP",
    faithful: true,
    what: "interpreter unwrapping disabled, so `cmd /c` launders a walk past the guard",
    reddens: ["W1-cmd-grep", "W2-cmd-find", "W3-cmd-quoted", "Q7-sh-c", "Q8-bash-c", "X14-wrapper-then-launcher", "X15-launcher-then-wrapper"],
    patch: [["function unwrap(segment) {", "function unwrap(segment) {\n  return segment;"]],
  },
  {
    id: "INV-ANY-TOKEN-POSITION",
    faithful: true,
    what: "a walker's name anywhere in the segment counts, not just in command position - the over-broad reading that makes prose about a command into a command",
    reddens: ["A7-grep-in-arg", "A8-not-command-position", "XA6-command-lookup", "XA12-xargs-residual"],
    patch: [[
      "const cmd = firstToken(segment).toLowerCase();",
      'const cmd = (["find", "ls", "grep", "dir"].find((w) => new RegExp(w, "i").test(unwrap(segment))) || firstToken(segment)).toLowerCase();',
    ]],
  },
  {
    id: "INV-NO-FIND-BRANCH",
    faithful: true,
    what: "the find branch removed - the original reason this guard exists",
    reddens: ["F1-find", "W2-cmd-find", "Q3-real-chain", "Q4-command-substitution", "Q5-apostrophe-then-chain", "Q7-sh-c", "X1-timeout", "X3-timeout-flag-operand", "X4-env", "X5-env-assignment", "X6-env-value-flag", "X7-nice", "X8-nice-value-flag", "X9-time", "X10-command", "X11-stdbuf", "X12-ionice", "X13-nohup", "X14-wrapper-then-launcher", "X15-launcher-then-wrapper"],
    patch: [['if (cmd === "find") {', "if (false) {"]],
  },
  {
    id: "INV-NO-LS-BRANCH",
    faithful: true,
    what: "the ls branch removed, so `ls -R` walks unchecked",
    reddens: ["L1-ls-R"],
    patch: [['if (cmd === "ls") {', "if (false) {"]],
  },
  {
    id: "INV-NO-POWERSHELL-BRANCH",
    faithful: true,
    what: "the PowerShell/cmd branch removed - -Recurse and dir /s are the Windows spellings of the same walk",
    reddens: ["P1-recurse", "P2-dir-s"],
    patch: [[
      'if (cmd === "get-childitem" || cmd === "gci" || cmd === "dir" || cmd === "ci") {',
      "if (false) {",
    ]],
  },

  // --- Q: quote-awareness ---
  {
    id: "INV-QUOTE-BLIND-SPLIT",
    faithful: true,
    what: "the quote-blind .split(), which cut on a pipe, semicolon or backtick even inside a quoted grep pattern",
    reddens: ["Q1-pattern-pipe-and-tick", "Q9-pipe-pattern-subtree", "Q10-semicolon-pattern-subtree"],
    patch: [[
      SEGMENTS_HEAD,
      SEGMENTS_HEAD.replace(
        "{",
        "{\n  return stripHeredocs(command).split(/\\|\\||&&|[|;\\n]|\\$\\(|`/).map((s) => s.trim()).filter(Boolean);",
      ),
    ]],
  },
  {
    id: "INV-NEVER-SPLIT",
    faithful: false,
    what: "stand-in: the whole command treated as ONE segment - what an over-corrected fix that simply stopped cutting would produce",
    reddens: ["Q2-real-pipeline", "Q3-real-chain", "Q4-command-substitution", "Q5-apostrophe-then-chain"],
    patch: [[
      SEGMENTS_HEAD,
      SEGMENTS_HEAD.replace("{", "{\n  return [stripHeredocs(command).trim()].filter(Boolean);"),
    ]],
  },
  {
    id: "INV-IGNORE-QUOTE-NESTING",
    faithful: true,
    what: "an apostrophe opens a quote even inside double quotes - so `echo \"it's fine\" ; find ...` swallows the rest of the line",
    reddens: ["Q5-apostrophe-then-chain"],
    patch: [["if (ch === \"'\" && !double) {", "if (ch === \"'\") {"]],
  },
  {
    id: "INV-NO-POSIX-SHELL-UNWRAP",
    faithful: true,
    what: "sh -c and bash -c not unwrapped, so a POSIX shell launders a walk the way cmd /c cannot",
    reddens: ["Q7-sh-c", "Q8-bash-c"],
    patch: [[
      '.replace(/^(sh|bash|dash|zsh|ksh)\\s+(-[A-Za-z]+\\s+)*-[A-Za-z]*c\\s+/i, "")',
      '.replace(/^(?!)/i, "")',
    ]],
  },
  {
    id: "INV-LEADING-QUOTE-ONLY",
    faithful: true,
    what: "only the LEADING quote of a wrapper's payload stripped, leaving `.` as `.\"` so the path test finds it unequal",
    reddens: ["W3-cmd-quoted", "Q8-bash-c"],
    patch: [[
      '.replace(/^(["\'])([\\s\\S]*)\\1$/, "$2")',
      '.replace(/^(?!)/, "")',
    ]],
  },

  // --- X: launcher prefixes ---
  {
    id: "INV-GUARD-CRASHES",
    faithful: false,
    what: "stand-in: the guard cannot run at all. Without a CRASH disposition this reddened only the DENY rows, identical to INV-ALWAYS-ALLOW",
    reddens: CASES.map(([id]) => id),
    patch: [[HITS_LINE, "const hits = ;"]],
  },
  {
    id: "INV-NO-LAUNCHER-STRIP",
    faithful: true,
    what: "no launcher stripping at all, so benign prefixes launder a walk past the guard",
    reddens: ["X1-timeout", "X2-timeout-grep", "X3-timeout-flag-operand", "X4-env", "X5-env-assignment", "X6-env-value-flag", "X7-nice", "X8-nice-value-flag", "X9-time", "X10-command", "X11-stdbuf", "X12-ionice", "X13-nohup", "X14-wrapper-then-launcher", "X15-launcher-then-wrapper"],
    patch: [[
      NORMALISE_HEAD,
      NORMALISE_HEAD.replace("{", "{\n  return unwrap(segment);"),
    ]],
  },
  {
    id: "INV-NO-DURATION-SKIP",
    faithful: true,
    what: "timeout's mandatory DURATION operand no longer skipped, so the duration is read as the command and the walk behind it goes unseen",
    reddens: ["X1-timeout", "X2-timeout-grep", "X3-timeout-flag-operand", "X14-wrapper-then-launcher", "X15-launcher-then-wrapper"],
    patch: [["operand: /^\\d+(\\.\\d+)?[smhd]?$/,", "operand: null,"]],
  },
  {
    id: "INV-NO-VALUE-FLAG-SKIP",
    faithful: true,
    what: "flags that take a SEPARATE operand treated as valueless, so the operand is read as the command",
    reddens: ["X3-timeout-flag-operand", "X6-env-value-flag", "X8-nice-value-flag", "X12-ionice"],
    patch: [["i += spec.valueFlags.includes(tokens[i]) ? 2 : 1;", "i += 1;"]],
  },
  {
    id: "INV-COMMAND-NO-LOOKUP-CARVEOUT",
    faithful: true,
    what: "the lookup carve-out removed, so `command -v find` is stripped to `find` and a SAFE command is denied - the over-strip direction, which no DENY row can see",
    reddens: ["XA6-command-lookup"],
    patch: [[
      "if (lookup) break; // a lookup runs nothing - leave the segment as it stands",
      "if (false) break;",
    ]],
  },
  {
    id: "INV-XARGS-AS-LAUNCHER",
    faithful: true,
    what: "the ALTERNATIVE DECISION on xargs, made visible: treating it as a launcher denies `echo . | xargs grep -rn foo` - and would equally deny `ls docs | xargs grep -rn foo`, which is scoped work",
    reddens: ["XA12-xargs-residual"],
    patch: [[
      "  time: { valueFlags: [], operand: null },",
      '  time: { valueFlags: [], operand: null },\n  xargs: { valueFlags: ["-n", "-I", "-P", "-d", "-a", "-s", "-E", "-L"], operand: null },',
    ]],
  },
];

/* ------------------------------------------------------------------ *
 * Runner.
 * ------------------------------------------------------------------ */

const out = (s) => process.stdout.write(s);

function cleanup() {
  for (const f of TEMP_FILES) {
    try {
      rmSync(f);
    } catch {
      /* a leftover temp file is not worth failing a proof over */
    }
  }
}

let pass = 0;
let fail = 0;
const rows = [];

for (const [id, command, expected, why] of CASES) {
  const { actual, reason } = ask(GUARD, command);
  const ok = actual === expected;
  ok ? pass++ : fail++;
  rows.push(`${ok ? "  ok  " : " FAIL "} ${expected.padEnd(5)} ${actual.padEnd(5)} ${id.padEnd(24)} ${command}`);
  if (!ok) {
    rows.push(`         defending: ${why}${reason ? `\n         guard said: ${reason}` : ""}`);
  }
}

const denies = CASES.filter(([, , e]) => e === "DENY").length;

out("exp   got   id                       command\n");
out(`${rows.join("\n")}\n`);
out(
  `\n${pass} passed, ${fail} failed  -  ${denies} DENY rows and ${
    CASES.length - denies
  } ALLOW rows, so neither an always-deny nor an always-allow guard can pass this.\n`,
);

if (fail) {
  cleanup();
  process.exit(1);
}

if (!process.argv.includes("--inversions")) {
  out("Run with --inversions to check every row can actually fail.\n");
  cleanup();
  process.exit(0);
}

const ids = new Set(CASES.map((c) => c[0]));
const named = new Set(INVERSIONS.flatMap((i) => i.reddens));
const unknown = [...named].filter((n) => !ids.has(n));
const unbound = [...ids].filter((i) => !named.has(i));

out(`\n--- inversion sweep: ${INVERSIONS.length} inversions ---\n`);

let sweepFailed = 0;
for (const inv of INVERSIONS) {
  let build;
  try {
    build = patchedGuard(inv.id, inv.patch);
  } catch (err) {
    out(`FAIL ${inv.id.padEnd(28)} ${err.message}\n`);
    sweepFailed += 1;
    continue;
  }
  const red = evaluate(build).sort();
  const want = [...inv.reddens].sort();
  const same = red.length === want.length && red.every((r, i) => r === want[i]);
  if (!same) sweepFailed += 1;
  const tag = inv.faithful ? "faithful" : "stand-in";
  out(`${same ? "ok  " : "FAIL"} ${inv.id.padEnd(28)} ${tag}  reddened ${red.length}: ${red.join(", ") || "(none)"}\n`);
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
