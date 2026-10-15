# Accessibility starter kit: install report

Installed on 15 October 2026 by Claude Code, following the kit's `INSTALL-AGENT.md`,
in a Claude Code cloud session (Ubuntu 24.04 Linux, running as root). The kit was
tested on Windows only, so everything below is on an untested platform.

A clean automated run is not WCAG 2.2 AA conformance.

## Answers used

| Question | Answer |
| --- | --- |
| Project root | The repository root |
| Preview URL | `http://localhost:8080` (served with `npx http-server -p 8080 -c-1`) |
| Key pages | `UoS_AI_Prompt_Library_130.html`, `UoS_AI_Tool_Evaluation_Framework.html` |
| Screen reader layer | Yes |
| Real NVDA | No (Windows only) |

## Step by step

| Step | What was run | Result |
| --- | --- | --- |
| 0 | Risk notice and questions | Agreed |
| 1 | `node --version`, `git --version`, `npx --version` | Pass: Node 22.22.0, git 2.43.0, npx 10.9.4 |
| 2 | No clobber copy of `.claude/`, `a11y-fixtures/`, `tools/`, `docs/`, `.achecker.yml`; `.gitignore` lines | Pass: no collisions, key files present |
| 3 | `.claude/settings.json` from the example; parse check | Pass: parses, all 6 hook commands use `$CLAUDE_PROJECT_DIR` |
| 3b | `AGENTS.md` and `CLAUDE.md` from the templates | Pass: `@AGENTS.md` present; "About this project" drafted, please review |
| 4 | `keyPages` set; both config files parsed | Pass |
| 5 | Eight proof scripts | 7 pass, 1 fails (error 1) |
| 6 | Audit both fixtures | pa11y as expected; IBM cannot run (errors 2, 3, 4) |
| 7 | `.mcp.json`, Chrome and Firefox DevTools servers | Pass with caveats (errors 5, 6) |
| 8 | Screen reader stack and its two proofs | Packages installed; both proofs fail (error 7) |
| 9 | Real NVDA | Skipped (Windows only). Offline speech log proof: 116 passed |
| 10 | Live guard and edit hook checks | Guard pass; edit hook works only with a workaround (error 8) |

### Step 5 proof scripts

| Script | Exit | Result |
| --- | --- | --- |
| `prove-no-recursive-walk.mjs --inversions` | 0 | 25 inversions, all bound |
| `prove-big-doc-read.mjs --inversions` | 0 | 14 inversions, all bound |
| `prove-no-heredoc.mjs --inversions` | 0 | 16 inversions, all bound |
| `prove-harness-proof-prompt.mjs --inversions` | 0 | 21 rows, 0 failing |
| `prove-settings-parse-check.mjs --inversions` | **1** | 23 rows, 1 failing (A6) |
| `prove-live-region-inventory.mjs` | 0 | 6 passed |
| `prove-outline.mjs --inversions` | 0 | 11 inversions, all bound |
| `prove-check-report-style.mjs` | 0 | 37 passed |

### Step 6 fixture audits (pa11y only)

| Fixture | Expected | Got |
| --- | --- | --- |
| `fixture-broken.html` | Exit 1; pa11y `image-alt`, `label`, `color-contrast`, `link-name`, `html-has-lang` | Exit 1; exactly those 5 rules |
| `fixture-clean.html` | Exit 0; 0 violations, 0 potentials | pa11y 0 and 0; exit 1 only because IBM could not run |

### Step 10 live checks

- `find .` was refused by the `no-recursive-walk` guard, naming Grep, Glob and
  `git ls-files` as alternatives. `find . -maxdepth 1` was allowed.
- The `no-heredoc` guard also refused a multi-line commit message during the install,
  which showed the hooks were already live in the session.
- The edit hook stayed silent on a broken demo page inside the session, because both
  engines failed to launch and the hook never blocks on an engine error. Run by hand
  with the browser workaround, it reported all 4 seeded violations (exit 2), and it
  was silent on a clean page (exit 0). The demo page was deleted afterwards.

## Errors

1. **Proof row A6 fails on Linux.** `prove-settings-parse-check.mjs`:
   `FAIL ALLOW A6 backslash Windows path to an invalid file`. The row rewrites a real
   path with backslashes. Linux treats a backslash as part of a file name, so the
   file is not found and the hook stays silent by design. Very likely a Windows only
   row; it should pass on Windows. The test was not changed.
2. **Chromium will not start as root.** Both engines failed with
   `Running as root without --no-sandbox`. Workaround for this session only: a small
   wrapper script that adds `--no-sandbox`, passed through `PUPPETEER_EXECUTABLE_PATH`
   (the retry Step 6 allows). This fixed pa11y. Not a problem on a normal Windows
   machine.
3. **IBM checker install blocked.** Its `chromedriver` dependency downloads from
   `googlechromelabs.github.io`, which this environment's network policy blocks
   (`403`). npx exited 1 with no message. `CHROMEDRIVER_SKIP_DOWNLOAD=true` lets the
   install finish.
4. **IBM rule archive blocked.** At run time the checker fetches its rules from
   `cdn.jsdelivr.net`, also blocked (`ENOTFOUND`, and `403` through the proxy). IBM
   therefore produced no results at all here, so target size (SC 2.5.8) and IBM's
   other rules are untested in this session.
5. **Firefox is not installed** in the container. The `firefox-devtools` server
   reports Connected, but has no browser to drive.
6. **MCP servers live in the container.** The Chrome and Firefox servers were added
   to this container's user configuration, which disappears with the session. On your
   own machine, add them again with the Windows commands in `mcp-user-servers.md`.
   The two Playwright servers in `.mcp.json` show "Pending approval" until approved
   at start-up.
7. **Screen reader proofs fail.** `sr-prove.mjs` and `label-in-name-prove.mjs` both
   exit 1: `Cached Chromium not found at /opt/pw-browsers/chromium-1223/...`. The
   scripts require the pinned Chromium build 1223; this container has build 1194, and
   every Playwright download host is blocked. The pinned versions were not changed.
8. **Edit hook silent in this session.** A consequence of errors 2 to 4: with no
   engine able to start, the hook is silent. It is not proof a page is clean. The
   hook itself works (see Step 10).

None of these errors is in your two pages or in the kit's design. Errors 2 to 8 come
from the cloud container: root user, blocked hosts, no Firefox, no restart.

## What is ready

- All kit files in the repository, with settings, instruction files, configuration
  and `.gitignore`, ready for anyone who clones the branch.
- The three guards, working and proven (25, 14 and 16 inversions).
- pa11y with axe, proven against both fixtures.
- The live region inventory, digest outliner, report style checker and offline NVDA
  log parser, all proven.
- A first pa11y baseline of your two pages (below).

## What is not ready

- The IBM engine (errors 3 and 4).
- The virtual screen reader and Label in Name checks (error 7).
- The edit hook in cloud sessions, unless the browser workaround is set (errors 2 and 8).
- Real NVDA (Windows only, not requested).

## First baseline of your pages (pa11y only)

| Page | Violations | Rules |
| --- | --- | --- |
| `UoS_AI_Prompt_Library_130.html` | 130 | `color-contrast` (130) |
| `UoS_AI_Tool_Evaluation_Framework.html` | 104 | `color-contrast` (54), `select-name` (49), `label` (1) |

Full reports are written to `.claude/a11y/reports/pa11y/` when the audit runs (that
folder is git-ignored). IBM was not run, so these counts are incomplete.

## Recommended next steps

1. **On your Windows laptop** (the tested platform): pull this branch, start the
   preview server, then re-run Step 5, Step 6, Step 8 and Step 10 of
   `INSTALL-AGENT.md`. Add the two DevTools servers with the Windows commands, then
   restart Claude Code.
2. **Or, to use the kit in cloud sessions:** in the cloud environment's settings,
   under Network access, allow `cdn.jsdelivr.net`, `googlechromelabs.github.io` and
   `cdn.playwright.dev` (see
   https://code.claude.com/docs/en/cloud-environments#network-access). The root
   sandbox issue would still need the `--no-sandbox` wrapper.
3. Fix the contrast and unlabelled `<select>` findings on your pages, then re-audit.
4. Then do the manual checks in
   `.claude/skills/a11y-audit-loop/references/manual-checks.md`.
