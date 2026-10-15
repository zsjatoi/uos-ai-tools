// audit.mjs — shared accessibility audit runner.
//
// Runs two WCAG 2.2 AA audit engines against one or more pages served by your
// local preview server, writes full reports to disk and prints a compact
// summary. Both engines run through `npx`, pinned in a11y.config.json, so there
// is no npm install and no node_modules in your project.
//
// Usage (from anywhere; the script locates the project root itself):
//   node .claude/a11y/audit.mjs a11y-fixtures/fixture-broken.html
//   node .claude/a11y/audit.mjs --all          (audits the keyPages list)
//   node .claude/a11y/audit.mjs page1.html page2.html
//
// Exit code: 0 when there are no VIOLATION-level findings; 1 otherwise.
// Potentials (manual-review items) are shown but never fail the CLI run.
//
// This file also EXPORTS its audit logic (auditPage, isServerUp, CONFIG, ...)
// so the PostToolUse hook can reuse it without spawning a second process.
//
// Result levels, reported separately everywhere:
//   - "violations" = hard failures (IBM value FAIL, pa11y type "error")
//   - "potentials" = manual-review  (IBM value POTENTIAL, pa11y type "warning")

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Logging: configurable levels, British spelling.
// ---------------------------------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
const ENABLE_ALL_LOGGING = false;
const DISABLE_ALL_LOGGING = false;

function shouldLog(level) {
  if (DISABLE_ALL_LOGGING) return false;
  if (ENABLE_ALL_LOGGING) return true;
  return level <= DEFAULT_LOG_LEVEL;
}
function logError(message, ...args) {
  if (shouldLog(LOG_LEVELS.ERROR)) console.error(message, ...args);
}
function logWarn(message, ...args) {
  if (shouldLog(LOG_LEVELS.WARN)) console.warn(message, ...args);
}
function logInfo(message, ...args) {
  if (shouldLog(LOG_LEVELS.INFO)) console.log(message, ...args);
}
function logDebug(message, ...args) {
  if (shouldLog(LOG_LEVELS.DEBUG)) console.log(message, ...args);
}

// ---------------------------------------------------------------------------
// Locate the project. This file sits at <root>/.claude/a11y/audit.mjs, so the
// project root is two directories up. webRoot from the config is resolved
// against that root.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url)); // <root>/.claude/a11y
export const A11Y_DIR = here;
export const PROJECT_ROOT = resolve(here, "..", ".."); // <root>

const CONFIG_PATH = join(A11Y_DIR, "a11y.config.json");
if (!existsSync(CONFIG_PATH)) {
  logError(`Config not found at ${CONFIG_PATH}. Cannot continue.`);
  process.exit(1);
}
export const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

// The web server root (usually "."), as an absolute path. The IBM checker MUST
// be spawned with this as its working directory, otherwise it silently ignores
// .achecker.yml and falls back to built-in defaults.
const WEB_ROOT = resolve(PROJECT_ROOT, CONFIG.webRoot || ".");
const PREVIEW_BASE = (CONFIG.previewBase || "").replace(/\/+$/, "");
export const KEY_PAGES = Array.isArray(CONFIG.keyPages) ? CONFIG.keyPages : [];

// Prefixes (project-relative) the edit hook never audits.
export const HOOK_EXCLUDE_PREFIXES = Array.isArray(CONFIG.hookExcludePrefixes)
  ? CONFIG.hookExcludePrefixes
  : [".claude/", "a11y-fixtures/"];

// Engine package@version strings, taken verbatim from the config.
const IBM_PKG = CONFIG.pins?.accessibilityChecker;
const PA11Y_PKG = CONFIG.pins?.pa11y;
if (!IBM_PKG || !PA11Y_PKG) {
  logError("Both pinned engine versions must be set in a11y.config.json (pins.accessibilityChecker and pins.pa11y).");
  process.exit(1);
}

// Report output folders. IBM writes to the outputFolder in .achecker.yml, which
// it resolves against its working directory (WEB_ROOT).
const REPORTS_ROOT = join(A11Y_DIR, "reports");
const ACHECKER_OUT = join(WEB_ROOT, ".claude", "a11y", "reports", "achecker");
const PA11Y_OUT = join(REPORTS_ROOT, "pa11y");
mkdirSync(PA11Y_OUT, { recursive: true });

// ---------------------------------------------------------------------------
// pa11y viewport. pa11y's own default is 1280x1024, and anything below the
// fold goes unsampled. An unsampled node can surface as a RED rather than a
// pass: axe returns it as "incomplete", and pa11y@9 maps that to an error for
// colour contrast. A tall viewport avoids the problem. Set pa11yViewport in the
// config to roughly your tallest page's scrollHeight, rounded up.
// pa11y has no --viewport flag, so the value travels in a config file.
// ---------------------------------------------------------------------------
const PA11Y_VIEWPORT = CONFIG.pa11yViewport || { width: 1280, height: 2000 };
const PA11Y_CONFIG_PATH = join(PA11Y_OUT, "pa11y-viewport.config.json");
writeFileSync(PA11Y_CONFIG_PATH, JSON.stringify({ viewport: PA11Y_VIEWPORT }, null, 2), "utf8");

// ---------------------------------------------------------------------------
// npx invocation helper. On Windows a bare spawn of "npx" fails with ENOENT,
// so go through cmd. If even that fails with ENOENT, retry once with the
// absolute path to npx.cmd that ships next to this Node executable.
// ---------------------------------------------------------------------------
const IS_WINDOWS = process.platform === "win32";

function runNpx(pkgArgs, cwd, timeoutMs, extraEnv) {
  // pkgArgs is the argument list AFTER "npx". extraEnv (optional) is merged
  // over the inherited environment for this spawn only.
  const opts = { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 };
  if (extraEnv) opts.env = { ...process.env, ...extraEnv };

  if (IS_WINDOWS) {
    let res = spawnSync("cmd", ["/c", "npx", ...pkgArgs], opts);
    if (res.error && res.error.code === "ENOENT") {
      const npxCmd = join(dirname(process.execPath), "npx.cmd");
      logWarn(`Bare npx failed with ENOENT; retrying via ${npxCmd}`);
      res = spawnSync("cmd", ["/c", npxCmd, ...pkgArgs], opts);
    }
    return res;
  }

  let res = spawnSync("npx", pkgArgs, opts);
  if (res.error && res.error.code === "ENOENT") {
    const npxBin = join(dirname(process.execPath), "npx");
    logWarn(`Bare npx failed with ENOENT; retrying via ${npxBin}`);
    res = spawnSync(npxBin, pkgArgs, opts);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

// Build the full preview URL for a page path relative to webRoot.
function pageUrl(pagePath) {
  const clean = pagePath.replace(/^\/+/, "");
  return `${PREVIEW_BASE}/${clean}`;
}

// Turn "http://localhost:8080" into the host folder name the IBM checker uses
// for its reports, e.g. "localhost_8080" (the colon becomes an underscore).
function sanitizedHost() {
  const u = new URL(PREVIEW_BASE);
  return u.host.replace(/:/g, "_");
}

// Reduce a report file name to a form that is stable across the engines'
// different sanitising rules. IBM rewrites a query string into its file name
// ("page.html?v=2" becomes "page.html_v_2"), so a predicted name can miss.
function normaliseReportName(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

// Predict where the IBM checker writes a page's JSON report, with a recursive
// fallback search in case the sanitising differs.
function findAcheckerReport(pagePath) {
  const clean = pagePath.replace(/^\/+/, "");
  const predicted = join(ACHECKER_OUT, sanitizedHost(), `${clean}.json`);
  if (existsSync(predicted)) return predicted;

  const baseName = clean.split("/").pop() + ".json";
  const wantedNormalised = normaliseReportName(baseName);
  let newest = null;
  let newestTime = -1;
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (normaliseReportName(entry) === wantedNormalised && st.mtimeMs > newestTime) {
        newest = full;
        newestTime = st.mtimeMs;
      }
    }
  }
  walk(ACHECKER_OUT);
  return newest;
}

// Keep at most five unique rule ids for the compact summary.
function firstFive(list) {
  return [...new Set(list)].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Dev-server noise filter. Some preview servers (BrowserSync, used by the VS
// Code "Preview on Web Server" extension) inject an element such as
// <div id="__bs_notify__"> into every page. The engines flag its inline styles
// on every page although it is not your markup. Findings that resolve to an id
// listed in ignoreSelectors are dropped from the COUNTS only; the raw reports
// on disk are untouched. The id appears in the IBM "snippet" and in the pa11y
// "selector" and "context" fields.
// ---------------------------------------------------------------------------
const PREVIEW_INJECTED_IDS = Array.isArray(CONFIG.ignoreSelectors)
  ? CONFIG.ignoreSelectors
  : ["__bs_notify__"];

function isPreviewInjected(...fields) {
  return fields.some(
    (f) => typeof f === "string" && PREVIEW_INJECTED_IDS.some((id) => f.includes(id)),
  );
}

// ---------------------------------------------------------------------------
// The IBM checker drives a headless browser through its bundled Puppeteer. On
// some machines that browser was never provisioned, so achecker cannot launch
// it and writes NO report. Point Puppeteer at a Chromium we know is present.
// Order of preference:
//   1. PUPPETEER_EXECUTABLE_PATH, if the user already set it;
//   2. ibmBrowserPath from a11y.config.json;
//   3. a Playwright-cached Chromium (Windows, macOS and Linux locations).
// If none is found we inject nothing and achecker uses whatever it can find.
// Edge and Chrome are deliberately NOT tried: this pinned achecker ships an old
// Puppeteer that drives the plain Playwright Chromium reliably but can fail to
// launch them. Affects only the IBM spawn.
// ---------------------------------------------------------------------------
function playwrightBrowserRoots() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0") {
    return [process.env.PLAYWRIGHT_BROWSERS_PATH];
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "ms-playwright")] : [];
  }
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Caches", "ms-playwright")];
  }
  return [join(homedir(), ".cache", "ms-playwright")];
}

// Relative executable locations inside a chromium-<revision> folder.
const CHROMIUM_EXECUTABLES = Object.freeze({
  win32: [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]],
  darwin: [
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ],
  linux: [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"]],
});

function findPlaywrightChromium() {
  const relatives = CHROMIUM_EXECUTABLES[process.platform] || CHROMIUM_EXECUTABLES.linux;
  for (const root of playwrightBrowserRoots()) {
    if (!existsSync(root)) continue;
    // Newest revision first.
    const folders = readdirSync(root).filter((e) => e.startsWith("chromium-")).sort().reverse();
    for (const folder of folders) {
      for (const rel of relatives) {
        const exe = join(root, folder, ...rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

function resolveIbmBrowser() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  const candidates = [CONFIG.ibmBrowserPath, findPlaywrightChromium()].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine 1: IBM Equal Access checker (PRIMARY). Reads the JSON report it
// writes (authoritative) and splits results into violations (FAIL) and
// potentials (POTENTIAL).
// ---------------------------------------------------------------------------
function runIbm(pagePath) {
  const url = pageUrl(pagePath);
  logDebug(`IBM: scanning ${url}`);

  const browser = resolveIbmBrowser();
  const extraEnv = browser ? { PUPPETEER_EXECUTABLE_PATH: browser } : undefined;
  if (browser) logDebug(`IBM: using browser ${browser}`);

  // Stamp the moment before the scan, to tell a fresh report from a stale one.
  const scanStart = Date.now();

  // 4 minute timeout covers the first-ever Chromium download.
  const res = runNpx(["-y", IBM_PKG, url], WEB_ROOT, 4 * 60 * 1000, extraEnv);

  if (res.error && res.error.code === "ENOENT") {
    return { engine: "IBM", error: "npx not found (ENOENT) even via absolute path." };
  }
  // The IBM checker exits 1 when it finds violations. That is normal, not a
  // script failure; the JSON report holds the real counts.

  let reportPath = findAcheckerReport(pagePath);

  // Staleness gate. If achecker could not launch its browser it writes nothing,
  // and the basename fallback above can return an OLD report, which would then
  // read as a fresh pass. Reject any report written before this scan began.
  if (reportPath) {
    try {
      if (statSync(reportPath).mtimeMs < scanStart) {
        logWarn(`IBM: ignoring stale report (predates this scan) at ${reportPath}`);
        reportPath = null;
      }
    } catch {
      reportPath = null;
    }
  }

  if (!reportPath) {
    const hint = browser
      ? `achecker wrote no fresh report this runner could FIND. Two causes look ` +
        `identical here: it could not launch the browser at ${browser}, or it wrote ` +
        `the report under a name we did not match. Look under ${ACHECKER_OUT} before ` +
        `blaming the browser.`
      : "achecker wrote no fresh report and no browser was found to point it at " +
        "(set PUPPETEER_EXECUTABLE_PATH, or ibmBrowserPath in a11y.config.json).";
    return { engine: "IBM", error: hint };
  }

  let data;
  try {
    data = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (e) {
    return { engine: "IBM", error: `Could not parse IBM report: ${e.message}` };
  }

  const rawResults = Array.isArray(data.results) ? data.results : [];
  const results = rawResults.filter((r) => !isPreviewInjected(r.snippet, r.path?.dom));
  const viol = results.filter((r) => Array.isArray(r.value) && r.value[1] === "FAIL");
  const pot = results.filter((r) => Array.isArray(r.value) && r.value[1] === "POTENTIAL");

  return {
    engine: "IBM",
    violations: viol.length,
    potentials: pot.length,
    violationRules: firstFive(viol.map((r) => r.ruleId)),
    potentialRules: firstFive(pot.map((r) => r.ruleId)),
    // Up to ten violation details for the hook's concise summary.
    violationDetails: viol.slice(0, 10).map((r) => ({
      rule: r.ruleId,
      message: ibmMessage(r),
      selector: r.path?.dom || "",
    })),
    reportPath,
  };
}

function ibmMessage(r) {
  if (r.message) return r.message;
  if (r.reasonId) return r.reasonId;
  return r.ruleId || "(no message)";
}

// ---------------------------------------------------------------------------
// Engine 2: pa11y with the axe runner (SECOND). Parses its JSON stdout, writes
// a copy to the reports folder, and splits errors (violations) from warnings
// (potentials).
// ---------------------------------------------------------------------------
function runPa11y(pagePath) {
  const url = pageUrl(pagePath);
  logDebug(`pa11y: scanning ${url}`);
  const res = runNpx(
    ["-y", PA11Y_PKG, "--runner", "axe", "--reporter", "json", "--config", PA11Y_CONFIG_PATH, url],
    WEB_ROOT,
    3 * 60 * 1000,
  );

  if (res.error && res.error.code === "ENOENT") {
    return { engine: "pa11y", error: "npx not found (ENOENT) even via absolute path." };
  }

  // pa11y prints a JSON array to stdout and exits 2 when it finds issues. Grab
  // from the first "[" to the last "]" in case any banner text leaks onto stdout.
  const out = (res.stdout || "").trim();
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  let issues = [];
  if (start !== -1 && end !== -1 && end >= start) {
    try {
      issues = JSON.parse(out.slice(start, end + 1));
    } catch (e) {
      return { engine: "pa11y", error: `Could not parse pa11y JSON: ${e.message}` };
    }
  } else {
    return {
      engine: "pa11y",
      error: `pa11y produced no JSON output. stderr: ${(res.stderr || "").slice(0, 200)}`,
    };
  }

  // Persist the full report. A page path may carry a query string, and Windows
  // rejects ? * : " < > | in a file name, so sanitise them out of the REPORT
  // name only; the scanned URL is untouched.
  const fileName =
    pagePath
      .replace(/^\/+/, "")
      .replace(/[\\/]/g, "__")
      .replace(/[?*:"<>|]/g, "_") + ".json";
  const reportPath = join(PA11Y_OUT, fileName);
  writeFileSync(reportPath, JSON.stringify(issues, null, 2), "utf8");

  const realIssues = issues.filter((i) => !isPreviewInjected(i.selector, i.context));
  const errors = realIssues.filter((i) => i.type === "error");
  const warnings = realIssues.filter((i) => i.type === "warning");

  return {
    engine: "pa11y",
    violations: errors.length,
    potentials: warnings.length,
    violationRules: firstFive(errors.map((i) => i.code)),
    potentialRules: firstFive(warnings.map((i) => i.code)),
    violationDetails: errors.slice(0, 10).map((i) => ({
      rule: i.code,
      message: i.message || "",
      selector: i.selector || "",
    })),
    reportPath,
  };
}

// ---------------------------------------------------------------------------
// Public: audit a single page. Returns a structured result for both engines;
// does no printing (callers decide how to present it).
// ---------------------------------------------------------------------------
export function auditPage(pagePath) {
  const ibm = runIbm(pagePath);
  const pa11y = runPa11y(pagePath);
  return { page: pagePath, ibm, pa11y };
}

// ---------------------------------------------------------------------------
// Public: is the preview server reachable? Returns a boolean with no logging,
// so the hook can stay silent and decide its own behaviour.
// ---------------------------------------------------------------------------
export async function isServerUp() {
  if (!PREVIEW_BASE) return false;
  try {
    await fetch(PREVIEW_BASE, { method: "GET" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point. Runs only when this file is executed directly.
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    logError("No page given. Usage: node .claude/a11y/audit.mjs <page-path | --all>");
    process.exit(1);
  }

  let pages;
  if (args.includes("--all")) {
    pages = KEY_PAGES.slice();
    if (pages.length === 0) {
      logError("--all was given but keyPages is empty in a11y.config.json.");
      process.exit(1);
    }
  } else {
    pages = args;
  }

  if (!(await isServerUp())) {
    logError(`Preview server is not running at ${PREVIEW_BASE}. Start it, then retry.`);
    process.exit(1);
  }

  let totalViolations = 0;
  let totalPotentials = 0;
  let hadEngineError = false;

  for (const page of pages) {
    logInfo(`\nPAGE: ${page}`);
    const { ibm, pa11y } = auditPage(page);

    for (const r of [ibm, pa11y]) {
      if (r.error) {
        hadEngineError = true;
        logError(`  ${r.engine.padEnd(6)} ERROR: ${r.error}`);
        continue;
      }
      totalViolations += r.violations;
      totalPotentials += r.potentials;
      const vr = r.violationRules.length ? r.violationRules.join(", ") : "(none)";
      const pr = r.potentialRules.length ? r.potentialRules.join(", ") : "(none)";
      logInfo(`  ${r.engine.padEnd(6)} violations: ${r.violations} [${vr}]`);
      logInfo(`  ${"".padEnd(6)} potentials: ${r.potentials} [${pr}]`);
    }
    logInfo(`  reports: ${ibm.reportPath || "-"}`);
    logInfo(`           ${pa11y.reportPath || "-"}`);
  }

  logInfo(`\nTotals — violations: ${totalViolations}, potentials: ${totalPotentials}`);
  // The CLI fails (exit 1) on any VIOLATION-level finding or engine error.
  if (totalViolations > 0 || hadEngineError) process.exit(1);
  process.exit(0);
}

// Run main() only when invoked directly, not when the hook imports this module.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    logError(`Unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  });
}
