# Severity classification

A four-level scheme. Use these labels and no synonyms.

| | Definition |
| --- | --- |
| **1. Critical** | Blocks at least one disability group from completing a **core business function** entirely. Test: if all users faced this barrier, would you classify it as a critical bug? |
| **2. Serious** | A core business function can only be completed with an **unacceptable workaround**, OR the issue blocks use of **non-essential** functionality entirely. |
| **3. Moderate** | Affects **non-essential** functionality but has an **acceptable workaround**. |
| **4. Minor** | Distracting or annoying but does not block functionality. |

**The scale measures human cost, not technical wrongness.** It asks what this stops someone
doing and how hard it is to work around. That is why a Level A conformance failure can sit at
Minor, and something failing no criterion at all can sit at Moderate.

## Everything turns on two judgements

Both get challenged. Write down how you answered each, in the report, for any grade that is
not obvious.

### 1. Is the affected functionality core or non-essential?

**Core means the thing the product exists for.** Derive the core functions from the
requirements themselves rather than inventing them. On a scholarships site they came straight
from the tickets' own "As a prospective student, I want..." lines: find a scholarship, work
out whether you are eligible, find out how to apply.

Everything else is non-essential. **Non-essential does not mean unimportant.** It means a
user who cannot use it can still do what they came to do.

### 2. Is the workaround acceptable or unacceptable?

This does most of the work.

**Acceptable:** a route a competent user of that assistive technology would take anyway, at
comparable cost. Reaching a section by heading navigation instead of a landmark. Pressing
`Ctrl+Home` instead of using a back-to-top button.

**Unacceptable:** it costs disproportionately more than the intended route, or the user has
no way of knowing it exists. Arrowing through 250 country names because nothing signalled the
list was collapsed.

Same page, same user, two very different costs.

## The decision procedure

Take the first level that fits.

1. Is a core function impossible for some group? **Critical.**
2. Is a core function possible only via an unacceptable workaround? **Serious.**
3. Is non-essential functionality entirely unusable for some group? **Serious.**
4. Is non-essential functionality affected, with an acceptable workaround? **Moderate.**
5. Otherwise, noise, duplication, non-semantic markup, inconsistency: **Minor.**

Steps 2 and 3 both land on Serious deliberately. A total block on something small and a
painful barrier on something big both deserve the next sprint.

## The "if all users faced this" test

**Critical carries a sanity check the other levels do not.** It exists to stop severity
inflation, which is the standing pressure on anyone grading accessibility defects: the
consequence feels serious, so everything drifts upward, and a register where everything is
Critical schedules nothing.

Worked example. A collapsed list of 250 countries is fully readable to a screen reader, under
a button that gives no state and produces no perceivable change. Now ask the test: if every
user saw 250 country names permanently expanded under a button that appeared to do nothing,
would the release stop? No. It is a bad bug and an embarrassing one. **Serious, not Critical**,
even though it was the first thing we would fix.

## Show your borderline calls

**Put the arguable grades in a table with their counter-arguments.** Three or four is usually
the right number. It converts an argument in a meeting into a decision the reader can
overrule on the spot, and it stops the register looking falsely confident.

| Issue | Call | Why, and the counter-argument |
| --- | --- | --- |
| Collapsed list read out in full | Serious | Eligibility is core and can still be established. Unacceptable workaround, not a block. Counter-argument for Critical: with no signal a collapse exists, many users would give up before item 250. We judged "would give up" a usability prediction, not a measured block. |
| Back-to-top button with no name | Moderate | The second Serious limb fits, since the button is entirely unusable to a screen-reader user. But `Ctrl+Home` achieves the same outcome and is standard, which is the Moderate test. We took Moderate and raised its fix priority instead, because the fix is two attributes. |

## Two things severity is not

### Not the WCAG level

Independent axes. A register can hold a Level A failure rated Minor and a Moderate row that
fails no criterion at all. **A criterion tells you whether it conforms; the severity tells
you how much it hurts.** Report both columns. Neither can be derived from the other.

Watch for criteria that have moved. SC 4.1.1 Parsing was **removed in WCAG 2.2**, so
duplicate IDs no longer fail it. Record such an issue as a defect with no criterion rather
than citing a criterion that no longer exists.

### Not fix priority

Priority blends severity, then how many pages the issue touches, then how cheap the fix is.
Say which blend you used, and never leave a Serious row below a run of Moderate ones without
explaining why.

## Grading things that fail no criterion

Legitimate and often necessary. Say so explicitly in the WCAG column: "none, best practice",
or "none, SC 4.1.1 was removed in WCAG 2.2".

**Do not invent a criterion to justify a grade.** A reader who checks and finds the criterion
does not apply will discount your whole register, including the parts that are right.
