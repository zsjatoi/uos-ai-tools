// sr-prove.mjs — the screen-reader fixture proof.
//
// This is the screen-reader equivalent of the Stage 2 static-audit fixture
// proof. It reads BOTH fixtures through the virtual screen reader and proves
// the reader genuinely distinguishes the clean page from the broken one:
//
//   fixture-clean.html  — the form control is voiced WITH its label
//                         ("Search term"), the headings are reachable, and the
//                         link is voiced WITH discernible text.
//   fixture-broken.html — the unlabelled input is voiced WITHOUT a usable name,
//                         and the empty link is voiced WITHOUT discernible text.
//
// If both fixtures ever voiced the same thing, the proof FAILS — that is the
// point. A pass here is NOT proof the app is usable with a screen reader; it
// proves these specific name/role assertions, on these fixtures. See
// manual-checks for what still needs a human listening.
//
// Run:  node .claude/a11y/sr/sr-prove.mjs
// Exit: 0 only if every clean check AND every broken check passes.

import { speakPage, isServerUp, CONFIG, firstPass } from "./sr-audit.mjs";

const FIXTURES = CONFIG.fixtures;

// --- phrase parsing ----------------------------------------------------------
// The virtual reader voices each item as "<role>" or "<role>, <name>[, <state>]".
// Container boundaries are voiced as "end of <role>...". roleEntries() returns
// the OPENING announcements for a given role with the accessible name parsed
// out (empty string when the item has no name).
function roleEntries(log, role) {
  const re = new RegExp(`^${role}(?:,\\s*(.*))?$`, "i");
  const out = [];
  for (const phrase of log) {
    if (/^end of\b/i.test(phrase)) continue; // skip closing boundaries
    const m = phrase.match(re);
    if (!m) continue;
    // The first comma-separated segment after the role is the accessible name;
    // trailing segments like "level 1" are state, not name.
    let name = (m[1] || "").trim();
    name = name.replace(/,\s*level\s*\d+.*$/i, "").trim();
    out.push({ phrase, name });
  }
  return out;
}

const hasNamed = (entries, reName) => entries.some((e) => e.name && reName.test(e.name));
const allUnnamed = (entries) => entries.length > 0 && entries.every((e) => e.name === "");

function printVoiced(title, log) {
  console.log(`\n--- voiced: ${title} (${log.length} announcements) ---`);
  log.forEach((p, i) => console.log(`  ${String(i).padStart(2, " ")} | ${p}`));
}

async function main() {
  if (!(await isServerUp())) {
    console.error(
      `Preview server is not running at ${CONFIG.previewBase}. Start your ` +
      `preview server (any static server on that address), then retry.`
    );
    process.exit(1);
  }

  const cleanRes = await speakPage(FIXTURES.clean);
  const brokenRes = await speakPage(FIXTURES.broken);
  const clean = firstPass(cleanRes.spokenPhraseLog);
  const broken = firstPass(brokenRes.spokenPhraseLog);

  console.log(`\nBrowser (explicit, reused): ${cleanRes.executablePath}`);
  printVoiced(FIXTURES.clean, clean);
  printVoiced(FIXTURES.broken, broken);

  // Parse the items of interest on each page.
  const cleanText = roleEntries(clean, "textbox");
  const cleanLink = roleEntries(clean, "link");
  const cleanHead = roleEntries(clean, "heading");
  const brokenText = roleEntries(broken, "textbox");
  const brokenLink = roleEntries(broken, "link");

  console.log("\n--- items of interest ---");
  console.log("  clean  textbox :", JSON.stringify(cleanText.map((e) => e.phrase)));
  console.log("  broken textbox :", JSON.stringify(brokenText.map((e) => e.phrase)));
  console.log("  clean  link    :", JSON.stringify(cleanLink.map((e) => e.phrase)));
  console.log("  broken link    :", JSON.stringify(brokenLink.map((e) => e.phrase)));
  console.log("  clean  headings:", JSON.stringify(cleanHead.map((e) => e.phrase)));

  // --- the proof: clean voices names, broken voices their absence -----------
  const checks = {
    "CLEAN: control voiced WITH label 'Search term'": hasNamed(cleanText, /search term/i),
    "CLEAN: headings reachable (>=1 named heading)":
      cleanHead.length >= 1 && cleanHead.some((e) => e.name),
    "CLEAN: link voiced WITH text 'Visit example.com'": hasNamed(cleanLink, /visit example\.com/i),
    "BROKEN: input voiced but WITHOUT a usable name":
      brokenText.length >= 1 && allUnnamed(brokenText) && !hasNamed(brokenText, /search term/i),
    "BROKEN: empty link voiced WITHOUT discernible text":
      brokenLink.length >= 1 && allUnnamed(brokenLink),
    // The two pages must genuinely differ on the same control, or the proof is
    // meaningless (it would also "pass" if the reader said nothing at all).
    "DISTINGUISHES: clean control named, broken control unnamed":
      hasNamed(cleanText, /search term/i) && allUnnamed(brokenText),
    "DISTINGUISHES: clean link named, broken link unnamed":
      hasNamed(cleanLink, /visit example\.com/i) && allUnnamed(brokenLink),
  };

  console.log("\n--- proof results ---");
  let allPass = true;
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }

  console.log(
    `\n${allPass ? "PROOF PASSED" : "PROOF FAILED"} — the virtual screen reader ` +
    `${allPass ? "genuinely distinguishes" : "did NOT distinguish"} the clean page from the broken one.`
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(`Unexpected error: ${e.stack || e.message}`);
  process.exit(1);
});
