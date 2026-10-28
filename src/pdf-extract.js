// Minimal text-based PDF text extractor (zero dependencies).
// Supports: xref tables + xref streams + object streams, FlateDecode /
// ASCIIHex / ASCII85 content streams, WinAnsi / MacRoman / Differences /
// ToUnicode / embedded-Type1-built-in font decoding, per-page text with
// rough line breaks.
// Scope: text-based PDFs. Scanned-image PDFs and /Encrypt are out of scope.
// Layout use is minimal but genuine: text-matrix positions drive line breaks,
// word spaces, and tab markers for wide same-line gutters (column gaps), so
// side-by-side grids stay distinguishable in the flattened text. No table
// geometry: downstream separation of merged grids is still best-effort.

import { inflateSync } from 'node:zlib';

// ---------- character tables ----------

const WINANSI_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function winAnsiByteToCodePoint(b) {
  if (b < 0x80 || b >= 0xa0) return b;
  return WINANSI_HIGH[b] ?? 0xfffd;
}

// MacRoman high-byte table (bytes 0x80-0xFF in order).
const MACROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéè' +
  'êëíìîïñóòôöõúùûü' +
  '†°¢£§•¶ß®©™´¨≠ÆØ' +
  '∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ' +
  '–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ' +
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ' +
  '�ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
if (MACROMAN_HIGH.length !== 128) throw new Error('MacRoman table corrupted');

function macRomanByteToCodePoint(b) {
  if (b < 0x80) return b;
  return MACROMAN_HIGH.codePointAt(b - 0x80);
}

// Common Adobe glyph names (for /Differences and non-ToUnicode fonts).
const GLYPH_MAP = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$',
  percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '-', period: '.',
  slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':',
  semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
  bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}',
  asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quoteleft: '‘',
  quoteright: '’', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚',
  quotedblbase: '„', Euro: '€', euro: '€', copyright: '©', registered: '®',
  trademark: '™', degree: '°', plusminus: '±', multiply: '×', divide: '÷',
  periodcentered: '·', ellipsis: '…', dagger: '†', daggerdbl: '‡',
  section: '§', paragraph: '¶', sterling: '£', yen: '¥', cent: '¢',
  fl: 'ﬂ', fi: 'ﬁ', ffi: 'ﬃ', ffl: 'ﬄ',
  lessequal: '≤', greaterequal: '≥', arrowright: '→',
  parenleftbigg: '(', parenrightbigg: ')',
};
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') GLYPH_MAP[ch] = ch;

function glyphNameToUnicode(name, byte) {
  if (name === '.notdef') return '';
  if (Object.hasOwn(GLYPH_MAP, name)) return GLYPH_MAP[name];
  const m = /^(?:uni|u)([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    try {
      return String.fromCodePoint(parseInt(m[1], 16));
    } catch {
      return '?';
    }
  }
  if (name.length === 1) return name;
  return codePointToString(winAnsiByteToCodePoint(byte));
}

function codePointToString(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '?';
  }
}

// ---------- low-level PDF object parser ----------

const isWhite = (b) => b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
const isDelim = (b) =>
  b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d ||
  b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25;

function skipWs(buf, pos) {
  while (pos < buf.length) {
    const b = buf[pos];
    if (b === 0x25) {
      while (pos < buf.length && buf[pos] !== 0x0a && buf[pos] !== 0x0d) pos += 1;
      continue;
    }
    if (!isWhite(b)) break;
    pos += 1;
  }
  return pos;
}

function parseName(buf, pos) {
  // pos points at '/'
  pos += 1;
  const out = [];
  while (pos < buf.length && !isWhite(buf[pos]) && !isDelim(buf[pos])) {
    if (buf[pos] === 0x23 && pos + 2 < buf.length) {
      const hex = buf.subarray(pos + 1, pos + 3).toString('latin1');
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        pos += 3;
        continue;
      }
    }
    out.push(buf[pos]);
    pos += 1;
  }
  return { value: { type: 'name', name: Buffer.from(out).toString('latin1') }, pos };
}

function parseLiteralString(buf, pos) {
  // pos points at '('
  pos += 1;
  const out = [];
  let depth = 1;
  while (pos < buf.length && depth > 0) {
    const b = buf[pos];
    if (b === 0x5c) {
      const n = buf[pos + 1];
      if (n === 0x6e) { out.push(0x0a); pos += 2; }
      else if (n === 0x72) { out.push(0x0d); pos += 2; }
      else if (n === 0x74) { out.push(0x09); pos += 2; }
      else if (n === 0x62) { out.push(0x08); pos += 2; }
      else if (n === 0x66) { out.push(0x0c); pos += 2; }
      else if (n === 0x0d) { pos += buf[pos + 2] === 0x0a ? 3 : 2; }
      else if (n === 0x0a) { pos += 2; }
      else if (n >= 0x30 && n <= 0x37) {
        let j = pos + 1;
        let oct = '';
        while (j < buf.length && oct.length < 3 && buf[j] >= 0x30 && buf[j] <= 0x37) {
          oct += String.fromCharCode(buf[j]);
          j += 1;
        }
        out.push(parseInt(oct, 8) & 0xff);
        pos = j;
      } else if (n !== undefined) {
        out.push(n);
        pos += 2;
      } else {
        pos += 1;
      }
      continue;
    }
    if (b === 0x28) depth += 1;
    if (b === 0x29) {
      depth -= 1;
      if (depth === 0) {
        pos += 1;
        break;
      }
    }
    out.push(b);
    pos += 1;
  }
  return { value: { type: 'str', data: Buffer.from(out) }, pos };
}

function parseHexString(buf, pos) {
  // pos points at '<' (not '<<')
  pos += 1;
  let hex = '';
  while (pos < buf.length && buf[pos] !== 0x3e) {
    const b = buf[pos];
    if (!isWhite(b)) hex += String.fromCharCode(b);
    pos += 1;
  }
  pos += 1; // consume '>'
  if (hex.length % 2 === 1) hex += '0';
  return { value: { type: 'hex', data: Buffer.from(hex, 'hex') }, pos };
}

function parseNumberOrRef(buf, pos) {
  const start = pos;
  while (pos < buf.length && /[0-9+\-.]/.test(String.fromCharCode(buf[pos]))) pos += 1;
  const raw = buf.subarray(start, pos).toString('latin1');
  const afterFirst = skipWs(buf, pos);
  const m = /^(\d+)\s+R\b/.exec(buf.subarray(afterFirst, afterFirst + 32).toString('latin1'));
  if (/^-?\d+$/.test(raw) && m) {
    const secondEnd = afterFirst + m[0].length;
    return { value: { type: 'ref', num: Number(raw), gen: Number(m[1]) }, pos: secondEnd };
  }
  return { value: { type: 'num', num: Number(raw) }, pos };
}

function parseValue(buf, pos, depth = 0) {
  if (depth > 50) throw new Error('PDF nesting too deep');
  pos = skipWs(buf, pos);
  if (pos >= buf.length) throw new Error('Unexpected end of PDF data');
  const b = buf[pos];
  if (b === 0x28) return parseLiteralString(buf, pos);
  if (b === 0x3c) {
    if (buf[pos + 1] === 0x3c) {
      pos += 2;
      const dict = new Map();
      for (;;) {
        pos = skipWs(buf, pos);
        if (buf[pos] === 0x3e && buf[pos + 1] === 0x3e) {
          pos += 2;
          break;
        }
        const key = parseName(buf, pos);
        pos = key.pos;
        const val = parseValue(buf, pos, depth + 1);
        pos = val.pos;
        dict.set(key.value.name, val.value);
      }
      return { value: { type: 'dict', dict }, pos };
    }
    return parseHexString(buf, pos);
  }
  if (b === 0x2f) return parseName(buf, pos);
  if (b === 0x5b) {
    pos += 1;
    const items = [];
    for (;;) {
      pos = skipWs(buf, pos);
      if (buf[pos] === 0x5d) {
        pos += 1;
        break;
      }
      const val = parseValue(buf, pos, depth + 1);
      pos = val.pos;
      items.push(val.value);
    }
    return { value: { type: 'arr', items }, pos };
  }
  if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
    return parseNumberOrRef(buf, pos);
  }
  const word = /^[A-Za-z][A-Za-z0-9]*/.exec(buf.subarray(pos, pos + 16).toString('latin1'));
  if (word) {
    const w = word[0];
    pos += w.length;
    if (w === 'true') return { value: { type: 'bool', bool: true }, pos };
    if (w === 'false') return { value: { type: 'bool', bool: false }, pos };
    if (w === 'null') return { value: { type: 'null' }, pos };
    return { value: { type: 'op', op: w }, pos };
  }
  throw new Error(`Cannot parse PDF value at offset ${pos}`);
}

// ---------- stream filters ----------

function asciiHexDecode(buf) {
  let hex = buf.toString('latin1').replace(/\s+/g, '');
  const eod = hex.indexOf('>');
  if (eod >= 0) hex = hex.slice(0, eod);
  if (hex.length % 2 === 1) hex += '0';
  return Buffer.from(hex, 'hex');
}

function ascii85Decode(buf) {
  const text = buf.toString('latin1').replace(/\s+/g, '');
  const out = [];
  let i = 0;
  const end = text.includes('~>') ? text.indexOf('~>') : text.length;
  while (i < end) {
    const ch = text[i];
    if (ch === 'z') {
      out.push(0, 0, 0, 0);
      i += 1;
      continue;
    }
    const group = text.slice(i, Math.min(i + 5, end));
    const n = group.length;
    const padded = group + 'u'.repeat(5 - n);
    let acc = 0;
    for (const c of padded) {
      const v = c.charCodeAt(0) - 33;
      if (v < 0 || v > 84) throw new Error('Invalid ASCII85 data');
      acc = acc * 85 + v;
    }
    const bytes = [(acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff];
    out.push(...bytes.slice(0, n - 1));
    i += n;
  }
  return Buffer.from(out);
}

function decodeStreamData(dict, data) {
  let filters = dict.get('Filter');
  if (!filters) return Buffer.from(data);
  if (filters.type === 'name') filters = [filters.name];
  else if (filters.type === 'arr') filters = filters.items.map((f) => (f.type === 'name' ? f.name : ''));
  else return Buffer.from(data);
  let out = Buffer.from(data);
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') out = inflateSync(out);
    else if (f === 'ASCIIHexDecode' || f === 'AHx') out = asciiHexDecode(out);
    else if (f === 'ASCII85Decode' || f === 'A85') out = ascii85Decode(out);
    else if (f === '') continue;
    else throw new Error(`Unsupported PDF stream filter: ${f}`);
  }
  return out;
}

// ---------- indirect object access ----------

function keyOf(num, gen) {
  return `${num}_${gen}`;
}

class PdfReader {
  constructor(buf) {
    this.buf = Buffer.from(buf);
    this.offsets = new Map();
    this.compressed = new Map();
    this.cache = new Map();
    this.objStmCache = new Map();
    this.trailer = new Map();
    this.buildIndex();
  }

  buildIndex() {
    const marker = Buffer.from('startxref');
    const at = this.buf.lastIndexOf(marker);
    if (at < 0) {
      this.fallbackScan();
      return;
    }
    const tail = this.buf.subarray(at, at + 64).toString('latin1');
    const m = /startxref\s+(\d+)/.exec(tail);
    if (!m) {
      this.fallbackScan();
      return;
    }
    const visited = new Set();
    let pos = Number(m[1]);
    let found = false;
    while (Number.isInteger(pos) && pos >= 0 && pos < this.buf.length && !visited.has(pos)) {
      visited.add(pos);
      const p = skipWs(this.buf, pos);
      if (this.buf.subarray(p, p + 4).toString('latin1') === 'xref') {
        const next = this.parseTableXref(p + 4);
        found = true;
        pos = next;
      } else {
        const next = this.parseStreamXref(p);
        found = true;
        pos = next;
      }
    }
    if (!found || (this.offsets.size === 0 && this.compressed.size === 0)) {
      this.fallbackScan();
    }
  }

  parseTableXref(pos) {
    for (;;) {
      pos = skipWs(this.buf, pos);
      if (this.buf.subarray(pos, pos + 7).toString('latin1') === 'trailer') {
        const t = parseValue(this.buf, pos + 7);
        // Capture /Prev before merging: mergeTrailer never stores /Prev.
        const prev = t.value && t.value.type === 'dict' ? t.value.dict.get('Prev') : undefined;
        this.mergeTrailer(t.value);
        return prev && prev.type === 'num' ? prev.num : -1;
      }
      const head = /^(\d+)\s+(\d+)/.exec(this.buf.subarray(pos, pos + 32).toString('latin1'));
      if (!head) throw new Error('Malformed xref table');
      pos += head[0].length;
      const first = Number(head[1]);
      const count = Number(head[2]);
      for (let i = 0; i < count; i += 1) {
        pos = skipWs(this.buf, pos);
        const entry = /^(\d{10})\s+(\d{5})\s+([fn])/.exec(
          this.buf.subarray(pos, pos + 24).toString('latin1')
        );
        if (!entry) throw new Error('Malformed xref entry');
        pos += entry[0].length;
        if (entry[3] === 'n') {
          this.recordOffset(first + i, Number(entry[2]), Number(entry[1]));
        }
      }
    }
  }

  parseStreamXref(pos) {
    const obj = this.parseIndirect(pos);
    if (!obj || obj.type !== 'stream') throw new Error('Malformed xref stream');
    const dict = obj.dict;
    this.mergeTrailer({ type: 'dict', dict });
    const widths = dictValue(dict, 'W');
    const size = dictValue(dict, 'Size');
    if (!widths || widths.type !== 'arr' || !size || size.type !== 'num') {
      throw new Error('Malformed xref stream dictionary');
    }
    const [w1, w2, w3] = widths.items.map((w) => (w.type === 'num' ? w.num : 0));
    const entryLen = w1 + w2 + w3;
    const raw = decodeStreamData(dict, obj.data);
    let index = dictValue(dict, 'Index');
    let sections = [[0, size.num]];
    if (index && index.type === 'arr') {
      sections = [];
      for (let i = 0; i + 1 < index.items.length; i += 2) {
        sections.push([numValue(index.items[i]), numValue(index.items[i + 1])]);
      }
    }
    let cursor = 0;
    const readInt = (n) => {
      let v = 0;
      for (let i = 0; i < n; i += 1) v = v * 256 + raw[cursor + i];
      cursor += n;
      return v;
    };
    for (const [first, count] of sections) {
      for (let i = 0; i < count; i += 1) {
        if (cursor + entryLen > raw.length) break;
        const type = w1 === 0 ? 1 : readInt(w1);
        const field2 = readInt(w2);
        const field3 = readInt(w3);
        if (type === 1) this.recordOffset(first + i, field3, field2);
        else if (type === 2) this.recordCompressed(first + i, field2, field3);
      }
    }
    const prev = dict.get('Prev');
    return prev && prev.type === 'num' ? prev.num : -1;
  }

  mergeTrailer(value) {
    if (!value || value.type !== 'dict') return;
    for (const [k, v] of value.dict) {
      if (k === 'Prev') continue;
      if (!this.trailer.has(k)) this.trailer.set(k, v);
    }
  }

  // The xref chain is walked newest-first, so the first record seen for an
  // object is its newest revision and older sections must not overwrite it.
  // Both maps are checked: an object may move between plain and compressed
  // storage across incremental updates.
  recordOffset(num, gen, offset) {
    const k = keyOf(num, gen);
    if (this.offsets.has(k) || this.compressed.has(k)) return;
    this.offsets.set(k, offset);
  }

  recordCompressed(num, stm, idx) {
    const k = keyOf(num, 0);
    if (this.compressed.has(k) || this.offsets.has(k)) return;
    this.compressed.set(k, { stm, idx });
  }

  fallbackScan() {
    const text = this.buf.toString('latin1');
    const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const k = keyOf(Number(m[1]), Number(m[2]));
      if (!this.offsets.has(k)) this.offsets.set(k, m.index);
    }
  }

  parseIndirect(offset) {
    let pos = skipWs(this.buf, offset);
    const head = /^(\d+)\s+(\d+)\s+obj\b/.exec(this.buf.subarray(pos, pos + 32).toString('latin1'));
    if (!head) throw new Error(`No indirect object at offset ${offset}`);
    pos += head[0].length;
    const parsed = parseValue(this.buf, pos);
    pos = skipWs(this.buf, parsed.pos);
    if (parsed.value.type === 'dict' && /^stream(\r\n|\r|\n)/.test(bufSlice(this.buf, pos, 9))) {
      const eol = this.buf[pos + 6] === 0x0d && this.buf[pos + 7] === 0x0a ? 8 : 7;
      pos += eol;
      let length = dictValue(parsed.value.dict, 'Length');
      length = this.resolveOne(length);
      let end;
      if (length && length.type === 'num') {
        end = pos + length.num;
      } else {
        end = this.buf.indexOf(Buffer.from('endstream'), pos);
        if (end < 0) throw new Error('Unterminated stream');
      }
      return { type: 'stream', dict: parsed.value.dict, data: this.buf.subarray(pos, end) };
    }
    return parsed.value;
  }

  get(num, gen = 0) {
    const k = keyOf(num, gen);
    if (this.cache.has(k)) return this.cache.get(k);
    let value = null;
    if (this.compressed.has(k)) {
      const { stm, idx } = this.compressed.get(k);
      value = this.readObjStm(stm, idx);
    } else if (this.offsets.has(k)) {
      value = this.parseIndirect(this.offsets.get(k));
    } else if (gen !== 0 && (this.offsets.has(keyOf(num, 0)) || this.compressed.has(keyOf(num, 0)))) {
      return this.get(num, 0);
    }
    this.cache.set(k, value);
    return value;
  }

  readObjStm(stmNum, idx) {
    if (!this.objStmCache.has(stmNum)) {
      const stm = this.get(stmNum, 0);
      if (!stm || stm.type !== 'stream') throw new Error(`Bad object stream ${stmNum}`);
      const raw = decodeStreamData(stm.dict, stm.data);
      const n = numValue(this.resolveOne(dictValue(stm.dict, 'N')));
      const first = numValue(this.resolveOne(dictValue(stm.dict, 'First')));
      const headerNums = raw.subarray(0, first).toString('latin1').trim().split(/\s+/).map(Number);
      const entries = [];
      for (let i = 0; i < n; i += 1) {
        const off = headerNums[i * 2 + 1];
        entries.push(parseValue(raw, first + off).value);
      }
      this.objStmCache.set(stmNum, entries);
    }
    return this.objStmCache.get(stmNum)[idx] ?? null;
  }

  resolveOne(value, depth = 0) {
    let v = value;
    while (v && v.type === 'ref' && depth < 20) {
      v = this.get(v.num, v.gen);
      depth += 1;
    }
    return v && v.type === 'ref' ? null : v;
  }

  rootRef() {
    const fromTrailer = this.resolveOne(this.trailer.get('Root'));
    if (fromTrailer) return fromTrailer;
    // Fallback: locate the catalog by scanning objects.
    for (const [, offset] of this.offsets) {
      try {
        const v = this.parseIndirect(offset);
        const d = v.type === 'dict' ? v.dict : null;
        if (d && dictValue(d, 'Type')?.name === 'Catalog') return v;
      } catch {
        // ignore unparseable objects during scan
      }
    }
    return null;
  }

  collectPages() {
    const root = this.rootRef();
    if (!root || root.type !== 'dict') throw new Error('PDF catalog not found');
    if (this.trailer.get('Encrypt')) throw new Error('Encrypted PDFs are not supported in this demo');
    const pages = this.resolveOne(dictValue(root.dict, 'Pages'));
    if (!pages || pages.type !== 'dict') throw new Error('PDF page tree not found');
    const out = [];
    const walk = (node, inheritedResources) => {
      const resources = dictValue(node.dict, 'Resources') ?? inheritedResources;
      const kids = this.resolveOne(dictValue(node.dict, 'Kids'));
      if (kids && kids.type === 'arr') {
        for (const kid of kids.items) {
          const resolved = this.resolveOne(kid);
          if (resolved && resolved.type === 'dict') walk(resolved, resources);
        }
        return;
      }
      out.push({ dict: node.dict, resources: this.resolveOne(resources) });
    };
    walk(pages, null);
    return out;
  }

  pageContentBytes(page) {
    const contents = this.resolveOne(dictValue(page.dict, 'Contents'));
    if (!contents) return Buffer.alloc(0);
    const parts = [];
    const push = (v) => {
      const s = this.resolveOne(v);
      if (s && s.type === 'stream') parts.push(decodeStreamData(s.dict, s.data));
    };
    if (contents.type === 'arr') {
      for (const item of contents.items) push(item);
    } else {
      push(contents);
    }
    return Buffer.concat(parts);
  }
}

function bufSlice(buf, pos, len) {
  return buf.subarray(pos, pos + len).toString('latin1');
}

function dictValue(dict, name) {
  if (!dict || typeof dict.get !== 'function') return undefined;
  return dict.get(name);
}

function numValue(v) {
  return v && v.type === 'num' ? v.num : 0;
}

// ---------- ToUnicode CMap ----------

function utf16beToString(buf) {
  const units = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    units.push((buf[i] << 8) | buf[i + 1]);
  }
  return String.fromCharCode(...units);
}

function parseToUnicode(data) {
  const text = data.toString('latin1');
  const map = new Map();
  const clean = (h) => h.replace(/\s+/g, '').toLowerCase();
  for (const block of text.matchAll(/beginbfchar(.*?)endbfchar/gs)) {
    for (const e of block[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      map.set(clean(e[1]), utf16beToString(Buffer.from(clean(e[2]), 'hex')));
    }
  }
  for (const block of text.matchAll(/beginbfrange(.*?)endbfrange/gs)) {
    const body = block[1];
    for (const e of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*\[([^\]]*)\]/g)) {
      const lo = parseInt(clean(e[1]), 16);
      const width = clean(e[1]).length;
      const dsts = [...e[3].matchAll(/<([0-9A-Fa-f\s]+)>/g)];
      dsts.forEach((d, i) => {
        map.set((lo + i).toString(16).padStart(width, '0'), utf16beToString(Buffer.from(clean(d[1]), 'hex')));
      });
    }
    for (const e of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      const lo = parseInt(clean(e[1]), 16);
      const hi = parseInt(clean(e[2]), 16);
      const width = clean(e[1]).length;
      const dstBytes = Buffer.from(clean(e[3]), 'hex');
      if (hi - lo > 100000) continue;
      for (let code = lo; code <= hi; code += 1) {
        // Increment the destination value alongside the source code.
        const dst = Buffer.from(dstBytes);
        let carry = code - lo;
        for (let i = dst.length - 1; i >= 0 && carry > 0; i -= 1) {
          const sum = dst[i] + carry;
          dst[i] = sum & 0xff;
          carry = sum >> 8;
        }
        map.set(code.toString(16).padStart(width, '0'), utf16beToString(dst));
      }
    }
  }
  return map;
}

// ---------- font decoding ----------

// Parse the built-in /Encoding of an embedded Type1 font program: the
// cleartext `dup <code> /<glyph> put` entries. Accepts raw cleartext and
// PFB-wrapped programs (ASCII segments only; the encrypted portion carries
// outlines, never the encoding). Returns an array of 256 glyph names (null
// for unmapped codes), or null when the program carries no encoding so the
// caller keeps its existing fallback instead of guessing.
export function parseType1BuiltInEncoding(program) {
  let text = '';
  try {
    const buf = Buffer.from(program ?? []);
    if (buf.length >= 6 && buf[0] === 0x80 && buf[1] === 0x01) {
      const parts = [];
      let pos = 0;
      while (pos + 6 <= buf.length && buf[pos] === 0x80) {
        const kind = buf[pos + 1];
        if (kind === 0x03) break;
        const len = buf.readUInt32LE(pos + 2);
        const start = pos + 6;
        if (start + len > buf.length) break;
        if (kind === 0x01) parts.push(buf.subarray(start, start + len));
        pos = start + len;
      }
      text = Buffer.concat(parts).toString('latin1');
    } else {
      text = buf.toString('latin1');
    }
  } catch {
    return null;
  }
  if (!text.includes('/Encoding')) return null;
  const names = new Array(256).fill(null);
  let count = 0;
  for (const m of text.matchAll(/dup\s+(\d+)\s*\/([A-Za-z0-9_]+)\s*put/g)) {
    const code = Number(m[1]);
    if (code < 0 || code > 255) continue;
    if (names[code] === null) count += 1;
    names[code] = m[2];
  }
  return count > 0 ? names : null;
}

// Built-in encoding of a simple font's embedded Type1 program (/FontFile):
// the PDF spec's designated decoding when the font dict carries no
// /Encoding of its own. Returns null for anything else (TrueType/CFF
// programs, missing descriptors) so decoding falls through unchanged.
function builtInEncodingNames(reader, dict) {
  try {
    const descriptor = reader.resolveOne(dictValue(dict, 'FontDescriptor'));
    if (!descriptor || descriptor.type !== 'dict') return null;
    const program = reader.resolveOne(dictValue(descriptor.dict, 'FontFile'));
    if (!program || program.type !== 'stream') return null;
    return parseType1BuiltInEncoding(decodeStreamData(program.dict, program.data));
  } catch {
    return null;
  }
}

function buildFontDecoder(reader, fontValue) {
  const font = reader.resolveOne(fontValue);
  const empty = { decode: (bytes) => bytes.toString('latin1') };
  if (!font || font.type !== 'dict') return empty;
  const dict = font.dict;
  const subtype = dictValue(dict, 'Subtype')?.name;
  const composite = subtype === 'Type0';
  let baseName = 'WinAnsiEncoding';
  const diffNames = new Array(256).fill(null);
  const enc = reader.resolveOne(dictValue(dict, 'Encoding'));
  if (enc && enc.type === 'name') {
    baseName = enc.name;
  } else if (enc && enc.type === 'dict') {
    baseName = reader.resolveOne(dictValue(enc.dict, 'BaseEncoding'))?.name ?? baseName;
    const diffs = reader.resolveOne(dictValue(enc.dict, 'Differences'));
    if (diffs && diffs.type === 'arr') {
      let code = 0;
      for (const item of diffs.items) {
        const r = reader.resolveOne(item);
        if (!r) continue;
        if (r.type === 'num') code = r.num;
        else if (r.type === 'name' && code >= 0 && code < 256) {
          diffNames[code] = r.name;
          code += 1;
        }
      }
    }
  }
  const baseByte =
    baseName === 'MacRomanEncoding' ? macRomanByteToCodePoint : winAnsiByteToCodePoint;
  let toUnicode = new Map();
  const tuRef = dictValue(dict, 'ToUnicode') ?? descendantToUnicode(reader, dict);
  const tu = reader.resolveOne(tuRef);
  if (tu && tu.type === 'stream') {
    try {
      toUnicode = parseToUnicode(decodeStreamData(tu.dict, tu.data));
    } catch {
      toUnicode = new Map();
    }
  }

  // Simple fonts without their own /Encoding, /Differences, or /ToUnicode
  // coverage decode through the embedded program's built-in encoding (the
  // PDF spec fallback), before the WinAnsi/MacRoman guess. Resolved once
  // per font; the decoder itself is cached per font object.
  const builtIn = composite ? null : builtInEncodingNames(reader, dict);
  const decodeSimpleByte = (b) => {
    const key = b.toString(16).padStart(2, '0');
    if (toUnicode.has(key)) return toUnicode.get(key);
    const diff = diffNames[b];
    if (diff) return glyphNameToUnicode(diff, b);
    const builtin = builtIn ? builtIn[b] : null;
    if (builtin) return glyphNameToUnicode(builtin, b);
    return codePointToString(baseByte(b));
  };

  return {
    decode(bytes) {
      let out = '';
      if (composite) {
        for (let i = 0; i < bytes.length;) {
          const two = bytes.subarray(i, i + 2).toString('hex');
          const one = bytes.subarray(i, i + 1).toString('hex');
          if (i + 1 < bytes.length && toUnicode.has(two)) {
            out += toUnicode.get(two);
            i += 2;
          } else if (toUnicode.has(one)) {
            out += toUnicode.get(one);
            i += 1;
          } else if (i + 1 < bytes.length) {
            const code = (bytes[i] << 8) | bytes[i + 1];
            out += code < 0x100 ? codePointToString(winAnsiByteToCodePoint(code)) : codePointToString(code);
            i += 2;
          } else {
            out += codePointToString(winAnsiByteToCodePoint(bytes[i]));
            i += 1;
          }
        }
      } else {
        for (const b of bytes) out += decodeSimpleByte(b);
      }
      return out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    },
  };
}

function descendantToUnicode(reader, dict) {
  const desc = reader.resolveOne(dictValue(dict, 'DescendantFonts'));
  if (desc && desc.type === 'arr' && desc.items.length > 0) {
    const first = reader.resolveOne(desc.items[0]);
    if (first && first.type === 'dict') return dictValue(first.dict, 'ToUnicode');
  }
  return undefined;
}

// ---------- content stream interpreter ----------

const OP_ARG_COUNTS = {
  // text state
  Tf: 2, TL: 1, Tc: 1, Tw: 1, Tz: 1, Ts: 1, Tr: 1,
  Tm: 6, Td: 2, TD: 2,
  // graphics / color state (ignored, operands dropped)
  w: 1, J: 1, j: 1, M: 1, d: 2, ri: 1, i: 1, gs: 1,
  cm: 6, m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4,
  S: 0, s: 0, f: 0, F: 0, 'f*': 0, B: 0, 'B*': 0, b: 0, 'b*': 0, n: 0, W: 0, 'W*': 0,
  CS: 1, cs: 1, SC: -1, sc: -1, SCN: -1, scn: -1, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4,
  sh: 1, BX: 0, EX: 0, BMC: 1, EMC: 0, MP: 1, DP: 2,
  d0: 2, d1: 6, Do: 1,
};

function interpretContent(bytes, resolveFont, resolveForm, depth = 0) {
  let Tm = [1, 0, 0, 1, 0, 0];
  let Tlm = [...Tm];
  let font = null;
  let fontSize = 12;
  let leading = 0;
  let inText = false;
  let out = '';
  let lastX = null;
  let lastY = null;
  const stack = [];

  const placeRun = (str) => {
    if (!str) return;
    const x = Tm[4];
    const y = Tm[5];
    const unit = Math.abs(Tm[0]) > 2 ? 1 : Math.max(fontSize, 1);
    if (lastY === null) {
      out += str;
    } else if (Math.abs(y - lastY) > 2) {
      out += `\n${str}`;
    } else if (x > lastX + unit * 2.5) {
      // Wide same-line gap (a column gutter, not a word space): preserve the
      // layout evidence with a tab so side-by-side grids stay distinguishable
      // in the flattened text instead of merging into one space-joined row.
      out += `\t${str}`;
    } else if (x > lastX + unit * 0.25) {
      out += ` ${str}`;
    } else {
      out += str;
    }
    lastX = x + str.length * unit * 0.5;
    lastY = y;
  };

  const showString = (v, firstInSequence) => {
    const bytesValue = v && (v.type === 'str' || v.type === 'hex') ? v.data : null;
    if (!bytesValue) return;
    const decoded = font ? font.decode(bytesValue) : bytesValue.toString('latin1');
    if (firstInSequence) placeRun(decoded);
    else out += decoded;
    if (decoded) {
      const unit = Math.abs(Tm[0]) > 2 ? 1 : Math.max(fontSize, 1);
      lastX = (lastX ?? Tm[4]) + decoded.length * unit * 0.5;
    }
  };

  let pos = 0;
  const takeArgs = (n) => {
    const args = n < 0 ? stack.splice(0) : stack.splice(Math.max(stack.length - n, 0));
    stack.length = 0;
    return args;
  };
  const num = (v) => (v && v.type === 'num' ? v.num : 0);

  while (pos < bytes.length) {
    pos = skipWs(bytes, pos);
    if (pos >= bytes.length) break;
    const b = bytes[pos];
    if (b === 0x28 || b === 0x3c || b === 0x2f || b === 0x5b ||
        (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      try {
        const parsed = parseValue(bytes, pos);
        pos = parsed.pos;
        stack.push(parsed.value);
      } catch {
        pos += 1;
      }
      continue;
    }
    const opMatch = /^([A-Za-z][A-Za-z0-9*]*|'|")/.exec(bytes.subarray(pos, pos + 12).toString('latin1'));
    if (!opMatch) {
      pos += 1;
      stack.length = 0;
      continue;
    }
    const op = opMatch[1];
    pos += op.length;

    if (op === 'BI') {
      // Inline image: skip options + ID + raw data up to EI boundary.
      const idAt = bytes.indexOf(Buffer.from('ID'), pos);
      if (idAt < 0) break;
      let dataStart = idAt + 2;
      if (bytes[dataStart] === 0x0d && bytes[dataStart + 1] === 0x0a) dataStart += 2;
      else if (isWhite(bytes[dataStart])) dataStart += 1;
      let end = dataStart;
      for (;;) {
        end = bytes.indexOf(Buffer.from('EI'), end);
        if (end < 0) {
          pos = bytes.length;
          break;
        }
        if (isWhite(bytes[end - 1]) && (end + 2 >= bytes.length || isWhite(bytes[end + 2]))) {
          pos = end + 2;
          break;
        }
        end += 2;
      }
      stack.length = 0;
      continue;
    }

    switch (op) {
      case 'BT':
        Tm = [1, 0, 0, 1, 0, 0];
        Tlm = [...Tm];
        inText = true;
        stack.length = 0;
        break;
      case 'ET':
        inText = false;
        stack.length = 0;
        break;
      case 'Tm': {
        const a = takeArgs(6).map(num);
        Tlm = [...a];
        Tm = [...a];
        break;
      }
      case 'Td':
      case 'TD': {
        const [tx, ty] = takeArgs(2).map(num);
        if (op === 'TD') leading = -ty;
        const [a, c, e] = [Tlm[0], Tlm[2], Tlm[4]];
        const [bb, d, f] = [Tlm[1], Tlm[3], Tlm[5]];
        Tlm = [a, bb, c, d, tx * a + ty * c + e, tx * bb + ty * d + f];
        Tm = [...Tlm];
        break;
      }
      case 'T*': {
        const [a, c, e] = [Tlm[0], Tlm[2], Tlm[4]];
        const [bb, d, f] = [Tlm[1], Tlm[3], Tlm[5]];
        Tlm = [a, bb, c, d, -leading * c + e, -leading * d + f];
        Tm = [...Tlm];
        stack.length = 0;
        break;
      }
      case 'Tf': {
        const [nameV, sizeV] = takeArgs(2);
        font = nameV && nameV.type === 'name' ? resolveFont(nameV.name) : null;
        fontSize = num(sizeV) || 12;
        break;
      }
      case 'TL':
        leading = num(takeArgs(1)[0]);
        break;
      case 'Tj':
        showString(takeArgs(1)[0], true);
        break;
      case 'TJ': {
        const arr = takeArgs(1)[0];
        if (arr && arr.type === 'arr') {
          let first = true;
          let kernSpace = false;
          for (const item of arr.items) {
            if (item.type === 'num') {
              if (item.num < -100) kernSpace = true;
            } else {
              if (kernSpace && !first && !out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
              kernSpace = false;
              showString(item, first);
              first = false;
            }
          }
        }
        break;
      }
      case "'": {
        const [a, c, e] = [Tlm[0], Tlm[2], Tlm[4]];
        const [bb, d, f] = [Tlm[1], Tlm[3], Tlm[5]];
        Tlm = [a, bb, c, d, -leading * c + e, -leading * d + f];
        Tm = [...Tlm];
        showString(takeArgs(1)[0], true);
        break;
      }
      case '"': {
        const args = takeArgs(3);
        const [a, c, e] = [Tlm[0], Tlm[2], Tlm[4]];
        const [bb, d, f] = [Tlm[1], Tlm[3], Tlm[5]];
        Tlm = [a, bb, c, d, -leading * c + e, -leading * d + f];
        Tm = [...Tlm];
        showString(args[2], true);
        break;
      }
      case 'BDC': {
        takeArgs(2);
        break;
      }
      case 'Do': {
        const [nameV] = takeArgs(1);
        if (depth < 5 && nameV && nameV.type === 'name') {
          const formBytes = resolveForm(nameV.name);
          if (formBytes) {
            const nested = interpretContent(formBytes.bytes, formBytes.resolveFont, formBytes.resolveForm, depth + 1);
            if (nested.trim()) {
              if (out && !out.endsWith('\n')) out += '\n';
              out += nested;
              lastX = null;
              lastY = null;
            }
          }
        }
        break;
      }
      default: {
        if (Object.hasOwn(OP_ARG_COUNTS, op)) takeArgs(OP_ARG_COUNTS[op]);
        else stack.length = 0;
        break;
      }
    }
    void inText;
  }
  return out;
}

// ---------- ingest entry point ----------

/**
 * Extract per-page text from a PDF buffer.
 * @param {Buffer|Uint8Array} input
 * @returns {{ pageCount: number, pages: Array<{ page: number, text: string }> }}
 */
export function extractPdfText(input) {
  const buf = Buffer.from(input);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Not a PDF file (missing %PDF- header)');
  }
  const reader = new PdfReader(buf);
  const pages = reader.collectPages();
  if (pages.length === 0) throw new Error('No pages found in PDF');
  const fontCache = new Map();
  const result = pages.map((page, i) => {
    const resources = page.resources && page.resources.type === 'dict' ? page.resources.dict : new Map();
    const fontDictValue = reader.resolveOne(resources.get('Font'));
    const fontDict = fontDictValue && fontDictValue.type === 'dict' ? fontDictValue.dict : new Map();
    const xobjValue = reader.resolveOne(resources.get('XObject'));
    const xobjDict = xobjValue && xobjValue.type === 'dict' ? xobjValue.dict : new Map();

    const resolveFont = (name) => {
      const ref = fontDict.get(name.startsWith('/') ? name.slice(1) : name);
      if (!ref) return null;
      const cacheKey = ref.type === 'ref' ? keyOf(ref.num, ref.gen) : `${i}:${name}`;
      if (!fontCache.has(cacheKey)) fontCache.set(cacheKey, buildFontDecoder(reader, ref));
      return fontCache.get(cacheKey);
    };
    const resolveForm = (name) => {
      const ref = xobjDict.get(name.startsWith('/') ? name.slice(1) : name);
      const form = reader.resolveOne(ref);
      if (!form || form.type !== 'stream') return null;
      if (form.dict.get('Subtype')?.name !== 'Form') return null;
      const subRes = reader.resolveOne(form.dict.get('Resources'));
      const subDict = subRes && subRes.type === 'dict' ? subRes.dict : resources;
      const subFonts = reader.resolveOne(subDict.get('Font'));
      const subFontDict = subFonts && subFonts.type === 'dict' ? subFonts.dict : new Map();
      const subXobj = reader.resolveOne(subDict.get('XObject'));
      const subXobjDict = subXobj && subXobj.type === 'dict' ? subXobj.dict : new Map();
      return {
        bytes: decodeStreamData(form.dict, form.data),
        resolveFont: (n) => {
          const r = subFontDict.get(n.startsWith('/') ? n.slice(1) : n) ?? fontDict.get(n);
          if (!r) return null;
          const ck = r.type === 'ref' ? keyOf(r.num, r.gen) : `${i}:${n}`;
          if (!fontCache.has(ck)) fontCache.set(ck, buildFontDecoder(reader, r));
          return fontCache.get(ck);
        },
        resolveForm: (n) => {
          const r = subXobjDict.get(n.startsWith('/') ? n.slice(1) : n);
          const f = reader.resolveOne(r);
          if (!f || f.type !== 'stream' || f.dict.get('Subtype')?.name !== 'Form') return null;
          return { bytes: decodeStreamData(f.dict, f.data), resolveFont, resolveForm };
        },
      };
    };

    const rawBytes = reader.pageContentBytes(page);
    const raw = rawBytes.length > 0 ? interpretContent(rawBytes, resolveFont, resolveForm) : '';
    const text = raw.split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').replace(/^\n+|\n+$/g, '');
    return { page: i + 1, text };
  });
  return { pageCount: result.length, pages: result };
}

export { PdfReader };


