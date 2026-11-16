// parse.js — a dependency-free CommonMark 0.31.2 + GFM parser.
//
// parse(markdown) returns the HTML that marked 18.1.3 returns with its
// default options (gfm on, breaks off, pedantic off, async off).
// Written from scratch in this session. No code is copied from marked or
// from any other Markdown parser; the behaviour was worked out from the
// CommonMark and GFM specs and checked against the practice set.

export function parse(src) {
  const state = { refs: new Map() };
  const doc = parseBlocks(src, state);
  // Safety net: collect link reference definitions from every paragraph
  // in the finished tree. The incremental stripDefs during block parsing
  // can miss a definition when its paragraph is split or closed early,
  // so this pass makes sure every definition paragraph contributes its
  // definitions before rendering.
  collectDefs(doc, state);
  return renderBlocks(doc, state);
}

// Walk the block tree and strip (collect + remove) leading link
// reference definitions from every paragraph. A paragraph left empty
// by this is removed from its parent.
function collectDefs(node, state) {
  if (!node.children) return;
  for (let k = node.children.length - 1; k >= 0; k--) {
    const child = node.children[k];
    if (child.t === 'paragraph') {
      stripDefs(child, state, true);
      if (!child.lines.length) node.children.splice(k, 1);
    } else {
      collectDefs(child, state);
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isPunct(ch) {
  if (!ch) return false;
  if (ASCII_PUNCT.indexOf(ch) >= 0) return true;
  // CommonMark punctuation is Unicode P (punctuation) or S (symbols),
  // which covers currency signs like $ £ € as well as letters' marks
  return /[\p{P}\p{S}]/u.test(ch);
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ' || /\s/.test(ch);
}

// Escape text for HTML output. A bare & is always escaped, because any
// valid entity reference in the source has already been consumed as its own
// node by tryEntity; a & that reaches here (for example from a backslash
// escape) is literal text. < > " ' are always escaped.
function escapeText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Escape for link destinations and titles, where a valid entity reference
// (&name; or &#digits; or &#xhex;) is left alone, as marked does.
const ENTITY_TAIL = /^(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]*);/;

function escapeAttr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      out += ENTITY_TAIL.test(s.slice(i + 1)) ? '&' : '&amp;';
    } else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Escape for code spans and code blocks: every & is escaped.
function escapeCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Decode a numeric character reference body (the part after &# and before ;).
// Returns the character, or U+FFFD for 0, surrogates and out-of-range values.
function decodeNumeric(body) {
  let code;
  if (body[0] === 'x' || body[0] === 'X') code = parseInt(body.slice(1), 16);
  else code = parseInt(body, 10);
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  return String.fromCodePoint(code);
}

// marked cleans a link destination the way encodeURI does, except a literal
// % stays a % (encodeURI would turn it into %25 first).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Line cursor: a line of input with a position in it, tracked in columns so
// that tabs (which jump to the next multiple of 4 columns) are handled the
// way the spec handles them. Advancing part-way through a tab turns the rest
// of the tab into spaces inside the line itself.
// ---------------------------------------------------------------------------

function blankRest(c) {
  for (let i = c.i; i < c.s.length; i++) {
    if (c.s[i] !== ' ' && c.s[i] !== '\t') return false;
  }
  return true;
}

function indentOf(c) {
  let col = c.col;
  let i = c.i;
  while (i < c.s.length) {
    const ch = c.s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - c.col;
}

function advance(c, n) {
  while (n > 0 && c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === '\t') {
      const w = 4 - (c.col % 4);
      if (n < w) {
        c.s = c.s.slice(0, c.i) + ' '.repeat(w - n) + c.s.slice(c.i + 1);
        c.col += n;
        n = 0;
      } else {
        c.i++;
        c.col += w;
        n -= w;
      }
    } else {
      c.i++;
      c.col++;
      n--;
    }
  }
}

// Remove up to n columns of leading whitespace from the cursor's line and
// return what is left of the line.
// Expand a single leading tab at the start of a fenced code line to
// spaces, starting at the given column. A tab advances to the next
// multiple of 4 columns. Only a tab that is the very first character
// and whose column is past 0 expands (it completes the fence indent,
// as in a 7-space fence followed by a tab becoming one space); a tab
// at column 0 is content and stays a literal tab, and tabs after a
// space or in the middle of content are kept literally too.
function expandTabs(s, startCol) {
  if (s[0] !== '\t' || startCol <= 0) return s;
  const w = 4 - (startCol % 4);
  return ' '.repeat(w) + s.slice(1);
}

function removeIndent(c, n) {
  const ind = indentOf(c);
  advance(c, n < ind ? n : ind);
  return c.s.slice(c.i);
}

// ---------------------------------------------------------------------------
// Block nodes
// ---------------------------------------------------------------------------

function mkNode(t, fields) {
  const n = { t, children: [], parent: null };
  if (fields) Object.assign(n, fields);
  return n;
}

function addChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

function lastChild(node) {
  return node.children.length ? node.children[node.children.length - 1] : null;
}

function isContainer(node) {
  return node.t === 'document' || node.t === 'blockquote' || node.t === 'list' || node.t === 'item';
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Unicode case folding for link labels: toLowerCase plus the special
// full case foldings (ẞ -> ss, ligatures -> their letters).
const CASE_FOLD_MAP = {
  '\u1E9E': 'ss', '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl',
  '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
};
function caseFold(s) {
  let out = '';
  for (const ch of s) out += CASE_FOLD_MAP[ch] || ch;
  return out.toLowerCase();
}

// True when a label holds an unescaped [ (a link label may not hold one).
function hasUnescapedBracket(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '[') return true;
  }
  return false;
}

// Normalize a link label for lookup: collapse runs of whitespace to one
// space, trim, and case-fold. Backslash escapes are NOT removed: the raw
// label text is what matches, so [foo\!] does not match a [foo!] definition.
function normalizeLabel(label) {
  return caseFold(label
    .replace(/\s+/g, ' ')
    .trim());
}

// Try to parse one link reference definition starting at lines[k].
// A definition is: [label]: <dest> or dest, then an optional title, and
// the line must end there (the title may sit on a following line instead).
// The label, destination and the title's opening quote must all start
// within the first 3 lines, but a title may close on a later line.
// Returns { def, used, label } where used is how many lines the definition
// took, or null when the lines do not form a definition.
function parseOneDef(lines, k) {
  // quick check: the first line must start with [ (after up to 3 spaces)
  const first = lines[k];
  let fi = 0;
  while (fi < first.length && first[fi] === ' ' && fi < 3) fi++;
  if (first[fi] !== '[') return null;
  // join the remaining lines so the label, destination and title parsers
  // can look across line boundaries
  const joined = lines.slice(k).join('\n');
  const lineOf = (pos) => joined.slice(0, pos).split('\n').length;
  let p = 0;
  while (p < joined.length && joined[p] === ' ' && p < 3) p++;
  if (joined[p] !== '[') return null;
  // label: [ ... ] up to the first unescaped ] (a label may not hold a
  // nested bracket pair); it may span lines. The raw text is kept,
  // backslashes included, so it matches link labels the same way.
  let j = p;
  let label = '';
  while (j < joined.length) {
    const ch = joined[j];
    if (ch === '\\' && j + 1 < joined.length) { label += joined[j] + joined[j + 1]; j += 2; continue; }
    if (ch === ']') break;
    label += ch;
    j++;
  }
  if (j >= joined.length) return null;
  label = label.slice(1); // drop the opening [
  if (!label || label.length > 999) return null;
  if (!normalizeLabel(label)) return null; // a label of only whitespace
  if (hasUnescapedBracket(label)) return null; // a label holds no [
  j++; // past ]
  if (joined[j] !== ':') return null;
  p = j + 1;
  const skipWs = () => { while (p < joined.length && (joined[p] === ' ' || joined[p] === '\t' || joined[p] === '\n')) p++; };
  skipWs();
  if (p >= joined.length) return null;
  if (lineOf(p) > 3) return null; // the destination must start by line 3
  // destination
  let dest = '';
  if (joined[p] === '<') {
    const end = joined.indexOf('>', p + 1);
    if (end < 0) return null;
    const inner = joined.slice(p + 1, end);
    if (inner.indexOf('\n') >= 0 || inner.indexOf('<') >= 0) return null;
    dest = inner;
    p = end + 1;
  } else {
    let parens = 0;
    const start = p;
    while (p < joined.length) {
      const ch = joined[p];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
      if (ch === '\\' && p + 1 < joined.length) { p += 2; continue; }
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      }
      p++;
    }
    if (p === start) return null;
    dest = joined.slice(start, p);
  }
  dest = unescapeText(dest);
  // the definition must end at a line end: from where its content ends
  // to the end of that line there may only be spaces/tabs
  const endsLine = (pos) => {
    let q = pos;
    while (q < joined.length && (joined[q] === ' ' || joined[q] === '\t')) q++;
    return q >= joined.length || joined[q] === '\n';
  };
  // optional title: it may sit on the same line as the destination or on
  // the following line. A title on the same line must be separated from
  // the destination by whitespace. If the title is malformed (or has
  // other text after it on its line) the definition still stands without
  // it, ending at the destination.
  const afterDest = p;
  const wsStart = p;
  skipWs();
  const skippedWs = p - wsStart;
  const skippedNewline = joined.slice(wsStart, p).indexOf('\n') >= 0;
  let title = null;
  let contentEnd = afterDest;
  if (p < joined.length && (joined[p] === '"' || joined[p] === "'" || joined[p] === '(')) {
    if ((skippedNewline || skippedWs > 0) && lineOf(p) <= 3) {
      const open = joined[p];
      const close = open === '(' ? ')' : open;
      p++;
      let t = '';
      let ok = false;
      while (p < joined.length) {
        const ch = joined[p];
        // a backslash only escapes ASCII punctuation; otherwise it stays.
        // A title may span lines, so newlines are kept.
        if (ch === '\\' && p + 1 < joined.length && ASCII_PUNCT.indexOf(joined[p + 1]) >= 0) { t += joined[p + 1]; p += 2; continue; }
        if (ch === close) { ok = true; p++; break; }
        t += ch;
        p++;
      }
      if (ok && endsLine(p)) {
        title = t;
        contentEnd = p;
      }
    }
  }
  // a definition without a usable title must still end at a line end
  if (title === null && !endsLine(afterDest)) return null;
  const usedLines = lineOf(contentEnd);
  return { def: { dest, title }, used: usedLines, label };
}

// Remove backslash escapes before ASCII punctuation from a string.
function unescapeText(s) {
  return s.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
}

// Strip leading link reference definitions from a paragraph's lines,
// registering them in state.refs. A definition that uses every line seen
// so far (and fewer than 3 lines) is left alone unless `final` is set:
// its title may still arrive on the next line. Idempotent: safe to call
// repeatedly.
function stripDefs(para, state, final) {
  // Collect link reference definitions from the start of a paragraph.
  // Lines are only removed when final is true (the paragraph is being
  // closed): splicing while the paragraph is still being built corrupts
  // the line list, so a non-final call records the definitions but
  // leaves the lines in place for the closing call to remove.
  let i = 0;
  for (;;) {
    if (i >= para.lines.length) break;
    const got = parseOneDef(para.lines, i);
    if (!got) break;
    if (!final && got.used < 3 && i + got.used >= para.lines.length) break;
    const key = normalizeLabel(got.label);
    if (key && !state.refs.has(key)) state.refs.set(key, got.def);
    i += got.used;
  }
  if (final && i > 0) para.lines.splice(0, i);
}

// ---------------------------------------------------------------------------
// Block-start matchers
// ---------------------------------------------------------------------------

// Try to match a blockquote marker at the cursor. Returns true and consumes
// it (plus one following space) when it matches.
function matchBQ(c) {
  const saveI = c.i, saveCol = c.col;
  const ind = indentOf(c);
  if (ind > 3) return false;
  advance(c, ind);
  if (c.i >= c.s.length || c.s[c.i] !== '>') { c.i = saveI; c.col = saveCol; return false; }
  c.i++; c.col++;
  if (c.i < c.s.length && c.s[c.i] === ' ') { c.i++; c.col++; }
  else if (c.i < c.s.length && c.s[c.i] === '\t') advance(c, 1);
  return true;
}

// Match the content indent of an open list item. Returns true and consumes
// the indent when the line belongs to the item.
function matchItemIndent(c, item) {
  if (indentOf(c) < item.contentIndent) return false;
  advance(c, item.contentIndent);
  return true;
}

const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

function matchSetext(c) {
  const rest = c.s.slice(c.i);
  const m = SETEXT_RE.exec(rest);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

function matchAtx(c) {
  const rest = c.s.slice(c.i);
  const m = ATX_RE.exec(rest);
  if (!m) return null;
  let text = rest.slice(m[0].length);
  // strip a closing sequence of #s at the end: it is preceded by spaces,
  // or it is the whole text (the space before it was the one after the
  // opening run)
  text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/^[ \t]*#+[ \t]*$/, '');
  text = text.replace(/^[ \t]+|[ \t]+$/g, '');
  return { level: m[1].length, text };
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function matchFence(c) {
  const rest = c.s.slice(c.i);
  const m = FENCE_RE.exec(rest);
  if (!m) return null;
  const fence = m[1];
  const info = rest.slice(m[0].length).trim();
  if (fence[0] === '`' && info.indexOf('`') >= 0) return null;
  return { ch: fence[0], len: fence.length, info, indent: indentOf(c) };
}

function isClosingFence(c, leaf) {
  const rest = c.s.slice(c.i);
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
  if (!m) return false;
  if (m[1][0] !== leaf.fenceCh) return false;
  return m[1].length >= leaf.fenceLen;
}

const THEMATIC_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function isThematic(c) {
  return THEMATIC_RE.test(c.s.slice(c.i));
}

// HTML block start conditions, numbered as in the CommonMark spec.
// Type 1 is pre/script/style (ends with the matching close tag); 2 is a
// comment, 3 a processing instruction, 4 a declaration, 5 CDATA; 6 is a
// block tag (ends at a blank line); 7 is any other complete tag (ends at a
// blank line, and cannot interrupt a paragraph). Returns the type or 0.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function htmlBlockType(c) {
  const rest = c.s.slice(c.i);
  if (!/^ {0,3}</.test(rest)) return 0;
  const s = rest.replace(/^ {0,3}/, '');
  if (/^<(pre|script|style|textarea)(?:[ \t/>]|$)/i.test(s)) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  const tag = matchHtmlTag(s);
  if (tag) {
    if (BLOCK_TAGS.has(tag.name.toLowerCase())) return 6;
    // type 7: a complete tag that is alone on its line
    if (/^[ \t]*$/.test(s.slice(tag.end))) return 7;
    return 0;
  }
  // an incomplete tag: a block tag name alone still starts a type 6 block
  // (the tag may continue on the next line, as in <div id="foo" ...)
  const m2 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m2 && BLOCK_TAGS.has(m2[1].toLowerCase())) return 6;
  return 0;
}

// Match a complete HTML open or close tag at the start of s. Returns
// {name, end} or null. end is the index just past the tag.
function matchHtmlTag(s) {
  let i = 0;
  if (s[i] !== '<') return null;
  i++;
  let closing = false;
  if (s[i] === '/') { closing = true; i++; }
  const nameStart = i;
  if (!/[A-Za-z]/.test(s[i] || '')) return null;
  while (i < s.length && /[A-Za-z0-9-]/.test(s[i])) i++;
  const name = s.slice(nameStart, i);
  if (closing) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (s[i] !== '>') return null;
    return { name, end: i + 1 };
  }
  for (;;) {
    // every attribute must be separated from what precedes it by
    // whitespace; a name glued to the tag name or the previous value
    // (as in <a href='bar'title=...>) is not a valid tag
    let ws = 0;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) { i++; ws++; }
    if (i >= s.length) return null;
    if (s[i] === '>') return { name, end: i + 1 };
    if (s[i] === '/' && s[i + 1] === '>') return { name, end: i + 2 };
    if (ws === 0) return null;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[i])) return null;
    while (i < s.length && /[A-Za-z0-9_.:-]/.test(s[i])) i++;
    // an optional = value, with spaces allowed around the =. Only
    // consume the spaces when an = actually follows: an attribute
    // with no value (as in <a _boolean zoop=...>) must leave the
    // separating whitespace for the next loop round to count.
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] === '=') {
      i = j + 1;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i];
        i++;
        while (i < s.length && s[i] !== q) i++;
        if (i >= s.length) return null;
        i++;
      } else {
        let v = 0;
        while (i < s.length && !/[ \t\n"'=<>`]/.test(s[i])) { i++; v++; }
        if (v === 0) return null;
      }
    }
  }
}

// Match a list marker at the cursor. Returns null, or { list, item } info:
// kind 'bullet'|'ordered', marker char/delimiter, start number, and how many
// columns of content indent the item has.
function matchListMarker(c) {
  const ind = indentOf(c);
  if (ind > 3) return null;
  const saveI = c.i, saveCol = c.col;
  advance(c, ind);
  const s = c.s;
  let i = c.i;
  let kind, marker, start = null;
  if (s[i] === '-' || s[i] === '+' || s[i] === '*') {
    kind = 'bullet';
    marker = s[i];
    i++;
  } else {
    const m = /^(\d{1,9})([.)])/.exec(s.slice(i));
    if (!m) { c.i = saveI; c.col = saveCol; return null; }
    kind = 'ordered';
    marker = m[2];
    start = parseInt(m[1], 10);
    i += m[0].length;
  }
  // spaces (or a tab) after the marker
  let spaces = 0;
  let j = i;
  let col = c.col + (i - c.i);
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { spaces++; col++; j++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; j++; }
  }
  const empty = j >= s.length;
  // a list marker must be followed by at least one space (or end the line)
  if (!empty && spaces === 0) {
    c.i = saveI; c.col = saveCol;
    return null;
  }
  let contentIndent;
  // the marker's width is its matched text (e.g. 003. is 4 columns, even
  // though its number is 3)
  const markerW = kind === 'bullet' ? 1 : (i - c.i);
  if (empty) {
    contentIndent = ind + markerW + 1;
  } else if (spaces >= 1 && spaces <= 4) {
    contentIndent = ind + markerW + spaces;
  } else {
    contentIndent = ind + markerW + 1;
  }
  // consume the marker (the indent was already consumed above), then the
  // following whitespace up to the content indent (any spaces past that
  // stay as the content's own indentation)
  advance(c, markerW);
  if (!empty) advance(c, contentIndent - ind - markerW);
  return { kind, marker, start, contentIndent, empty };
}

// A line is a table delimiter row when, split on |, every cell is dashes
// with an optional colon on either side.
function isTableDelim(c) {
  // a delimiter row may be indented at most 3 spaces
  if (indentOf(c) > 3) return false;
  const rest = c.s.slice(c.i).trim();
  if (!rest) return false;
  let cells = rest.split('|');
  if (cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  if (!cells.length) return false;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell.trim())) return false;
  }
  return true;
}

// Split a table row line into cell source strings. One leading and one
// trailing pipe are dropped; other pipes split the row, except an escaped
// pipe (\|) and a pipe inside a code span (a backtick run is skipped
// whole, up to its matching close, so backticks inside a span do not
// confuse the count).
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (i + run < s.length && s[i + run] === '`') run++;
      const close = findCodeClose(s, i + run, run);
      if (close >= 0) {
        // inside a code span a \| is still an escaped pipe in a table
        // cell, so it becomes a literal | in the cell text
        cur += s.slice(i, close).replace(/\\\|/g, '|');
        i = close - 1;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Is the pipe at position i inside a backtick code span on this line?
function inCodeSpan(line, i) {
  let ticks = 0;
  for (let j = 0; j < i; j++) if (line[j] === '`') ticks++;
  return ticks % 2 === 1;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function closeNode(node, state) {
  if (node.t === 'paragraph') {
    stripDefs(node, state, true);
    if (!node.lines.length && node.parent) {
      const sibs = node.parent.children;
      const k = sibs.indexOf(node);
      if (k >= 0) sibs.splice(k, 1);
    }
  } else if (node.t === 'code' && !node.fenced) {
    while (node.lines.length && node.lines[node.lines.length - 1] === '') node.lines.pop();
  }
}

function startBlock(c, container, state, open) {
  // blockquote
  {
    const saveI = c.i, saveCol = c.col;
    if (matchBQ(c)) {
      const bq = addChild(container, mkNode('blockquote'));
      return bq;
    }
    c.i = saveI; c.col = saveCol;
  }
  // ATX heading
  {
    const atx = matchAtx(c);
    if (atx) {
      return addChild(container, mkNode('heading', { level: atx.level, text: atx.text }));
    }
  }
  // fenced code
  {
    const fence = matchFence(c);
    if (fence) {
      advance(c, indentOf(c));
      const node = addChild(container, mkNode('code', {
        fenced: true, fenceCh: fence.ch, fenceLen: fence.len,
        info: unescapeText(fence.info),
        indent: fence.indent, lines: [],
      }));
      return node;
    }
  }
  // HTML block types 1-7
  {
    const type = htmlBlockType(c);
    if (type) {
      return addChild(container, mkNode('html', { htmlType: type, lines: [c.s.slice(c.i)] }));
    }
  }
  // thematic break (before list: a line of only * - _ is a break, not a
  // list item)
  if (isThematic(c)) {
    return addChild(container, mkNode('thematic_break'));
  }
  // list
  {
    const m = matchListMarker(c);
    if (m) {
      let list = null;
      // reuse the list we are already in, or a matching list that is the
      // container's last child
      if (container.t === 'list' && container.open &&
        ((m.kind === 'bullet' && container.marker === m.marker) ||
         (m.kind === 'ordered' && container.delim === m.marker))) {
        list = container;
      } else {
        const last = lastChild(container);
        if (last && last.t === 'list' && last.open &&
          ((m.kind === 'bullet' && last.marker === m.marker) ||
           (m.kind === 'ordered' && last.delim === m.marker))) {
          list = last;
        }
      }
      if (!list) {
        list = addChild(container, mkNode('list', {
          kind: m.kind, marker: m.kind === 'bullet' ? m.marker : null,
          delim: m.kind === 'ordered' ? m.marker : null,
          start: m.kind === 'ordered' ? m.start : null, loose: false,
        }));
        list.open = true;
        open.push(list);
      }
      const item = addChild(list, mkNode('item', { contentIndent: m.contentIndent, pendingBlank: false, pendingBlankInner: false }));
      item.open = true;
      return item;
    }
  }
  // indented code
  if (indentOf(c) >= 4) {
    const node = addChild(container, mkNode('code', { fenced: false, lines: [removeIndent(c, 4)] }));
    return node;
  }
  return null;
}

// Can a block of this kind interrupt an open paragraph?
function interruptsParagraph(c, state, nested) {
  const saveI = c.i, saveCol = c.col;
  if (matchBQ(c)) { c.i = saveI; c.col = saveCol; return true; }
  if (matchAtx(c)) return true;
  if (matchFence(c)) return true;
  const ht = htmlBlockType(c);
  if (ht >= 1 && ht <= 6) return true;
  if (isThematic(c)) return true;
  const m = matchListMarker(c);
  if (m) {
    c.i = saveI; c.col = saveCol;
    if (m.empty) return false;
    if (m.kind === 'bullet') return true;
    // an ordered list interrupts a paragraph only when it starts at 1,
    // unless it is nested inside a list item or blockquote, where any
    // start number interrupts (a nested list is a new block in its item)
    return nested || m.start === 1;
  }
  c.i = saveI; c.col = saveCol;
  return false;
}

function parseBlocks(src, state) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  // a trailing newline ends the last line; it is not an extra blank line
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // whether the source ends with a newline: an HTML block of type 6-7
  // that is the last block of the document keeps a trailing newline
  // only when the source ends with one
  state.srcEndsWithNewline = src.replace(/\r\n?/g, '\n').endsWith('\n');
  const doc = mkNode('document');
  const open = [doc];
  for (let li = 0; li < lines.length; li++) {
    const c = { s: lines[li], i: 0, col: 0 };
    const rawBlank = blankRest(c);
    let blank = rawBlank;
    // a lazy continuation line (a paragraph line without its container
    // markers) is added to the paragraph as text: it can never be a setext
    // underline or a table delimiter row
    let lazyLine = false;
    // Phase 1: descend through open containers, matching their markers.
    let idx = 0;
    while (idx + 1 < open.length) {
      const nx = open[idx + 1];
      if (nx.t === 'blockquote') {
        if (!matchBQ(c)) {
          // lazy continuation: a paragraph inside the quote keeps taking
          // plain text lines even without the > marker (but a thematic
          // break closes the quote instead, and a line that starts a
          // block that can interrupt a paragraph -- a list item, a fence,
          // a heading -- belongs outside the quote)
          if (!blank && !isThematic(c) && open[open.length - 1].t === 'paragraph') {
            const probe = { s: c.s, i: c.i, col: c.col };
            if (!matchListMarker(probe) && !interruptsParagraph(c, state, true)) { idx = open.length - 1; lazyLine = true; }
          }
          break;
        }
        idx++;
      } else if (nx.t === 'list') {
        idx++;
      } else if (nx.t === 'item') {
        if (blank) idx++;
        else if (nx.children.length === 0 && nx.pendingBlank) {
          // an empty item followed by a blank line takes no further
          // content; the next line belongs outside the list
          break;
        }
        else if (matchItemIndent(c, nx)) idx++;
        else {
          // A line inside an open fenced code block is code content even
          // when its indent does not match the item (e.g. a line at
          // column 0), so it never closes the block.
          if (open[open.length - 1].t === 'code' && open[open.length - 1].fenced) {
            idx = open.length - 1; lazyLine = true;
          } else {
          // lazy continuation inside a list item's paragraph, but only for
          // plain paragraph text: a line that starts a block that can
          // interrupt a paragraph (a new list item, a heading, ...) belongs
          // outside the item instead. Any list marker counts here, even an
          // ordered one that does not start at 1 (it still opens a new item
          // of the enclosing list rather than continuing the paragraph).
          const probe = { s: c.s, i: c.i, col: c.col };
          const startsList = !!matchListMarker(probe);
          if (open[open.length - 1].t === 'paragraph' && !startsList && !interruptsParagraph(c, state, true)) { idx = open.length - 1; lazyLine = true; }
          }
          break;
        }
      } else break;
    }
    // If the deepest matched container is a list but the line neither
    // starts a new item of that list nor continues one of its items, the
    // line belongs to the list's parent instead: step back out of the
    // list so the container (and the loose marking) is the parent item.
    while (idx > 0 && open[idx].t === 'list' && !blank) {
      const probe = { s: c.s, i: c.i, col: c.col };
      const lm = matchListMarker(probe);
      const list = open[idx];
      const startsItem = !!lm && ((lm.kind === 'bullet' && list.marker === lm.marker) ||
        (lm.kind === 'ordered' && list.delim === lm.marker));
      if (startsItem) break;
      idx--;
    }
    // Close every open block past the deepest matched container. A leaf
    // whose parent still matched stays open: phase 3 decides whether the
    // line continues it.
    while (open.length > idx + 1) {
      const top = open[open.length - 1];
      if (!isContainer(top) && open.length - 2 <= idx) break;
      const gone = open.pop();
      gone.open = false;
      closeNode(gone, state);
    }
    const container = open[open.length - 1];
    // a line that becomes blank only after its container markers are
    // consumed (e.g. >> inside a blockquote) is a blank line too, but
    // only when nothing is left after the markers: a line like >  keeps
    // its trailing space as paragraph content
    blank = rawBlank || c.i >= c.s.length;
    // A blank line inside an item, followed by more content in that item
    // or by a new item of the same list, makes its list loose. The item
    // that held the blank line may already have been closed by phase 1
    // (when the new line starts a fresh item), so check the items of the
    // list the line belongs to as well as the still-open ones.
    if (!blank) {
      for (const b of open) {
        // only the item the new line directly belongs to can be
        // loosened by the blank: a blank deep inside a nested item
        // does not loosen the outer lists. A blank that is blank only
        // after its container markers (pendingBlankInner) loosens the
        // list only when the new line is content inside the same item,
        // not when it starts a new item of the list.
        if (b.t === 'item' && (b.pendingBlank || b.pendingBlankInner) && b === container) {
          if (b.parent) b.parent.loose = true;
          b.pendingBlank = false;
          b.pendingBlankInner = false;
        }
      }
      // A blank line that was consumed inside a nested item does not
      // loosen the ancestor items: the blank separates two blocks of
      // the nested item, not two children of the ancestor. Clear the
      // pending blank on every ancestor item that has a nested item
      // between it and this line's container (a blockquote between
      // them does not count: the blank is still inside the ancestor).
      {
        let seenItem = container.t === 'item';
        let p = container.parent;
        while (p) {
          if (p.t === 'item') {
            if (seenItem) { p.pendingBlank = false; p.pendingBlankInner = false; }
            seenItem = true;
          }
          p = p.parent;
        }
      }
      let list = null;
      if (container.t === 'list') list = container;
      else if (container.parent && container.parent.t === 'list') list = container.parent;
      else if (container.parent && container.parent.t === 'item' && container.parent.parent && container.parent.parent.t === 'list') list = container.parent.parent;
      if (list) {
        // only a line that actually belongs to this list (a new item of
        // it, or content in one of its still-open items) makes it loose;
        // a line outside the list does not, even after a blank line
        const probe = { s: c.s, i: c.i, col: c.col };
        const lm = matchListMarker(probe);
        const belongs = !!lm && ((lm.kind === 'bullet' && list.marker === lm.marker) ||
          (lm.kind === 'ordered' && list.delim === lm.marker));
        const openItem = open.some((b) => b.t === 'item' && b.parent === list);
        if (belongs || openItem) {
          for (const it of list.children) {
            if (it.t === 'item' && it.pendingBlank) {
              list.loose = true;
              it.pendingBlank = false;
            }
          }
        } else {
          for (const it of list.children) {
            if (it.t === 'item') { it.pendingBlank = false; it.pendingBlankInner = false; }
          }
        }
      }
    }
    // Phase 2: blank lines.
    if (blank) {
      const leaf = isContainer(container) ? lastChild(container) : container;
      if (leaf && leaf.t === 'table' && c.s.slice(c.i).length > 0) {
        // a whitespace-only line inside a table (e.g. a lone tab) is a
        // table row of empty cells, not a blank line ending the table
        leaf.rows.push(splitRow(c.s.slice(c.i)));
        state.lastLineBlank = true;
        continue;
      }
      if (leaf && leaf.t === 'code' && leaf.open) {
        // a whitespace-only line inside a code block keeps whatever is
        // left after the code indent is removed (so a line of 6 spaces
        // inside an indented block contributes 2 spaces, and a line of 2
        // spaces inside a fenced block stays 2 spaces). A leading tab
        // expands only in a fenced block.
        const rest = removeIndent(c, leaf.fenced ? leaf.indent : 4);
        leaf.lines.push(leaf.fenced ? expandTabs(rest, c.col) : rest);
      } else if (leaf && leaf.t === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5 && !htmlBlockEnded(leaf)) {
        // HTML blocks of types 1-5 continue across blank lines, but only
        // while they have not ended yet; once the end marker is seen the
        // block is closed and a blank line ends it
        leaf.lines.push('');
      } else {
        // a truly empty line after an HTML block suppresses its trailing
        // newline, even when the block already ended on an earlier line
        // (a type 1-5 block is popped as soon as its end marker is
        // seen, so it is closed before the blank line arrives). A
        // whitespace-only line (e.g. a lone tab) does not suppress it.
        if (leaf && leaf.t === 'html' && c.s.slice(c.i).length === 0) leaf.blankAfter = true;
        if (leaf && leaf.open) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, state);
        }
        // only a line that is blank on its own (not merely blank after
        // its container markers, like a lone >) can make a list loose
        // between items. A blank line anywhere inside an item can loosen
        // its list, so every open item is marked, not just the innermost
        // one. A line that is blank only after its container markers
        // still loosens the list when the next line is more content
        // inside the same item (pendingBlankInner), but not when the next
        // line starts a new item of the list.
        if (rawBlank) {
          for (let k = open.length - 1; k >= 0; k--) {
            if (open[k].t === 'item') open[k].pendingBlank = true;
          }
        } else if (blank) {
          for (let k = open.length - 1; k >= 0; k--) {
            if (open[k].t === 'item') open[k].pendingBlankInner = true;
          }
        }
      }
      state.lastLineBlank = true;
      continue;
    }
    state.lastLineBlank = false;
    // Phase 3: an open leaf block may take the line. The leaf is the top
    // of the open stack itself when it is a leaf, or the last child of the
    // open container.
    let leaf = isContainer(container) ? lastChild(container) : container;
    if (leaf && leaf.open) {
      if (leaf.t === 'paragraph') {
        stripDefs(leaf, state);
        if (!leaf.lines.length) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, state);
          leaf = null;
        }
      }
      if (leaf && leaf.t === 'paragraph') {
        const st = lazyLine ? 0 : matchSetext(c);
        const delim = !lazyLine && isTableDelim(c);
        if (st || delim) {
          // strip any leading definitions first: a paragraph that is
          // only definitions has no text for a setext underline or a
          // table header to attach to, so === or |---| here is literal
          // text. Only strip once the line is known to be a setext or
          // table line, so a definition still waiting for its title on
          // a later line is not cut short.
          stripDefs(leaf, state, true);
        }
        if (st && leaf.lines.length) {
          leaf.t = 'heading';
          leaf.level = st;
          // a setext heading's text has no leading or trailing whitespace
          leaf.text = leaf.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          delete leaf.lines;
          const gone = open.pop();
          gone.open = false;
          continue;
        }
        if (delim && leaf.lines.length === 1) {
          const header = splitRow(leaf.lines[0]);
          const delims = splitRow(c.s.slice(c.i));
          // the delimiter row must have exactly as many cells as the
          // header, or this is not a table at all
          if (delims.length !== header.length) {
            leaf.lines.push(c.s.slice(c.i));
            continue;
          }
          const aligns = delims.map((d) => {
            const t = d.trim();
            if (t.startsWith(':') && t.endsWith(':')) return 'center';
            if (t.endsWith(':')) return 'right';
            if (t.startsWith(':')) return 'left';
            return null;
          });
          leaf.t = 'table';
          leaf.header = header;
          leaf.align = aligns;
          leaf.rows = [];
          delete leaf.lines;
          continue;
        }
        if (interruptsParagraph(c, state, !!(leaf.parent && leaf.parent.t !== 'document'))) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, state);
          leaf = null;
        } else {
          let text = c.s.slice(c.i);
          if (lazyLine) {
            // a lazy continuation line loses its leading indent: it had
            // no container markers, so the indent is not part of the text
            let cut = 0;
            while (cut < text.length && (text[cut] === ' ' || text[cut] === '\t')) cut++;
            text = text.slice(cut);
          }
          leaf.lines.push(text);
          continue;
        }
      }
      if (leaf && leaf.t === 'code' && leaf.fenced) {
        if (isClosingFence(c, leaf)) {
          const gone = open.pop();
          gone.open = false;
          continue;
        }
        // a fenced code line expands a leading tab to spaces by column;
        // an indented code line keeps its tabs literally
        const rest = removeIndent(c, leaf.indent);
        leaf.lines.push(expandTabs(rest, c.col));
        continue;
      }
      if (leaf && leaf.t === 'code' && !leaf.fenced) {
        if (indentOf(c) >= 4) {
          leaf.lines.push(removeIndent(c, 4));
          continue;
        }
        const gone = open.pop();
        gone.open = false;
        closeNode(gone, state);
        leaf = null;
      }
      if (leaf && leaf.t === 'html') {
        if (leaf.htmlType >= 1 && leaf.htmlType <= 5 && htmlBlockEnded(leaf)) {
          // the block already ended on an earlier line; close it and let
          // this line start something new
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, state);
          leaf = null;
        } else {
          leaf.lines.push(c.s.slice(c.i));
          if (leaf.htmlType >= 1 && leaf.htmlType <= 5 && htmlBlockEnded(leaf)) {
            const gone = open.pop();
            gone.open = false;
          }
          continue;
        }
      }
      if (leaf && leaf.t === 'table') {
        // a line that starts a new block (a blockquote here, or a fenced
        // code block) ends the table instead of becoming a row
        let ti = c.i;
        while (ti < c.s.length && c.s[ti] === ' ') ti++;
        if (c.s[ti] === '>' || matchFence(c)) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, state);
          leaf = null;
        } else {
          // every other non-blank line is a table row, even one without
          // pipes (it becomes a single cell, padded with empty cells)
          leaf.rows.push(splitRow(c.s.slice(c.i)));
          continue;
        }
      }
    }
    // Phase 4: start new blocks. The container is the current top of the
    // open stack (phase 3 may have closed the leaf that was on top).
    let cont = open[open.length - 1];
    let startedLeaf = false;
    while (true) {
      if (blankRest(c)) break;
      // A list only stays open while the line starts one of its items; a
      // line that does not closes the list and belongs to the parent. A
      // thematic break is not a list item, even when it starts with a
      // marker character.
      if (cont.t === 'list') {
        const probe = { s: c.s, i: c.i, col: c.col };
        const m = matchListMarker(probe);
        const same = m && !isThematic(c) && ((m.kind === 'bullet' && cont.marker === m.marker) ||
          (m.kind === 'ordered' && cont.delim === m.marker));
        if (!same) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, state);
          cont = cont.parent;
          continue;
        }
      }
      const started = startBlock(c, cont, state, open);
      if (!started) break;
      if (isContainer(started)) {
        cont = started;
        if (open[open.length - 1] !== started) open.push(started);
        continue;
      }
      // a leaf block: headings and thematic breaks are complete at once,
      // the rest stay open to take following lines
      if (started.t !== 'heading' && started.t !== 'thematic_break') {
        started.open = true;
        open.push(started);
      }
      startedLeaf = true;
      break;
    }
    // Phase 5: nothing started a leaf, so start a paragraph.
    const top = open[open.length - 1];
    if (!startedLeaf && isContainer(top) && !blankRest(c)) {
      const p = addChild(cont, mkNode('paragraph', { lines: [c.s.slice(c.i)] }));
      p.open = true;
      open.push(p);
      stripDefs(p, state);
      if (!p.lines.length) {
        const gone = open.pop();
        gone.open = false;
        closeNode(gone, state);
      }
    }
  }
  while (open.length > 1) {
    const gone = open.pop();
    gone.open = false;
    closeNode(gone, state);
  }
  return doc;
}

// Has an HTML block of type 1-4 reached its end marker?
function htmlBlockEnded(leaf) {
  const text = leaf.lines.join('\n');
  if (leaf.htmlType === 1) return /<\/(pre|script|style|textarea)/i.test(text);
  if (leaf.htmlType === 2) return text.indexOf('-->') >= 0;
  if (leaf.htmlType === 3) return text.indexOf('?>') >= 0;
  if (leaf.htmlType === 4) return text.indexOf('>') >= 0;
  if (leaf.htmlType === 5) return text.indexOf(']]>') >= 0;
  return false;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// A node list is a plain array; delimiter nodes live in it and are also
// listed (by reference, in scan order) in the delims array of the same parse.
function parseInline(src, state) {
  const nodes = [];
  const delims = [];
  let pos = 0;
  const n = src.length;

  const flush = (buf) => {
    if (buf.length) nodes.push({ t: 'text', s: buf });
  };
  let buf = '';

  const isNextWs = (p) => p >= n || isWhitespace(src[p]);

  while (pos < n) {
    const ch = src[pos];
    // backslash escape
    if (ch === '\\' && pos + 1 < n) {
      const nx = src[pos + 1];
      if (nx === '\n') {
        flush(buf); buf = '';
        nodes.push({ t: 'br', hard: true });
        pos += 2;
        // after a hard break the next line loses its leading indent
        while (pos < n && (src[pos] === ' ' || src[pos] === '\t')) pos++;
        continue;
      }
      if (ASCII_PUNCT.indexOf(nx) >= 0) {
        buf += nx;
        pos += 2;
        continue;
      }
      buf += '\\';
      pos++;
      continue;
    }
    // code span
    if (ch === '`') {
      let run = 0;
      while (pos + run < n && src[pos + run] === '`') run++;
      let close = -1;
      let j = pos + run;
      while (j < n) {
        const k = src.indexOf('`', j);
        if (k < 0) break;
        let rl = 0;
        while (k + rl < n && src[k + rl] === '`') rl++;
        if (rl === run) { close = k; break; }
        j = k + rl;
      }
      if (close < 0) {
        buf += '`'.repeat(run);
        pos += run;
        continue;
      }
      let content = src.slice(pos + run, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush(buf); buf = '';
      nodes.push({ t: 'code', s: content });
      pos = close + run;
      continue;
    }
    // < ... > : autolink, then raw HTML
    if (ch === '<') {
      const auto = tryAutolink(src, pos);
      if (auto) {
        flush(buf); buf = '';
        nodes.push(auto.node);
        pos = auto.end;
        continue;
      }
      const tag = tryHtmlInline(src, pos);
      if (tag) {
        flush(buf); buf = '';
        nodes.push({ t: 'html', s: tag.text });
        pos = tag.end;
        continue;
      }
      buf += '<';
      pos++;
      continue;
    }
    // link or image
    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const link = tryLink(src, pos, state);
      if (link) {
        flush(buf); buf = '';
        nodes.push(link.node);
        pos = link.end;
        continue;
      }
      buf += ch;
      pos++;
      continue;
    }
    // emphasis / strikethrough delimiters
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (pos + run < n && src[pos + run] === ch) run++;
      // a strikethrough delimiter is one or two tildes; any longer run
      // of ~ is literal text (~~~ does not strike)
      if (ch === '~' && run > 2) {
        buf += src.slice(pos, pos + run);
        pos += run;
        continue;
      }
      // the start and end of the text count as whitespace for flanking
      const before = pos > 0 ? src[pos - 1] : ' ';
      const after = pos + run < n ? src[pos + run] : ' ';
      const leftFlanking = !isWhitespace(after) && (!isPunct(after) || isWhitespace(before) || isPunct(before));
      const rightFlanking = !isWhitespace(before) && (!isPunct(before) || isWhitespace(after) || isPunct(after));
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlanking && (!rightFlanking || isPunct(before));
        canClose = rightFlanking && (!leftFlanking || isPunct(after));
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush(buf); buf = '';
      const d = { t: 'delim', c: ch, n: run, canOpen, canClose, active: true };
      nodes.push(d);
      delims.push(d);
      pos += run;
      continue;
    }
    // entity
    if (ch === '&') {
      const ent = tryEntity(src, pos);
      if (ent) {
        flush(buf); buf = '';
        nodes.push(ent.node);
        pos = ent.end;
        continue;
      }
      buf += '&';
      pos++;
      continue;
    }
    // newline: soft or hard break
    if (ch === '\n') {
      flush(buf); buf = '';
      // hard break when the line ends with two or more spaces
      let spaces = 0;
      let k = nodes.length ? nodes.length - 1 : -1;
      if (k >= 0 && nodes[k].t === 'text') {
        const s = nodes[k].s;
        let m = s.length;
        while (m > 0 && s[m - 1] === ' ') { spaces++; m--; }
        if (spaces >= 2) nodes[k].s = s.slice(0, m);
      }
      nodes.push({ t: 'br', hard: spaces >= 2 });
      pos++;
      // after a hard break the next line loses its leading indent
      if (spaces >= 2) {
        while (pos < n && (src[pos] === ' ' || src[pos] === '\t')) pos++;
      }
      continue;
    }
    // extended autolink (GFM): www., scheme://, email. An extended
    // autolink only starts after the start of the text, whitespace, or one
    // of these characters: * _ ~ ( [ { < " '
    const prev = pos === 0 ? '' : src[pos - 1];
    const canStart = pos === 0 || prev === ' ' || prev === '\t' || prev === '\n' ||
      '*_~([{<"\''.indexOf(prev) >= 0;
    if (canStart && !state.noAutolink) {
      const ext = tryExtAutolink(src, pos);
      if (ext) {
        flush(buf); buf = '';
        nodes.push(ext.node);
        pos = ext.end;
        continue;
      }
    }
    buf += ch;
    pos++;
  }
  flush(buf);
  processEmphasis(nodes, delims);
  return nodes;
}

// Try to match an entity reference at pos. Numeric references decode to a
// character; named references are passed through literally.
function tryEntity(src, pos) {
  const m = /^&#([Xx][0-9A-Fa-f]{1,6}|[0-9]{1,7});/.exec(src.slice(pos));
  if (m) {
    return { node: { t: 'text', s: decodeNumeric(m[1]) }, end: pos + m[0].length };
  }
  const m2 = /^&([A-Za-z][A-Za-z0-9]*);/.exec(src.slice(pos));
  if (m2) {
    return { node: { t: 'entity', s: m2[0] }, end: pos + m2[0].length };
  }
  return null;
}

// Try <scheme:...> or <email> at pos.
function tryAutolink(src, pos) {
  const rest = src.slice(pos);
  let m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
  if (m) {
    // the href is URL-cleaned; the link text keeps the raw destination
    const dest = cleanUrl(m[1]);
    if (dest === null) return null;
    return { node: { t: 'link', dest, title: null, children: [{ t: 'text', s: m[1] }] }, end: pos + m[0].length };
  }
  m = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest);
  if (m) {
    const dest = 'mailto:' + m[1];
    return { node: { t: 'link', dest, title: null, children: [{ t: 'text', s: m[1] }] }, end: pos + m[0].length };
  }
  return null;
}

// Try raw HTML (comment, PI, declaration, CDATA, tag) at pos.
// Match an HTML comment at the start of s: <!-->, <!--->, or <!--...-->
// up to the first -->. Returns the match or null.
function matchComment(s) {
  if (s.startsWith('<!-->')) return '<!-->';
  if (s.startsWith('<!--->')) return '<!--->';
  const m = /^<!--[\s\S]*?-->/.exec(s);
  return m ? m[0] : null;
}

function tryHtmlInline(src, pos) {
  const s = src.slice(pos);
  const com = matchComment(s);
  if (com) return { text: com, end: pos + com.length };
  let m = /^<\?[\s\S]*?\?>/.exec(s);
  if (m) return { text: m[0], end: pos + m[0].length };
  m = /^<![A-Z][\s\S]*?>/.exec(s);
  if (m) return { text: m[0], end: pos + m[0].length };
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(s);
  if (m) return { text: m[0], end: pos + m[0].length };
  const tag = matchHtmlTag(s);
  if (tag) return { text: s.slice(0, tag.end), end: pos + tag.end };
  return null;
}

// Find the matching ] for the [ at labelStart, counting nested brackets.
// A ] inside a backslash escape, a code span, or an HTML tag (whose quoted
// attribute values may contain ]) does not end the label. Returns the index
// of ] or -1.
// Find the index of the ] that ends a link label starting at src[start]
// (the character after the [). A label ends at the first unescaped ];
// unlike the link text it may not hold a nested bracket pair. Returns -1
// when there is no closing ].
function findLabelEndFlat(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === ']') return i;
    i++;
  }
  return -1;
}

function findLabelEnd(src, labelStart) {
  let depth = 1;
  let i = labelStart;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (i + run < src.length && src[i + run] === '`') run++;
      const close = findCodeClose(src, i + run, run);
      if (close >= 0) { i = close; continue; }
      i += run;
      continue;
    }
    if (ch === '<') {
      const tagEnd = skipHtmlTag(src, i);
      if (tagEnd >= 0) { i = tagEnd; continue; }
      // an angle autolink <scheme:...> or <email> also spans the label:
      // skip past its closing > so a ] inside it does not end the label
      const am = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/.exec(src.slice(i)) ||
        /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/.exec(src.slice(i));
      if (am) { i += am[0].length; continue; }
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Find the end of a code span that opens with a run of `run` backticks at
// or after start: the index just past the closing run of the same length,
// or -1 when there is none.
function findCodeClose(src, start, run) {
  let j = start;
  while (j < src.length) {
    const k = src.indexOf('`', j);
    if (k < 0) return -1;
    let r = 0;
    while (k + r < src.length && src[k + r] === '`') r++;
    if (r === run) return k + r;
    j = k + r;
  }
  return -1;
}

// Skip an HTML construct (comment, PI, declaration, CDATA, or tag) at pos,
// returning the index just past it, or -1 when there is none. A tag's
// quoted attribute values are skipped whole, so a ] inside one does not
// end a link label.
function skipHtmlTag(src, pos) {
  const s = src.slice(pos);
  const com = matchComment(s);
  if (com) return pos + com.length;
  let m = /^<\?[\s\S]*?\?>/.exec(s);
  if (m) return pos + m[0].length;
  m = /^<![A-Z][\s\S]*?>/.exec(s);
  if (m) return pos + m[0].length;
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(s);
  if (m) return pos + m[0].length;
  const tag = matchHtmlTag(s);
  if (tag) return pos + tag.end;
  return -1;
}

// Parse a link destination + optional title starting at pos (which must be
// at '('). Returns {dest, title, end} or null.
function parseLinkTarget(src, pos) {
  let p = pos + 1;
  const n = src.length;
  const skipWs = () => { while (p < n && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++; };
  skipWs();
  if (p >= n) return null;
  let dest = '';
  if (src[p] === '<') {
    // an angle-bracket destination ends at an unescaped >; a \> is part
    // of the destination, so <foo\> has no closing > and is not a link
    let q = p + 1;
    while (q < n && src[q] !== '\n') {
      if (src[q] === '\\' && q + 1 < n) { q += 2; continue; }
      if (src[q] === '<') return null;
      if (src[q] === '>') break;
      q++;
    }
    if (q >= n || src[q] !== '>') return null;
    dest = src.slice(p + 1, q);
    p = q + 1;
  } else {
    let parens = 0;
    const start = p;
    while (p < n) {
      const ch = src[p];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
      if (ch === '\\' && p + 1 < n) { p += 2; continue; }
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      }
      p++;
    }
    dest = src.slice(start, p);
  }
  dest = unescapeText(dest);
  dest = decodeEntitiesInText(dest);
  skipWs();
  let title = null;
  if (p < n && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
    const open = src[p];
    const close = open === '(' ? ')' : open;
    p++;
    let t = '';
    let ok = false;
    while (p < n) {
      const ch = src[p];
      if (ch === '\\' && p + 1 < n && ASCII_PUNCT.indexOf(src[p + 1]) >= 0) { t += src[p + 1]; p += 2; continue; }
      if (ch === close) { ok = true; p++; break; }
      if (ch === '\n') break;
      t += ch;
      p++;
    }
    if (!ok) return null;
    title = t;
    title = decodeEntitiesInText(title);
    skipWs();
  }
  if (p >= n || src[p] !== ')') return null;
  return { dest, title, end: p + 1 };
}

// Decode numeric character references inside a string (named ones stay).
function decodeEntitiesInText(s) {
  return s.replace(/&#([Xx][0-9A-Fa-f]{1,6}|[0-9]{1,7});/g, (m, body) => decodeNumeric(body));
}

// Does the node tree contain a link node anywhere?
function containsLink(nodes) {
  for (const node of nodes) {
    if (node.t === 'link') return true;
    if (node.children && containsLink(node.children)) return true;
  }
  return false;
}

// Try to parse a link (or image, when src[pos] is '!') at pos.
function tryLink(src, pos, state) {
  const isImage = src[pos] === '!';
  const open = isImage ? pos + 1 : pos;
  const labelStart = open + 1;
  const labelEnd = findLabelEnd(src, labelStart);
  if (labelEnd < 0) return null;
  const label = src.slice(labelStart, labelEnd);
  let j = labelEnd + 1;
  const n = src.length;
  const skipWs = () => { while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++; };
  let dest = null;
  let title = null;
  let end = -1;
  // an inline link's ( must immediately follow the ] (no whitespace)
  if (j < n && src[j] === '(') {
    const tgt = parseLinkTarget(src, j);
    if (tgt) {
      dest = tgt.dest;
      title = tgt.title;
      end = tgt.end;
    }
  }
  if (dest === null) {
    // fall back to the reference forms: [label][ref], [label][], [label].
    // The second [ must immediately follow the text ]: [foo] [bar] is
    // not a link, it is a shortcut [bar] after a literal [foo].
    j = labelEnd + 1;
    let refLabel = null;
    if (j < n && src[j] === '[') {
      const refEnd = findLabelEndFlat(src, j + 1);
      if (refEnd < 0) return null;
      refLabel = src.slice(j + 1, refEnd);
      // a reference label may not hold an unescaped [; without a usable
      // label this is a shortcut [label] instead
      if (hasUnescapedBracket(refLabel)) {
        refLabel = label;
        end = labelEnd + 1;
      } else {
        end = refEnd + 1;
      }
    } else {
      refLabel = label;
      end = labelEnd + 1;
    }
    const def = state.refs.get(normalizeLabel(refLabel === '' ? label : refLabel));
    if (!def) return null;
    dest = def.dest;
    title = def.title;
  }
  // Parse the label's inline content on its own. A link whose label holds
  // another link does not form (the inner one wins); an image's label may
  // hold a link, and the link's text becomes part of the alt text.
  // An extended autolink (www./email/scheme) inside the label is
  // suppressed while parsing it, so it stays plain text and does not
  // block the outer link; an angle autolink <...> inside the label still
  // forms and blocks the outer link.
  const savedNoAuto = state.noAutolink;
  state.noAutolink = true;
  const children = parseInline(label, state);
  state.noAutolink = savedNoAuto;
  if (!isImage && containsLink(children)) return null;
  const cleaned = cleanUrl(dest);
  if (cleaned === null) return null;
  const node = isImage
    ? { t: 'image', dest: cleaned, title, children }
    : { t: 'link', dest: cleaned, title, children };
  return { node, end };
}

// GFM extended autolinks: www., scheme://, and bare email addresses.
function tryExtAutolink(src, pos) {
  const rest = src.slice(pos);
  let m;
  if (rest.startsWith('www.')) {
    m = /^(www\.(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}[^\s<>]*)/.exec(rest);
    if (m) {
      const text = trimAutolinkTail(m[1]);
      if (!text) return null;
      const dest = cleanUrl('http://' + text);
      if (dest === null) return null;
      return { node: { t: 'link', dest, title: null, children: [{ t: 'text', s: text }] }, end: pos + text.length };
    }
    return null;
  }
  // a scheme autolink is scheme: followed by any run of non-space,
  // non-< characters (no // needed: mailto: and xmpp: count too). The
  // first character after the : must start an address (a letter, digit
  // or /), so a bare data: or many: is not an autolink.
  m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}:[A-Za-z0-9\/][^\s<>]*)/.exec(rest);
  if (m) {
    const rawText = m[1];
    const schemeEnd = rawText.indexOf(':');
    const scheme = rawText.slice(0, schemeEnd).toLowerCase();
    const afterScheme = rawText.slice(schemeEnd + 1);
    let text;
    if (scheme === 'mailto') {
      // mailto: takes an email address only, no path: match the email
      // on the raw text, so a trailing - or _ voids the whole autolink
      // instead of being trimmed away first
      const em = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)/.exec(afterScheme);
      if (!em) return null;
      const after = afterScheme[em[1].length];
      if (after && /[A-Za-z0-9_-]/.test(after)) return null;
      text = 'mailto:' + em[1];
    } else {
      text = trimAutolinkTail(rawText);
      if (!text) return null;
      if (!afterScheme.startsWith('//')) {
        // a scheme without // takes an address with at most one path
        // segment (xmpp:user@host/res, but not /res/more)
        const firstSlash = text.indexOf('/', schemeEnd + 1);
        if (firstSlash >= 0) {
          const secondSlash = text.indexOf('/', firstSlash + 1);
          if (secondSlash >= 0) text = text.slice(0, secondSlash);
        }
      }
    }
    const dest = cleanUrl(text);
    if (dest === null) return null;
    return { node: { t: 'link', dest, title: null, children: [{ t: 'text', s: text }] }, end: pos + text.length };
  }
  m = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)/.exec(rest);
  if (m) {
    const text = trimAutolinkTail(m[1]);
    if (!text) return null;
    // a trailing - or _ (or letter/digit) after the match means the
    // word continues and this is not an autolink at all. But a _ that is
    // a closing emphasis delimiter (followed by whitespace or
    // punctuation) does not continue the word, so it does not void the
    // autolink; only a _ followed by a word character, or a _ at the
    // very end, voids it
    const after = rest[text.length];
    if (after && after !== '_' && /[A-Za-z0-9_-]/.test(after)) return null;
    if (after === '_') {
      const next = rest[text.length + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
    }
    return { node: { t: 'link', dest: 'mailto:' + text, title: null, children: [{ t: 'text', s: text }] }, end: pos + text.length };
  }
  return null;
}

// Trim trailing punctuation from an extended autolink, per the GFM rules.
function trimAutolinkTail(text) {
  let end = text.length;
  // strip a trailing entity-like ; (e.g. &amp;)
  while (end > 0) {
    const ch = text[end - 1];
    if ('?!.,:*_~'.indexOf(ch) >= 0) { end--; continue; }
    if (ch === ';') {
      // an entity-like ending (&name;) is cut from the &; any other
      // trailing ; is trailing punctuation and is cut too
      const amp = text.lastIndexOf('&', end - 1);
      if (amp >= 0 && /^&[A-Za-z][A-Za-z0-9]*;$/.test(text.slice(amp, end))) { end = amp; continue; }
      end--; continue;
    }
    if (ch === ')') {
      const opens = (text.slice(0, end).match(/\(/g) || []).length;
      const closes = (text.slice(0, end).match(/\)/g) || []).length;
      if (closes > opens) { end--; continue; }
      break;
    }
    if (ch === ']') {
      const opens = (text.slice(0, end).match(/\[/g) || []).length;
      const closes = (text.slice(0, end).match(/\]/g) || []).length;
      if (closes > opens) { end--; continue; }
      break;
    }
    break;
  }
  return text.slice(0, end);
}

// The delimiter-stack emphasis algorithm (CommonMark spec, phase 2).
function processEmphasis(nodes, delims) {
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.active || !closer.canClose) continue;
    const c = closer.c;
    // find the nearest earlier opener of the same character that can still
    // pair with this closer
    let opener = null;
    let oi = -1;
    for (let k = di - 1; k >= 0; k--) {
      const d = delims[k];
      if (!d.active || d.c !== c || !d.canOpen) continue;
      // the rule of three: when both can open and close, the sum of the
      // lengths must not be a multiple of three (unless both are)
      if ((d.canClose || closer.canOpen) && (d.n + closer.n) % 3 === 0 && (d.n % 3 !== 0 || closer.n % 3 !== 0)) continue;
      // there must be at least one node between them
      const oiPos = nodes.indexOf(d);
      const ciPos = nodes.indexOf(closer);
      if (oiPos < 0 || ciPos < 0 || ciPos - oiPos < 2) continue;
      opener = d;
      oi = k;
      break;
    }
    if (!opener) continue;
    const use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    const tag = c === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const oiPos = nodes.indexOf(opener);
    const ciPos = nodes.indexOf(closer);
    const inner = nodes.slice(oiPos + 1, ciPos);
    const wrap = { t: tag, children: inner };
    nodes.splice(oiPos + 1, ciPos - oiPos - 1, wrap);
    opener.n -= use;
    closer.n -= use;
    if (opener.n === 0) {
      opener.active = false;
      const p = nodes.indexOf(opener);
      if (p >= 0) nodes.splice(p, 1);
    }
    if (closer.n === 0) {
      closer.active = false;
      const p = nodes.indexOf(closer);
      if (p >= 0) nodes.splice(p, 1);
    } else {
      // the closer still has length left: let it match another opener
      di--;
    }
  }
  // any delimiter left over becomes literal text, including delimiters
  // that ended up inside an emphasis wrapper
  const finalize = (list) => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].t === 'delim') {
        list[i] = { t: 'text', s: list[i].c.repeat(list[i].n) };
      } else if (list[i].children) {
        finalize(list[i].children);
      }
    }
  };
  finalize(nodes);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text') out += escapeText(node.s);
    else if (node.t === 'entity') out += node.s;
    else if (node.t === 'code') out += '<code>' + escapeCode(node.s) + '</code>';
    else if (node.t === 'html') out += node.s;
    else if (node.t === 'br') out += node.hard ? '<br>' : '\n';
    else if (node.t === 'em') out += '<em>' + renderInline(node.children) + '</em>';
    else if (node.t === 'strong') out += '<strong>' + renderInline(node.children) + '</strong>';
    else if (node.t === 'del') out += '<del>' + renderInline(node.children) + '</del>';
    else if (node.t === 'link') {
      out += '<a href="' + escapeAttr(node.dest) + '"';
      if (node.title !== null && node.title !== undefined) out += ' title="' + escapeAttr(node.title) + '"';
      out += '>' + renderInline(node.children) + '</a>';
    } else if (node.t === 'image') {
      out += '<img src="' + escapeAttr(node.dest) + '" alt="' + escapeText(plainText(node.children)) + '"';
      if (node.title !== null && node.title !== undefined) out += ' title="' + escapeAttr(node.title) + '"';
      out += '>';
    }
  }
  return out;
}

// Plain text of inline nodes, for image alt text: formatting is dropped,
// code stays literal, links and images give their text.
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text' || node.t === 'entity') out += node.s;
    else if (node.t === 'code') out += node.s;
    else if (node.t === 'br') out += '\n';
    else if (node.children) out += plainText(node.children);
  }
  return out;
}

function renderBlocks(node, state) {
  let out = '';
  for (const child of node.children) out += renderBlock(child, state);
  return out;
}

function renderBlock(node, state) {
  switch (node.t) {
    case 'paragraph':
      return '<p>' + renderInline(parseInline(node.lines.join('\n'), state)) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + renderInline(parseInline(node.text, state)) + '</h' + node.level + '>\n';
    case 'code': {
      // trailing blank lines are not part of an indented code block, but
      // blank lines before a closing fence are content of a fenced block
      let lines = node.lines;
      if (!node.fenced) {
        let end = lines.length;
        while (end > 0 && lines[end - 1] === '') end--;
        lines = lines.slice(0, end);
      }
      let content = lines.join('\n');
      if (content.length && !content.endsWith('\n')) content += '\n';
      if (node.fenced && node.info) {
        const lang = node.info.split(/\s+/)[0];
        return '<pre><code class="language-' + escapeAttr(lang) + '">' + escapeCode(content) + '</code></pre>\n';
      }
      return '<pre><code>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'html': {
      // HTML blocks of types 1-5 end with their end marker and keep the
      // line break after it; types 6-7 (which end at a blank line) have a
      // trailing newline only when they are the last block of the document
      // and the source itself ends with a newline. A block followed by a
      // blank line keeps no trailing newline.
      const sibs = node.parent && node.parent.t === 'document' ? node.parent.children : [];
      const isLastDoc = sibs.length && sibs[sibs.length - 1] === node;
      const trailing = ((node.htmlType >= 1 && node.htmlType <= 5) || (isLastDoc && state.srcEndsWithNewline)) && !node.blankAfter;
      return node.lines.join('\n') + (trailing ? '\n' : '');
    }
    case 'thematic_break':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(node, state) + '</blockquote>\n';
    case 'list': {
      const tag = node.kind === 'ordered' ? 'ol' : 'ul';
      const open = node.kind === 'ordered' && node.start !== 1 ? '<ol start="' + node.start + '">\n' : '<' + tag + '>\n';
      return open + renderBlocks(node, state) + '</' + tag + '>\n';
    }
    case 'item':
      return '<li>' + renderItem(node, state) + '</li>\n';
    case 'table':
      return renderTable(node, state);
    default:
      return renderBlocks(node, state);
  }
}

// A list item's children: in a tight list, paragraphs render bare (no <p>).
// A list item's children: in a tight list, paragraphs render bare (no <p>).
// A task list item starts its first paragraph with [ ] or [x], which
// becomes a checkbox input at the start of the item (inside the <p> when
// the list is loose).
function renderItem(item, state) {
  const loose = !!(item.parent && item.parent.loose);
  let out = '';
  let first = true;
  for (const child of item.children) {
    if (child.t === 'paragraph') {
      let text = child.lines.join('\n');
      let box = '';
      if (first) {
        const m = /^\[([ xX])\] /.exec(text);
        if (m) {
          box = m[1] === ' '
            ? '<input disabled="" type="checkbox"> '
            : '<input checked="" disabled="" type="checkbox"> ';
          text = text.slice(m[0].length);
        }
      }
      const inner = renderInline(parseInline(text, state));
      out += loose ? '<p>' + box + inner + '</p>\n' : box + inner;
    } else {
      out += renderBlock(child, state);
    }
    first = false;
  }
  return out;
}

function renderTable(node, state) {
  const cell = (tag, text, align) => {
    const a = align ? ' align="' + align + '"' : '';
    return '<' + tag + a + '>' + renderInline(parseInline(text, state)) + '</' + tag + '>\n';
  };
  let out = '<table>\n<thead>\n<tr>\n';
  // the delimiter row fixes the number of columns; extra header or row
  // cells are dropped, missing ones are empty
  const ncols = node.align.length;
  for (let i = 0; i < ncols; i++) {
    out += cell('th', node.header[i] || '', node.align[i] || null);
  }
  out += '</tr>\n</thead>\n';
  // a table with no body rows has no tbody element at all
  if (!node.rows.length) return out + '</table>\n';
  out += '<tbody>';
  for (const row of node.rows) {
    out += '<tr>\n';
    for (let i = 0; i < ncols; i++) {
      out += cell('td', row[i] || '', node.align[i] || null);
    }
    out += '</tr>\n';
  }
  out += '</tbody></table>\n';
  return out;
}
