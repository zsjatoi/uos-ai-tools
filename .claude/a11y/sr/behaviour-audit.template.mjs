// behaviour-audit.template.mjs — the Playwright BEHAVIOUR proving test.
// TEMPLATE: runs as-is against the kit fixture a11y-fixtures/form-demo/. Copy it to
// behaviour-audit.mjs and change the selectors and assertions for your own forms.
//
// This is the dynamic-behaviour half of the layer. Unlike the static engines
// (which read one rendered snapshot) and the screen readers (which read names /
// roles / states), this DRIVES the page and asserts what happens over time:
// submission blocking, focus moving to the first invalid field, per-field error
// clearing LIVE on input, and a role="status" live region being POPULATED (not
// merely un-hidden) on a valid submit. These are common bug classes that
// no static audit or single SR read can see.
//
// No NVDA, no foreground gymnastics: it runs HEADLESS on the cached chromium-1223
// (launched by explicit executablePath from the external install), so it runs
// anywhere the virtual reader does — independent of the real-NVDA half. On-demand
// only; NEVER wired into the PostToolUse hook.
//
// Targets: positives on a11y-fixtures/form-demo/after.html (the correct page); falsifiable
// negatives on a11y-fixtures/form-demo/before.html (the broken control). Each assertion prints
// the value it asserted, so a pass is auditable.
//
// Run:  node .claude/a11y/sr/behaviour-audit.mjs [positive-page]
//       (default positive page a11y-fixtures/form-demo/after.html; negatives always on
//       a11y-fixtures/form-demo/before.html). Preview server must be up (previewBase in sr-config.json).

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, isServerUp, resolveInstallDir, VIEWPORT } from "./sr-audit.mjs";

// --- logging: configurable levels, British spelling -----------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
function shouldLog(level) { return level <= DEFAULT_LOG_LEVEL; }
function logError(m, ...a) { if (shouldLog(LOG_LEVELS.ERROR)) console.error(m, ...a); }
function logWarn(m, ...a) { if (shouldLog(LOG_LEVELS.WARN)) console.warn(m, ...a); }
function logInfo(m, ...a) { if (shouldLog(LOG_LEVELS.INFO)) console.log(m, ...a); }

// --- resolve the external toolchain (playwright) -----------------------------
const installDir = resolveInstallDir();
const pkgJson = join(installDir, "package.json");
if (!existsSync(pkgJson)) {
  logError(`Toolchain not installed at ${installDir}. See .claude/a11y/sr/SETUP.md.`);
  process.exit(1);
}
const requireExternal = createRequire(pkgJson);
const { chromium } = requireExternal("playwright");

const PREVIEW_BASE = (CONFIG.previewBase || "").replace(/\/+$/, "");
const pageUrl = (p) => (/^https?:\/\//i.test(p) ? p : `${PREVIEW_BASE}/${p.replace(/^\/+/, "")}`);

// --- tiny assertion recorder -------------------------------------------------
const results = []; // { key, pass, detail }
function check(key, pass, detail) {
  results.push({ key, pass: !!pass, detail: String(detail) });
}

// Press Tab `n` times from a neutral start and return the focused-element
// descriptor after each press (tag.class#id), so we can assert what the Tab order
// does and does NOT include.
async function tabFocusList(page, n) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
  });
  const seen = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    const d = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return "none";
      const cls = (a.className || "").toString().trim().replace(/\s+/g, ".");
      return `${a.tagName}.${cls}#${a.id || ""}`;
    });
    seen.push(d);
  }
  return seen;
}

async function runPositives(browser, positivePage) {
  const url = pageUrl(positivePage);

  // ===== Assertions 1-3 share ONE page (sequential state after an empty submit).
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // --- 1) empty submit is BLOCKED + focus to first invalid field ------------
  const url0 = page.url();
  await page.fill("#full-name", "");
  await page.click("button[type=submit]");
  await page.waitForTimeout(250);
  const url1 = page.url();
  const active1 = await page.evaluate(() => (document.activeElement ? document.activeElement.id : null));
  const confirm1 = await page.evaluate(() => (document.getElementById("confirm")?.textContent || "").trim());
  check("1: empty submit did not navigate (url unchanged)", url0 === url1, `${url0} -> ${url1}`);
  check("1: focus moved to first invalid field #full-name", active1 === "full-name", `activeElement=#${active1}`);
  check("1: no confirmation shown on empty submit", confirm1 === "", `confirm="${confirm1}"`);

  // --- 2) aria-invalid="true" + describedby resolves to a visible error ------
  for (const f of [{ id: "full-name", err: "full-name-error" }, { id: "email", err: "email-error" }]) {
    const info = await page.evaluate((fid) => {
      const el = document.getElementById(fid);
      const db = el.getAttribute("aria-describedby");
      const target = db ? document.getElementById(db) : null;
      const visible = target ? !target.hasAttribute("hidden") && getComputedStyle(target).display !== "none" : false;
      return {
        ai: el.getAttribute("aria-invalid"),
        db,
        targetExists: !!target,
        visible,
        text: target ? target.textContent.trim() : null,
      };
    }, f.id);
    check(`2: #${f.id} aria-invalid="true"`, info.ai === "true", `aria-invalid=${info.ai}`);
    check(
      `2: #${f.id} describedby resolves to a visible error element`,
      info.db === f.err && info.targetExists && info.visible,
      `describedby=${info.db}, exists=${info.targetExists}, visible=${info.visible}, text="${info.text}"`
    );
  }
  const campusInfo = await page.evaluate(() =>
    Array.from(document.getElementsByName("campus")).map((r) => ({
      ai: r.getAttribute("aria-invalid"),
      db: r.getAttribute("aria-describedby"),
    }))
  );
  check(
    `2: campus radios aria-invalid="true" + describedby=campus-error`,
    campusInfo.length > 0 && campusInfo.every((c) => c.ai === "true" && c.db === "campus-error"),
    JSON.stringify(campusInfo)
  );

  // --- 3) correcting a field clears its error LIVE, with NO re-submit --------
  // name (input event)
  await page.fill("#full-name", "Ada Lovelace");
  await page.waitForTimeout(150);
  const nameClr = await page.evaluate(() => {
    const el = document.getElementById("full-name");
    const err = document.getElementById("full-name-error");
    return { ai: el.getAttribute("aria-invalid"), db: el.getAttribute("aria-describedby"), errHidden: err.hasAttribute("hidden") };
  });
  check("3: #full-name cleared live — aria-invalid false/absent", nameClr.ai === "false" || nameClr.ai === null, `aria-invalid=${nameClr.ai}`);
  check("3: #full-name error detached (no describedby) + hidden", !nameClr.db && nameClr.errHidden, `describedby=${nameClr.db}, errHidden=${nameClr.errHidden}`);
  // email (input event) — the "at least one other"
  await page.fill("#email", "ada@example.com");
  await page.waitForTimeout(150);
  const emailClr = await page.evaluate(() => {
    const el = document.getElementById("email");
    const err = document.getElementById("email-error");
    return { ai: el.getAttribute("aria-invalid"), db: el.getAttribute("aria-describedby"), errHidden: err.hasAttribute("hidden") };
  });
  check("3: #email cleared live — aria-invalid false/absent", emailClr.ai === "false" || emailClr.ai === null, `aria-invalid=${emailClr.ai}`);
  check("3: #email error detached (no describedby) + hidden", !emailClr.db && emailClr.errHidden, `describedby=${emailClr.db}, errHidden=${emailClr.errHidden}`);
  // campus (change event)
  await page.check("#c-north");
  await page.waitForTimeout(150);
  const campusClr = await page.evaluate(() => {
    const r = document.getElementById("c-north");
    const err = document.getElementById("campus-error");
    return { ai: r.getAttribute("aria-invalid"), errHidden: err.hasAttribute("hidden") };
  });
  check("3: campus cleared live on change — aria-invalid false/absent + error hidden", (campusClr.ai === "false" || campusClr.ai === null) && campusClr.errHidden, `aria-invalid=${campusClr.ai}, errHidden=${campusClr.errHidden}`);
  // prove NO re-submit happened during live clearing
  const confirmDuring = await page.evaluate(() => (document.getElementById("confirm")?.textContent || "").trim());
  check("3: clearing happened with NO re-submit (confirm still empty)", confirmDuring === "", `confirm="${confirmDuring}"`);
  await page.close();

  // ===== 4) confirmation live region: present-and-empty, then POPULATED ======
  const page4 = await browser.newPage({ viewport: VIEWPORT });
  await page4.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const pre = await page4.evaluate(() => {
    const el = document.getElementById("confirm");
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return {
      exists: true,
      role: el.getAttribute("role"),
      text: el.textContent.trim(),
      display: cs.display,
      visibility: cs.visibility,
      hiddenAttr: el.hasAttribute("hidden"),
      ariaHidden: el.getAttribute("aria-hidden"),
    };
  });
  check("4: #confirm present with role=status", pre.exists && pre.role === "status", JSON.stringify(pre));
  check("4: #confirm EMPTY before submit", pre.exists && pre.text === "", `text="${pre.text}"`);
  check(
    "4: #confirm in the a11y tree before submit (not display:none / hidden / aria-hidden)",
    pre.exists && pre.display !== "none" && !pre.hiddenAttr && pre.ariaHidden !== "true",
    `display=${pre.display}, visibility=${pre.visibility}, hidden=${pre.hiddenAttr}, aria-hidden=${pre.ariaHidden}`
  );
  // fill valid + submit
  await page4.fill("#full-name", "Ada Lovelace");
  await page4.fill("#email", "ada@example.com");
  await page4.check("#c-north");
  await page4.click("button[type=submit]");
  await page4.waitForTimeout(300);
  const post = await page4.evaluate(() => {
    const el = document.getElementById("confirm");
    const a = document.activeElement;
    return { text: (el?.textContent || "").trim(), activeInvalid: a ? a.getAttribute("aria-invalid") : null, activeId: a ? a.id : null };
  });
  check(
    "4: valid submit POPULATES the confirmation (populate-not-reveal)",
    /registration has been received|thank you/i.test(post.text),
    `confirm="${post.text}"`
  );
  check(
    "4: valid submit NOT blocked (no field left marked invalid/focused)",
    post.activeInvalid !== "true",
    `activeElement=#${post.activeId}, aria-invalid=${post.activeInvalid}`
  );
  await page4.close();
}

async function runNegatives(browser, negativePage) {
  const url = pageUrl(negativePage);
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // One Tab walk serves both negatives (before.html has 6 focusables; 14 covers
  // a full cycle and then some).
  const tabOrder = await tabFocusList(page, 14);

  // --- 5) the submit is an inert <div> --------------------------------------
  const submit = await page.evaluate(() => {
    const el = document.querySelector(".submit-btn");
    return el ? { tag: el.tagName, role: el.getAttribute("role"), tabindex: el.getAttribute("tabindex") } : null;
  });
  check("5: submit is a <div>", submit && submit.tag === "DIV", `tag=${submit?.tag}`);
  check("5: submit has no role and no role=button", submit && submit.role === null, `role=${submit?.role}`);
  check("5: submit has no tabindex", submit && submit.tabindex === null, `tabindex=${submit?.tabindex}`);
  check("5: submit never receives focus via Tab", !tabOrder.some((d) => /submit-btn/.test(d)), `tabOrder=${JSON.stringify(tabOrder)}`);
  // NOTE: an earlier "Enter/Space produce no confirmation" sub-assertion was
  // dropped (demoted to this comment). It could not fail on before.html — a <div>
  // that cannot take focus swallows the keys regardless — and on after.html it
  // failed for a confirmation-pattern reason (role="status" is never hidden), not
  // for keyboard operability. The load-bearing, falsifiable proof that the div is
  // inoperable is "submit never receives focus via Tab" (above) plus "no role / no
  // tabindex".

  // --- 6) the help control is an inert <span> -------------------------------
  const help = await page.evaluate(() => {
    const el = document.querySelector(".help-toggle");
    return el ? { tag: el.tagName, role: el.getAttribute("role"), tabindex: el.getAttribute("tabindex") } : null;
  });
  check("6: help is a <span>", help && help.tag === "SPAN", `tag=${help?.tag}`);
  check("6: help is not a button and not role=button", help && help.role === null, `role=${help?.role}`);
  check("6: help is not in the tab order", !tabOrder.some((d) => /help-toggle/.test(d)), `tabOrder=${JSON.stringify(tabOrder)}`);

  await page.close();
}

async function main() {
  const positivePage = process.argv[2] || "a11y-fixtures/form-demo/after.html";
  // argv[3] overrides the negative-control page. Default is the broken before.html;
  // pointing it at after.html is how we PROVE the load-bearing negatives are
  // falsifiable (they fail against the correct page).
  const negativePage = process.argv[3] || "a11y-fixtures/form-demo/before.html";

  if (!(await isServerUp())) {
    logError(`Preview server not running at ${PREVIEW_BASE}. Start your preview server and retry.`);
    process.exit(1);
  }
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath) || !executablePath.includes(`chromium-${CONFIG.chromiumRevision}`)) {
    logWarn(`Chromium executablePath not the pinned chromium-${CONFIG.chromiumRevision}: ${executablePath}`);
  }

  logInfo(`Behaviour proving test (Playwright, headless chromium-${CONFIG.chromiumRevision})`);
  logInfo(`Browser (explicit): ${executablePath}`);
  logInfo(`Viewport (explicit): ${VIEWPORT.width}x${VIEWPORT.height}`);
  logInfo(`Positives: ${pageUrl(positivePage)}`);
  logInfo(`Negatives: ${pageUrl(negativePage)}`);

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    await runPositives(browser, positivePage);
    await runNegatives(browser, negativePage);
  } catch (e) {
    logError(`\nError during behaviour run: ${e.stack || e.message}`);
    await browser.close();
    process.exit(1);
  } finally {
    await browser.close();
  }

  // --- report ----------------------------------------------------------------
  logInfo(`\n=== BEHAVIOUR RESULTS ===`);
  let allPass = results.length > 0;
  for (const r of results) {
    logInfo(`  ${r.pass ? "PASS" : "FAIL"}  ${r.key}`);
    logInfo(`        ${r.detail}`);
    if (!r.pass) allPass = false;
  }

  logInfo(
    `\nFalsifiability note: assertions 1-4 and the structural/tab-order parts of 5-6 each ` +
    `fail if the behaviour is wrong (after.html proves correct; before.html proves broken). ` +
    `before.html discrimination rests on the load-bearing checks that the submit and help ` +
    `controls are not focusable and are absent from the tab order; the "no role / no tabindex" ` +
    `checks corroborate but also pass for a correct semantic <button>, so they are not ` +
    `load-bearing on their own. (An earlier "Enter/Space produce no confirmation" sub-assertion ` +
    `was dropped — see the comment in runNegatives.)`
  );
  logInfo(
    `\n${allPass ? "BEHAVIOUR PROOF PASSED" : "BEHAVIOUR PROOF FAILED"} — Playwright distinguished ` +
    `correct dynamic behaviour (after.html) from broken (before.html). This is DOM/behaviour truth, ` +
    `not a screen-reader or usability statement.`
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  logError(`Unexpected error: ${e.stack || e.message}`);
  process.exit(1);
});
