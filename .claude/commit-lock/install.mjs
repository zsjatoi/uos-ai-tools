// install.mjs - copy the commit-lock git hooks into THIS clone's .git/hooks.
//
// Hooks under .git/hooks are local to each clone and NOT version-controlled, so
// every fresh clone / new machine must run this once:
//
//     node .claude/commit-lock/install.mjs
//
// It copies .claude/commit-lock/hooks/{pre-commit,post-commit} into .git/hooks,
// backing up any pre-existing FOREIGN hook (one not ours) rather than clobbering
// it. It does NOT change any git config (e.g. core.hooksPath); it only writes
// files into the default hooks folder. Re-running it is safe (idempotent).
//
// See the README section 'Safety'. Uses ONLY Node built-ins.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

function log(message) {
  console.log(`[commit-lock install] ${message}`);
}

// Find the repo root and the real .git hooks dir (handles worktrees too).
function getGitDir() {
  // --git-path hooks gives the correct hooks dir even for linked worktrees.
  return execSync("git rev-parse --git-path hooks", { encoding: "utf8" }).trim();
}
function getRepoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

const REPO_ROOT = getRepoRoot();
const HOOKS_DIR = join(REPO_ROOT, getGitDir());
const SRC_DIR = join(REPO_ROOT, ".claude", "commit-lock", "hooks");
const HOOKS = ["pre-commit", "post-commit"];
const MARKER = "commit-lock"; // text present in our hooks, used to detect "ours"

// Warn (do not change) if core.hooksPath is set - our files would be ignored.
try {
  const custom = execSync("git config --get core.hooksPath", { encoding: "utf8" }).trim();
  if (custom) {
    log(`WARNING: git core.hooksPath is set to "${custom}". git will look there,`);
    log(`         NOT in ${HOOKS_DIR}. The guard will not run until that is`);
    log(`         reconciled. (Not changing git config - that is out of scope.)`);
  }
} catch {
  // core.hooksPath not set - the normal case. Carry on.
}

mkdirSync(HOOKS_DIR, { recursive: true });

for (const name of HOOKS) {
  const src = join(SRC_DIR, name);
  const dest = join(HOOKS_DIR, name);

  if (!existsSync(src)) {
    log(`SKIP ${name}: template missing at ${src}`);
    continue;
  }

  if (existsSync(dest)) {
    let existing = "";
    try { existing = readFileSync(dest, "utf8"); } catch {}
    if (existing.includes(MARKER)) {
      // Already ours - just refresh it.
      log(`updating existing ${name} (was already a commit-lock hook)`);
    } else {
      // Foreign hook - back it up so we never silently destroy someone's work.
      const backup = `${dest}.before-commit-lock`;
      renameSync(dest, backup);
      log(`backed up existing foreign ${name} -> ${backup}`);
    }
  }

  // Copy with line endings forced to LF. git on Windows may have rewritten the
  // template to CRLF, and a CRLF shebang (#!/bin/sh\r) breaks the hook with
  // "bad interpreter". Normalising here makes the install robust even if
  // .gitattributes was not honoured on this clone.
  const body = readFileSync(src, "utf8").replace(/\r\n/g, "\n");
  writeFileSync(dest, body);
  // Best-effort executable bit (a no-op on Windows; harmless).
  try { chmodSync(dest, 0o755); } catch {}
  log(`installed ${name} -> ${dest}`);
}

log("done. Commits on this machine are now serialised by the commit lock.");
