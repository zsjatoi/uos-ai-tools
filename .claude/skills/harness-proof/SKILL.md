---
name: harness-proof
description: Prove a throwaway measurement instrument can actually fail, before you believe a number it produces. Use when you have just written, or are about to write, a one-off harness (a drive script, a measurement rig, a parser over source, a tripwire, a regex gate, a grep-based count, a listen sheet) and are about to report a result from it. Also use when a harness reports the very defect it was built to find, when a fix does not move a number, or when a result is suspiciously clean. Encodes the negative-control loop: baseline, plant, prove red, restore, prove green.
---

# Harness proof

A throwaway instrument gives no sign when it is wrong. It returns a plausible number, and the only tell is that the number disagrees with something else, which then looks like a finding about the something else. This skill is the cheapest way to stop that. It costs minutes, where unwinding a false result costs a whole verification cycle.

It is invoked, not enforced. Load it at the moment you write the instrument, not when you read the result.

## What this does not cover

- It does not replace a proper test fixture. If the instrument will be re-run, by you next week or by anyone else, it is not throwaway and needs a real fixture with rows that must fail as well as rows that must pass.
- It proves the instrument can report. It says nothing about whether the thing being measured is correct. Those are different claims, and mixing them up is its own defect.
- It cannot rescue an instrument that is insensitive to the error you are hunting. Step 0 is the only defence, and it is a judgement, not a procedure.

## Step 0: ask what the instrument is insensitive to

An instrument that is robust to the error you are hunting returns green and proves nothing. A green result from it looks identical to a green result that means something.

Example: you want to know whether an audio clip was labelled with the right sample rate, so you play it back through speech recognition. Recognition copes with a speed error of a third either way, which is exactly the band you are testing, so every candidate rate transcribes correctly. Three passing checks looked like three pieces of evidence and were none. A person listening hears a wrong rate as pitch within seconds.

Write the answer down. If the instrument cannot discriminate, say so and stop. That negative is the reportable result, and it is worth more than a number.

## The loop

Five steps. Do not skip step 4 because step 3 passed.

### 1. Baseline, with a seeded canary

Run it clean and record the exact figure. Then seed something the instrument must catch, and confirm that it does.

A zero is the figure that misleads most often, because a clean run and a dead instrument both produce it. Typical case: a network tripwire whose URL parser throws inside a sandbox where the `URL` constructor does not exist. Every request lands in the catch block and is waved through, the tally stays empty, and the empty tally reads as "nothing was blocked".

- A tripwire needs a deliberately forbidden request made after every page load, with the refusal recorded.
- A count or marker gate needs at least one needle that is expected to be positive, so an empty read cannot pass as clean.
- A counter needs a known-positive input.

### 2. Write down the predicted red set before you run

Name which rows, files or figures should change when you plant the defect. This turns a sweep into evidence. If less goes red than you predicted, you have learnt something about how the guards are structured, often that two independent guards exist where you thought there was one. If more goes red, a second guard exists that you did not know about. Neither is visible unless the prediction was written first.

### 3. Plant the defect, and assert the patch count

Break the subject, not the instrument, wherever you can. Anchor the patch on the construct itself (a function head, a unique declaration), never on a neighbouring line borrowed for uniqueness. An edit to the neighbour then disarms the plant without any sign.

Assert how many sites you patched and refuse on anything but the expected number. A patch that matches zero sites and a patch that matches three have the same symptom: every row stays green. Zero means the instrument is disarmed and looks exactly like a passing one.

If the plant goes through a shell, print the regular expression's `.source` and check the anchor survived. Shells collapse escapes: `\\b` can arrive as a backspace character, and every anchored pattern silently becomes an unanchored one. Write instruments with a file tool so no shell parser touches the content.

### 4. Prove it goes red, and check the exact exit code

A non-zero exit is not enough. A deliberate refusal and a crash are both non-zero, and only one of them means the guard worked. Check the exact code.

Then ask of your own instrument: what would make this unable to fail? Shapes that hide from every passing row:

- an exit code overwritten by a handler that arms itself on import
- a crashed subject read as a pass, where the instrument spawns a process and reads its output
- a claim made in the instrument's printed prose but not enforced in code, such as "both sides are populated" with one side empty
- a catch block that turns a failure into a pass; every catch should record into a field the assertions read
- a figure derived from the rows' own English labels, so renaming a row moves a total
- a row that tests the proof's own command line rather than the subject, so a real defect planted in the subject still passes

### 5. Restore, and prove it goes green again

Restore in a `finally` block, then confirm the reading has returned to the baseline before trusting anything further. An unverified restore is a mutation you have forgotten about. A checksum that moves after a supposed no-op restore is the cheapest detector there is. Note that `sed -i` and default text read/write in several languages rewrite line endings across a whole file while changing nothing a diff will show.

## Two-sided or it proves nothing

A one-sided check passes equally well on an instrument that matches everything. Every count needs its complement from the same run on the same data: what it returned and what it should have returned. A filter that returns 7 of 255 matching items looks like a working filter, because nothing about seven correct results says the rest are missing.

The "should have returned" side must be computed by the thing under test, not approximated beside it with your own regular expression.

## When the harness reports the defect it was built to find

Suspect the harness first. A harness that printed "the reply carried no image; this is the defect I exist to find" was itself at fault, in two independent places, either of which alone was enough.

- A field named for the wire must be read off the wire. Reporting what the caller intended to send answers the exact question a reader would otherwise go and check.
- A harness that pre-computes what the application computes bypasses the seam it exists to prove. Hand the application the input it normally receives and let it derive the rest.
- A row that supplies the very argument whose forwarding is in question proves the consumer and says nothing about the producer.

When two candidate causes would produce the same observable, that observable is evidence for neither. Disable exactly one, re-measure, restore. The answer can be both: a candidate whose removal changes the result is proved to contribute, not to be sufficient. Read it back with every other candidate still disabled before calling it the cause.

## Parsing source code

- Strip comments with a stripper that understands string literals. Prose answers for code in both directions: an assertion that a string is gone is satisfied by the comment explaining its removal, and a banner comment quoting `key: "value"` matches the pattern you wrote for real code. A naive two-pass stripper also eats code, for example a line comment containing `/*` that opens a phantom block comment.
- A flat regular expression has no notion of depth, so it reports a field three levels down as a property of the top-level object. Parse to a value, or match the whole path.
- A zero from a source search tells you about the source's spelling, not about the object the code receives. Where a factory synthesises a field, call the factory and read the result.

## Finishing

State which figures were measured in this run and which were read from a document, a default or memory. If the instrument could not discriminate, say that instead of giving a number. If you are about to run this loop a second time on the same instrument, stop: it is not throwaway, and it needs a fixture.
