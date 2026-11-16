// main.ts — driver for the markdown-render-speed-02 bounty (round 5).
//
// Takes every case from <input>/cases.json, renders each one with the
// dependency-free parse() from ./parse.js, and writes the HTML strings
// — in exactly the same order as the cases — to <output>/html.json.
//
// Directories come from MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR when
// set (useful for local runs) and fall back to /input and /output (the
// paths the harness uses).
//
// The driver is strict: it refuses to write output when the input is
// malformed (a case without a string id or a string markdown field, a
// non-array payload, or a count mismatch), so a bad run fails loudly
// instead of producing a silently misaligned html.json. On success it
// prints one JSON summary line on stderr (tool, case count, elapsed
// milliseconds, microseconds per case, output path) and nothing on
// stdout.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse } from './parse.js';

type CaseIn = { id: string; markdown: string };

function fail(msg: string): never {
  throw new Error('fast-markdown: ' + msg);
}

function run(): void {
  const started = performance.now();
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
  } catch (e) {
    fail('cannot read cases.json from ' + inputDir + ': ' + (e as Error).message);
  }
  if (!Array.isArray(raw)) fail('cases.json must be a JSON array, got ' + typeof raw);
  const cases = raw as CaseIn[];

  const html: string[] = new Array<string>(cases.length);
  cases.forEach((entry, i) => {
    const where = 'case ' + i + (entry && typeof entry === 'object' && typeof (entry as CaseIn).id === 'string' ? ' (id ' + (entry as CaseIn).id + ')' : '');
    if (!entry || typeof entry !== 'object') fail(where + ' is not an object');
    if (typeof (entry as CaseIn).id !== 'string' || (entry as CaseIn).id === '') fail(where + ' has no non-empty string id');
    if (typeof (entry as CaseIn).markdown !== 'string') fail(where + ' has no string markdown field');
    html[i] = parse((entry as CaseIn).markdown);
  });

  // The harness scores html.json positionally, so the count must match
  // the input exactly and every entry must be a string.
  if (html.length !== cases.length) fail('rendered ' + html.length + ' outputs for ' + cases.length + ' cases');
  html.forEach((h, i) => {
    if (typeof h !== 'string') fail('output at index ' + i + ' is not a string');
  });

  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, 'html.json');
  writeFileSync(outPath, JSON.stringify(html));

  const ms = performance.now() - started;
  console.error(JSON.stringify({
    tool: 'fast-markdown',
    cases: cases.length,
    elapsedMs: Math.round(ms * 100) / 100,
    microsecondsPerCase: cases.length > 0 ? Math.round(((ms * 1000) / cases.length) * 100) / 100 : 0,
    output: outPath,
  }));
}

run();
