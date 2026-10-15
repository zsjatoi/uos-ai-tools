// nvda-prove.mjs — the REAL-NVDA proving test (Phase 2 fidelity check).
//
// Unlike sr-prove.mjs (the VIRTUAL reader — a JS simulation), this drives the
// real NVDA engine: Guidepup's pinned portable build, **NVDA 2021.3.1**, via the
// NVDA Remote Access addon. It reads the speech TEXT NVDA emits over that channel
// (no audio needed; the build runs at volume 0). It proves things the virtual
// reader cannot: that the real engine announces validation state, native
// `required`, and a role="status" live-region update for the demo form.
//
// IMPORTANT LABELLING: every result here is "real NVDA engine (Guidepup pinned
// build, NVDA 2021.3.1)" — NOT "NVDA 2026.1". The pinned build is older than the
// NVDA a human runs; a missing announcement may be a 2021-build phrasing
// difference, not a page failure. We print the FULL spokenPhraseLog per step so a
// human can judge, and echo the exact spoken string on any assertion FAIL.
//
// FOREGROUND IS A HARD GATE. NVDA reads whatever window owns the OS foreground.
// The after.html announcement assertions are meaningless unless NVDA is actually
// on the browser. We bring the browser frontmost DETERMINISTICALLY with our own
// Win32 helper (Get-Process chrome -> ShowWindow + ALT-key trick +
// SetForegroundWindow) — NOT Guidepup's windowsActivate, whose internal
// `Get-Process chrome.exe` is rejected by PowerShell so its SetForegroundWindow
// no-ops. We also MINIMISE VS Code first so it cannot reclaim the foreground, and
// RESTORE it on exit. We then verify the browser holds the foreground before
// judging, re-checking between steps. If foreground is never acquired or is lost
// mid-run we ABORT as an ENVIRONMENT condition — never as a page failure.
//
// Real NVDA is Windows-only and takes over the screen reader and the OS
// foreground, so run it only on a quiet desktop. Guidepup's portable NVDA must be
// permitted on the machine. The toolchain + portable NVDA live OUTSIDE the repo (%LOCALAPPDATA%\claude-
// a11y-sr). The browser is the cached chromium-1223, launched HEADED by explicit
// executablePath — NVDA cannot read a headless browser. On-demand only; NEVER
// wired into the PostToolUse hook.
//
// Run:  node .claude/a11y/sr/nvda-prove.mjs [page]   (default a11y-fixtures/form-demo/after.html)
//       Preview server must be up (previewBase in sr-config.json). The run momentarily minimises VS Code.
//
// Exit codes: 0 all assertions pass · 1 foreground held but an assertion failed
//             (genuine — strings shown) · 2 foreground tooling blocked/errored
//             (e.g. PowerShell/Add-Type policy) · 3 environment: foreground not
//             acquired or lost.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CONFIG, isServerUp, resolveInstallDir } from "./sr-audit.mjs";

// --- house-style logging -----------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
function shouldLog(level) { return level <= DEFAULT_LOG_LEVEL; }
function logError(m, ...a) { if (shouldLog(LOG_LEVELS.ERROR)) console.error(m, ...a); }
function logWarn(m, ...a) { if (shouldLog(LOG_LEVELS.WARN)) console.warn(m, ...a); }
function logInfo(m, ...a) { if (shouldLog(LOG_LEVELS.INFO)) console.log(m, ...a); }

const BUILD_LABEL = "real NVDA engine (Guidepup pinned build, NVDA 2021.3.1)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- resolve the external toolchain (playwright + real NVDA) ------------------
const installDir = resolveInstallDir();
const pkgJson = join(installDir, "package.json");
if (!existsSync(pkgJson)) {
  logError(`Toolchain not installed at ${installDir}. See .claude/a11y/sr/SETUP.md.`);
  process.exit(1);
}
const requireExternal = createRequire(pkgJson);
const { chromium } = requireExternal("playwright");
const { nvda, WindowsKeyCodes, WindowsModifiers } = requireExternal("@guidepup/guidepup");

const PREVIEW_BASE = (CONFIG.previewBase || "").replace(/\/+$/, "");
const pageUrl = (p) => (/^https?:\/\//i.test(p) ? p : `${PREVIEW_BASE}/${p.replace(/^\/+/, "")}`);

// --- Win32 foreground control (our own; Guidepup's windowsActivate is buggy) --
// Run a PowerShell script via -EncodedCommand to avoid all quoting issues.
// Throws if PowerShell itself is blocked (caller treats as exit 2).
function runPwsh(script) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64],
    { encoding: "utf8", timeout: 20000 }
  );
}

const WIN32_ADDTYPE = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
}
"@
`;

// Minimise VS Code, then force the chromium test window (matched by page title)
// to the OS foreground using the ALT-key trick that bypasses the foreground lock.
// Returns the helper's stdout (contains FG=True/False and TITLE=...).
function forceBrowserForeground(pageTitle) {
  const psTitle = pageTitle.replace(/'/g, "''"); // single-quote escape for PS literal
  const script = `${WIN32_ADDTYPE}
$ErrorActionPreference = 'SilentlyContinue'
# Minimise VS Code windows so they cannot reclaim the foreground.
Get-Process Code | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [Fg]::ShowWindow($_.MainWindowHandle, 6) | Out-Null }
Start-Sleep -Milliseconds 250
# Find the chromium-1223 test window by its page title (unique to the test).
$p = Get-Process chrome | Where-Object { $_.MainWindowTitle -like '*${psTitle}*' } | Select-Object -First 1
if (-not $p) { 'NO_WINDOW'; exit 0 }
$h = $p.MainWindowHandle
[Fg]::ShowWindow($h, 9) | Out-Null          # SW_RESTORE
[Fg]::keybd_event(0xA4, 0, 0, [UIntPtr]::Zero)  # ALT down  (foreground-lock bypass)
[Fg]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero)  # ALT up
[Fg]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 350
$fg = [Fg]::GetForegroundWindow()
'FG=' + ($fg -eq $h)
'TITLE=' + $p.MainWindowTitle
`;
  return runPwsh(script);
}

// Restore VS Code to the foreground at the end of the run.
function restoreIde() {
  try {
    runPwsh(`${WIN32_ADDTYPE}
$ErrorActionPreference = 'SilentlyContinue'
$c = Get-Process Code | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($c) { [Fg]::ShowWindow($c.MainWindowHandle, 9) | Out-Null; [Fg]::SetForegroundWindow($c.MainWindowHandle) | Out-Null }
`);
  } catch (_) { /* best-effort */ }
}

// --- foreground verification (via Win32 GetForegroundWindow) -----------------
// Check the OS foreground DIRECTLY rather than via NVDA's reportTitle: a repeated
// NVDA "report title" is interpreted as the multi-press "spell title" gesture (it
// starts spelling "C, o, n, f, ..."), which is unreliable to parse and perturbs
// NVDA. GetForegroundWindow is deterministic and side-effect-free.
const MOVE_TO_TOP = { keyCode: [WindowsKeyCodes.Home], modifiers: [WindowsModifiers.Control] };
function isBrowserForeground(pageTitle) {
  const psTitle = pageTitle.replace(/'/g, "''");
  const out = runPwsh(`${WIN32_ADDTYPE}
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-Process chrome | Where-Object { $_.MainWindowTitle -like '*${psTitle}*' } | Select-Object -First 1
if (-not $p) { 'FG=False'; 'TITLE=NO_WINDOW'; exit 0 }
$fg = [Fg]::GetForegroundWindow()
'FG=' + ($fg -eq $p.MainWindowHandle)
'TITLE=' + $p.MainWindowTitle
`);
  return { acquired: /FG=True/.test(out), raw: (out || "").replace(/\s+/g, " ").trim() };
}

// Move NVDA to the start of the browser web content. Assumes the browser already
// owns the foreground (gated by the caller).
async function navigateToWebContent(page) {
  await nvda.perform(nvda.keyboardCommands.exitFocusMode);
  await page.locator("body").waitFor();
  await page.locator("body").focus();
  await page.locator("body").click();
  await page.locator("body").blur();
  await nvda.perform(nvda.keyboardCommands.readNextFocusableItem);
  await nvda.perform(nvda.keyboardCommands.toggleBetweenBrowseAndFocusMode);
  await nvda.perform(nvda.keyboardCommands.toggleBetweenBrowseAndFocusMode);
  await nvda.perform(nvda.keyboardCommands.exitFocusMode);
  await nvda.perform(MOVE_TO_TOP);
  await nvda.clearSpokenPhraseLog();
}

// Wait until NVDA's speech settles (lastSpokenPhrase unchanged for `quietMs`).
async function settle(timeoutMs = 5000, quietMs = 1000) {
  let last = await nvda.lastSpokenPhrase();
  const start = Date.now();
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(200);
    const cur = await nvda.lastSpokenPhrase();
    if (cur !== last) { last = cur; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) break;
  }
}

// One capture step: clear the log, do the action, settle, print + return the log.
async function capture(label, action, opts = {}) {
  const { settleMs = 5000, quietMs = 1000 } = opts;
  await nvda.clearSpokenPhraseLog();
  await action();
  await settle(settleMs, quietMs);
  const log = await nvda.spokenPhraseLog();
  logInfo(`\n--- ${label} — spokenPhraseLog (${log.length}) ---`);
  log.forEach((p, i) => logInfo(`  ${String(i).padStart(2, " ")} | ${p}`));
  return log;
}

// Restore the IDE, then exit with the given code.
function finish(code) {
  restoreIde();
  process.exit(code);
}

// --- capability gate: real NVDA is Windows-only AND per-machine ---------------
// Permitted only if this is Windows and Guidepup's portable NVDA is registered
// (HKCU\Software\Guidepup\Nvda) AND its nvda.exe exists. The registry key path is
// overridable via A11Y_NVDA_REGKEY so the fallback can be exercised without
// touching the real key.
function nvdaCapability() {
  if (process.platform !== "win32") return { permitted: false, reason: "not Windows" };
  const regKey = process.env.A11Y_NVDA_REGKEY || "HKCU\\Software\\Guidepup\\Nvda";
  try {
    const out = execFileSync("reg", ["query", regKey], { encoding: "utf8" });
    const m = out.match(/REG_SZ\s+([^\r\n]+)/i);
    const dir = m ? m[1].trim() : null;
    const exe = dir ? join(dir, "nvda.exe") : null;
    if (!exe || !existsSync(exe)) {
      return { permitted: false, reason: `Guidepup NVDA registered but nvda.exe missing (${exe || "no REG_SZ value"})` };
    }
    return { permitted: true, reason: dir };
  } catch (_) {
    return { permitted: false, reason: `registry key ${regKey} not present (run @guidepup/setup)` };
  }
}

async function main() {
  const page = process.argv[2] || "a11y-fixtures/form-demo/after.html";

  // Capability gate FIRST. Never error where real NVDA isn't permitted; tell the
  // caller (the /a11y-nvda command) to fall back to the virtual reader. Exit 4 is
  // the dedicated "not permitted here — fall back" code.
  const cap = nvdaCapability();
  if (!cap.permitted) {
    logWarn(`Real NVDA not available on this machine: ${cap.reason}.`);
    logInfo(`FALLBACK: real NVDA not permitted here — use the virtual reader instead:`);
    logInfo(`  /a11y-sr ${page}   (node .claude/a11y/sr/sr-audit.mjs ${page})`);
    process.exit(4);
  }
  logInfo(`NVDA capability OK (Guidepup permitted): ${cap.reason}`);

  const url = pageUrl(page);

  if (!(await isServerUp())) {
    logError(`Preview server not running at ${PREVIEW_BASE}. Start your preview server (previewBase in sr-config.json) and retry.`);
    process.exit(1);
  }
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath) || !executablePath.includes(`chromium-${CONFIG.chromiumRevision}`)) {
    logWarn(`Chromium executablePath not the pinned chromium-${CONFIG.chromiumRevision}: ${executablePath}`);
  }

  logInfo(`Engine: ${BUILD_LABEL}`);
  logInfo(`Browser (headed, explicit): ${executablePath}`);
  logInfo(`Reading: ${url}`);
  logInfo(`Note: real NVDA speech captured over the Remote Access channel (not a simulation).`);

  const browser = await chromium.launch({ executablePath, headless: false });
  const results = {};
  const stepText = {};
  let abortMsg = null;

  try {
    await nvda.start();
    const tab = await browser.newPage();
    // MEASURED, not set. These run headed and commandeer the foreground, so forcing
    // a window size could change what NVDA reads and would need a real-NVDA
    // re-verification to clear. Playwright still emulates a viewport in headed mode
    // unless viewport:null is passed, so print what it actually is rather than
    // assuming the OS window governs.
    console.log(`Viewport (measured, not set): ${JSON.stringify(tab.viewportSize())}`);
    await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const pageTitle = await tab.title();

    // --- FOREGROUND GATE -----------------------------------------------------
    let fgOut;
    try {
      fgOut = forceBrowserForeground(pageTitle);
    } catch (e) {
      logError(`\nForeground tooling failed (PowerShell/Add-Type blocked or errored): ${e.message}`);
      await nvda.stop();
      await browser.close();
      logError(
        `\nABORT (exit 2) — environment: the Win32 foreground helper is unavailable on this machine ` +
        `(likely a managed-policy block on PowerShell/Add-Type). This is NOT a page failure and NOT ` +
        `focus-stealing; the after.html assertions were not evaluated.`
      );
      finish(2);
    }
    logInfo(`\nForeground helper output: ${JSON.stringify((fgOut || "").replace(/\s+/g, " ").trim())}`);
    await tab.bringToFront();
    await sleep(800);

    const fg = isBrowserForeground(pageTitle);
    logInfo(`Foreground acquired (Win32 confirms): ${fg.acquired}  [${fg.raw}]`);
    if (!fg.acquired) {
      await nvda.stop();
      await browser.close();
      logError(
        `\nABORT (exit 3) — environment: browser foreground not acquired. The after.html ` +
        `announcement assertions are MEANINGLESS until the browser holds the foreground and were ` +
        `NOT evaluated. Win32 reported: ${JSON.stringify(fg.raw)}.`
      );
      finish(3);
    }

    await navigateToWebContent(tab);

    let held = isBrowserForeground(pageTitle);
    if (!held.acquired) {
      abortMsg = `browser foreground LOST during navigateToWebContent (Win32: ${held.raw})`;
    }

    const steps = [
      {
        key: "A",
        run: async () => {
          // Set DOM focus on the clean field, then have NVDA report the focused
          // control. (moveToNextFormField sends the quick-nav 'f' key, which gets
          // TYPED into the field in focus mode — polluting it — so we don't use it.)
          const log = await capture("A: focus clean 'Full name'; NVDA reports it", async () => {
            await tab.locator("#full-name").focus();
            await sleep(400);
            await nvda.perform(nvda.keyboardCommands.reportCurrentFocus);
          });
          const t = log.join(" | ").toLowerCase();
          stepText.A = log.join(" | ");
          results["A: announces label 'Full name'"] = /full name/.test(t);
          results["A: announces 'required' (native required)"] = /required/.test(t);
          results["A: NOT yet invalid (clean field)"] = !/invalid/.test(t);
        },
      },
      {
        key: "B",
        run: async () => {
          const log = await capture("B: submit empty form, then NVDA reports focused field", async () => {
            await tab.locator("button[type=submit]").click();
            await sleep(700);
            await nvda.perform(nvda.keyboardCommands.reportCurrentFocus);
          });
          const activeId = await tab.evaluate(() =>
            document.activeElement ? document.activeElement.id : null
          );
          const t = log.join(" | ").toLowerCase();
          stepText.B = log.join(" | ");
          results["B: focus moved to first invalid field (#full-name)"] = activeId === "full-name";
          results["B: announcement contains label 'Full name'"] = /full name/.test(t);
          results["B: announcement contains an INVALID indication"] = /invalid/.test(t);
          results["B: announcement contains error 'Enter your full name'"] = /enter your full name/.test(t);
        },
      },
      {
        key: "C",
        run: async () => {
          await tab.locator("#full-name").fill("Ada Lovelace");
          await tab.locator("#email").fill("ada@example.com");
          await tab.locator("#c-highfield").check();
          const log = await capture("C: submit the now-valid form", async () => {
            await tab.locator("button[type=submit]").click();
            await sleep(2000); // give the polite role="status" region time to be announced
          }, { settleMs: 10000, quietMs: 2500 });
          const t = log.join(" | ").toLowerCase();
          stepText.C = log.join(" | ");
          // Separate the PAGE's job (populate the role="status" region) from
          // NVDA's auto-announcement of it. The DOM check proves the page did its
          // job; the spoken check is the (flaky) polite live-region capture. If
          // the DOM is populated but nothing was spoken, that is a capture/build
          // limitation, NOT a page failure.
          const confirmText = (await tab.evaluate(() => {
            const el = document.getElementById("confirm");
            return el ? el.textContent : "";
          })).toLowerCase();
          results["C: page populated role=status region in DOM"] =
            /registration has been received/.test(confirmText) || /thank you/.test(confirmText);
          results["C: real NVDA ANNOUNCED the confirmation (polite live region)"] =
            /registration has been received/.test(t) || /thank you/.test(t);
        },
      },
    ];

    for (const step of steps) {
      if (abortMsg) break;
      const h = isBrowserForeground(pageTitle);
      if (!h.acquired) {
        abortMsg = `browser foreground LOST before step ${step.key} (Win32: ${h.raw})`;
        break;
      }
      await step.run();
    }

    await nvda.stop();
  } catch (e) {
    logError(`\nError during NVDA proving run: ${e.stack || e.message}`);
    try { await nvda.stop(); } catch (_) {}
    await browser.close();
    finish(1);
  } finally {
    await browser.close();
  }

  // --- report ----------------------------------------------------------------
  logInfo(`\n=== RESULTS (${BUILD_LABEL}) ===`);
  let allPass = Object.keys(results).length > 0;
  for (const [name, ok] of Object.entries(results)) {
    logInfo(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) {
      allPass = false;
      const k = name[0];
      logInfo(`        captured (${k}): ${JSON.stringify(stepText[k] || "")}`);
    }
  }

  if (abortMsg) {
    logError(
      `\nABORT (exit 3) — environment: ${abortMsg}. Assertions after this point were NOT ` +
      `evaluated; any results above were judged WHILE the browser held the foreground. This is ` +
      `an environment condition, not a page failure.`
    );
    finish(3);
  }

  logInfo(
    `\n${allPass ? "PROOF PASSED" : "PROOF INCOMPLETE"} — these are real NVDA engine announcements ` +
    `(Guidepup pinned build, NVDA 2021.3.1), captured over the Remote Access channel while the ` +
    `browser held the foreground. A FAIL prints the exact spoken string above: weigh a 2021-build ` +
    `phrasing difference against a page that genuinely did not announce. This is NOT NVDA 2026.1 ` +
    `and NOT a statement of general usability.`
  );
  finish(allPass ? 0 : 1);
}

main().catch((e) => {
  logError(`Unexpected error: ${e.stack || e.message}`);
  finish(1);
});
