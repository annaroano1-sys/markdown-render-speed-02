// main.ts — driver for the markdown-render-speed-02 bounty (round 7).
//
// Renders every case from <input>/cases.json with the dependency-free
// parse() in ./parse.js and writes the HTML strings — in exactly the
// same order as the cases — to <output>/html.json.
//
// The input/output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when set (handy for local runs) and fall back to
// /input and /output (the paths the harness uses).
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

type CaseRow = {
  id: string;
  markdown: string;
};

function die(msg: string): never {
  throw new Error('fast-markdown: ' + msg);
}

function run(): void {
  const started = performance.now();
  const srcDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const dstDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(srcDir, 'cases.json'), 'utf8'));
  } catch (err) {
    die('cannot read cases.json from ' + srcDir + ': ' + (err as Error).message);
  }
  if (!Array.isArray(raw)) die('cases.json must be a JSON array, got ' + typeof raw);
  const rows = raw as CaseRow[];

  const html: string[] = [];
  for (let pos = 0; pos < rows.length; pos++) {
    const row = rows[pos];
    const tag = 'case ' + pos +
      (row && typeof row === 'object' && typeof (row as CaseRow).id === 'string'
        ? ' (id ' + (row as CaseRow).id + ')'
        : '');
    if (!row || typeof row !== 'object') die(tag + ' is not an object');
    if (typeof (row as CaseRow).id !== 'string' || (row as CaseRow).id === '') {
      die(tag + ' has no non-empty string id');
    }
    if (typeof (row as CaseRow).markdown !== 'string') {
      die(tag + ' has no string markdown field');
    }
    html.push(parse((row as CaseRow).markdown));
  }

  // The harness scores html.json positionally, so the count must match
  // the input exactly and every entry must be a string.
  if (html.length !== rows.length) {
    die('rendered ' + html.length + ' outputs for ' + rows.length + ' cases');
  }
  for (let pos = 0; pos < html.length; pos++) {
    if (typeof html[pos] !== 'string') die('output at index ' + pos + ' is not a string');
  }

  mkdirSync(dstDir, { recursive: true });
  const target = join(dstDir, 'html.json');
  writeFileSync(target, JSON.stringify(html));

  const took = performance.now() - started;
  const report = {
    tool: 'fast-markdown',
    cases: rows.length,
    elapsedMs: Math.round(took * 100) / 100,
    microsecondsPerCase: rows.length > 0
      ? Math.round(((took * 1000) / rows.length) * 100) / 100
      : 0,
    output: target,
  };
  console.error(JSON.stringify(report));
}

run();
