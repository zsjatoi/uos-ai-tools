// label-in-name-prove.mjs — the fixture proof for the SC 2.5.3 checker.
//
// Sibling of sr-prove.mjs. It reads a11y-fixtures/fixture-label-in-name.html,
// where EVERY control declares its own expected verdict in data-lin-expect, and
// asserts the checker produced exactly that verdict. Nothing is expected in this
// runner, so the fixture stays the single source of truth.
//
// Why it exists: a checker that reports nothing looks identical to a clean page.
// This fixture carries seeded failures AND correct controls, so a run that finds
// no failures here proves the checker is broken rather than the page clean —
// and the correct controls are the canaries that catch over-reporting.
//
// The load-bearing rows:
//   FAIL   — an aria-label whose words differ from the visible title, including
//            one inside display:none that no other layer in this kit can see.
//   PASS   — aria-labelledby naming a control from its own visible title, inside
//            a label that also holds a longer description. A naive whole-label
//            comparison fails this row, so it is the guard against that bug.
//   REVIEW — containment passes but aria-label still suppresses visible content.
//   SKIP   — icon-only and symbolic controls, where 2.5.3 does not apply.
//
// Run:  node .claude/a11y/sr/label-in-name-prove.mjs
// Exit: 0 only if every declared expectation is met.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isServerUp, CONFIG, VIEWPORT } from "./sr-audit.mjs";
import {
  launchBrowser,
  pageUrl,
  scanPage,
  scanUrl,
  VIEWPORTS,
  parseMaxCoRendered,
  evaluateCoRenderedGate,
} from "./label-in-name-audit.mjs";

// --- house-style logging -----------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
function shouldLog(level) { return level <= DEFAULT_LOG_LEVEL; }
function logError(m, ...a) { if (shouldLog(LOG_LEVELS.ERROR)) console.error(m, ...a); }
function logInfo(m, ...a) { if (shouldLog(LOG_LEVELS.INFO)) console.log(m, ...a); }

const HERE = dirname(fileURLToPath(import.meta.url));
const SR_CONFIG = JSON.parse(readFileSync(join(HERE, "sr-config.json"), "utf8"));
const FIXTURE =
  (SR_CONFIG.fixtures && SR_CONFIG.fixtures.labelInName) ||
  "a11y-fixtures/fixture-label-in-name.html";

// --- tiny assertion recorder (same shape as behaviour-audit.mjs) --------------
const results = []; // { key, pass, detail }
function check(key, pass, detail) {
  results.push({ key, pass: !!pass, detail: String(detail) });
}

async function main() {
  if (!(await isServerUp())) {
    logError(`Preview server not running at ${CONFIG.previewBase}. Start your preview server (previewBase in sr-config.json) and retry.`);
    process.exit(1);
  }

  const { executablePath, browser } = await launchBrowser();
  logInfo(`Label-in-Name fixture proof (headless chromium-${CONFIG.chromiumRevision})`);
  logInfo(`Browser (explicit): ${executablePath}`);
  logInfo(`Viewport (explicit): ${VIEWPORT.width}x${VIEWPORT.height}`);
  logInfo(`Fixture: ${pageUrl(FIXTURE)}`);

  let scan;
  let multi;
  let expectations;
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(pageUrl(FIXTURE), { waitUntil: "domcontentloaded", timeout: 30000 });
    // Read the fixture's own declarations. Everything asserted below comes from
    // here, so the expectations live with the markup they describe.
    expectations = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-lin-expect]")).map((el) => ({
        id: el.id,
        expect: el.getAttribute("data-lin-expect"),
      }))
    );
    scan = await scanPage(page);
    await page.close();
    // The same fixture through the MULTI-WIDTH path. The fixture has no media
    // queries and no external stylesheet, so every width must produce identical
    // verdicts — which makes it a clean canary that the merge in scanUrl() drops
    // no rows and invents none. Without this, a merge bug would only ever show up
    // on a real page, where a changed count is ambiguous.
    multi = await scanUrl(browser, FIXTURE);
  } catch (e) {
    logError(`\nError during proof run: ${e.stack || e.message}`);
    await browser.close();
    process.exit(1);
  } finally {
    await browser.close();
  }

  // The fixture must actually declare something, or every assertion below would
  // pass over an empty set — the failure mode this whole file exists to prevent.
  check(
    "0: fixture declares expectations",
    expectations.length >= 8,
    `${expectations.length} control(s) carry data-lin-expect (need >= 8)`
  );

  const byId = new Map();
  for (const row of scan.rows) {
    if (row.control.id) byId.set(row.control.id, row);
  }

  for (const e of expectations) {
    const row = byId.get(e.id);
    const actual = row ? row.level : "SKIP"; // no row produced == out of scope
    check(
      `#${e.id}: expected ${e.expect}`,
      actual === e.expect,
      `actual=${actual}` +
        (row
          ? `, visible=${JSON.stringify(row.control.visibleText)}, name=${JSON.stringify(row.name)}, source=${row.source}`
          : ", no row produced (2.5.3 not applicable)")
    );
  }

  // Canary counts, so an all-SKIP run cannot read as a pass.
  const fails = scan.rows.filter((r) => r.level === "FAIL");
  check(
    "canary: the checker reddens on seeded failures",
    fails.length === expectations.filter((e) => e.expect === "FAIL").length && fails.length > 0,
    `${fails.length} FAIL row(s): ${fails.map((r) => r.control.locator).join(", ") || "(none)"}`
  );
  check(
    "canary: at least one PASS row (no over-reporting)",
    scan.rows.some((r) => r.level === "PASS"),
    `${scan.rows.filter((r) => r.level === "PASS").length} PASS row(s)`
  );

  // The differentiator for this whole layer: it must reach a control that the
  // static engines and the virtual reader cannot see, because it is unrendered.
  const hidden = byId.get("lin-fail-hidden-htmlzip");
  check(
    "load-bearing: an UNRENDERED control was judged",
    !!hidden && hidden.control.rendered === false && hidden.level === "FAIL",
    hidden
      ? `rendered=${hidden.control.rendered}, level=${hidden.level}, source=${hidden.source}`
      : "no row for #lin-fail-hidden-htmlzip"
  );

  // The ambiguous-name check is a separate question from 2.5.3, so it gets its own
  // falsifiable rows: the seeded pair must be found, and the correctly-authored
  // single-instance controls must NOT be swept in.
  const loadGroup = scan.duplicateNames.find((g) => g.key === "load");
  check(
    "ambiguity: the seeded duplicate name is detected",
    !!loadGroup && loadGroup.count === 2,
    loadGroup
      ? `"${loadGroup.name}" x${loadGroup.count}: ${loadGroup.members.map((m) => m.locator).join(", ")}`
      : "no group found for the name \"Load\""
  );
  check(
    "ambiguity: both members are rendered together (the live-ambiguity signal)",
    !!loadGroup && loadGroup.renderedCount === 2,
    loadGroup ? `renderedCount=${loadGroup.renderedCount} of ${loadGroup.count}` : "n/a"
  );
  check(
    "ambiguity: unique names are NOT reported (no over-reporting)",
    !scan.duplicateNames.some((g) => g.key === "postcode" || g.key === "find records"),
    `groups: ${scan.duplicateNames.map((g) => `${g.key}x${g.count}`).join(", ") || "(none)"}`
  );

  // The co-rendered gate, proved by inversion on this fixture's real scan. The
  // seeded "Load" pair gives a known co-rendered count of exactly 1, so the same
  // page must pass at --max-co-rendered=1 and redden at 0. A gate that only ever
  // passes is indistinguishable from one that is never evaluated, which is why
  // the breaching row is here rather than a green-only assertion.
  const gateAllowed = evaluateCoRenderedGate(scan.duplicateNames, 1);
  const gateBreached = evaluateCoRenderedGate(scan.duplicateNames, 0);
  check(
    "gate: --max-co-rendered=1 passes on a fixture with exactly one co-rendered group",
    gateAllowed.enabled && gateAllowed.count === 1 && !gateAllowed.breached,
    `count=${gateAllowed.count}, max=${gateAllowed.max}, breached=${gateAllowed.breached}`
  );
  check(
    "gate: INVERSION — the same page breaches at --max-co-rendered=0",
    gateBreached.breached && gateBreached.offending.some((g) => g.key === "load"),
    `breached=${gateBreached.breached}, offending=` +
      `${gateBreached.offending.map((g) => `${g.key}x${g.renderedCount}`).join(", ") || "(none)"}`
  );
  check(
    "gate: absent flag leaves the runner reporting only (no behaviour change)",
    parseMaxCoRendered(["page.html", "--all-rows"]) === null &&
      !evaluateCoRenderedGate(scan.duplicateNames, null).breached &&
      parseMaxCoRendered(["--max-co-rendered=0"]) === 0,
    `parse(absent)=${parseMaxCoRendered(["page.html", "--all-rows"])}, ` +
      `parse("--max-co-rendered=0")=${parseMaxCoRendered(["--max-co-rendered=0"])}`
  );

  // Multi-width canary: identical verdicts, no rows lost or invented.
  check(
    "viewport: the two-width scan yields the same rows as a single-width scan",
    !!multi && multi.rows.length === scan.rows.length,
    `single=${scan.rows.length} rows, multi=${multi ? multi.rows.length : "n/a"} rows across ` +
      `${VIEWPORTS.map((v) => v.width + "x" + v.height).join(", ")}`
  );
  check(
    "viewport: a fixture with no media queries reports no divergences",
    !!multi && (multi.divergences || []).length === 0 && (multi.churn || []).length === 0,
    `divergences=${multi ? (multi.divergences || []).length : "n/a"}, ` +
      `churn=${multi ? (multi.churn || []).length : "n/a"}`
  );

  // --- report ----------------------------------------------------------------
  logInfo(`\n=== LABEL-IN-NAME PROOF RESULTS ===`);
  let allPass = results.length > 0;
  for (const r of results) {
    logInfo(`  ${r.pass ? "PASS" : "FAIL"}  ${r.key}`);
    logInfo(`        ${r.detail}`);
    if (!r.pass) allPass = false;
  }

  logInfo(
    `\nName sources on the fixture: ${scan.stats.axProbed} rendered control(s) named from the ` +
    `real accessibility tree (matched by id); CDP probe ok = ${scan.stats.axAligned}; ` +
    `AX-vs-DOM disagreements = ${scan.stats.disagreements}. The unrendered row is ` +
    `necessarily DOM-derived — the accessibility tree does not contain it.`
  );
  logInfo(
    `\nFalsifiability: the seeded FAIL rows redden and the correct controls do not, so the ` +
    `checker discriminates rather than merely reporting. The PASS row for ` +
    `#lin-pass-labelledby is the specific guard against comparing a whole compound label ` +
    `against the name.`
  );
  logInfo(
    `\n${allPass ? "LABEL-IN-NAME PROOF PASSED" : "LABEL-IN-NAME PROOF FAILED"} — this proves ` +
    `the checker's own behaviour on this fixture. It is NOT a statement about any real page ` +
    `and NOT WCAG 2.2 AA conformance.`
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  logError(`Unexpected error: ${e.stack || e.message}`);
  process.exit(1);
});
