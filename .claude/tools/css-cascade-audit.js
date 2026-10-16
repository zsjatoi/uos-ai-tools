/**
 * CSS cascade and focus-indicator diagnostics.
 *
 * Paste this whole file into a browser console on any page, or inject it with
 * a browser tool's evaluate function. It defines four globals:
 *
 *   window.auditCascade(selector, pseudo)
 *     Which rule wins for each property on this element? Builds a static
 *     cascade model from the live CSSOM: every matching rule in
 *     !important -> specificity -> document-order sequence, with its source
 *     stylesheet and whether it is active for the current media. Prints the
 *     computed value alongside as ground truth.
 *
 *   window.auditCascadeRoot(selector, root, pseudo)
 *     Every declaration touching one shorthand root (for example "outline"),
 *     in cascade order.
 *
 *   window.verifyCascadeWinner(selector, property, pseudo)
 *     The discriminating test. Temporarily removes the predicted winning
 *     declaration from the live CSSOM, re-reads the computed value, and
 *     restores it. If the computed value does not move, the prediction was
 *     wrong or another rule declares the same value.
 *
 *   await window.auditFocusIndicator(selector)
 *     Asserts :focus-visible rather than assuming it, waits for transitions
 *     to settle, and reports indicator contrast.
 *
 * HONESTY BOUNDARY. auditCascade is a model, not proof: the specificity
 * calculation is approximate (no :is() / :where() weighting) and shorthand
 * versus longhand precedence is shown, not resolved. Anything marginal must go
 * through verifyCascadeWinner. None of this is WCAG conformance.
 *
 * Nothing on disk is touched. Reload the page to discard any state.
 */
(function () {
  "use strict";

  // Pseudo-classes that depend on transient element state. These are stripped
  // before element.matches(), otherwise a rule that only applies while focused
  // or hovered would never be reported as matching.
  const STATEFUL_PSEUDO = Object.freeze([
    ":focus-within",
    ":focus-visible",
    ":focus",
    ":hover",
    ":active",
    ":target",
    ":visited",
    ":link",
  ]);

  // Shorthand roots used to group related declarations.
  const PROPERTY_ROOTS = Object.freeze([
    "outline",
    "border",
    "background",
    "box-shadow",
    "font",
    "margin",
    "padding",
    "transition",
  ]);

  // Settle polling, for properties that sit under a CSS transition.
  const SETTLE_POLL_MS = 100;
  const SETTLE_MAX_POLLS = 40;
  const SETTLE_STABLE_READS = 2;

  // Computed properties reported for a focus indicator, in reading order.
  const FOCUS_REPORT_KEYS = Object.freeze([
    "outline",
    "outlineStyle",
    "outlineWidth",
    "outlineColor",
    "outlineOffset",
    "boxShadow",
    "backgroundColor",
    "color",
    "border",
  ]);

  // SC 1.4.11 non-text contrast minimum, for labelling only. Not a verdict.
  const NON_TEXT_CONTRAST_MINIMUM = 3;

  const VERDICT = Object.freeze({
    CONFIRMED: "CONFIRMED: removing this declaration changed the computed value",
    NOT_CONFIRMED:
      "NOT CONFIRMED: computed value unchanged; another rule declares the same value, or the prediction is wrong",
    AMBIGUOUS:
      "AMBIGUOUS: top two candidates declare the same value; the computed value is evidence for neither",
  });

  const logError = (message, ...args) => console.error(message, ...args);
  const logWarn = (message, ...args) => console.warn(message, ...args);
  const logInfo = (message, ...args) => console.log(message, ...args);

  // ---------------------------------------------------------------
  // Selector analysis
  // ---------------------------------------------------------------

  // Approximate specificity as an (a,b,c) triple. :is() / :where() / :has()
  // weighting is not modelled, and arguments inside functional pseudo-classes
  // are counted naively.
  function specificityOf(selector) {
    let rest = selector;

    const ids = (rest.match(/#[\w-]+/g) || []).length;
    const pseudoElements = (rest.match(/::[\w-]+/g) || []).length;

    // Remove pseudo-elements first so their double colons are not later
    // miscounted as pseudo-classes.
    rest = rest.replace(/::[\w-]+/g, " ");

    const classes = (rest.match(/\.[\w-]+/g) || []).length;
    const attributes = (rest.match(/\[[^\]]*\]/g) || []).length;
    const pseudoClasses = (rest.match(/:[\w-]+/g) || []).length;

    // Whatever survives stripping the above is an element/type selector.
    const elements = (
      rest
        .replace(/#[\w-]+/g, " ")
        .replace(/\.[\w-]+/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/:[\w-]+(\([^)]*\))?/g, " ")
        .match(/\b[a-zA-Z][\w-]*\b/g) || []
    ).length;

    return {
      a: ids,
      b: classes + attributes + pseudoClasses,
      c: elements + pseudoElements,
    };
  }

  // Negative if x is less specific than y, positive if more.
  function compareSpecificity(x, y) {
    if (x.a !== y.a) return x.a - y.a;
    if (x.b !== y.b) return x.b - y.b;
    return x.c - y.c;
  }

  function formatSpecificity(spec) {
    return `${spec.a},${spec.b},${spec.c}`;
  }

  // Split a selector into the stateful pseudo-classes it requires and the
  // remainder that can be tested with element.matches().
  function splitStatefulPseudo(selector) {
    const requiredStates = [];
    let testable = selector;

    for (const pseudo of STATEFUL_PSEUDO) {
      // The trailing boundary matters so ":focus" does not eat ":focus-visible".
      const pattern = new RegExp(pseudo.replace(/[:]/g, "\\$&") + "(?![\\w-])", "g");
      if (pattern.test(testable)) {
        requiredStates.push(pseudo);
        testable = testable.replace(pattern, "");
      }
    }

    return { testable: testable.trim(), requiredStates };
  }

  function elementMatchesSafely(element, selector) {
    if (!selector) return true;
    try {
      return element.matches(selector);
    } catch (error) {
      return false;
    }
  }

  // ---------------------------------------------------------------
  // CSSOM walking
  // ---------------------------------------------------------------

  // An empty or absent media condition is always active.
  function mediaActive(mediaText) {
    if (!mediaText || mediaText === "all") return true;
    try {
      return window.matchMedia(mediaText).matches;
    } catch (error) {
      logWarn(`could not evaluate media "${mediaText}"`, error);
      return true;
    }
  }

  function sheetLabel(sheet) {
    if (!sheet) return "unknown";
    return sheet.href ? sheet.href.split("/").pop() : "inline";
  }

  // Walk every stylesheet in document order, invoking the visitor for each
  // CSSStyleRule with its enclosing conditions and a monotonic document-order
  // index (the cascade's final tie-break).
  //
  // Stylesheets that depend on prefers-color-scheme can expose readable
  // cssRules even when their media does not match, so rules are reported with
  // an explicit active flag rather than silently included.
  function walkStyleRules(visitor) {
    let orderIndex = 0;

    for (const sheet of Array.from(document.styleSheets)) {
      let topLevelRules;
      try {
        topLevelRules = Array.from(sheet.cssRules);
      } catch (error) {
        // Cross-origin stylesheet: cssRules access throws. Report and skip.
        logWarn(`cannot read rules from ${sheetLabel(sheet)} (cross-origin?)`, error);
        continue;
      }

      const sheetMedia = sheet.media ? sheet.media.mediaText : "";
      const sheetActive = !sheet.disabled && mediaActive(sheetMedia);

      const descend = (rules, conditions, conditionsActive) => {
        for (const rule of rules) {
          // Style rules MUST be tested before group rules. Since CSS nesting
          // landed, a CSSStyleRule also exposes a (usually empty) cssRules
          // list, so "has cssRules" no longer identifies a group rule.
          // Testing that first silently skips every style rule in the page.
          if (typeof rule.selectorText === "string") {
            visitor(rule, {
              sheet: sheetLabel(sheet),
              sheetMedia,
              conditions,
              active: sheetActive && conditionsActive,
              orderIndex: orderIndex++,
            });

            // Nested rules use relative "&" selectors, which element.matches()
            // cannot evaluate; the matcher's try/catch skips them rather than
            // mis-attributing them.
            if (rule.cssRules && rule.cssRules.length) {
              descend(Array.from(rule.cssRules), conditions, conditionsActive);
            }
            continue;
          }

          // Conditional group rule (@media / @supports / @layer): recurse,
          // tracking whether its condition currently holds.
          if (rule.cssRules) {
            const condition =
              rule.conditionText || (rule.media && rule.media.mediaText) || "";
            const isSupports =
              typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule;

            let holds = true;
            if (isSupports) {
              try {
                holds = CSS.supports(condition);
              } catch (error) {
                logWarn(`could not evaluate @supports (${condition})`, error);
              }
            } else if (condition) {
              holds = mediaActive(condition);
            }

            descend(
              Array.from(rule.cssRules),
              condition ? conditions.concat(condition) : conditions,
              conditionsActive && holds,
            );
          }
        }
      };

      descend(topLevelRules, [], true);
    }
  }

  // ---------------------------------------------------------------
  // auditCascade
  // ---------------------------------------------------------------

  function resolveElement(target) {
    if (target instanceof Element) return target;
    if (typeof target === "string") return document.querySelector(target);
    return null;
  }

  function rootOf(property) {
    for (const root of PROPERTY_ROOTS) {
      if (property === root || property.startsWith(root + "-")) return root;
    }
    return property;
  }

  // Collect every declaration that reaches an element, ranked by the cascade.
  //
  // target: selector or element.
  // pseudo: a stateful pseudo-class to treat as satisfied, for example
  //   ":focus-visible". Rules requiring other states are excluded unless the
  //   element genuinely matches them right now.
  // Returns the audit object, or null if the element was not found.
  function auditCascade(target, pseudo) {
    const element = resolveElement(target);
    if (!element) {
      logError(`auditCascade: no element for ${String(target)}`);
      return null;
    }

    const assumedState = pseudo || null;
    const declarations = [];

    walkStyleRules((rule, context) => {
      for (const part of rule.selectorText.split(",")) {
        const selector = part.trim();
        if (!selector) continue;

        // A pseudo-element rule (::before, ::marker, ...) styles a generated
        // box, not this element. Stripping the pseudo-element would wrongly
        // attribute its declarations to the element itself.
        if (selector.includes("::")) continue;

        const { testable, requiredStates } = splitStatefulPseudo(selector);
        if (!elementMatchesSafely(element, testable)) continue;

        // A required state counts as satisfied if the caller asked us to assume
        // it, or if the element actually matches it at this moment.
        const statesSatisfied = requiredStates.every(
          (state) => state === assumedState || elementMatchesSafely(element, state),
        );
        if (!statesSatisfied) continue;

        const specificity = specificityOf(selector);

        for (const property of Array.from(rule.style)) {
          declarations.push({
            property,
            root: rootOf(property),
            value: rule.style.getPropertyValue(property),
            important: rule.style.getPropertyPriority(property) === "important",
            selector,
            requiredStates,
            source: context.sheet,
            media: context.sheetMedia || context.conditions.join(" and ") || "",
            active: context.active,
            specificity,
            orderIndex: context.orderIndex,
          });
        }
        // One matching selector part per rule is enough; further parts of the
        // same rule contribute identical declarations.
        break;
      }
    });

    // Cascade order within equal origin: !important, then specificity, then
    // document order. Highest first.
    const rank = (x, y) => {
      if (x.important !== y.important) return x.important ? -1 : 1;
      const bySpecificity = compareSpecificity(y.specificity, x.specificity);
      if (bySpecificity !== 0) return bySpecificity;
      return y.orderIndex - x.orderIndex;
    };

    const computed = getComputedStyle(element);
    const byProperty = new Map();

    for (const declaration of declarations) {
      if (!declaration.active) continue;
      const list = byProperty.get(declaration.property) || [];
      list.push(declaration);
      byProperty.set(declaration.property, list);
    }

    const properties = {};
    for (const [property, list] of byProperty) {
      list.sort(rank);
      const [winner, runnerUp] = list;

      properties[property] = {
        computed: computed.getPropertyValue(property),
        predictedWinner: {
          value: winner.value,
          important: winner.important,
          source: winner.source,
          selector: winner.selector,
          specificity: formatSpecificity(winner.specificity),
        },
        // Two authored values being byte-identical is a reliable signal,
        // unlike comparing an authored value to a serialised computed one.
        ambiguous: Boolean(
          runnerUp && runnerUp.value === winner.value && runnerUp.important === winner.important,
        ),
        candidates: list,
      };
    }

    const audit = {
      element: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : ""),
      assumedState,
      matchesAssumedState: assumedState ? elementMatchesSafely(element, assumedState) : null,
      properties,
      inactiveRuleCount: declarations.filter((d) => !d.active).length,
      note:
        "Static cascade model. Specificity is approximate; shorthand vs longhand is shown, not resolved. " +
        "Confirm anything marginal with window.verifyCascadeWinner(selector, property, pseudo).",
    };

    logInfo(audit.note);
    if (assumedState && audit.matchesAssumedState === false) {
      logWarn(
        `auditCascade: element does NOT currently match ${assumedState}; ` +
          `rules requiring it are included on your instruction, but the computed ` +
          `values shown are for the element's ACTUAL state.`,
      );
    }

    console.table(
      Object.entries(properties).map(([property, detail]) => ({
        property,
        computed: detail.computed,
        predicted: detail.predictedWinner.value,
        important: detail.predictedWinner.important,
        wonBy: detail.predictedWinner.source,
        specificity: detail.predictedWinner.specificity,
        others: detail.candidates.length - 1,
        ambiguous: detail.ambiguous || "",
      })),
    );

    return audit;
  }

  // Show every declaration touching a shorthand root (for example "outline"),
  // in cascade order, so shorthand/longhand interaction is visible.
  function auditCascadeRoot(target, root, pseudo) {
    const audit = auditCascade(target, pseudo);
    if (!audit) return null;

    const rows = [];
    for (const [property, detail] of Object.entries(audit.properties)) {
      if (rootOf(property) !== root) continue;
      for (const candidate of detail.candidates) {
        rows.push({
          property,
          value: candidate.value,
          important: candidate.important,
          source: candidate.source,
          selector: candidate.selector,
          specificity: formatSpecificity(candidate.specificity),
          media: candidate.media,
        });
      }
    }

    console.table(rows);
    return rows;
  }

  // ---------------------------------------------------------------
  // verifyCascadeWinner: the discriminating test
  // ---------------------------------------------------------------

  // Disable-and-remeasure. Removes the predicted winning declaration from the
  // live CSSOM, re-reads the computed value, then restores it. A computed value
  // alone cannot tell you which of two rules declaring the same value won; this
  // can. The restore runs in a finally block, so a throw cannot leave the page
  // mutated.
  //
  // property: exact property name, for example "outline-style".
  function verifyCascadeWinner(target, property, pseudo) {
    const element = resolveElement(target);
    if (!element) {
      logError(`verifyCascadeWinner: no element for ${String(target)}`);
      return null;
    }

    const audit = auditCascade(target, pseudo);
    const detail = audit && audit.properties[property];
    if (!detail) {
      logError(
        `verifyCascadeWinner: no active rule declares "${property}" on this element. ` +
          `Check the exact property name (longhand vs shorthand).`,
      );
      return null;
    }

    // Re-locate the winning rule object in the CSSOM.
    const winner = detail.candidates[0];
    let winningRule = null;
    walkStyleRules((rule, context) => {
      if (winningRule) return;
      if (context.orderIndex !== winner.orderIndex) return;
      winningRule = rule;
    });

    if (!winningRule) {
      logError("verifyCascadeWinner: could not re-locate the winning rule");
      return null;
    }

    const before = getComputedStyle(element).getPropertyValue(property);
    const savedValue = winningRule.style.getPropertyValue(property);
    const savedPriority = winningRule.style.getPropertyPriority(property);

    let after;
    try {
      winningRule.style.removeProperty(property);
      after = getComputedStyle(element).getPropertyValue(property);
    } finally {
      winningRule.style.setProperty(property, savedValue, savedPriority);
    }

    const restored = getComputedStyle(element).getPropertyValue(property);
    const changed = after !== before;

    const result = {
      property,
      predictedWinner: `${winner.source} { ${winner.selector} }`,
      computedBefore: before,
      computedWithWinnerRemoved: after,
      computedAfterRestore: restored,
      changed,
      verdict: detail.ambiguous
        ? VERDICT.AMBIGUOUS
        : changed
          ? VERDICT.CONFIRMED
          : VERDICT.NOT_CONFIRMED,
      restoredCleanly: restored === before,
      fallbackWinner: changed ? describeFallback(detail, after) : null,
    };

    if (!result.restoredCleanly) {
      logError(
        "verifyCascadeWinner: the CSSOM did not restore to its original value. " +
          "Reload the page before trusting further measurements.",
      );
    }

    console.table([result]);
    return result;
  }

  // Which remaining candidate explains the value once the winner is removed?
  function describeFallback(detail, valueAfterRemoval) {
    const next = detail.candidates
      .slice(1)
      .find((candidate) => candidate.value === valueAfterRemoval);
    return next
      ? `${next.source} { ${next.selector} }`
      : "no candidate matches; likely a user-agent or initial value";
  }

  // ---------------------------------------------------------------
  // auditFocusIndicator
  // ---------------------------------------------------------------

  function readFocusStyles(element) {
    const style = getComputedStyle(element);
    const snapshot = {};
    for (const key of FOCUS_REPORT_KEYS) snapshot[key] = style[key];
    return snapshot;
  }

  // Poll until two consecutive identical reads. A single read right after
  // focusing can return a mid-transition frame. The iteration count is returned
  // so a throttled page (one whose animation frames are not running because it
  // is backgrounded) is visible in the output rather than silently yielding a
  // part-way value.
  async function settle(element) {
    let previous = null;
    let stableReads = 0;
    let snapshot = readFocusStyles(element);

    for (let iteration = 1; iteration <= SETTLE_MAX_POLLS; iteration++) {
      snapshot = readFocusStyles(element);
      const key = JSON.stringify(snapshot);

      if (key === previous) {
        stableReads++;
        if (stableReads >= SETTLE_STABLE_READS) {
          return { snapshot, iterations: iteration, settled: true };
        }
      } else {
        stableReads = 0;
        previous = key;
      }

      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }

    logWarn(
      "auditFocusIndicator: values never stabilised. If the page is not in the " +
        "foreground its transitions may be frozen. Bring the tab to the front and retry.",
    );
    return { snapshot, iterations: SETTLE_MAX_POLLS, settled: false };
  }

  // First rgb()/rgba() triple in a computed value. Returns null rather than a
  // partial object so the caller can report "not calculated" instead of
  // quietly producing NaN.
  function parseRgb(value) {
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value || "");
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }

  // Alpha channel of a computed colour; opaque when no alpha is present.
  function alphaOf(value) {
    const match = /rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(value || "");
    return match ? Number(match[1]) : 1;
  }

  // Nearest ancestor background that actually paints. A transparent element
  // shows whatever is behind it, so contrast must be measured against that,
  // not against rgba(0,0,0,0), which would otherwise parse as black and
  // produce a confidently wrong ratio.
  function opaqueBackgroundFrom(startElement) {
    let element = startElement;

    while (element) {
      const background = getComputedStyle(element).backgroundColor;
      if (parseRgb(background) && alphaOf(background) > 0) {
        const label =
          element === startElement
            ? "self"
            : element.tagName.toLowerCase() +
              (element.id ? `#${element.id}` : "");
        return { colour: background, from: label };
      }
      element = element.parentElement;
    }

    return { colour: "rgb(255, 255, 255)", from: "assumed canvas" };
  }

  // WCAG 2 relative luminance.
  function relativeLuminance(rgb) {
    const toLinear = (channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  }

  // Contrast ratio between two computed colours, or null if either cannot be
  // parsed.
  function contrastBetween(colourA, colourB) {
    const rgbA = parseRgb(colourA);
    const rgbB = parseRgb(colourB);
    if (!rgbA || !rgbB) return null;

    const [lighter, darker] = [relativeLuminance(rgbA), relativeLuminance(rgbB)].sort(
      (x, y) => y - x,
    );
    const ratio = (lighter + 0.05) / (darker + 0.05);
    if (!Number.isFinite(ratio)) return null;
    return Math.round(ratio * 100) / 100;
  }

  // Report an element's focus indicator: computed styles focused and
  // unfocused, plus the contrast of the indicator against the colour it sits
  // on. Requires the element to already be focused via the keyboard.
  //
  // NOT a conformance result. Which colours count as "adjacent" for SC 1.4.11
  // is a judgement call, and forced-colors is not covered here.
  async function auditFocusIndicator(target) {
    const element = resolveElement(target);
    if (!element) {
      logError(`auditFocusIndicator: no element for ${String(target)}`);
      return null;
    }

    // Assert, never assume. A bare programmatic .focus() does not always match
    // :focus-visible; it depends on the last real interaction.
    const isActive = document.activeElement === element;
    const focusVisible = elementMatchesSafely(element, ":focus-visible");

    if (!isActive || !focusVisible) {
      logError(
        `auditFocusIndicator: element is not keyboard-focused ` +
          `(activeElement=${isActive}, :focus-visible=${focusVisible}). ` +
          `Tab to it first, then re-run. Refusing to report focus styles.`,
      );
      return {
        element: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : ""),
        aborted: true,
        isActiveElement: isActive,
        focusVisible,
      };
    }

    const { snapshot, iterations, settled } = await settle(element);

    // Unfocused baseline: read a clone so the real element keeps focus.
    const clone = element.cloneNode(true);
    clone.removeAttribute("id");
    element.parentNode.insertBefore(clone, element);
    const unfocused = readFocusStyles(clone);
    clone.remove();

    const outlineVisible = snapshot.outlineStyle !== "none" && parseFloat(snapshot.outlineWidth) > 0;
    const shadowVisible = Boolean(snapshot.boxShadow && snapshot.boxShadow !== "none");
    const shadowInset = shadowVisible && snapshot.boxShadow.includes("inset");
    const shadowColour = parseRgb(snapshot.boxShadow) ? snapshot.boxShadow : null;

    // An OUTER indicator (outline, outset shadow) is judged against the colour
    // it sits on: the surrounding surface, not the element's own fill. An
    // INSET ring is judged against the fill it is drawn over. Comparing an
    // outset glow to the button's own background produces a meaninglessly low
    // number, so both surfaces are resolved and reported separately.
    const ownFill = opaqueBackgroundFrom(element);
    const surroundings = opaqueBackgroundFrom(element.parentElement);

    const report = {
      element: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : ""),
      focusVisible: true,
      hover: elementMatchesSafely(element, ":hover"),
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      settleIterations: iterations,
      settled,
      focused: snapshot,
      unfocused,
      surfaces: {
        ownFill: ownFill.colour,
        ownFillFrom: ownFill.from,
        surroundings: surroundings.colour,
        surroundingsFrom: surroundings.from,
      },
      indicator: {
        outlineRendering: outlineVisible,
        boxShadowRendering: shadowVisible,
        boxShadowInset: shadowInset,
        // Outline is always outside the border box.
        outlineContrastVsSurroundings: outlineVisible
          ? contrastBetween(snapshot.outlineColor, surroundings.colour)
          : null,
        // Judge the shadow against whichever surface it is actually drawn on.
        boxShadowContrast: shadowVisible
          ? contrastBetween(shadowColour, shadowInset ? ownFill.colour : surroundings.colour)
          : null,
        boxShadowJudgedAgainst: shadowVisible
          ? shadowInset
            ? "own fill (inset)"
            : "surrounding surface (outset)"
          : null,
        fillChanged: unfocused.backgroundColor !== snapshot.backgroundColor,
      },
      note:
        `Outer indicators are compared with the nearest opaque ancestor background; ` +
        `inset ones with the element's own fill. SC 1.4.11 wants at least ` +
        `${NON_TEXT_CONTRAST_MINIMUM}:1 against ADJACENT colours; confirm the surface chosen here is the ` +
        `one you mean. box-shadow is dropped under forced-colors, which this does not test. Not conformance.`,
    };

    logInfo(report.note);
    console.table({
      "focus-visible asserted": report.focusVisible,
      "settle iterations": `${iterations}${settled ? "" : " (NOT SETTLED)"}`,
      "prefers dark": report.prefersDark,
      "outline rendering": outlineVisible,
      "box-shadow rendering": shadowVisible,
      "fill inverts on focus": report.indicator.fillChanged,
      "outline contrast": report.indicator.outlineContrastVsSurroundings,
      "box-shadow contrast": report.indicator.boxShadowContrast,
      "shadow judged against": report.indicator.boxShadowJudgedAgainst,
      "surrounding surface": `${surroundings.colour} (${surroundings.from})`,
    });

    return report;
  }

  window.CSSCascadeAudit = {
    auditCascade,
    auditCascadeRoot,
    verifyCascadeWinner,
    auditFocusIndicator,
    specificityOf,
  };
  window.auditCascade = auditCascade;
  window.auditCascadeRoot = auditCascadeRoot;
  window.verifyCascadeWinner = verifyCascadeWinner;
  window.auditFocusIndicator = auditFocusIndicator;
})();
