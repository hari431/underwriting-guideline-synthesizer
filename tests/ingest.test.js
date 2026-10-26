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
