#!/usr/bin/env node
/**
 * nvda-log-control.mjs — start / stop / status for an ISOLATED NVDA speech
 * capture.
 *
 * WHY THIS EXISTS
 * ----------------
 * NVDA at logging level Input/output records every utterance it sends to the
 * synthesiser. That is the only measurement of SPEECH this kit has that does
 * not need a person listening. But raising the level through the GUI has three
 * problems: a human has to do it, the control moved between NVDA versions, and
 * at IO level NVDA logs everything spoken machine-wide — mail, chat, window
 * titles, the agent's own transcript — into the user's own log, persistently.
 *
 * NVDA's command line solves all three at once:
 *
 *   nvda.exe -l 12 -f <our path>
 *
 * MEASURED ON NVDA 2026.1, 9 August 2026 — these are the facts this
 * file is built on, not assumptions:
 *
 *   - `-f` IS honoured on an installed (non-portable) copy. While capture was
 *     active, %TEMP%\nvda.log stayed frozen at its previous size and mtime and
 *     %TEMP%\nvda-old.log was not even rotated. Nothing reaches the user's
 *     ambient log while we are capturing.
 *   - `-l 12` does NOT persist into nvda.ini. The ini was rewritten across the
 *     capture instance's exit (mtime moved — the positive canary that a write
 *     really happened) and loggingLevel still read its original value. So the
 *     stop path needs no level-restore step.
 *   - A bare relaunch restores the configured level.
 *   - `-k` reports running state by exit code (0 running, 1 not) and does NOT
 *     restart NVDA.
 *   - `OFF` does not mean "no log file": NVDA still writes three startup INFO
 *     lines before the config applies. Never infer the level from file
 *     existence.
 *   - NVDA holds the capture file open for writing. Node's fs reads it fine;
 *     .NET's File.ReadAllText takes a sharing violation on it.
 *
 * THE RULE THIS FILE WILL NOT BREAK: if NVDA is not already running, we report
 * and stop. A screen reader starting unbidden on somebody's desktop is not
 * ours to do. The stop path honours the same principle in reverse — it
 * restores the state we found, which may be "not running at all".
 *
 * Run:
 *   node .claude/a11y/sr/nvda-log-control.mjs status
 *   node .claude/a11y/sr/nvda-log-control.mjs start
 *   node .claude/a11y/sr/nvda-log-control.mjs stop [--keep-log[=<dest>]]
 *   ... any command with --json for machine-readable output.
 * Exit: 0 success; 1 refusal, failure, or unverified capture.
 *
 * Windows-only, and it takes over the screen reader: it restarts the user's
 * NVDA, which speaks and closes Speech Viewer, so run it only on a quiet
 * desktop. On-demand only. Never wired into a PostToolUse hook.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseNvdaLog } from "./nvda-speech-log.mjs";

// ---------------------------------------------------------------------------
// Logging (project house style: configurable, British spelling).
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
// Constants
// ---------------------------------------------------------------------------

/** NVDA log levels, from its own --help. Input/output is what we capture at. */
export const NVDA_LOG_LEVELS = Object.freeze({
  DEBUG: 10,
  INPUT_OUTPUT: 12,
  DEBUG_WARNING: 15,
  INFO: 20,
  DISABLED: 100,
});

/** Exit code from `nvda.exe -k` / --check-running. */
const CHECK_RUNNING_EXIT = Object.freeze({ RUNNING: 0, NOT_RUNNING: 1 });

const STATE_SCHEMA_VERSION = 1;
const CAPTURE_SUBDIR = "listen";
const STATE_FILENAME = "nvda-capture-state.json";

/** How long to wait for the capture file to prove itself live. */
const VERIFY_TIMEOUT_MS = 20000;
const VERIFY_POLL_MS = 400;

/** How long to wait for the restored NVDA to come back up. */
const RESTART_TIMEOUT_MS = 25000;

/** How long to wait for the outgoing NVDA to release the capture file. */
const FILE_RELEASE_TIMEOUT_MS = 20000;

/**
 * How long to wait for a HUMAN to click into the driven window.
 *
 * Generous on purpose: this machine has two monitors, and the window can open
 * on the one the person is not looking at. A timeout that fires while they are
 * still hunting for it produces an abort that looks exactly like a refusal to
 * attach. Starting value, to be revised from measurement rather than taste.
 */
const ATTACH_TIMEOUT_MS = 60000;

/** A capture session older than this was abandoned by a died run. */
const ABANDONED_SESSION_MS = 4 * 60 * 60 * 1000;

/**
 * Where an installed NVDA lives, most-likely first.
 *
 * BOTH entries are load-bearing: NVDA ships a 32-bit build, which lands under
 * Program Files (x86) on 64-bit Windows. Some machines have 2026.1 under
 * Program Files and others have 2025.1.2 under Program Files (x86). Checking
 * only the 64-bit path would make runs need NVDA_EXE set by hand, and made a
 * passive survey report "NVDA not found" on a machine where NVDA was running
 * and speaking. An older build is the more likely to be 32-bit, not the less.
 */
const NVDA_EXE_CANDIDATES = [
  "C:\\Program Files\\NVDA\\nvda.exe",
  "C:\\Program Files (x86)\\NVDA\\nvda.exe",
];

const HERE = dirname(fileURLToPath(import.meta.url));
const SR_CONFIG_PATH = join(HERE, "sr-config.json");

// ---------------------------------------------------------------------------
// Paths — resolved through the existing sr-config.json convention rather than
// a second hard-coded copy of it.
// ---------------------------------------------------------------------------

export function resolveInstallDir() {
  let config = {};
  try {
    config = JSON.parse(readFileSync(SR_CONFIG_PATH, "utf8"));
  } catch {
    // Fall through to the documented defaults; a missing config must not stop
    // the tool naming where it would have written.
  }
  const envName = config.installDirEnv || "A11Y_SR_HOME";
  if (process.env[envName]) return process.env[envName];

  // NVDA is Windows-only, so the default base is %LOCALAPPDATA% (same rule as sr-audit.mjs).
  const dirName = config.installDirName || "claude-a11y-sr";
  return join(process.env.LOCALAPPDATA || "", dirName);
}

export function captureDir() {
  return join(resolveInstallDir(), CAPTURE_SUBDIR);
}

export function statePath() {
  return join(captureDir(), STATE_FILENAME);
}

/** Filename-safe local timestamp; NVDA log names must not contain colons. */
function fileStamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// NVDA facts
// ---------------------------------------------------------------------------

export function resolveNvdaExe() {
  const override = process.env.NVDA_EXE;
  if (override && existsSync(override)) return override;
  for (const candidate of NVDA_EXE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Quote a string for a single-quoted PowerShell literal.
 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Every call into nvda.exe goes through PowerShell's Start-Process.
 *
 * WHY, measured 9 August 2026: nvda.exe is manifested with UIAccess ("NVDA
 * application (has UIAccess)"), and Node's spawn/spawnSync — which use
 * CreateProcess — are refused with EACCES. Start-Process goes via ShellExecute
 * and succeeds. This is not a style choice: a direct spawn fails 100% of the
 * time, and an EACCES silently read as "not running" would make this tool
 * launch a screen reader it was told never to launch.
 *
 * @param {boolean} wait  true to block and return NVDA's exit code (for -k).
 */
function startProcess(exePath, args, { wait = false } = {}) {
  const argString = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const pieces = [`Start-Process -FilePath ${psQuote(exePath)}`];
  if (argString) pieces.push(`-ArgumentList ${psQuote(argString)}`);
  if (wait) pieces.push("-Wait -PassThru -WindowStyle Hidden");
  const command = wait
    ? `$p = ${pieces.join(" ")}; exit $p.ExitCode`
    : `${pieces.join(" ")} | Out-Null`;

  return spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, encoding: "utf8" },
  );
}

/**
 * Is NVDA running? Uses NVDA's own -k, which reports by exit code and does NOT
 * restart a running copy (measured 9 August 2026: pid unchanged across a call).
 */
export function isNvdaRunning(exePath) {
  const result = startProcess(exePath, ["-k"], { wait: true });
  if (result.error) return { running: null, error: result.error.message };
  if (result.status === CHECK_RUNNING_EXIT.RUNNING) return { running: true };
  if (result.status === CHECK_RUNNING_EXIT.NOT_RUNNING) return { running: false };
  return {
    running: null,
    error: `unexpected -k exit code ${result.status}: ${String(result.stderr).trim()}`,
  };
}

/**
 * The pids of any running nvda.exe.
 *
 * This is what makes staleness PROVABLE rather than inferred: a session whose
 * recorded pid is no longer running was abandoned, whatever else is true. It
 * uses tasklist rather than nvda.exe, so it launches nothing.
 */
export function nvdaPids() {
  const result = spawnSync(
    "tasklist",
    ["/FI", "IMAGENAME eq nvda.exe", "/NH", "/FO", "CSV"],
    { windowsHide: true, encoding: "utf8" },
  );
  const pids = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const m = /^"nvda\.exe","(\d+)"/i.exec(line.trim());
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

/**
 * Is a process still alive?
 *
 * Used to decide whether the RUN that owns a capture session still exists —
 * a different question from whether NVDA does, and the one that matters when a
 * run is killed from outside and its cleanup never executes.
 *
 * `process.kill(pid, 0)` sends no signal and only tests for existence. EPERM
 * means the process exists but belongs to someone else, which is still ALIVE —
 * treating that as dead would break another seat's live session.
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function nvdaIniPath() {
  return join(process.env.APPDATA || "", "nvda", "nvda.ini");
}

/**
 * Read [general] loggingLevel from nvda.ini.
 *
 * Returns null when the key is absent, which is a real state meaning "NVDA's
 * own default", not an error. NVDA's ini is configobj format; nested sections
 * are [[double]] bracketed, so a single-bracket heading ends [general].
 */
export function readLoggingLevel(iniPath = nvdaIniPath()) {
  if (!existsSync(iniPath)) return { level: null, iniPath, exists: false };

  const lines = readFileSync(iniPath, "utf8").split(/\r?\n/);
  let inGeneral = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^[]/.test(trimmed)) {
      inGeneral = trimmed === "[general]";
      continue;
    }
    if (!inGeneral) continue;
    const m = /^loggingLevel\s*=\s*(\S+)/.exec(trimmed);
    if (m) return { level: m[1], iniPath, exists: true };
  }
  return { level: null, iniPath, exists: true };
}

/**
 * NVDA's version, from the binary's own version resource — authoritative, and
 * it does not run NVDA. The fleet survey depends on this being right on a
 * machine whose NVDA predates this tool by five years.
 */
export function nvdaVersion(exePath) {
  const command = `(Get-Item ${psQuote(exePath)}).VersionInfo.ProductVersion`;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, encoding: "utf8" },
  );
  const version = String(result.stdout || "").trim();
  if (version) return version;

  // Fallback: the shipped user guide names the version in its opening lines.
  const guide = join(dirname(exePath), "documentation", "en", "userGuide.html");
  if (!existsSync(guide)) return null;
  const head = readFileSync(guide, "utf8").slice(0, 4000);
  const m = /NVDA\s+(\d{4}\.\d+(?:\.\d+)?)/.exec(head);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export function readState() {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { corrupt: true, error: error.message, path };
  }
}

function writeState(state) {
  mkdirSync(captureDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf8");
}

function clearState() {
  const path = statePath();
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * Is a recorded session stale — i.e. did a previous run die with capture on?
 * The tell is that the NVDA now running is not the instance we started.
 */
export function assessSession(state, exePath) {
  if (!state || state.corrupt) return { stale: false };

  const ageMs = Date.now() - new Date(state.startedAt).getTime();
  const running = exePath ? isNvdaRunning(exePath).running : null;

  if (running === false) {
    return { stale: true, ageMs, reason: "NVDA is not running, but a capture session is recorded" };
  }
  // The decisive case, and the commonest in practice: NVDA is running, but it
  // is not the instance we started — a died run, or the user restarting their
  // own screen reader. Nothing about the run state alone can see this.
  if (state.capturePid && !nvdaPids().includes(state.capturePid)) {
    return {
      stale: true,
      ageMs,
      reason: `the NVDA instance that owned this capture (pid ${state.capturePid}) is gone; a different one is running`,
    };
  }
  // THE OWNING RUN IS GONE, EVEN THOUGH ITS NVDA IS NOT.
  //
  // Seen in practice, and it cost two sittings. A listen run was
  // killed from outside (TaskStop), so its `finally` never executed and
  // commandStop never ran — but the NVDA instance it had started was still
  // alive and still capturing. Every test above therefore said "not stale":
  // NVDA was running, and the recorded capturePid WAS among the live pids. The
  // next run was refused with "a capture session is already active", and there
  // was nothing to tell an operator why.
  //
  // The precise question is whether the PROCESS THAT OWNS the session is still
  // there, and only the owner's own pid can answer it. A session whose owner
  // has gone is abandoned however healthy its NVDA looks.
  if (state.ownerPid && !isProcessAlive(state.ownerPid)) {
    return {
      stale: true,
      ageMs,
      reason: `the run that started this capture (pid ${state.ownerPid}) is gone; its NVDA was left capturing`,
    };
  }
  if (ageMs > ABANDONED_SESSION_MS) {
    return {
      stale: true,
      ageMs,
      reason: `capture session is ${Math.round(ageMs / 3600000)}h old — abandoned by a died run`,
    };
  }
  // Say so when the strong check could not run, rather than reporting a clean
  // "not stale" that was never actually tested. Without a recorded pid, a died
  // run followed by a manual NVDA restart is invisible to every rule above.
  if (!state.capturePid) {
    return {
      stale: false,
      ageMs,
      pidCheckUnavailable:
        "no owning pid was recorded for this session, so 'NVDA running but not capturing' cannot be detected",
    };
  }
  return { stale: false, ageMs };
}

// ---------------------------------------------------------------------------
// Capture verification
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the capture file to prove the level really came down.
 *
 * Never report success on the launch alone — the launch says nothing about
 * whether -f was honoured or whether the level applied. An IO or DEBUGWARNING
 * record can only appear at level <= 15, so its presence is the evidence.
 * Records with neither means the file is receiving but the level is not down,
 * which is reported as unverified rather than dressed up as success.
 */
export async function waitForLiveCapture(capturePath, timeoutMs = VERIFY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = { records: 0, io: 0, exists: false };

  while (Date.now() < deadline) {
    if (existsSync(capturePath)) {
      try {
        // Reading a file NVDA holds open for writing: Node opens shared, so
        // this works while capture is live.
        const parsed = parseNvdaLog(readFileSync(capturePath, "utf8"));
        const lowLevel = parsed.records.filter(
          (r) => r.level === "IO" || r.level === "DEBUGWARNING",
        ).length;
        lastSeen = { records: parsed.records.length, io: lowLevel, exists: true };
        if (lowLevel > 0) return { verified: true, ...lastSeen };
      } catch (error) {
        lastSeen.readError = error.message;
      }
    }
    await sleep(VERIFY_POLL_MS);
  }
  return { verified: false, ...lastSeen };
}

/**
 * Block until the screen reader demonstrably speaks FOR the driven window.
 *
 * WHY THIS EXISTS, AND WHY THE PERSON IS NEVER ASKED TO CONFIRM
 * -------------------------------------------------------------
 * Measured on one Windows machine: a programmatic raise (CDP
 * Browser.setWindowBounds + page.bringToFront) does NOT make NVDA follow the
 * window. Win32 GetForegroundWindow returns the driven browser carrying the
 * page's own title, document.hasFocus() is true, and NVDA carries on speaking
 * for whatever it was on before. Everything the agent can see says "attached";
 * the reader disagrees, and the reader is the instrument.
 *
 * A human attaches it first time — but a MOUSE CLICK ALONE DOES NOT. Observed
 * on the same machine: clicking into the driven window left keyboard focus in
 * the editor the person had come from, and NVDA stayed there with it. What
 * attaches the reader is a keyboard interaction (Alt-Tab to the window, or
 * click and then press Tab). Callers must ask for a key press, not a click.
 *
 * The person cannot TELL us they have done it without leaving the window to
 * type, which destroys the thing they just reported — so a confirm-by-message
 * handshake cannot work even in principle. Hence: they press a key, and say
 * nothing. The log is the message.
 *
 * The marker must be text the reader can only be speaking BECAUSE it is on the
 * page (its title or heading), and must not be text the run itself writes,
 * or attachment could be satisfied by the very announcement being measured.
 *
 * Returns { attached, markerUtterances, waitedMs }. NOTE that `waitedMs` is
 * DETECTION latency, not the person's reaction time: the capture is already
 * running while the window is created and raised, so someone primed and quick
 * can attach during that settle and produce a waitedMs in single-digit
 * milliseconds (measured: 14 ms). It means "the marker was already there when
 * the wait began", never "attaching took no time".
 *
 * A false is a clean abort
 * signal: the caller must NOT go on to drive, because silence from an
 * unattached reader is uninterpretable — it is neither a page result nor a
 * format result, which is the confusion this whole layer exists to prevent.
 */
export async function waitForReaderAttachment(capturePath, marker, options = {}) {
  const { timeoutMs = ATTACH_TIMEOUT_MS, pollMs = VERIFY_POLL_MS } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(capturePath)) {
      try {
        // Node opens shared, so this reads a file NVDA holds open for writing.
        const parsed = parseNvdaLog(readFileSync(capturePath, "utf8"));
        const hits = parsed.speech.filter((r) => r.text.includes(marker));
        if (hits.length > 0) {
          return {
            attached: true,
            markerUtterances: hits.length,
            waitedMs: Date.now() - startedAt,
          };
        }
      } catch {
        // A partial line mid-write is normal; keep polling.
      }
    }
    await sleep(pollMs);
  }
  return { attached: false, markerUtterances: 0, waitedMs: Date.now() - startedAt };
}

/**
 * Block until the reader stops speaking, so a measured announcement is not
 * fired into the middle of one it will lose to.
 *
 * MEASURED on one Windows machine, immediately after attachment was
 * first detected: the run fired the moment the marker appeared, and the capture
 * then held 8 utterances AFTER the fire, none of them the probe string. The
 * reader was still working through the person's own Tab navigation, and a
 * polite live-region write placed into that traffic did not survive to the
 * synthesiser. Stated as the hypothesis it is: competing focus announcements
 * are a known way to lose a polite write, and this wait is both the mitigation
 * and the test of it.
 *
 * Idleness is read from the reader's OWN log rather than slept past, because
 * how long a person takes to stop navigating is not a constant and a fixed
 * sleep would encode one machine's guess as everyone's timing.
 *
 * A false `quiet` is not fatal and callers may still fire — but they must
 * RECORD it, because a result measured into a busy reader is weaker evidence
 * than one measured into a quiet one, and nothing downstream can tell.
 */
export async function waitForSpeechQuiet(capturePath, options = {}) {
  const { quietMs = 1500, timeoutMs = 15000, pollMs = VERIFY_POLL_MS } = options;
  const startedAt = Date.now();
  let lastCount = -1;
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let count = lastCount;
    if (existsSync(capturePath)) {
      try {
        count = parseNvdaLog(readFileSync(capturePath, "utf8")).speech.length;
      } catch {
        // Partial line mid-write; treat as no change and keep polling.
      }
    }
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return { quiet: true, waitedMs: Date.now() - startedAt, utteranceCount: count };
    }
    await sleep(pollMs);
  }
  return { quiet: false, waitedMs: Date.now() - startedAt, utteranceCount: lastCount };
}

/**
 * Retry a file operation until the capture file is released.
 *
 * MEASURED 9 August 2026: a relaunch restarts NVDA, but `-k` answers "running"
 * for the OUTGOING instance as readily as the incoming one, so a run-state
 * check returns immediately while the old process still holds the capture file
 * open. Deleting it there fails with EPERM. Waiting for the file to be
 * releasable is the direct evidence that the capture instance has actually
 * gone — a better signal than the run state, which cannot distinguish the two
 * instances at all.
 */
async function retryFileOp(operation, timeoutMs = FILE_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      operation();
      return { ok: true };
    } catch (error) {
      lastError = error;
      await sleep(VERIFY_POLL_MS);
    }
  }
  return { ok: false, error: lastError ? lastError.message : "timed out" };
}

/** Wait until exactly one nvda.exe is present, so its pid can be attributed. */
async function waitForSingleNvdaPid(timeoutMs = FILE_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let pids = nvdaPids();
  while (Date.now() < deadline && pids.length !== 1) {
    await sleep(VERIFY_POLL_MS);
    pids = nvdaPids();
  }
  return pids;
}

/** Wait for NVDA to be running (or confirmed absent) after a restart. */
async function waitForRunState(exePath, wanted, timeoutMs = RESTART_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { running } = isNvdaRunning(exePath);
    if (running === wanted) return true;
    await sleep(VERIFY_POLL_MS);
  }
  return false;
}

/** Launch (or relaunch, or quit) NVDA. See startProcess for why via PowerShell. */
function launchNvda(exePath, args) {
  const result = startProcess(exePath, args, { wait: false });
  if (result.error) throw new Error(`could not launch NVDA: ${result.error.message}`);
  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function commandStatus() {
  const exePath = resolveNvdaExe();
  const ini = readLoggingLevel();
  const state = readState();
  const session = assessSession(state, exePath);

  const report = {
    computerName: process.env.COMPUTERNAME || null,
    nvdaExe: exePath,
    nvdaVersion: exePath ? nvdaVersion(exePath) : null,
    nvdaRunning: exePath ? isNvdaRunning(exePath).running : null,
    iniPath: ini.iniPath,
    loggingLevel: ini.level,
    captureDir: captureDir(),
    session: state ? { ...state, ...session } : null,
  };

  if (state && !state.corrupt && existsSync(state.capturePath)) {
    const stats = statSync(state.capturePath);
    const parsed = parseNvdaLog(readFileSync(state.capturePath, "utf8"));
    report.capture = {
      path: state.capturePath,
      bytes: stats.size,
      records: parsed.records.length,
      utterances: parsed.speech.length,
      gestures: parsed.gestures.length,
    };
  }

  return report;
}

export async function commandStart() {
  const exePath = resolveNvdaExe();
  if (!exePath) {
    return { ok: false, refusal: "NVDA executable not found. Set NVDA_EXE if it is installed elsewhere." };
  }

  const { running, error } = isNvdaRunning(exePath);
  if (error) return { ok: false, refusal: `could not determine whether NVDA is running: ${error}` };

  // The rule. Not a soft preference.
  if (!running) {
    const orphan = readState();
    return {
      ok: false,
      refusal:
        "NVDA is NOT running. This tool will not start a screen reader that the person at the keyboard did not start. Ask them to run NVDA, then try again.",
      // Surface an orphan here too — otherwise a died run's log sits on disk
      // invisibly for as long as NVDA stays closed.
      orphanedSession: orphan && !orphan.corrupt ? orphan.capturePath : null,
    };
  }

  const existing = readState();
  const session = assessSession(existing, exePath);
  let healed = null;
  if (existing) {
    if (session.stale) {
      healed = `cleared a stale capture session from ${existing.startedAt} (${session.reason})`;
      // A died run leaves its log behind too. We own this directory, so clear
      // it rather than accumulating somebody's speech on disk indefinitely.
      if (existing.capturePath && existsSync(existing.capturePath)) {
        const removed = await retryFileOp(() => rmSync(existing.capturePath, { force: true }));
        healed += removed.ok
          ? ` and deleted its orphaned log`
          : ` (its log at ${existing.capturePath} could NOT be deleted: ${removed.error})`;
      }
      clearState();
    } else {
      return {
        ok: false,
        refusal: `a capture session is already active (started ${existing.startedAt}, log ${existing.capturePath}). Run stop first.`,
      };
    }
  }

  const ini = readLoggingLevel();
  const capturePath = join(captureDir(), `nvda-speech-${fileStamp()}.log`);
  mkdirSync(captureDir(), { recursive: true });

  const preState = {
    running: true,
    loggingLevel: ini.level,
    iniPath: ini.iniPath,
  };

  launchNvda(exePath, ["-l", String(NVDA_LOG_LEVELS.INPUT_OUTPUT), "-f", capturePath]);

  const back = await waitForRunState(exePath, true);
  const verification = await waitForLiveCapture(capturePath);

  // Record the owning pid only once exactly ONE nvda.exe is present. During a
  // restart the outgoing and incoming instances briefly coexist, and sampling
  // in that window returns two pids — which is why this polls rather than
  // reading once (measured 9 August 2026: the first implementation recorded
  // null every time for exactly this reason).
  const pidsNow = await waitForSingleNvdaPid();
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    computerName: process.env.COMPUTERNAME || null,
    nvdaExe: exePath,
    nvdaVersion: nvdaVersion(exePath),
    // The pid of the RUN that owns this session, so a killed run's leftover
    // capture can be told from a live one. See assessSession.
    ownerPid: process.pid,
    capturePath,
    // Exactly one nvda.exe is expected; if the machine somehow has more, we
    // record none rather than guess which one owns the capture.
    capturePid: pidsNow.length === 1 ? pidsNow[0] : null,
    preState,
  };
  writeState(state);

  return {
    ok: verification.verified,
    healed,
    capturePath,
    nvdaBackUp: back,
    verification,
    preState,
    warning: verification.verified
      ? null
      : "Capture was NOT verified: no IO/DEBUGWARNING record appeared within the timeout. The level may not have come down. Do not treat a silent result from this session as evidence about the page.",
  };
}

export async function commandStop(options = {}) {
  const exePath = resolveNvdaExe();
  if (!exePath) return { ok: false, refusal: "NVDA executable not found." };

  const state = readState();
  if (!state) return { ok: false, refusal: "no capture session is recorded — nothing to stop." };
  if (state.corrupt) {
    clearState();
    return { ok: false, refusal: `capture state file was corrupt (${state.error}); it has been cleared.` };
  }

  const result = { capturePath: state.capturePath, preState: state.preState };
  // Only clear the session record once the capture file has actually been
  // dealt with. Clearing it after a failed delete orphans the log with nothing
  // left pointing at it — measured on the first live stop, 9 August 2026.
  let captureHandled = false;

  try {
    // Restore the state we FOUND. Phase 0 measured NVDA not running at all on
    // this machine, so "stop = bare relaunch" would have started a screen
    // reader on a desktop that had none.
    if (state.preState.running) {
      launchNvda(exePath, []);
      result.restoredBy = "bare relaunch";
      result.nvdaRunning = await waitForRunState(exePath, true);
    } else {
      launchNvda(exePath, ["-q"]);
      result.restoredBy = "-q quit (NVDA was not running before capture began)";
      result.nvdaRunning = !(await waitForRunState(exePath, false));
    }

    // -l does not persist (measured), so this is a check, not a repair. If it
    // ever fails, the measurement has changed and the design needs revisiting.
    const ini = readLoggingLevel();
    result.loggingLevel = ini.level;
    result.levelRestored = ini.level === state.preState.loggingLevel;

    if (existsSync(state.capturePath)) {
      // RELEASE TEST — rename, which is non-destructive and decisive.
      //
      // Two checks were tried first and both were wrong, recorded so nobody
      // rebuilds them. (a) Opening the file for WRITING ("r+") SUCCEEDS while
      // capture is live — NVDA shares read and write, so it proved nothing
      // while reporting success. (b) Waiting for the size to stop changing
      // across two 400 ms polls returned true while the outgoing instance was
      // still writing its shutdown tail, and a --keep-log copy taken on that
      // signal came out 65 bytes SHORT of the finished file — losing exactly
      // the last utterances, which is where the announcement under test lives.
      //
      // What NVDA withholds is FILE_SHARE_DELETE, so both delete (EPERM) and
      // rename (EBUSY) fail until it lets go. Measured 9 August 2026.
      const releasedPath = `${state.capturePath}.released`;
      const released = await retryFileOp(() => renameSync(state.capturePath, releasedPath));
      result.captureReleased = released.ok;
      if (!released.ok) {
        result.releaseError = released.error;
        result.warning =
          "The capture log was never released by NVDA, so it could not be read or removed safely. The session record has been left in place for the next start to clear.";
        result.ok = false;
        return result;
      }

      const stats = statSync(releasedPath);
      const parsed = parseNvdaLog(readFileSync(releasedPath, "utf8"));
      result.captured = {
        bytes: stats.size,
        records: parsed.records.length,
        utterances: parsed.speech.length,
        gestures: parsed.gestures.length,
      };

      if (options.keepLog) {
        if (typeof options.keepLog === "string") {
          copyFileSync(releasedPath, options.keepLog);
          rmSync(releasedPath, { force: true });
          result.keptAt = options.keepLog;
        } else {
          // Bare --keep-log: put it back under its own name and report where.
          renameSync(releasedPath, state.capturePath);
          result.keptAt = state.capturePath;
        }
        captureHandled = true;
        result.privacyNote =
          "The kept log records everything NVDA spoke machine-wide while capture was on — not only the page under test. Read only the window you fired in, delete it when done, and never commit it.";
      } else {
        rmSync(releasedPath, { force: true });
        result.deleted = true;
        captureHandled = true;
      }
    } else {
      result.captured = null;
      captureHandled = true;
      result.note = "capture file was already absent";
    }

    result.ok = captureHandled;
    return result;
  } finally {
    // A throw above must not leave a session recorded that the next start
    // would treat as active — but neither must a failed delete leave the log
    // orphaned with nothing pointing at it. Clear only when the log is dealt
    // with; otherwise the record survives for start's self-heal to find.
    if (captureHandled) clearState();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseKeepLog(args) {
  const flag = args.find((a) => a === "--keep-log" || a.startsWith("--keep-log="));
  if (!flag) return false;
  const eq = flag.indexOf("=");
  return eq >= 0 ? flag.slice(eq + 1) : true;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith("--")) || "status";
  const asJson = args.includes("--json");

  let result;
  switch (command) {
    case "status":
      result = await commandStatus();
      break;
    case "start":
      result = await commandStart();
      break;
    case "stop":
      result = await commandStop({ keepLog: parseKeepLog(args) });
      break;
    default:
      logError(`Unknown command "${command}". Use status | start | stop.`);
      process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    logInfo(`nvda-log-control ${command}`);
    for (const [key, value] of Object.entries(result)) {
      if (value === null || value === undefined) continue;
      logInfo(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
  }

  const failed = result.ok === false || result.refusal;
  process.exit(failed ? 1 : 0);
}

/**
 * Only run the CLI when invoked directly. The fleet survey IMPORTS this module
 * for commandStart/commandStop, and an unguarded main() would restart the
 * user's screen reader as a side effect of the import.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main().catch((error) => {
    logError(`nvda-log-control failed: ${error.stack || error.message}`);
    process.exit(1);
  });
}
