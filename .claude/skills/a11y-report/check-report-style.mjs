#!/usr/bin/env node
// Style checker for accessibility reports.
//
// It finds SIGNATURES, never defects. A hit is a line to look at, not a verdict:
// a curly apostrophe inside quoted page content is correct, and an em dash in a
// sentence you meant to write is fine. What it catches reliably is the thing
// prose rules do not catch on their own: volume.
//
// Usage:
//   node .claude/skills/a11y-report/check-report-style.mjs <file> [<file> ...]
//   node .claude/skills/a11y-report/check-report-style.mjs --json <file>
//
// Exit 0 = no BLOCK-level hits. Exit 1 = at least one. Exit 2 = could not read.

import { readFileSync } from "node:fs";

// --- what counts -----------------------------------------------------------

// Pictographic characters. Deliberately NOT a blanket "non-ASCII" sweep, which
// would flag £, é, ä and the en dash we are told to use for ranges.
//
// Arrow ranges are DELIBERATELY EXCLUDED here and handled by ARROW below. When
// they were in both, every arrow was counted twice and the emoji figure was
// inflated by exactly the arrow count. A trailing variation selector is folded
// into the match rather than counted separately, so "warning sign + VS16" is
// one hit and not two.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]\u{FE0F}?/gu;
const ARROW = /[\u{2190}-\u{21FF}\u{27F5}-\u{27FF}\u{2B05}-\u{2B07}]|->|=>/gu;
const CURLY = /[‘’“”]/g;
const EM_DASH = /—/g;
const BOLD_FIRST_BULLET = /^\s*[-*+]\s+\*\*/;

// AI tells that are matchable without a parser. Each is quoted from the
// accessibility-advocate-style skill's own list.
const TELLS = [
  [/\bit(?:'|’)?s not (?:just )?[^.,;]{2,40}[,.—-]\s*it(?:'|’)?s\b/gi, "negative parallelism (\"it's not X, it's Y\")"],
  [/\bnot because\b[^.]{2,60}\bbut because\b/gi, "negative parallelism (\"not because X, but because Y\")"],
  [/\bthe (?:question|point|issue) (?:is|isn't|is not)\b[^.]{0,40}\.\s*the \1 is\b/gi, "negative parallelism (question/answer)"],
  [/\bhere(?:'|’)?s (?:the (?:thing|kicker)|where it gets)\b/gi, "false suspense"],
  [/\blet(?:'|’)?s (?:break this down|unpack|dive in|explore)\b/gi, "pedagogical filler"],
  [/\b(?:in conclusion|to sum up|in summary)\b/gi, "signposted conclusion"],
  [/\b(?:it(?:'|’)?s worth noting|importantly|notably|interestingly)\b/gi, "empty transition"],
  [/\b(?:delve|utilise|robust|streamline|tapestry|paradigm|synergy)\b/gi, "overused AI vocabulary"],
  // "leverage" and "harness" are banned AS VERBS. Both are ordinary nouns, and
  // "harness" is common in tooling documents (a test harness). A rule that is
  // permanently red on correct usage trains people to ignore the checker, so
  // these match verb form only.
  [
    /\b(?:to|will|can|could|should|would|must|we|they|you|it)\s+(?:leverage|harness)\b|\b(?:leverag|harness)(?:es|ed|ing)\b/gi,
    "overused AI vocabulary (verb form)",
  ],
  [/\b(?:serves as|stands as)\b/gi, "the \"serves as\" dodge"],
  [/\b(?:experts|industry reports|studies) (?:argue|suggest|show)\b/gi, "vague attribution"],
];

// The only severity labels a report may use.
const SEVERITIES = ["Critical", "Serious", "Moderate", "Minor"];

// --- helpers ---------------------------------------------------------------

// Fenced code blocks hold measured output and real markup. Their content is
// evidence, so it is excluded from every prose rule. Returns a parallel array
// marking whether each line sits inside a fence.
function markCodeFences(lines) {
  const inFence = new Array(lines.length).fill(false);
  let open = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) {
      open = !open;
      inFence[i] = true;
      return;
    }
    inFence[i] = open;
  });
  return inFence;
}

const stripInlineCode = (s) => s.replace(/`[^`]*`/g, "");

function countIn(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

// --- the check -------------------------------------------------------------

export function checkReport(source, name = "report") {
  const lines = source.split(/\r?\n/);
  const inFence = markCodeFences(lines);
  const hits = [];

  const prose = lines
    .map((l, i) => (inFence[i] ? "" : stripInlineCode(l)))
    .join("\n");

  const words = prose.split(/\s+/).filter(Boolean).length;

  const add = (level, rule, line, detail) =>
    hits.push({ level, rule, line, detail });

  lines.forEach((raw, i) => {
    if (inFence[i]) return;
    const l = stripInlineCode(raw);
    const n = i + 1;

    for (const ch of l.match(EMOJI) || [])
      add("BLOCK", "emoji-or-pictograph", n, `found ${JSON.stringify(ch)}`);

    for (const a of l.match(ARROW) || [])
      add("BLOCK", "arrow", n, `found ${JSON.stringify(a)} - write the relationship in words`);

    for (const q of l.match(CURLY) || [])
      add("WARN", "curly-quote", n, `found ${JSON.stringify(q)} - use straight quotes unless quoting source text`);

    if (BOLD_FIRST_BULLET.test(raw))
      add("WARN", "bold-first-bullet", n, "every bullet opening bold is an AI tell when repeated");

    for (const [re, label] of TELLS) {
      re.lastIndex = 0;
      const found = l.match(re);
      if (found) for (const f of found) add("WARN", "ai-tell", n, `${label}: ${JSON.stringify(f.slice(0, 60))}`);
    }
  });

  // Em dashes are judged by density, not presence: the style says two or three
  // across a whole piece is plenty.
  const emDashes = countIn(prose, EM_DASH);
  const budget = Math.max(3, Math.round(words / 1000));
  if (emDashes > budget)
    add(
      "WARN",
      "em-dash-density",
      0,
      `${emDashes} em dashes in ${words} words (budget ${budget})`,
    );

  // Severity vocabulary: if the document grades anything, it must use the four
  // canonical labels and no synonyms.
  // "trivial" and "cosmetic" are deliberately NOT here: both are ordinary
  // adjectives ("a trivial template edit") and produced false positives. Only
  // unambiguous grading vocabulary stays.
  const OFF_SCALE =
    /\b(?:blocker|showstopper|(?:high|medium|low) severity|P[1-4]|sev\s?[1-4])\b/gi;
  for (const m of prose.match(OFF_SCALE) || [])
    add("BLOCK", "off-scale-severity", 0, `${JSON.stringify(m)} - use ${SEVERITIES.join(" / ")}`);

  const usesSeverity = SEVERITIES.some((s) =>
    new RegExp(`\\b${s}\\b`).test(prose),
  );

  const bold = { BLOCK: 0, WARN: 0 };
  for (const h of hits) bold[h.level]++;

  return {
    name,
    words,
    emDashes,
    emDashBudget: budget,
    usesSeverityScale: usesSeverity,
    counts: bold,
    hits,
  };
}

// --- CLI -------------------------------------------------------------------
// Guarded, so importing this module for the fixture proof does not run the CLI
// and exit(2) on "no files given".

import { pathToFileURL } from "node:url";
const RUN_DIRECTLY =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (RUN_DIRECTLY) main();

function main() {
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const files = argv.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: check-report-style.mjs [--json] <file> [<file> ...]");
  process.exit(2);
}

let worst = 0;
const results = [];

for (const f of files) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch (e) {
    console.error(`cannot read ${f}: ${e.message}`);
    process.exit(2);
  }
  const r = checkReport(src, f);
  results.push(r);
  if (r.counts.BLOCK > 0) worst = 1;
}

if (asJson) {
  console.log(JSON.stringify(results, null, 1));
  process.exit(worst);
}

for (const r of results) {
  console.log(`\n${r.name}`);
  console.log(
    `  ${r.words} words   BLOCK ${r.counts.BLOCK}   WARN ${r.counts.WARN}   ` +
      `em dashes ${r.emDashes}/${r.emDashBudget}   severity scale used: ${r.usesSeverityScale}`,
  );

  const byRule = new Map();
  for (const h of r.hits) {
    if (!byRule.has(h.rule)) byRule.set(h.rule, []);
    byRule.get(h.rule).push(h);
  }
  for (const [rule, hs] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
    const lvl = hs[0].level;
    console.log(`  [${lvl}] ${rule} x${hs.length}`);
    for (const h of hs.slice(0, 4))
      console.log(`        ${h.line ? "line " + h.line + ": " : ""}${h.detail}`);
    if (hs.length > 4) console.log(`        ... and ${hs.length - 4} more`);
  }
  if (r.hits.length === 0) console.log("  clean");
}

process.exit(worst);
}
