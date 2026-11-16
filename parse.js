// parse.js — a dependency-free CommonMark 0.31.2 + GFM parser, written
// from scratch in this session to match marked 18.1.3 (default options:
// gfm on, breaks off, pedantic off, async off) byte for byte on the
// practice set.
//
// Design notes (my own reconstruction):
// - Block phase builds a tree of block nodes from the source lines,
//   tracking open containers on a stack; inline phase then walks each
//   paragraph/heading/table cell and resolves links, code, entities and
//   emphasis into a node list; a final render pass turns the tree into
//   HTML. Nothing here is copied from any other parser.
// - Emphasis uses the CommonMark delimiter stack, plus one marked
//   behaviour the stack alone gets wrong: when an em pairing would
//   swallow an inner strong's delimiters, marked's outside-in scan
//   (its m/f accounting) refuses the pairing, so the outer `*`s stay
//   literal. resolveEmphasis replays that scan before accepting an
//   em pair (see markedScan).

export function parse(src) {
  const st = { defs: new Map(), inA: false };
  const tree = readBlocks(src, st);
  // Safety net: link reference definitions are stripped from paragraphs
  // as they close, but a paragraph that is split or closed early can
  // keep a definition behind, so sweep the finished tree once more and
  // collect every definition before rendering.
  sweepDefs(tree, st);
  return showBlocks(tree, st);
}

// Walk the block tree and peel leading link reference definitions off
// every paragraph. A paragraph emptied by this is cut from its parent.
function sweepDefs(nd, st) {
  if (!nd.children) return;
  for (let k = nd.children.length - 1; k >= 0; k--) {
    const kid = nd.children[k];
    if (kid.t === 'paragraph') {
      peelDefs(kid, st, true);
      if (!kid.lines.length) nd.children.splice(k, 1);
    } else {
      sweepDefs(kid, st);
    }
  }
}

// ---------------------------------------------------------------------------
// Characters and escaping
// ---------------------------------------------------------------------------

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isGap(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isPunctChar(ch) {
  if (!ch) return false;
  if (ASCII_PUNCT.indexOf(ch) >= 0) return true;
  // CommonMark punctuation is Unicode P (punctuation) or S (symbols),
  // which covers currency signs like $ £ € as well as letters' marks.
  return /[\p{P}\p{S}]/u.test(ch);
}

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ' || /\s/.test(ch);
}

// Escape text for HTML output. A bare & is always escaped, because any
// valid entity reference in the source has already been consumed as its
// own node; a & that reaches here (for example from a backslash escape)
// is literal text. < > " ' are always escaped.
const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escText(s) {
  return s.replace(/[&<>"']/g, (ch) => TEXT_ESCAPES[ch]);
}

// Escape for link destinations and titles, where a valid entity reference
// (&name; or &#digits; or &#xhex;) is left alone, as marked does.
const ENT_TAIL = /^(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]*);/;

function escAttr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    switch (ch) {
      case '&':
        out += ENT_TAIL.test(s.slice(i + 1)) ? '&' : '&amp;';
        break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case "'": out += '&#39;'; break;
      default: out += ch;
    }
  }
  return out;
}

// Escape for code spans and code blocks: every & is escaped.
function escCode(s) {
  let out = '';
  for (const ch of s) {
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Decode a numeric character reference body (the part after &# and
// before ;). Returns the character, or U+FFFD for 0, surrogates and
// out-of-range values.
function decodeNum(body) {
  let code;
  if (body[0] === 'x' || body[0] === 'X') code = parseInt(body.slice(1), 16);
  else code = parseInt(body, 10);
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  return String.fromCodePoint(code);
}

// marked cleans a link destination the way encodeURI does, except a
// literal % stays a % (encodeURI would turn it into %25 first).
function tidyUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Line cursor: one input line with a position in it, tracked in columns so
// that tabs (which jump to the next multiple of 4 columns) are handled
// the way the spec handles them. Advancing part-way through a tab turns
// the rest of the tab into spaces inside the line itself.
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

// Remove up to n leading whitespace characters from a fenced code line,
// counting each space or tab as one character. A tab is removed whole,
// never expanded to the next tab stop and partially kept (a column-based
// removal turns a tab after a 2-space fence indent into 2 spaces;
// marked turns it into nothing). Only the leading whitespace run is
// touched; a shorter run is removed whole.
function dedentFenceLine(s, n) {
  let k = 0;
  while (k < s.length && k < n && (s[k] === ' ' || s[k] === '\t')) k++;
  return s.slice(k);
}

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
  const nd = { t, children: [], parent: null };
  if (fields) Object.assign(nd, fields);
  return nd;
}

function addChild(par, kid) {
  kid.parent = par;
  par.children.push(kid);
  return kid;
}

function lastChild(nd) {
  return nd.children.length ? nd.children[nd.children.length - 1] : null;
}

function isContainer(nd) {
  return nd.t === 'document' || nd.t === 'blockquote' || nd.t === 'list' || nd.t === 'item';
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Unicode case folding for link labels: toLowerCase plus the special
// full case foldings (ẞ -> ss, ligatures -> their letters).
const FOLD_MAP = {
  '\u1E9E': 'ss', '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl',
  '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
};

function foldCase(s) {
  let out = '';
  for (const ch of s) out += FOLD_MAP[ch] || ch;
  return out.toLowerCase();
}

// True when a label holds an unescaped [ (a link label may not hold one).
function hasBareBracket(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '[') return true;
  }
  return false;
}

// Normalize a link label for lookup: collapse runs of whitespace to one
// space, trim, and case-fold. Backslash escapes are NOT removed: the raw
// label text is what matches, so [foo\!] does not match a [foo!]
// definition.
function foldLabel(label) {
  return foldCase(label.replace(/\s+/g, ' ').trim());
}

// Remove backslash escapes before ASCII punctuation from a string.
function dropBackslashes(s) {
  return s.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
}

// Try to parse one link reference definition starting at lines[k].
// A definition is: [label]: <dest> or dest, then an optional title, and
// the line must end there (the title may sit on a following line instead).
// The label, destination and the title's opening quote must all start
// within the first 3 lines, but a title may close on a later line.
// Returns { def, used, label } where used is how many lines the
// definition took, or null when the lines do not form a definition.
function readOneDef(lines, k) {
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
  if (!foldLabel(label)) return null; // a label of only whitespace
  if (hasBareBracket(label)) return null; // a label holds no [
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
  dest = dropBackslashes(dest);
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

// Strip leading link reference definitions from a paragraph's lines,
// registering them in st.defs. A definition that uses every line seen
// so far (and fewer than 3 lines) is left alone unless `final` is set:
// its title may still arrive on the next line. Idempotent: safe to call
// repeatedly.
function peelDefs(para, st, final) {
  // Lines are only removed when final is true (the paragraph is being
  // closed): splicing while the paragraph is still being built corrupts
  // the line list, so a non-final call records the definitions but
  // leaves the lines in place for the closing call to remove.
  let i = 0;
  for (;;) {
    if (i >= para.lines.length) break;
    const got = readOneDef(para.lines, i);
    if (!got) break;
    if (!final && got.used < 3 && i + got.used >= para.lines.length) break;
    const key = foldLabel(got.label);
    if (key && !st.defs.has(key)) st.defs.set(key, got.def);
    i += got.used;
  }
  if (final && i > 0) para.lines.splice(0, i);
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// A node list is a plain array; delimiter nodes live in it and are also
// listed (by reference, in scan order) in the marks array of the same parse.
function readInline(src, st) {
  const out = [];
  const marks = [];
  let pos = 0;
  const n = src.length;

  const flush = (buf) => {
    if (buf.length) out.push({ kind: 'text', txt: buf });
  };
  let buf = '';

  while (pos < n) {
    const ch = src[pos];
    // backslash escape
    if (ch === '\\' && pos + 1 < n) {
      const nx = src[pos + 1];
      if (nx === '\n') {
        flush(buf); buf = '';
        out.push({ kind: 'br', firm: true });
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
      out.push({ kind: 'code', txt: content });
      pos = close + run;
      continue;
    }
    // < ... > : autolink, then raw HTML
    if (ch === '<') {
      const auto = tryAngleLink(src, pos);
      if (auto) {
        flush(buf); buf = '';
        out.push(auto.node);
        pos = auto.end;
        continue;
      }
      const tag = tryInlineHtml(src, pos);
      if (tag) {
        flush(buf); buf = '';
        // marked tracks an open <a> tag document-wide: while it is open,
        // bare-URL/bare-email autolinks are suppressed everywhere (the
        // inline lexer's state is shared across blocks and is only cleared
        // by an inline </a>). An <a> inside an HTML block never reaches
        // here, so it correctly does not poison anything.
        if (!st.inA && /^<a /i.test(tag.text)) st.inA = true;
        else if (st.inA && /^<\/a>/i.test(tag.text)) st.inA = false;
        out.push({ kind: 'html', txt: tag.text });
        pos = tag.end;
        continue;
      }
      buf += '<';
      pos++;
      continue;
    }
    // link or image
    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const link = tryRef(src, pos, st);
      if (link) {
        flush(buf); buf = '';
        out.push(link.node);
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
      const leftFlanking = !isWs(after) && (!isPunctChar(after) || isWs(before) || isPunctChar(before));
      const rightFlanking = !isWs(before) && (!isPunctChar(before) || isWs(after) || isPunctChar(after));
      let opens, closes;
      if (ch === '_') {
        opens = leftFlanking && (!rightFlanking || isPunctChar(before));
        closes = rightFlanking && (!leftFlanking || isPunctChar(after));
      } else {
        opens = leftFlanking;
        closes = rightFlanking;
      }
      flush(buf); buf = '';
      const d = { kind: 'delim', ch, cnt: run, full: run, opens, closes, live: true, at: pos, prev: before, next: after, dead: false };
      out.push(d);
      marks.push(d);
      pos += run;
      continue;
    }
    // entity
    if (ch === '&') {
      const ent = tryEnt(src, pos);
      if (ent) {
        flush(buf); buf = '';
        out.push(ent.node);
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
      let k = out.length ? out.length - 1 : -1;
      if (k >= 0 && out[k].kind === 'text') {
        const s = out[k].txt;
        let m = s.length;
        while (m > 0 && s[m - 1] === ' ') { spaces++; m--; }
        if (spaces >= 2) out[k].txt = s.slice(0, m);
      }
      out.push({ kind: 'br', firm: spaces >= 2 });
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
    if (canStart && !st.noAuto && !st.inA) {
      const ext = tryBareLink(src, pos);
      if (ext) {
        flush(buf); buf = '';
        out.push(ext.node);
        pos = ext.end;
        continue;
      }
    }
    buf += ch;
    pos++;
  }
  flush(buf);
  // delimiters inside a failed link label (one whose backtick code span
  // blocked the link) stay literal: they never pair
  if (st.dead) {
    for (const d of marks) {
      for (const r of st.dead) {
        if (r.src === src && d.at >= r.start && d.at < r.end) { d.live = false; d.dead = true; break; }
      }
    }
  }
  // delimiters inside a phantom code span (opened by an unbalanced
  // backtick in a link label, closed by the next backtick) stay literal
  if (st.ghost) {
    for (const d of marks) {
      for (const r of st.ghost) {
        if (r.src === src && d.at >= r.start && d.at < r.end) { d.live = false; d.dead = true; break; }
      }
    }
  }
  resolveEmphasis(out, marks);
  return out;
}

// Try to match an entity reference at pos. Numeric references decode to a
// character; named references are passed through literally.
function tryEnt(src, pos) {
  const m = /^&#([Xx][0-9A-Fa-f]{1,6}|[0-9]{1,7});/.exec(src.slice(pos));
  if (m) {
    return { node: { kind: 'text', txt: decodeNum(m[1]) }, end: pos + m[0].length };
  }
  const m2 = /^&([A-Za-z][A-Za-z0-9]*);/.exec(src.slice(pos));
  if (m2) {
    return { node: { kind: 'entity', txt: m2[0] }, end: pos + m2[0].length };
  }
  return null;
}

// Try <scheme:...> or <email> at pos.
function tryAngleLink(src, pos) {
  const rest = src.slice(pos);
  let m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
  if (m) {
    // the href is URL-cleaned; the link text keeps the raw destination
    const dest = tidyUrl(m[1]);
    if (dest === null) return null;
    return { node: { kind: 'link', href: dest, cap: null, bare: true, kids: [{ kind: 'text', txt: m[1] }] }, end: pos + m[0].length };
  }
  m = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest);
  if (m) {
    const dest = 'mailto:' + m[1];
    return { node: { kind: 'link', href: dest, cap: null, bare: true, kids: [{ kind: 'text', txt: m[1] }] }, end: pos + m[0].length };
  }
  return null;
}

// Match an HTML comment at the start of s: <!-->, <!--->, or <!--...-->
// up to the first -->. Returns the match or null.
function readComment(s) {
  if (s.startsWith('<!-->')) return '<!-->';
  if (s.startsWith('<!--->')) return '<!--->';
  const m = /^<!--[\s\S]*?-->/.exec(s);
  return m ? m[0] : null;
}

// Try raw HTML (comment, PI, declaration, CDATA, tag) at pos.
function tryInlineHtml(src, pos) {
  const s = src.slice(pos);
  const com = readComment(s);
  if (com) return { text: com, end: pos + com.length };
  let m = /^<\?[\s\S]*?\?>/.exec(s);
  if (m) return { text: m[0], end: pos + m[0].length };
  m = /^<![A-Z][\s\S]*?>/.exec(s);
  if (m) return { text: m[0], end: pos + m[0].length };
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(s);
  if (m) return { text: m[0], end: pos + m[0].length };
  const tag = readTag(s);
  if (tag) return { text: s.slice(0, tag.end), end: pos + tag.end };
  return null;
}

// Find the index of the ] that ends a link label starting at src[start]
// (the character after the [). A label ends at the first unescaped ];
// unlike the link text it may not hold a nested bracket pair. Returns -1
// when there is no closing ].
function findFlatEnd(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === ']') return i;
    i++;
  }
  return -1;
}

// Find the matching ] for the [ at labelStart, counting nested brackets.
// A ] inside a backslash escape, a code span, or an HTML tag (whose quoted
// attribute values may contain ]) does not end the label. Returns the index
// of ] or -1.
function findMarkEnd(src, labelStart) {
  let depth = 1;
  let i = labelStart;
  // a backtick run that fails to find its closing run leaves the next
  // backtick run literal too: it is the failed opener's tail, not a
  // code span of its own (``guide` in a label must not swallow the ])
  let prevFailed = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (i + run < src.length && src[i + run] === '`') run++;
      if (prevFailed) { i += run; prevFailed = false; continue; }
      // marked's label pattern matches a code span as a backtick run,
      // content with no backticks, and a closing run of ANY length
      // (`+(?!`)[^`]*?`+(?!`)) — so ``url` in `[docs each
      // ``url`](...)` closes at the single ` after url, and the ] ends
      // the label. A run of 2+ directly before ] is literal backticks
      // (``+(?=\\])), not a span opener: `[a ``](u)` keeps its label.
      if (run >= 2 && src[i + run] === ']') { i += run; continue; }
      let close = -1;
      for (let b = i + run; b < src.length; b++) {
        if (src[b] === '`') {
          let r = 0;
          while (b + r < src.length && src[b + r] === '`') r++;
          close = b + r;
          break;
        }
      }
      if (close >= 0) { i = close; continue; }
      prevFailed = true;
      i += run;
      continue;
    }
    if (ch === '<') {
      const tagEnd = skipTag(src, i);
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
function findTickEnd(src, start, run) {
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

// Find the first backtick run in a link label that has no same-length
// closing run inside the label; returns {pos, len} (pos in the label)
// or null. Such a run is literal text in the label, but it still
// opens a phantom code span that runs to the next backtick in the
// paragraph and swallows any emphasis delimiters in between (marked
// leaves `*x*` literal between `[a ``b` c](#1)` and a later `` `e` ``).
function firstLooseTick(label) {
  let i = 0;
  while (i < label.length) {
    // an escaped backtick is literal text, not a code span opener
    if (label[i] === '\\' && i + 1 < label.length) { i += 2; continue; }
    if (label[i] !== '`') { i++; continue; }
    let run = 0;
    while (i + run < label.length && label[i + run] === '`') run++;
    const close = findTickEnd(label, i + run, run);
    if (close < 0) return { pos: i, len: run };
    i = close;
  }
  return null;
}

// Skip an HTML construct (comment, PI, declaration, CDATA, or tag) at pos,
// returning the index just past it, or -1 when there is none. A tag's
// quoted attribute values are skipped whole, so a ] inside one does not
// end a link label.
function skipTag(src, pos) {
  const s = src.slice(pos);
  const com = readComment(s);
  if (com) return pos + com.length;
  let m = /^<\?[\s\S]*?\?>/.exec(s);
  if (m) return pos + m[0].length;
  m = /^<![A-Z][\s\S]*?>/.exec(s);
  if (m) return pos + m[0].length;
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(s);
  if (m) return pos + m[0].length;
  const tag = readTag(s);
  if (tag) return pos + tag.end;
  return -1;
}

// Parse a link destination + optional title starting at pos (which must be
// at '('). Returns {dest, title, end} or null.
function readTarget(src, pos) {
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
  dest = dropBackslashes(dest);
  dest = decodeEnts(dest);
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
    title = decodeEnts(title);
    skipWs();
  }
  if (p >= n || src[p] !== ')') return null;
  return { dest, title, end: p + 1 };
}

// Decode numeric character references inside a string (named ones stay).
function decodeEnts(s) {
  return s.replace(/&#([Xx][0-9A-Fa-f]{1,6}|[0-9]{1,7});/g, (m, body) => decodeNum(body));
}

// Does the node tree contain a code span whose content holds a
// backtick? marked does not form a link whose label holds such a code
// span — unless the label ends with a code span, in which case the
// link still forms. (The label's backticks confuse its scanner when
// anything but a code span follows the span.)
function hasTickCode(nodes) {
  for (const node of nodes) {
    if (node.kind === 'code' && node.txt.indexOf('`') >= 0) return true;
    if (node.kids && hasTickCode(node.kids)) return true;
  }
  return false;
}

// Does the node tree contain a (non-autolink) link node anywhere? An
// autolink inside a link label does not block the outer link, but a
// real nested link does, so autolink nodes (tagged bare) are skipped.
function hasLink(nodes) {
  for (const node of nodes) {
    if (node.kind === 'link' && !node.bare) return true;
    if (node.kids && hasLink(node.kids)) return true;
  }
  return false;
}

// Try to parse a link (or image, when src[pos] is '!') at pos.
function tryRef(src, pos, st) {
  const isImage = src[pos] === '!';
  const open = isImage ? pos + 1 : pos;
  const labelStart = open + 1;
  const labelEnd = findMarkEnd(src, labelStart);
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
    const tgt = readTarget(src, j);
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
      const refEnd = findFlatEnd(src, j + 1);
      if (refEnd < 0) return null;
      refLabel = src.slice(j + 1, refEnd);
      // a reference label may not hold an unescaped [; without a usable
      // label this is a shortcut [label] instead
      if (hasBareBracket(refLabel)) {
        refLabel = label;
        end = labelEnd + 1;
      } else {
        end = refEnd + 1;
      }
    } else {
      refLabel = label;
      end = labelEnd + 1;
    }
    const def = st.defs.get(foldLabel(refLabel === '' ? label : refLabel));
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
  const savedNoAuto = st.noAuto;
  st.noAuto = true;
  // marked's link tokenizer also saves inLink, sets it while parsing the
  // label, and restores it afterwards, so an <a> tag inside a link label
  // never poisons the rest of the document
  const savedInA = st.inA;
  st.inA = true;
  const kids = readInline(label, st);
  st.inA = savedInA;
  st.noAuto = savedNoAuto;
  if (!isImage && hasLink(kids)) return null;
  if (!isImage && hasTickCode(kids)) {
    // a label holding a backtick code span still forms a link when it
    // ends with a code span; anything else after the span blocks it
    const last = kids[kids.length - 1];
    if (!last || last.kind !== 'code') {
      // the failed label's emphasis stays literal too: remember its
      // source range so its delimiters never pair
      (st.dead || (st.dead = [])).push({ src, start: labelStart, end: labelEnd });
      return null;
    }
  }
  const cleaned = tidyUrl(dest);
  if (cleaned === null) return null;
  const node = isImage
    ? { kind: 'image', href: cleaned, cap: title, kids }
    : { kind: 'link', href: cleaned, cap: title, kids };
  // an unbalanced backtick in the label opens a phantom code span to
  // the next backtick in the paragraph; emphasis inside it stays
  // literal, so remember the range (link end .. next backtick)
  const ub = firstLooseTick(label);
  if (ub) {
    const q = src.indexOf('`', end);
    if (q >= 0) (st.ghost || (st.ghost = [])).push({ src, start: end, end: q });
    // marked's masking pairs same-length backtick runs left to right
    // starting at the unbalanced opener, and the emphasis delimiters
    // inside those (shifted) code spans stay literal: the opener in
    // the label shifts every later pairing by one, so a delimiter
    // between two real code spans can still be swallowed (e.g. the
    // `_issue table_` between `deno` and `a` in doc-09). A span's
    // content may hold backtick runs of other lengths, so the closer
    // is the next run of the SAME length, not the next run. Simulate
    // that pairing from the opener and record each span after the link.
    const ranges = st.ghost || (st.ghost = []);
    let i = labelStart + ub.pos;
    while (true) {
      while (i < src.length && src[i] !== '`') i++;
      if (i >= src.length) break;
      let run = 0;
      while (i + run < src.length && src[i + run] === '`') run++;
      // the closer is the next run of the same length; runs of other
      // lengths in between are just span content
      let q = -1;
      let j = i + run;
      while (j < src.length) {
        while (j < src.length && src[j] !== '`') j++;
        if (j >= src.length) break;
        let nr = 0;
        while (j + nr < src.length && src[j + nr] === '`') nr++;
        if (nr === run) { q = j; break; }
        j += nr;
      }
      if (q >= 0) {
        const s0 = Math.max(i, end);
        if (s0 < q + run) ranges.push({ src, start: s0, end: q + run });
        i = q + run;
      } else {
        // lone run: move on to the next run (any length)
        let k = i + run;
        while (k < src.length && src[k] !== '`') k++;
        if (k >= src.length) break;
        i = k;
      }
    }
  }
  return { node, end };
}

// Try an extended (GFM) autolink at pos: www.example.com, http://...,
// or user@host.tld. The match must start on a word boundary.
// Try an extended (GFM) autolink at pos: www.example.com,
// scheme://..., scheme:address (mailto:, xmpp:), or user@host.tld.
// The match must start on a word boundary (checked by the caller).
function tryBareLink(src, pos) {
  const rest = src.slice(pos);
  let m;
  if (rest.startsWith('www.')) {
    m = /^(www\.(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}[^\s<>]*)/.exec(rest);
    if (m) {
      const text = trimLinkTail(m[1]);
      if (!text) return null;
      const dest = tidyUrl('http://' + text);
      if (dest === null) return null;
      return { node: { kind: 'link', href: dest, cap: null, bare: true, kids: [{ kind: 'text', txt: text }] }, end: pos + text.length };
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
      text = trimLinkTail(rawText);
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
    const dest = tidyUrl(text);
    if (dest === null) return null;
    return { node: { kind: 'link', href: dest, cap: null, bare: true, kids: [{ kind: 'text', txt: text }] }, end: pos + text.length };
  }
  m = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)/.exec(rest);
  if (m) {
    const text = trimLinkTail(m[1]);
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
    return { node: { kind: 'link', href: 'mailto:' + text, cap: null, bare: true, kids: [{ kind: 'text', txt: text }] }, end: pos + text.length };
  }
  return null;
}

// Trim trailing punctuation from an extended autolink, per the GFM rules.
// A '(' opens a group that must close before the end of the run (the
// match holds no whitespace, so a group that never closes is not part
// of the autolink at all): cut the text before the first '(' whose
// group never closes, counting nested groups. A trailing ')' is kept
// only when it closes an earlier '(' in the text; an unmatched one is
// trimmed. A trailing ']' is never trimmed (marked keeps it).
function trimLinkTail(text) {
  {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') stack.push(i);
      else if (text[i] === ')' && stack.length) stack.pop();
    }
    if (stack.length) text = text.slice(0, stack[0]);
  }
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
      // A trailing ')' is kept only when it closes a simple group
      // (one holding no '(' of its own). It is trimmed when it has no
      // matching '(' at all, and also when the group it closes holds
      // a nested '(' — marked drops the closing paren of a nested
      // group, but keeps the one closing a simple group.
      let depth = 0;
      let match = -1;
      for (let i = end - 2; i >= 0; i--) {
        if (text[i] === ')') depth++;
        else if (text[i] === '(') {
          if (depth === 0) { match = i; break; }
          depth--;
        }
      }
      if (match < 0) { end--; continue; }
      let nested = false;
      for (let i = match + 1; i < end - 1; i++) {
        if (text[i] === '(') { nested = true; break; }
      }
      if (nested) { end--; continue; }
      break;
    }
    break;
  }
  return text.slice(0, end);
}


// ---------------------------------------------------------------------------
// Emphasis resolution
// ---------------------------------------------------------------------------

// Replays marked 18.1.3's emStrong scan from a candidate em opener and
// answers whether the (opener, closer) em pairing is one marked makes
// (or one that does not disturb the pairing marked makes). The scan
// tracks delimTotal from the opener's remaining run length: a run that
// can only open adds to it, a run that can only close subtracts from
// it, a both-flanking run is skipped by the rule of three (its length
// goes to midDelimTotal) or subtracts, and a run that can neither open
// nor close is invisible to the scan. The first run where delimTotal
// drops to zero or below is the run marked pairs the opener with. An
// em pairing is allowed when the closer IS that run, or when the
// opener still has enough delimiters left after the em pairing to
// also make marked's pairing (the inner em inside a strong, as in
// ***foo* bar**). Otherwise the pairing is blocked: the opener pairs
// with the later run instead, as in doc-11.
function markedScan(marks, opener, closer) {
  const ch = opener.ch;
  const runLength = opener.full;
  const runPrevChar = opener.prev;
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctChar(runPrevChar);
  const nextChar = isPunctChar(opener.next) ? opener.next : '';
  const openerCanClose = runPrevChar.trim() !== '' && (nextChar !== '' || (ch === '*' && !runPrevPunct));
  const midRun = opener.cnt < opener.full;
  let delimTotal = opener.cnt;
  let midDelimTotal = 0;
  const oi = marks.indexOf(opener);
  for (let i = oi + 1; i < marks.length; i++) {
    const nd = marks[i];
    if (nd.ch !== ch || !nd.live || nd.cnt <= 0) continue;
    const rLength = nd.cnt;
    if (nd.opens && !nd.closes) {
      // left-delimiter only (groups 3/4): adds to the scan
      delimTotal += rLength;
      continue;
    }
    if (!nd.opens && !nd.closes) continue; // matches no group: invisible
    if (nd.opens && nd.closes) {
      // either (groups 5/6): a mid-run opener cannot close against it
      if (midRun) return true; // scan stops: no pairing found; do not block
      if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
        midDelimTotal += rLength;
        continue;
      }
    } else if (openerCanClose) {
      // right-delimiter only (groups 1/2) when the opener can close:
      // the rule of three applies here too
      if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
        midDelimTotal += rLength;
        continue;
      }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    // first run where the scan drops to zero or below: this is the run
    // marked pairs the opener with
    const capped = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    if (nd === closer) return true;
    const usePrime = Math.min(opener.cnt, capped) % 2 === 1 ? 1 : 2;
    // the em pairing uses one of the opener's delimiters; marked's
    // pairing needs usePrime of them. Both can happen only when the
    // opener has enough left after the em pairing.
    return opener.cnt - 1 >= usePrime;
  }
  return true; // scan found no pairing: do not block
}


// Resolve emphasis and strikethrough in a node list, in place. Each
// closer pairs (possibly several times, if it has length left: a run of
// 3 can pair once as strong and once as em) with the nearest earlier
// opener that can still pair with it. Delimiters that cannot pair
// become literal text. An em pairing is allowed only when marked's
// outside-in scan agrees the closer is the one this opener pairs with
// (see markedScan); strong and strikethrough pairings are not gated.
function resolveEmphasis(nodes, marks) {
  for (let di = 0; di < marks.length; di++) {
    const closer = marks[di];
    if (!closer.live || !closer.closes) continue;
    const ch = closer.ch;
    while (closer.live && closer.cnt > 0) {
      let opener = null;
      let use = 0;
      for (let k = di - 1; k >= 0; k--) {
        const d = marks[k];
        if (!d.live || d.ch !== ch || !d.opens) continue;
        // a deactivated opener is closed to single-delimiter closers
        if (d.dead && closer.cnt === 1) continue;
        // the rule of three: when both can open and close, the sum of the
        // lengths must not be a multiple of three (unless both are)
        if ((d.closes || closer.opens) && (d.cnt + closer.cnt) % 3 === 0 && (d.cnt % 3 !== 0 || closer.cnt % 3 !== 0)) continue;
        // there must be at least one node between them
        const oiPos = nodes.indexOf(d);
        const ciPos = nodes.indexOf(closer);
        if (oiPos < 0 || ciPos < 0 || ciPos - oiPos < 2) continue;
        const u = d.cnt >= 2 && closer.cnt >= 2 ? 2 : 1;
        // an em pairing is allowed only when marked's outside-in scan
        // agrees (see markedScan); strong and strikethrough pairings
        // are not gated
        if (ch === '*' && u === 1 && !markedScan(marks, d, closer)) continue;
        opener = d;
        use = u;
        break;
      }
      if (!opener) break;
      const pairN = closer.cnt;
      const tag = ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      const oiPos = nodes.indexOf(opener);
      const ciPos = nodes.indexOf(closer);
      const inner = nodes.slice(oiPos + 1, ciPos);
      const wrap = { kind: tag, kids: inner };
      nodes.splice(oiPos + 1, ciPos - oiPos - 1, wrap);
      opener.cnt -= use;
      closer.cnt -= use;
      // marked's regex emphasis leaves one delimiter of a trailing run
      // inside a strong when an inner emphasis closer within it was
      // both-flanking (its following text starts with a word character):
      // the regex counts that delimiter in its closer span and only
      // strips two from the end, so one stays as literal text. The
      // delimiter stack would leave it outside instead. Detect it: the
      // last em in the strong's content is followed by a text node
      // starting with an alphanumeric character. Asterisk only: the
      // underscore closer regex does not share this accounting.
      if (tag === 'strong' && ch === '*' && closer.cnt > 0) {
        let moveInside = false;
        for (let j = inner.length - 1; j >= 0; j--) {
          if (inner[j].kind === 'em') {
            const next = inner[j + 1];
            if (next && next.kind === 'text' && /^[A-Za-z0-9]/.test(next.txt)) moveInside = true;
            break;
          }
        }
        if (moveInside) {
          wrap.kids.push({ kind: 'text', txt: ch });
          closer.cnt -= 1;
        }
      }
      if (opener.cnt === 0) {
        opener.live = false;
        const p = nodes.indexOf(opener);
        if (p >= 0) nodes.splice(p, 1);
      }
      if (closer.cnt === 0) {
        closer.live = false;
        const p = nodes.indexOf(closer);
        if (p >= 0) nodes.splice(p, 1);
      }
      // Deactivation: earlier openers that fail the rule of three
      // against this closer (at its length when it paired) are marked,
      // scanning back only as far as the nearest opener that can close
      // (even a consumed one still bars the way).
      for (let k = di - 1; k >= 0; k--) {
        const d = marks[k];
        if (d.ch !== ch) continue;
        if (d.opens && d.closes) break;
        if (!d.live || !d.opens) continue;
        if (closer.opens && (d.cnt + pairN) % 3 === 0 && (d.cnt % 3 !== 0 || pairN % 3 !== 0)) d.dead = true;
      }
    }
  }
  // any delimiter left over becomes literal text, including delimiters
  // that ended up inside an emphasis wrapper
  const finalize = (list) => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'delim') {
        list[i] = { kind: 'text', txt: list[i].ch.repeat(list[i].cnt) };
      } else if (list[i].kids) {
        finalize(list[i].kids);
      }
    }
  };
  finalize(nodes);
}

// ---------------------------------------------------------------------------
// Block matchers
// ---------------------------------------------------------------------------

// Match a blockquote marker at the cursor: up to 3 spaces of indent, a
// >, then one optional space (a tab after the > expands to spaces by
// column; the first space of that expansion is the marker's own space,
// so it is dropped and the rest stays as content indent).
function matchBQ(c) {
  const saveI = c.i, saveCol = c.col;
  const ind = indentOf(c);
  if (ind > 3) return false;
  advance(c, ind);
  if (c.i >= c.s.length || c.s[c.i] !== '>') { c.i = saveI; c.col = saveCol; return false; }
  c.i++; c.col++;
  let j = c.i, col = ind + 1, expanded = '';
  while (j < c.s.length && (c.s[j] === ' ' || c.s[j] === '\t')) {
    if (c.s[j] === ' ') { expanded += ' '; col++; j++; }
    else { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; j++; }
  }
  const rest = c.s.slice(j);
  c.s = (expanded.length ? expanded.slice(1) : '') + rest;
  c.i = 0;
  c.col = 0;
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

// A lazy paragraph continuation line keeps its leading whitespace,
// except that an indent of four or more columns loses exactly four
// columns (an indented-code indent); a shorter indent is kept whole.
function stripLazyIndent(s) {
  let col = 0, i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    col += s[i] === ' ' ? 1 : 4 - (col % 4);
    i++;
    if (col >= 4) break;
  }
  return col >= 4 ? s.slice(i) : s;
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
  const tag = readTag(s);
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
function readTag(s) {
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

// Match a list marker at the cursor. Returns null, or { kind, marker,
// start, contentIndent, empty }: kind 'bullet'|'ordered', marker char /
// delimiter, start number, and how many columns of content indent the
// item has.
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
      const close = findTickEnd(s, i + run, run);
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
// Block construction
// ---------------------------------------------------------------------------

function closeNode(node, st) {
  if (node.t === 'paragraph') {
    peelDefs(node, st, true);
    if (!node.lines.length && node.parent) {
      const sibs = node.parent.children;
      const k = sibs.indexOf(node);
      if (k >= 0) sibs.splice(k, 1);
    }
  } else if (node.t === 'code' && !node.fenced) {
    while (node.lines.length && node.lines[node.lines.length - 1] === '') node.lines.pop();
  }
}

function startBlock(c, container, st, open) {
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
        info: dropBackslashes(fence.info),
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
function interruptsParagraph(c, st, nested) {
  const saveI = c.i, saveCol = c.col, saveS = c.s;
  if (matchBQ(c)) { c.i = saveI; c.col = saveCol; c.s = saveS; return true; }
  if (matchAtx(c)) return true;
  if (matchFence(c)) return true;
  const ht = htmlBlockType(c);
  if (ht >= 1 && ht <= 6) return true;
  if (isThematic(c)) return true;
  const m = matchListMarker(c);
  if (m) {
    c.i = saveI; c.col = saveCol; c.s = saveS;
    if (m.empty) return false;
    if (m.kind === 'bullet') return true;
    // an ordered list interrupts a paragraph only when it starts at 1,
    // unless it is nested inside a list item or blockquote, where any
    // start number interrupts (a nested list is a new block in its item)
    return nested || m.start === 1;
  }
  c.i = saveI; c.col = saveCol; c.s = saveS;
  return false;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Parse the source into a block tree. The source is split into lines;
// each line is fed through the open containers (phase 1), new blocks are
// opened and old ones closed (phases 2-4), and the line's content is
// added to the innermost open block (phase 5).
function readBlocks(src, st) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  // a trailing newline ends the last line; it is not an extra blank line
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // whether the source ends with a newline: an HTML block of type 6-7
  // that is the last block of the document keeps a trailing newline
  // only when the source ends with one
  st.srcEndsWithNewline = src.replace(/\r\n?/g, '\n').endsWith('\n');
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
          // a heading -- belongs outside the quote). A line that is
          // blank after the markers matched so far (an outer-only >
          // line, with or without trailing spaces) is NOT a lazy line:
          // it is a blank line for the inner quote, so the inner quote
          // closes and a later > > line opens a new one.
          if (!blank && !blankRest(c) && !isThematic(c) && open[open.length - 1].t === 'paragraph') {
            const probe = { s: c.s, i: c.i, col: c.col };
            if (!matchListMarker(probe) && !interruptsParagraph(c, st, true)) { idx = open.length - 1; lazyLine = true; }
          }
          break;
        }
        idx++;
      } else if (nx.t === 'list') {
        idx++;
      } else if (nx.t === 'item') {
        // a line that is blank only after its container markers are
        // consumed (a lone >) is a blank line inside the item too: it
        // must descend into the item (marking it blank) rather than
        // close the item, or the next indented line after a fence and
        // a blank line lands outside the item as indented code
        if (blank || c.i >= c.s.length) idx++;
        else if (nx.children.length === 0 && nx.pendingBlank) {
          // an empty item followed by a blank line takes no further
          // content; the next line belongs outside the list
          break;
        }
        else if (matchItemIndent(c, nx)) idx++;
        else {
          // A line inside an open fenced code block is code content even
          // when its indent does not match the item -- but only once the
          // block already holds a line. An empty block is closed by a
          // non-matching line instead (``- foo`` + `` ```sh`` + a column-0
          // ``print`` is an empty code block, then a paragraph), while a
          // block that already has content keeps a column-0 line as code.
          // A line that starts a list marker is not code content: it
          // opens a new item of an enclosing list and ends the code
          // block (and the blockquote/item holding it).
          const probe = { s: c.s, i: c.i, col: c.col };
          const startsList = !!matchListMarker(probe);
          if (open[open.length - 1].t === 'code' && open[open.length - 1].fenced && open[open.length - 1].lines.length > 0 && !startsList) {
            idx = open.length - 1; lazyLine = true;
          } else {
          // lazy continuation inside a list item's paragraph, but only for
          // plain paragraph text: a line that starts a block that can
          // interrupt a paragraph (a new list item, a heading, ...) belongs
          // outside the item instead. Any list marker counts here, even an
          // ordered one that does not start at 1 (it still opens a new item
          // of the enclosing list rather than continuing the paragraph).
          if (open[open.length - 1].t === 'paragraph' && !startsList && !interruptsParagraph(c, st, true)) { idx = open.length - 1; lazyLine = true; }
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
      closeNode(gone, st);
    }
    const container = open[open.length - 1];
    // a line that becomes blank only after its container markers are
    // consumed (e.g. >> inside a blockquote) is a blank line too, but
    // only when nothing is left after the markers: a line like >  keeps
    // its trailing space as paragraph content (cm-241)
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
      // A nested LIST counts as a nested item here too: a blank between
      // two items of a nested list (the new line lands in the list
      // itself) does not loosen the list holding the item that holds
      // that nested list, so the item holding the list is cleared as
      // well -- without this, a blank deep inside a nested list
      // loosened every list above it (L12, doc-06).
      {
        let seenItem = container.t === 'item' || container.t === 'list';
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
            // a blank line between two items of this list makes it
            // loose, whether the blank was a truly empty line
            // (pendingBlank) or became blank only after its container
            // markers were consumed, as a lone > between items
            // (pendingBlankInner, set only when the blank was at the
            // item's own level)
            if (it.t === 'item' && (it.pendingBlank || it.pendingBlankInner)) {
              list.loose = true;
              it.pendingBlank = false;
              it.pendingBlankInner = false;
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
      if (leaf && leaf.t === 'table' && /^ *\t$/.test(c.s.slice(c.i))) {
        // a line of spaces plus a single trailing tab inside a table
        // is a table row of empty cells, not a blank line ending the
        // table; any other whitespace-only line (spaces, several tabs,
        // or anything after the tab) ends the table
        leaf.rows.push(splitRow(c.s.slice(c.i)));
        st.lastLineBlank = true;
        continue;
      }
      if (leaf && leaf.t === 'code' && leaf.open) {
        // a whitespace-only line inside a code block keeps whatever is
        // left after the code indent is removed (so a line of 6 spaces
        // inside an indented block contributes 2 spaces, and a line of 2
        // spaces inside a fenced block stays 2 spaces). A leading tab
        // expands only in a fenced block, from the column where the
        // line's content starts (see the fenced-code line handling).
        // Only a backtick fence dedents its content by the fence's indent
        // (marked's indent compensation matches ``` only); a tilde fence
        // keeps its content's indentation untouched.
        const col0 = c.col;
        const rest = leaf.fenced
          ? (leaf.fenceCh === '`' ? dedentFenceLine(c.s.slice(c.i), leaf.indent) : c.s.slice(c.i))
          : removeIndent(c, 4);
        leaf.lines.push(leaf.fenced ? expandTabs(rest, col0) : rest);
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
          closeNode(gone, st);
        }
        // only a line that is blank on its own (not merely blank after
        // its container markers, like a lone >) can make a list loose
        // between items. A blank line anywhere inside an item can loosen
        // its list, so every open item is marked, not just the innermost
        // one. A line that is blank only after its container markers
        // (pendingBlankInner) also loosens the list when the next line
        // is more content inside the same item, or a new item of the
        // same list — but only when the blank is at that item's own
        // level: a marker-only blank nested inside a child block of the
        // item (for example a lone > inside a blockquote the item holds)
        // does not loosen the item's list.
        if (rawBlank) {
          for (let k = open.length - 1; k >= 0; k--) {
            if (open[k].t === 'item') open[k].pendingBlank = true;
          }
        } else if (blank) {
          for (let k = open.length - 1; k >= 0; k--) {
            const it = open[k];
            if (it.t === 'item' && (container === it || leaf === it || leaf.parent === it)) {
              it.pendingBlankInner = true;
            }
          }
        }
      }
      st.lastLineBlank = true;
      continue;
    }
    st.lastLineBlank = false;
    // Phase 3: an open leaf block may take the line. The leaf is the top
    // of the open stack itself when it is a leaf, or the last child of the
    // open container.
    let leaf = isContainer(container) ? lastChild(container) : container;
    if (leaf && leaf.open) {
      if (leaf.t === 'paragraph') {
        peelDefs(leaf, st);
        if (!leaf.lines.length) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, st);
          leaf = null;
        }
      }
      if (leaf && leaf.t === 'paragraph') {
        const setextLv = lazyLine ? 0 : matchSetext(c);
        const delim = !lazyLine && isTableDelim(c);
        if (setextLv || delim) {
          // strip any leading definitions first: a paragraph that is
          // only definitions has no text for a setext underline or a
          // table header to attach to, so === or |---| here is literal
          // text. Only strip once the line is known to be a setext or
          // table line, so a definition still waiting for its title on
          // a later line is not cut short.
          peelDefs(leaf, st, true);
        }
        if (setextLv && leaf.lines.length) {
          leaf.t = 'heading';
          leaf.level = setextLv;
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
        if (interruptsParagraph(c, st, !!(leaf.parent && leaf.parent.t !== 'document'))) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, st);
          leaf = null;
        } else {
          let text = c.s.slice(c.i);
          if (lazyLine) {
            // a lazy continuation line keeps its leading whitespace
            // (only an indent of four or more columns loses four), but
            // a lazy setext = underline inside a blockquote is paragraph
            // text that keeps exactly four leading spaces
            let cut = 0;
            while (cut < text.length && (text[cut] === ' ' || text[cut] === '\t')) cut++;
            const stripped = text.slice(cut);
            if (/^=+[ \t]*$/.test(stripped)) {
              let p = leaf.parent, inBQ = false;
              while (p) { if (p.t === 'blockquote') { inBQ = true; break; } p = p.parent; }
              text = inBQ ? '    ' + stripped : stripLazyIndent(text);
            } else {
              text = stripLazyIndent(text);
            }
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
        // an indented code line keeps its tabs literally. The tab's column
        // is measured from where the line's content starts (after the
        // container markers), before the fence indent is removed: a tab
        // that directly follows the fence indent sits at column 0 of the
        // content and stays a literal tab, while a tab after a blockquote
        // marker expands from the marker's column. Only a backtick fence
        // removes its indent from content lines; a tilde fence does not
        // (marked's indent compensation matches ``` only).
        const col0 = c.col;
        const rest = leaf.fenceCh === '`' ? dedentFenceLine(c.s.slice(c.i), leaf.indent) : c.s.slice(c.i);
        leaf.lines.push(expandTabs(rest, col0));
        continue;
      }
      if (leaf && leaf.t === 'code' && !leaf.fenced) {
        if (indentOf(c) >= 4) {
          leaf.lines.push(removeIndent(c, 4));
          continue;
        }
        const gone = open.pop();
        gone.open = false;
        closeNode(gone, st);
        leaf = null;
      }
      if (leaf && leaf.t === 'html') {
        if (leaf.htmlType >= 1 && leaf.htmlType <= 5 && htmlBlockEnded(leaf)) {
          // the block already ended on an earlier line; close it and let
          // this line start something new
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, st);
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
        // a line that starts a new block (a blockquote here, a fenced
        // code block, a list item, or an HTML block of type 1-6) ends the
        // table instead of becoming a row; a list marker after a table
        // row is a new list, not a single-cell row. Type 7 (an inline
        // tag alone on its line, like <span>) does not end it: marked's
        // table row pattern only excludes block-level HTML starts.
        let ti = c.i;
        while (ti < c.s.length && c.s[ti] === ' ') ti++;
        const probe = { s: c.s, i: c.i, col: c.col };
        const htmlType = htmlBlockType(c);
        if (c.s[ti] === '>' || matchFence(c) || matchListMarker(probe) || (htmlType >= 1 && htmlType <= 6)) {
          const gone = open.pop();
          gone.open = false;
          closeNode(gone, st);
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
          closeNode(gone, st);
          cont = cont.parent;
          continue;
        }
      }
      const started = startBlock(c, cont, st, open);
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
      peelDefs(p, st);
      if (!p.lines.length) {
        const gone = open.pop();
        gone.open = false;
        closeNode(gone, st);
      }
    }
  }
  while (open.length > 1) {
    const gone = open.pop();
    gone.open = false;
    closeNode(gone, st);
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
// Rendering
// ---------------------------------------------------------------------------

function showInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += escText(node.txt);
    else if (node.kind === 'entity') out += node.txt;
    else if (node.kind === 'code') out += '<code>' + escCode(node.txt) + '</code>';
    else if (node.kind === 'html') out += node.txt;
    else if (node.kind === 'br') out += node.firm ? '<br>' : '\n';
    else if (node.kind === 'em') out += '<em>' + showInline(node.kids) + '</em>';
    else if (node.kind === 'strong') out += '<strong>' + showInline(node.kids) + '</strong>';
    else if (node.kind === 'del') out += '<del>' + showInline(node.kids) + '</del>';
    else if (node.kind === 'link') {
      out += '<a href="' + escAttr(node.href) + '"';
      if (node.cap !== null && node.cap !== undefined) out += ' title="' + escAttr(node.cap) + '"';
      out += '>' + showInline(node.kids) + '</a>';
    } else if (node.kind === 'image') {
      out += '<img src="' + escAttr(node.href) + '" alt="' + escText(plainText(node.kids)) + '"';
      if (node.cap !== null && node.cap !== undefined) out += ' title="' + escAttr(node.cap) + '"';
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
    if (node.kind === 'text' || node.kind === 'entity') out += node.txt;
    else if (node.kind === 'code') out += node.txt;
    else if (node.kind === 'br') out += '\n';
    else if (node.kids) out += plainText(node.kids);
  }
  return out;
}

function showBlocks(node, st) {
  let out = '';
  for (const child of node.children) out += showBlock(child, st);
  return out;
}

// Is this paragraph the last block of a list (the last descendant of
// the list's last item)? Its trailing spaces are stripped; a paragraph
// anywhere else in a list keeps them.
function isLastParaInList(node) {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (p.children[p.children.length - 1] !== n) return false;
    if (p.t === 'item' && p.parent && p.parent.t === 'list' &&
      p.parent.children[p.parent.children.length - 1] === p) return true;
    n = p;
  }
  return false;
}

function showBlock(node, st) {
  switch (node.t) {
    case 'paragraph':
      return '<p>' + showInline(readInline(isLastParaInList(node) ? node.lines.join('\n').replace(/[ \t]+$/, '') : node.lines.join('\n'), st)) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + showInline(readInline(node.text, st)) + '</h' + node.level + '>\n';
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
        return '<pre><code class="language-' + escAttr(lang) + '">' + escCode(content) + '</code></pre>\n';
      }
      return '<pre><code>' + escCode(content) + '</code></pre>\n';
    }
    case 'html': {
      // HTML blocks of types 1-5 end with their end marker and keep the
      // line break after it; types 6-7 (which end at a blank line) have a
      // trailing newline only when they are the last block of the document
      // and the source itself ends with a newline. A block followed by a
      // blank line keeps no trailing newline.
      const sibs = node.parent && node.parent.t === 'document' ? node.parent.children : [];
      const isLastDoc = sibs.length && sibs[sibs.length - 1] === node;
      const trailing = ((node.htmlType >= 1 && node.htmlType <= 5) || (isLastDoc && st.srcEndsWithNewline)) && !node.blankAfter;
      return node.lines.join('\n') + (trailing ? '\n' : '');
    }
    case 'thematic_break':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + showBlocks(node, st) + '</blockquote>\n';
    case 'list': {
      const tag = node.kind === 'ordered' ? 'ol' : 'ul';
      const open = node.kind === 'ordered' && node.start !== 1 ? '<ol start="' + node.start + '">\n' : '<' + tag + '>\n';
      return open + showBlocks(node, st) + '</' + tag + '>\n';
    }
    case 'item':
      return '<li>' + showItem(node, st) + '</li>\n';
    case 'table':
      return showTable(node, st);
    default:
      return showBlocks(node, st);
  }
}

// A list item's children: in a tight list, paragraphs render bare (no <p>).
// A task list item starts its first paragraph with [ ] or [x], which
// becomes a checkbox input at the start of the item (inside the <p> when
// the list is loose).
function showItem(item, st) {
  const loose = !!(item.parent && item.parent.loose);
  let out = '';
  let first = true;
  for (const child of item.children) {
    if (child.t === 'paragraph') {
      let text = child.lines.join('\n');
      if (isLastParaInList(child)) {
        text = text.replace(/[ \t]+$/, '');
      }
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
      const inner = showInline(readInline(text, st));
      out += loose ? '<p>' + box + inner + '</p>\n' : box + inner;
    } else {
      out += showBlock(child, st);
    }
    first = false;
  }
  return out;
}

function showTable(node, st) {
  const cell = (tag, text, align) => {
    const a = align ? ' align="' + align + '"' : '';
    return '<' + tag + a + '>' + showInline(readInline(text, st)) + '</' + tag + '>\n';
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
