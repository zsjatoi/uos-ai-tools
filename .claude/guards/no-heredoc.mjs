#!/usr/bin/env node
/**
 * PreToolUse guard: block multi-line content inlined into a shell command.
 *
 * Why: content routed through a shell parser can be corrupted. A POSIX heredoc
 * fails LOUDLY and INTERMITTENTLY (a long single-quoted body died on an ordinary
 * apostrophe, and the mechanism was never isolated). A PowerShell here-string
 * fails SILENTLY: it corrupts the text while the command succeeds (for example a
 * `\\b` collapsing to a backspace character). Content written by a file tool
 * never reaches a shell parser, whatever the parser's problem turns out to be.
 * A hook fires at the moment of the action, which a rule in a document does not.
 *
 * BLOCKS
 *   << DELIM / <<-DELIM / <<'DELIM' / <<"DELIM"   with a body of 2+ lines
 *   @'...'@ and @"..."@ (PowerShell here-strings)  with a body of 2+ lines
 *   node -e|--eval|-p, python[3] -c, pwsh|powershell -Command|-c, and the same
 *   inside cmd /c or sh -c "..."                   with a quoted argument containing
 *                                                  a newline
 *
 * ALLOWS - every one is deliberate, and each has a fixture row
 *   <<< herestrings                 one value, no multi-line parser gauntlet
 *   a single-line heredoc body      not multi-line content; the rule's own scope
 *   << inside a quoted string       data, not an operator
 *   git commit -F <path>            the remedy the rule prescribes
 *   a single-line inline eval of any length or backslash content
 *   an unparseable payload          never block on our own bug
 *
 * FAIL-OPEN IS DELIBERATE: every uncertainty allows (an unparseable payload, an
 * unresolvable quote state, an unterminated construct with nothing after it).
 * This guards a reliability property with a known remedy and must never be the
 * reason a task cannot proceed.
 *
 * Proof: node .claude/guards/prove-no-heredoc.mjs [--inversions]
 * See the README section 'Guards'.
 */

import { pathToFileURL } from "node:url";

/** A body of this many lines or more is the "multi-line content" the rule names. */
export const MULTILINE_BODY_LINES = 2;

/**
 * POSIX heredoc operator, with `<<<` excluded on BOTH sides.
 *
 * THE `<<<` EXCLUSION IS THE TRAP THIS REGEX IS SHAPED AROUND. A herestring is a
 * single value that never spans lines, so blocking it would cost a legitimate
 * tool for no benefit - and `<<<` contains `<<`, so a naive match eats every one
 * of them. Row A1 and INV-HERESTRING-NOT-EXCLUDED bind it.
 *
 * The lookahead sits after the optional `-` so `<<-EOF` still matches.
 */
const HEREDOC_OP = /(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** PowerShell here-string. The opener must be followed by a newline per the spec. */
const PS_HERESTRING = /@(['"])\r?\n([\s\S]*?)^\1@/gm;

/**
 * Is `index` inside an unclosed quote?
 *
 * Only the PREFIX is scanned, which is what makes this tractable: a heredoc body
 * is full of apostrophes that would wreck a whole-command quote scan, but a body
 * sits AFTER the operator and cannot affect whether the operator itself is quoted.
 *
 * Blanking complete quoted spans first would be wrong: in the commonest form,
 * `cat > f << 'EOF'`, the delimiter is quoted and the span opens AFTER the
 * operator. Row A3 asserts the quoted-string case; row D1 asserts the quoted
 * delimiter still fires.
 */
export function inQuoteAt(command, index) {
  let single = false;
  let double = false;
  for (let i = 0; i < index; i += 1) {
    const ch = command[i];
    if (ch === "\\" && double) {
      i += 1; // an escaped char inside "" is data
      continue;
    }
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
  }
  return single || double;
}

/**
 * Count the body lines of a heredoc that opens at `afterOp`.
 * The remainder of the operator's own line is not body. An unterminated heredoc
 * counts everything that follows, so a missing delimiter cannot hide a body.
 */
function heredocBodyLines(command, afterOp, delimiter) {
  const rest = command.slice(afterOp);
  const newline = rest.indexOf("\n");
  if (newline === -1) return 0; // nothing follows the operator at all
  const lines = rest.slice(newline + 1).split("\n");
  const close = lines.findIndex((l) => l.trim() === delimiter);
  const body = close === -1 ? lines : lines.slice(0, close);
  // A trailing empty element from a final newline is not a line of content.
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  return body.length;
}

/** Decide on a Bash/PowerShell command. Returns a violation string, or null. */
export function judgeCommand(command) {
  if (!command) return null;
  const text = String(command);

  for (const match of text.matchAll(HEREDOC_OP)) {
    if (inQuoteAt(text, match.index)) continue; // an operator inside a string is data
    const delimiter = match[2];
    const lines = heredocBodyLines(text, match.index + match[0].length, delimiter);
    if (lines >= MULTILINE_BODY_LINES) {
      return `a heredoc (<<${delimiter}) inlining ${lines} lines of content into a shell command`;
    }
  }

  for (const match of text.matchAll(PS_HERESTRING)) {
    const body = match[2].split("\n").filter((l) => l.trim() !== "");
    if (body.length >= MULTILINE_BODY_LINES) {
      const quote = match[1] === "'" ? "@'...'@" : '@"..."@';
      return `a PowerShell here-string (${quote}) inlining ${body.length} lines of content into a shell command`;
    }
  }

  return judgeInlineEval(text, 0);
}

/**
 * Inline-eval heads: `node -e|--eval|-p`, `python[3] -c`, `pwsh|powershell
 * -Command|-c`, each followed by a quoted argument. A multi-line string inlined
 * this way is the same hazard as a heredoc (escape collapse moves here once
 * heredocs are blocked).
 *
 * `(?<![\w.-])` keeps `mynode -e` and `foo.node -e` out. A head quoted inside a
 * larger string (`grep "node -e '...'"`) is data and is skipped by the caller.
 */
const EVAL_HEAD =
  /(?<![\w.-])((?:node(?:\.exe)?\s+(?:-e|--eval|-p|--print))|(?:python3?(?:\.exe)?\s+-c)|(?:(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?))\s+(['"])/gi;

/** Wrappers whose quoted argument is itself a command line, so it is judged again. */
const EVAL_WRAPPER =
  /(?<![\w.-])(?:cmd(?:\.exe)?\s+\/[ck]|(?:sh|bash|dash|zsh|ksh)\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c)\s+(['"])/gi;

/** Wrappers can nest; three levels is a generous bound. */
const MAX_WRAPPER_DEPTH = 3;

/**
 * The text from `start` to the matching close quote. Inside double quotes a
 * backslash escapes the next character, inside single quotes it is literal. An
 * unterminated argument runs to the end, so a missing quote cannot hide a body.
 */
function quotedArgument(src, start, quote) {
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "\\" && quote === '"') {
      i += 1; // an escaped char inside "" is data
      continue;
    }
    if (src[i] === quote) return src.slice(start, i);
  }
  return src.slice(start);
}

/** Violation string for a multi-line inline-eval argument, or null. */
function judgeInlineEval(src, depth) {
  for (const head of src.matchAll(EVAL_HEAD)) {
    const quoted = inQuoteAt(src, head.index);
    if (quoted) continue; // an eval head inside a string is data, not a command
    const arg = quotedArgument(src, head.index + head[0].length, head[2]);
    if (arg.includes("\n")) {
      const name = head[1].replace(/\s+/g, " ");
      return `a multi-line string inlined into ${name} (${arg.split("\n").length} lines)`;
    }
  }

  if (depth >= MAX_WRAPPER_DEPTH) return null;
  for (const wrap of src.matchAll(EVAL_WRAPPER)) {
    const wrapQuoted = inQuoteAt(src, wrap.index);
    if (wrapQuoted) continue;
    const inner = quotedArgument(src, wrap.index + wrap[0].length, wrap[1]);
    const found = judgeInlineEval(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

export function reason(violation) {
  return [
    `Blocked: ${violation}.`,
    "",
    "Write the content to a file with the Write tool, then point the command at",
    "the path. That removes the shell from the content path entirely - no quoting,",
    "no escaping, no length limit to get right.",
    "",
    "  Write  <path>          the content, unparsed by any shell",
    "  <cmd>  <path>          the command, reading it back",
    "",
    "For a commit message: write the message file with the Write tool (outside the",
    "working tree, so it can never be swept into a commit) and pass that path to",
    "`git commit -F <path>`.",
    "",
    "Why, in one line: a POSIX heredoc fails loudly and intermittently, and a",
    "PowerShell here-string fails silently, corrupting the text while the command",
    "succeeds. See the README section 'Guards'.",
    "",
    "The same rule covers a multi-line string inlined into node -e, python -c or",
    "pwsh -Command: Write the script to a file, then run the path.",
    "",
    "Still allowed: a `<<<` herestring, a single-line heredoc body, and a",
    "single-line inline eval of any length or backslash content.",
  ].join("\n");
}

/**
 * The CLI half only runs when this file IS the entry point, so the proof can
 * import the predicates without the stdin handler competing for the stream.
 *
 * COMPARED AS A RESOLVED URL, NOT WITH endsWith: for a fixture named
 * `prove-<name>.mjs`, `argv[1].endsWith("<name>.mjs")` is TRUE in the fixture too,
 * so the stdin handler would arm inside the proof process and race its exit code.
 */
const isEntryPoint =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      process.exit(0); // unparseable payload: never block on our own bug
    }

    const violation = judgeCommand(payload?.tool_input?.command);
    if (!violation) process.exit(0);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason(violation),
        },
      }),
    );
    process.exit(0);
  });
}
