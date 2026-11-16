// Driver for the markdown-render-speed-02 bounty (round 4, full rewrite).
//
// Reads every case from <input>/cases.json, renders each one with the
// dependency-free parse() from ./parse.js, and writes the resulting
// HTML strings — in exactly the same order as the cases — to
// <output>/html.json.
//
// The input and output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when set (handy for local runs) and default to
// /input and /output (the paths the harness uses).
//
// Compared with the round-3 driver this one also:
//   - checks that every case carries a string id as well as a string
//     markdown field, so a malformed case is caught before rendering,
//   - times the run with performance.now() and reports both the total
//     and the average microseconds per case,
//   - prints its summary as one JSON object on stderr, so a runner can
//     parse the timing and the counts without scraping prose.
//
// It exits non-zero on any validation or I/O failure; on success it
// prints the JSON summary to stderr and nothing to stdout.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse } from './parse.js';

interface InputCase {
  id: string;
  markdown: string;
}

function abort(reason: string): never {
  throw new Error('[fast-markdown] ' + reason);
}

function main(): void {
  const t0 = performance.now();
  const inDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
  } catch (err) {
    abort('cannot read cases.json in ' + inDir + ': ' + (err as Error).message);
  }
  if (!Array.isArray(payload)) {
    abort('cases.json must hold a JSON array of cases, got ' + typeof payload);
  }
  const inputs = payload as InputCase[];

  const rendered: string[] = new Array<string>(inputs.length);
  for (let index = 0; index < inputs.length; index++) {
    const entry = inputs[index];
    const where = 'case at index ' + index +
      (entry && typeof entry === 'object' && typeof entry.id === 'string'
        ? ' (id ' + entry.id + ')'
        : '');
    if (!entry || typeof entry !== 'object') {
      abort(where + ' is not an object');
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      abort(where + ' has no non-empty string id');
    }
    if (typeof entry.markdown !== 'string') {
      abort(where + ' has no string markdown field');
    }
    rendered[index] = parse(entry.markdown);
  }

  // The harness scores html.json positionally, so the count must match
  // the input exactly and every entry must be a string; a short,
  // misaligned or mistyped output must never be written silently.
  if (rendered.length !== inputs.length) {
    abort('rendered ' + rendered.length + ' outputs for ' + inputs.length + ' cases');
  }
  for (let index = 0; index < rendered.length; index++) {
    if (typeof rendered[index] !== 'string') {
      abort('output at index ' + index + ' is not a string');
    }
  }

  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'html.json');
  writeFileSync(outPath, JSON.stringify(rendered));

  const elapsedMs = performance.now() - t0;
  const summary = {
    tool: 'fast-markdown',
    cases: inputs.length,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    microsecondsPerCase: inputs.length > 0
      ? Math.round((elapsedMs * 1000) / inputs.length * 100) / 100
      : 0,
    output: outPath,
  };
  console.error(JSON.stringify(summary));
}

main();
