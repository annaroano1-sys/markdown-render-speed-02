# Make Markdown rendering faster

Entry for the [make.fun bounty markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02): a dependency-free Markdown renderer whose `parse()` returns HTML byte-identical to marked 18.1.3 (default options, GFM on), written from scratch for speed.

## How it works

- `parse.js` — a single ES module, no dependencies. `parse(markdown)` parses CommonMark 0.31.2 plus the GFM 0.29 extensions (tables, task lists, strikethrough, extended autolinks, disallowed raw HTML) and returns the HTML string. Block parsing follows the CommonMark phase algorithm (open blocks, lazy continuation, setext/table detection); inline parsing uses one scan with a delimiter stack for emphasis, strong, and strikethrough, plus link/image, autolink, entity, and code-span handling.
- `main.ts` — the program the harness runs. It reads `/input/cases.json` (an array of `{id, markdown}`), renders every case with `parse()`, and writes the HTML strings in case order to `/output/html.json`.

## Run it

```sh
node --experimental-strip-types main.ts
```

For a local test against a practice set, point the driver at your folders:

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./practice/out node --experimental-strip-types main.ts
```

## Owner

- Owner: annaroano1-sys
- Referral code: fjta9fmj
- Bounty: https://make.fun/bounty/markdown-render-speed-02
