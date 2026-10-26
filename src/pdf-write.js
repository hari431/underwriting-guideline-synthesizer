// Minimal multi-page text PDF writer (zero dependencies).
// Used to generate the synthetic guideline fixture. WinAnsi-encoded,
// Helvetica, one content stream per page, FlateDecode-compressed by default.
import { deflateSync } from 'node:zlib';

// Unicode -> WinAnsi byte for the handful of non-ASCII chars fixtures use.
const WINANSI_EXTRA = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85],
  ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a],
  ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c],
  ['ž', 0x9e], ['Ÿ', 0x9f], ['©', 0xa9], ['®', 0xae], ['°', 0xb0],
]);

function encodeWinAnsi(text) {
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      if (ch === '\t') out.push(0x20);
      continue; // drop other controls
    } else if (code < 0x80) {
      out.push(code);
    } else if (code >= 0xa0 && code <= 0xff) {
      out.push(code);
    } else if (WINANSI_EXTRA.has(ch)) {
      out.push(WINANSI_EXTRA.get(ch));
    } else {
      out.push(0x3f); // '?' fallback
    }
  }
  return Buffer.from(out);
}

function escapePdfString(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return Buffer.from(out);
}

function pageContentStream(lines) {
  const parts = [];
  let y = 720;
  for (const line of lines) {
    const text = escapePdfString(encodeWinAnsi(line));
    parts.push(Buffer.from(`BT /F1 12 Tf 1 0 0 1 72 ${y} Tm (`, 'latin1'));
    parts.push(text);
    parts.push(Buffer.from(') Tj ET\n', 'latin1'));
    y -= 14;
  }
  return Buffer.concat(parts);
}

/**
 * Build a PDF Buffer from pages (each page = array of text lines).
 * @param {string[][]} pages
 * @param {{ compress?: boolean }} options
 */
export function buildPdf(pages, { compress = true } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('buildPdf requires a non-empty array of pages');
  }
  const objects = [];
  // Reserve numbering: 1 Catalog, 2 Pages, then per-page Page + Contents, then Font.
  let nextId = 3;
  const pageIds = [];
  const contentIds = [];
  for (let i = 0; i < pages.length; i += 1) {
    pageIds.push(nextId);
    nextId += 1;
    contentIds.push(nextId);
    nextId += 1;
  }
  const fontId = nextId;
  nextId += 1;

  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
  objects[2] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    'latin1'
  );
  for (let i = 0; i < pages.length; i += 1) {
    objects[pageIds[i]] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`,
      'latin1'
    );
    const raw = pageContentStream(pages[i]);
    const data = compress ? deflateSync(raw) : raw;
    const filter = compress ? ' /Filter /FlateDecode' : '';
    objects[contentIds[i]] = {
      stream: true,
      dict: Buffer.from(`<< /Length ${data.length}${filter} >>`, 'latin1'),
      data,
    };
  }
  objects[fontId] = Buffer.from(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    'latin1'
  );

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  for (let id = 1; id < nextId; id += 1) {
    offsets[id] = chunks.reduce((n, c) => n + c.length, 0);
    chunks.push(Buffer.from(`${id} 0 obj\n`, 'latin1'));
    const obj = objects[id];
    if (obj && obj.stream) {
      chunks.push(obj.dict);
      chunks.push(Buffer.from('\nstream\n', 'latin1'));
      chunks.push(obj.data);
      chunks.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      chunks.push(obj);
      chunks.push(Buffer.from('\nendobj\n', 'latin1'));
    }
  }
  const xrefOffset = chunks.reduce((n, c) => n + c.length, 0);
  let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
