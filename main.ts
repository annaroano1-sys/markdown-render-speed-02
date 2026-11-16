// Driver for the markdown-render-speed-02 bounty.
//
// Reads every test case from <input>/cases.json, renders each one with the
// dependency-free parse() from ./parse.js, and writes the HTML strings to
// <output>/html.json in the same order as the cases.
//
// The input and output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when they are set (local testing), and default to
// /input and /output (the harness paths).
//
// The driver validates its input before rendering so a malformed
// cases.json fails fast with the offending case named, instead of
// producing a short or misaligned html.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const parsed: unknown = JSON.parse(raw);
if (!Array.isArray(parsed)) {
  throw new Error('cases.json must hold a JSON array of cases, got ' + typeof parsed);
}
const cases: { id: string; markdown: string }[] = parsed as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  if (!c || typeof c !== 'object' || typeof c.markdown !== 'string') {
    throw new Error(
      'case at index ' + i + ' has no string markdown field' +
      (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string'
        ? ' (id ' + (c as { id: string }).id + ')'
        : ''),
    );
  }
  html[i] = parse(c.markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
