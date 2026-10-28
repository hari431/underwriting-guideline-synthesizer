import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { buildPdf } from '../src/pdf-write.js';
import { createDocument, createJob, normalizeJob } from '../src/models.js';
import { validateJob } from '../src/validate.js';
import { buildWorkbookXlsx, tableSheetNames } from '../src/excel.js';
import { processPdf } from '../src/pipeline.js';
import { expandRecordTables } from '../src/table-split.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Fully synthetic fixtures. Labels are abstract (Band/Tier/Class/Group) so
// the tests exercise generic structure only — no domain titles or values.
const EVIDENCE =
  'SYNTHETIC LOOKUP GRID\nBand 25–55: 1.00 Band 18-24: 1.25 Band 56 to 70: 1.05 Band 71+: 1.20\n' +
  'Values are factors in decimal form.';

function normalizeTables(tables) {
  return normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables })
  ).tables;
}

function bandRangeTable() {
  return {
    name: 'Band Factor',
    sourcePages: [2],
    source_location: 'page 2, lower half',
    evidenceText: EVIDENCE,
    headers: ['Band Factor'],
    rows: [['Band 25–55: 1.00'], ['Band 18-24: 1.25'], ['Band 56 to 70: 1.05'], ['Band 71+: 1.20']],
    notes: 'Synthetic note.',
  };
}

function tierCreditTable() {
  return {
    name: 'Tier Credit',
    sourcePages: [2],
    evidenceText: 'SYNTHETIC TIER GRID\nTier 1: 5% * Tier 2: 10% Tier 3: 15% Tier 4: 45% / 50%\n* Marks the selected tier.',
    headers: ['Tier Credit'],
    rows: [['Tier 1: 5% *'], ['Tier 2: 10%'], ['Tier 3: 15%'], ['Tier 4: 45% / 50%']],
    footnotes: ['Existing synthetic footnote.'],
    notes: 'Synthetic note.',
  };
}

test('table-normalize: range rows expand into minimum/maximum/value columns', () => {
  const { tables, expansions } = expandRecordTables(normalizeTables([bandRangeTable()]));
  assert.equal(tables.length, 1);
  assert.equal(expansions.length, 1);
  const t = tables[0];
  assert.deepEqual(t.headers, ['Minimum Band', 'Maximum Band', 'Band Factor']);
  assert.deepEqual(t.rows, [
    ['25', '55', '1.00'],
    ['18', '24', '1.25'],
    ['56', '70', '1.05'],
    ['71', '', '1.20'],
  ]);
  assert.deepEqual(t.columns.map((c) => [c.label, c.order]), [
    ['Minimum Band', 1],
    ['Maximum Band', 2],
    ['Band Factor', 3],
  ]);
  // Source identity is preserved, not rewritten.
  assert.deepEqual(t.source_pages, [2]);
  assert.equal(t.source_location, 'page 2, lower half');
  assert.equal(t.evidence_text, EVIDENCE);
  assert.equal(t.notes, 'Synthetic note.');
  assert.equal(t.name, 'Band Factor');
  assert.equal(expansions[0].kind, 'range');
});

test('table-normalize: label/value rows expand with markers detached and alternatives verbatim', () => {
  const { tables, expansions } = expandRecordTables(normalizeTables([tierCreditTable()]));
  assert.equal(expansions.length, 1);
  const t = tables[0];
  assert.deepEqual(t.headers, ['Tier', 'Tier Credit']);
  assert.deepEqual(t.rows, [
    ['1', '5%'],
    ['2', '10%'],
    ['3', '15%'],
    ['4', '45% / 50%'],
  ]);
  assert.deepEqual(t.columns.map((c) => c.label), ['Tier', 'Tier Credit']);
  // Existing footnotes stay first; the detached marker is appended with provenance.
  assert.equal(t.footnotes[0], 'Existing synthetic footnote.');
  assert.equal(t.footnotes.length, 2);
  assert.match(t.footnotes[1], /\*.*detached from 1 cell/);
  assert.equal(expansions[0].kind, 'key-value');
  assert.deepEqual(expansions[0].markers, ['*']);
  assert.deepEqual(expansions[0].alternatives, ['45% / 50%']);
});

test('table-normalize: mixed range and point keys keep a verbatim key column', () => {
  const table = {
    name: 'Group Rate', sourcePages: [1], evidenceText: 'ev',
    headers: ['Group Rate'],
    rows: [['Group 25–55: 1.00'], ['Group 65: 1.10'], ['Group 71+: 1.20']],
  };
  const { tables, expansions } = expandRecordTables(normalizeTables([table]));
  assert.equal(expansions.length, 1);
  assert.deepEqual(tables[0].headers, ['Group', 'Group Rate']);
  assert.deepEqual(tables[0].rows, [['25–55', '1.00'], ['65', '1.10'], ['71+', '1.20']]);
  assert.equal(expansions[0].kind, 'key-value');
});

test('table-normalize: ambiguous single-column text is preserved, not guessed', () => {
  const tables = normalizeTables([
    {
      name: 'Times', sourcePages: [1], evidenceText: 'ev',
      headers: ['Slot'], rows: [['Slot 10:30'], ['Slot 11:00'], ['Slot 12:15']],
    },
    {
      name: 'Constant', sourcePages: [1], evidenceText: 'ev',
      headers: ['Note'], rows: [['Ref: 7'], ['Ref: 7'], ['Ref: 7']],
    },
    {
      name: 'Prose', sourcePages: [1], evidenceText: 'ev',
      headers: ['Memo'], rows: [['See page one'], ['Refer to annex'], ['Ask the desk']],
    },
    {
      name: 'Narrow', sourcePages: [1], evidenceText: 'ev',
      headers: ['Pair'], rows: [['Class A: 1.00'], ['Class B: 1.25']],
    },
    {
      name: 'Wide', sourcePages: [1], evidenceText: 'ev',
      headers: ['Item', 'Detail'],
      rows: [['Item 1', 'Class A: 1.00'], ['Item 2', 'Class B: 1.25'], ['Item 3', 'Class C: 1.05']],
    },
  ]);
  const { tables: out, expansions } = expandRecordTables(tables);
  assert.equal(expansions.length, 0);
  assert.deepEqual(out.map((t) => t.headers), [['Slot'], ['Note'], ['Memo'], ['Pair'], ['Item', 'Detail']]);
  assert.deepEqual(out[0].rows, [['Slot 10:30'], ['Slot 11:00'], ['Slot 12:15']]);
  assert.deepEqual(out[4].rows[0], ['Item 1', 'Class A: 1.00']);
});

test('table-normalize: pipeline expands recorded single-column grids with a review notice', async () => {
  const dir = await fs.mkdtemp(path.join(here, '..', 'tmp', 'ratecraft-normalize-'));
  try {
    const recordingPath = path.join(dir, 'recording.json');
    await fs.writeFile(recordingPath, JSON.stringify({ tables: [bandRangeTable(), tierCreditTable()], routines: [] }));
    const pdf = buildPdf([['PAGE 1'], ['PAGE 2']]);
    const { job, source } = await processPdf(pdf, { filename: 'scratch.pdf', recordingPath });
    assert.equal(source, 'recorded');
    assert.equal(job.tables.length, 2);
    assert.deepEqual(job.tables.map((t) => t.headers), [
      ['Minimum Band', 'Maximum Band', 'Band Factor'],
      ['Tier', 'Tier Credit'],
    ]);
    assert.deepEqual(job.tables[0].rows[3], ['71', '', '1.20']);
    assert.deepEqual(job.tables[1].rows[0], ['1', '5%']);
    assert.ok(job.tables.every((t) => t.id && t.source_pages.length > 0 && t.evidence_text));
    assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
    const notices = job.issues.filter((i) => /normalized into (range|key-value) columns/.test(i.message));
    assert.equal(notices.length, 2);
    assert.ok(notices.every((i) => i.severity === 'warning'));
    assert.ok(notices.some((i) => /Footnote marker.*"\*"/.test(i.message)));
    assert.ok(notices.some((i) => /alternatives.*45% \/ 50%/.test(i.message)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('table-normalize: validator flags unexpanded single-column record text for review', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 3 }),
      tables: [
        {
          name: 'Times', sourcePages: [1], evidenceText: 'ev',
          headers: ['Slot'], rows: [['Slot 10:30'], ['Slot 11:00'], ['Slot 12:15']],
        },
      ],
    })
  );
  const flagged = validateJob(job).filter((i) => /could not be confidently split/.test(i.message));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'warning');
  assert.deepEqual(flagged[0].source_pages, [1]);

  // Expanded tables no longer carry record-column text, so they stay quiet.
  const { tables } = expandRecordTables(normalizeTables([bandRangeTable()]));
  const quiet = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables })
  );
  assert.deepEqual(validateJob(quiet).filter((i) => /confidently split|merged into one/.test(i.message)), []);
});

test('table-normalize: expanded tables export to separate columns, byte-deterministically', () => {
  const { tables } = expandRecordTables(normalizeTables([bandRangeTable(), tierCreditTable()]));
  const job = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables })
  );
  job.issues = validateJob(job);
  const a = buildWorkbookXlsx(job, { source: 'recorded' });
  const b = buildWorkbookXlsx(job, { source: 'recorded' });
  assert.ok(a.equals(b), 'expected identical bytes for identical input');
  const files = readZip(a);
  const strings = files.get('xl/sharedStrings.xml');
  for (const cell of ['Minimum Band', 'Maximum Band', 'Band Factor', '25', '55', '1.00', '71', '1.20', 'Tier', '5%']) {
    assert.ok(strings.includes(`<t xml:space="preserve">${cell}</t>`), `missing separate cell value: ${cell}`);
  }
  assert.ok(!strings.includes('Band 25–55: 1.00</t>'), 'range rows must not stay packed in one cell');
  const workbook = files.get('xl/workbook.xml');
  const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  const sheets = tableSheetNames(job.tables);
  const sheetXml = files.get(`xl/worksheets/sheet${names.indexOf(sheets[0]) + 1}.xml`);
  const rows = [...sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)].map((m) => m[2]);
  assert.equal(rows.length, 6); // title + headers + 4 data rows
  assert.equal((rows[1].match(/<c /g) || []).length, 3);
  assert.equal((rows[2].match(/<c /g) || []).length, 3);
});

// Minimal ZIP reader for tests: parse local headers, inflate entries.
function readZip(buf) {
  const files = new Map();
  let pos = 0;
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buf.readUInt16LE(pos + 8);
    const compLen = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const start = pos + 30 + nameLen + extraLen;
    const payload = buf.subarray(start, start + compLen);
    files.set(name, (method === 8 ? inflateRawSync(payload) : Buffer.from(payload)).toString('utf8'));
    pos = start + compLen;
  }
  return files;
}
