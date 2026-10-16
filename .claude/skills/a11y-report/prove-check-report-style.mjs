#!/usr/bin/env node
// Fixture proof for check-report-style.mjs.
//
// DENY rows: text that MUST be flagged. ALWAYS-ALLOW rows: text that must NOT be,
// because a checker that flags everything is as useless as one that flags nothing.
// The run refuses to report success if either side is empty.

import { checkReport } from "./check-report-style.mjs";

const rows = [];
const row = (side, label, source, test) => rows.push({ side, label, source, test });

const has = (rule) => (r) => r.hits.some((h) => h.rule === rule);
const hasNot = (rule) => (r) => !r.hits.some((h) => h.rule === rule);

// --------------------------------------------------------------- DENY rows
row("DENY", "warning emoji is caught", "Something ⚠️ important.", has("emoji-or-pictograph"));
row("DENY", "tick and cross are caught", "Result ✅ then ❌.", has("emoji-or-pictograph"));
row("DENY", "unicode arrow is caught", "Funding type → Fee reduction", has("arrow"));
row("DENY", "ascii arrow is caught", "Moderate -> Serious", has("arrow"));
row("DENY", "curly quote is caught", "He said “yes” to it.", has("curly-quote"));
row("DENY", "curly apostrophe is caught", "The page’s own heading.", has("curly-quote"));
row("DENY", "bold-first bullet is caught", "- **Thing.** Detail follows.", has("bold-first-bullet"));
row(
  "DENY",
  "em dash density is caught",
  "One — two — three — four — five — six — seven — eight.",
  has("em-dash-density"),
);
row("DENY", "negative parallelism is caught", "It's not a bug, it's a feature.", has("ai-tell"));
row("DENY", "false suspense is caught", "Here's the kicker: it fails.", has("ai-tell"));
row("DENY", "signposted conclusion is caught", "In conclusion, we found four issues.", has("ai-tell"));
row("DENY", "empty transition is caught", "Importantly, the page loads.", has("ai-tell"));
row("DENY", "AI vocabulary is caught", "We delve into a robust paradigm.", has("ai-tell"));
row("DENY", "\"leverage\" as a verb is caught", "We will leverage the existing data.", has("ai-tell"));
row("DENY", "\"harness\" as a verb is caught", "The team can harness this signal.", has("ai-tell"));
row("DENY", "verb inflections are caught", "It harnessed the cached result.", has("ai-tell"));
row("DENY", "vague attribution is caught", "Experts argue this matters.", has("ai-tell"));
row("DENY", "off-scale severity is caught", "This is a blocker for release.", has("off-scale-severity"));
row("DENY", "P1 style grading is caught", "Logged as P1 against the team.", has("off-scale-severity"));
row(
  "DENY",
  "high/medium/low severity wording is caught",
  "Rated medium severity by the supplier.",
  has("off-scale-severity"),
);

// These two bind defects the checker HAD on its first real run, so they
// cannot come back silently.
row(
  "DENY",
  "an arrow counts ONCE, as an arrow and not also as an emoji",
  "Moderate → Serious",
  (r) =>
    r.hits.filter((h) => h.rule === "arrow").length === 1 &&
    r.hits.filter((h) => h.rule === "emoji-or-pictograph").length === 0,
);
row(
  "DENY",
  "warning sign plus variation selector is ONE hit, not two",
  "Note ⚠️ here.",
  (r) => r.hits.filter((h) => h.rule === "emoji-or-pictograph").length === 1,
);

// --------------------------------------------------- ALWAYS-ALLOW rows
row(
  "ALLOW",
  "plain prose is clean",
  "The button carries no accessible name. Give it an aria-label.",
  (r) => r.hits.length === 0,
);
row(
  "ALLOW",
  "an arrow INSIDE a fenced code block is evidence, not decoration",
  ["```", "Funding type → Fee reduction", "```"].join("\n"),
  hasNot("arrow"),
);
row(
  "ALLOW",
  "a curly quote inside a fenced block is quoted source text",
  ["```", "We’ll update this page shortly.", "```"].join("\n"),
  hasNot("curly-quote"),
);
row(
  "ALLOW",
  "an arrow in INLINE code is evidence too",
  "Console: `scrollWidth → 2117` confirms it.",
  hasNot("arrow"),
);
row("ALLOW", "the pound sign is not an emoji", "The award is worth £20,780 a year.", hasNot("emoji-or-pictograph"));
row("ALLOW", "an accented name is not an emoji", "The Spärck page fails at 320 px.", hasNot("emoji-or-pictograph"));
row("ALLOW", "an en dash range is allowed", "Measured across 2020–2024 without issue.", (r) => r.hits.length === 0);
row(
  "ALLOW",
  "two em dashes stay within budget",
  "The count updates — visibly — and is never announced.",
  hasNot("em-dash-density"),
);
row(
  "ALLOW",
  "the four canonical severities are not off-scale",
  "Rated Critical, Serious, Moderate and Minor respectively.",
  hasNot("off-scale-severity"),
);
row(
  "ALLOW",
  "the severity scale is detected when used",
  "This issue is Serious.",
  (r) => r.usesSeverityScale === true,
);
row(
  "ALLOW",
  "a non-graded document does not claim the scale",
  "The page loads and the heading reads correctly.",
  (r) => r.usesSeverityScale === false,
);
row(
  "ALLOW",
  "\"trivial\" as an ordinary adjective is not a severity grade",
  "A trivial template edit outranks an expensive one.",
  hasNot("off-scale-severity"),
);
row(
  "ALLOW",
  "\"cosmetic\" as an ordinary adjective is not a severity grade",
  "The change is cosmetic and affects no behaviour.",
  hasNot("off-scale-severity"),
);
row(
  "ALLOW",
  "\"harness\" as a NOUN (a test harness) must stay clean",
  "The external harness runs the audit engines against a live page.",
  hasNot("ai-tell"),
);
row(
  "ALLOW",
  "\"leverage\" as a noun is not the banned verb",
  "The leverage ratio was unchanged.",
  hasNot("ai-tell"),
);

// ------------------------------------------------------------------- run
let pass = 0;
let fail = 0;
const failures = [];

for (const r of rows) {
  const result = checkReport(r.source, r.label);
  const ok = r.test(result);
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${r.side} :: ${r.label}`);
  }
  console.log(`${ok ? "pass" : "FAIL"}  ${r.side.padEnd(5)} ${r.label}`);
}

const denies = rows.filter((r) => r.side === "DENY").length;
const allows = rows.filter((r) => r.side === "ALLOW").length;

console.log(`\n${rows.length} rows: ${denies} DENY, ${allows} ALLOW`);
console.log(`${pass} passed, ${fail} failed`);

if (denies === 0 || allows === 0) {
  console.log(
    "\nREFUSED: a proof with only one side cannot tell a working checker from " +
      "an always-deny or always-allow one.",
  );
  process.exit(2);
}
if (fail > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("\nboth sides populated and green.");
