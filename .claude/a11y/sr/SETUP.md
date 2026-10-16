# Installing the screen-reader tools

**Snapshot taken on 8 October 2026.** Versions may have changed since.

These tools let Claude Code read a page the way a screen reader would. They include:

- a **simulated screen reader**, which runs anywhere
- a **Label in Name check**, which compares what a control says with what it shows
- a **form behaviour test**
- an optional **real NVDA** test, which works on Windows only

None of these run on their own. You start them when you want them. If you do not
install these tools, the rest of the kit still works.

## Where the tools go

The tools go in a folder **outside** your project. That keeps them out of your
website, and stops them causing trouble in folders that sync to the cloud.

The folder is:

1. whatever you set in the `A11Y_SR_HOME` environment variable, if you set one
2. otherwise, on Windows: `%LOCALAPPDATA%\claude-a11y-sr`
3. on macOS: `~/Library/Application Support/claude-a11y-sr`
4. on Linux: `~/.local/share/claude-a11y-sr`

The scripts work out this folder each time they run, so no name or path is written
into them.

## The one rule that matters: run npm from inside that folder

> Always run `npm` from inside the tools folder. Never run
> `npm install --prefix <folder>` from your project.

If you use `--prefix` from your project, npm can create a link from the tools folder
back into your project. That ties the tools to your website, and it is dangerous to
remove. If you deleted that link the normal way, your computer could follow it and
delete your project too. If you ever find such a link, remove only the link: use
`cmd /c rmdir "<path>"` on Windows, or `rm <path>` without `-r` on macOS and Linux.

## What gets installed

| Package | Version | What it does |
| --- | --- | --- |
| `@guidepup/virtual-screen-reader` | 0.32.1 | the simulated screen reader |
| `@playwright/test` | 1.60.0 | controls the browser |
| `playwright` | 1.60.0 | the matching version for the browser the scripts expect |

For real NVDA only (Windows):

| Package | Version | What it does |
| --- | --- | --- |
| `@guidepup/guidepup` | 0.27.0 | controls NVDA |
| `@guidepup/playwright` | 0.17.0 | connects NVDA and the browser |
| `@guidepup/setup` | 0.22.0 | downloads a separate copy of NVDA and an add-on it needs |

One person maintains most of the Guidepup packages. Bear that in mind if you plan to
rely on them for a long time.

## Installing on Windows (PowerShell)

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

## Installing on macOS or Linux (not tested)

```bash
dir="${A11Y_SR_HOME:-$HOME/.local/share/claude-a11y-sr}"   # on macOS the default is ~/Library/Application Support/claude-a11y-sr
mkdir -p "$dir" && cd "$dir"
npm init -y
npm install --save-exact @playwright/test@1.60.0 playwright@1.60.0 @guidepup/virtual-screen-reader@0.32.1
npx playwright@1.60.0 install chromium
```

The last command downloads the version of Chromium that matches `playwright@1.60.0`.
The scripts print which browser they use every time they run. Check that the
`chromiumRevision` in `sr-config.json` matches the one your install reports.

To try it, start your preview server, then run `node .claude/a11y/sr/sr-prove.mjs`
from your project. The address it uses is `previewBase` in `sr-config.json`.

## Optional: real NVDA (Windows only)

Real NVDA **takes over your screen reader and brings windows to the front**. Run it
only when you are not using the computer for anything else. Never run it in the
background or on a shared machine.

It uses its own copy of NVDA, version 2021.3.1, not the NVDA you may already have.
So the words it records are 2021 wording. Your computer must also allow three things:
the NVDA download, a setting written to `HKCU\Software\Guidepup\Nvda` in the Windows
registry, and NVDA's Remote Access add-on. If your organisation blocks any of these,
use the simulated screen reader instead.

1. Install the three packages, from inside the tools folder:

   ```powershell
   Push-Location $dir
   try {
     npm install --save-exact `
       @guidepup/guidepup@0.27.0 @guidepup/playwright@0.17.0 @guidepup/setup@0.22.0
   } finally { Pop-Location }
   ```

2. Install the separate copy of NVDA into the tools folder, not your temporary folder,
   so a clean-up cannot delete it. Run this from inside the tools folder:

   ```powershell
   Push-Location $dir
   try {
     node node_modules\@guidepup\setup\bin\setup --nvda-install-dir "$dir\nvda"
   } finally { Pop-Location }
   ```

3. Check it worked. The registry setting should exist, and `nvda.exe` should be there:

   ```powershell
   reg query "HKCU\Software\Guidepup\Nvda"
   Test-Path "$dir\nvda\nvda-0.1.3-2021.3.1\nvda\nvda.exe"   # expect True
   ```

### Settings to check after every install

The setup step writes a fresh `nvda.ini` file each time, which removes any change you
made. Open `$dir\nvda\nvda-0.1.3-2021.3.1\nvda\userConfig\nvda.ini` and check these
three settings:

- **Mouse tracking off.** Add a `[mouse]` section with `enableMouseTracking = False`.
  You must add this yourself every time. Without it, NVDA reads out whatever the mouse
  is over, which spoils the recording.
- **Silent speech.** Under `[speech]` then `[[oneCore]]`, check `volume = 0` is there.
  It should be there already, so the tests run silently.
- **No automatic reading.** Under `[virtualBuffers]`, check
  `autoSayAllOnPageLoad = False` is there. It should be there already, so NVDA does not
  read the whole page when it loads.

### What the NVDA test's exit codes mean

| Exit code | Meaning |
| --- | --- |
| 0 | Passed. |
| 1 | NVDA ran, but a check failed. The exact words NVDA said are printed. |
| 2 | Windows blocked the helper that brings the window to the front, for example because of a PowerShell policy. |
| 3 | The window could not stay at the front, for example because you were using the computer. |
| 4 | Your computer does not allow this test. Use the simulated screen reader instead. |

Codes 2 and 3 are about your computer, never about the page you are testing.

### Recording what your own NVDA says

`nvda-log-control.mjs start|stop|status` restarts the NVDA you already have, with a
private log that records everything it says. `nvda-speech-log.mjs` reads that log.
This also takes over your screen reader: it restarts NVDA and closes Speech Viewer.
Run it only when the computer is free.

**Privacy:** while recording is on, the log captures **everything** NVDA says on the
computer, including emails and chat messages. `stop` deletes the log unless you ask
it not to. Never commit a log to git, and never share one without removing everything
except your test words.

You can test the log reader without NVDA by running
`node .claude/a11y/sr/nvda-speech-prove.mjs`.
