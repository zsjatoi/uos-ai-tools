# Listen-sheet authoring checklist

Check a listen sheet against this list before you hand it to anyone for a sitting with NVDA or another screen reader. The list comes from a run of sittings in which a third of the defects were in the sheets, not in the page, and every one was found by the person trying to follow the sheet and none by review. A typical comment was: "the words were in English, but they didn't make sense to me."

This file covers sheets only. The method for running a sitting is in [.claude/docs/listening-protocol.md](../../../docs/listening-protocol.md).

1. **Name every control by the words that appear on screen, nothing else.** Check each noun against the rendered page. If it is not there, it is your vocabulary, not the interface's (the "pairs list" versus the real "Suggested corrections").
2. **Walk every sitting on the real page before shipping it.** Reading cannot catch what driving it catches. A screen reader counts a table's header as row 1, so "row 73" is off by one. Counts can legitimately collapse at one step and need a warning. A control you told people not to press can turn out to be live at that moment. One sheet said to press Tab three times, then Enter to cancel a dialogue, and that landed on OK.
3. **Identify controls by name and state, not by number.** Screen readers number rows differently from the DOM, and duplicate-named controls (two "Keep the change" checkboxes far apart) need explicit disambiguation.
4. **Do not ask for a gesture the page cannot perform.** A disabled button is out of the tab order entirely, and a paragraph is not a tab stop. Check each gesture against the real element.
5. **State the order of operations exactly, and test that order.** A wrong order ("choose the tool, then reload", where reload undoes the choice) fails every time and is only caught by running it.
6. **Any setup block must print exactly one of READY, NOT READY (with a reason) or FAILED (with the error).** Silence is the dangerous outcome, not the loud failure. Say explicitly that a silent block is itself a failure.
7. **Guard any step that is not safe to repeat.** A setup block that passes its own checks a second time on an already-prepared page can silently replace its output rather than adding to it, producing plausible wrong counts.
8. **One hand-over, one gesture, one question.** Never ask for a journey and a control in the same sitting, or two readings from one hand-over. The protocol document explains why.
9. **Open each sitting with what it is for, in plain terms**, not just what to press. Without that, the listener cannot judge their own answer and can only report noise.
10. **Make the fail condition distinguishable from the pass**, explicitly. Do not describe the fail so vaguely that a real pass reads as a fail.
11. **Warn about anything alarming that is correct** (a sharp count drop, an emptied table, a focus jump) at the step where it happens.
12. **Count every expected announcement against the code before the sitting.** If a sheet miscounts the expected sentences, the listener cannot tell a defect from a wrong sheet. Read the code path that speaks, count the writes per event, and put the count in the sheet only after checking it.
13. **Keep the sheet short.** About 8 steps or 20 minutes; split anything bigger. Number steps in the order they are done. One pasted setup line prints READY or NOT READY. Each step says where to be, what to press, and "paste the Speech Viewer text". Keep expected answers out of the sheet and do the SAME / DIFFERENT marking yourself. Never give a step a second half.

**How to apply:** when rewriting a sitting, quote the old wording underneath the new so the change can be judged directly.
