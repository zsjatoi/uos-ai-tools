#!/usr/bin/env node
/**
 * PostToolUse hook: when a throwaway measurement script is WRITTEN, show the
 * harness-proof loop once per session.
 *
 * Why: a one-off measurement script that has never been seen to fail produces
 * numbers nobody should trust, and a rule held in a skill reaches only the
 * session that loads it. A hook reaches every session at the moment of the action.
 *
 * WHAT IT DOES
 * On a `Write` of .mjs / .js / .py / .ps1 under `.claude/measurements/` or the OS
 * temp directory (or literal `/tmp/`), emits hookSpecificOutput.additionalContext
 * ONCE per session. That is the channel that reaches the agent; a systemMessage is
 * shown to the user only (the hook runs and the agent sees nothing).
 * Everything else: exit 0, silent.
 *
 * It is NOT a guard. It never blocks, and it FAILS OPEN on every uncertainty
 * (missing fields, unparseable stdin, a throw): exit 0, no output. The one
 * deliberate bias runs the other way: a missing session_id speaks, because one
 * extra message is cheaper than silence.
 *
 * Proof: node .claude/hooks/prove-harness-proof-prompt.mjs --inversions
 * See the README section 'Guards'.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT_EXTENSION = /\.(mjs|js|py|ps1)$/i;
const MEASUREMENTS_SEGMENT = "/.claude/measurements/";
const LITERAL_TMP = "/tmp/";
const MARKER_DIR_NAME = "claude-harness-proof-prompt";

export const MESSAGE = [
  "You just wrote a throwaway measurement script. Prove it can FAIL before you believe a number from it (skill: harness-proof):",
  "1. Baseline: run clean, record the exact figure, and seed a canary the instrument MUST catch.",
  "2. Write the predicted red set down BEFORE the plant.",
  "3. Plant a defect in the subject and assert the patch count (zero sites and three sites both leave every row green).",
  "4. Prove it goes RED, with the exact exit code, not merely non-zero.",
  "5. Restore in a finally, then prove it goes GREEN and back to baseline.",
  "Step 0: what error is this instrument INSENSITIVE to? A zero from a dead instrument and a clean run look identical.",
  "Load `harness-proof` before you believe its first number.",
].join("\n");

const normalise = (p) => String(p).replace(/\\/g, "/").toLowerCase();

/** True when the path is a measurement script location and extension. */
export function isMeasurementScript(filePath, tmp = tmpdir()) {
  if (!filePath || !SCRIPT_EXTENSION.test(String(filePath))) return false;
  // Leading slash so a relative `.claude/measurements/...` matches the segment.
  const path = "/" + normalise(filePath).replace(/^\/+/, "");
  if (path.includes(MEASUREMENTS_SEGMENT)) return true;
  if (path.startsWith(LITERAL_TMP)) return true;
  const tmpRoot = normalise(tmp).replace(/\/+$/, "");
  return tmpRoot.length > 0 && normalise(filePath).startsWith(tmpRoot + "/");
}

/**
 * Decide on a parsed payload. Returns the message to show, or null.
 * Creates the once-per-session marker as a side effect when it speaks.
 */
export function decide(payload, { tmp = tmpdir(), markerDir } = {}) {
  if (payload?.tool_name !== "Write") return null;
  if (!isMeasurementScript(payload?.tool_input?.file_path, tmp)) return null;

  const dir = markerDir ?? join(tmp, MARKER_DIR_NAME);
  const sessionId = payload.session_id;
  // A session id is used as a file name, so refuse anything path-like.
  const usable = typeof sessionId === "string" && /^[\w.-]+$/.test(sessionId);
  if (usable) {
    const marker = join(dir, sessionId);
    if (existsSync(marker)) return null;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, "");
    } catch {
      // Could not record it: speak anyway.
    }
  }
  return MESSAGE;
}

const isEntryPoint =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      const message = decide(JSON.parse(raw));
      if (message) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },
          }),
        );
      }
    } catch {
      // fail open: no output
    }
    process.exitCode = 0;
  });
}
