// A faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
// run(input) returns exactly makefun-site 1.0.0's build(input) for every input:
// the output tree (path -> text) of the site, byte for byte. Dependency-free ES
// module; no caching between cases (every cache below is created fresh inside
// one run() call and dropped with it); each case answered alone.
//
// How it is fast: the reference lexes Markdown into token objects, renders
// inline markup one character at a time with string concatenation, walks
// template trees through scope chains with Object.hasOwn per name, and calls
// slugify (NFKD + regex) again and again for the same titles and tag names.
// This version instead:
//   - renders Markdown in a single pass over the lines, emitting chunks into
//     one array (no token objects), with bulk escaping and native indexOf
//     jumps for code spans and link closers;
//   - counts words with a transition scan instead of match(/\S+/g);
//   - slugifies with an ASCII fast path (NFKD is the identity on ASCII) and
//     memoises slugs and long dates within the case (titles and tag names
//     repeat heavily; tags come from a small fixed vocabulary);
//   - parses front matter by scanning line starts instead of splitting the
//     whole source, and resolves links through a per-case memo;
//   - renders templates with a flat frame stack and one shared output array
//     (no per-node string concatenation, no scope-chain objects).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------------------------------------------------------- text */

// The HTML escape table. ESC_RE is the fast "does it need escaping" test.
const ESC_RE = /[&<>"']/;
function escapeHtml(s) {
  if (!ESC_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let r = null;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    if (r !== null) {
      out += s.slice(start, i) + r;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Slug, ASCII fast path: NFKD is the identity on ASCII and ASCII holds no
// combining marks, so the normalise/strip steps can be skipped entirely.
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  // Non-ASCII: exactly the reference's algorithm (NFKD, drop \p{M}, code
  // points, A-Z lowered, runs of other characters one '-', cut at 64).
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// Words: runs of non-whitespace, counted without allocating the words.
// ASCII printable characters (the overwhelming majority) are never
// whitespace, so the common case is two comparisons per character.
function wordsOf(t) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    let ws;
    if (c < 127) ws = c === 32 || (c >= 9 && c <= 13);
    else {
      ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
        c === 0x3000 || c === 0xfeff;
    }
    if (ws) inW = false;
    else if (!inW) { n++; inW = true; }
  }
  return n;
}

/* ---------------------------------------------------------- front matter */

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A string value: "..." with \" and \\ its only escapes, or bare.
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parse one source's front matter: { data, body } or { error }. The text
// has "\n" line ends. Only the front-matter region is scanned line by line;
// the body is one slice. Order matters: the closing line is found first,
// and only then are the lines between validated.
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  // Find the closing line first.
  let closeLineNo = -1;
  let bodyStart = -1;
  let p = 4; // just past '---\n'
  let lineNo = 1; // the opening '---' is line 1
  while (p <= text.length) {
    const e = text.indexOf('\n', p);
    lineNo++;
    if ((e === -1 ? text.slice(p) : text.slice(p, e)) === '---') {
      closeLineNo = lineNo;
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    p = e + 1;
  }
  if (closeLineNo === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = 4;
  lineNo = 1;
  while (lineNo + 1 < closeLineNo) {
    const e = text.indexOf('\n', p);
    const line = e === -1 ? text.slice(p) : text.slice(p, e);
    lineNo++;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) {
      // blank or comment
    } else {
      const ci = line.indexOf(':');
      let key = null;
      let raw = null;
      if (ci > 0) {
        let keyOk = true;
        for (let i = 0; i < ci; i++) {
          const c = line.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
        }
        if (keyOk) {
          const rest = line.slice(ci + 1);
          if (rest === '') { raw = ''; key = line.slice(0, ci); }
          else if (rest.charCodeAt(0) === 32) { raw = rest.slice(1); key = line.slice(0, ci); }
        }
      }
      if (key === null) return { error: `line ${lineNo} is not "key: value"` };
      // Trailing spaces and tabs dropped.
      let re = raw.length;
      while (re > 0) {
        const c = raw.charCodeAt(re - 1);
        if (c === 32 || c === 9) re--;
        else break;
      }
      raw = raw.slice(0, re);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

/* ---------------------------------------------------------- markdown inline */

function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

// First index from `from` where `s` holds `what` outside a backslash escape.
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// First single * from `from` (one whose run is not **), outside an escape.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    if (isWsCode(s.charCodeAt(i))) return true;
  }
  return false;
}

// Render inline markup, appending chunks to `parts`. The string form is
// inlineStr below; this form avoids a join per block (paragraphs and list
// items write straight into the page's chunk array).
function inlineInto(s, env, parts) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    // Jump to the next character that can start an inline construct, with
    // native indexOf scans, instead of walking every character in JS.
    let j = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j === n) {
      parts.push(escapeHtml(s.slice(i)));
      break;
    }
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      if (j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
        if (j > i) parts.push(escapeHtml(s.slice(i, j)));
        parts.push(escapeHtml(s[j + 1]));
        i = j + 2;
      } else {
        // Not an escape: the backslash is itself, part of the plain text.
        parts.push(escapeHtml(s.slice(i, j + 1)));
        i = j + 1;
      }
      continue;
    }
    if (c === 96) { // backtick: code span
      const m = s.indexOf('`', j + 1);
      if (m > j + 1) {
        if (j > i) parts.push(escapeHtml(s.slice(i, j)));
        parts.push('<code>', escapeHtml(s.slice(j + 1, m)), '</code>');
        i = m + 1;
      } else {
        parts.push(escapeHtml(s.slice(i, j + 1)));
        i = j + 1;
      }
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(j + 1) === 42) {
        const m = findUnescaped(s, '**', j + 2);
        if (m > j + 2) {
          if (j > i) parts.push(escapeHtml(s.slice(i, j)));
          parts.push('<strong>');
          inlineInto(s.slice(j + 2, m), env, parts);
          parts.push('</strong>');
          i = m + 2;
        } else {
          parts.push(escapeHtml(s.slice(i, j + 2)));
          i = j + 2;
        }
        continue;
      }
      const m = findSingleStar(s, j + 1);
      if (m > j + 1) {
        if (j > i) parts.push(escapeHtml(s.slice(i, j)));
        parts.push('<em>');
        inlineInto(s.slice(j + 1, m), env, parts);
        parts.push('</em>');
        i = m + 1;
      } else {
        parts.push(escapeHtml(s.slice(i, j + 1)));
        i = j + 1;
      }
      continue;
    }
    // '['
    const kk = findUnescaped(s, ']', j + 1);
    const m = kk !== -1 && s.charCodeAt(kk + 1) === 40 ? s.indexOf(')', kk + 2) : -1;
    const target = m === -1 ? '' : s.slice(kk + 2, m);
    if (target !== '' && !hasWhitespace(target)) {
      if (j > i) parts.push(escapeHtml(s.slice(i, j)));
      parts.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s.slice(j + 1, kk), env, parts);
      parts.push('</a>');
      i = m + 1;
      continue;
    }
    parts.push(escapeHtml(s.slice(i, j + 1)));
    i = j + 1;
  }
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  const parts = [];
  inlineInto(s, env, parts);
  return parts.join('');
}

/* ---------------------------------------------------------- markdown blocks */

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Fence open: ``` + optional language (A-Z a-z 0-9 _ + -), then spaces/tabs.
// Returns the language, or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(start, langEnd);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 #, at least one space/tab, then non-empty text (trailing
// spaces/tabs dropped). Returns { depth, text } or null.
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h + 1;
  while (s < line.length) {
    const cc = line.charCodeAt(s);
    if (cc !== 32 && cc !== 9) break;
    s++;
  }
  let e = line.length;
  while (e > s) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e === s) return null;
  return { depth: h, text: line.slice(s, e) };
}

function isHr(line) {
  if (line !== '---' && line !== '***') {
    // '---' or '***' followed by spaces/tabs only
    if (line.length < 3) return false;
    const head = line.slice(0, 3);
    if (head !== '---' && head !== '***') return false;
    for (let i = 3; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return true;
}

function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e) {
    const c = line.charCodeAt(s);
    if (c === 32 || c === 9) s++;
    else break;
  }
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return line.slice(s, e);
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// Render one body: { html, toc, excerpt }. env: { link, slugCache }.
// Blocks write their chunks straight into one array (each block's chunks
// end with "\n"), so the HTML is joined once, not once per block.
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const chunks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      chunks.push(`<pre><code${cls}>`);
      for (let k = 0; k < body.length; k++) chunks.push(escapeHtml(body[k]), '\n');
      chunks.push('</code></pre>', '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(env.slug(heading.text), ids);
      const html = inlineStr(heading.text, env);
      chunks.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      chunks.push('<hr>', '\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // blockquote
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) chunks.push('<blockquote>\n</blockquote>', '\n');
      else {
        chunks.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), env, chunks);
        chunks.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // List?
    let bullet = false;
    let ordered = false;
    let startNum = 1;
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      bullet = true;
    } else {
      // digits '.' ' '
      let d = 0;
      while (d < line.length && d < 9) {
        const c = line.charCodeAt(d);
        if (c < 48 || c > 57) break;
        d++;
      }
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        startNum = Number(line.slice(0, d));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < L) {
        const l = lines[i];
        if (ordered) {
          let d = 0;
          while (d < l.length && d < 9) {
            const c = l.charCodeAt(d);
            if (c < 48 || c > 57) break;
            d++;
          }
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) {
            items.push([trimLine(l.slice(d + 2))]);
            i++;
            continue;
          }
        } else {
          const cc = l.charCodeAt(0);
          if ((cc === 45 || cc === 42) && l.charCodeAt(1) === 32) {
            items.push([trimLine(l.slice(2))]);
            i++;
            continue;
          }
        }
        // continuation: 2+ spaces then a non-whitespace character
        let sp = 0;
        while (sp < l.length && l.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < l.length && !isWsCode(l.charCodeAt(sp))) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      chunks.push(open, '\n');
      for (let k = 0; k < items.length; k++) {
        chunks.push('<li>');
        inlineInto(items[k].join('\n'), env, chunks);
        chunks.push('</li>', '\n');
      }
      chunks.push(`</${tag}>`, '\n');
      continue;
    }
    // Paragraph.
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      // The first paragraph's HTML is also the excerpt, so it is built as
      // one string; later paragraphs write into the chunk array directly.
      const html = inlineStr(text, env);
      excerpt = html;
      chunks.push('<p>', html, '</p>', '\n');
    } else {
      chunks.push('<p>');
      inlineInto(text, env, chunks);
      chunks.push('</p>', '\n');
    }
  }
  return { html: chunks.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------------------------------------------------- templates */

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let v = scope[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render nodes into `out` (an array of string chunks). `scope` is one flat
// object holding every visible name: the page's values plus the innermost
// loop's element and `loop`. A for-loop saves the names it binds, sets them,
// renders its body, and restores them, so nesting and self-includes (which
// re-enter a loop while it runs) keep the right values. One fixed-shape
// object per render keeps every lookup monomorphic, and no object is
// allocated per loop iteration.
function renderNodes(nodes, scope, out, ctx, depth) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, out, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const oldVal = scope[n.name];
        const oldLoop = scope.loop;
        const loopObj = { index: 0, first: false, last: false, length: len };
        scope.loop = loopObj;
        for (let k = 0; k < len; k++) {
          scope[n.name] = xs[k];
          loopObj.index = k + 1;
          loopObj.first = k === 0;
          loopObj.last = k === len - 1;
          renderNodes(n.body, scope, out, ctx, depth);
        }
        scope[n.name] = oldVal;
        scope.loop = oldLoop;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, out, ctx, depth + 1);
        break;
      }
    }
  }
}

/* ---------------------------------------------------------- the build */

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  // Per-case caches (fresh every run; nothing survives to the next case).
  const slugCache = new Map();
  const slug = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const dateCache = new Map();
  const long = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) {
      v = longDate(date);
      dateCache.set(date, v);
    }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out. The loop-variable names are collected so a
  // render's scope object can hold them all from the start.
  const templates = new Map();
  const forNames = new Set();
  const collectForNames = (nodes) => {
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      if (n.kind === 'for') {
        forNames.add(n.name);
        collectForNames(n.body);
      } else if (n.kind === 'if') {
        collectForNames(n.then);
        if (n.else !== null) collectForNames(n.else);
      }
    }
  };
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let ti = 0; ti < tNames.length; ti++) {
    const name = tNames[ti];
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
      collectForNames(nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. Sources, sorted by path in code-unit order; .md sources have their
  // line ends made "\n", anything else is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks, in order.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (let fi = 0; fi < statics.length; fi++) staticPaths.add(statics[fi].path);
  const broken = new Set();
  const resolveCache = new Map();
  const hrefCache = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      slug,
      link: (target) => {
        const ck = `${dir}\n${target}`;
        const hit = hrefCache.get(ck);
        if (hit !== undefined) {
          // A cached miss still reports, under this source's own path.
          if (hit === null) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit === null ? target : hit;
        }
        let href;
        const c0 = target.charCodeAt(0);
        let scheme = false;
        if (c0 >= 65 && c0 <= 90 || c0 >= 97 && c0 <= 122) {
          for (let k = 1; k < target.length; k++) {
            const c = target.charCodeAt(k);
            if (c === 58) { scheme = true; break; }
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
          }
        }
        if (scheme || c0 === 47 || c0 === 35) {
          href = target;
        } else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          let path = null;
          if (rel !== '') {
            const rk = `${dir}\n${rel}`;
            if (resolveCache.has(rk)) path = resolveCache.get(rk);
            else {
              path = resolvePath(dirParts, rel);
              resolveCache.set(rk, path);
            }
          }
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else {
            broken.add(`broken-link ${s.path} -> ${target}`);
            href = null; // sentinel: unresolved, kept as written
          }
        }
        hrefCache.set(ck, href);
        return href === null ? target : href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const ownTagsOf = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      if (!seen.has(slug(name))) {
        seen.add(slug(name));
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names = ownTagsOf(p);
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (s.post) continue;
    const names = ownTagsOf(s);
    s.tagRefs = names.map((name) => {
      const sl = slug(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages, and the layouts.
  const cardOf = (s) => {
    // reading_minutes is the same for a source's card and its page: count
    // its words once.
    if (s.readingMinutes === undefined) s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : long(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : long(s.data.date) });
  // One card object per source, shared by its page and by every list that
  // shows it (templates only read cards, so sharing is safe).
  for (let si = 0; si < kept.length; si++) kept[si].card = cardOf(kept[si]);
  const cards = new Map();
  for (let pi = 0; pi < posts.length; pi++) cards.set(posts[pi], posts[pi].card);

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    // One scope object with a fixed shape: every loop variable name first
    // (undefined until a loop binds it), then the shared values, then this
    // render's own values.
    const scope = {};
    for (const fn of forNames) scope[fn] = undefined;
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    scope.page = undefined;
    scope.posts = undefined;
    scope.pager = undefined;
    scope.tag = undefined;
    scope.loop = undefined;
    for (const k in vars) scope[k] = vars[k];
    const out = [];
    renderNodes(nodes, scope, out, ctx, 0);
    return out.join('');
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
