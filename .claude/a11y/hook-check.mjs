// hook-check.mjs — PostToolUse accessibility gate.
//
// Claude Code runs this after Write/Edit/MultiEdit. It reads the hook JSON
// from stdin, works out which page(s) the edit affects, audits them, and:
//   - stays COMPLETELY SILENT (exit 0) when there are no hard violations;
//   - prints a short summary to stderr and exits 2 when there ARE hard
//     violations, so the summary comes back to Claude to fix.
//
// It gates on VIOLATION-level findings only. Manual-review "potentials" never
// make the hook speak (use /a11y-audit to see those, split by level).
//
// Silent no-op (exit 0) when: the edited file is not .html/.css/.js; it lives
// under a hookExcludePrefixes path (default .claude/ and a11y-fixtures/); the
// toggle file .claude/a11y/hook.off exists; or the preview server is down (one
// line is logged to hook.log and we move on).
//
// TWO passes run, in this order:
//   1. For a .js edit, a STATIC live-region-creator inventory (no browser, no
//      server). It speaks only when the edit introduces a creator the
//      allowlist does not cover.
//   2. The browser audit.
//
// Uses ONLY Node built-ins and imports the audit logic from audit.mjs.

import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  auditPage,
  isServerUp,
  KEY_PAGES,
  A11Y_DIR,
  PROJECT_ROOT,
  HOOK_EXCLUDE_PREFIXES,
} from "./audit.mjs";
import { findLiveRegionCreators, loadAllowlist } from "./live-region-inventory.mjs";

const TOGGLE_FILE = join(A11Y_DIR, "hook.off");
const LOG_FILE = join(A11Y_DIR, "hook.log");
const MAX_LINES = 12; // hard cap on the stderr summary
const ALLOWLIST_REL = ".claude/a11y/live-region-allowlist.json";

// Read everything from stdin (the hook payload JSON).
async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

// Convert an absolute or relative edited-file path into a path relative to the
// project root, with forward slashes. Returns null if the file is outside the
// project.
function toProjectRelative(filePath) {
  const abs = resolve(PROJECT_ROOT, filePath);
  const rel = relative(PROJECT_ROOT, abs).replace(/\\/g, "/");
  if (rel.startsWith("..")) return null;
  return rel;
}

// Build the at-most-12-line summary for a flat list of violations.
function buildSummary(relFile, violations, primaryReport) {
  const lines = [];
  lines.push(`A11y: ${violations.length} violation(s) after editing ${relFile}`);

  // Reserve one line for the trailing "full report" pointer.
  const detailBudget = MAX_LINES - 2; // header + trailer
  const shown = violations.slice(0, detailBudget);
  for (const v of shown) {
    const msg = (v.message || "").replace(/\s+/g, " ").slice(0, 80);
    const sel = (v.selector || "").replace(/\s+/g, " ").slice(0, 50);
    lines.push(`  [${v.engine}] ${v.page} ${v.rule}: ${msg}${sel ? ` (${sel})` : ""}`);
  }

  const remaining = violations.length - shown.length;
  if (remaining > 0) {
    lines.push(`  …and ${remaining} more — full report at ${primaryReport}`);
  } else {
    lines.push(`  full report at ${primaryReport}`);
  }
  return lines.join("\n");
}

// Build the at-most-12-line summary for a new live-region creator.
function buildLiveRegionSummary(relFile, findings, allowed) {
  const lines = [];
  lines.push(
    `A11y: ${relFile} creates ${findings.length} live region(s); allowlist permits ${allowed}`,
  );

  // Header + two trailer lines, so the findings get the rest.
  const detailBudget = MAX_LINES - 3;
  const shown = findings.slice(0, detailBudget);
  for (const f of shown) {
    const snippet = (f.snippet || "").replace(/\s+/g, " ").slice(0, 60);
    lines.push(`  line ${f.line} [${f.kind}] ${snippet}`);
  }
  const remaining = findings.length - shown.length;
  if (remaining > 0) lines.push(`  …and ${remaining} more`);

  lines.push(
    "  A live region created at the moment its message is written is often not announced.",
  );
  lines.push(
    `  Write into one long-lived region that exists from page load, or add an entry to ${ALLOWLIST_REL}.`,
  );
  return lines.join("\n");
}

// The static pass. Returns a summary string when the edit introduces a creator
// the allowlist does not cover, otherwise null. Never throws: a fault in this
// check must not block the edit, nor stop the browser audit that follows it.
function checkLiveRegions(rel) {
  try {
    const source = readFileSync(resolve(PROJECT_ROOT, rel), "utf8");
    const findings = findLiveRegionCreators(source, rel);
    if (findings.length === 0) return null; // excluded paths also land here

    const entry = loadAllowlist().files.find((f) => f.file === rel);
    const allowed = entry ? entry.count : 0;
    if (findings.length <= allowed) return null;
    return buildLiveRegionSummary(rel, findings, allowed);
  } catch {
    return null;
  }
}

async function main() {
  // ----- Parse the hook payload -----
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // Malformed or empty payload: do nothing, do not block the edit.
    process.exit(0);
  }
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  // ----- Toggle: if hook.off exists, do nothing -----
  if (existsSync(TOGGLE_FILE)) process.exit(0);

  // ----- Only audit HTML/CSS/JS -----
  const lower = filePath.toLowerCase();
  const isHtml = lower.endsWith(".html");
  const isCss = lower.endsWith(".css");
  const isJs = lower.endsWith(".js");
  if (!isHtml && !isCss && !isJs) process.exit(0);

  // ----- Work out the project-relative path and skip excluded areas -----
  // Excluded areas typically hold deliberately broken fixtures or the tooling
  // itself, which the gate would otherwise fail on every edit.
  const rel = toProjectRelative(filePath);
  if (!rel) process.exit(0);
  if (HOOK_EXCLUDE_PREFIXES.some((prefix) => rel.startsWith(prefix))) process.exit(0);

  // ----- Static pass: live-region creators (no server, no browser) -----
  // Runs BEFORE the browser audit on purpose: it needs neither the preview
  // server nor an engine, so it still speaks where the audit would skip.
  if (isJs) {
    const liveRegionSummary = checkLiveRegions(rel);
    if (liveRegionSummary) {
      console.error(liveRegionSummary);
      process.exit(2);
    }
  }

  // ----- Map the edited file to the page(s) to audit -----
  // An HTML file maps to itself; a CSS or JS file maps to the keyPages list
  // (a change to shared styles or scripts can affect any of them).
  let pages;
  if (isHtml) {
    pages = [rel];
  } else {
    pages = KEY_PAGES.slice();
    if (pages.length === 0) process.exit(0); // nothing configured to audit
  }

  // ----- If the server is down, log one line and stay silent -----
  if (!(await isServerUp())) {
    try {
      const stamp = new Date().toISOString();
      appendFileSync(LOG_FILE, `${stamp} server down — skipped audit after editing ${rel}\n`);
    } catch {
      // If even logging fails, still do not block the edit.
    }
    process.exit(0);
  }

  // ----- Audit each page and collect VIOLATION-level findings only -----
  const flat = [];
  let primaryReport = join(A11Y_DIR, "reports");
  for (const page of pages) {
    const { ibm, pa11y } = auditPage(page);
    for (const engineResult of [ibm, pa11y]) {
      if (engineResult.error) continue; // never block on an engine error
      const details = engineResult.violationDetails || [];
      if (details.length && primaryReport === join(A11Y_DIR, "reports")) {
        primaryReport = engineResult.reportPath || primaryReport;
      }
      for (const d of details) {
        flat.push({ page, engine: engineResult.engine, ...d });
      }
    }
  }

  // ----- Pass: stay silent -----
  if (flat.length === 0) process.exit(0);

  // ----- Fail: print a concise summary to stderr and exit 2 -----
  console.error(buildSummary(rel, flat, primaryReport));
  process.exit(2);
}

main().catch(() => {
  // Any unexpected error must never block the edit.
  process.exit(0);
});
