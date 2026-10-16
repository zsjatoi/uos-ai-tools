#!/usr/bin/env node
/**
 * Fixture for harness-proof-prompt.mjs.
 *
 *   node .claude/hooks/prove-harness-proof-prompt.mjs               rows only
 *   node .claude/hooks/prove-harness-proof-prompt.mjs --inversions  rows + sweep
 *
 * Each row declares its side (DENY = silent, ALLOW = speaks or structural).
 * Inversions patch a COPY of the hook, assert the patch count, and run the rows
 * against it in a child process (HARNESS_PROOF_HOOK), so a patched entry point
 * cannot arm a stdin handler inside the sweep itself. Exit codes of a child are
 * not trusted for the verdict: failing rows are read from its printed output.
 *
 * See the README section 'Guards'.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REAL_HOOK = join(HERE, "harness-proof-prompt.mjs");
const HOOK_PATH = process.env.HARNESS_PROOF_HOOK || REAL_HOOK;
const SELF = fileURLToPath(import.meta.url);
const SENTINEL = "ROWRESULT ";

const hook = await import(pathToFileURL(HOOK_PATH).href);
// Measured straight after import: a hook that armed its stdin handler on import
// leaves a data listener on this process's stdin.
const armedOnImport = process.stdin.listenerCount("data");

const scratch = mkdtempSync(join(tmpdir(), "hp-fixture-"));
const fakeTmp = join(scratch, "Temp");
mkdirSync(fakeTmp, { recursive: true });
let counter = 0;
const fresh = () => join(scratch, "markers-" + ++counter);
const write = (file_path, extra = {}) => ({ tool_name: "Write", tool_input: { file_path }, ...extra });

function cli(payloadText) {
  const env = { ...process.env, TEMP: fakeTmp, TMP: fakeTmp, TMPDIR: fakeTmp };
  const r = spawnSync(process.execPath, [HOOK_PATH], { input: payloadText, env, encoding: "utf8" });
  return { out: r.stdout, status: r.status };
}
const cliJson = (obj) => cli(JSON.stringify(obj));
const REQUIRED_WORDS = ["baseline", "plant", "red", "restore", "green", "harness-proof"];
const speaks = (r) => {
  try {
    const o = JSON.parse(r.out).hookSpecificOutput;
    const text = String(o?.additionalContext ?? "").toLowerCase();
    return (
      r.status === 0 &&
      o?.hookEventName === "PostToolUse" &&
      typeof o.additionalContext === "string" &&
      REQUIRED_WORDS.every((w) => text.includes(w))
    );
  } catch {
    return false;
  }
};
const hasSystemMessage = (r) => {
  try {
    return "systemMessage" in JSON.parse(r.out);
  } catch {
    return true; // unparseable: cannot show the key is absent
  }
};

const rows = [];
const row = (name, side, ok) => rows.push({ name, side, ok: Boolean(ok) });

try {
  const opts = (tmp = fakeTmp) => ({ tmp, markerDir: fresh() });
  const sid = (s) => ({ session_id: s });

  // DENY: silent
  row("D1 src/config.js", "DENY", hook.decide(write("src/config.js", sid("a")), opts()) === null);
  row("D2 docs/x.md", "DENY", hook.decide(write("docs/x.md", sid("a")), opts()) === null);
  row("D3 measurements notes.md (wrong extension)", "DENY",
    hook.decide(write(".claude/measurements/x/notes.md", sid("a")), opts()) === null);
  {
    const o = opts();
    mkdirSync(o.markerDir, { recursive: true });
    writeFileSync(join(o.markerDir, "seen"), "");
    row("D4 marker already exists", "DENY",
      hook.decide(write(".claude/measurements/x/d.mjs", sid("seen")), o) === null);
  }
  row("D5 Edit tool on a matching path", "DENY",
    hook.decide({ tool_name: "Edit", tool_input: { file_path: ".claude/measurements/x/d.mjs" }, session_id: "a" }, opts()) === null);
  {
    const r = cli("");
    row("D6 empty stdin", "DENY", r.out === "" && r.status === 0);
  }
  {
    const r = cli("not json {");
    row("D7 stdin not JSON", "DENY", r.out === "" && r.status === 0);
  }
  row("D8 .md under temp", "DENY", hook.decide(write(join(fakeTmp, "notes.md"), sid("a")), opts()) === null);
  row("D9 src/tmp/x.mjs is not /tmp/", "DENY", hook.decide(write("src/tmp/x.mjs", sid("a")), opts()) === null);

  // ALLOW: speaks
  const spoke = (p, o = opts()) => typeof hook.decide(p, o) === "string";
  row("A1 measurements drive.mjs", "ALLOW", spoke(write(".claude/measurements/p9/drive.mjs", sid("b"))));
  const winTmp = "C:\\work\\AppData\\Local\\Temp";
  row("A2 Windows temp probe-1.py", "ALLOW", spoke(write(winTmp + "\\probe-1.py", sid("b")), opts(winTmp)));
  row("A3 /tmp/x.mjs", "ALLOW", spoke(write("/tmp/x.mjs", sid("b"))));
  row("A4 backslash relative path", "ALLOW", spoke(write(".claude\\measurements\\p9\\drive.mjs", sid("b"))));
  {
    const m = (hook.decide(write(".claude/measurements/p9/a.mjs", sid("c")), opts()) ?? "").toLowerCase();
    const words = ["baseline", "plant", "red", "restore", "green", "harness-proof"];
    row("A5 message carries the five steps and the skill name", "ALLOW", words.every((w) => m.includes(w)));
    row("A11 message is at most 12 lines", "ALLOW", m.length > 0 && m.split("\n").length <= 12);
  }
  {
    const o = opts();
    const first = hook.decide(write(".claude/measurements/p9/a.mjs", sid("s1")), o);
    const second = hook.decide(write(".claude/measurements/p9/b.mjs", sid("s1")), o);
    const other = hook.decide(write(".claude/measurements/p9/c.mjs", sid("s2")), o);
    row("A6 once per session, new session speaks", "ALLOW",
      typeof first === "string" && second === null && typeof other === "string");
  }
  {
    const o = opts();
    const a = hook.decide(write(".claude/measurements/p9/a.mjs"), o);
    const b = hook.decide(write(".claude/measurements/p9/a.mjs"), o);
    row("A7 missing session_id speaks", "ALLOW", typeof a === "string" && typeof b === "string");
  }
  row("A8 fixture process does not arm the hook's stdin handler", "ALLOW", armedOnImport === 0);
  row("A9 CLI speaks JSON hookSpecificOutput.additionalContext", "ALLOW",
    speaks(cliJson(write(".claude/measurements/p9/drive.mjs", sid("cli-" + process.pid)))));
  row("D10 CLI output carries no systemMessage key", "DENY",
    !hasSystemMessage(cliJson(write(".claude/measurements/p9/drive.mjs", sid("clid-" + process.pid)))));
  row("A10 CLI speaks for a path under temp", "ALLOW",
    speaks(cliJson(write(join(fakeTmp, "probe.py"), sid("clit-" + process.pid)))));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Child mode: print rows, no verdict from the exit code.
if (process.env.HARNESS_PROOF_HOOK) {
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
  const INVERSIONS = [
    {
      id: "INV-EXT",
      patches: [["if (!filePath || !SCRIPT_EXTENSION.test(String(filePath))) return false;", "if (!filePath) return false;"]],
      predicted: ["D3 measurements notes.md (wrong extension)", "D8 .md under temp"],
    },
    {
      id: "INV-MARKER",
      patches: [["if (existsSync(marker)) return null;", ""]],
      predicted: ["D4 marker already exists", "A6 once per session, new session speaks"],
    },
    {
      id: "INV-ENDSWITH-ENTRY",
      patches: [[
        'process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;',
        'process.argv[1] && process.argv[1].endsWith("harness-proof-prompt.mjs");',
      ]],
      predicted: ["A8 fixture process does not arm the hook's stdin handler"],
    },
    {
      id: "INV-PATH-NARROW",
      patches: [
        ["if (path.startsWith(LITERAL_TMP)) return true;", ""],
        ['return tmpRoot.length > 0 && normalise(filePath).startsWith(tmpRoot + "/");', "return false;"],
      ],
      predicted: ["A2 Windows temp probe-1.py", "A3 /tmp/x.mjs", "A10 CLI speaks for a path under temp"],
    },
    {
      id: "INV-OLDSHAPE",
      patches: [[
        'hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },',
        "systemMessage: message,",
      ]],
      predicted: [
        "A9 CLI speaks JSON hookSpecificOutput.additionalContext",
        "A10 CLI speaks for a path under temp",
        "D10 CLI output carries no systemMessage key",
      ],
    },
  ];

  const dir = mkdtempSync(join(tmpdir(), "hp-inv-"));
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
      const file = join(sub, "harness-proof-prompt.mjs");
      writeFileSync(file, patched);
      const child = spawnSync(process.execPath, [SELF], {
        env: { ...process.env, HARNESS_PROOF_HOOK: file },
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
}

process.exitCode = failing.length ? 1 : 0;
