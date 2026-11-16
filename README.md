# Fast Markdown

A dependency-free Markdown renderer whose `parse(markdown)` output is
byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3
(default options, GFM on) on all 720 practice cases (CommonMark 0.31.2
+ GFM 0.29 examples + 40 long READMEs), in about 1.5 seconds for the
whole set.

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/annaroano1-sys/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/annaroano1-sys/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02):
make Markdown rendering faster.

## Layout

- `parse.js` — the renderer (ES module, no dependencies). Exports
  `parse(src)`.
- `main.ts` — the harness driver: reads `/input/cases.json`, writes
  `/output/html.json` (one HTML string per case, in order).

## How it works

`parse()` builds a block tree from the source lines (blockquotes,
lists, headings, fences, HTML blocks, tables), scans each paragraph,
heading and table cell into inline nodes, pairs emphasis delimiters
with a delimiter stack gated by a faithful replay of marked's
outside-in `emStrong` scan (the part that decides the tricky
emphasis-nesting cases), then prints the tree as HTML.
