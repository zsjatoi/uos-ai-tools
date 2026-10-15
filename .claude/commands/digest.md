---
description: Map a big Markdown file by section and get exact line ranges to Read, instead of reading the whole file
---

Run the section outline for the file the person names. If they name none, ask
which. Do not guess, and do not fall back to reading a file whole.

```
node .claude/digest/outline.mjs <file.md> --depth 2
```

Then narrow, in this order, stopping as soon as you have a line range small
enough to read:

1. `--depth 2`: the whole-document map.
2. `--find "<regex>"`: only the sections whose heading or body matches.
3. `--find "<regex>" --body`: the matching lines with their **absolute line
   numbers**. This is the step that pays on big files, where one section can be
   half the file.
4. `Read <file> offset=<startLine> limit=<n>`: read that range verbatim.

## What this tool does and does not do

It reports **where things are**. It never summarises, scores or drops a line, and
makes no network call. Everything you read after the map, you read in full.

## Rules

- **Never present the outline as the content.** It is a map. If asked what a
  section says, read the range and quote it.
- **The `coverage: OK` footer is load-bearing.** It states that the sections tile
  the file with no gap or overlap. The tool exits 3 rather than print an outline
  that does not tile.
- **A `WARNING: ... possible setext heading(s)` line means the outline may be
  incomplete** for that file. Say so rather than treating it as a full map.
- `--audit` asks whether a naive parse of this file would have been wrong, by
  printing the strict-versus-naive heading disagreement.
- The `big-doc-read` guard (see the README, "Guards") blocks a whole-file read of
  a large `.md` and names these commands in its refusal.
