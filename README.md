# Fast Markdown — a drop-in replacement for marked 18.1.3

A single dependency-free ES module, `parse.js`, whose `parse(markdown)`
returns HTML byte-identical to `marked.parse` (marked 18.1.3, default
options, GFM on) on the 720-case suite of the make.fun
`markdown-render-speed-02` bounty: the CommonMark 0.31.2 spec examples,
the GFM 0.29 extension examples, and 40 long real-world READMEs.

`main.ts` is the bounty driver. It reads `<input>/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json`), renders every case in order, and writes
`<output>/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`). It validates the
input first, so a malformed `cases.json` fails fast naming the offending
case instead of producing a short or misaligned output file.

## Why it is fast

The parser is a single hand-written pass, not a token tree:

- Blocks are matched with small scanners over the raw lines; no
  intermediate AST is built for the document, only the open-container
  stack and the leaf being filled.
- Inline content is scanned once into a flat node list with a delimiter
  stack. Emphasis is resolved in place (closer-first, document order),
  so nested `*` / `**` / `_` / `__` / `~~` cost no extra passes.
- No regular expressions run over the whole document. The only regexes
  are tiny, anchored ones for a single construct (an entity, an autolink,
  a table delimiter row).
- Nothing is allocated per character. Text is accumulated in a buffer
  and flushed only at a construct boundary.

On this machine the full 720-case run takes about 1.5 seconds; marked
itself takes about 7 seconds on the same input.

## What it covers

- CommonMark blocks: ATX and setext headings, indented and fenced code,
  blockquotes, lists (bullet and ordered, tight and loose, task items),
  thematic breaks, HTML blocks (types 1–7), paragraphs, link reference
  definitions.
- GFM: tables (with alignment), strikethrough, task lists, extended
  autolinks (`www.`, scheme, email), disallowed raw HTML handling.
- Inline: code spans, emphasis and strong emphasis (including marked's
  deactivation rule for the rule of three), links and images (inline,
  reference, shortcut, collapsed), autolinks, entities, hard and soft
  line breaks, backslash escapes.
- Edge cases the suite exercises: nested emphasis such as
  `*a **b**c*` versus `*foo**bar**baz*`; link labels that hold code spans
  (a link forms only when the label ends with the span) and autolinks
  (an inner autolink does not block the outer link); unbalanced backticks
  in a link label, which open a phantom code span that swallows emphasis
  up to the next backtick; tables whose rows are separated by a lone tab
  line; a list item whose blank line is a lone `>`; and fenced code
  whose first line sits at column 0.

## Layout

- `parse.js` — the whole renderer. Exports `parse(markdown)`.
- `main.ts` — the bounty driver described above.
- `LICENSE` — MIT.

## Running it

```sh
# check the module parses
node --check parse.js

# run the practice suite from the kit (paths are examples)
MAKEFUN_INPUT_DIR=/path/to/kit/practice/input \
MAKEFUN_OUTPUT_DIR=/tmp/out \
node main.ts
```

The output file is `html.json`: a JSON array of 720 HTML strings, in the
same order as `cases.json`. Running the driver twice on the same input
produces byte-identical output.
