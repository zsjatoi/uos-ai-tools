# What the accessibility engines find on the test pages

**Snapshot taken on 8 October 2026.**

This file records what each engine found on the kit's test pages, so you know what a
working setup looks like. If you update an engine, run the test pages again and
compare with these tables.

## The engines and versions

| Engine | Package (fixed version) | Rules | How it runs |
| --- | --- | --- | --- |
| IBM Equal Access (the main one) | `accessibility-checker@3.1.78` | the `WCAG_2_2` rule set, archive `19May2026` | `npx -y accessibility-checker@3.1.78 <url>`, run from `webRoot` |
| pa11y (the second one) | `pa11y@9.0.0` | axe (axe-core 4.10) | `npx -y pa11y@9.0.0 --runner axe --reporter json --config <viewport config> <url>` |

You need Node.js 20.19 or newer in the 20 series, 22.12 or newer in the 22 series, or
23 and above. Both engines run through `npx`, so nothing is installed in your project.

## What they find on `fixture-broken.html`

We put seven faults on this page on purpose. "Found" means the engine reported it.

| | Fault we added | IBM rule | IBM | axe rule | axe |
| --- | --- | --- | --- | --- | --- |
| a | An image with no alt text | `img_alt_valid` | found | `image-alt` | found |
| b | A text box with no label | `input_label_exists` | found | `label` | found |
| c | Grey text on white, contrast about 2.85 to 1 | `text_contrast_sufficient` | found | `color-contrast` | found |
| d | A link with no name | `a_text_purpose` | found | `link-name` | found |
| e | Two elements sharing one id | none | not found (note 1) | none | not found (note 1) |
| f | Buttons only 18 by 18 pixels, packed together (WCAG 2.5.8) | `target_spacing_sufficient` | found | none | not found (note 2) |
| g | A page with no language set | `html_lang_exists` | found | `html-has-lang` | found |

IBM also lists some "potentials" on this page. These are things for a person to check,
not faults we added, and you will see them on real pages too. Examples are
`style_color_misuse`, `form_submit_button_exists`, `element_tabbable_visible` and
`style_focus_visible`.

**IBM found 6 of the 7** faults (all except the shared id). **axe found 5 of the 7**
(all except the shared id and the small buttons).

## What they find on `fixture-clean.html`

| Engine | Result |
| --- | --- |
| IBM Equal Access | Passed: no violations and no potentials |
| axe (through pa11y) | Passed: nothing reported |

`PROVENANCE.md` records the exact numbers we saw when we built the kit.

## Notes

1. **A shared id is no longer a WCAG failure.** WCAG 2.2 removed the rule about this
   (4.1.1 Parsing). IBM's `WCAG_2_2` rule set no longer reports it, and axe-core 4.10
   dropped its general rule for it. We left the fault on the page to show this. It is
   correct behaviour, not a problem with your setup.

2. **Only IBM checks button and link size.** pa11y's axe setup does not include the
   WCAG 2.2 AA rules, so it has no size rule. IBM is your only automatic check for
   WCAG 2.5.8. A single small button on its own can still pass, because the rule
   allows enough space around it. That is why the test page packs three small buttons
   together.

3. **We fixed the rule archive so results stay the same.** If you choose `versioned`,
   IBM uses whatever archive is newest when it runs, so results can change from one
   day to the next. In one early run, the size rule did not fire at all because IBM
   used an older archive. Use the short archive name that
   `npx accessibility-checker archives` lists, such as `19May2026`.

4. **IBM must run from your `webRoot` folder.** It reads `.achecker.yml` from the
   folder it runs in. If it runs anywhere else, it quietly uses its own defaults (the
   newest archive and a different rule set) and saves its results in a stray
   `results/` folder. `audit.mjs` runs it from the right folder for you. If you run IBM
   yourself, do the same.

5. **The first edit can look clean.** The edit-time check loads your page through your
   preview server. Straight after an edit, the server can show the old page for a
   moment. So the first edit that adds a fault may pass. The next edit, or
   `/a11y-audit`, finds it. This is a timing issue, not a mistake in the check.

6. **Some preview servers add their own elements.** BrowserSync, used by the VS Code
   "Preview on Web Server" extension, adds a `<div id="__bs_notify__">` to every page.
   IBM then raises one `style_color_misuse` potential on every page. `audit.mjs` leaves
   out findings for any id listed in `ignoreSelectors` in `a11y.config.json`. The full
   reports on disk still include them. If your server adds a different element, add
   its id there.

7. **Neither engine checks that a control's name matches its label** (WCAG 2.5.3,
   Label in Name). On one real project, both engines found no violations, while 25
   controls had hidden names that did not contain their visible words. That is a real
   gap, and it is why `/a11y-label-in-name` exists. The engines also cannot reach
   controls inside hidden panels, closed `<details>` sections or other modes of the
   page. They check the page only as it first loads.

8. **`fieldset_label_valid` means two groups share a name, not that a name is
   missing.** It fires on a `<fieldset>` that has a visible `<legend>`, and says the
   group has "a duplicate name to another group". Treat it as a naming problem, not a
   missing label. Do not mix it up with `input_label_exists`. That one can also fire on
   a control inside a closed `<details>` section, just because the section is closed.

9. **Neither engine notices names that several controls share.** A page with ten
   buttons all called "Download" raises nothing from either engine. But a
   screen-reader or voice-control user cannot tell those buttons apart (WCAG 2.4.6
   and 2.4.4). `/a11y-label-in-name` lists names shared by several controls, and
   counts how many show on screen at once. Judge the problem by the number on screen
   together, not the total.

10. **Check how much results vary before you blame a change.** On large pages, the
    number of potentials can change between runs even when nothing has changed. Run
    the check twice before you blame your edit. One run before and one after cannot
    tell your change apart from normal variation.

11. **pa11y uses the window size in `pa11yViewport`** (1280 by 2000 to start with).
    pa11y's own default is 1280 by 1024. If an element sits just below the bottom of
    the window, axe can mark it "incomplete", and pa11y 9 then reports some of those
    as **errors**, such as colour contrast. A tall window avoids this. Set the height
    close to your longest page, and change it when your pages grow. pa11y 9 has no
    command-line option for window size, so `audit.mjs` writes a small settings file
    and passes it with `--config`.
