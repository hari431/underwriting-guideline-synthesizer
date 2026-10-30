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
import { splitMergedTables } from '../src/table-split.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Fully synthetic fixtures. Labels are abstract (Item/Rate/Class/Tier) so the
// tests exercise generic structure only — no domain titles or column names.
const EVIDENCE =
  'SYNTHETIC MASTER GRID\nItem Rate P Rate Q Alpha Factor Beta Credit\n' +
  'Item 1 10 20 Class A: 1.00 Tier 1: 5%\nItem 2 11 21 Class B: 1.25 Tier 2: 10%\n' +
  'Item 3 12 22 Class C: 1.05 Tier 3: 15%\nItem 4 13 23 Class D: 1.20 Tier 4: 20%';

function mergedSideBySide() {
  return {
    name: 'Synthetic master grid',
    sourcePages: [2],
    source_location: 'page 2, upper half',
    evidenceText: EVIDENCE,
    headers: ['Item', 'Rate P', 'Rate Q', 'Alpha Factor', 'Beta Credit'],
    rows: [
      ['Item 1', '10', '20', 'Class A: 1.00', 'Tier 1: 5%'],
      ['Item 2', '11', '21', 'Class B: 1.25', 'Tier 2: 10%'],
      ['Item 3', '12', '22', 'Class C: 1.05', 'Tier 3: 15%'],
      ['Item 4', '13', '23', 'Class D: 1.20', 'Tier 4: 20%'],
    ],
    footnotes: ['Synthetic footnote carried on every part.'],
    notes: 'Synthetic note.',
  };
}

function normalizeTables(tables) {
  return normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables })
  ).tables;
}

test('table-split: three side-by-side grids separate into three tables', () => {
  const { tables, splits } = splitMergedTables(normalizeTables([mergedSideBySide()]));
  assert.equal(tables.length, 3);
  assert.equal(splits.length, 1);
  assert.deepEqual(tables.map((t) => t.headers), [
    ['Item', 'Rate P', 'Rate Q'],
    ['Alpha Factor'],
    ['Beta Credit'],
  ]);
  assert.deepEqual(tables[0].rows, [
    ['Item 1', '10', '20'],
    ['Item 2', '11', '21'],
    ['Item 3', '12', '22'],
    ['Item 4', '13', '23'],
  ]);
  assert.deepEqual(tables[1].rows, [['Class A: 1.00'], ['Class B: 1.25'], ['Class C: 1.05'], ['Class D: 1.20']]);
  assert.deepEqual(tables[2].rows, [['Tier 1: 5%'], ['Tier 2: 10%'], ['Tier 3: 15%'], ['Tier 4: 20%']]);
  // Every value is preserved verbatim: no invention, no drops.
  const flat = (rows) => rows.map((r) => r.join('|')).join('\n');
  assert.equal(
    tables.map((t) => flat(t.rows)).join('\n---\n'),
    'Item 1|10|20\nItem 2|11|21\nItem 3|12|22\nItem 4|13|23\n---\n' +
      'Class A: 1.00\nClass B: 1.25\nClass C: 1.05\nClass D: 1.20\n---\n' +
      'Tier 1: 5%\nTier 2: 10%\nTier 3: 15%\nTier 4: 20%'
  );
});

test('table-split: split parts keep own names, structure, pages, and evidence', () => {
  const { tables } = splitMergedTables(normalizeTables([mergedSideBySide()]));
  assert.deepEqual(tables.map((t) => t.name), [
    'Synthetic master grid (grid 1 of 3)',
    'Synthetic master grid (grid 2 of 3)',
    'Synthetic master grid (grid 3 of 3)',
  ]);
  for (const part of tables) {
    assert.deepEqual(part.source_pages, [2]);
    assert.equal(part.source_location, 'page 2, upper half');
    assert.equal(part.evidence_text, EVIDENCE);
    assert.deepEqual(part.footnotes, ['Synthetic footnote carried on every part.']);
    assert.equal(part.notes, 'Synthetic note.');
    assert.ok(part.rows.length === 4 && part.rows.every((r) => r.length === part.headers.length));
    assert.deepEqual(part.columns.map((c) => c.order), part.headers.map((_, i) => i + 1));
  }
  assert.deepEqual(tables[0].columns.map((c) => c.label), ['Item', 'Rate P', 'Rate Q']);
  assert.deepEqual(tables[1].columns.map((c) => c.label), ['Alpha Factor']);
});

test('table-split: legitimate wide tables stay intact', () => {
  const wide = {
    name: 'Synthetic calculation breakdown',
    sourcePages: [1],
    evidenceText: 'ev',
    headers: ['Code', 'Component', 'Basis', 'Factor', 'Amount'],
    rows: [
      ['C-01', 'Base component', 'Per unit', '1.00', '100'],
      ['C-02', 'Surcharge: see note', 'Per unit', '1.10', '110'],
      ['C-03', 'Total', 'Sum', '', '999'],
    ],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([wide]));
  assert.equal(splits.length, 0);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, wide.headers);
  assert.deepEqual(tables[0].rows, [['C-01', 'Base component', 'Per unit', '1.00', '100'], ['C-02', 'Surcharge: see note', 'Per unit', '1.10', '110'], ['C-03', 'Total', 'Sum', null, '999']]);
  assert.equal(tables[0].name, wide.name);
});

test('table-split: stacked and multi-page tables pass through unsplit', () => {
  const stackedUpper = {
    name: 'Upper grid', sourcePages: [1], evidenceText: 'ev',
    headers: ['Key', 'Value'], rows: [['a', '1'], ['b', '2']],
  };
  const stackedLower = {
    name: 'Lower grid', sourcePages: [1], evidenceText: 'ev',
    headers: ['Name', 'Score'], rows: [['x', '9'], ['y', '8']],
  };
  // One logical table spanning pages arrives with its header row repeated at
  // the page break: indistinguishable from stacked grids, so it must be
  // preserved (the validator flags it for review instead of guessing).
  const spanning = {
    name: 'Spanning grid', sourcePages: [1, 2], evidenceText: 'ev',
    headers: ['Key', 'Value'],
    rows: [['a', '1'], ['b', '2'], ['Key', 'Value'], ['c', '3']],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([stackedUpper, stackedLower, spanning]));
  assert.equal(splits.length, 0);
  assert.equal(tables.length, 3);
  assert.deepEqual(tables.map((t) => t.name), ['Upper grid', 'Lower grid', 'Spanning grid']);
  assert.deepEqual(tables[2].rows, [['a', '1'], ['b', '2'], ['Key', 'Value'], ['c', '3']]);
});

test('table-split: ambiguous composite columns are preserved and flagged, not guessed', () => {
  const ambiguous = {
    name: 'Ambiguous composite grid',
    sourcePages: [1],
    evidenceText: 'ev',
    headers: ['Item', 'Rate', 'Mixed notes'],
    rows: [
      ['Item 1', '10', 'Low: 0.90'],
      ['Item 2', '11', 'Medium: 1.00'],
      ['Item 3', '12', 'High: 1.20'],
      ['Item 4', '13', 'Urgent: 1.50'],
    ],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([ambiguous]));
  assert.equal(splits.length, 0);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['Item', 'Rate', 'Mixed notes']);
  const job = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables: [ambiguous] })
  );
  const issues = validateJob(job);
  const flagged = issues.filter((i) => i.target_id === 'T1' && /adjacent.*grids|merged into one/.test(i.message));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'warning');
  assert.deepEqual(flagged[0].source_pages, [1]);
});

test('table-split: a descriptive key column stays with its grid', () => {
  // Same shape as merged side-by-side grids whose left grid carries an
  // annotated key column ("label: description" pairs are row labels, not a
  // lookup): only the numeric-valued grids separate.
  const table = {
    name: 'Keyed master grid',
    sourcePages: [2],
    evidenceText: 'ev',
    headers: ['Band', 'Rate P', 'Rate Q', 'Alpha Factor', 'Beta Credit'],
    rows: [
      ['Band 1: 0 to 1 yrs (current)', '10', '20', 'Class A: 1.00', 'Tier 1: 5%'],
      ['Band 2: 2 to 4 yrs', '11', '21', 'Class B: 1.25', 'Tier 2: 10%'],
      ['Band 3: 5 to 7 yrs', '12', '22', 'Class C: 1.05', 'Tier 3: 15%'],
      ['Band 4: 8+ yrs (review)', '13', '23', 'Class D: 1.20', 'Tier 4: 45% / 50%'],
    ],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([table]));
  assert.equal(splits.length, 1);
  assert.equal(tables.length, 3);
  assert.deepEqual(tables.map((t) => t.headers), [
    ['Band', 'Rate P', 'Rate Q'],
    ['Alpha Factor'],
    ['Beta Credit'],
  ]);
  assert.equal(tables[0].rows[0][0], 'Band 1: 0 to 1 yrs (current)');
});

test('table-split: constant and middle record columns are preserved, not guessed', () => {
  const constant = {
    name: 'Constant note', sourcePages: [1], evidenceText: 'ev',
    headers: ['Item', 'Rate', 'Note'],
    rows: [
      ['Item 1', '10', 'Ref: 7'],
      ['Item 2', '11', 'Ref: 7'],
      ['Item 3', '12', 'Ref: 7'],
    ],
  };
  const middle = {
    name: 'Middle grid', sourcePages: [1], evidenceText: 'ev',
    headers: ['Item', 'Alpha Factor', 'Rate'],
    rows: [
      ['Item 1', 'Class A: 1.00', '10'],
      ['Item 2', 'Class B: 1.25', '11'],
      ['Item 3', 'Class C: 1.05', '12'],
      ['Item 4', 'Class D: 1.20', '13'],
    ],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([constant, middle]));
  assert.equal(splits.length, 0);
  assert.equal(tables.length, 2);
  // The middle grid is genuinely ambiguous, so review is asked instead.
  const job = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables: [middle] })
  );
  const flagged = validateJob(job).filter((i) => /merged into one/.test(i.message));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'warning');
});

test('table-split: narrow and short tables never split', () => {
  const narrow = {
    name: 'Narrow', sourcePages: [1], evidenceText: 'ev',
    headers: ['Group', 'Detail'],
    rows: [['g1', 'Class A: 1.00'], ['g2', 'Class B: 1.25'], ['g3', 'Class C: 1.05']],
  };
  const short = {
    name: 'Short', sourcePages: [1], evidenceText: 'ev',
    headers: ['A', 'B', 'C'],
    rows: [['a', 'b', 'Class A: 1.00'], ['d', 'e', 'Class B: 1.25']],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([narrow, short]));
  assert.equal(splits.length, 0);
  assert.equal(tables.length, 2);
});

test('table-split: fully blank interior columns separate deterministically', () => {
  const table = {
    name: 'Gapped grid', sourcePages: [1], evidenceText: 'ev',
    headers: ['Key', 'Value', '', 'Name', 'Score'],
    rows: [['a', '1', '', 'x', '9'], ['b', '2', '', 'y', '8'], ['c', '3', '', 'z', '7']],
  };
  const { tables, splits } = splitMergedTables(normalizeTables([table]));
  assert.equal(splits.length, 1);
  assert.deepEqual(tables.map((t) => t.headers), [['Key', 'Value'], ['Name', 'Score']]);
});

test('table-split: split ids are deterministic', () => {
  const clean = {
    name: 'Clean', sourcePages: [1], evidenceText: 'ev',
    headers: ['Key', 'Value'], rows: [['a', '1']],
  };
  const run = () => {
    const { tables } = splitMergedTables(normalizeTables([mergedSideBySide(), clean]));
    return normalizeJob(
      createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables })
    ).tables.map((t) => t.id);
  };
  assert.deepEqual(run(), ['T1', 'T3', 'T4', 'T2']);
  assert.deepEqual(run(), run());
});

test('table-split: pipeline separates recorded side-by-side grids with a review issue', async () => {
  const recording = path.join(here, '..', 'fixtures', 'recorded', 'side-by-side-extract.json');
  const pdf = buildPdf([['SYNTHETIC SIDE-BY-SIDE FIXTURE PAGE 1'], ['SYNTHETIC SIDE-BY-SIDE FIXTURE PAGE 2']]);
  const { job, source } = await processPdf(pdf, { filename: 'synthetic.pdf', recordingPath: recording });
  assert.equal(source, 'recorded');
  assert.equal(job.tables.length, 3);
  assert.deepEqual(job.tables.map((t) => t.headers), [
    ['Item', 'Rate P', 'Rate Q'],
    ['Class', 'Alpha Factor'],
    ['Tier', 'Beta Credit'],
  ]);
  assert.ok(job.tables.every((t) => t.id && t.source_pages.length > 0 && t.evidence_text));
  const errors = job.issues.filter((i) => i.severity === 'error');
  assert.equal(errors.length, 0);
  const splitNote = job.issues.filter((i) => /separated into 3 independent grids/.test(i.message));
  assert.equal(splitNote.length, 1);
  assert.equal(splitNote[0].severity, 'warning');
});

test('table-split: each logical table exports to its own sheet, byte-deterministically', () => {
  const { tables } = splitMergedTables(normalizeTables([mergedSideBySide()]));
  const job = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), tables })
  );
  job.issues = validateJob(job);
  const names = tableSheetNames(job.tables);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  const a = buildWorkbookXlsx(job, { source: 'recorded' });
  const b = buildWorkbookXlsx(job, { source: 'recorded' });
  assert.ok(a.equals(b), 'expected identical bytes for identical input');
  const files = readZip(a);
  const workbook = files.get('xl/workbook.xml');
  for (const name of names) {
    assert.ok(workbook.includes(`name="${name}"`), `missing sheet: ${name}`);
  }
  const strings = files.get('xl/sharedStrings.xml');
  for (const header of ['Item', 'Rate P', 'Rate Q', 'Alpha Factor', 'Beta Credit', 'Class A: 1.00', 'Tier 4: 20%']) {
    assert.ok(strings.includes(`<t xml:space="preserve">${header}</t>`), `missing cell value: ${header}`);
  }
});

test('table-split: scratch recording in temp dir also separates (no fixture coupling)', async () => {
  const tmpParent = path.join(here, '..', 'tmp');
  await fs.mkdir(tmpParent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpParent, 'ratecraft-split-'));
  try {
    const recordingPath = path.join(dir, 'recording.json');
    await fs.writeFile(recordingPath, JSON.stringify({ tables: [mergedSideBySide()], routines: [] }));
    const pdf = buildPdf([['PAGE 1'], ['PAGE 2']]);
    const { job } = await processPdf(pdf, { filename: 'scratch.pdf', recordingPath });
    assert.equal(job.tables.length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
