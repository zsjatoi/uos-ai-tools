#!/usr/bin/env node
/**
 * Fixture for settings-parse-check.mjs.
 *
 *   node .claude/hooks/prove-settings-parse-check.mjs               rows only
 *   node .claude/hooks/prove-settings-parse-check.mjs --inversions  rows + sweep
 *
 * Every file it parses lives in a temp directory it creates and removes; no real
 * project file is touched. Inversions patch a COPY of the hook, assert the patch
 * count, and run the rows against it in a child process (SETTINGS_PARSE_HOOK).
 * The sweep refuses to run if any row is named by no inversion. Failing rows are
 * read from a child's printed output, not its exit code.
 *
 * See the README section 'Troubleshooting'.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REAL_HOOK = join(HERE, "settings-parse-check.mjs");
const HOOK_PATH = process.env.SETTINGS_PARSE_HOOK || REAL_HOOK;
const SELF = fileURLToPath(import.meta.url);
const SENTINEL = "ROWRESULT ";

const hook = await import(pathToFileURL(HOOK_PATH).href);
// A hook that armed its stdin handler on import leaves a data listener here.
const armedOnImport = process.stdin.listenerCount("data");

const scratch = mkdtempSync(join(tmpdir(), "spc-fixture-" + process.pid + "-"));
const fwd = (p) => p.replace(/\\/g, "/");
const VALID = '{"permissions":{"allow":["a"]},"hooks":{"PostToolUse":[]}}';
// A realistic shape: nested hook arrays with matchers and commands.
const REALISTIC = JSON.stringify({
  permissions: { allow: ["Bash(node:*)"], ask: [] },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/guards/no-heredoc.mjs"' }] },
    ],
  },
}, null, 2);
const TRAILING_COMMA = '{"a":1,}';
const MISSING_BRACKET = '{"hooks":{"PostToolUse":[{"a":1}}}';

function put(rel, content) {
  const file = join(scratch, ...rel.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  return fwd(file);
}
const tool = (name, file_path, extra = {}) => ({ tool_name: name, tool_input: { file_path }, ...extra });

function cli(payloadText) {
  const r = spawnSync(process.execPath, [HOOK_PATH], { input: payloadText, encoding: "utf8" });
  return { out: r.stdout, status: r.status };
}
const cliJson = (obj) => cli(JSON.stringify(obj));
const parseOut = (r) => {
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};
const spokeCli = (r) => {
  const o = parseOut(r)?.hookSpecificOutput;
  return r.status === 0 && o?.hookEventName === "PostToolUse" && typeof o.additionalContext === "string";
};
const silentCli = (r) => r.out === "" && r.status === 0;
const said = (m) => typeof m === "string";

const rows = [];
const row = (name, side, ok) => rows.push({ name, side, ok: Boolean(ok) });

try {
  const validFile = put("v/.claude/settings.json", VALID);
  const bomFile = put("bom/.claude/settings.json", "﻿" + VALID);
  const realisticFile = put("real/.claude/settings.json", REALISTIC);
  const notesFile = put("notes/settings.json", TRAILING_COMMA);
  const vscodeFile = put(".vscode/settings.json", TRAILING_COMMA);
  const xFile = put("x.json", TRAILING_COMMA);
  const trailing = put("t/.claude/settings.json", TRAILING_COMMA);
  const bracket = put("b/.claude/settings.json", MISSING_BRACKET);
  const localFile = put("l/.claude/settings.local.json", TRAILING_COMMA);
  const mcpFile = put("m/.mcp.json", TRAILING_COMMA);
  const claudeJson = put("c/.claude.json", TRAILING_COMMA);

  // DENY: silent
  row("D1 valid .claude/settings.json", "DENY", hook.decide(tool("Write", validFile)) === null);
  row("D2 valid file with leading BOM", "DENY", hook.decide(tool("Write", bomFile)) === null);
  row("D3 invalid notes/settings.json (parent not .claude)", "DENY", hook.decide(tool("Write", notesFile)) === null);
  row("D4 invalid .vscode/settings.json (JSONC lives there)", "DENY", hook.decide(tool("Write", vscodeFile)) === null);
  row("D5 invalid x.json", "DENY", hook.decide(tool("Write", xFile)) === null);
  row("D6 matching path that does not exist", "DENY",
    hook.decide(tool("Write", fwd(join(scratch, "none", ".claude", "settings.json")))) === null);
  row("D7 empty stdin", "DENY", silentCli(cli("")));
  row("D8 stdin not JSON", "DENY", silentCli(cli("not json {")));
  row("D9 valid realistic settings.json (nested hook arrays)", "DENY", hook.decide(tool("Write", realisticFile)) === null);
  row("D10 Bash tool on an invalid file", "DENY", hook.decide(tool("Bash", trailing)) === null);
  row("D11 CLI output carries no systemMessage key", "DENY", (() => {
    const o = parseOut(cliJson(tool("Write", trailing, { session_id: "d11-" + process.pid })));
    return o !== null && !("systemMessage" in o);
  })());

  // ALLOW: speaks
  row("A1 trailing comma in .claude/settings.json", "ALLOW", said(hook.decide(tool("Write", trailing))));
  row("A2 missing bracket in .claude/settings.json", "ALLOW", said(hook.decide(tool("Write", bracket))));
  row("A3 invalid settings.local.json", "ALLOW", said(hook.decide(tool("Write", localFile))));
  row("A4 invalid .mcp.json", "ALLOW", said(hook.decide(tool("Write", mcpFile))));
  row("A5 invalid .claude.json", "ALLOW", said(hook.decide(tool("Write", claudeJson))));
  row("A6 backslash Windows path to an invalid file", "ALLOW",
    said(hook.decide(tool("Write", trailing.replace(/\//g, "\\")))));
  row("A7 Edit tool on an invalid file", "ALLOW", said(hook.decide(tool("Edit", trailing))));
  row("A8 second failing write in one session still speaks", "ALLOW", (() => {
    const p = tool("Write", trailing, { session_id: "a8-" + process.pid });
    return spokeCli(cliJson(p)) && spokeCli(cliJson(p));
  })());
  row("A9 text names the file and says disabled", "ALLOW", (() => {
    const m = hook.decide(tool("Write", trailing));
    return said(m) && m.includes(trailing) && m.includes("disabled");
  })());
  row("A10 message is at most 6 lines", "ALLOW", (() => {
    const m = hook.decide(tool("Write", trailing));
    return said(m) && m.split("\n").length <= 6;
  })());
  row("A11 fixture process does not arm the hook's stdin handler", "ALLOW", armedOnImport === 0);
  row("A12 CLI speaks JSON hookSpecificOutput.additionalContext", "ALLOW",
    spokeCli(cliJson(tool("Write", trailing, { session_id: "a12-" + process.pid }))));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Child mode: print rows only.
if (process.env.SETTINGS_PARSE_HOOK) {
  console.log(SENTINEL + JSON.stringify(rows));
  process.exit(0);
}

const failing = rows.filter((r) => !r.ok);
const deny = rows.filter((r) => r.side === "DENY").length;
const allow = rows.filter((r) => r.side === "ALLOW").length;
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.side.padEnd(5)} ${r.name}`);
console.log(`${rows.length} rows, ${deny} DENY, ${allow} ALLOW, ${failing.length} failing`);
if (deny === 0 || allow === 0) {
  console.log("REFUSED: one side is empty");
  failing.push({ name: "side-empty" });
}

if (process.argv.includes("--inversions")) {
  const source = readFileSync(REAL_HOOK, "utf8");
  const count = (s, needle) => s.split(needle).length - 1;
  const id = (prefix) => rows.find((r) => r.name.startsWith(prefix + " ")).name;
  const R = (...ps) => ps.map(id);
  const ALL_SPEAK = R("A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A12", "D11");
  const INVERSIONS = [
    { id: "INV-BOM", patches: [["if (text.startsWith(BOM)) text = text.slice(1);", ""]], predicted: R("D2") },
    {
      id: "INV-PARENT",
      patches: [["return SETTINGS_NAMES.has(base) && parts[parts.length - 2] === CLAUDE_DIR;", "return SETTINGS_NAMES.has(base);"]],
      predicted: R("D3", "D4"),
    },
    {
      id: "INV-ANYJSON",
      patches: [["if (ALWAYS_NAMES.has(base)) return true;", 'if (ALWAYS_NAMES.has(base) || base.endsWith(".json")) return true;']],
      predicted: R("D3", "D4", "D5"),
    },
    {
      id: "INV-MCP",
      patches: [['const ALWAYS_NAMES = new Set([".mcp.json", ".claude.json"]);', 'const ALWAYS_NAMES = new Set([".claude.json"]);']],
      predicted: R("A4"),
    },
    {
      id: "INV-OLDSHAPE",
      patches: [['hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },', "systemMessage: message,"]],
      predicted: R("A8", "A12", "D11"),
    },
    {
      id: "INV-ENDSWITH",
      patches: [[
        "process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;",
        'process.argv[1] && process.argv[1].endsWith("settings-parse-check.mjs");',
      ]],
      predicted: R("A11"),
    },
    { id: "INV-NOPARSE", patches: [["    JSON.parse(text);", ""]], predicted: ALL_SPEAK },
    {
      id: "INV-ALWAYS-SPEAK",
      patches: [["    JSON.parse(text);", '    JSON.parse(text); throw new Error("x");']],
      predicted: R("D1", "D2", "D9"),
    },
    {
      id: "INV-MISSING-SPEAKS",
      patches: [["return null; // missing or unreadable: silent", 'text = "{";']],
      predicted: R("D6"),
    },
    {
      id: "INV-FAILOPEN-CLI",
      patches: [["// fail open: no output", 'process.stdout.write("{\\"x\\":1}");']],
      predicted: R("D7", "D8"),
    },
    {
      id: "INV-BASH",
      patches: [['new Set(["Edit", "Write", "MultiEdit"])', 'new Set(["Edit", "Write", "MultiEdit", "Bash"])']],
      predicted: R("D10"),
    },
    {
      id: "INV-NO-EDIT",
      patches: [['new Set(["Edit", "Write", "MultiEdit"])', 'new Set(["Write", "MultiEdit"])']],
      predicted: R("A7"),
    },
    {
      id: "INV-WORD",
      patches: [["Every setting in that file is disabled for", "Every setting in that file is off for"]],
      predicted: R("A9"),
    },
    {
      id: "INV-LONG",
      patches: [[
        '"Fix it now (trailing comma, missing bracket, stray comment), then re-run:",',
        '"Fix it now (trailing comma, missing bracket, stray comment), then re-run:", "x", "y", "z",',
      ]],
      predicted: R("A10"),
    },
  ];

  // Refuse if any row is bound by no inversion.
  const bound = new Set(INVERSIONS.flatMap((i) => i.predicted));
  const unbound = rows.filter((r) => !bound.has(r.name)).map((r) => r.name);
  if (unbound.length) {
    console.log("REFUSED: rows named by no inversion: " + JSON.stringify(unbound));
    failing.push({ name: "unbound rows" });
  } else {
    const dir = mkdtempSync(join(tmpdir(), "spc-inv-" + process.pid + "-"));
    try {
      for (const inv of INVERSIONS) {
        let patched = source;
        let refused = false;
        for (const [find, replace] of inv.patches) {
          if (count(patched, find) !== 1) {
            console.log(`INVERSION ${inv.id}: REFUSED, patch matched ${count(patched, find)} sites`);
            refused = true;
            break;
          }
          patched = patched.split(find).join(replace);
        }
        if (refused) {
          failing.push({ name: inv.id + " patch count" });
          continue;
        }
        // Same basename as the real hook, so an endsWith entry-point test is armed.
        const sub = join(dir, inv.id);
        mkdirSync(sub);
        const file = join(sub, "settings-parse-check.mjs");
        writeFileSync(file, patched);
        const child = spawnSync(process.execPath, [SELF], {
          env: { ...process.env, SETTINGS_PARSE_HOOK: file },
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        const line = (child.stdout || "").split("\n").find((l) => l.startsWith(SENTINEL));
        if (!line) {
          console.log(`INVERSION ${inv.id}: no result line (child status ${child.status})`);
          failing.push({ name: inv.id + " no result" });
          continue;
        }
        const red = JSON.parse(line.slice(SENTINEL.length)).filter((r) => !r.ok).map((r) => r.name).sort();
        const want = [...inv.predicted].sort();
        const match = JSON.stringify(red) === JSON.stringify(want);
        console.log(`INVERSION ${inv.id}: red=${JSON.stringify(red)} predicted=${JSON.stringify(want)} ${match ? "MATCH" : "MISMATCH"}`);
        if (!match) failing.push({ name: inv.id + " red set" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`${INVERSIONS.length} inversions`);
  }
}

process.exitCode = failing.length ? 1 : 0;
