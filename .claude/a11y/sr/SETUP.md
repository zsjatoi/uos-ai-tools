# Screen-reader testing layer: setup and install

This is the **on-demand** screen-reader test layer that sits beside the static-audit
layer (`.claude/a11y/audit.mjs`). It drives a real browser and reads the page through
a screen-reader simulation (the virtual reader) and, optionally on Windows, real NVDA.
It is never wired into an edit-time hook and is never assumed available: a machine
without this install simply cannot run it.

## Where the toolchain lives (outside your project)

All npm packages install **outside** your project tree, so the dev toolchain is never
a dependency of the site you are testing and cannot trigger file-locking or sync
problems in a synced folder. The install home is:

1. `A11Y_SR_HOME`, if you set it to an absolute path; otherwise
2. Windows: `%LOCALAPPDATA%\claude-a11y-sr`
3. macOS: `~/Library/Application Support/claude-a11y-sr`
4. Linux: `~/.local/share/claude-a11y-sr`

The scripts resolve this at runtime, so no username or path is hard-coded.

## Hard rule: run npm from INSIDE the install folder

> Always run `npm` from inside the install home. Never use
> `npm install --prefix <dir>` while your current directory is the project root.

**Why:** `npm install --prefix <dir>` run from the project root can fold the project
in as a local `file:` dependency and create a directory junction or symlink from the
external `node_modules` back into your project. That couples the dev toolchain to the
site, plants a link into your (possibly synced) project tree, and is dangerous to
remove: a recursive delete that follows the link would delete the project. If you ever
find such a link, remove the link only (`cmd /c rmdir "<path>"` on Windows, `rm <path>`
without `-r` elsewhere), never a recursive delete.

## Install

Pinned versions, as authored in the install home's `package.json`:

| Package | Version | Role |
| --- | --- | --- |
| `@guidepup/virtual-screen-reader` | 0.32.1 | screen-reader simulation (ships a self-contained browser ESM build) |
| `@playwright/test` | 1.60.0 | drives the browser |
| `playwright` | 1.60.0 | matched pair for the Chromium revision the scripts expect |

Windows-only, optional (real NVDA):

| Package | Version | Role |
| --- | --- | --- |
| `@guidepup/guidepup` | 0.27.0 | drives the real NVDA engine over the Remote Access addon |
| `@guidepup/playwright` | 0.17.0 | Playwright + NVDA integration |
| `@guidepup/setup` | 0.22.0 | downloads and registers the portable NVDA + Remote Access addon |

The Guidepup packages are maintained chiefly by one author. Weigh that before
depending on them long term.

### Windows (PowerShell)

```powershell
$dir = if ($env:A11Y_SR_HOME) { $env:A11Y_SR_HOME } else { "$env:LOCALAPPDATA\claude-a11y-sr" }
New-Item -ItemType Directory -Force $dir | Out-Null
Push-Location $dir
try {
  npm init -y
  npm install --save-exact @playwright/test@1.60.0 playwright@1.60.0 @guidepup/virtual-screen-reader@0.32.1
  npx playwright@1.60.0 install chromium
} finally { Pop-Location }
```

### macOS / Linux (bash)

```bash
dir="${A11Y_SR_HOME:-$HOME/.local/share/claude-a11y-sr}"   # macOS default: ~/Library/Application Support/claude-a11y-sr
mkdir -p "$dir" && cd "$dir"
npm init -y
npm install --save-exact @playwright/test@1.60.0 playwright@1.60.0 @guidepup/virtual-screen-reader@0.32.1
npx playwright@1.60.0 install chromium
```

`playwright@1.60.0` installs the Chromium revision it is paired with, and the scripts
launch that browser by explicit `executablePath`, which they log on every run. Check
`chromiumRevision` in `sr-config.json` agrees with the revision your install reports.

Then start your preview server (the address is `previewBase` in `sr-config.json`) and
try the virtual reader: `node .claude/a11y/sr/sr-prove.mjs`.

## Optional: real NVDA (Windows only)

Real NVDA is Windows-only and **takes over the screen reader and the OS foreground**,
so run it only on a quiet desktop, never headless, in CI or in the background. It is
on-demand only. It drives Guidepup's own pinned portable NVDA build (NVDA 2021.3.1),
not whichever NVDA you have installed, so its wording is 2021-era. It also needs a
machine whose policy and antivirus allow Guidepup's portable-NVDA download, its
`HKCU\Software\Guidepup\Nvda` registry write and the Remote Access addon. Where that is
not permitted, fall back to the virtual reader.

1. Install the three packages, from INSIDE the install home:

   ```powershell
   Push-Location $dir
   try {
     npm install --save-exact `
       @guidepup/guidepup@0.27.0 @guidepup/playwright@0.17.0 @guidepup/setup@0.22.0
   } finally { Pop-Location }
   ```

2. Install the portable NVDA to a stable path off `%TEMP%` (so temp cleanup cannot
   remove it), running the setup bin from inside the install home:

   ```powershell
   Push-Location $dir
   try {
     node node_modules\@guidepup\setup\bin\setup --nvda-install-dir "$dir\nvda"
   } finally { Pop-Location }
   ```

3. Confirm the permit check passed: the registry key resolves under the stable path
   and `nvda.exe` exists.

   ```powershell
   reg query "HKCU\Software\Guidepup\Nvda"
   Test-Path "$dir\nvda\nvda-0.1.3-2021.3.1\nvda\nvda.exe"   # expect True
   ```

### NVDA build hardening (re-apply after every (re-)provision)

`@guidepup/setup` writes a fresh `nvda.ini`, so any key you added is reset on every
(re-)provision. Edit `$dir\nvda\nvda-0.1.3-2021.3.1\nvda\userConfig\nvda.ini`:

- `[mouse]` then `enableMouseTracking = False`: add this yourself each time. The
  section does not exist in a fresh install. Without it NVDA voices whatever the mouse
  hovers over and pollutes the capture.
- `[speech]` then `[[oneCore]]` then `volume = 0`: a build default; verify it is
  present (the build runs silent for automation).
- `[virtualBuffers]` then `autoSayAllOnPageLoad = False`: a build default; verify it
  is present so NVDA does not auto-read the whole page on load.

### Exit-code contract (`nvda-prove.mjs`)

`0` pass. `1` foreground held but an assertion failed (the exact spoken string is
printed). `2` Win32 foreground helper blocked, for example by a PowerShell/Add-Type
policy. `3` foreground not acquired or lost, for example on a busy desktop. `4` not
permitted here, so fall back to the virtual reader. Codes `2` and `3` are environment
conditions, never page failures.

### Speech-log capture (installed NVDA)

`nvda-log-control.mjs start|stop|status` restarts your installed NVDA with an isolated
log at Input/output level, and `nvda-speech-log.mjs` parses it. This also takes over
the screen reader (it restarts NVDA and closes Speech Viewer), so run it only on a
quiet desktop. While capture is on, everything spoken on the machine is recorded to
that file: `stop` deletes it by default, and you should never commit a kept log. The
parser itself is pure Node and is proved offline with
`node .claude/a11y/sr/nvda-speech-prove.mjs`.
