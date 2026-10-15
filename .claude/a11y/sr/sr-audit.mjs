// sr-audit.mjs — screen-reader (virtual) audit runner.
//
// On-demand companion to the static-audit runner (../audit.mjs). It drives a
// REAL browser (the Playwright chromium-1223 build) and reads the page through
// the Guidepup VIRTUAL screen reader: a JS simulation of a screen reader that
// walks the page's accessibility tree and reports what each item would be
// voiced as.
//
// This is NOT real NVDA. It catches accessible-name / role / state and
// reading-order problems early; it does not reproduce NVDA's actual speech,
// browser<->SR quirks, or live-region timing. See SETUP.md and the manual
// checks reference.
//
// The npm toolchain lives OUTSIDE your project (see SETUP.md), in A11Y_SR_HOME
// or a per-user default folder. playwright@1.60.0 is the matched pair for
// chromium-1223, and we launch it by EXPLICIT executablePath (logged on every
// run) rather than any floating default, so every machine drives the same
// browser.

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// --- logging: configurable levels, British spelling -----------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
const ENABLE_ALL_LOGGING = false;
const DISABLE_ALL_LOGGING = false;
function shouldLog(level) {
  if (DISABLE_ALL_LOGGING) return false;
  if (ENABLE_ALL_LOGGING) return true;
  return level <= DEFAULT_LOG_LEVEL;
}
function logError(m, ...a) { if (shouldLog(LOG_LEVELS.ERROR)) console.error(m, ...a); }
function logWarn(m, ...a) { if (shouldLog(LOG_LEVELS.WARN)) console.warn(m, ...a); }
function logInfo(m, ...a) { if (shouldLog(LOG_LEVELS.INFO)) console.log(m, ...a); }
function logDebug(m, ...a) { if (shouldLog(LOG_LEVELS.DEBUG)) console.log(m, ...a); }

// --- locate config + the external toolchain ----------------------------------
const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/.claude/a11y/sr
export const PROJECT_ROOT = resolve(HERE, "..", "..", ".."); // <root>
export const CONFIG = JSON.parse(readFileSync(join(HERE, "sr-config.json"), "utf8"));

// Resolve the external install dir: A11Y_SR_HOME if set, otherwise a per-user
// folder outside the project (so a synced or committed tree never holds
// node_modules):
//   Windows  %LOCALAPPDATA%\claude-a11y-sr
//   macOS    ~/Library/Application Support/claude-a11y-sr
//   Linux    ~/.local/share/claude-a11y-sr
export function resolveInstallDir() {
  const override = process.env[CONFIG.installDirEnv];
  if (override) return resolve(override);

  let base;
  if (process.platform === "win32") base = process.env.LOCALAPPDATA;
  else if (process.platform === "darwin") base = join(homedir(), "Library", "Application Support");
  else base = join(homedir(), ".local", "share");

  if (!base) {
    throw new Error(
      `Cannot resolve the screen-reader toolchain folder: set ${CONFIG.installDirEnv}. ` +
      `See .claude/a11y/sr/SETUP.md.`
    );
  }
  return join(base, CONFIG.installDirName);
}

const PREVIEW_BASE = (CONFIG.previewBase || "").replace(/\/+$/, "");

// The viewport every headless runner in this folder uses. Playwright already
// emulates 1280x720 by default, so passing it explicitly changes NOTHING about what
// these runners see — it makes the value deterministic, greppable, and printable
// instead of an unstated default nobody can find. That matters when a page hides
// labels below a breakpoint: the viewport silently decides what the reader sees.
export const VIEWPORT = CONFIG.viewport || { width: 1280, height: 720 };
export const viewportLabel = (v = VIEWPORT) => `${v.width}x${v.height}`;

function pageUrl(pageOrUrl) {
  if (/^https?:\/\//i.test(pageOrUrl)) return pageOrUrl;
  return `${PREVIEW_BASE}/${pageOrUrl.replace(/^\/+/, "")}`;
}

// --- preview server reachability (mirrors audit.mjs) -------------------------
export async function isServerUp() {
  if (!PREVIEW_BASE) return false;
  try { await fetch(PREVIEW_BASE, { method: "GET" }); return true; }
  catch { return false; }
}

// --- core: speak a page with the virtual screen reader -----------------------
// Returns { url, executablePath, spokenPhraseLog: string[] }.
export async function speakPage(pageOrUrl) {
  const installDir = resolveInstallDir();
  const pkgJson = join(installDir, "package.json");
  if (!existsSync(pkgJson)) {
    throw new Error(
      `Screen-reader toolchain not installed at ${installDir} (no package.json). ` +
      `Install it per .claude/a11y/sr/SETUP.md (run npm from INSIDE that dir).`
    );
  }

  // Resolve playwright + the virtual reader from the EXTERNAL node_modules.
  const requireExternal = createRequire(pkgJson);
  const { chromium } = requireExternal("playwright");
  // The package's "exports" map exposes the self-contained browser ESM build
  // as the "./browser.js" subpath (resolving to lib/esm/index.browser.js).
  const readerPath = requireExternal.resolve(
    "@guidepup/virtual-screen-reader/browser.js"
  );
  const readerSrc = readFileSync(readerPath, "utf8");

  // Explicit, logged browser path — the proven chromium-1223 build, not a default.
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath)) {
    throw new Error(
      `Cached Chromium not found at ${executablePath}. Expected the chromium-` +
      `${CONFIG.chromiumRevision} build in the Playwright browser cache. See SETUP.md.`
    );
  }
  if (!executablePath.includes(`chromium-${CONFIG.chromiumRevision}`)) {
    logWarn(
      `Chromium executablePath does not look like the pinned chromium-` +
      `${CONFIG.chromiumRevision} build: ${executablePath}`
    );
  }

  const url = pageUrl(pageOrUrl);
  logInfo(`SR: launching ${executablePath}`);
  logInfo(`SR: viewport (explicit) ${VIEWPORT.width}x${VIEWPORT.height}`);
  logInfo(`SR: reading ${url}`);

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    // domcontentloaded, not load: the broken fixture references an external
    // placeholder image we must not wait on.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Run the virtual reader INSIDE the page against the real, rendered DOM.
    // The reader's self-contained browser ESM build is injected via a blob
    // URL import so we get its proper exports (no reliance on minified names).
    const spokenPhraseLog = await page.evaluate(async (src) => {
      const blobUrl = URL.createObjectURL(
        new Blob([src], { type: "text/javascript" })
      );
      try {
        const mod = await import(blobUrl);
        const virtual = mod.virtual;
        await virtual.start({ container: document.body });
        // Walk forward through the whole accessibility tree exactly once. The
        // reader treats document.body as a "document" root and WRAPS back to the
        // start after the final node, so we stop the first time we reach the
        // top-level "end of document" — that is one complete pass. A generous
        // guard caps any unexpected runaway.
        let guard = 0;
        while (guard++ < 1000) {
          await virtual.next();
          const cur = await virtual.lastSpokenPhrase();
          if (/^end of document\b/i.test(cur)) break;
        }
        const log = await virtual.spokenPhraseLog();
        await virtual.stop();
        return log;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }, readerSrc);

    return { url, executablePath, spokenPhraseLog };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (used by the CLI below and by sr-prove.mjs).
// ---------------------------------------------------------------------------

// The virtual reader treats document.body as a "document" root and WRAPS back
// to the start after the final node. speakPage() already stops at the first
// top-level "end of document", but cut defensively at that boundary so callers
// always see exactly ONE pass.
export function firstPass(log) {
  const end = log.findIndex((p) => /^end of document\b/i.test(p));
  return end === -1 ? log : log.slice(0, end + 1);
}

// Roles whose announcement carries an accessible NAME the user must hear. An
// empty name on an INTERACTIVE role is a likely problem (a control a screen
// reader user cannot identify).
const NAMED_ROLE_RE =
  /^(heading|link|button|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem(?:checkbox|radio)?|tab|switch|slider|spinbutton|image|img|graphic)\b(?:,\s*(.*))?$/i;
const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
  "switch", "slider", "spinbutton",
]);

// Parse one pass of announcements into the items a screen-reader review cares
// about: headings, interactive controls (with names), and images. Flags any
// interactive control with NO accessible name, and any image announced bare
// (no name — possibly missing alt, or legitimately decorative).
export function summarisePage(onePassLog) {
  const headings = [];
  const interactive = [];
  const images = [];
  const unnamedInteractive = [];
  const unnamedImages = [];

  for (const phrase of onePassLog) {
    if (/^end of\b/i.test(phrase)) continue;
    const m = phrase.match(NAMED_ROLE_RE);
    if (!m) continue;
    const role = m[1].toLowerCase();
    // First comma-separated segment after the role is the name; later segments
    // (e.g. "level 2", "position 1") are state, not name.
    let name = (m[2] || "").trim().replace(/,\s*(level|position|set size)\b.*$/i, "").trim();
    const entry = { role, name, phrase };

    if (role === "heading") headings.push(entry);
    else if (role === "image" || role === "img" || role === "graphic") {
      images.push(entry);
      if (name === "") unnamedImages.push(entry);
    } else {
      interactive.push(entry);
      if (INTERACTIVE_ROLES.has(role) && name === "") unnamedInteractive.push(entry);
    }
  }
  return { headings, interactive, images, unnamedInteractive, unnamedImages };
}

// ---------------------------------------------------------------------------
// CLI: speak a single page and print what was voiced + a names review.
// Informational only — it does NOT gate (no pass/fail oracle for an arbitrary
// page), but it flags interactive controls voiced with no accessible name.
//
//   node .claude/a11y/sr/sr-audit.mjs <page-path> [maxReadingOrderLines]
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    logError("Usage: node .claude/a11y/sr/sr-audit.mjs <page-path> [maxLines]");
    process.exit(1);
  }
  const page = args[0];
  const maxLines = Number.isFinite(Number(args[1])) && Number(args[1]) > 0 ? Number(args[1]) : 80;

  if (!(await isServerUp())) {
    logError(
      `Preview server is not running at ${PREVIEW_BASE}. Start your ` +
      `preview server (any static server on that address), then retry.`
    );
    process.exit(1);
  }

  let res;
  try {
    res = await speakPage(page);
  } catch (e) {
    logError(e.message);
    process.exit(1);
  }
  const log = firstPass(res.spokenPhraseLog);
  const s = summarisePage(log);

  logInfo(`\nBrowser (explicit, reused): ${res.executablePath}`);
  logInfo(`Reading order: ${log.length} announcements (one pass) for ${res.url}`);

  logInfo(`\n--- reading order (first ${Math.min(maxLines, log.length)}) ---`);
  log.slice(0, maxLines).forEach((p, i) => logInfo(`  ${String(i).padStart(3, " ")} | ${p}`));
  if (log.length > maxLines) logInfo(`  ... (${log.length - maxLines} more; pass a larger maxLines to see them)`);

  logInfo(`\n--- headings (${s.headings.length}) ---`);
  s.headings.forEach((h) => logInfo(`  ${h.phrase}`));

  logInfo(`\n--- interactive controls (${s.interactive.length}) ---`);
  s.interactive.forEach((c) => logInfo(`  ${c.name === "" ? "[NO NAME] " : ""}${c.phrase}`));

  logInfo(`\n--- images (${s.images.length}; ${s.unnamedImages.length} with no name) ---`);

  // The one thing a screen-reader user cannot work around: a control with no name.
  if (s.unnamedInteractive.length > 0) {
    logWarn(`\n*** ${s.unnamedInteractive.length} interactive control(s) voiced WITHOUT an accessible name: ***`);
    s.unnamedInteractive.forEach((c) => logWarn(`    ${c.phrase}`));
    logWarn(`These are likely problems: a screen-reader user cannot identify them.`);
  } else {
    logInfo(`\nNo interactive control was voiced without a name.`);
  }

  logInfo(
    `\nNote: this is the VIRTUAL (simulated) screen reader. It checks name / role / ` +
    `reading-order properties only — NOT real NVDA speech and NOT general usability. ` +
    `See .claude/skills/a11y-audit-loop/references/screen-reader-testing.md.`
  );
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    logError(`Unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  });
}
