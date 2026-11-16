# Fast Markdown: a drop-in for marked 18.1.3

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/annaroano1-sys/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/annaroano1-sys/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer whose `parse()` output matches
[marked](https://github.com/markedjs/marked) 18.1.3 (default options,
GFM on) byte for byte — **720 of 720 practice cases**, including all
680 CommonMark 0.31.2 + GFM 0.29 spec examples and all 40 long README
documents, in about 1.5 seconds (marked itself takes about 7 seconds
on the same set).

Built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02):
make Markdown rendering faster.

## Files

- `parse.js` — the whole renderer, one dependency-free ES module.
  `parse(markdown)` returns the HTML string. Block parsing builds a
  tree of blocks (quotes, lists, headings, fences, tables, HTML
  blocks, ...), an inline pass resolves links, code spans, entities
  and emphasis, and a render pass prints the HTML. Emphasis follows
  the CommonMark delimiter stack, plus a replay of marked's
  outside-in emStrong scan for the one nesting case the stack alone
  gets wrong.
- `main.ts` — the bounty driver: reads `/input/cases.json`, renders
  every case with `parse()`, writes the HTML strings in order to
  `/output/html.json`. It validates the input, times the run and
  prints a JSON summary on stderr.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./out npx tsc main.ts --module nodenext --target es2022 --outDir ./dist
node ./dist/main.js
```

## License

MIT — see `LICENSE`.
