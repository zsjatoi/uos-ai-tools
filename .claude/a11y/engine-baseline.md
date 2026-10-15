# Engine baseline: automated accessibility auditing

This file records what each audit engine detected on the kit's fixture pages, so
you have a known-good reference. Re-run the fixtures after any engine upgrade and
compare against the tables below.

## Pinned engine versions

| Engine | Package (pinned) | Runner and rules | Invocation |
| --- | --- | --- | --- |
| IBM Equal Access (primary) | `accessibility-checker@3.1.78` | policy `WCAG_2_2`, `ruleArchive: "19May2026"` | `npx -y accessibility-checker@3.1.78 <url>`, run from `webRoot` |
| pa11y (second) | `pa11y@9.0.0` | `--runner axe` (axe-core 4.10) | `npx -y pa11y@9.0.0 --runner axe --reporter json --config <viewport config> <url>` |

Node `^20.19 || ^22.12 || >=23`. Both engines run through `npx`, so nothing is
installed into your project.

## Detection results on `fixture-broken.html`

Seven faults are seeded. Detected means the engine reported it.

| # | Seeded fault | IBM rule id | IBM | pa11y/axe rule | pa11y |
| --- | --- | --- | --- | --- | --- |
| a | `<img>` with no alt | `img_alt_valid` | detected | `image-alt` | detected |
| b | Unlabelled text input | `input_label_exists` | detected | `label` | detected |
| c | Text contrast about 2.85:1 | `text_contrast_sufficient` | detected | `color-contrast` | detected |
| d | Empty link (no name) | `a_text_purpose` | detected | `link-name` | detected |
| e | Two elements share one id | none | not detected (note 1) | none | not detected (note 1) |
| f | 18 by 18 px targets, no spacing (SC 2.5.8) | `target_spacing_sufficient` | detected | none | not detected (note 2) |
| g | `<html>` with no lang | `html_lang_exists` | detected | `html-has-lang` | detected |

IBM also raises manual-review *potentials* on the broken page. These are not
seeded faults and are expected on real markup: for example `style_color_misuse`,
`form_submit_button_exists`, `element_tabbable_visible` and `style_focus_visible`.

Score: **IBM 6 of 7** (all except the duplicate id), **pa11y/axe 5 of 7** (all
except the duplicate id and target size).

## Results on `fixture-clean.html`

| Engine | Result |
| --- | --- |
| IBM Equal Access | Pass: zero violations and zero potentials |
| pa11y/axe | Pass: empty result array |

The figures observed when the kit was built are recorded in `PROVENANCE.md`.

## Notes

1. **A duplicate id is no longer a WCAG failure.** WCAG 2.2 removed SC 4.1.1
   (Parsing). Under the `WCAG_2_2` policy IBM does not flag duplicate ids on
   non-interactive elements, and axe-core 4.10 dropped its generic
   `duplicate-id` rule. The fault stays in the fixture to document this. It is
   correct behaviour, not a gap in your setup.

2. **Target size is IBM-only.** pa11y's axe runner does not include the
   `wcag22aa` tag, so it has no target-size rule. IBM is your only automated check
   for SC 2.5.8. A single isolated undersized target passes (a 24 px circle can be
   drawn without touching another target), which is why the fixture clusters
   three 18 by 18 px buttons with no spacing.

3. **The rule archive is pinned for repeatable results.** `versioned` would drift
   to the latest dated deployment at run time (an early run resolved to an older
   archive in which target size did not fire; a later one resolved to a newer
   archive in which it did). Use the SHORT archive id from
   `npx accessibility-checker archives` (for example `19May2026`), not the
   dotted date in the help-document URLs.

4. **IBM must run with `webRoot` as its working directory.** It loads
   `.achecker.yml` from the current directory. Run from anywhere else, it
   silently falls back to built-in defaults (latest archive, default policy) and
   writes to a stray `results/` folder. `audit.mjs` sets the working directory for
   you; if you run `achecker` by hand, do the same.

5. **Stale-server race on the first edit.** The hook audits pages over HTTP
   through your preview server. Straight after an edit the server can briefly
   serve the old content, so the first edit that introduces a fault may audit
   silently while your editor's own linter already shows it. The next edit, or
   `/a11y-audit`, catches it. This is timing, not a logic error.

6. **Preview servers can inject elements of their own.** BrowserSync (used by
   the VS Code "Preview on Web Server" extension) adds a fixed
   `<div id="__bs_notify__">` to every page, which makes IBM raise one
   `style_color_misuse` potential per page. `audit.mjs` drops findings that resolve
   to any id listed in `ignoreSelectors` in `a11y.config.json`. The raw reports on
   disk are untouched. If your server injects something else, add its id there.

7. **SC 2.5.3 Label in Name is checked by neither engine.** In one real
   project both engines reported 0 violations while 25 controls carried an
   `aria-label` that did not contain their visible text. That is a genuine gap,
   not correct behaviour, and it is why `/a11y-label-in-name` exists. The engines
   also cannot *reach* controls inside `display:none` panels, closed `<details>`
   or behind a mode switch: both read the page as loaded.

8. **`fieldset_label_valid` means a duplicate name, not a missing one.** It fires
   on a `<fieldset>` with a visible `<legend>`, and says the group has "a
   duplicate name to another group". Route it to ambiguous-name work, not to a
   missing-name fix. Do not confuse it with `input_label_exists`, which on a
   control inside a closed `<details>` can be an artefact of the disclosure being
   closed.

9. **Ambiguous accessible names are checked by neither engine.** A page of ten
   buttons all named "Download" raises nothing from either engine, yet a
   screen-reader or voice-input user cannot tell them apart (SC 2.4.6, 2.4.4).
   `/a11y-label-in-name` lists names shared by several controls and counts how
   many are rendered together. Gate on the co-rendered count, never the total.

10. **Establish the spread before attributing a change.** On large pages the
    potentials count can swing between runs with nothing altered, because both
    engines audit the working tree as served. Run the baseline twice before
    blaming your edit. A before-and-after at n=1 per side cannot separate your
    change from the instrument's own spread.

11. **pa11y runs at the viewport in `pa11yViewport`** (default 1280 by 2000).
    pa11y's own default is 1280 by 1024, and a node just past the bottom edge can
    be returned by axe as "incomplete" and surfaced by pa11y@9 as an **error**
    (it maps incomplete results on serious-impact rules such as colour contrast to
    errors). A tall viewport avoids that. Set the height to roughly your tallest
    page's `scrollHeight`, and re-measure when pages grow. pa11y 9's CLI has no
    `--viewport` flag, which is why `audit.mjs` writes a small config file and
    passes `--config`.
