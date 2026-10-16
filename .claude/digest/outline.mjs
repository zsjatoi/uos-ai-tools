#!/usr/bin/env node
/**
 * outline.mjs - read a big Markdown document by the SECTION, not by the megabyte.
 *
 * Why: reading a multi-hundred-kilobyte ledger or log whole costs tens of
 * thousands of tokens, while its section map is a few kilobytes. The compaction
 * is arithmetic rather than clever: print the outline, pick the section, then
 * Read that line range.
 *
 * This tool does NO summarising, NO scoring and NO network. It never decides what
 * matters - it reports where things are and hands back exact line ranges, so
 * every byte you go on to read is read verbatim. An instrument that silently
 * drops lines is indistinguishable from a clean read.
 *
 * USAGE
 *   node .claude/digest/outline.mjs <file.md>
 *   node .claude/digest/outline.mjs <file.md> --depth 2
 *   node .claude/digest/outline.mjs <file.md> --find "item 130"
 *   node .claude/digest/outline.mjs <file.md> --find "\\bfallback\\b" --body
 *   node .claude/digest/outline.mjs <file.md> --section 42
 *   node .claude/digest/outline.mjs <file.md> --audit
 *
 * THE FENCE IS THE WHOLE CORRECTNESS PROBLEM
 *   A `#` at the start of a line inside a fenced code block is a shell comment,
 *   not a heading, and technical documents are full of shell examples. A naive
 *   /^#+ /  scan INVENTS headings, which shifts every line range after it - so
 *   the outline stays plausible and the ranges are wrong.
 *   `--audit` prints the disagreement between the strict and naive parses on the
 *   file you give it; `prove-outline.mjs` binds that disagreement on a fixture.
 *
 * COVERAGE CANARY
 *   The sections must TILE the file: no gaps, no overlaps, and the byte total
 *   must equal the file size exactly. That is asserted on every run and printed
 *   in the footer. An outline that does not tile is refused (exit 3) rather than
 *   reported, because a parse that lost a region reads exactly like a short doc.
 *
 * Exit: 0 outline printed · 2 usage/ENOENT · 3 coverage canary failed.
 * See the README section 'Guards'.
 */

import { readFileSync, statSync, realpathSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * USAGE LOG - so "are we actually using this?" is answerable after the fact.
 *
 * One line per invocation, appended, in the OS temp directory (override with
 * DIGEST_LOG_HOME) so it never lands inside a synced or version-controlled tree.
 *
 * IT IS ONE-SIDED: it records every time the tool WAS used and cannot record a
 * time it SHOULD have been used and was not. The negative case has its own
 * instrument, the PreToolUse guard .claude/guards/big-doc-read.mjs.
 *
 * Writing never breaks a run: any failure is swallowed.
 */
const LOG_DIR = process.env.DIGEST_LOG_HOME || join(tmpdir(), "claude-digest");
const LOG_FILE = join(LOG_DIR, "usage.log");

function recordUsage(line) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()}\t${line}\n`, "utf8");
  } catch {
    /* a log that cannot be written must never stop the tool */
  }
}

function printUsage(limit = 20) {
  if (!existsSync(LOG_FILE)) {
    process.stdout.write(`digest usage log: none yet at ${LOG_FILE}\n(The tool has not been run on this machine, or has not been run since the log was added.)\n`);
    return;
  }
  const rows = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  process.stdout.write(`digest usage log: ${LOG_FILE}\n${rows.length} invocation(s) on this machine, last ${Math.min(limit, rows.length)}:\n\n`);
  for (const row of rows.slice(-limit)) process.stdout.write(`  ${row}\n`);
  process.stdout.write(
    "\nONE-SIDED: this records when the tool WAS used. It cannot show a big file\nread whole instead - nothing calls this code on that path. The negative case is\ncovered separately by the PreToolUse guard .claude/guards/big-doc-read.mjs.\n",
  );
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-{2,})[ \t]*$/;

/** Byte offset of the start of every line, plus the total byte length. */
function lineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/**
 * Parse a Markdown document into sections.
 *
 * THE OPTIONS EXIST TO BE WRONG, and that is their whole purpose.
 *   `strict: false`      drops fence tracking - the naive parse `--audit` prints.
 *   `headingRe`          swaps the ATX pattern, so a looser one can be measured.
 *   `setextAsHeading`    parses setext underlines instead of merely counting them.
 * They are seams for `prove-outline.mjs`, which drives THIS function through
 * them rather than re-implementing a defect beside it: a harness that computes
 * what the code computes proves nothing about the code.
 */
export function parseMarkdown(text, { strict = true, headingRe = ATX_RE, setextAsHeading = false } = {}) {
  // A file ending in a newline yields a PHANTOM final element from split("\n"),
  // which would inflate totalLines and the LAST section's endLine by one.
  const rawLines = text.split("\n");
  const lines = rawLines.length > 1 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  const offsets = lineOffsets(text);
  const headings = [];
  const setextSuspects = [];

  let fenceChar = null;
  let fenceLen = 0;
  let inFrontMatter = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, "");

    // Front matter: only when the very first line is exactly ---.
    if (i === 0 && line.trim() === "---") {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (line.trim() === "---") inFrontMatter = false;
      continue;
    }

    if (strict) {
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const [, marker, info] = fence;
        const char = marker[0];
        if (fenceChar === null) {
          fenceChar = char;
          fenceLen = marker.length;
        } else if (char === fenceChar && marker.length >= fenceLen && info.trim() === "") {
          fenceChar = null;
          fenceLen = 0;
        }
        continue;
      }
      if (fenceChar !== null) continue;
    }

    const atx = headingRe.exec(line);
    if (atx) {
      headings.push({ level: atx[1].length, title: atx[2].trim(), line: i });
      continue;
    }

    // Setext canary. Not parsed as a heading - COUNTED, so a document that uses
    // them cannot be silently mis-outlined by a tool that only reads ATX.
    if (strict && SETEXT_RE.test(line) && i > 0) {
      const prev = lines[i - 1].replace(/\r$/, "");
      if (prev.trim() !== "" && !headingRe.test(prev) && !FENCE_RE.test(prev)) {
        if (setextAsHeading) {
          headings.push({ level: line.trim().startsWith("=") ? 1 : 2, title: prev.trim(), line: i - 1 });
        } else {
          setextSuspects.push(i);
        }
      }
    }
  }

  const totalBytes = Buffer.byteLength(text, "utf8");
  const sections = [];

  const firstHeadingLine = headings.length ? headings[0].line : lines.length;
  const preambleBytes = Buffer.byteLength(text.slice(0, offsets[firstHeadingLine] ?? totalBytes), "utf8");

  for (let h = 0; h < headings.length; h += 1) {
    const start = headings[h].line;
    const endExclusive = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    const startOffset = offsets[start];
    const endOffset = h + 1 < headings.length ? offsets[endExclusive] : text.length;
    sections.push({
      index: h + 1,
      level: headings[h].level,
      title: headings[h].title,
      startLine: start + 1, // 1-indexed, matching the Read tool
      endLine: endExclusive, // inclusive
      bytes: Buffer.byteLength(text.slice(startOffset, endOffset), "utf8"),
      text: text.slice(startOffset, endOffset),
    });
  }

  return {
    sections,
    setextSuspects,
    preambleBytes,
    preambleEndLine: firstHeadingLine, // 0 when the file opens on a heading
    totalBytes,
    totalLines: lines.length,
  };
}

/**
 * The coverage canary. Sections plus preamble must account for every byte and
 * tile the line space without gap or overlap.
 */
export function checkCoverage(parsed) {
  const problems = [];
  const summed = parsed.sections.reduce((n, s) => n + s.bytes, 0) + parsed.preambleBytes;
  if (summed !== parsed.totalBytes) {
    problems.push(`byte total ${summed} does not equal file size ${parsed.totalBytes}`);
  }
  let expectedNextLine = parsed.preambleEndLine + 1;
  for (const s of parsed.sections) {
    if (s.startLine !== expectedNextLine) {
      problems.push(`section ${s.index} starts at L${s.startLine}, expected L${expectedNextLine}`);
    }
    if (s.endLine < s.startLine) {
      problems.push(`section ${s.index} ends (L${s.endLine}) before it starts (L${s.startLine})`);
    }
    expectedNextLine = s.endLine + 1;
  }
  if (parsed.sections.length && expectedNextLine !== parsed.totalLines + 1) {
    problems.push(`sections end at L${expectedNextLine - 1}, file has ${parsed.totalLines} lines`);
  }
  return problems;
}

/**
 * Collapse a section list to `depth`, absorbing each kept section's descendants
 * into its byte total and line range. A section deeper than `depth` never
 * disappears - its bytes move to the nearest kept ancestor - so the rolled-up
 * list still tiles the file, and the sum still equals the file size.
 */
export function rollUp(sections, depth) {
  const kept = [];
  for (const s of sections) {
    if (s.level <= depth) {
      kept.push({ ...s, children: 0 });
      continue;
    }
    const parent = kept[kept.length - 1];
    if (!parent) continue; // a deep heading before any shallow one: no ancestor
    parent.bytes += s.bytes;
    parent.endLine = Math.max(parent.endLine, s.endLine);
    parent.text += s.text;
    parent.children += 1;
  }
  return kept;
}

const human = (n) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(2)}M`);

// Crude and labelled as such: bytes/4. Not a model tokenizer, and only ever
// used to say "whole file" against "this section", where the ratio is the point.
const estTokens = (bytes) => Math.round(bytes / 4);

function usage(message) {
  if (message) process.stderr.write(`outline: ${message}\n\n`);
  process.stderr.write(
    [
      "Usage: node .claude/digest/outline.mjs <file.md> [options]",
      "",
      "  --depth N        only show headings at level N or shallower",
      "  --find <regex>   only sections whose heading or body matches (case-insensitive)",
      "  --body           with --find, also print the matching lines",
      "  --section N      print one section's line range and its first lines",
      "  --audit          report the strict-vs-naive heading disagreement on this file",
      "  --usage [N]      show the last N invocations logged on this machine",
      "",
    ].join("\n"),
  );
  process.exitCode = 2;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return usage();
  if (args[0] === "--usage") return printUsage(Number(args[1]) || 20);

  const file = args[0];
  const opt = { depth: 6, find: null, body: false, section: null, audit: false };
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--depth") opt.depth = Number(args[++i]);
    else if (a === "--find") opt.find = args[++i];
    else if (a === "--body") opt.body = true;
    else if (a === "--section") opt.section = Number(args[++i]);
    else if (a === "--audit") opt.audit = true;
    else return usage(`unknown option ${a}`);
  }

  let text;
  try {
    text = readFileSync(file, "utf8");
    statSync(file);
  } catch (error) {
    return usage(`cannot read ${file} - ${error.message}`);
  }

  const mode = opt.audit ? "audit" : opt.section !== null ? `section ${opt.section}` : opt.find ? `find /${opt.find}/${opt.body ? " --body" : ""}` : `depth ${opt.depth}`;
  recordUsage(`${file}\t${statSync(file).size} bytes\t${mode}`);

  const parsed = parseMarkdown(text);
  const problems = checkCoverage(parsed);
  if (problems.length) {
    process.stderr.write(`outline: COVERAGE CANARY FAILED for ${file}\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write("Refusing to print an outline that does not tile the file.\n");
    process.exitCode = 3;
    return;
  }

  const out = [];
  out.push(`${basename(file)} - ${human(parsed.totalBytes)}, ${parsed.totalLines} lines, ${parsed.sections.length} sections, ~${estTokens(parsed.totalBytes).toLocaleString()} tokens whole`);

  if (opt.audit) {
    const naive = parseMarkdown(text, { strict: false });
    const extra = naive.sections.length - parsed.sections.length;
    out.push(`  --audit: strict ${parsed.sections.length} headings, naive ${naive.sections.length} (naive over-counts by ${extra})`);
    if (extra > 0) {
      const strictLines = new Set(parsed.sections.map((s) => s.startLine));
      const phantoms = naive.sections.filter((s) => !strictLines.has(s.startLine)).slice(0, 8);
      for (const p of phantoms) out.push(`    phantom L${p.startLine}: ${p.title.slice(0, 70)}`);
    }
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  if (opt.section !== null) {
    const s = parsed.sections.find((x) => x.index === opt.section);
    if (!s) return usage(`no section ${opt.section} (file has ${parsed.sections.length})`);
    out.push(`  §${s.index} L${s.startLine}-L${s.endLine} · ${human(s.bytes)} · ~${estTokens(s.bytes).toLocaleString()} tokens`);
    out.push(`  Read ${file} offset=${s.startLine} limit=${s.endLine - s.startLine + 1}`);
    out.push("");
    out.push(...s.text.split("\n").slice(0, 30));
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  // A depth-limited view must ROLL UP its children, or a parent whose content
  // all lives in its subsections reports a handful of bytes and the reader picks
  // a line range that contains nothing.
  let shown = rollUp(parsed.sections, opt.depth);
  let matcher = null;
  if (opt.find) {
    try {
      matcher = new RegExp(opt.find, "i");
    } catch (error) {
      return usage(`bad --find regex - ${error.message}`);
    }
    shown = shown.filter((s) => matcher.test(s.title) || matcher.test(s.text));
    out.push(`  --find /${opt.find}/i matched ${shown.length} of ${parsed.sections.length} sections`);
  }

  // THE PREAMBLE IS NOT A SECTION, SO --find WOULD NOT SEE IT, AND ON A
  // HEADING-LESS FILE THE PREAMBLE IS THE WHOLE DOCUMENT. Any match above the
  // first heading of any document would otherwise be invisible to --find.
  if (matcher && parsed.preambleEndLine > 0) {
    const preambleLines = text.split("\n").slice(0, parsed.preambleEndLine);
    const hits = preambleLines.map((line, i) => [i + 1, line]).filter(([, line]) => matcher.test(line));
    if (hits.length) {
      out.push(`  preamble L1-L${parsed.preambleEndLine}   [${hits.length} line${hits.length === 1 ? "" : "s"}]`);
      if (opt.body) {
        for (const [n, line] of hits) out.push(`         L${n}: ${line.trim().slice(0, 160)}`);
      }
    }
  }

  for (const s of shown) {
    const indent = "  ".repeat(Math.max(0, s.level - 1));
    const kids = s.children ? ` (+${s.children})` : "";
    let row = `  §${String(s.index).padStart(3)} L${String(s.startLine).padStart(5)}-${String(s.endLine).padEnd(5)} ${human(s.bytes).padStart(6)}${kids.padEnd(6)} ${indent}${"#".repeat(s.level)} ${s.title}`;
    if (matcher) {
      const hits = s.text.split("\n").filter((l) => matcher.test(l));
      row += `   [${hits.length} line${hits.length === 1 ? "" : "s"}]`;
      out.push(row);
      if (opt.body) {
        for (const [n, line] of s.text.split("\n").entries()) {
          if (matcher.test(line)) out.push(`         L${s.startLine + n}: ${line.trim().slice(0, 160)}`);
        }
      }
    } else {
      out.push(row);
    }
  }

  const shownBytes = shown.reduce((n, s) => n + s.bytes, 0);
  out.push("");

  // A HEADING-LESS FILE IS A REAL CASE AND THE MAP IS USELESS FOR IT, so say so
  // rather than printing "0 sections" and leaving the reader to work it out.
  if (parsed.sections.length === 0) {
    out.push(`  NO HEADINGS - this file has no ATX headings, so there is no section map to give you.`);
    out.push(`  Use --find "<regex>" --body for absolute line numbers, or read a range directly:`);
    out.push(`  Read ${file} offset=1 limit=200`);
    out.push("");
  }

  out.push(`  coverage: OK - ${parsed.sections.length} sections tile L${parsed.preambleEndLine + 1}-L${parsed.totalLines}, ${human(parsed.totalBytes)} accounted for`);
  if (parsed.preambleBytes > 0) out.push(`  preamble: L1-L${parsed.preambleEndLine} · ${human(parsed.preambleBytes)} (before the first heading)`);
  if (parsed.setextSuspects.length) {
    out.push(`  WARNING: ${parsed.setextSuspects.length} possible setext heading(s) - NOT parsed as headings (first at L${parsed.setextSuspects[0] + 1})`);
  }
  out.push(`  listed ${shown.length} section(s), ${human(shownBytes)} · reading those instead of the file: ~${estTokens(shownBytes).toLocaleString()} vs ~${estTokens(parsed.totalBytes).toLocaleString()} tokens`);

  process.stdout.write(out.join("\n") + "\n");
}

// Only drive the CLI when this file IS the entry point. The proof imports
// parseMarkdown/rollUp/checkCoverage, and an unguarded main() would print usage
// on import and set a non-zero exit code the proof would then have to undo.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv);
}
