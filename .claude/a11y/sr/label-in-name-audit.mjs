// label-in-name-audit.mjs — SC 2.5.3 Label in Name checker, plus name-override review.
//
// WHY THIS EXISTS. A checkbox can carry aria-label="PDF format" over a visible
// title of "PDF (HTML Rendering)". That fails SC 2.5.3, and EVERY other layer
// can report clean:
//   - IBM Equal Access and pa11y/axe: 0 violations. Neither engine checks 2.5.3.
//   - /a11y-sr: silent. summarisePage() in sr-audit.mjs flags name === "" only,
//     so a WRONG name is out of its scope.
//   - all three: could not even reach the controls, which sit inside a
//     display:none panel.
// This runner closes the first two gaps. The third is state-capture's job.
//
// WHAT IT REPORTS, at two levels:
//   FAIL   — SC 2.5.3: the control's VISIBLE label text is not contained in its
//            accessible name. Extra text in the name is allowed; that is what
//            the success criterion says.
//   REVIEW — ambiguous name: several controls answer to the SAME accessible name.
//            A different question from 2.5.3, which cannot see it: ten buttons all
//            named "Download" each pass containment perfectly while telling a
//            screen-reader or voice-input user nothing about which one they want.
//   REVIEW — name override: the control has aria-label AND visible label text,
//            even where containment passes. This is the other half of the
//            defect above: aria-label="DOCX format" passed containment against
//            the visible "DOCX" while silently suppressing the entire
//            .format-description, including an accessibility warning.
//
// Headless on the cached chromium-1223, launched by explicit executablePath from
// the external install. On-demand ONLY; NEVER wired into the PostToolUse hook.
//
// A clean run is NOT WCAG 2.2 AA conformance, and REVIEW rows are judgement
// calls for a human, not defects.
//
// Run:  node .claude/a11y/sr/label-in-name-audit.mjs <page> [--all-rows]
//       (page is relative to the web root, e.g. index.html, or a full URL.
//        --all-rows also prints the controls that passed.)
//       Preview server must be up (previewBase in sr-config.json).

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, isServerUp, resolveInstallDir } from "./sr-audit.mjs";

// --- house-style logging -----------------------------------------------------
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const DEFAULT_LOG_LEVEL = LOG_LEVELS.INFO;
function shouldLog(level) { return level <= DEFAULT_LOG_LEVEL; }
function logError(m, ...a) { if (shouldLog(LOG_LEVELS.ERROR)) console.error(m, ...a); }
function logWarn(m, ...a) { if (shouldLog(LOG_LEVELS.WARN)) console.warn(m, ...a); }
function logInfo(m, ...a) { if (shouldLog(LOG_LEVELS.INFO)) console.log(m, ...a); }

// --- resolve the external toolchain (playwright) -----------------------------
const installDir = resolveInstallDir();
const pkgJson = join(installDir, "package.json");
if (!existsSync(pkgJson)) {
  logError(`Toolchain not installed at ${installDir}. See .claude/a11y/sr/SETUP.md.`);
  process.exit(1);
}
const requireExternal = createRequire(pkgJson);
const { chromium } = requireExternal("playwright");

const PREVIEW_BASE = (CONFIG.previewBase || "").replace(/\/+$/, "");
export const pageUrl = (p) =>
  /^https?:\/\//i.test(p) ? p : `${PREVIEW_BASE}/${p.replace(/^\/+/, "")}`;

// Every element that can take an accessible name and be operated by a user.
// Kept as one string so the in-page walk and the CDP walk use the SAME selector
// and therefore the same document order (alignment is verified below).
export const CONTROL_SELECTOR = [
  "input:not([type=hidden])",
  "select",
  "textarea",
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="searchbox"]',
].join(",");

// ---------------------------------------------------------------------------
// Comparison rule. Every edge case in this check lives here, so it is spelled
// out rather than left to the reader.
//
// SC 2.5.3 asks that the visible LABEL TEXT be contained in the accessible
// name. So: normalise both sides, then test containment — not equality.
// ---------------------------------------------------------------------------
export function normalise(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    // Strip leading/trailing punctuation, SYMBOLS and combining marks only.
    // Interior punctuation is part of the label a user reads out
    // ("PDF (HTML Rendering)") and must be kept.
    //
    // \p{S} and \p{M} are load-bearing, not tidying. An emoji or symbol used as
    // an icon is not text a user reads as part of the label — which is already
    // the rule isSymbolicOnly() applies to a whole label — so a PREFIX of one
    // must not be treated as label text either. Without them "↻ Refresh" never
    // reduces to "refresh" and "⬇️ Download" never to "download", and the
    // checker reports a containment failure that is an artefact of its own
    // normalisation (measured on a real page: most emoji-prefixed rows were
    // over-reported this way).
    // \p{M} is here because an emoji presentation selector (U+FE0F, Mn) trails
    // the base character in "⬇️" and would otherwise survive the \p{S} strip.
    .replace(/^[\s\p{P}\p{S}\p{M}]+|[\s\p{P}\p{S}\p{M}]+$/gu, "");
}

// WCAG does not treat an icon or a symbol as a text label, so aria-label="Close"
// on a "×" is NOT a 2.5.3 failure. Getting this wrong turns the whole run into
// noise, which is why it is a named predicate rather than an inline condition.
const SYMBOLIC_ONLY_RE = /^[\s\p{P}\p{S}\p{Emoji_Presentation}]*$/u;
export function isSymbolicOnly(s) {
  return SYMBOLIC_ONLY_RE.test(String(s || ""));
}

// A visible label must contain at least one letter or digit to be comparable.
export function isComparableVisibleText(s) {
  const n = normalise(s);
  if (n === "") return false;
  if (isSymbolicOnly(n)) return false;
  return /[\p{L}\p{N}]/u.test(n);
}

// ---------------------------------------------------------------------------
// The in-page collector. Runs against the real, rendered DOM.
//
// querySelectorAll sees display:none content, which the accessibility tree does
// NOT — that is the whole reason this layer can reach controls in hidden panels
// where every other layer stops. The cost is that a name computed here is
// DOM-DERIVED, not the browser's own computation. Rendered controls are
// cross-checked against the real accessibility tree below, and every finding
// records which source produced its name.
// ---------------------------------------------------------------------------
function collectorSource(controlSelector) {
  return `(() => {
  const CONTROL_SELECTOR = ${JSON.stringify(controlSelector)};

  // Text that a sighted user cannot see does not count as a VISIBLE label. Both
  // of the usual off-screen helper classes are matched by name
  // (.visually-hidden and .sr-only), plus the generic CSS cases. Note this is a
  // per-element test: getComputedStyle on an element inside a display:none
  // ancestor still reports that element's own display, so the walk works on
  // unrendered subtrees too.
  const OFFSCREEN_CLASS_RE = /(^|\\s)(visually-hidden|sr-only)(\\s|$)/;
  function isInvisibleForLabelText(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const cls = (el.getAttribute("class") || "");
    if (OFFSCREEN_CLASS_RE.test(cls)) return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    // Clip-based off-screen helpers under any class name.
    if (cs.clip === "rect(0px, 0px, 0px, 0px)") return true;
    return false;
  }

  // Accumulate the text of root's descendants, skipping invisible subtrees and
  // skipping the control itself (a wrapping <label> contains the control).
  function visibleTextOf(root, skipEl) {
    if (!root) return "";
    // Test the ROOT as well as its descendants. A <label class="visually-hidden">
    // is a legitimate name source but is NOT a visible label, so 2.5.3 has
    // nothing to compare — missing this counted off-screen label text as visible.
    if (isInvisibleForLabelText(root)) return "";
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (node === skipEl) return;
      if (isInvisibleForLabelText(node)) return;
      for (const child of node.childNodes) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return out.replace(/\\s+/g, " ").trim();
  }

  // Text used for NAME computation includes off-screen text (an aria-labelledby
  // target or a visually-hidden <label> legitimately names a control), but never
  // an aria-hidden subtree.
  function nameTextOf(root, skipEl) {
    if (!root) return "";
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (node === skipEl) return;
      if (node.getAttribute("aria-hidden") === "true") return;
      for (const child of node.childNodes) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return out.replace(/\\s+/g, " ").trim();
  }

  function labelsFor(el) {
    const out = [];
    const wrapping = el.closest("label");
    if (wrapping) out.push(wrapping);
    if (el.id) {
      const esc = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id;
      for (const l of document.querySelectorAll('label[for="' + esc + '"]')) {
        if (!out.includes(l)) out.push(l);
      }
    }
    return out;
  }

  function idRefText(el, attr) {
    const raw = el.getAttribute(attr);
    if (!raw) return null;
    const parts = raw.split(/\\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    const chunks = [];
    let missing = 0;
    for (const id of parts) {
      const t = document.getElementById(id);
      if (!t) { missing++; continue; }
      chunks.push(nameTextOf(t, null) || (t.getAttribute("aria-label") || ""));
    }
    return { text: chunks.join(" ").replace(/\\s+/g, " ").trim(), missing };
  }

  // A human-readable locator for the report. For an element with no id this has to
  // work harder than a CSS selector would: the ambiguous-name list groups controls
  // that share a name, and ten rows all reading "button.imgdesc-mm-action-btn" name
  // the defect without saying WHICH button, which makes the finding unactionable.
  // So fall back to the nearest ancestor id plus the onclick handler, which is what
  // actually distinguishes generated controls like imgdescMMLoad('qwen35').
  function locatorFor(el) {
    if (el.id) return "#" + el.id;
    const bits = [el.tagName.toLowerCase()];
    const t = el.getAttribute("type");
    if (t) bits.push('[type="' + t + '"]');
    const n = el.getAttribute("name");
    if (n) bits.push('[name="' + n + '"]');
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/)[0];
    if (cls) bits.push("." + cls);
    let out = bits.join("");

    let anc = el.parentElement;
    let hops = 0;
    while (anc && hops++ < 8) {
      if (anc.id) { out = "#" + anc.id + " >> " + out; break; }
      anc = anc.parentElement;
    }
    const onclick = el.getAttribute("onclick");
    if (onclick) out += "  onclick=" + onclick.replace(/\\s+/g, " ").slice(0, 48);
    return out;
  }

  const els = Array.from(document.querySelectorAll(CONTROL_SELECTOR));
  return els.map((el, index) => {
    const labels = labelsFor(el);
    const visibleFromLabels = labels
      .map((l) => visibleTextOf(l, el))
      .filter(Boolean)
      .join(" ")
      .replace(/\\s+/g, " ")
      .trim();
    // A button or link presents its own content as its visible label.
    const ownVisible = visibleTextOf(el, null);
    const selfLabelling = /^(button|a|summary)$/i.test(el.tagName) ||
      /^(button|link|tab|menuitem)$/.test(el.getAttribute("role") || "");
    const visibleText = visibleFromLabels || (selfLabelling ? ownVisible : "");

    // A label element often holds MORE than the label: a format
    // checkbox may wrap a short title AND a multi-line description in one <label>.
    // Comparing the whole lot against the name would fail every such control,
    // including the correctly-authored ones. So collect the plausible label
    // texts — the whole thing, each label element, and each element block within
    // them — and 2.5.3 passes if ANY of them is contained in the name.
    const visibleCandidates = [];
    const addCandidate = (t) => {
      const v = String(t || "").replace(/\\s+/g, " ").trim();
      if (v && !visibleCandidates.includes(v)) visibleCandidates.push(v);
    };
    addCandidate(visibleText);
    for (const l of labels) {
      addCandidate(visibleTextOf(l, el));
      for (const child of l.querySelectorAll("*")) {
        if (child === el || child.contains(el)) continue;
        if (isInvisibleForLabelText(child)) continue;
        addCandidate(visibleTextOf(child, el));
      }
    }
    // Same treatment for a self-labelling element. A visually-hidden span sitting
    // BETWEEN the visible words (a status <summary> element may do
    // exactly that) means the visible text is not a contiguous substring of the
    // name even though every visible word is present and in order — so compare
    // the visible blocks individually rather than only the concatenation.
    if (selfLabelling) {
      addCandidate(ownVisible);
      for (const child of el.querySelectorAll("*")) {
        if (isInvisibleForLabelText(child)) continue;
        addCandidate(visibleTextOf(child, null));
      }
    }

    // Accessible-name resolution, in HTML-AAM order.
    const ariaLabelledby = idRefText(el, "aria-labelledby");
    const ariaLabel = el.getAttribute("aria-label");
    const labelText = labels.map((l) => nameTextOf(l, el)).filter(Boolean).join(" ").trim();
    let domName = "";
    let nameSource = "none";
    if (ariaLabelledby && ariaLabelledby.text) {
      domName = ariaLabelledby.text; nameSource = "aria-labelledby";
    } else if (ariaLabel && ariaLabel.trim()) {
      domName = ariaLabel.trim(); nameSource = "aria-label";
    } else if (labelText) {
      domName = labelText; nameSource = "label";
    } else if (selfLabelling && nameTextOf(el, null)) {
      domName = nameTextOf(el, null); nameSource = "content";
    } else if (el.getAttribute("title")) {
      domName = el.getAttribute("title").trim(); nameSource = "title";
    }

    return {
      index,
      locator: locatorFor(el),
      id: el.id || null,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || null,
      role: el.getAttribute("role") || null,
      rendered: el.getClientRects().length > 0,
      visibleText,
      visibleCandidates,
      domName,
      nameSource,
      hasAriaLabel: !!(ariaLabel && ariaLabel.trim()),
      danglingLabelledby: ariaLabelledby ? ariaLabelledby.missing : 0,
    };
  });
})()`;
}

// ---------------------------------------------------------------------------
// The real computed name, from the browser's own accessibility tree.
//
// Extends the CDP probe pattern already used by probeAxExposure() in
// alt-text-audit.mjs: Accessibility.getPartialAXTree already returns `name` and
// `description` as AXValues alongside the `role` that probe reads, so this needs
// no new domain, command, or round trip.
//
// Identity is by `id`, NOT by document order. Order-based pairing looked correct
// on a static fixture and then failed on the real app: an app page keeps mutating,
// so a CDP walk taken moments after the in-page walk found 775 controls where the
// page had reported 757. Pairing by id is immune to that. Controls with no id keep
// the DOM-derived name, which is reported as such rather than guessed at.
// ---------------------------------------------------------------------------
async function axNames(page, controls) {
  const result = {
    byId: new Map(),
    aligned: true,
    probed: 0,
    cdpControls: 0,
    unmatchedIds: 0,
    withoutId: controls.filter((c) => c.rendered && !c.id).length,
    error: null,
  };
  const wantedIds = new Set(controls.filter((c) => c.rendered && c.id).map((c) => c.id));
  if (wantedIds.size === 0) return result;

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: CONTROL_SELECTOR,
    });
    result.cdpControls = (nodeIds || []).length;

    // Map id -> CDP nodeId first, so a mutation between the two walks shifts
    // nothing: an id either resolves or it does not.
    const nodeIdById = new Map();
    for (const nodeId of nodeIds || []) {
      const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
      const idIdx = attributes.indexOf("id");
      if (idIdx === -1) continue;
      const id = attributes[idIdx + 1];
      if (!id || !wantedIds.has(id)) continue;
      // A duplicate id is a defect in its own right; refuse to guess which is meant.
      if (nodeIdById.has(id)) nodeIdById.set(id, null);
      else nodeIdById.set(id, nodeId);
    }

    for (const id of wantedIds) {
      const nodeId = nodeIdById.get(id);
      if (!nodeId) { result.unmatchedIds++; continue; }
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
        nodeId,
        fetchRelatives: false,
      });
      const n = nodes && nodes[0];
      if (!n) { result.unmatchedIds++; continue; }
      result.byId.set(id, {
        name: n.name && n.name.value ? String(n.name.value) : "",
        description: n.description && n.description.value ? String(n.description.value) : "",
        role: n.role && n.role.value ? String(n.role.value) : null,
        ignored: n.ignored === true,
      });
      result.probed++;
    }
  } catch (e) {
    result.aligned = false;
    result.error = `probe-error:${e.message}`;
  } finally {
    try { await cdp.detach(); } catch { /* best-effort */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Which name are we judging, and where did it come from? Shared by the 2.5.3
// check and the ambiguous-name check so the two can never disagree about what a
// control is called.
// ---------------------------------------------------------------------------
export function resolveName(control, ax) {
  const useAx = !!(ax && !ax.ignored && ax.name);
  return {
    name: useAx ? ax.name : control.domName,
    source: useAx ? "ax" : "dom",
  };
}

// ---------------------------------------------------------------------------
// Classify one control. Returns null where there is nothing to judge.
// ---------------------------------------------------------------------------
export function classify(control, ax) {
  const { name, source } = resolveName(control, ax);

  // No comparable visible label text: an icon-only button, or a symbol like "×".
  // Nothing to compare, so 2.5.3 does not apply.
  if (!isComparableVisibleText(control.visibleText)) return null;

  const candidates = (control.visibleCandidates || [control.visibleText])
    .filter(isComparableVisibleText);
  if (candidates.length === 0) return null;

  const nameN = normalise(name);

  if (nameN === "") {
    // No name at all is /a11y-sr's territory, not 2.5.3's. Report it as review
    // rather than staying silent, because a visible label that produced no name
    // is a real wiring problem.
    return {
      level: "REVIEW",
      reason: "visible label text but NO accessible name",
      control, name, source,
    };
  }

  const matched = candidates.find((c) => nameN.includes(normalise(c)));
  if (!matched) {
    return {
      level: "FAIL",
      reason:
        "SC 2.5.3: no visible label text is contained in the accessible name " +
        `(tried ${candidates.length} candidate(s))`,
      control, name, source, candidates,
    };
  }

  if (control.hasAriaLabel) {
    return {
      level: "REVIEW",
      reason:
        `aria-label overrides visible content: "${matched}" is contained in the name, ` +
        "but any other visible text (e.g. a description) is suppressed",
      control, name, source, matched,
    };
  }

  return {
    level: "PASS",
    reason: `visible label text "${matched}" is contained in the accessible name`,
    control, name, source, matched,
  };
}

// ---------------------------------------------------------------------------
// Ambiguous names: several controls answering to the SAME accessible name.
//
// A DIFFERENT question from 2.5.3, and one 2.5.3 cannot ask. Ten buttons all
// named "Download" each pass containment perfectly — their visible text is
// "Download" and so is their name — while telling a screen-reader or voice-input
// user nothing about *which* thing they download. Typical offenders are
// repeated "Download", "Copy code to clipboard" and "Details" buttons.
//
// Reported as REVIEW, never FAIL, because repeated names are often legitimate:
// four copies of an export fieldset, or a "Cancel" in each of several dialogs
// that never coexist.
//
// The discriminator worth having is HOW MANY ARE RENDERED AT ONCE. Several
// same-named controls visible together is a live ambiguity a user can actually
// hit; several in mutually-exclusive panels usually is not. So groups are sorted
// by co-rendered count first, putting the likely real problems at the top,
// and the count is printed rather than being used to hide anything.
// ---------------------------------------------------------------------------
export function findDuplicateNames(controls, ax) {
  const groups = new Map();
  for (const control of controls) {
    const axEntry = control.id ? ax.byId.get(control.id) : undefined;
    const { name, source } = resolveName(control, axEntry);
    const key = normalise(name);
    // An EMPTY name is a different defect and /a11y-sr's territory, not ambiguity.
    if (key === "") continue;
    if (!groups.has(key)) groups.set(key, { key, name, members: [] });
    groups.get(key).members.push({
      locator: control.locator,
      tag: control.tag,
      role: control.role,
      rendered: control.rendered,
      source,
    });
  }

  return [...groups.values()]
    .filter((g) => g.members.length > 1)
    .map((g) => ({
      ...g,
      count: g.members.length,
      renderedCount: g.members.filter((m) => m.rendered).length,
    }))
    .sort((a, b) => b.renderedCount - a.renderedCount || b.count - a.count);
}

// ---------------------------------------------------------------------------
// The co-rendered gate (opt-in, --max-co-rendered=N).
//
// Reporting a number and hoping someone reads it is not a guard. A page taken to
// 0 co-rendered groups needs something to hold it there: this runner's exit code
// keys on FAIL rows only, so a future edit could reintroduce a dozen identical
// "Download" buttons and every automated check would still be green.
//
// GATE ON CO-RENDERED, NEVER ON THE TOTAL. The total can legitimately be large —
// the same item may appear in several panels with only one rendered at a time, so
// those groups have one member rendered and are correct. A gate on the total
// would demand deleting real controls to satisfy it.
//
// Split into a parser and a pure evaluator so the fixture proof can exercise
// exactly the code the CLI runs, rather than a re-implementation of it.
// ---------------------------------------------------------------------------
export function parseMaxCoRendered(argv) {
  const flag = argv.find((a) => a.startsWith("--max-co-rendered="));
  if (!flag) return null; // absent = report only, behaviour unchanged
  const raw = flag.slice("--max-co-rendered=".length);
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`--max-co-rendered needs an integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function evaluateCoRenderedGate(duplicateNames, max) {
  const offending = duplicateNames.filter((g) => g.renderedCount > 1);
  return {
    enabled: max !== null && max !== undefined,
    max,
    count: offending.length,
    offending,
    breached: max !== null && max !== undefined && offending.length > max,
  };
}

// ---------------------------------------------------------------------------
// Scan one already-loaded page. Exported so the prove runner reuses it.
// ---------------------------------------------------------------------------
export async function scanPage(page) {
  const controls = await page.evaluate(collectorSource(CONTROL_SELECTOR));
  const ax = await axNames(page, controls);

  const rows = [];
  const disagreementRows = [];
  for (const control of controls) {
    const axEntry = control.id ? ax.byId.get(control.id) : undefined;
    const row = classify(control, axEntry);
    if (!row) continue;
    // Calibration: where BOTH sources exist, do they agree? A count read bare
    // invites the reader to supply their own causal story, so record WHICH
    // controls disagree and how — that is what says whether the DOM-derived
    // name used on unrendered controls can be trusted.
    if (axEntry && !axEntry.ignored && axEntry.name && control.domName) {
      if (normalise(axEntry.name) !== normalise(control.domName)) {
        disagreementRows.push({
          locator: control.locator,
          via: control.nameSource,
          ax: axEntry.name,
          dom: control.domName,
        });
      }
    }
    rows.push(row);
  }

  const duplicateNames = findDuplicateNames(controls, ax);

  return {
    controls,
    rows,
    disagreementRows,
    duplicateNames,
    stats: {
      controls: controls.length,
      rendered: controls.filter((c) => c.rendered).length,
      judged: rows.length,
      fails: rows.filter((r) => r.level === "FAIL").length,
      reviews: rows.filter((r) => r.level === "REVIEW").length,
      passes: rows.filter((r) => r.level === "PASS").length,
      axProbed: ax.probed,
      axAligned: ax.aligned,
      axError: ax.error,
      axCdpControls: ax.cdpControls,
      axUnmatchedIds: ax.unmatchedIds,
      axRenderedWithoutId: ax.withoutId,
      disagreements: disagreementRows.length,
      danglingLabelledby: controls.reduce((n, c) => n + (c.danglingLabelledby || 0), 0),
      duplicateNameGroups: duplicateNames.length,
      duplicateNameGroupsCoRendered: duplicateNames.filter((g) => g.renderedCount > 1).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Viewports. SC 2.5.3 has to hold at every width the site supports, and a page
// may hide control labels below a breakpoint, for example:
//
//   .file-controls .btn-label { display: none }
//   @media (min-width: 1400px) { .file-controls .btn-label { display: inline } }
//
// Such controls are icon-only narrow and text-labelled wide. Scanning one width
// cannot see both cases: removing an aria-label can leave a control with NO
// accessible name at the wide width while a single-width scan stays silent.
//
// Two widths suffice for a page whose only width-dependent label rule is the
// 1400px breakpoint; add widths if your page has more such breakpoints.
// ---------------------------------------------------------------------------
const CONFIGURED_VIEWPORTS =
  Array.isArray(CONFIG.viewports) && CONFIG.viewports.length > 0
    ? CONFIG.viewports
    : [{ width: 1280, height: 720 }];

// --viewport=1280x720 (repeatable) narrows the scan to specific widths. Its reason
// for existing is falsifiability: proving the second width is what catches a
// responsive-label regression requires running the SAME page at one width and at
// two, and a flag makes that reproducible instead of a hand-edited config.
export function parseViewportFlags(argv) {
  const out = [];
  for (const a of argv) {
    const m = /^--viewport=(\d+)x(\d+)$/.exec(a);
    if (m) out.push({ width: Number(m[1]), height: Number(m[2]) });
  }
  return out;
}

export const VIEWPORTS = (() => {
  const fromFlags = parseViewportFlags(process.argv.slice(2));
  return fromFlags.length > 0 ? fromFlags : CONFIGURED_VIEWPORTS;
})();

const viewportLabel = (v) => `${v.width}x${v.height}`;

// Identity for merging the same control across widths. The locator already carries
// the nearest ancestor id and the onclick handler for id-less controls, so it is
// stable across a resize; a genuinely indistinguishable pair would merge, which is
// noted rather than hidden.
const rowKey = (row) => row.control.id || row.control.locator;

// Load a page once and scan it at every configured width. Exported for the prove
// runner. scanPage() itself stays single-viewport, so callers that own their own
// page (the prove runner) are unaffected.
export async function scanUrl(browser, pageOrUrl) {
  const url = pageUrl(pageOrUrl);
  const page = await browser.newPage({ viewport: VIEWPORTS[0] });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Let the app finish building before the FIRST scan. Without this the widths
    // see different DOMs and the difference reads as a viewport effect: the
    // divergence count can vary between two runs of the same page, which is
    // timing, not layout. Any control-set difference that survives this
    // wait is reported as DOM churn rather than dressed up as a finding.
    await page.waitForTimeout(2500);

    const perViewport = [];
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      // Let the media queries settle before reading computed styles.
      await page.waitForTimeout(300);
      perViewport.push({ viewport: v, scan: await scanPage(page) });
    }
    return { url, ...mergeScans(perViewport) };
  } finally {
    await page.close();
  }
}

// Merge per-width scans. A control FAILS if it fails at ANY width — the criterion
// must hold at all of them — and each row records where it failed. Controls whose
// verdict CHANGES between widths are pulled out separately: that set is exactly
// the responsive-label population, and it is where a fix can be right at one width
// and wrong at another.
export function mergeScans(perViewport) {
  const base = perViewport[perViewport.length - 1].scan;
  if (perViewport.length === 1) {
    return { ...base, viewports: [perViewport[0].viewport], divergences: [] };
  }

  const allWidths = perViewport.map(({ viewport }) => viewportLabel(viewport));

  // PRESENCE is read from the CONTROL set, not from the rows. That distinction is
  // load-bearing. querySelectorAll sees display:none, so a media query can never
  // remove a control from the control set — but it CAN empty that control's visible
  // label, which produces no row because 2.5.3 then has nothing to compare. Those
  // two cases look identical if you only look at rows, and they mean opposite
  // things: "judged at one width, skipped at the other" is the responsive-label
  // signal this scan exists to find, while "missing from the control set entirely"
  // is the page still building between scans.
  const controlsByKey = new Map();
  const rowsByKey = new Map();
  for (const { viewport, scan } of perViewport) {
    const w = viewportLabel(viewport);
    for (const control of scan.controls) {
      const key = control.id || control.locator;
      if (!controlsByKey.has(key)) controlsByKey.set(key, new Map());
      controlsByKey.get(key).set(w, control);
    }
    for (const row of scan.rows) {
      const key = rowKey(row);
      if (!rowsByKey.has(key)) rowsByKey.set(key, new Map());
      rowsByKey.get(key).set(w, row);
    }
  }

  const LEVEL_RANK = { PASS: 0, REVIEW: 1, FAIL: 2 };
  const rows = [];
  const divergences = [];
  const churn = [];

  for (const [key, perWidthControl] of controlsByKey) {
    const perWidthRow = rowsByKey.get(key) || new Map();
    const absentFromDom = allWidths.filter((w) => !perWidthControl.has(w));
    if (absentFromDom.length > 0) {
      churn.push({ key, absentFromDom, presentAt: [...perWidthControl.keys()] });
      // Still judge it on the widths where it existed — a real finding at one
      // width is not discarded because the DOM moved.
    }
    if (perWidthRow.size === 0) continue; // never comparable at any width

    let worst = null;
    for (const row of perWidthRow.values()) {
      if (!worst || LEVEL_RANK[row.level] > LEVEL_RANK[worst.level]) worst = row;
    }
    const widths = [...perWidthRow.entries()]
      .filter(([, row]) => row.level === worst.level)
      .map(([w]) => w);

    const levels = new Set([...perWidthRow.values()].map((r) => r.level));
    const skippedAt = allWidths.filter(
      (w) => perWidthControl.has(w) && !perWidthRow.has(w)
    );
    if (levels.size > 1 || skippedAt.length > 0) {
      divergences.push({
        key,
        levelsByWidth: allWidths
          .filter((w) => perWidthRow.has(w))
          .map((w) => `${w}=${perWidthRow.get(w).level}`),
        skippedAt,
        row: worst,
      });
    }
    rows.push({ ...worst, widths, judgedAtWidths: perWidthRow.size });
  }

  // Ambiguity and the AX/DOM calibration are read from the WIDEST scan, where the
  // most label text is visible; merging them across widths would double-count.
  return {
    ...base,
    rows,
    viewports: perViewport.map((p) => p.viewport),
    divergences,
    churn,
    stats: {
      ...base.stats,
      judged: rows.length,
      fails: rows.filter((r) => r.level === "FAIL").length,
      reviews: rows.filter((r) => r.level === "REVIEW").length,
      passes: rows.filter((r) => r.level === "PASS").length,
      divergences: divergences.length,
      churn: churn.length,
    },
  };
}

export async function launchBrowser() {
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath) || !executablePath.includes(`chromium-${CONFIG.chromiumRevision}`)) {
    logWarn(`Chromium executablePath not the pinned chromium-${CONFIG.chromiumRevision}: ${executablePath}`);
  }
  return { executablePath, browser: await chromium.launch({ executablePath, headless: true }) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function printRow(r) {
  const c = r.control;
  const where = c.rendered ? "rendered" : "not-rendered";
  const at = r.widths && r.widths.length ? `, at ${r.widths.join(" + ")}` : "";
  logInfo(`  ${r.level.padEnd(6)} ${c.locator}  (${c.tag}${c.type ? `[${c.type}]` : ""}, ${where}${at})`);
  logInfo(`         visible : ${JSON.stringify(c.visibleText)}`);
  logInfo(`         name    : ${JSON.stringify(r.name)}   [source=${r.source}, via=${c.nameSource}]`);
  logInfo(`         why     : ${r.reason}`);
  if (r.level === "FAIL" && r.candidates) {
    r.candidates.forEach((cand) => logInfo(`         tried   : ${JSON.stringify(cand)}`));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes("--all-rows");
  const page = args.find((a) => !a.startsWith("--"));
  if (!page) {
    logError(
      "Usage: node .claude/a11y/sr/label-in-name-audit.mjs <page> [--all-rows] " +
      "[--viewport=WxH] [--max-co-rendered=N]"
    );
    process.exit(1);
  }

  // Parsed before the browser launches, so a typo costs nothing.
  let maxCoRendered;
  try {
    maxCoRendered = parseMaxCoRendered(args);
  } catch (e) {
    logError(e.message);
    process.exit(1);
  }

  if (!(await isServerUp())) {
    logError(`Preview server not running at ${PREVIEW_BASE}. Start your preview server (previewBase in sr-config.json) and retry.`);
    process.exit(1);
  }

  const { executablePath, browser } = await launchBrowser();
  logInfo(`Label-in-Name audit (SC 2.5.3), headless chromium-${CONFIG.chromiumRevision}`);
  logInfo(`Browser (explicit): ${executablePath}`);

  let scan;
  try {
    scan = await scanUrl(browser, page);
  } catch (e) {
    logError(`\nError during scan: ${e.stack || e.message}`);
    await browser.close();
    process.exit(1);
  } finally {
    await browser.close();
  }

  const s = scan.stats;
  logInfo(`Page: ${scan.url}`);
  logInfo(
    `\nControls found: ${s.controls} (${s.rendered} rendered). Judged for 2.5.3: ${s.judged} ` +
    `— the rest have no comparable visible label text (icon-only or symbolic), so the ` +
    `criterion does not apply to them.`
  );

  const fails = scan.rows.filter((r) => r.level === "FAIL");
  const reviews = scan.rows.filter((r) => r.level === "REVIEW");

  logInfo(`\n=== FAIL — SC 2.5.3 (${fails.length}) ===`);
  if (fails.length === 0) logInfo("  none");
  fails.forEach(printRow);

  logInfo(`\n=== REVIEW — human judgement (${reviews.length}) ===`);
  if (reviews.length === 0) logInfo("  none");
  reviews.forEach(printRow);

  // A separate question from 2.5.3, so a separate section — never folded into the
  // FAIL/REVIEW counts above.
  const dups = scan.duplicateNames;
  const coRendered = dups.filter((g) => g.renderedCount > 1);
  logInfo(
    `\n=== REVIEW — ambiguous names: one name, several controls (${dups.length} group(s), ` +
    `${coRendered.length} with more than one rendered at once) ===`
  );
  if (dups.length === 0) logInfo("  none");
  const dupLimit = showAll ? dups.length : 12;
  dups.slice(0, dupLimit).forEach((g) => {
    logInfo(`  ${String(g.count).padStart(3)}x  ${JSON.stringify(g.name)}  (${g.renderedCount} rendered now)`);
    const shown = showAll ? g.members : g.members.slice(0, 6);
    shown.forEach((m) => logInfo(`         ${m.locator}${m.rendered ? "" : "  [not-rendered]"}`));
    if (g.members.length > shown.length) {
      logInfo(`         ...and ${g.members.length - shown.length} more (--all-rows to list)`);
    }
  });
  if (dups.length > dupLimit) {
    // Never truncate silently: say what was dropped.
    logInfo(`  ...and ${dups.length - dupLimit} further group(s) not shown — re-run with --all-rows.`);
  }
  if (dups.length > 0) {
    logInfo(
      `  These all PASS SC 2.5.3 — their names match their visible text. The problem is a ` +
      `different one: out of context a screen-reader or voice-input user cannot tell them ` +
      `apart. Fix by naming the object, e.g. "Download FastVLM 0.5B" — a .visually-hidden ` +
      `span inside the control keeps the visible label short and still satisfies 2.5.3, ` +
      `because the visible word stays contained in the name. Groups where only ONE is ` +
      `rendered are often mutually-exclusive copies and may be fine; judge, do not bulk-fix.`
    );
  }

  if (showAll) {
    const passes = scan.rows.filter((r) => r.level === "PASS");
    logInfo(`\n=== PASS (${passes.length}) ===`);
    passes.forEach(printRow);
  } else {
    logInfo(`\n(${s.passes} control(s) passed; re-run with --all-rows to list them.)`);
  }

  // The controls whose verdict CHANGES with width. Highest-signal output of the
  // multi-width scan: a fix here can be correct at one width and wrong at another.
  const divs = scan.divergences || [];
  logInfo(`\n=== VIEWPORT DIVERGENCES (${divs.length}) ===`);
  if (divs.length === 0) {
    logInfo("  none — every control was judged the same way at every width scanned");
  }
  divs.forEach((d) => {
    const skipped = d.skippedAt.length
      ? `  [no visible label at ${d.skippedAt.join(", ")}, so 2.5.3 did not apply there]`
      : "";
    logInfo(`  ${d.key}  ${d.levelsByWidth.join("  ")}${skipped}`);
    logInfo(`         visible : ${JSON.stringify(d.row.control.visibleText)}`);
    logInfo(`         name    : ${JSON.stringify(d.row.name)}`);
  });
  if (divs.length > 0) {
    logInfo(
      `  These controls change their visible label with viewport width — typically ` +
      `a stylesheet rule hides the text label below a breakpoint. Judge such a control at ` +
      `the width where it HAS visible text; a name that is fine icon-only can fail once ` +
      `the label appears.`
    );
  }

  // DOM churn is NOT a viewport effect and must not be presented as one. A media
  // query cannot remove a control from querySelectorAll's reach, so a control
  // missing at one width was simply not built yet when that width was scanned.
  const churn = scan.churn || [];
  if (churn.length > 0) {
    logWarn(
      `\n  Note: ${churn.length} control(s) were in the DOM at one width and not another. ` +
      `That is the page still building between scans, NOT a layout effect — a media ` +
      `query cannot hide a control from querySelectorAll. They were still judged ` +
      `wherever they existed. If this count is large or unstable between runs, raise ` +
      `the settle wait in scanUrl().`
    );
    churn.slice(0, 8).forEach((c) => logWarn(`      ${c.key} — present only at ${c.presentAt.join(", ")}`));
    if (churn.length > 8) logWarn(`      ...and ${churn.length - 8} more`);
  }

  // Instrument the precondition beside the result, so no number is read bare.
  logInfo(`\n--- name sources ---`);
  logInfo(
    `  viewports scanned                    : ` +
    `${(scan.viewports || []).map((v) => `${v.width}x${v.height}`).join(", ") || "(one, unrecorded)"}` +
    ` — a control FAILS if it fails at ANY of them`
  );
  logInfo(`  real accessibility-tree names probed : ${s.axProbed} (rendered controls, matched by id)`);
  logInfo(`  controls seen by CDP                 : ${s.axCdpControls} (in-page walk saw ${s.controls}; an app page mutates between the two, which is why matching is by id and not by order)`);
  logInfo(`  rendered controls with no id         : ${s.axRenderedWithoutId} (DOM-derived name; not matchable)`);
  logInfo(`  rendered ids CDP could not resolve   : ${s.axUnmatchedIds}`);
  if (!s.axAligned) {
    logWarn(`  CDP probe FAILED (${s.axError}), so EVERY name above is DOM-derived. Confirm in the accessibility tree before acting.`);
  }
  logInfo(
    `  AX-vs-DOM disagreements              : ${s.disagreements}` +
    (s.disagreements === 0
      ? " (the DOM-derived name matched the real one everywhere both existed)"
      : " — listed below; judge from the cases whether the unrendered rows can be trusted")
  );
  for (const d of scan.disagreementRows) {
    logInfo(`      ${d.locator} [via=${d.via}]  ax=${JSON.stringify(d.ax)}  dom=${JSON.stringify(d.dom)}`);
  }
  if (s.danglingLabelledby > 0) {
    logInfo(`  dangling aria-labelledby references  : ${s.danglingLabelledby} (separate defect; not 2.5.3)`);
  }

  logInfo(
    `\nHonesty: this checks SC 2.5.3 containment, flags aria-label overrides, and lists ` +
    `names shared by more than one control. Only the FAIL rows are 2.5.3; the ambiguous-name ` +
    `list is adjacent evidence for button/link purpose (2.4.6 / 2.4.4) and is a human call. It is ` +
    `NOT a name/role audit (use /a11y-sr), NOT a conformance statement, and REVIEW rows ` +
    `are judgement calls for a human. Unrendered controls are named from the DOM, not ` +
    `from the browser's accessibility tree — see the name-sources block above.`
  );
  logInfo(
    `Deliberate leniency: a label element often holds a title AND a description, so a ` +
    `control passes if ANY plausible label text is contained in the name. That avoids ` +
    `failing correctly-authored controls, at the cost of passing a name that matches only ` +
    `part of a compound label. REVIEW rows are where that leniency is most worth reading.`
  );
  // The opt-in 2.4.6 gate. Reported separately from the 2.5.3 verdict and never
  // folded into it — they are different criteria and a reader must be able to
  // tell which one reddened the run.
  const gate = evaluateCoRenderedGate(dups, maxCoRendered);
  if (gate.enabled) {
    logInfo(
      `\n=== GATE — co-rendered ambiguous names: ${gate.count} (allowed ${gate.max}) — ` +
      `${gate.breached ? "BREACHED" : "ok"} ===`
    );
    if (gate.breached) {
      gate.offending.forEach((g) =>
        logInfo(`  ${String(g.renderedCount).padStart(3)} rendered together  ${JSON.stringify(g.name)}`)
      );
      logInfo(
        `  This is SC 2.4.6 / 2.4.4 (button and link purpose), NOT an SC 2.5.3 failure — ` +
        `the names above match their visible text perfectly. Fix by naming the object each ` +
        `control acts on. Note the TOTAL group count (${dups.length}) is deliberately not ` +
        `gated: groups with one member rendered are usually mutually-exclusive copies.`
      );
    }
  }

  process.exit(fails.length === 0 && !gate.breached ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    logError(`Unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  });
}
