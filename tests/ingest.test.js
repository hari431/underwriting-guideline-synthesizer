import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../src/pdf-write.js';
import { extractPdfText } from '../src/pdf-extract.js';

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
      ['Incremental sample page one', 'Base rate table goes here'],
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

test('ingest: commercial property PDF exposes varied lookup phrasings and staged premium wording', async () => {
  const pdfPath = 'C:\\Users\\divya\\Downloads\\underwriteiq_synthetic_commercial_property_guidelines.pdf';
  let buf;
  try {
    buf = await fs.readFile(pdfPath);
  } catch (err) {
    assert.fail(`Commercial property test PDF is inaccessible at ${pdfPath}: ${err?.message ?? err}. Provide the file to run this regression test; not skipping.`);
  }
  const result = extractPdfText(buf);
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
