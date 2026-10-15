---
name: a11y-report
description: "House rules for writing an accessibility report or issue register: the four-level severity classification, fix-priority ordering, the required content of a finding, and a mechanical style checker. Load this whenever you write or edit an accessibility findings document, issue register, audit report, triage list, or Jira comment set reporting accessibility results, whether or not the user names the skill. It composes with accessibility-advocate-style, which it requires."
---

# Writing an accessibility report

A report is read by people who did not do the testing and will not repeat it. It has to
survive being pasted into Jira, converted to Word, forwarded to a supplier, and quoted back
at you in a meeting six weeks later.

**Load `accessibility-advocate-style` first.** This skill adds what that one does not cover:
severity, priority, the required parts of a finding, and a checker. It does not restate the
voice, British English, disability-language or AI-tell rules, which live there and belong
only there.

## The pipeline, in order

1. **Load `accessibility-advocate-style`.** Its own description tells you to prefer it for
   substantial written content even unprompted. Reports qualify.
2. **Write the report** to the structure below.
3. **Run the checker**: `node .claude/skills/a11y-report/check-report-style.mjs <file>`.
4. **Fix every BLOCK.** Justify or fix every WARN. Do not ship with unexamined hits.

The checker finds signatures, never defects. A hit is a line to look at.

## Hard rules

### No emoji, and no unicode icons

**Never use emoji or pictographic characters in an accessibility report.** No warning signs,
no ticks, no crosses, no arrows.

The reason is specific to this document type. Screen readers announce these characters, so a
report peppered with warning signs reads aloud as "warning sign" before every caution. Your
report is going to be read by the accessibility team at the receiving organisation, and some
of them use a screen reader. **A document that argues for accessible content while being
tiring to listen to loses the argument in the first paragraph.**

They also convert unpredictably into Word, Jira and email, and they do not translate.

**Signal a caution with words instead**, which survives every one of those journeys:

```
Bad:   ⚠️ The count is a ceiling, not a total.
Good:  **Warning: the count is a ceiling, not a total.**
Good:  Use a heading: "What this figure does not tell you".
```

### No arrows. Write the relationship.

`→` is unicode decoration and gets announced as "rightwards arrow", or as nothing at all.

```
Bad:   Moderate → Serious
Good:  raised from Moderate to Serious

Bad:   scrollWidth → 2117
Good:  scrollWidth returns 2117
```

Where a command and its result belong together, put both inside one fenced code block. The
checker ignores fenced blocks, because their contents are evidence rather than prose.

### Use the four severity labels and no synonyms

**Critical, Serious, Moderate, Minor.** Never `blocker`, `P1`, `sev 2` or `high severity`.

*(Those terms are in code spans deliberately. The checker excludes code, so a document can
name what it forbids without flagging itself.)*

The full classification, the two judgements it turns on, and the decision procedure are in
[`references/severity-classification.md`](references/severity-classification.md). Read it
before grading anything; the two judgements do all the work and both get challenged.

### Every finding carries six things

Omit any one and the reader cannot act:

1. **What it is**, in a sentence, with enough context to stand alone.
2. **The WCAG criterion and level**, or an explicit statement that it fails none.
3. **The severity**, using the four labels.
4. **Where it occurs**: which pages, how many of how many.
5. **Evidence**: the measurement, or the markup, in a fenced block.
6. **A suggested fix**, concrete enough to act on.

### Separate accessibility issues from functional defects

A functional bug that affects everybody equally is not an accessibility issue, even when you
found it during an accessibility review. **Put those in their own clearly-labelled section.**

Presenting a functional bug as a WCAG failure invites the reader to check, find the content
perfectly reachable, and discount the findings that genuinely are conformance issues. You
lose more than you gain.

### State what you checked and found clean

A report listing only failures reads as a complete picture and is not one. **Record the
checks that came back clean**, especially the ones a reader would otherwise re-run, and the
negative results that stop somebody re-opening a closed question.

### State what you did not test

Scope, coverage, and any scenario you could not exercise. **Say why**, and say what would
unblock it.

### Lead with the headline, including good news

If nothing is Critical, say so in the first screen. A long list reads worse than it is, and
the reader forms their impression before they reach your qualifications.

## Structure

Adapt the order, keep the parts:

1. **What this is**: scope, dates, what was tested, how much.
2. **The severity classification used**, so grades can be checked rather than trusted.
3. **The headline**: the single most important fact, good or bad.
4. **Findings in fix-priority order**, with a summary table first and detail after.
5. **Recorded but not accessibility issues.**
6. **Checked, with no finding.**
7. **Not tested.**
8. **A closing honesty line**: a clean automated result is not conformance.

## Fix priority is not severity

**Priority blends severity, then breadth, then cost of fix.** A Moderate issue fixed by two
attributes on every page outranks an expensive one at the same grade.

Say which blend you used, and **never let a Serious row sit below a run of Moderate ones**
without explaining why. If you cannot explain it, re-rank.

**Call out where one fix closes several findings.** It changes what the team schedules, and
it is the single most useful thing a register can tell them.

## Self-check before you finish

1. `accessibility-advocate-style` was loaded before writing.
2. The checker runs with zero BLOCK hits.
3. Every finding carries all six required parts.
4. Severities use only the four labels.
5. Functional defects sit in their own section.
6. Clean checks and untested scope are both recorded.
7. The headline is in the first screen.
8. Priority order is explained, and no Serious row sits below Moderate ones unexplained.

## The checker

```bash
node .claude/skills/a11y-report/check-report-style.mjs docs/my-report.md
node .claude/skills/a11y-report/check-report-style.mjs --json docs/*.md
```

**Proof:** `node .claude/skills/a11y-report/prove-check-report-style.mjs` runs the fixture
rows: text the checker must flag (DENY) and text it must leave alone (ALLOW). It refuses to
report success if either side is empty, because a checker that flags everything is as
useless as one that flags nothing.

**Two of its rows bind defects the checker shipped with**, found on its first real run and
kept so they cannot return silently: arrows were counted twice, once as an arrow and once as
an emoji; and a warning sign followed by a variation selector counted as two hits rather
than one. It also flagged "a trivial template edit" as an off-scale severity grade, so
"trivial" and "cosmetic" were removed from that pattern as ordinary adjectives.

**Known limits, stated so nobody over-trusts it:**

- It cannot tell a curly quote you typed from one inside quoted page content outside a code
  fence. Curly quotes are WARN for that reason.
- Bold-first bullets are a tell only when repeated. One is fine; eighteen is the signal.
- It reads Markdown. It knows nothing about the Word version, so re-check after conversion.
- A clean checker run says the prose is tidy. It says nothing about whether the findings are
  right, and a clean automated audit is not WCAG conformance.
