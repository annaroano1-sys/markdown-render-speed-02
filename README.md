# Fast Markdown — a drop-in for marked 18.1.3

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/annaroano1-sys/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/annaroano1-sys/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown parser that renders HTML byte-identical to
[marked](https://github.com/markedjs/marked) 18.1.3 (default options,
GFM on) — written from scratch for the
[make.fun bounty](https://make.fun/bounty/markdown-render-speed-02).

## Score

**720 / 720 practice cases byte-identical** (680 CommonMark 0.31.2 +
GFM 0.29 spec examples and 40 long READMEs), deterministic across
runs, in about 1.4 seconds for all 720 cases on this machine — marked
itself takes roughly 7 seconds for the same set.

## Files

- `parse.js` — the whole parser, zero dependencies. Exports one
  function, `parse(markdown)`, which returns the HTML string.
- `main.ts` — the bounty driver. It reads `/input/cases.json`, calls
  `parse()` for every case, and writes the 720 HTML strings in order
  to `/output/html.json`. It validates the input (every case needs a
  string `id` and a string `markdown` field) and the output (same
  count, every entry a string) before writing anything, and prints a
  one-line JSON timing summary to stderr.
- `package.json` — `{"type": "module"}` plus the package metadata.

## How the parser works

Parsing runs in three passes over the source:

1. **Blocks.** The source is split into lines and fed through a stack
   of open containers (document, blockquote, list, item). Each line
   descends through the containers that match it, closes the ones
   that don't, and either continues the open leaf block (paragraph,
   fenced or indented code, HTML block, table) or starts a new one
   (ATX or setext heading, thematic break, list, blockquote). Blank
   lines mark list items so tight and loose lists render correctly.
2. **Inline.** Every paragraph, heading and table cell is scanned
   once for backslash escapes, code spans, autolinks, links and
   images, entities, hard and soft breaks, and emphasis delimiters.
   Link reference definitions are collected while paragraphs close.
3. **Emphasis.** Delimiters pair with the CommonMark delimiter-stack
   algorithm, plus one marked behaviour the stack alone gets wrong:
   marked resolves emphasis outside-in with an `m`/`f` accounting
   (its `emStrong` scan), so an outer `**` run pairs with the later
   `**` closer as strong while the single `*`s inside stay literal.
   `markedScan` replays that accounting before accepting an `em`
   pairing — that is what makes the last case, `doc-11`, match.

Rendering walks the block tree and emits HTML; link destinations are
cleaned the way `encodeURI` does, and text is escaped so that a bare
`&` can never smuggle an entity through.

## Try it

```sh
node -e "import('./parse.js').then(m => console.log(m.parse('# Hello **world**')))"
# <h1>Hello <strong>world</strong></h1>
```

## License

MIT. See `LICENSE`.
