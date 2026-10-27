import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbookXlsx, crc32, routineSheetNames, tableSheetNames } from '../src/excel.js';
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

function sheetNamesInOrder(workbookXml) {
  return [...workbookXml.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
}

function sheetXmlByName(zip, workbookXml, name) {
  const names = sheetNamesInOrder(workbookXml);
  const idx = names.indexOf(name);
  assert.ok(idx >= 0, `workbook missing sheet: ${name}`);
  return zip.get(`xl/worksheets/sheet${idx + 1}.xml`);
}

const FIXED_SHEETS = ['Cover', 'Table Summary', 'Table Columns', 'Routine Summary', 'Issues'];

function unescapeXml(s) {
  return String(s ?? '').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function sharedStringItems(stringsXml) {
  return [...stringsXml.matchAll(/<si><t xml:space="preserve">(.*?)<\/t><\/si>/gs)].map((m) => unescapeXml(m[1]));
}

// Decode a worksheet to rows of cell values via the shared string table.
function sheetRowsAsValues(sheetXml, stringsXml) {
  const items = sharedStringItems(stringsXml);
  const rows = [];
  for (const m of sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
    const cells = [...m[2].matchAll(/<c r="[A-Z]+\d+" t="s"(?: s="\d+")?><v>(\d+)<\/v><\/c>/g)]
      .map((c) => items[Number(c[1])] ?? '');
    rows.push(cells);
  }
  return rows;
}

function sectionRows(values, label) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
  if (idx < 0) return null;
  const header = values[idx + 1] ?? [];
  const body = [];
  for (let i = idx + 2; i < values.length; i += 1) {
    if (values[i].length === 1) break; // next section label
    body.push(values[i]);
  }
  return { header, body };
}

function hyperlinksIn(sheetXml) {
  return [...sheetXml.matchAll(/<hyperlink ref="([A-Z]+\d+)" location="([^"]+)"/g)]
    .map((m) => ({ ref: m[1], location: unescapeXml(m[2]) }));
}

function cellRef(r, c) {
  let name = '';
  let i = c;
  do {
    name = String.fromCharCode(65 + (i % 26)) + name;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return `${name}${r + 1}`;
}

function expectedLocation(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'!A1`;
}

// Style index per cell in one worksheet row (null when unstyled), or null
// when the row is absent. Rows are 1-based as in the sheet XML.
function rowCellStyles(sheetXml, rowNum) {
  const m = sheetXml.match(new RegExp(`<row r="${rowNum}">(.*?)</row>`, 's'));
  if (!m) return null;
  return [...m[1].matchAll(/<c r="[A-Z]+\d+" t="s"(?: s="(\d+)")?><v>\d+<\/v><\/c>/g)]
    .map((c) => c[1] ?? null);
}

// Rows under a header-less labelled block (e.g. Source evidence).
function blockRows(values, label) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
  if (idx < 0) return null;
  const body = [];
  for (let i = idx + 1; i < values.length; i += 1) {
    if (values[i].length === 1) break; // next section label
    body.push(values[i]);
  }
  return body;
}

test('excel: workbook has structured sheets with traceability columns', () => {
  const job = sampleJob();
  job.issues = validateJob(job);
  const xlsx = buildWorkbookXlsx(job, { source: 'recorded' });
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
  const zip = readZip(xlsx);
  const workbook = zip.get('xl/workbook.xml');
  for (const name of FIXED_SHEETS) {
    assert.ok(workbook.includes(`name="${name}"`), `workbook missing sheet: ${name}`);
  }
  for (const name of ['Table Data', 'Routine Steps', 'Dependencies', 'Conditions']) {
    assert.ok(!workbook.includes(`name="${name}"`), `shared sheet must be replaced by per-asset sheets: ${name}`);
  }
  assert.ok(workbook.includes('name="T1"'), 'expected a worksheet for table T1');
  assert.ok(workbook.includes('name="R1"'), 'expected a worksheet for routine R1');
  const strings = zip.get('xl/sharedStrings.xml');
  for (const expected of ['Source pages', 'Evidence text', 'ev-table', 'ev-routine', 'a = b * 2', 'recorded']) {
    assert.ok(strings.includes(expected), `shared strings missing: ${expected}`);
  }
  assert.match(zip.get('xl/worksheets/sheet1.xml'), /<sheetData>/);
  assert.match(zip.get('xl/worksheets/sheet2.xml'), /t="s" s="1"/); // header row styled
});

test('excel: sample tables and routines export to separate sheets', async () => {
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
  const workbook = zip.get('xl/workbook.xml');
  const names = sheetNamesInOrder(workbook);
  const expectedTableSheets = tableSheetNames(job.tables);
  const expectedRoutineSheets = routineSheetNames(job.routines, expectedTableSheets);
  assert.equal(expectedTableSheets.length, 2);
  assert.equal(expectedRoutineSheets.length, 4);
  for (const sheetName of [...expectedTableSheets, ...expectedRoutineSheets]) {
    assert.ok(names.includes(sheetName), `workbook missing sheet: ${sheetName}`);
    assert.ok(sheetName.length <= 31, `sheet name too long: ${sheetName}`);
    assert.ok(!/[:\\/?*[\]]/.test(sheetName), `sheet name has forbidden chars: ${sheetName}`);
  }
  assert.equal(names.filter((n) => !FIXED_SHEETS.includes(n)).length, 6);
  // Routine Summary stays an index of every routine.
  const summary = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Routine Summary'), strings);
  assert.deepEqual(summary[0].slice(0, 4), ['Routine ID', 'Name', 'Kind', 'Purpose']);
  assert.equal(summary.length, 5); // header + 4 routines
});

test('excel: sample routine sheets populate fields supported by the source', async () => {
  const recording = await loadRecording(path.join(here, '..', 'fixtures', 'recorded', 'sample-extract.json'));
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'sample-guideline.pdf', pageCount: 3 }),
      tables: recording.tables,
      routines: recording.routines,
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const routineSheets = routineSheetNames(job.routines, tableSheetNames(job.tables));
  const byIndex = (i) => sheetRowsAsValues(sheetXmlByName(zip, workbook, routineSheets[i]), strings);

  // B1: the stated formula expands to one row per operation with explicit
  // brackets; no separate Inputs, Final calculation, or Dependencies sections.
  const b1 = byIndex(0);
  assert.deepEqual(b1[0], ['B1 - Base premium formula']);
  assert.ok(!b1.some((row) => row.length === 2 && (row[0] === 'Inputs' || row[0] === 'Outputs' || row[0] === 'Expression')));
  assert.equal(sectionRows(b1, 'Inputs'), null);
  assert.equal(sectionRows(b1, 'Dependencies'), null);
  assert.equal(sectionRows(b1, 'Final calculation'), null);
  assert.deepEqual(sectionRows(b1, 'Steps').header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(sectionRows(b1, 'Steps').body, [
    ['1', 'base_premium', '<--', '', 'base_rate', '', 'Start base_premium from base_rate (source step 1)'],
    ['2', '', '*', '', 'territory_factor', '', 'Apply * territory_factor to continue base_premium from prior step (source step 1)'],
  ]);

  // T1: true/false branches and referral code populated from explicit text.
  const t1 = byIndex(1);
  const t1conds = sectionRows(t1, 'Conditions');
  assert.equal(t1conds.body.length, 2);
  assert.equal(t1conds.body[0][1], 'IF territory IN (T01, T02, T03) THEN apply Table 2 factor');
  assert.equal(t1conds.body[0][2], 'apply Table 2 factor');
  assert.equal(t1conds.body[1][1], 'ELSE refer to underwriter (code REF-TERR)');
  assert.equal(t1conds.body[1][3], 'refer to underwriter (code REF-TERR)');
  assert.equal(t1conds.body[1][4], 'REF-TERR');
  assert.equal(sectionRows(t1, 'Final calculation'), null); // no formula or steps: nothing to close the flow

  // F1: stepwise rating steps — lookups assign table values to variables,
  // arithmetic expands to one row per operation, rounding assigns its output
  // with the source wording, and the cross-routine input stays traced. No
  // separate inventories.
  const f1 = byIndex(2);
  const f1steps = sectionRows(f1, 'Steps');
  assert.deepEqual(f1steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(f1steps.body.map((row) => row[0]), ['1', '2', '3', '4', '5']);
  assert.deepEqual(f1steps.body.map((row) => row[2]), ['<--', '<--', '<--', '+', 'R']);
  assert.deepEqual(f1steps.body[0], ['1', 'base_rate', '<--', '', 'table:Table 1 - Base Rate by Driver Class (driver class)', '', 'Lookup base_rate from Table 1 - Base Rate by Driver Class']);
  assert.deepEqual(f1steps.body[1], ['2', 'territory_factor', '<--', '', 'table:Table 2 - Territory Factor (territory)', '', 'Lookup territory_factor from Table 2 - Territory Factor']);
  assert.deepEqual(f1steps.body[2], ['3', 'final_premium', '<--', '', 'base_premium', '', 'uses base_premium from B1 - Base premium formula']);
  assert.deepEqual(f1steps.body[3], ['4', '', '+', '', 'policy_fee', '', 'Apply + policy_fee to continue final_premium from prior step (source step 3)']);
  assert.deepEqual(f1steps.body[4], ['5', 'final_premium', 'R', '', 'to the nearest dollar', '', 'Round final_premium (source step 4)']);
  assert.ok(f1steps.body.every((row) => row.length === 7 && row[6] !== ''));
  assert.equal(sectionRows(f1, 'Inputs'), null);
  assert.equal(sectionRows(f1, 'Dependencies'), null);
  assert.equal(sectionRows(f1, 'Final calculation'), null);

  // G1: unfamiliar wording kept verbatim with nothing invented, flagged instead.
  const g1 = byIndex(3);
  assert.deepEqual(sectionRows(g1, 'Steps').body, [['1', 'APPLY legacy_matrix_v2 surcharge curve', '', '', '', '', 'Source instruction (source step 1)']]);
  assert.equal(sectionRows(g1, 'Final calculation'), null);
  const g1issues = sectionRows(g1, 'Unresolved items');
  assert.ok(g1issues !== null && g1issues.body.length >= 1);
  assert.ok(g1issues.body.some((row) => row[2].includes('cannot reliably interpret')));

  // Every routine sheet keeps its own evidence and page references.
  for (const values of [b1, t1, f1, g1]) {
    const evidence = blockRows(values, 'Source evidence');
    assert.ok(evidence !== null);
    assert.ok(evidence.some((row) => row[0] === 'Source pages' && row[1] !== ''));
    assert.ok(evidence.some((row) => row[0] === 'Evidence' && row[1] !== ''));
  }
  const f1evidence = blockRows(f1, 'Source evidence');
  assert.ok(f1evidence.some((row) => row[0] === 'Source pages' && row[1] === '3'));

  // Routine Summary reflects the same populated inputs/outputs.
  const summary = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Routine Summary'), strings);
  const header = summary[0];
  const b1row = summary.find((row) => row[1] === 'B1 - Base premium formula');
  assert.equal(b1row[header.indexOf('Inputs')], 'base_rate; territory_factor');
  assert.equal(b1row[header.indexOf('Outputs')], 'base_premium');
});

test('excel: builds are byte-deterministic', () => {
  const a = buildWorkbookXlsx(sampleJob());
  const b = buildWorkbookXlsx(sampleJob());
  assert.ok(a.equals(b), 'expected identical bytes for identical input');
});

function countRows(sheetXml) {
  return (sheetXml.match(/<row r="/g) || []).length;
}

test('excel: each table gets a clean sheet with title, headers, and rows only', () => {
  const job = sampleJob();
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  for (const cell of ['A', 'B', '1', '2', '3', '4']) {
    assert.ok(strings.includes(`<t xml:space="preserve">${cell}</t>`), `missing separate cell value: ${cell}`);
  }
  assert.ok(!strings.includes('A | B'), 'headers must not be pipe-joined');
  assert.ok(!strings.includes('1 | 2'), 'row values must not be pipe-joined');
  assert.ok(!strings.includes('3 | 4'), 'row values must not be pipe-joined');
  const tableSheet = sheetXmlByName(zip, workbook, 'T1');
  assert.equal(countRows(tableSheet), 4); // title + headers + 2 data rows
  const tableColumns = sheetXmlByName(zip, workbook, 'Table Columns');
  assert.equal(countRows(tableColumns), 3); // header + 2 column definitions
  assert.ok(strings.includes('Original label'));
  // Factor sheet holds the title once at the top plus real columns/values.
  const rows = [...tableSheet.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)].map((m) => m[2]);
  assert.equal(rows.length, 4);
  assert.equal((rows[0].match(/<c /g) || []).length, 1); // title row: single cell
  assert.equal((rows[1].match(/<c /g) || []).length, 2); // header row: 2 real columns
  assert.equal((rows[2].match(/<c /g) || []).length, 2);
  assert.equal((rows[3].match(/<c /g) || []).length, 2);
});

test('excel: rating routine sheet keeps steps and conditions as separate rows', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 3 }),
      tables: [{ name: 'Base', sourcePages: [1], evidenceText: 'ev', headers: ['K', 'V'], rows: [['a', '1']] }],
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'ev',
        expressionText: '', conditions: ['IF x THEN y', 'ELSE refer'], steps: ['Step 1: first', 'Step 3: third'],
        dependsOn: ['Base', 'Elsewhere'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  assert.ok(!strings.includes('Step 1: first | Step 3: third'), 'steps must not be pipe-joined');
  assert.ok(!strings.includes('IF x THEN y | ELSE refer'), 'conditions must not be pipe-joined');
  assert.ok(!strings.includes('Base | Elsewhere'), 'dependencies must not be pipe-joined');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Calc'), strings);
  assert.deepEqual(values[0], ['Calc']); // routine name in A1
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body, [
    ['1', 'Step 1: first', '', '', '', '', 'Source instruction (source step 1)'],
    ['3', 'Step 3: third', '', '', '', '', 'Source instruction (source step 3)'], // gaps preserved without expansion
  ]);
  assert.ok(steps.body.every((row) => row.length === 7));
  const conditions = sectionRows(values, 'Conditions');
  assert.equal(conditions.body.length, 2);
  assert.equal(conditions.body[0][1], 'IF x THEN y');
  assert.equal(conditions.body[1][1], 'ELSE refer');
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);
  // Step table stays free of source columns; evidence lives in its own section.
  assert.ok(!steps.header.includes('Source pages'));
  assert.ok(!steps.header.includes('Evidence'));
  assert.ok(sectionRows(values, 'Source evidence') !== null);
});

test('excel: leading zeros and numeric precision survive export', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      tables: [{
        name: 'Codes', sourcePages: [1], evidenceText: 'ev',
        headers: ['Code', 'Cost'], rows: [['0012', '1.10'], ['0045', '2.00'], ['0108', '0.92']],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  for (const expected of ['0012', '0045', '0108', '1.10', '2.00', '0.92']) {
    assert.ok(strings.includes(`<t xml:space="preserve">${expected}</t>`), `missing exact value: ${expected}`);
  }
  assert.ok(!strings.includes('<t xml:space="preserve">12</t>'), 'leading zeros must not be stripped');
  assert.equal(countRows(sheetXmlByName(zip, workbook, 'Codes')), 5); // title + headers + 3 rows, order preserved
});

test('excel: table sheets omit export-only columns and repeated metadata', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      tables: [{
        id: 'T9', name: 'Example Factors', sourcePages: [2], evidenceText: 'ev',
        headers: ['Key', 'Value'], rows: [['k1', '1.50'], ['', '2.00']],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const sheet = sheetXmlByName(zip, workbook, 'Example Factors');
  const rows = [...sheet.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)].map((m) => ({ num: Number(m[1]), body: m[2] }));
  assert.deepEqual(rows.map((r) => r.num), [1, 2, 3, 4]);
  // Data rows carry exactly the real columns; blanks preserved as empty shared strings.
  assert.equal((rows[2].body.match(/<c /g) || []).length, 2);
  assert.equal((rows[3].body.match(/<c /g) || []).length, 2);
  const strings = zip.get('xl/sharedStrings.xml');
  assert.ok(!strings.includes('<t xml:space="preserve">Row #</t>'), 'factor sheets must not include Row #');
});

test('excel: sheet names are safe and unique', () => {
  const names = tableSheetNames([
    { id: 'T1', name: 'Duplicate Title With A Very Long Name That Exceeds Thirty One Characters' },
    { id: 'T2', name: 'Duplicate Title With A Very Long Name That Exceeds Thirty One Characters' },
    { id: 'T3', name: 'Bad:/\\?*[]Chars' },
    { id: 'T4', name: '' },
    { id: 'T5', name: 'Cover' },
  ]);
  assert.equal(names.length, 5);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 5);
  for (const name of names) {
    assert.ok(name.length >= 1 && name.length <= 31, `unsafe length: ${name}`);
    assert.ok(!/[:\\/?*[\]]/.test(name), `forbidden chars: ${name}`);
  }
  assert.notEqual(names[0], names[1]);
  assert.ok(names[2].includes('Bad'), 'sanitized name keeps readable base');
});

test('excel: rating routine sheet renders structured steps in stepwise form', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      tables: [{ name: 'Factors', sourcePages: [1], evidenceText: 'ev', headers: ['K', 'V'], rows: [['a', '1']] }],
      routines: [{
        name: 'Ordered Calc', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'ev',
        applicability: 'Each item', execution_context: 'per item',
        steps: [
          { sequence: 1, instruction: 'Initialize limit', operation: 'assignment', expression: 'x = 0', output: 'x' },
          { sequence: 2, instruction: 'Look up factor', operation: 'lookup', inputs: ['key_a', 'key_b'], output: 'f' },
          { sequence: 4, instruction: 'Round result', operation: 'rounding', operand: 'round to whole', output: 'r' },
        ],
        dependsOn: ['Factors'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ordered Calc'), strings);
  assert.deepEqual(values[0], ['Ordered Calc']);
  assert.ok(values.some((row) => row[0] === 'Applicability' && row[1] === 'Each item'));
  assert.ok(values.some((row) => row[0] === 'Execution context' && row[1] === 'per item'));
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['1', '2', '4']); // gaps preserved without expansion
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '<--', 'R']);
  assert.deepEqual(steps.body[0], ['1', 'x', '<--', '', '0', '', 'Assign 0 to x (source step 1)']);
  assert.deepEqual(steps.body[1], ['2', 'f', '<--', '', 'key_a, key_b', '', 'Lookup f (source step 2)']);
  assert.deepEqual(steps.body[2], ['4', 'r', 'R', '', 'round to whole', '', 'Round r (source step 4)']);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);
});

test('excel: step comments trace routine outputs and flag unresolved tables', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      tables: [{ name: 'Factors', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['a']] }],
      routines: [
        { name: 'Upstream', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'shared = base + 1' },
        {
          name: 'Downstream', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'ev',
          inputs: ['fee'],
          steps: [
            { sequence: 1, instruction: 'Compute total', operation: 'expression', expression: 'total = shared + fee', inputs: ['shared', 'fee'], output: 'total' },
            { sequence: 2, instruction: 'Look up rate', operation: 'lookup', inputs: ['K'], output: 'rate', depends_on: ['Table 9'] },
          ],
        },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Downstream'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['1', '2', '3']);
  assert.deepEqual(steps.body[0], ['1', 'total', '<--', '', 'shared', '', 'uses shared from Upstream']);
  assert.deepEqual(steps.body[1], ['2', '', '+', '', 'fee', '', 'Apply + fee to continue total from prior step (source step 1)']);
  assert.deepEqual(steps.body[2], ['3', 'rate', '<--', '', 'table:Table 9 (K)', '', 'table unresolved — verify']);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  // The cross-routine value resolves; only the unknown table is flagged.
  assert.ok(!job.issues.some((i) => /"shared"/.test(i.message)));
  assert.ok(job.issues.some((i) => /Table 9/.test(i.message) && /flagged as unresolved/.test(i.message)));
});

test('excel: routine sheet preserves condition branches and referral codes', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      routines: [{
        name: 'Eligibility', kind: 'condition', sourcePages: [1], evidenceText: 'ev',
        conditions: [{
          condition: 'territory in permitted set', true_branch: 'use matching factor',
          false_branch: 'refer for manual review', referral_code: 'REF-1',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Eligibility'), strings);
  const conditions = sectionRows(values, 'Conditions');
  assert.deepEqual(conditions.header, ['#', 'Condition', 'True branch', 'False branch', 'Referral code']);
  assert.deepEqual(conditions.body, [['1', 'territory in permitted set', 'use matching factor', 'refer for manual review', 'REF-1']]);
});

test('excel: each routine sheet carries only its own details and unresolved items', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      routines: [
        {
          name: 'First', kind: 'formula', sourcePages: [1], evidenceText: 'ev1',
          expressionText: 'a = b + 1', dependsOn: ['Missing Asset'],
        },
        {
          name: 'Second', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'ev2',
          steps: ['Do something'],
        },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const first = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'First'), strings);
  const second = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Second'), strings);
  assert.deepEqual(first[0], ['First']);
  assert.deepEqual(second[0], ['Second']);
  assert.deepEqual(sectionRows(first, 'Steps').body, [
    ['1', 'a', '<--', '', 'b', '', 'Start a from b (source step 1)'],
    ['2', '', '+', '', '1', '', 'Apply + 1 to continue a from prior step (source step 1)'],
  ]);
  assert.equal(sectionRows(first, 'Dependencies'), null);
  assert.equal(sectionRows(second, 'Dependencies'), null);
  const firstUnresolved = sectionRows(first, 'Unresolved items');
  assert.ok(firstUnresolved !== null && firstUnresolved.body.length >= 1);
  assert.ok(firstUnresolved.body.some((row) => row[2].includes('Missing Asset')));
  assert.equal(sectionRows(second, 'Unresolved items'), null);
  assert.deepEqual(sectionRows(second, 'Steps').body, [['1', 'Do something', '', '', '', '', 'Source instruction (source step 1)']]);
});

test('excel: routine sheet names are safe, unique, and avoid table sheets', () => {
  const tableNames = tableSheetNames([{ id: 'T1', name: 'Shared Name' }]);
  const names = routineSheetNames(
    [
      { id: 'R1', name: 'Shared Name' },
      { id: 'R2', name: 'Shared Name' },
      { id: 'R3', name: 'Bad:/\\?*[]Chars With A Very Long Tail That Must Truncate' },
      { id: 'R4', name: '' },
      { id: 'R5', name: 'Issues' },
    ],
    tableNames
  );
  assert.equal(names.length, 5);
  const all = [...tableNames, ...names].map((n) => n.toLowerCase());
  assert.equal(new Set(all).size, all.length);
  for (const name of names) {
    assert.ok(name.length >= 1 && name.length <= 31, `unsafe length: ${name}`);
    assert.ok(!/[:\\/?*[\]]/.test(name), `forbidden chars: ${name}`);
  }
  assert.notEqual(names[0], names[1]);
});

function twoByTwoJob() {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      tables: [
        { name: 'First Table', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['a']] },
        { name: 'Second Table', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['b']] },
      ],
      routines: [
        { name: 'First Routine', kind: 'formula', sourcePages: [2], evidenceText: 'ev', expressionText: 'a = 1' },
        { name: 'Second Routine', kind: 'formula', sourcePages: [2], evidenceText: 'ev', expressionText: 'b = 2' },
      ],
    })
  );
  job.issues = validateJob(job);
  return job;
}

test('excel: sheets follow Cover, Table Summary, Routine Summary, then details', () => {
  const job = twoByTwoJob();
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const names = sheetNamesInOrder(zip.get('xl/workbook.xml'));
  const tableSheets = tableSheetNames(job.tables);
  const routineSheets = routineSheetNames(job.routines, tableSheets);
  assert.deepEqual(names, [
    'Cover', 'Table Summary', 'Routine Summary', 'Table Columns',
    ...tableSheets, ...routineSheets, 'Issues',
  ]);
});

test('excel: cover indexes tables and routines with hyperlinks to detail sheets', () => {
  const job = twoByTwoJob();
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const coverXml = sheetXmlByName(zip, workbook, 'Cover');
  const values = sheetRowsAsValues(coverXml, strings);
  // Existing cover details are preserved.
  assert.deepEqual(values[0], ['Field', 'Value']);
  assert.ok(values.some((row) => row[0] === 'Document' && row[1] === 'g.pdf'));
  const tablesBlock = blockRows(values, 'Included Rating Tables');
  assert.deepEqual(tablesBlock, [['T1', 'First Table'], ['T2', 'Second Table']]);
  const routinesBlock = blockRows(values, 'Included Rating Routines');
  assert.deepEqual(routinesBlock, [['R1', 'First Routine'], ['R2', 'Second Routine']]);
  // Each name links to its detail worksheet.
  const tableSheets = tableSheetNames(job.tables);
  const routineSheets = routineSheetNames(job.routines, tableSheets);
  const links = new Map(hyperlinksIn(coverXml).map((l) => [l.ref, l.location]));
  const tablesLabel = values.findIndex((row) => row.length === 1 && row[0] === 'Included Rating Tables');
  tableSheets.forEach((sheet, i) => {
    assert.equal(links.get(cellRef(tablesLabel + 1 + i, 1)), expectedLocation(sheet));
  });
  const routinesLabel = values.findIndex((row) => row.length === 1 && row[0] === 'Included Rating Routines');
  routineSheets.forEach((sheet, i) => {
    assert.equal(links.get(cellRef(routinesLabel + 1 + i, 1)), expectedLocation(sheet));
  });
  assert.equal(links.size, 4);
});

test('excel: routine titles, section headings, and column headers are styled, data is not', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      tables: [{ name: 'Base', sourcePages: [1], evidenceText: 'ev', headers: ['K', 'V'], rows: [['a', '1']] }],
      routines: [
        {
          name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
          steps: ['Step 1: Do first thing', 'Step 2: Do second thing'],
          conditions: ['IF x THEN y'],
          dependsOn: ['Base'],
        },
        { name: 'Plain', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'a = b * 2', dependsOn: ['Base'] },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  // Title font is bold and slightly larger; section headings share one subtle fill.
  const styles = zip.get('xl/styles.xml');
  assert.ok(styles.includes('<font><sz val="14"/><b/><name val="Calibri"/></font>'), 'title font must be bold and larger');
  assert.ok(styles.includes('FFD9E1F2'), 'section headings must share one subtle fill');
  assert.ok(styles.includes('<xf numFmtId="0" fontId="3" fillId="0"'), 'title style must use the larger bold font');
  assert.ok(styles.includes('<xf numFmtId="0" fontId="1" fillId="1"'), 'section heading style must be bold with fill');

  const assertRoutineFormatting = (sheetName, expectedSections) => {
    const sheetXml = sheetXmlByName(zip, workbook, sheetName);
    const values = sheetRowsAsValues(sheetXml, strings);
    assert.deepEqual(rowCellStyles(sheetXml, 1), ['3']); // routine title: bold + larger
    for (const label of expectedSections) {
      const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
      assert.ok(idx >= 0, `${sheetName} missing section: ${label}`);
      assert.deepEqual(rowCellStyles(sheetXml, idx + 1), ['4'], `${sheetName} heading must use section style: ${label}`);
      if (label === 'Source evidence') {
        const body = blockRows(values, label);
        body.forEach((_, i) => {
          assert.ok(rowCellStyles(sheetXml, idx + 2 + i).every((s) => s === null), `${sheetName} evidence data must stay normal`);
        });
        continue;
      }
      const section = sectionRows(values, label);
      assert.ok(section !== null, `${sheetName} missing table: ${label}`);
      assert.ok(rowCellStyles(sheetXml, idx + 2).length > 0);
      assert.ok(rowCellStyles(sheetXml, idx + 2).every((s) => s === '1'), `${sheetName} column headers must be bold: ${label}`);
      section.body.forEach((_, i) => {
        assert.ok(rowCellStyles(sheetXml, idx + 3 + i).every((s) => s === null), `${sheetName} data must stay normal: ${label}`);
      });
    }
    return values;
  };

  // Step-based routine: every present section is styled; data stays normal.
  const calcValues = assertRoutineFormatting('Calc', ['Steps', 'Conditions', 'Source evidence']);
  assert.deepEqual(sectionRows(calcValues, 'Steps').header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(sectionRows(calcValues, 'Steps').body.map((row) => row[1]), ['Step 1: Do first thing', 'Step 2: Do second thing']);
  // No separate inventory sections and no empty sections for visual consistency.
  assert.equal(sectionRows(calcValues, 'Inputs'), null);
  assert.equal(sectionRows(calcValues, 'Dependencies'), null);
  assert.equal(sectionRows(calcValues, 'Final calculation'), null);
  assert.equal(sectionRows(calcValues, 'Unresolved items'), null);

  // Formula-only routine: the expression expands to one row per operation
  // with the same title/heading/header styling.
  const plainValues = assertRoutineFormatting('Plain', ['Steps', 'Source evidence']);
  assert.deepEqual(sectionRows(plainValues, 'Steps').header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(sectionRows(plainValues, 'Steps').body, [
    ['1', 'a', '<--', '', 'b', '', 'Start a from b (source step 1)'],
    ['2', '', '*', '', '2', '', 'Apply * 2 to continue a from prior step (source step 1)'],
  ]);
  assert.equal(sectionRows(plainValues, 'Inputs'), null);
  assert.equal(sectionRows(plainValues, 'Dependencies'), null);
  assert.equal(sectionRows(plainValues, 'Final calculation'), null);
});

test('excel: summaries link each name to its detail sheet', () => {
  const job = twoByTwoJob();
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const tableSheets = tableSheetNames(job.tables);
  const routineSheets = routineSheetNames(job.routines, tableSheets);
  const tableXml = sheetXmlByName(zip, workbook, 'Table Summary');
  const tableLinks = hyperlinksIn(tableXml);
  assert.equal(tableLinks.length, 2);
  tableSheets.forEach((sheet, i) => {
    assert.deepEqual(tableLinks[i], { ref: cellRef(i + 1, 1), location: expectedLocation(sheet) });
  });
  const tableValues = sheetRowsAsValues(tableXml, strings);
  assert.equal(tableValues[1][1], 'First Table');
  assert.equal(tableValues[2][1], 'Second Table');
  const routineXml = sheetXmlByName(zip, workbook, 'Routine Summary');
  const routineLinks = hyperlinksIn(routineXml);
  assert.equal(routineLinks.length, 2);
  routineSheets.forEach((sheet, i) => {
    assert.deepEqual(routineLinks[i], { ref: cellRef(i + 1, 1), location: expectedLocation(sheet) });
  });
  const routineValues = sheetRowsAsValues(routineXml, strings);
  assert.equal(routineValues[1][1], 'First Routine');
  assert.equal(routineValues[2][1], 'Second Routine');
});

test('excel: rating routine steps trace variables without separate inventories', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 3 }),
      tables: [
        { name: 'Table 1 - Base Rate by Driver Class', sourcePages: [1], evidenceText: 'ev', headers: ['Driver Class', 'Base Rate'], rows: [['Preferred', '480']] },
        { name: 'Table 2 - Territory Factor', sourcePages: [2], evidenceText: 'ev', headers: ['Territory', 'Factor'], rows: [['T01', '1.35']] },
      ],
      routines: [
        {
          name: 'B1 - Base premium formula', kind: 'formula', sourcePages: [1], evidenceText: 'ev',
          expressionText: 'base_premium = base_rate * territory_factor',
          dependsOn: ['Table 1 - Base Rate by Driver Class', 'Table 2 - Territory Factor'],
        },
        {
          name: 'T1 - Territory eligibility condition', kind: 'condition', sourcePages: [2], evidenceText: 'ev',
          conditions: ['IF territory IN (T01) THEN apply Table 2 factor'],
          dependsOn: ['Table 2 - Territory Factor'],
        },
        {
          name: 'F1 - Final premium calculation', kind: 'calculation_steps', sourcePages: [3], evidenceText: 'ev',
          expressionText: 'final_premium = base_premium + policy_fee',
          steps: [
            'Look up base_rate from Table 1 using driver class.',
            'Look up territory_factor from Table 2 using territory.',
            'final_premium = base_premium + policy_fee, where policy_fee = 25.',
            'Round final_premium to the nearest dollar.',
          ],
          dependsOn: ['B1 - Base premium formula', 'T1 - Territory eligibility condition'],
        },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const routineSheets = routineSheetNames(job.routines, tableSheetNames(job.tables));
  const byName = (name) => {
    const idx = job.routines.findIndex((r) => r.name === name);
    return sheetRowsAsValues(sheetXmlByName(zip, workbook, routineSheets[idx]), strings);
  };

  // B1: ordered operation rows carry the stated formula; the tables it
  // names stay out of any separate inventory.
  const b1 = byName('B1 - Base premium formula');
  assert.deepEqual(sectionRows(b1, 'Steps').body, [
    ['1', 'base_premium', '<--', '', 'base_rate', '', 'Start base_premium from base_rate (source step 1)'],
    ['2', '', '*', '', 'territory_factor', '', 'Apply * territory_factor to continue base_premium from prior step (source step 1)'],
  ]);
  assert.equal(sectionRows(b1, 'Inputs'), null);
  assert.equal(sectionRows(b1, 'Dependencies'), null);
  assert.equal(sectionRows(b1, 'Final calculation'), null);

  // F1: lookups assign table values to variables and the routine input
  // stays traced to its producing routine; nothing is guessed.
  const f1 = byName('F1 - Final premium calculation');
  const f1steps = sectionRows(f1, 'Steps');
  assert.deepEqual(f1steps.body[0], ['1', 'base_rate', '<--', '', 'table:Table 1 - Base Rate by Driver Class (driver class)', '', 'Lookup base_rate from Table 1 - Base Rate by Driver Class']);
  assert.deepEqual(f1steps.body[1], ['2', 'territory_factor', '<--', '', 'table:Table 2 - Territory Factor (territory)', '', 'Lookup territory_factor from Table 2 - Territory Factor']);
  assert.deepEqual(f1steps.body[2][6], 'uses base_premium from B1 - Base premium formula');
  assert.equal(sectionRows(f1, 'Inputs'), null);
  assert.equal(sectionRows(f1, 'Dependencies'), null);
  assert.equal(sectionRows(f1, 'Final calculation'), null);

  // T1 is a condition routine, so it keeps the legacy layout: no inputs
  // means no mapping section is shown.
  const t1 = byName('T1 - Territory eligibility condition');
  assert.equal(sectionRows(t1, 'Inputs'), null);
});

test('excel: steps show how table values feed later calculations', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      tables: [{ name: 'Lookup Table', sourcePages: [1], evidenceText: 'ev', headers: ['Key', 'Value'], rows: [['k1', '1']] }],
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'ev',
        inputs: ['factor'],
        outputs: ['y'],
        steps: [
          { sequence: 1, instruction: 'Look up x', operation: 'lookup', inputs: ['my_key'], output: 'x', depends_on: ['Lookup Table'] },
          { sequence: 2, instruction: 'Compute y', operation: 'expression', expression: 'y = x * 2', inputs: ['x', 'factor'], output: 'y' },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Calc'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body[0], ['1', 'x', '<--', '', 'table:Lookup Table (my_key)', '', 'Lookup x from Lookup Table']);
  assert.deepEqual(steps.body[1], ['2', 'y', '<--', '', 'x', '', 'uses x from step 1 (Lookup Table)']);
  assert.deepEqual(steps.body[2], ['3', '', '*', '', '2', '', 'Apply * 2 to continue y from prior step (source step 2)']);
  // No separate inventories: the steps carry the table link and the
  // external factor stays a plain operand without a guessed source.
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);
});

test('excel: steps trace the producing routine and flag unresolved tables', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
      tables: [{ name: 'Factors', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['a']] }],
      routines: [
        { name: 'Upstream', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'shared = base + 1' },
        {
          name: 'Downstream', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'ev',
          inputs: ['fee'],
          steps: [
            { sequence: 1, instruction: 'Compute total', operation: 'expression', expression: 'total = shared + fee', inputs: ['shared', 'fee'], output: 'total' },
            { sequence: 2, instruction: 'Look up rate', operation: 'lookup', inputs: ['K'], output: 'rate', depends_on: ['Table 9'] },
          ],
        },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Downstream'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.body[0], ['1', 'total', '<--', '', 'shared', '', 'uses shared from Upstream']);
  assert.deepEqual(steps.body[1], ['2', '', '+', '', 'fee', '', 'Apply + fee to continue total from prior step (source step 1)']);
  assert.deepEqual(steps.body[2], ['3', 'rate', '<--', '', 'table:Table 9 (K)', '', 'table unresolved — verify']);
  // No separate inventories: the producing routine stays traced in the
  // step comment and the unknown table is flagged in place.
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);
  // The upstream formula expands to one row per operation.
  const up = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Upstream'), strings);
  assert.deepEqual(sectionRows(up, 'Steps').body, [
    ['1', 'shared', '<--', '', 'base', '', 'Start shared from base (source step 1)'],
    ['2', '', '+', '', '1', '', 'Apply + 1 to continue shared from prior step (source step 1)'],
  ]);
  assert.equal(sectionRows(up, 'Inputs'), null);
});

test('excel: routine sheet follows stepwise rating routine steps (Collision coverage)', () => {
  // Models a stepwise collision coverage rating routine: lookups assign table
  // values to variables, intermediate assignments copy values through, a
  // chained multiply keeps the source '*' operation verbatim, and rounding renders
  // as 'R' assigning its output with the operand carried through verbatim.
  // Lookup keys render as
  // spaced labels ('Coverage Name'), never as object paths ('Coverage.Name').
  // No separate inventory sections.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'guideline.pdf', pageCount: 1 }),
      tables: [
        {
          name: 'Collision Driver Vehicle Factor', sourcePages: [1], evidenceText: 'factor schedule ($)',
          headers: ['Driver Age', 'Deductible', 'Vehicle Age', 'Factor'], rows: [['25', '500', '5', '1.20']],
        },
        {
          name: 'Base Rate', sourcePages: [1], evidenceText: 'base rates ($)',
          headers: ['Coverage Name', 'Rate'], rows: [['Collision', '70.00']],
        },
      ],
      routines: [{
        name: 'Collision coverage rating', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'Collision coverage rating steps 1-8.',
        inputs: ['AssignedDriver.DriverAge', 'Coverage.Deductible', 'Vehicle.VehicleAge', 'Coverage.Name'],
        outputs: ['TermAmount'],
        steps: [
          { sequence: 1, instruction: 'CollisionDriverVehicleFactor', operation: 'lookup', inputs: ['AssignedDriver.DriverAge', 'Coverage.Deductible', 'Vehicle.VehicleAge'], output: 'CollisionDriverVehicleFactor', depends_on: ['Collision Driver Vehicle Factor'] },
          { sequence: 2, instruction: 'BaseRateFactor', operation: 'lookup', inputs: ['Coverage.Name'], output: 'BaseRateFactor', depends_on: ['Base Rate'] },
          { sequence: 3, instruction: 'Basis', operation: 'assignment', expression: 'Basis = 1', output: 'Basis' },
          { sequence: 4, instruction: 'BaseRate', operation: 'assignment', expression: 'BaseRate = BaseRateFactor', inputs: ['BaseRateFactor'], output: 'BaseRate' },
          { sequence: 5, instruction: 'AdjustedRate', operation: 'assignment', expression: 'AdjustedRate = BaseRate', inputs: ['BaseRate'], output: 'AdjustedRate' },
          { sequence: 6, instruction: '', operation: '*', operand: 'CollisionDriverVehicleFactor', inputs: ['CollisionDriverVehicleFactor'] },
          { sequence: 7, instruction: 'TermAmount', operation: 'assignment', expression: 'TermAmount = AdjustedRate', inputs: ['AdjustedRate'], output: 'TermAmount' },
          { sequence: 8, instruction: '', operation: 'rounding', operand: '1', inputs: ['TermAmount'], output: 'TermAmount' },
        ],
        dependsOn: ['Collision Driver Vehicle Factor', 'Base Rate'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Collision coverage rating'), strings);

  // Layout: ordered steps communicate the complete routine, then source
  // evidence. No separate Inputs, Final calculation, or Dependencies.
  const labelIndex = (label) => values.findIndex((row) => row.length === 1 && row[0] === label);
  const stepsAt = labelIndex('Steps');
  assert.ok(stepsAt >= 0, 'expected a Steps section');
  assert.equal(labelIndex('Inputs'), -1);
  assert.equal(labelIndex('Final calculation'), -1);
  assert.equal(labelIndex('Dependencies'), -1);
  assert.ok(labelIndex('Source evidence') > stepsAt);
  assert.ok(!values.some((row) => row[0] === 'Expression'), 'formula must not lead the sheet');

  // Steps match the reference routine row for row: assignments read as
  // `variable <-- operand`, the chained multiply keeps '*', rounding is
  // 'R', and each intermediate value stays traced to its source step.
  // Bracket columns stay explicit (empty here); every row keeps a comment.
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(steps.body[0], ['1', 'CollisionDriverVehicleFactor', '<--', '', 'table:Collision Driver Vehicle Factor (AssignedDriver DriverAge, Coverage Deductible, Vehicle VehicleAge)', '', 'Lookup CollisionDriverVehicleFactor from Collision Driver Vehicle Factor']);
  assert.deepEqual(steps.body[1], ['2', 'BaseRateFactor', '<--', '', 'table:Base Rate (Coverage Name)', '', 'Lookup BaseRateFactor from Base Rate']);
  assert.deepEqual(steps.body[2], ['3', 'Basis', '<--', '', '1', '', 'Assign 1 to Basis (source step 3)']);
  assert.deepEqual(steps.body[3], ['4', 'BaseRate', '<--', '', 'BaseRateFactor', '', 'uses BaseRateFactor from step 2 (Base Rate)']);
  assert.deepEqual(steps.body[4], ['5', 'AdjustedRate', '<--', '', 'BaseRate', '', 'uses BaseRate from step 4']);
  assert.deepEqual(steps.body[5], ['6', '', '*', '', 'CollisionDriverVehicleFactor', '', 'uses CollisionDriverVehicleFactor from step 1 (Collision Driver Vehicle Factor)']);
  assert.deepEqual(steps.body[6], ['7', 'TermAmount', '<--', '', 'AdjustedRate', '', 'uses AdjustedRate from step 5']);
  assert.deepEqual(steps.body[7], ['8', 'TermAmount', 'R', '', '1', '', 'uses TermAmount from step 7']);
  assert.equal(sectionRows(values, 'Unresolved items'), null);
  assert.ok(blockRows(values, 'Source evidence') !== null);
});

test('excel: generic staged calc keeps multiplication and rounding as separate steps', () => {
  // Generic three-lookup routine: Step 4 calculates with ×, Step 5 rounds
  // half-up in place. No expression_text was extracted; the ordered steps
  // alone communicate the routine, with no separate inventory sections.
  const steps = [
    'Step 1: Look up alpha_rate using customer_tier in the Alpha rating table.',
    'Step 2: Look up beta_factor using region_code in the Beta factor table.',
    'Step 3: Look up gamma_factor using account_age in the Gamma factor table.',
    'Step 4: Calculate quoted_total = alpha_rate × beta_factor × gamma_factor.',
    'Step 5: Round quoted_total to the nearest whole currency unit using standard half-up rounding.',
  ];
  const evidence = 'Routine GEN-001 — Sample staged calculation. Inputs: customer_tier, region_code, account_age. Step 4: Calculate quoted_total = alpha_rate × beta_factor × gamma_factor. Step 5: Round quoted_total to the nearest whole currency unit using standard half-up rounding.';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'sample-staged-guidelines.pdf', pageCount: 2 }),
      tables: [
        { name: 'Alpha rating table', sourcePages: [1], evidenceText: 'Alpha rating table', headers: ['Customer tier', 'Alpha rate'], rows: [['V1', '1200']] },
        { name: 'Beta factor table', sourcePages: [1], evidenceText: 'Beta factor table', headers: ['Region code', 'Factor'], rows: [['T1', '0.85']] },
        { name: 'Gamma factor table', sourcePages: [1], evidenceText: 'Gamma factor table', headers: ['Account age', 'Factor'], rows: [['Less than 2', '1.40']] },
      ],
      routines: [{
        name: 'GEN-001 — Sample Staged Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: evidence,
        expressionText: '',
        steps,
        dependsOn: ['Alpha rating table', 'Beta factor table', 'Gamma factor table'],
        inputs: ['customer_tier', 'region_code', 'account_age'],
        outputs: ['quoted_total'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);

  // Steps 1-3 map each lookup key to its result variable and source table.
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 5);
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'lookup', 'lookup', 'expression', 'rounding']);
  assert.deepEqual(det[0].inputs, ['customer_tier']);
  assert.equal(det[0].output, 'alpha_rate');
  assert.deepEqual(det[0].depends_on, ['Alpha rating table']);
  assert.deepEqual(det[1].inputs, ['region_code']);
  assert.equal(det[1].output, 'beta_factor');
  assert.deepEqual(det[1].depends_on, ['Beta factor table']);
  assert.deepEqual(det[2].inputs, ['account_age']);
  assert.equal(det[2].output, 'gamma_factor');
  assert.deepEqual(det[2].depends_on, ['Gamma factor table']);

  // Step 4 is a structured multiplication expression preserving the source ×.
  assert.equal(det[3].operation, 'expression');
  assert.equal(det[3].expression, 'quoted_total = alpha_rate × beta_factor × gamma_factor');
  assert.equal(det[3].output, 'quoted_total');
  assert.deepEqual(det[3].inputs, ['alpha_rate', 'beta_factor', 'gamma_factor']);
  assert.equal(det[4].operation, 'rounding');
  assert.equal(det[4].output, 'quoted_total');

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'GEN-001 — Sample Staged Calc'), strings);

  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);

  // Steps expand the chained multiplication to one row per operation in
  // source order: lookups assign table values, each × is its own row with
  // explicit brackets, rounding assigns its output with the source wording,
  // and every row keeps a comment.
  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '<--', '×', '×', 'R']);
  assert.deepEqual(stepsSection.body[0], ['1', 'alpha_rate', '<--', '', 'table:Alpha rating table (customer_tier)', '', 'Lookup alpha_rate from Alpha rating table']);
  assert.deepEqual(stepsSection.body[1], ['2', 'beta_factor', '<--', '', 'table:Beta factor table (region_code)', '', 'Lookup beta_factor from Beta factor table']);
  assert.deepEqual(stepsSection.body[2], ['3', 'gamma_factor', '<--', '', 'table:Gamma factor table (account_age)', '', 'Lookup gamma_factor from Gamma factor table']);
  assert.deepEqual(stepsSection.body[3], ['4', 'quoted_total', '<--', '', 'alpha_rate', '', 'uses alpha_rate from step 1 (Alpha rating table)']);
  assert.deepEqual(stepsSection.body[4], ['5', '', '×', '', 'beta_factor', '', 'uses beta_factor from step 2 (Beta factor table)']);
  assert.deepEqual(stepsSection.body[5], ['6', '', '×', '', 'gamma_factor', '', 'uses gamma_factor from step 3 (Gamma factor table)']);
  assert.deepEqual(stepsSection.body[6], ['7', 'quoted_total', 'R', '', 'to the nearest whole currency unit using standard half-up rounding', '', 'Round quoted_total (source step 5)']);
  assert.ok(stepsSection.body.every((row) => row.length === 7 && row[6] !== ''));

  // Source evidence is preserved verbatim.
  const evidenceRows = blockRows(values, 'Source evidence');
  assert.ok(evidenceRows.some((row) => row[0] === 'Source pages' && row[1] === '2'));
  assert.ok(evidenceRows.some((row) => row[0] === 'Evidence' && row[1].includes('GEN-001')));
});

test('excel: generic multi-stage calc keeps IF/ELSE and rounding stages in step order', () => {
  // Generic four-lookup routine: Step 5 divides and multiplies, Step 6 is an
  // IF/ELSE minimum, Step 7 rounds into a new variable. Short table aliases
  // resolve to the extracted tables; the ordered steps carry every stage.
  const steps = [
    'Step 1: Find the base value for billing_group in Index A.',
    'Step 2: Retrieve plan_factor from Index B using plan_code.',
    'Step 3: Look up tier_factor using tier_level in Index C.',
    'Step 4: Select the zone factor for zone_code from Index D.',
    'Step 5: Calculate gross_amount = (contract_value / 1000) × base_value × plan_factor × tier_factor × zone_factor.',
    'Step 6: Apply a minimum charge of 200 currency units. If gross_amount is below 200, set net_amount to 200; otherwise net_amount equals gross_amount.',
    'Step 7: Round net_amount to the nearest whole currency unit using half-up rounding. Store the result as billed_amount.',
  ];
  const intermediate = 'gross_amount = (contract_value / 1000) × base_value × plan_factor × tier_factor × zone_factor';
  const evidence = 'Routine GEN-002 - Sample multi-stage calculation. Inputs: billing_group, plan_code, tier_level, zone_code, contract_value. Step 5: Calculate gross_amount. Step 6: minimum charge conditional. Step 7: rounding to billed_amount.';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'sample-multi-stage-guidelines.pdf', pageCount: 3 }),
      tables: [
        { name: 'Index A - Base value', sourcePages: [1], evidenceText: 'Index A schedule (annual rate per 1,000)', headers: ['Billing group', 'Base value'], rows: [['O1', '1.20']] },
        { name: 'Index B - Plan factor', sourcePages: [1], evidenceText: 'Index B schedule (annual factor per class)', headers: ['Plan code', 'Factor'], rows: [['C1', '0.80']] },
        { name: 'Index C - Tier factor', sourcePages: [1], evidenceText: 'Index C schedule (annual factor per class)', headers: ['Tier level', 'Factor'], rows: [['P1', '0.90']] },
        { name: 'Index D - Zone factor', sourcePages: [2], evidenceText: 'Index D schedule (annual factor per zone)', headers: ['Zone code', 'Factor'], rows: [['Urban', '1.20']] },
      ],
      routines: [{
        name: 'GEN-002 - Sample Multi-Stage Calc',
        kind: 'calculation_steps',
        sourcePages: [3],
        evidenceText: evidence,
        expressionText: intermediate,
        steps,
        conditions: ['If gross_amount is below 200, set net_amount to 200; otherwise net_amount equals gross_amount.'],
        dependsOn: ['Index A', 'Index B', 'Index C', 'Index D'],
        inputs: ['billing_group', 'plan_code', 'tier_level', 'zone_code', 'contract_value'],
        outputs: ['billed_amount'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(!job.issues.some((i) => /matches no extracted table/.test(i.message)), 'short table aliases must resolve');

  const det = job.routines[0].steps_detailed;
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'lookup', 'lookup', 'lookup', 'expression', 'condition', 'rounding']);
  assert.deepEqual(det.map((d) => d.output), ['base_value', 'plan_factor', 'tier_factor', 'zone_factor', 'gross_amount', 'net_amount', 'billed_amount']);
  assert.deepEqual(det[0].inputs, ['billing_group']);
  assert.deepEqual(det[0].depends_on, ['Index A']);
  assert.deepEqual(det[1].inputs, ['plan_code']);
  assert.deepEqual(det[4].inputs, ['contract_value', 'base_value', 'plan_factor', 'tier_factor', 'zone_factor']);
  assert.deepEqual(det[5].inputs, ['gross_amount']);
  assert.deepEqual(det[6].inputs, ['net_amount']);

  const cond = job.routines[0].conditions_detailed;
  assert.equal(cond.length, 1);
  assert.equal(cond[0].condition, 'gross_amount is below 200');
  assert.equal(cond[0].true_branch, 'set net_amount to 200');
  assert.equal(cond[0].false_branch, 'net_amount equals gross_amount.');

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const routineSheet = routineSheetNames(job.routines, tableSheetNames(job.tables))[0];
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, routineSheet), strings);

  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);

  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '<--', '<--', '/', '×', '×', '×', '×', '', '<--', '', '<--', '', 'R']);
  assert.deepEqual(stepsSection.body[0], ['1', 'base_value', '<--', '', 'table:Index A - Base value (billing_group)', '', 'Lookup base_value from Index A - Base value']);
  assert.deepEqual(stepsSection.body[1], ['2', 'plan_factor', '<--', '', 'table:Index B - Plan factor (plan_code)', '', 'Lookup plan_factor from Index B - Plan factor']);
  assert.deepEqual(stepsSection.body[3], ['4', 'zone_factor', '<--', '', 'table:Index D - Zone factor (zone_code)', '', 'Lookup zone_factor from Index D - Zone factor']);
  // Parenthesized division opens, divides, and closes before the chain of
  // multiplications; each operation keeps its source symbol and order.
  assert.deepEqual(stepsSection.body[4], ['5', 'gross_amount', '<--', '(', 'contract_value', '', 'Start gross_amount from contract_value (source step 5)']);
  assert.deepEqual(stepsSection.body[5], ['6', '', '/', '', '1000', ')', 'Apply / 1000 to continue gross_amount from prior step (source step 5)']);
  assert.deepEqual(stepsSection.body[6], ['7', '', '×', '', 'base_value', '', 'uses base_value from step 1 (Index A - Base value)']);
  assert.deepEqual(stepsSection.body[7], ['8', '', '×', '', 'plan_factor', '', 'uses plan_factor from step 2 (Index B - Plan factor)']);
  assert.match(stepsSection.body[8][6], /uses tier_factor from step 3/);
  assert.match(stepsSection.body[9][6], /uses zone_factor from step 4/);
  // The minimum-charge conditional expands to IF/ELSE/ENDIF rows with one
  // assignment row per branch; dependency comments use the new numbers.
  assert.deepEqual(stepsSection.body[10].slice(0, 6), ['11', 'IF', '', '', 'gross_amount is below 200', '']);
  assert.match(stepsSection.body[10][6], /uses gross_amount from step 10/);
  assert.deepEqual(stepsSection.body[11], ['12', 'net_amount', '<--', '', '200', '', 'Set net_amount to 200 (true branch, source step 6)']);
  assert.deepEqual(stepsSection.body[12].slice(0, 6), ['13', 'ELSE', '', '', '', '']);
  assert.deepEqual(stepsSection.body[13].slice(0, 6), ['14', 'net_amount', '<--', '', 'gross_amount', '']);
  assert.match(stepsSection.body[13][6], /uses gross_amount from step 10/);
  assert.deepEqual(stepsSection.body[14].slice(0, 6), ['15', 'ENDIF', '', '', '', '']);
  assert.deepEqual(stepsSection.body[15].slice(0, 6), ['16', 'billed_amount', 'R', '', 'net_amount to the nearest whole currency unit using half-up rounding', '']);
  assert.match(stepsSection.body[15][6], /uses net_amount from step 14/);
  assert.ok(stepsSection.body.every((row) => row.length === 7 && row[6] !== ''));

  const condSection = sectionRows(values, 'Conditions');
  assert.equal(condSection.body[0][1], 'If gross_amount is below 200, set net_amount to 200; otherwise net_amount equals gross_amount.');
  assert.equal(condSection.body[0][2], 'set net_amount to 200');
  assert.equal(condSection.body[0][3], 'net_amount equals gross_amount.');

  const evidenceRows = blockRows(values, 'Source evidence');
  assert.ok(evidenceRows.some((row) => row[0] === 'Source pages' && row[1] === '3'));
  assert.ok(evidenceRows.some((row) => row[0] === 'Evidence' && row[1].includes('GEN-002')));
});

test('excel: generic widget calc keeps gross/net/billed stages distinct in step order', () => {
  const steps = [
    '1 Find the widget rate for widget_class in Schedule Q.',
    '2 Retrieve gadget_factor from Schedule R using gadget_code.',
    '3 Calculate gross_total = (account_value / 1000) × widget_rate × gadget_factor.',
    '4 Apply floor. If gross_total is below 100, set net_total to 100; otherwise net_total equals gross_total.',
    '5 Round net_total to the nearest whole unit. Store the result as billed_total.',
  ];
  const intermediate = 'gross_total = (account_value / 1000) × widget_rate × gadget_factor';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      tables: [
        { name: 'Schedule Q - Widget rate (annual rate per 1,000 of account_value)', sourcePages: [1], evidenceText: 'Schedule Q (annual rate per 1,000)', headers: ['Widget class', 'Widget rate'], rows: [['W1', '1.10']] },
        { name: 'Schedule R - Gadget factor', sourcePages: [1], evidenceText: 'Schedule R (annual factor per class)', headers: ['Gadget code', 'Factor'], rows: [['G1', '0.90']] },
      ],
      routines: [{
        name: 'Widget premium calc',
        kind: 'calculation',
        sourcePages: [1],
        evidenceText: 'Widget premium calc with gross, net, and billed stages.',
        expressionText: `${intermediate}.`,
        steps,
        dependsOn: ['Schedule Q', 'Schedule R'],
        inputs: ['widget_class', 'gadget_code', 'account_value'],
        outputs: ['billed_total'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.routines[0].kind, 'calculation_steps');
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(!job.issues.some((i) => /unrecognized kind/.test(i.message)));

  const det = job.routines[0].steps_detailed;
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'lookup', 'expression', 'condition', 'rounding']);
  assert.deepEqual(det.map((d) => d.output), ['widget_rate', 'gadget_factor', 'gross_total', 'net_total', 'billed_total']);
  assert.deepEqual(det[0].inputs, ['widget_class']);
  assert.deepEqual(det[0].depends_on, ['Schedule Q']);

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Widget premium calc'), strings);

  // No separate inventories: the steps carry every stage in source order.
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);

  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '/', '×', '×', '', '<--', '', '<--', '', 'R']);
  assert.deepEqual(stepsSection.body[0], ['1', 'widget_rate', '<--', '', 'table:Schedule Q - Widget rate (annual rate per 1,000 of account_value) (widget_class)', '', 'Lookup widget_rate from Schedule Q - Widget rate (annual rate per 1,000 of account_value)']);
  assert.deepEqual(stepsSection.body[1], ['2', 'gadget_factor', '<--', '', 'table:Schedule R - Gadget factor (gadget_code)', '', 'Lookup gadget_factor from Schedule R - Gadget factor']);
  assert.deepEqual(stepsSection.body[2], ['3', 'gross_total', '<--', '(', 'account_value', '', 'Start gross_total from account_value (source step 3)']);
  assert.deepEqual(stepsSection.body[3], ['4', '', '/', '', '1000', ')', 'Apply / 1000 to continue gross_total from prior step (source step 3)']);
  assert.match(stepsSection.body[4][6], /uses widget_rate from step 1/);
  assert.match(stepsSection.body[5][6], /uses gadget_factor from step 2/);
  assert.deepEqual(stepsSection.body[6].slice(0, 6), ['7', 'IF', '', '', 'gross_total is below 100', '']);
  assert.match(stepsSection.body[6][6], /uses gross_total from step 6/);
  assert.deepEqual(stepsSection.body[7], ['8', 'net_total', '<--', '', '100', '', 'Set net_total to 100 (true branch, source step 4)']);
  assert.deepEqual(stepsSection.body[8].slice(0, 6), ['9', 'ELSE', '', '', '', '']);
  assert.match(stepsSection.body[9][6], /uses gross_total from step 6/);
  assert.deepEqual(stepsSection.body[10].slice(0, 6), ['11', 'ENDIF', '', '', '', '']);
  assert.deepEqual(stepsSection.body[11].slice(0, 6), ['12', 'billed_total', 'R', '', 'net_total to the nearest whole unit', '']);
  assert.match(stepsSection.body[11][6], /uses net_total from step 10/);
  assert.ok(stepsSection.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: conditional chain renders IF/ELSEIF/ELSE/ENDIF under Instruction', () => {
  // Generic branched routine: the conditional step carries an else-if stage.
  // Keywords render under Instruction with an empty Op; conditions stay in
  // Operand and each branch keeps the `output <-- value` assignment form.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      tables: [
        { name: 'Lookup One', sourcePages: [1], evidenceText: 'Lookup One (annual values per key)', headers: ['Key', 'Value'], rows: [['a', '1']] },
      ],
      routines: [{
        name: 'Generic Branched Calc',
        kind: 'calculation_steps',
        sourcePages: [1],
        evidenceText: 'Generic branched calculation with an else-if stage.',
        steps: [
          'Fetch alpha_total using alpha_key from Lookup One.',
          'If alpha_total is below 100, set band_total to 100; else if alpha_total is above 500, set band_total to 500; otherwise band_total equals alpha_total.',
        ],
        dependsOn: ['Lookup One'],
        inputs: ['alpha_key'],
        outputs: ['band_total'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  const det = job.routines[0].steps_detailed;
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'condition']);
  assert.equal(det[1].output, 'band_total');

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Generic Branched Calc'), strings);
  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(stepsSection.body.map((row) => row[1]), ['alpha_total', 'IF', 'band_total', 'ELSEIF', 'band_total', 'ELSE', 'band_total', 'ENDIF']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '', '<--', '', '<--', '', '<--', '']);
  assert.deepEqual(stepsSection.body[1].slice(0, 6), ['2', 'IF', '', '', 'alpha_total is below 100', '']);
  assert.deepEqual(stepsSection.body[2], ['3', 'band_total', '<--', '', '100', '', 'Set band_total to 100 (true branch, source step 2)']);
  assert.deepEqual(stepsSection.body[3].slice(0, 6), ['4', 'ELSEIF', '', '', 'alpha_total is above 500', '']);
  assert.deepEqual(stepsSection.body[4], ['5', 'band_total', '<--', '', '500', '', 'Set band_total to 500 (else-if branch, source step 2)']);
  assert.deepEqual(stepsSection.body[5].slice(0, 6), ['6', 'ELSE', '', '', '', '']);
  assert.deepEqual(stepsSection.body[6].slice(0, 6), ['7', 'band_total', '<--', '', 'alpha_total', '']);
  assert.match(stepsSection.body[6][6], /uses alpha_total from step 1/);
  assert.deepEqual(stepsSection.body[7].slice(0, 6), ['8', 'ENDIF', '', '', '', '']);
  assert.ok(stepsSection.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: formula-only routine expands its expression into ordered operation steps', () => {
  const expr = 'gross_total = alpha_value + beta_value';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Staged totals',
        kind: 'formula',
        sourcePages: [1],
        evidenceText: 'Staged totals with a gross formula and a billed output.',
        expressionText: expr,
        inputs: ['alpha_value', 'beta_value'],
        outputs: ['billed_total'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Staged totals'), strings);
  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body, [
    ['1', 'gross_total', '<--', '', 'alpha_value', '', 'Start gross_total from alpha_value (source step 1)'],
    ['2', '', '+', '', 'beta_value', '', 'Apply + beta_value to continue gross_total from prior step (source step 1)'],
  ]);
  assert.equal(sectionRows(values, 'Final calculation'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
});

test('excel: rule actions render in the true branch while condition text stays verbatim', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Widget eligibility',
        kind: 'eligibility',
        sourcePages: [1],
        evidenceText: 'Widget eligibility rules with referral actions.',
        conditions: [
          'RULE-7 Widget count exceeds 10 units. Refer',
          'RULE-8 Risk score is low. Apply widget credit from the Widget table.',
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.routines[0].kind, 'condition');
  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Widget eligibility'), strings);
  assert.ok(values.some((row) => row[0] === 'Kind' && row[1] === 'condition'));
  const conds = sectionRows(values, 'Conditions');
  assert.equal(conds.body[0][1], 'RULE-7 Widget count exceeds 10 units. Refer');
  assert.equal(conds.body[0][2], 'Refer');
  assert.equal(conds.body[1][1], 'RULE-8 Risk score is low. Apply widget credit from the Widget table.');
  assert.equal(conds.body[1][2], 'Apply widget credit from the Widget table.');
});

test('excel: bare step numbers preserve gaps in the step column', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Gapped steps',
        kind: 'calculation_steps',
        sourcePages: [1],
        evidenceText: 'Steps with a numbering gap.',
        steps: ['1 First action here.', '3 Third action here.'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Gapped steps'), strings);
  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '3']);
  assert.deepEqual(stepsSection.body, [
    ['1', '1 First action here.', '', '', '', '', 'Source instruction (source step 1)'],
    ['3', '3 Third action here.', '', '', '', '', 'Source instruction (source step 3)'],
  ]);
});

test('excel: staged calc keeps interim and conditional stages in step order', () => {
  const interim = 'interim_total = alpha_value + beta_value';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      tables: [
        { name: 'Lookup One', sourcePages: [1], evidenceText: 'Lookup One (annual values per key)', headers: ['Key', 'Value'], rows: [['a', '1']] },
        { name: 'Lookup Two', sourcePages: [1], evidenceText: 'Lookup Two (annual values per key)', headers: ['Key', 'Value'], rows: [['b', '2']] },
      ],
      routines: [{
        name: 'Generic Staged Calc',
        kind: 'calculation_steps',
        sourcePages: [1],
        evidenceText: 'Generic staged calculation with interim and final totals.',
        expressionText: interim,
        steps: [
          'Fetch alpha_value using alpha_key from Lookup One.',
          'Obtain beta_value for beta_key in Lookup Two.',
          'Calculate interim_total = alpha_value + beta_value.',
          'If interim_total is below 100, set final_total to 100; otherwise final_total equals interim_total.',
        ],
        dependsOn: ['Lookup One', 'Lookup Two'],
        inputs: ['alpha_key', 'beta_key'],
        outputs: ['final_total'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  const det = job.routines[0].steps_detailed;
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'lookup', 'expression', 'condition']);
  assert.deepEqual(det.map((d) => d.output), ['alpha_value', 'beta_value', 'interim_total', 'final_total']);

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Generic Staged Calc'), strings);
  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '+', '', '<--', '', '<--', '']);
  assert.deepEqual(stepsSection.body[0], ['1', 'alpha_value', '<--', '', 'table:Lookup One (alpha_key)', '', 'Lookup alpha_value from Lookup One']);
  assert.deepEqual(stepsSection.body[1], ['2', 'beta_value', '<--', '', 'table:Lookup Two (beta_key)', '', 'Lookup beta_value from Lookup Two']);
  assert.deepEqual(stepsSection.body[2], ['3', 'interim_total', '<--', '', 'alpha_value', '', 'uses alpha_value from step 1 (Lookup One)']);
  assert.deepEqual(stepsSection.body[3], ['4', '', '+', '', 'beta_value', '', 'uses beta_value from step 2 (Lookup Two)']);
  assert.deepEqual(stepsSection.body[4].slice(0, 6), ['5', 'IF', '', '', 'interim_total is below 100', '']);
  assert.equal(stepsSection.body[4][6], 'uses interim_total from step 4');
  assert.deepEqual(stepsSection.body[5], ['6', 'final_total', '<--', '', '100', '', 'Set final_total to 100 (true branch, source step 4)']);
  assert.deepEqual(stepsSection.body[6].slice(0, 6), ['7', 'ELSE', '', '', '', '']);
  assert.match(stepsSection.body[7][6], /uses interim_total from step 4/);
  assert.deepEqual(stepsSection.body[8].slice(0, 6), ['9', 'ENDIF', '', '', '', '']);
  assert.ok(stepsSection.body.every((row) => row.length === 7 && row[6] !== ''));
  assert.equal(sectionRows(values, 'Final calculation'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
});

test('excel: arithmetic expansion preserves parentheses and operator precedence', () => {
  // Generic precedence pair: without parens the source order is kept so
  // standard precedence still applies; with parens the bracket columns make
  // the grouping explicit. Both expand to one row per operation with
  // sequential numbers and a comment on every row.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 1 }),
      routines: [
        {
          name: 'Precedence plain', kind: 'formula', sourcePages: [1], evidenceText: 'Plain precedence.',
          expressionText: 'out_total = alpha_value + beta_value * gamma_value',
        },
        {
          name: 'Precedence grouped', kind: 'formula', sourcePages: [1], evidenceText: 'Grouped precedence.',
          expressionText: 'out_total = (alpha_value + beta_value) * gamma_value',
        },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const plain = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Precedence plain'), strings);
  const grouped = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Precedence grouped'), strings);

  const plainSteps = sectionRows(plain, 'Steps');
  assert.deepEqual(plainSteps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(plainSteps.body.map((row) => row[0]), ['1', '2', '3']);
  assert.deepEqual(plainSteps.body.map((row) => row[2]), ['<--', '+', '*']);
  assert.deepEqual(plainSteps.body.map((row) => row[3]), ['', '', '']);
  assert.deepEqual(plainSteps.body.map((row) => row[5]), ['', '', '']);
  assert.deepEqual(plainSteps.body[0], ['1', 'out_total', '<--', '', 'alpha_value', '', 'Start out_total from alpha_value (source step 1)']);
  assert.match(plainSteps.body[1][6], /beta_value/);
  assert.match(plainSteps.body[2][6], /gamma_value/);

  const groupedSteps = sectionRows(grouped, 'Steps');
  assert.deepEqual(groupedSteps.body.map((row) => row[0]), ['1', '2', '3']);
  assert.deepEqual(groupedSteps.body.map((row) => row[2]), ['<--', '+', '*']);
  assert.deepEqual(groupedSteps.body[0], ['1', 'out_total', '<--', '(', 'alpha_value', '', 'Start out_total from alpha_value (source step 1)']);
  assert.deepEqual(groupedSteps.body[1].slice(0, 6), ['2', '', '+', '', 'beta_value', ')']);
  assert.deepEqual(groupedSteps.body[2].slice(0, 6), ['3', '', '*', '', 'gamma_value', '']);
  for (const section of [plainSteps, groupedSteps]) {
    assert.ok(section.body.every((row) => row.length === 7 && row[6] !== ''));
  }
});

test('excel: condition routines keep the legacy sheet layout with all sections', () => {
  // Underwriting rules are out of scope for the stepwise
  // simplification: a condition routine keeps Inputs, Steps, Final
  // calculation, Conditions, Dependencies, and Source evidence, including
  // the rule that a parenthetical title qualifier never sources an input.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'generic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Schedule Q - Widget rate (annual rate per 1,000 of account_value)', sourcePages: [1], evidenceText: 'Schedule Q (annual rate per 1,000)', headers: ['Widget class', 'Widget rate'], rows: [['W1', '1.10']] },
      ],
      routines: [{
        name: 'Widget review rules',
        kind: 'condition',
        sourcePages: [2],
        evidenceText: 'Widget review rules with a lookup step and a stated formula.',
        expressionText: 'review_score = widget_rate + account_value',
        steps: ['Look up widget_rate using widget_class in Schedule Q.'],
        conditions: ['RULE-7 Widget count exceeds 10 units. Refer'],
        dependsOn: ['Schedule Q'],
        inputs: ['widget_class', 'account_value'],
        outputs: ['review_score'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Widget review rules'), strings);
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.header, ['Input', 'Source', 'Lookup keys']);
  assert.deepEqual(inputs.body, [
    ['widget_class', 'input parameter', ''],
    ['account_value', 'unresolved — verify', ''],
  ]);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Operation', 'Operand', 'Comment']);
  assert.deepEqual(steps.body, [['1', 'Look up widget_rate using widget_class in Schedule Q.', 'lookup', 'widget_class', 'lookup Schedule Q - Widget rate (annual rate per 1,000 of account_value) → widget_rate']]);
  const final = sectionRows(values, 'Final calculation');
  assert.deepEqual(final.body, [['review_score = widget_rate + account_value', 'review_score']]);
  const conds = sectionRows(values, 'Conditions');
  assert.equal(conds.body.length, 1);
  assert.equal(conds.body[0][1], 'RULE-7 Widget count exceeds 10 units. Refer');
  assert.equal(conds.body[0][2], 'Refer');
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [['Schedule Q', 'table', 'explicit', 'widget_rate (keys: widget_class)']]);
  assert.ok(blockRows(values, 'Source evidence') !== null);
});
