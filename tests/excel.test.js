import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbookXlsx, crc32 } from '../src/excel.js';
import { createDocument, createJob, normalizeJob } from '../src/models.js';
import { validateJob } from '../src/validate.js';
import { loadRecording } from '../src/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function sampleJob() {
  return normalizeJob(
    createJob({
      document: createDocument({ filename: 'sample-guideline.pdf', pageCount: 3 }),
      tables: [
        { name: 'T1', sourcePages: [1], evidenceText: 'ev-table', headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] },
      ],
      routines: [
        { name: 'R1', kind: 'formula', sourcePages: [2], evidenceText: 'ev-routine', expressionText: 'a = b * 2', dependsOn: ['T1'] },
      ],
    })
  );
}

// Minimal ZIP reader for tests: parse local headers, verify CRCs, inflate.
function readZip(buf) {
  const entries = new Map();
  let pos = 0;
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const compSize = buf.readUInt32LE(pos + 18);
    const rawSize = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(raw.length, rawSize, `size mismatch for ${name}`);
    assert.equal(crc32(raw), crc, `CRC mismatch for ${name}`);
    entries.set(name, raw.toString('utf8'));
    pos = dataStart + compSize;
  }
  assert.ok(buf.subarray(pos).includes('Cover') || entries.has('xl/workbook.xml'), 'expected central directory after entries');
  return entries;
}

test('excel: workbook has 4 sheets with traceability columns', () => {
  const job = sampleJob();
  job.issues = validateJob(job);
  const xlsx = buildWorkbookXlsx(job, { source: 'recorded' });
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
  const zip = readZip(xlsx);
  assert.match(zip.get('xl/workbook.xml'), /name="Cover"/);
  assert.match(zip.get('xl/workbook.xml'), /name="Tables"/);
  assert.match(zip.get('xl/workbook.xml'), /name="Routines"/);
  assert.match(zip.get('xl/workbook.xml'), /name="Issues"/);
  const strings = zip.get('xl/sharedStrings.xml');
  for (const expected of ['Source pages', 'Evidence text', 'ev-table', 'ev-routine', 'a = b * 2', 'recorded']) {
    assert.ok(strings.includes(expected), `shared strings missing: ${expected}`);
  }
  // Sheet 1 (cover) and sheet 2 (tables) reference the shared strings.
  assert.match(zip.get('xl/worksheets/sheet1.xml'), /<sheetData>/);
  assert.match(zip.get('xl/worksheets/sheet2.xml'), /t="s" s="1"/); // header row styled
});

test('excel: every data row carries source pages', async () => {
  const recording = await loadRecording(path.join(here, '..', 'fixtures', 'recorded', 'sample-extract.json'));
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'sample-guideline.pdf', pageCount: 3 }),
      tables: recording.tables,
      routines: recording.routines,
    })
  );
  job.issues = validateJob(job);
  const xlsx = buildWorkbookXlsx(job, { source: 'recorded' });
  const zip = readZip(xlsx);
  const strings = zip.get('xl/sharedStrings.xml');
  // Table names, G1 unfamiliar expression, and the review warning all present.
  for (const expected of ['Table 1 - Base Rate by Driver Class', 'APPLY legacy_matrix_v2 surcharge curve', 'cannot reliably interpret']) {
    assert.ok(strings.includes(expected), `shared strings missing: ${expected}`);
  }
  // G1 routine row and its issue row both reference page 3.
  assert.ok(strings.includes('Routine G1 - Legacy surcharge note'));
});

test('excel: builds are byte-deterministic', () => {
  const a = buildWorkbookXlsx(sampleJob());
  const b = buildWorkbookXlsx(sampleJob());
  assert.ok(a.equals(b), 'expected identical bytes for identical input');
});
