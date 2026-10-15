#!/usr/bin/env node
/**
 * PostToolUse hook: when an agent Edit or Write leaves a Claude config file as
 * invalid JSON, tell the agent at once.
 *
 * Why: a malformed settings.json disables EVERY setting in it, silently - a
 * trailing comma plus a dropped `]` removes all hooks and permission entries with
 * no error at the point of use. Nothing parsed the file after an agent wrote it.
 *
 * WHAT IT DOES
 * On Edit / Write / MultiEdit whose tool_input.file_path is
 *   - settings.json or settings.local.json inside a directory named `.claude`
 *     (any root, so ~/.claude/settings.json is covered), or
 *   - .mcp.json, or .claude.json,
 * it reads the file from disk (an Edit carries no whole content), strips one
 * leading U+FEFF and JSON.parses it. Valid: silent. Invalid: prints
 * hookSpecificOutput.additionalContext (the channel that reaches the agent; a
 * systemMessage reaches only the user). Speaks EVERY time a matching file fails,
 * not once per session.
 *
 * It is NOT a guard: never blocks, FAILS OPEN on every uncertainty (bad stdin,
 * missing fields, unreadable or missing file, a throw): exit 0, no output.
 *
 * NOT IN SCOPE: a write by Bash or PowerShell (sed, Set-Content), a hand edit
 * in an editor, schema validity, duplicate hook registrations. Parse only - so
 * parse the file yourself after pasting config by hand.
 *
 * Proof: node .claude/hooks/prove-settings-parse-check.mjs --inversions
 * See the README section 'Troubleshooting'.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SETTINGS_NAMES = new Set(["settings.json", "settings.local.json"]);
const CLAUDE_DIR = ".claude";
const ALWAYS_NAMES = new Set([".mcp.json", ".claude.json"]);
const BOM = "﻿";
const PARSE_COMMAND =
  "node -e \"JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^\\uFEFF/,''))\" <file>";

const normalise = (p) => String(p).replace(/\\/g, "/").toLowerCase();

/** True when the path names a config file this hook parses. */
export function isConfigFile(filePath) {
  if (!filePath) return false;
  const parts = normalise(filePath).split("/");
  const base = parts[parts.length - 1];
  if (ALWAYS_NAMES.has(base)) return true;
  return SETTINGS_NAMES.has(base) && parts[parts.length - 2] === CLAUDE_DIR;
}

/** Returns the message to show for a parsed payload, or null. */
export function decide(payload) {
  if (!TOOLS.has(payload?.tool_name)) return null;
  const filePath = payload?.tool_input?.file_path;
  if (!isConfigFile(filePath)) return null;

  let text;
  try {
    text = readFileSync(String(filePath), "utf8");
  } catch {
    return null; // missing or unreadable: silent
  }
  if (text.startsWith(BOM)) text = text.slice(1);

  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return [
      `${filePath} no longer parses as JSON: ${err?.message ?? err}`,
      "Every setting in that file is disabled for any conversation started before it is fixed.",
      "Fix it now (trailing comma, missing bracket, stray comment), then re-run:",
      PARSE_COMMAND,
    ].join("\n");
  }
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
