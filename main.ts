// Driver for the markdown-render-speed-02 bounty.
//
// Reads every test case from <input>/cases.json, renders each one with the
// dependency-free parse() from ./parse.js, and writes the HTML strings to
// <output>/html.json in the same order as the cases.
//
// The input and output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when they are set (local testing), and default to
// /input and /output (the harness paths).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases: { id: string; markdown: string }[] = JSON.parse(raw);

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
