#!/usr/bin/env node
/**
 * PreToolUse guard: block a whole-file read of a very large Markdown document.
 *
 * Why: reading a multi-hundred-kilobyte ledger or log whole costs tens of
 * thousands of tokens, while a section map plus one range costs a few hundred.
 * A rule in a documentation file only fires when somebody reads it; a hook fires
 * at the moment of the action.
 *
 * BLOCKS
 *   Read <a .md over the threshold> with NO offset and NO limit
 *   cat / bat / type / Get-Content of the same, with no range flag
 *
 * ALLOWS - every one of these is deliberate, and each has a proof row
 *   Read with offset OR limit at ANY size   the escape hatch, and the whole point
 *   any .md under the threshold
 *   any non-Markdown file                   source and JSON are a different problem
 *   head/tail/sed -n/grep on a big .md      already bounded
 *   a file that does not exist              not ours to judge
 *   an unparseable payload                  never block on our own bug
 *
 * THRESHOLD: `bigDocThresholdBytes` in .claude/a11y/a11y.config.json (default
 * 100000), read at runtime. A missing, unparseable or invalid config falls back
 * to the default. It is a cost floor, not a style rule: set it where one whole
 * read starts to cost more than mapping the document.
 *
 * FAIL-OPEN IS DELIBERATE. Every uncertainty (a missing file, a stat that throws,
 * a payload that will not parse) allows. This guard protects a budget, not a
 * correctness property, so it must never be the reason a task cannot proceed.
 *
 * Proof: node .claude/guards/prove-big-doc-read.mjs
 * See the README section 'Guards'.
 */

import { statSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_THRESHOLD_BYTES = 100_000;

/** Where the shared kit config lives, relative to this guard. */
export const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "a11y",
  "a11y.config.json",
);

/**
 * Read `bigDocThresholdBytes` from the config file. Anything other than a
 * positive finite number - a missing file, bad JSON, a wrong type - yields the
 * default, so a broken config can never turn this guard off or make it throw.
 */
export function loadThreshold(configPath = CONFIG_PATH) {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.bigDocThresholdBytes;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_THRESHOLD_BYTES;
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** Commands that read a whole file. Bounded readers are deliberately absent. */
const WHOLE_FILE_READERS = new Set(["cat", "bat", "type", "Get-Content", "gc"]);

/**
 * Any of these makes a WHOLE-FILE READER bounded, so it is not our business.
 *
 * `-n` and `--lines` are deliberately ABSENT: they bound `head`/`tail`, which are
 * not whole-file readers here, while on `cat` `-n` merely NUMBERS the lines and
 * prints the whole file. Including it would open a silent bypass.
 */
const RANGE_FLAGS = /(^|\s)(-TotalCount|-Tail|-First|-Last|-Head|--line-range)(\s|$)|\|/;

export function fileSize(path, sizeOf = statSync) {
  try {
    return sizeOf(resolve(path)).size;
  } catch {
    return null; // missing or unreadable: not ours to judge
  }
}

/** Decide on a Read tool call. Returns a violation string, or null to allow. */
export function judgeRead(toolInput, sizeOf, threshold = loadThreshold()) {
  const path = toolInput?.file_path;
  if (!path || !MARKDOWN.test(path)) return null;

  // The escape hatch. A bounded read is the behaviour this guard exists to
  // produce, so it is never blocked however large the file is.
  if (toolInput.offset !== undefined || toolInput.limit !== undefined) return null;

  const size = fileSize(path, sizeOf);
  if (size === null || size < threshold) return null;

  return `Read of ${path} (${size.toLocaleString()} bytes, ~${Math.round(size / 4).toLocaleString()} tokens) with no offset or limit`;
}

/**
 * Decide on a Bash/PowerShell command.
 * Only whole-file readers in COMMAND POSITION count, so `grep cat file.md` and
 * `echo cat` are not reads.
 */
export function judgeCommand(command, sizeOf, threshold = loadThreshold()) {
  if (!command) return null;
  for (const segment of String(command).split(/&&|\|\||;|\n/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const verb = tokens[0].replace(/^.*[\\/]/, "");
    if (!WHOLE_FILE_READERS.has(verb)) continue;
    if (RANGE_FLAGS.test(trimmed)) continue; // already bounded

    for (const token of tokens.slice(1)) {
      const arg = token.replace(/^["']|["']$/g, "");
      if (arg.startsWith("-") || !MARKDOWN.test(arg)) continue;
      const size = fileSize(arg, sizeOf);
      if (size !== null && size >= threshold) {
        return `${verb} of ${arg} (${size.toLocaleString()} bytes, ~${Math.round(size / 4).toLocaleString()} tokens)`;
      }
    }
  }
  return null;
}

/**
 * A path with a space must be QUOTED in the suggested commands, or the advice is
 * unrunnable. The Read tool supplies an absolute path, which often contains
 * spaces, while a Bash refusal is usually given a relative one - so a message
 * checked on one tool is not checked on the other.
 */
function shellQuote(path) {
  return /[\s"']/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

export function reason(violation, rawPath) {
  const path = shellQuote(rawPath);
  return [
    `Blocked: ${violation}.`,
    "",
    "Map it first, then read one range (see the README section 'Guards').",
    "",
    `  node .claude/digest/outline.mjs ${path} --depth 2`,
    `  node .claude/digest/outline.mjs ${path} --find "<what you are after>" --body`,
    "",
    "The second prints absolute line numbers. Then read that range:",
    "",
    `  Read ${path} offset=<startLine> limit=<n>`,
    "",
    "A bounded read is NEVER blocked, at any size - that is the escape hatch.",
    "If you genuinely need the whole document, read it in ranges and say why.",
    "The size limit is `bigDocThresholdBytes` in .claude/a11y/a11y.config.json.",
  ].join("\n");
}

// The CLI half only runs when this file IS the entry point, so the proof can
// import the predicates without the stdin handler competing for the stream.
//
// COMPARED AS A RESOLVED URL, NOT WITH endsWith: "prove-big-doc-read.mjs"
// .endsWith("big-doc-read.mjs") is TRUE, so the endsWith form armed the stdin
// handler inside the FIXTURE process, whose process.exit(0) then overwrote the
// fixture's failing exit code (false pass) or hung it. Row A15 and
// INV-ENDSWITH-ENTRY-POINT bind it.
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

    const input = payload?.tool_input ?? {};
    const violation = judgeRead(input) ?? judgeCommand(input.command);
    if (!violation) process.exit(0);

    const path = input.file_path ?? violation.match(/ of (\S+) /)?.[1] ?? "<file>";

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason(violation, path),
        },
      }),
    );
    process.exit(0);
  });
}
