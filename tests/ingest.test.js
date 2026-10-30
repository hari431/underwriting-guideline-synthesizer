import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../src/pdf-write.js';
import { extractPdfText, parseType1BuiltInEncoding } from '../src/pdf-extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'sample-guideline.pdf');

test('ingest: sample fixture yields 3 pages with expected content', async () => {
  const buf = await fs.readFile(fixture);
  const result = extractPdfText(buf);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.pages.map((p) => p.page), [1, 2, 3]);
  assert.match(result.pages[0].text, /Base Rate by Driver Class/);
  assert.match(result.pages[0].text, /base_premium = base_rate \* territory_factor/);
  assert.match(result.pages[1].text, /Territory Factor/);
  assert.match(result.pages[1].text, /T03 Rural \u2013 South/); // en dash round-trip
  assert.match(result.pages[2].text, /final_premium = base_premium \+ policy_fee/);
});

test('ingest: multi-line layout preserved as separate lines', async () => {
  const buf = await fs.readFile(fixture);
  const { pages } = extractPdfText(buf);
  const lines = pages[0].text.split('\n');
  assert.ok(lines.length >= 10, `expected >=10 lines, got ${lines.length}`);
  assert.equal(lines[0], 'UNDERWRITEIQ SYNTHETIC GUIDELINE - ACME PERSONAL AUTO (DEMO DATA)');
});

test('ingest: uncompressed streams also work', () => {
  const buf = buildPdf([['Hello (world) \\ test', 'Second line: 100%']], { compress: false });
  const result = extractPdfText(buf);
  assert.equal(result.pageCount, 1);
  assert.match(result.pages[0].text, /Hello \(world\) \\ test/);
  assert.match(result.pages[0].text, /Second line: 100%/);
});

test('ingest: rejects non-PDF input', () => {
  assert.throws(() => extractPdfText(Buffer.from('not a pdf')), /Not a PDF/);
});

// Minimal one-page PDF with explicitly positioned text runs (no helpers from
// pdf-write, which only emits whole lines at a fixed x). Run texts must avoid
// PDF string escapes; the layout values below are plain synthetic tokens.
function buildPositionedPdf(runs) {
  const streamText = runs
    .map((r) => `BT /F1 12 Tf 1 0 0 1 ${r.x} ${r.y} Tm (${r.text}) Tj ET\n`)
    .join('');
  const streamData = Buffer.from(streamText, 'latin1');
  const objects = [
    null,
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      'latin1'
    ),
    {
      stream: true,
      dict: Buffer.from(`<< /Length ${streamData.length} >>`, 'latin1'),
      data: streamData,
    },
    Buffer.from(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      'latin1'
    ),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = chunks.reduce((n, c) => n + c.length, 0);
    chunks.push(Buffer.from(`${id} 0 obj\n`, 'latin1'));
    const obj = objects[id];
    if (obj.stream) {
      chunks.push(obj.dict, Buffer.from('\nstream\n', 'latin1'), obj.data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      chunks.push(obj, Buffer.from('\nendobj\n', 'latin1'));
    }
  }
  const xrefOffset = chunks.reduce((n, c) => n + c.length, 0);
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.concat([...chunks, Buffer.from(xref, 'latin1')]);
}

test('ingest: wide same-line gutters survive as tabs; word gaps stay spaces', () => {
  const pdf = buildPositionedPdf([
    { x: 72, y: 720, text: 'GridA-Item' },
    { x: 400, y: 720, text: 'GridB-Item' },
    { x: 72, y: 700, text: 'North' },
    { x: 140, y: 700, text: 'South' },
  ]);
  const { pages } = extractPdfText(pdf);
  const lines = pages[0].text.split('\n');
  assert.equal(lines[0], 'GridA-Item\tGridB-Item');
  assert.equal(lines[1], 'North South');
});

// Build a valid multi-page PDF with an incremental update appended (the way
// tools resave an edited PDF): a revised catalog plus a revised page-2
// content stream, with a new xref section chained via /Prev. Objects that
// only appear in the original xref (page tree, page 1 stream, font) must
// still resolve, and revised objects must resolve to their newest revision.
function appendIncrementalUpdate(basePdf, revisedPage2Lines) {
  const marker = Buffer.from('startxref');
  const at = basePdf.lastIndexOf(marker);
  const prev = /startxref\s+(\d+)/.exec(basePdf.subarray(at, at + 64).toString('latin1'))[1];
  const catalog = Buffer.from(
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /D >>] >> >>\nendobj\n',
    'latin1'
  );
  let y = 720;
  let streamText = '';
  for (const line of revisedPage2Lines) {
    streamText += `BT /F1 12 Tf 1 0 0 1 72 ${y} Tm (${line}) Tj ET\n`;
    y -= 14;
  }
  const streamData = Buffer.from(streamText, 'latin1');
  const streamHead = Buffer.from(`6 0 obj\n<< /Length ${streamData.length} >>\nstream\n`, 'latin1');
  const streamTail = Buffer.from('\nendstream\nendobj\n', 'latin1');
  const off1 = basePdf.length;
  const off6 = off1 + catalog.length;
  const xoff = off6 + streamHead.length + streamData.length + streamTail.length;
  const xref =
    `xref\n1 1\n${String(off1).padStart(10, '0')} 00000 n \n` +
    `6 1\n${String(off6).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size 8 /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xoff}\n%%EOF`;
  return Buffer.concat([basePdf, catalog, streamHead, streamData, streamTail, Buffer.from(xref, 'latin1')]);
}

test('ingest: incremental-update PDF resolves the full xref chain with newest revision winning', () => {
  const base = buildPdf(
    [
      ['Incremental sample page one', 'Base rating table goes here'],
      ['Incremental sample page two ORIGINAL'],
    ],
    { compress: true }
  );
  const pdf = appendIncrementalUpdate(base, ['Incremental sample page two REVISED']);
  const result = extractPdfText(pdf);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages.map((p) => p.page), [1, 2]);
  assert.match(result.pages[0].text, /Incremental sample page one/);
  assert.match(result.pages[1].text, /REVISED/);
  assert.doesNotMatch(result.pages[1].text, /ORIGINAL/);
});

// Minimal one-page PDF whose math font has no /Encoding, /Differences, or
// /ToUnicode: decoding must fall back to the embedded Type1 program's own
// /Encoding (per the PDF spec for simple fonts). Codes and glyph names are
// synthetic and abstract.
function buildBuiltInEncodingPdf() {
  const fontProgram = Buffer.from(
    '%!FontType1-1.0: SYNTH TestMath\n' +
      '/FontName /SYNTH+TestMath def\n' +
      '/Encoding 256 array 0 1 255 {1 index exch /.notdef put} readonly def\n' +
      'dup 58 /period put\n' +
      'dup 59 /comma put\n' +
      'dup 2 /multiply put\n' +
      'dup 20 /lessequal put\n' +
      'dup 21 /greaterequal put\n' +
      'readonly def\n',
    'latin1'
  );
  const streamText =
    'BT /F1 12 Tf 1 0 0 1 72 720 Tm <413A3042> Tj ET\n' + // bytes A 0x3A 0 B
    'BT /F1 12 Tf 1 0 0 1 72 700 Tm <021415> Tj ET\n' + // bytes 0x02 0x14 0x15
    'BT /F2 12 Tf 1 0 0 1 72 680 Tm (A1:0B) Tj ET\n'; // WinAnsi control font
  const streamData = Buffer.from(streamText, 'latin1');
  const objects = [
    null,
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R /F2 8 0 R >> >> /Contents 4 0 R >>',
      'latin1'
    ),
    {
      stream: true,
      dict: Buffer.from(`<< /Length ${streamData.length} >>`, 'latin1'),
      data: streamData,
    },
    Buffer.from(
      '<< /Type /Font /Subtype /Type1 /BaseFont /SYNTH+TestMath /FontDescriptor 6 0 R >>',
      'latin1'
    ),
    Buffer.from(
      '<< /Type /FontDescriptor /FontName /SYNTH+TestMath /Flags 4 /FontFile 7 0 R >>',
      'latin1'
    ),
    {
      stream: true,
      dict: Buffer.from(`<< /Length ${fontProgram.length} >>`, 'latin1'),
      data: fontProgram,
    },
    Buffer.from(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      'latin1'
    ),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = chunks.reduce((n, c) => n + c.length, 0);
    chunks.push(Buffer.from(`${id} 0 obj\n`, 'latin1'));
    const obj = objects[id];
    if (obj.stream) {
      chunks.push(obj.dict, Buffer.from('\nstream\n', 'latin1'), obj.data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      chunks.push(obj, Buffer.from('\nendobj\n', 'latin1'));
    }
  }
  const xrefOffset = chunks.reduce((n, c) => n + c.length, 0);
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.concat([...chunks, Buffer.from(xref, 'latin1')]);
}

test('ingest: simple font without Encoding decodes via its embedded Type1 program', () => {
  const { pages } = extractPdfText(buildBuiltInEncodingPdf());
  const lines = pages[0].text.split('\n');
  assert.equal(lines[0], 'A.0B');
  assert.equal(lines[1], '×≤≥');
  assert.equal(lines[2], 'A1:0B');
});

test('ingest: Type1 built-in encoding parser reads cleartext and PFB programs', () => {
  const ascii = Buffer.from(
    '/Encoding 256 array 0 1 255 {1 index exch /.notdef put} readonly def\n' +
      'dup 58 /period put\ndup 2 /multiply put\nreadonly def\n',
    'latin1'
  );
  const clear = parseType1BuiltInEncoding(ascii);
  assert.ok(clear);
  assert.equal(clear[58], 'period');
  assert.equal(clear[2], 'multiply');
  assert.equal(clear[65], null);
  const header = Buffer.from([0x80, 0x01]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(ascii.length, 0);
  const pfb = Buffer.concat([header, len, ascii, Buffer.from([0x80, 0x03])]);
  const wrapped = parseType1BuiltInEncoding(pfb);
  assert.ok(wrapped);
  assert.equal(wrapped[58], 'period');
  assert.equal(parseType1BuiltInEncoding(Buffer.from('no encoding here', 'latin1')), null);
  assert.equal(parseType1BuiltInEncoding(Buffer.from('/Encoding 256 array readonly def\n', 'latin1')), null);
});

test('ingest: synthetic commercial-lines PDF exposes varied lookup phrasings and staged premium wording', () => {
  // Deterministic in-test replacement for a former local-Downloads regression
  // PDF: the same lookup phrasings and staged-premium wording, built with the
  // repo's own PDF writer so the test runs on any checkout.
  const pdf = buildPdf([
    [
      'Find the base rate for occupancy_class in Table A',
      'Retrieve construction_factor from Table B using construction_code',
      'Look up protection_factor using protection_class in Table C',
    ],
    [
      'Select the territory factor for territory from Table D',
      'raw_premium = base_rate * construction_factor',
      'adjusted_premium = raw_premium * protection_factor',
    ],
    [
      'annual_premium = adjusted_premium + policy_fee',
      'If raw_premium is below 350, apply the minimum premium; otherwise use annual_premium.',
    ],
  ]);
  const result = extractPdfText(pdf);
  assert.equal(result.pageCount, 3);
  const combined = result.pages.map((p) => p.text).join('\n');
  for (const phrase of [
    'Find the base rate for occupancy_class in Table A',
    'Retrieve construction_factor from Table B using construction_code',
    'Look up protection_factor using protection_class in Table C',
    'Select the territory factor for territory from Table D',
    'raw_premium',
    'adjusted_premium',
    'annual_premium',
    'If raw_premium is below 350',
    'otherwise',
    'Table A',
    'Table D',
  ]) {
    assert.ok(combined.includes(phrase), `commercial property PDF text missing: ${phrase}`);
  }
});
