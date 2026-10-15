#!/usr/bin/env node
/**
 * PreToolUse guard: block unscoped recursive filesystem walks.
 *
 * Why: a recursive walk from the project root can be very slow (synced or
 * network drives especially) and blow a tool timeout, while an indexed search
 * answers in seconds. A rule in a documentation file only fires when the file is
 * read; a hook fires at the moment the command is typed.
 *
 * BLOCKS
 *   find ... without -maxdepth
 *   ls -R / ls --recursive
 *   Get-ChildItem/gci/dir -Recurse
 *   dir /s                          (cmd.exe form)
 *   grep -r/-R/--recursive over `.` or with no path
 *
 * ALLOWS
 *   find with -maxdepth, find --help / --version
 *   grep -r <explicit subtree>
 *   rg (ripgrep) in every form      - it is what the Grep tool runs
 *   everything that is not a walk
 *
 * Only the FIRST token of each shell segment is inspected (after interpreter
 * wrappers and benign launchers such as `timeout`/`env` are peeled off), so
 * `grep find`, `git log --grep=find` and paths containing "find" all pass.
 *
 * Fails OPEN on every uncertainty (unparseable payload, odd quoting).
 *
 * THIS FILE HAS NO ENTRY-POINT GATE: the stdin handler at the bottom arms on
 * import as well as on execution. That is safe only because NOTHING IMPORTS IT -
 * the fixture spawns it as a child process. If you ever import it, add a
 * resolved-URL entry-point comparison first (never an `endsWith` test, which
 * matches the fixture's own filename).
 *
 * See the README section 'Guards'.
 */

const ALTERNATIVES = [
  "Grep                     - indexed content search (ripgrep). THE answer for searching file CONTENTS.",
  "Glob                     - indexed filename search; use for anything that might be UNTRACKED (backups, sync-conflict copies, build output).",
  "git ls-files <pattern>   - reads the git index, never touches the filesystem. Tracked files only.",
  "find <dir> -maxdepth N   - allowed, for one explicitly-scoped subtree.",
  "grep -r <dir>            - allowed when <dir> is a real subtree, not `.`.",
];

/**
 * Strip heredoc BODIES before segmenting. A heredoc body is data, not commands:
 * a commit message that describes `find . -name x` must not be read as one.
 */
function stripHeredocs(command) {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    "<<HEREDOC"
  );
}

/** Where a command line may be cut. Two-character tokens FIRST. */
const SPLIT_TOKENS = ["||", "&&", "$(", "|", ";", "\n", "`"];

/**
 * Split a command line into segments that each begin at a command position.
 *
 * QUOTE-AWARE: a plain split on `|`, `;` or a backtick also cuts inside a quoted
 * grep PATTERN, where those characters are data. That fragments the line so the
 * `.` argument lands outside the fragment beginning with `grep` (a walk allowed
 * through), or leaves a scoped search with no path (scoped work refused).
 *
 * Two behaviours worth knowing before calling either a regression:
 * 1. A lone apostrophe OUTSIDE quotes swallows the rest of the line. Correct:
 *    the shell treats the quote as unterminated and never runs the command.
 * 2. An UNTERMINATED heredoc can desynchronise quote state. The failure
 *    direction is a missed split, i.e. fail-open.
 *
 * Quote characters are KEPT in the emitted segment: the grep branch derives
 * `hadQuotedPattern` from them.
 */
function segments(command) {
  const text = stripHeredocs(command);
  const out = [];
  let current = "";
  let single = false;
  let double = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    // Inside double quotes a backslash escapes the next character; inside single
    // quotes it is literal, which is why this is gated on `double`.
    if (double && ch === "\\" && i + 1 < text.length) {
      current += ch + text[i + 1];
      i += 1;
      continue;
    }
    if (ch === "'" && !double) {
      single = !single;
      current += ch;
      continue;
    }
    if (ch === '"' && !single) {
      double = !double;
      current += ch;
      continue;
    }

    if (!single && !double) {
      const token = SPLIT_TOKENS.find((t) => text.startsWith(t, i));
      if (token) {
        out.push(current);
        current = "";
        i += token.length - 1;
        continue;
      }
    }

    current += ch;
  }
  out.push(current);

  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Strip interpreter wrappers so the real command is inspected
 * (`cmd /c`, `powershell -c`, `sh -c` and friends).
 */
function unwrap(segment) {
  let s = segment;
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/^cmd(\.exe)?\s+\/[ck]\s+/i, "")
      .replace(/^(powershell(\.exe)?|pwsh)\s+(-\w+\s+)*-c(ommand)?\s+/i, "")
      // POSIX shells. The flag cluster is matched loosely (`-lc`, `-ec`).
      .replace(/^(sh|bash|dash|zsh|ksh)\s+(-[A-Za-z]+\s+)*-[A-Za-z]*c\s+/i, "")
      // A MATCHED PAIR OF OUTER QUOTES IS STRIPPED TOGETHER: stripping only the
      // leading one leaves a trailing quote glued to the last argument, turning
      // the final `.` into `."` and letting the walk through.
      .replace(/^(["'])([\s\S]*)\1$/, "$2")
      .replace(/^["']/, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Argument-taking launchers that RUN ANOTHER COMMAND, and how to skip past their
 * own flags and operands to reach it. Without this the guard reads `timeout` as
 * the command and never inspects the walk behind it.
 *
 * Two deliberate decisions:
 * 1. `command` IS here, but a LOOKUP is not an execution: `command -v find` runs
 *    nothing, so `lookupFlags` stops the strip.
 * 2. `xargs` is deliberately ABSENT: its paths come from stdin, which a static
 *    check cannot see, and denying it would refuse scoped work such as
 *    `ls docs | xargs grep -rn foo`. A recorded residual beats a false positive.
 *
 * An unrecognised token is treated as the command, so a parse this table cannot
 * handle fails OPEN.
 */
const LAUNCHERS = {
  timeout: {
    valueFlags: ["-k", "-s", "--kill-after", "--signal"],
    // The DURATION is a mandatory positional operand. Tested by shape, so a token
    // that is not a duration is left alone and read as the command.
    operand: /^\d+(\.\d+)?[smhd]?$/,
  },
  env: { valueFlags: ["-u", "--unset", "-C", "--chdir"], operand: null },
  nice: { valueFlags: ["-n", "--adjustment"], operand: null },
  ionice: {
    valueFlags: ["-c", "-n", "-p", "--class", "--classdata", "--pid"],
    operand: null,
  },
  stdbuf: {
    valueFlags: ["-i", "-o", "-e", "--input", "--output", "--error"],
    operand: null,
  },
  time: { valueFlags: [], operand: null },
  nohup: { valueFlags: [], operand: null },
  command: { valueFlags: [], operand: null, lookupFlags: ["-v", "-V", "--version"] },
};

/**
 * Peel benign launcher prefixes off a segment until a real command is in front.
 * Whitespace-split is deliberate; a quoted space inside a launcher flag value
 * desynchronises the skip, which is a miss (fail-open) and not a false positive.
 */
function stripLaunchers(segment) {
  let tokens = segment.split(/\s+/).filter(Boolean);

  for (let round = 0; round < 4 && tokens.length; round += 1) {
    const name = tokens[0].replace(/^.*[\\/]/, "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(LAUNCHERS, name)) break;
    const spec = LAUNCHERS[name];

    let i = 1;
    let lookup = false;
    while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "--") {
      if (spec.lookupFlags && spec.lookupFlags.includes(tokens[i])) lookup = true;
      // `--flag=value` is one token; only the separated form consumes the next.
      i += spec.valueFlags.includes(tokens[i]) ? 2 : 1;
    }
    if (lookup) break; // a lookup runs nothing - leave the segment as it stands
    if (tokens[i] === "--") i += 1;

    // `env VAR=x <walk>` - the same assignments firstToken() strips inline.
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;

    if (spec.operand && i < tokens.length && spec.operand.test(tokens[i])) i += 1;

    if (i >= tokens.length) return ""; // a launcher with nothing left to run
    tokens = tokens.slice(i);
  }

  return tokens.join(" ");
}

/**
 * Interpreters and launchers can nest in either order, so alternate the two to a
 * fixed point. Kept out of unwrap() so one fixture inversion has one subject.
 */
function normalise(segment) {
  let s = segment;
  for (let i = 0; i < 3; i += 1) {
    const next = stripLaunchers(unwrap(s));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** First bare token of a segment, with any leading env assignments stripped. */
function firstToken(segment) {
  const tokens = unwrap(segment).split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return (tokens[i] || "").replace(/^.*[\\/]/, "");
}

/** Returns a reason string if this segment is an unscoped walk, else null. */
function violation(rawSegment) {
  const segment = normalise(rawSegment);
  const cmd = firstToken(segment).toLowerCase();
  if (!cmd) return null;
  const rest = segment.slice(segment.toLowerCase().indexOf(cmd) + cmd.length);

  if (cmd === "find") {
    if (/--help|--version/.test(rest)) return null;
    if (/(^|\s)-maxdepth(\s|$)/.test(rest)) return null;
    return "`find` without -maxdepth walks the whole subtree.";
  }

  if (cmd === "ls") {
    // -R anywhere in a short-flag cluster, or --recursive
    if (/(^|\s)--recursive(\s|$)/.test(rest)) return "`ls --recursive`";
    if (/(^|\s)-[A-Za-z]*R/.test(rest)) return "`ls -R`";
    return null;
  }

  // `grep -r` walks the tree exactly as `find` does. Allowed only when pointed at
  // a real subtree; `.` (or no path at all, which GNU grep reads as the cwd) is
  // the whole-project walk this guard exists to stop.
  //
  // Quoted patterns are stripped BEFORE tokenising, so `grep -rn "foo bar" .` is
  // read as one path argument and not two; otherwise a multi-word pattern looks
  // like a path list and the check silently inverts.
  if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep") {
    if (/--help|--version/.test(rest)) return null;
    // `r` anywhere in a short-flag cluster (so the common `-rn` is caught), not
    // only at its end. Safe for grep: r/R appear in no other short flag it takes.
    const recursive =
      /(^|\s)--recursive(\s|$)/.test(rest) || /(^|\s)-[A-Za-z]*[rR]/.test(rest);
    if (!recursive) return null;

    const hadQuotedPattern = /"[^"]*"|'[^']*'/.test(rest);
    const bare = rest
      .replace(/"[^"]*"/g, " ")
      .replace(/'[^']*'/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !t.startsWith("-"));

    // With an unquoted pattern the first bare token IS the pattern, not a path.
    const paths = hadQuotedPattern ? bare : bare.slice(1);

    if (paths.length === 0) {
      return "`grep -r` with no path searches the whole working directory.";
    }
    if (paths.some((p) => p === "." || p === "./" || p === ".\\")) {
      return "`grep -r` over `.` walks the whole project.";
    }
    return null;
  }

  if (cmd === "get-childitem" || cmd === "gci" || cmd === "dir" || cmd === "ci") {
    if (/(^|\s)-recurse\b/i.test(rest)) return "`-Recurse`";
    if (/(^|\s)\/s\b/i.test(rest)) return "`dir /s`";
    return null;
  }

  return null;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    process.exit(0); // unparseable payload: never block on our own bug
  }
  if (!command) process.exit(0);

  const hits = segments(command).map(violation).filter(Boolean);
  if (hits.length === 0) process.exit(0);

  const reason = [
    `Blocked: ${hits[0]}`,
    "",
    "A recursive walk from the project root can be very slow and may blow the",
    "tool timeout. See the README section 'Guards'.",
    "",
    "Use instead:",
    ...ALTERNATIVES.map((a) => `  ${a}`),
    "",
    "Pick by whether the file might be UNTRACKED: git ls-files cannot see",
    "untracked files, so it reports clean by construction and is the wrong tool",
    "for a stray-backup or conflict-copy check. Use Glob for that.",
  ].join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
});
