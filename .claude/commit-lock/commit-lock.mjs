// commit-lock.mjs - same-machine commit serialiser.
//
// PURPOSE
//   Several Claude Code instances can run against one repository on the SAME
//   machine and git-commit at overlapping moments, tangling commits. This script
//   makes only one commit run at a time on this machine.
//
//   It is wired in via two git hooks (installed by install.mjs):
//     - pre-commit  runs:  node .claude/commit-lock/commit-lock.mjs acquire
//     - post-commit runs:  node .claude/commit-lock/commit-lock.mjs release
//
//   git runs pre-commit BEFORE making the commit, and post-commit AFTER. So we
//   grab the lock before, and let go after. If "acquire" exits non-zero, git
//   aborts the commit - that is how we make a commit wait or refuse.
//
// THE LOCK
//   The lock is a DIRECTORY, not a file. Creating a directory is ATOMIC: the OS
//   either creates it (we win the lock) or fails because it already exists
//   (someone else holds it) - there is no gap where two instances could both
//   think they won. A "check if it exists, then create" file approach would have
//   that gap; a directory does not.
//
//   It lives OUTSIDE the project tree, on local disk:
//     %LOCALAPPDATA%\claude-commit-lock\<repo-key>.lock   (Windows)
//     <os temp dir>/claude-commit-lock/<repo-key>.lock    (elsewhere)
//   keyed to THIS repo, so a commit in a different repo is never blocked, and kept
//   out of any synced folder so it is never shared between machines.
//
// SAFETY NET
//   If a release is ever missed (a crashed process, a closed terminal between the
//   commit and post-commit), the lock would otherwise sit there forever. To
//   prevent a permanent deadlock, "acquire" treats any lock OLDER than
//   STALE_TIMEOUT as abandoned and breaks it. The worst case self-heals after
//   STALE_TIMEOUT instead of jamming every instance.
//
// SCOPE
//   Same-machine only. Two different MACHINES committing at once is NOT handled
//   here - that needs a git remote.
//
// See the README section 'Safety'. Uses ONLY Node built-ins.

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// TUNABLE CONSTANTS - edit these if the timings need changing.
// ---------------------------------------------------------------------------

// How long a waiting commit will keep trying before it gives up (milliseconds).
const WAIT_TIMEOUT = 60 * 1000; // 60 seconds

// How old a lock must be before we assume the holder died and break it.
// MUST be larger than WAIT_TIMEOUT, so a normal in-progress commit (which
// clears well within WAIT_TIMEOUT) is never mistaken for "stale".
const STALE_TIMEOUT = 300 * 1000; // 300 seconds (5 minutes)

// How often we re-check a held lock while waiting (milliseconds).
const POLL_INTERVAL = 2 * 1000; // 2 seconds

// ---------------------------------------------------------------------------
// PATHS - all resolved at runtime; nothing hard-coded to a user or machine.
// ---------------------------------------------------------------------------

// Base folder for all repos' locks, on local disk.
const LOCK_BASE = join(process.env.LOCALAPPDATA || process.env.TEMP || tmpdir(), "claude-commit-lock");

// Find this repo's top-level folder so the lock key is stable no matter which
// sub-folder git ran the hook from. Fall back to the current directory.
function getRepoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// Turn the repo path into a short, unique, filesystem-safe key. We combine a
// readable name (the folder's basename) with a short hash of the full path, so
// two repos that happen to share a basename still get distinct locks.
function getRepoKey(repoRoot) {
  const normalised = repoRoot.replace(/\\/g, "/").toLowerCase();
  const shortHash = createHash("sha1").update(normalised).digest("hex").slice(0, 8);
  const baseName = (normalised.split("/").pop() || "repo").replace(/[^a-z0-9._-]/g, "_");
  return `${baseName}-${shortHash}`;
}

const REPO_ROOT = getRepoRoot();
const REPO_KEY = getRepoKey(REPO_ROOT);
const LOCK_DIR = join(LOCK_BASE, `${REPO_KEY}.lock`); // the atomic lock itself
const META_FILE = join(LOCK_DIR, "holder.json"); // who holds it + when
const TOKEN_FILE = join(LOCK_BASE, `${REPO_KEY}.token`); // see "safe release" below

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

function log(message) {
  // One clear line to stderr so it shows up in the commit output.
  console.error(`[commit-lock] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Identify who we are, for the metadata. The optional CLAUDE_INSTANCE label is
// just a friendly tag if the environment provides one.
function describeHolder() {
  return {
    host: hostname(),
    pid: process.pid,
    label: process.env.CLAUDE_INSTANCE || process.env.CLAUDE_CODE_INSTANCE || "",
  };
}

// Read the current lock's metadata, or null if it cannot be read.
function readMeta() {
  try {
    return JSON.parse(readFileSync(META_FILE, "utf8"));
  } catch {
    return null;
  }
}

// How old (ms) is a lock, given its metadata? Returns Infinity if unknown, so
// an unreadable/corrupt lock is treated as stale and gets cleaned up.
function lockAgeMs(meta) {
  if (!meta || !meta.acquiredAt) return Infinity;
  const then = Date.parse(meta.acquiredAt);
  if (Number.isNaN(then)) return Infinity;
  return Date.now() - then;
}

function describeMeta(meta) {
  if (!meta) return "unknown holder";
  const who = meta.label ? `${meta.label} ` : "";
  return `${who}${meta.host || "?"}/pid ${meta.pid ?? "?"} since ${meta.acquiredAt || "?"}`;
}

// Remove the lock directory (used by stale-break and by release).
function removeLockDir() {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // If removal fails, the stale-break path will retry on the next attempt.
  }
}

// ---------------------------------------------------------------------------
// ACQUIRE - called by pre-commit. Exit 0 = got the lock, commit proceeds.
//           Exit 1 = could not get it, git aborts the commit.
// ---------------------------------------------------------------------------

async function acquire() {
  // Make sure the base folder exists (first run on a fresh machine).
  mkdirSync(LOCK_BASE, { recursive: true });

  const startedWaiting = Date.now();

  // Keep trying until we win the lock or run out of patience.
  // (No infinite loop: every branch either returns or eventually times out.)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Try to CREATE the lock directory. This is the atomic step.
    try {
      mkdirSync(LOCK_DIR); // NOT recursive - must fail if it already exists.
    } catch (err) {
      if (err.code !== "EEXIST") {
        // An unexpected filesystem error: fail safe, do not force a commit.
        log(`could not create lock (${err.code || err.message}); aborting commit to be safe`);
        process.exit(1);
      }

      // The lock already exists - someone holds it. Inspect it.
      const meta = readMeta();
      const age = lockAgeMs(meta);

      // STALE? Break it and loop round to try creating again.
      if (age > STALE_TIMEOUT) {
        const ageSec = Number.isFinite(age) ? Math.round(age / 1000) : "unknown";
        log(`breaking STALE lock held by ${describeMeta(meta)} (age ${ageSec}s > ${STALE_TIMEOUT / 1000}s)`);
        removeLockDir();
        continue; // retry the atomic create immediately
      }

      // LIVE lock. Have we waited longer than we are willing to?
      if (Date.now() - startedWaiting >= WAIT_TIMEOUT) {
        log(`lock still held by ${describeMeta(meta)} after waiting ${WAIT_TIMEOUT / 1000}s - aborting; please retry shortly`);
        process.exit(1);
      }

      // Otherwise wait a moment and try again.
      log(`commit lock held by ${describeMeta(meta)} - waiting...`);
      await sleep(POLL_INTERVAL);
      continue;
    }

    // If we reach here, mkdirSync succeeded - WE HOLD THE LOCK.
    // Record who we are and when, plus a one-time token used for safe release.
    const token = createHash("sha1")
      .update(`${process.pid}:${Date.now()}:${Math.round(performance.now())}`)
      .digest("hex");
    const meta = { ...describeHolder(), acquiredAt: new Date().toISOString(), token };
    try {
      writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
      // Stash the token OUTSIDE the lock too, so post-commit (a separate
      // process) can prove it is releasing the same lock it acquired and not a
      // newer one a stale-break handed to another instance. See release().
      writeFileSync(TOKEN_FILE, token);
    } catch (err) {
      // If we cannot record ownership, drop the lock and fail safe.
      removeLockDir();
      log(`acquired lock but could not record metadata (${err.message}); aborting`);
      process.exit(1);
    }

    log(`acquired (held by ${describeMeta(meta)})`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// RELEASE - called by post-commit. Always exits 0: a release problem must
//           never look like a commit failure (the commit already happened).
//
//   Safe-release check: we only remove the lock if its token matches the token
//   we stashed at acquire time. If they differ, our lock was broken as stale
//   and re-acquired by another instance mid-commit (only possible on a commit
//   longer than STALE_TIMEOUT) - in that case we must NOT remove the other
//   instance's lock. The stale-break is the backstop for any lock we leave.
// ---------------------------------------------------------------------------

function release() {
  const meta = readMeta();
  let myToken = null;
  try {
    myToken = readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    myToken = null;
  }

  if (!existsSync(LOCK_DIR)) {
    // Nothing to release (already broken/cleaned). Tidy our token and leave.
    try { rmSync(TOKEN_FILE, { force: true }); } catch {}
    process.exit(0);
  }

  if (meta && myToken && meta.token && meta.token !== myToken) {
    log(`not releasing: current lock (${describeMeta(meta)}) is not the one we acquired; leaving it for its owner`);
    try { rmSync(TOKEN_FILE, { force: true }); } catch {}
    process.exit(0);
  }

  removeLockDir();
  try { rmSync(TOKEN_FILE, { force: true }); } catch {}
  log("released");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------

const command = process.argv[2];
if (command === "acquire") {
  acquire().catch((err) => {
    // Unexpected error in acquire: fail safe by aborting the commit.
    log(`unexpected error during acquire (${err.message}); aborting commit`);
    process.exit(1);
  });
} else if (command === "release") {
  release();
} else {
  log(`usage: node commit-lock.mjs <acquire|release>`);
  log(`  repo key : ${REPO_KEY}`);
  log(`  lock dir : ${LOCK_DIR}`);
  log(`  if a commit is stuck: delete that lock dir, or commit with --no-verify (see the README section 'Safety')`);
  process.exit(2);
}
