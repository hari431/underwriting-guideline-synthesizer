import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbookXlsx, crc32, routineSheetNames, tableSheetNames } from '../src/excel.js';
import { createDocument, createJob, generateParameterizedLookups, generateWorkedExampleLookups, inferTableColumns, normalizeJob } from '../src/models.js';
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
// Empty self-closed <c/> cells decode as '' in column order.
function sheetRowsAsValues(sheetXml, stringsXml) {
  const items = sharedStringItems(stringsXml);
  const rows = [];
  for (const m of sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
    const cells = [...m[2].matchAll(/<c r="[A-Z]+\d+"(?: t="s"(?: s="\d+")?><v>(\d+)<\/v><\/c>|\/>)/g)]
      .map((c) => (c[1] === undefined ? '' : (items[Number(c[1])] ?? '')));
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
  return [...m[1].matchAll(/<c r="[A-Z]+\d+"(?: t="s"(?: s="(\d+)")?><v>\d+<\/v><\/c>|\/>)/g)]
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
    ['1.1', 'base_premium', '<--', '', 'base_rate', '', 'Start base_premium from base_rate (source step 1)'],
    ['1.2', '', '*', '', 'territory_factor', '', 'Apply * territory_factor to continue base_premium from prior step (source step 1)'],
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
  assert.deepEqual(f1steps.body.map((row) => row[0]), ['1', '2', '3.1', '3.2', '4']);
  assert.deepEqual(f1steps.body.map((row) => row[2]), ['<--', '<--', '<--', '+', 'R']);
  assert.deepEqual(f1steps.body[0], ['1', 'base_rate', '<--', '', 'table:Table 1 - Base Rate by Driver Class (driver class)', '', 'Lookup base_rate from Table 1 - Base Rate by Driver Class']);
  assert.deepEqual(f1steps.body[1], ['2', 'territory_factor', '<--', '', 'table:Table 2 - Territory Factor (territory)', '', 'Lookup territory_factor from Table 2 - Territory Factor']);
  assert.deepEqual(f1steps.body[2], ['3.1', 'final_premium', '<--', '', 'base_premium', '', 'uses base_premium from B1 - Base premium formula']);
  assert.deepEqual(f1steps.body[3], ['3.2', '', '+', '', 'policy_fee', '', 'Apply + policy_fee to continue final_premium from prior step (source step 3)']);
  assert.deepEqual(f1steps.body[4], ['4', 'final_premium', 'R', '', 'to the nearest dollar', '', 'Round final_premium (source step 4)']);
  assert.ok(f1steps.body.every((row) => row.length === 7 && row[6] !== ''));
  assert.equal(sectionRows(f1, 'Inputs'), null);
  assert.equal(sectionRows(f1, 'Dependencies'), null);
  assert.equal(sectionRows(f1, 'Final calculation'), null);

  // G1: unfamiliar wording kept verbatim with nothing invented, flagged instead.
  const g1 = byIndex(3);
  assert.deepEqual(sectionRows(g1, 'Steps').body, [['1', 'APPLY legacy_matrix_v2 surcharge curve', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 1)']]);
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
    ['1', 'Step 1: first', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 1)'],
    ['3', 'Step 3: third', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 3)'], // gaps preserved without expansion
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
  assert.deepEqual(steps.body.map((row) => row[0]), ['1.1', '1.2', '2']);
  assert.deepEqual(steps.body[0], ['1.1', 'total', '<--', '', 'shared', '', 'uses shared from Upstream']);
  assert.deepEqual(steps.body[1], ['1.2', '', '+', '', 'fee', '', 'Apply + fee to continue total from prior step (source step 1)']);
  assert.deepEqual(steps.body[2], ['2', 'rate', '<--', '', 'table:Table 9 (K)', '', 'table unresolved — verify']);
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
    ['1.1', 'a', '<--', '', 'b', '', 'Start a from b (source step 1)'],
    ['1.2', '', '+', '', '1', '', 'Apply + 1 to continue a from prior step (source step 1)'],
  ]);
  assert.equal(sectionRows(first, 'Dependencies'), null);
  assert.equal(sectionRows(second, 'Dependencies'), null);
  const firstUnresolved = sectionRows(first, 'Unresolved items');
  assert.ok(firstUnresolved !== null && firstUnresolved.body.length >= 1);
  assert.ok(firstUnresolved.body.some((row) => row[2].includes('Missing Asset')));
  const secondUnresolved = sectionRows(second, 'Unresolved items');
  assert.ok(secondUnresolved !== null && secondUnresolved.body.length === 1);
  assert.ok(secondUnresolved.body[0][2].includes('without an evidenced operation'));
  assert.deepEqual(sectionRows(second, 'Steps').body, [['1', 'Do something', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 1)']]);
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
  const calcUnresolved = sectionRows(calcValues, 'Unresolved items');
  assert.ok(calcUnresolved !== null && calcUnresolved.body.length === 2);
  assert.ok(calcUnresolved.body.some((row) => row[2].includes('without an evidenced operation')));
  assert.ok(calcUnresolved.body.some((row) => row[2].includes('no explicit fallback')));

  // Formula-only routine: the expression expands to one row per operation
  // with the same title/heading/header styling.
  const plainValues = assertRoutineFormatting('Plain', ['Steps', 'Source evidence']);
  assert.deepEqual(sectionRows(plainValues, 'Steps').header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(sectionRows(plainValues, 'Steps').body, [
    ['1.1', 'a', '<--', '', 'b', '', 'Start a from b (source step 1)'],
    ['1.2', '', '*', '', '2', '', 'Apply * 2 to continue a from prior step (source step 1)'],
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
    ['1.1', 'base_premium', '<--', '', 'base_rate', '', 'Start base_premium from base_rate (source step 1)'],
    ['1.2', '', '*', '', 'territory_factor', '', 'Apply * territory_factor to continue base_premium from prior step (source step 1)'],
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
  assert.deepEqual(steps.body[1], ['2.1', 'y', '<--', '', 'x', '', 'uses x from step 1 (Lookup Table)']);
  assert.deepEqual(steps.body[2], ['2.2', '', '*', '', '2', '', 'Apply * 2 to continue y from prior step (source step 2)']);
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
  assert.deepEqual(steps.body[0], ['1.1', 'total', '<--', '', 'shared', '', 'uses shared from Upstream']);
  assert.deepEqual(steps.body[1], ['1.2', '', '+', '', 'fee', '', 'Apply + fee to continue total from prior step (source step 1)']);
  assert.deepEqual(steps.body[2], ['2', 'rate', '<--', '', 'table:Table 9 (K)', '', 'table unresolved — verify']);
  // No separate inventories: the producing routine stays traced in the
  // step comment and the unknown table is flagged in place.
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
  assert.equal(sectionRows(values, 'Final calculation'), null);
  // The upstream formula expands to one row per operation.
  const up = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Upstream'), strings);
  assert.deepEqual(sectionRows(up, 'Steps').body, [
    ['1.1', 'shared', '<--', '', 'base', '', 'Start shared from base (source step 1)'],
    ['1.2', '', '+', '', '1', '', 'Apply + 1 to continue shared from prior step (source step 1)'],
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
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4.1', '4.2', '4.3', '5']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '<--', '×', '×', 'R']);
  assert.deepEqual(stepsSection.body[0], ['1', 'alpha_rate', '<--', '', 'table:Alpha rating table (customer_tier)', '', 'Lookup alpha_rate from Alpha rating table']);
  assert.deepEqual(stepsSection.body[1], ['2', 'beta_factor', '<--', '', 'table:Beta factor table (region_code)', '', 'Lookup beta_factor from Beta factor table']);
  assert.deepEqual(stepsSection.body[2], ['3', 'gamma_factor', '<--', '', 'table:Gamma factor table (account_age)', '', 'Lookup gamma_factor from Gamma factor table']);
  assert.deepEqual(stepsSection.body[3], ['4.1', 'quoted_total', '<--', '', 'alpha_rate', '', 'uses alpha_rate from step 1 (Alpha rating table)']);
  assert.deepEqual(stepsSection.body[4], ['4.2', '', '×', '', 'beta_factor', '', 'uses beta_factor from step 2 (Beta factor table)']);
  assert.deepEqual(stepsSection.body[5], ['4.3', '', '×', '', 'gamma_factor', '', 'uses gamma_factor from step 3 (Gamma factor table)']);
  assert.deepEqual(stepsSection.body[6], ['5', 'quoted_total', 'R', '', 'to the nearest whole currency unit using standard half-up rounding', '', 'Round quoted_total (source step 5)']);
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
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '6.1', '6.2', '6.3', '6.4', '6.5', '7']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '<--', '<--', '/', '×', '×', '×', '×', '', '<--', '', '<--', '', 'R']);
  assert.deepEqual(stepsSection.body[0], ['1', 'base_value', '<--', '', 'table:Index A - Base value (billing_group)', '', 'Lookup base_value from Index A - Base value']);
  assert.deepEqual(stepsSection.body[1], ['2', 'plan_factor', '<--', '', 'table:Index B - Plan factor (plan_code)', '', 'Lookup plan_factor from Index B - Plan factor']);
  assert.deepEqual(stepsSection.body[3], ['4', 'zone_factor', '<--', '', 'table:Index D - Zone factor (zone_code)', '', 'Lookup zone_factor from Index D - Zone factor']);
  // Parenthesized division opens, divides, and closes before the chain of
  // multiplications; each operation keeps its source symbol and order.
  assert.deepEqual(stepsSection.body[4], ['5.1', 'gross_amount', '<--', '(', 'contract_value', '', 'Start gross_amount from contract_value (source step 5)']);
  assert.deepEqual(stepsSection.body[5], ['5.2', '', '/', '', '1000', ')', 'Apply / 1000 to continue gross_amount from prior step (source step 5)']);
  assert.deepEqual(stepsSection.body[6], ['5.3', '', '×', '', 'base_value', '', 'uses base_value from step 1 (Index A - Base value)']);
  assert.deepEqual(stepsSection.body[7], ['5.4', '', '×', '', 'plan_factor', '', 'uses plan_factor from step 2 (Index B - Plan factor)']);
  assert.match(stepsSection.body[8][6], /uses tier_factor from step 3/);
  assert.match(stepsSection.body[9][6], /uses zone_factor from step 4/);
  // The minimum-charge conditional expands to IF/ELSE/ENDIF rows with one
  // assignment row per branch; dependency comments use the hierarchical
  // numbers and trace intermediates to their definition-start row.
  assert.deepEqual(stepsSection.body[10].slice(0, 6), ['6.1', 'IF', '', '', 'gross_amount is below 200', '']);
  assert.match(stepsSection.body[10][6], /uses gross_amount from step 5\.1/);
  assert.deepEqual(stepsSection.body[11], ['6.2', 'net_amount', '<--', '', '200', '', 'Set net_amount to 200 (true branch, source step 6)']);
  assert.deepEqual(stepsSection.body[12].slice(0, 6), ['6.3', 'ELSE', '', '', '', '']);
  assert.deepEqual(stepsSection.body[13].slice(0, 6), ['6.4', 'net_amount', '<--', '', 'gross_amount', '']);
  assert.match(stepsSection.body[13][6], /uses gross_amount from step 5\.1/);
  assert.deepEqual(stepsSection.body[14].slice(0, 6), ['6.5', 'ENDIF', '', '', '', '']);
  assert.deepEqual(stepsSection.body[15].slice(0, 6), ['7', 'billed_amount', 'R', '', 'net_amount to the nearest whole currency unit using half-up rounding', '']);
  assert.match(stepsSection.body[15][6], /uses net_amount from step 6\.4/);
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
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3.1', '3.2', '3.3', '3.4', '4.1', '4.2', '4.3', '4.4', '4.5', '5']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '/', '×', '×', '', '<--', '', '<--', '', 'R']);
  assert.deepEqual(stepsSection.body[0], ['1', 'widget_rate', '<--', '', 'table:Schedule Q - Widget rate (annual rate per 1,000 of account_value) (widget_class)', '', 'Lookup widget_rate from Schedule Q - Widget rate (annual rate per 1,000 of account_value)']);
  assert.deepEqual(stepsSection.body[1], ['2', 'gadget_factor', '<--', '', 'table:Schedule R - Gadget factor (gadget_code)', '', 'Lookup gadget_factor from Schedule R - Gadget factor']);
  assert.deepEqual(stepsSection.body[2], ['3.1', 'gross_total', '<--', '(', 'account_value', '', 'Start gross_total from account_value (source step 3)']);
  assert.deepEqual(stepsSection.body[3], ['3.2', '', '/', '', '1000', ')', 'Apply / 1000 to continue gross_total from prior step (source step 3)']);
  assert.match(stepsSection.body[4][6], /uses widget_rate from step 1/);
  assert.match(stepsSection.body[5][6], /uses gadget_factor from step 2/);
  assert.deepEqual(stepsSection.body[6].slice(0, 6), ['4.1', 'IF', '', '', 'gross_total is below 100', '']);
  assert.match(stepsSection.body[6][6], /uses gross_total from step 3\.1/);
  assert.deepEqual(stepsSection.body[7], ['4.2', 'net_total', '<--', '', '100', '', 'Set net_total to 100 (true branch, source step 4)']);
  assert.deepEqual(stepsSection.body[8].slice(0, 6), ['4.3', 'ELSE', '', '', '', '']);
  assert.match(stepsSection.body[9][6], /uses gross_total from step 3\.1/);
  assert.deepEqual(stepsSection.body[10].slice(0, 6), ['4.5', 'ENDIF', '', '', '', '']);
  assert.deepEqual(stepsSection.body[11].slice(0, 6), ['5', 'billed_total', 'R', '', 'net_total to the nearest whole unit', '']);
  assert.match(stepsSection.body[11][6], /uses net_total from step 4\.4/);
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
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7']);
  assert.deepEqual(stepsSection.body.map((row) => row[1]), ['alpha_total', 'IF', 'band_total', 'ELSEIF', 'band_total', 'ELSE', 'band_total', 'ENDIF']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '', '<--', '', '<--', '', '<--', '']);
  assert.deepEqual(stepsSection.body[1].slice(0, 6), ['2.1', 'IF', '', '', 'alpha_total is below 100', '']);
  assert.deepEqual(stepsSection.body[2], ['2.2', 'band_total', '<--', '', '100', '', 'Set band_total to 100 (true branch, source step 2)']);
  assert.deepEqual(stepsSection.body[3].slice(0, 6), ['2.3', 'ELSEIF', '', '', 'alpha_total is above 500', '']);
  assert.deepEqual(stepsSection.body[4], ['2.4', 'band_total', '<--', '', '500', '', 'Set band_total to 500 (else-if branch, source step 2)']);
  assert.deepEqual(stepsSection.body[5].slice(0, 6), ['2.5', 'ELSE', '', '', '', '']);
  assert.deepEqual(stepsSection.body[6].slice(0, 6), ['2.6', 'band_total', '<--', '', 'alpha_total', '']);
  assert.match(stepsSection.body[6][6], /uses alpha_total from step 1/);
  assert.deepEqual(stepsSection.body[7].slice(0, 6), ['2.7', 'ENDIF', '', '', '', '']);
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
    ['1.1', 'gross_total', '<--', '', 'alpha_value', '', 'Start gross_total from alpha_value (source step 1)'],
    ['1.2', '', '+', '', 'beta_value', '', 'Apply + beta_value to continue gross_total from prior step (source step 1)'],
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
    ['1', '1 First action here.', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 1)'],
    ['3', '3 Third action here.', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 3)'],
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
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3.1', '3.2', '4.1', '4.2', '4.3', '4.4', '4.5']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['<--', '<--', '<--', '+', '', '<--', '', '<--', '']);
  assert.deepEqual(stepsSection.body[0], ['1', 'alpha_value', '<--', '', 'table:Lookup One (alpha_key)', '', 'Lookup alpha_value from Lookup One']);
  assert.deepEqual(stepsSection.body[1], ['2', 'beta_value', '<--', '', 'table:Lookup Two (beta_key)', '', 'Lookup beta_value from Lookup Two']);
  assert.deepEqual(stepsSection.body[2], ['3.1', 'interim_total', '<--', '', 'alpha_value', '', 'uses alpha_value from step 1 (Lookup One)']);
  assert.deepEqual(stepsSection.body[3], ['3.2', '', '+', '', 'beta_value', '', 'uses beta_value from step 2 (Lookup Two)']);
  assert.deepEqual(stepsSection.body[4].slice(0, 6), ['4.1', 'IF', '', '', 'interim_total is below 100', '']);
  assert.equal(stepsSection.body[4][6], 'uses interim_total from step 3.1');
  assert.deepEqual(stepsSection.body[5], ['4.2', 'final_total', '<--', '', '100', '', 'Set final_total to 100 (true branch, source step 4)']);
  assert.deepEqual(stepsSection.body[6].slice(0, 6), ['4.3', 'ELSE', '', '', '', '']);
  assert.match(stepsSection.body[7][6], /uses interim_total from step 3\.1/);
  assert.deepEqual(stepsSection.body[8].slice(0, 6), ['4.5', 'ENDIF', '', '', '', '']);
  assert.ok(stepsSection.body.every((row) => row.length === 7 && row[6] !== ''));
  assert.equal(sectionRows(values, 'Final calculation'), null);
  assert.equal(sectionRows(values, 'Dependencies'), null);
  assert.equal(sectionRows(values, 'Inputs'), null);
});

test('excel: arithmetic expansion preserves parentheses and operator precedence', () => {
  // Generic precedence pair: without parens the source order is kept so
  // standard precedence still applies; with parens the bracket columns make
  // the grouping explicit. Both expand to one row per operation with
  // hierarchical numbers and a comment on every row.
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
  assert.deepEqual(plainSteps.body.map((row) => row[0]), ['1.1', '1.2', '1.3']);
  assert.deepEqual(plainSteps.body.map((row) => row[2]), ['<--', '+', '*']);
  assert.deepEqual(plainSteps.body.map((row) => row[3]), ['', '', '']);
  assert.deepEqual(plainSteps.body.map((row) => row[5]), ['', '', '']);
  assert.deepEqual(plainSteps.body[0], ['1.1', 'out_total', '<--', '', 'alpha_value', '', 'Start out_total from alpha_value (source step 1)']);
  assert.match(plainSteps.body[1][6], /beta_value/);
  assert.match(plainSteps.body[2][6], /gamma_value/);

  const groupedSteps = sectionRows(grouped, 'Steps');
  assert.deepEqual(groupedSteps.body.map((row) => row[0]), ['1.1', '1.2', '1.3']);
  assert.deepEqual(groupedSteps.body.map((row) => row[2]), ['<--', '+', '*']);
  assert.deepEqual(groupedSteps.body[0], ['1.1', 'out_total', '<--', '(', 'alpha_value', '', 'Start out_total from alpha_value (source step 1)']);
  assert.deepEqual(groupedSteps.body[1].slice(0, 6), ['1.2', '', '+', '', 'beta_value', ')']);
  assert.deepEqual(groupedSteps.body[2].slice(0, 6), ['1.3', '', '*', '', 'gamma_value', '']);
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

test('excel: unparsed steps are marked for review while parsed steps render normally', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      tables: [{ name: 'Lookup One', sourcePages: [1], evidenceText: 'ev', headers: ['Key', 'Value'], rows: [['a', '1']] }],
      routines: [{
        name: 'Mixed', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          'Look up alpha_value from Lookup One using alpha_key.',
          'Review the outcome with the team before proceeding.',
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message)));
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Mixed'), strings);
  assert.deepEqual(sectionRows(values, 'Steps').body, [
    ['1', 'alpha_value', '<--', '', 'table:Lookup One (alpha_key)', '', 'Lookup alpha_value from Lookup One'],
    ['2', 'Review the outcome with the team before proceeding.', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 2)'],
  ]);
  // Review marking is deterministic.
  assert.ok(buildWorkbookXlsx(job, { source: 'recorded' }).equals(buildWorkbookXlsx(job, { source: 'recorded' })));
});

test('excel: legacy layout marks steps without operations for review', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      routines: [{
        name: 'Rules', kind: 'condition', sourcePages: [1], evidenceText: 'ev',
        conditions: ['IF alpha_value is high THEN apply factor ELSE refer for review'],
        steps: ['Review the outcome with the team.'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Rules'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Operation', 'Operand', 'Comment']);
  assert.deepEqual(steps.body, [['1', 'Review the outcome with the team.', 'REVIEW', '', 'Needs review — no evidenced operation']]);
});

test('excel: legacy layout shows code-only Instruction for REVIEW steps with evidenced codes', () => {
  const line = 'LX-R1 Ledger rule review Standard bracket Flat Factor 1.000000';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      routines: [{
        name: 'Rules', kind: 'condition', sourcePages: [1], evidenceText: 'ev',
        conditions: ['IF alpha_value is high THEN apply factor ELSE refer for review'],
        steps: [{
          sequence: 1,
          instruction: line,
          cells: { code: 'LX-R1', formula: 'Ledger rule review Standard bracket' },
        }],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].operation, undefined);
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Rules'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.body, [['1', 'LX-R1', 'REVIEW', '', 'Needs review — no evidenced operation']]);
  assert.ok(!steps.body.flat().includes(line));
  const evidence = blockRows(values, 'Source evidence');
  assert.ok(evidence.some((row) => row[0] === 'Step 1 text' && row[1] === line));
});

test('excel: multi-statement formula routine renders one row group per assignment', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      routines: [{
        name: 'Totals',
        kind: 'formula',
        sourcePages: [1],
        evidenceText: 'ev',
        expressionText: 'line_total = price + fee; grand_total = line_total + tax',
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Totals'), strings);
  const steps = sectionRows(values, 'Steps');
  const assignments = steps.body.filter((row) => row[1] !== '' && row[2] === '<--');
  assert.deepEqual(assignments.map((row) => row[1]), ['line_total', 'grand_total']);
  assert.ok(!steps.body.some((row) => row.join(' ').includes('grand_total = line_total')));
});

test('excel: grouped routine sheet preserves source step order and sequences', async () => {
  const { groupStepRoutines } = await import('../src/routine-group.js');
  const members = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      routines: [
        { name: 'PIPE-STEP-01: Base', kind: 'formula', sourcePages: [1], evidenceText: 'ev1', expressionText: 'rate1 = base_rate', inputs: ['base_rate'], outputs: ['rate1'] },
        { name: 'PIPE-STEP-02: Factor', kind: 'formula', sourcePages: [1], evidenceText: 'ev2', expressionText: 'rate2 = rate1 * zone_factor', inputs: ['rate1', 'zone_factor'], outputs: ['rate2'] },
        { name: 'PIPE-STEP-03: Total', kind: 'formula', sourcePages: [1], evidenceText: 'ev3', expressionText: 'total = rate2 + flat_fee', inputs: ['rate2', 'flat_fee'], outputs: ['total'] },
      ],
    })
  ).routines;
  const { routines } = groupStepRoutines(members);
  assert.equal(routines.length, 1);
  const job = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 1 }), routines })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const names = sheetNamesInOrder(workbook);
  const sheet = names.find((n) => n.startsWith('PIPE-STEP-01 to'));
  assert.ok(sheet, 'expected one grouped routine sheet');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, sheet), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.body.map((row) => row[0]), ['1', '2.1', '2.2', '3.1', '3.2']);
  assert.deepEqual(
    steps.body.filter((row) => row[1] !== '').map((row) => row[1]),
    ['rate1', 'rate2', 'total']
  );
});

test('excel: Table Summary shows table aliases for traceability', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      tables: [
        { name: 'SYN-CODE Part A', title: 'Synthetic Widget Multipliers', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
      ],
      routines: [],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Table Summary'), strings);
  assert.equal(values[0][2], 'Aliases');
  assert.equal(values[1][1], 'Synthetic Widget Multipliers');
  assert.equal(values[1][2], 'SYN-CODE Part A');
});

test('excel: multi-word outputs and x multiply expand with chained tracing', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      routines: [{
        name: 'Harbor Fee Pipeline', kind: 'calculation_steps', sourcePages: [1, 2], evidenceText: 'synthetic pipeline',
        steps: [
          { sequence: 1, instruction: 'Base harbor fee', operation: 'expression', expression: 'Harbor base = units * unit_fee', inputs: ['units', 'unit_fee'], output: 'Harbor base' },
          { sequence: 2, instruction: 'Loaded fee', operation: 'expression', expression: 'Harbor loaded = Harbor base x load_factor', inputs: ['Harbor base', 'load_factor'], output: 'Harbor loaded' },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Fee Pipeline'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body, [
    ['1.1', 'Harbor base', '<--', '', 'units', '', 'Start Harbor base from units (source step 1)'],
    ['1.2', '', '*', '', 'unit_fee', '', 'Apply * unit_fee to continue Harbor base from prior step (source step 1)'],
    ['2.1', 'Harbor loaded', '<--', '', 'Harbor base', '', 'uses Harbor base from step 1.1'],
    ['2.2', '', 'x', '', 'load_factor', '', 'Apply x load_factor to continue Harbor loaded from prior step (source step 2)'],
  ]);
});

test('excel: multi-assignment steps render ordered groups; spaced calls stay whole', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Totals', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic totals',
        steps: [
          {
            sequence: 1, operation: 'expression',
            instruction: 'Sum the riders: Harbor riders = HD-R1+HD-R2 Harbor subtotal = Harbor core + Harbor riders',
            expression: 'Harbor subtotal = Harbor core + Harbor riders',
            inputs: ['Harbor core', 'HD-R1', 'HD-R2'], output: 'Harbor subtotal',
          },
          {
            sequence: 2, operation: 'expression',
            instruction: 'Round the average',
            expression: 'Harbor mean = round_half_up ( Harbor subtotal / 2 , 0 )',
            inputs: ['Harbor subtotal'], output: 'Harbor mean',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Totals'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.body, [
    ['1.1', 'Harbor riders', '<--', '', 'HD-R1', '', 'Start Harbor riders from HD-R1 (source step 1)'],
    ['1.2', '', '+', '', 'HD-R2', '', 'Apply + HD-R2 to continue Harbor riders from prior step (source step 1)'],
    ['1.3', 'Harbor subtotal', '<--', '', 'Harbor core', '', 'Start Harbor subtotal from Harbor core (source step 1)'],
    ['1.4', '', '+', '', 'Harbor riders', '', 'uses Harbor riders from step 1.1'],
    ['2', 'Harbor mean', '<--', '', 'round_half_up ( Harbor subtotal / 2 , 0 )', '', 'Assign round_half_up ( Harbor subtotal / 2 , 0 ) to Harbor mean (source step 2)'],
  ]);
});

test('excel: conditional assignment renders IF/ELSE branch rows instead of REVIEW', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Scaling', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic scaling',
        steps: [{
          sequence: 1, operation: 'expression',
          instruction: 'Scale the draft: Harbor scaled = vessel length / 100.0 if tide class in {High, Low} else vessel length',
          expression: 'Harbor scaled = vessel length / 100.0 if tide class in {High, Low} else vessel length',
          inputs: ['vessel length', 'tide class'], output: 'Harbor scaled',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Scaling'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['IF', 'Harbor scaled', '', 'ELSE', 'Harbor scaled', 'ENDIF']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['', '<--', '/', '', '<--', '']);
  assert.equal(steps.body[0][4], 'tide class in {High, Low}');
});

test('excel: comma-joined step output renders its evidenced assignment', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Split Totals', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic split',
        steps: [{
          sequence: 1, operation: 'expression',
          instruction: 'Scale prem rate: Harbor prem = Harbor base x tide factor',
          expression: 'Harbor prem = Harbor base x tide factor',
          inputs: ['Harbor base', 'tide factor'], output: 'Harbor prem, Harbor prod',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Split Totals'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['Harbor prem', '']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', 'x']);
});

test('excel: chained worked arithmetic renders assignment rows instead of REVIEW', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Worked Case', kind: 'worked_example', sourcePages: [1],
        evidenceText: 'synthetic worked illustration with expected values',
        steps: [
          'Ledger total = $12,500 / 100.0 = 125.0000 credits',
          'Alpha net = 3.40 x 1.180 = 4.0120→ 4.012; Alpha gross = 2.10 x 1.050 = 2.2050→ 2.205',
          'Harbor fee net total = 4.012 x 1.500 x 0.960 = 5.77728→ 5.7773; Harbor fee gross total = 2.205 x 1.500 x 0.960 = 3.17520→ 3.1752',
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Worked Case'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['Ledger total', '', 'Ledger total', 'Alpha net', '', 'Alpha gross', '', 'Alpha net', 'Alpha gross', 'Harbor fee net total', '', '', 'Harbor fee gross total', '', '', 'Harbor fee net total', 'Harbor fee gross total']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '/', '=', '<--', 'x', '<--', 'x', '=', '=', '<--', 'x', 'x', '<--', 'x', 'x', '=', '=']);
  const operandIndex = steps.header.indexOf('Operand');
  assert.deepEqual(
    steps.body.filter((row) => row[opIndex] === '=').map((row) => row[operandIndex]),
    ['125.0000 credits', '4.0120', '2.2050', '5.77728', '3.17520']
  );
});

test('excel: yields-clause renders assignment and evaluated rows instead of REVIEW', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Seeded Factor', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic yields',
        steps: ['Fee table (F-1): Seeded=0.040 => (1.000-Seeded)=0.960'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Seeded Factor'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['Seeded', '(1.000 - Seeded)']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '=']);
  const operandIndex = steps.header.indexOf('Operand');
  assert.deepEqual(steps.body.map((row) => row[operandIndex]), ['0.040', '0.960']);
});

test('excel: bare evaluated equality renders one verbatim row while validation flags the target', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Flat Fee', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic flat fee',
        steps: ['Harbor flat total: 2 x $150.00 = $300.00'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(job.issues.some((i) => /without a target variable/.test(i.message)), 'unstated target must warn');
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Flat Fee'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.equal(steps.body.length, 1);
  assert.equal(steps.body[0][1], '2 x $150.00');
  assert.equal(steps.body[0][opIndex], '=');
  assert.equal(steps.body[0][steps.header.indexOf('Operand')], '$300.00');
  assert.ok(/output not stated/.test(steps.body[0][steps.header.indexOf('Line Comment')]), 'row must note the unstated target');
});

test('excel: trailing comparison check renders a comparator row tracing its variable', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Reconciled', kind: 'worked_example', sourcePages: [1],
        evidenceText: 'synthetic worked illustration with a threshold check',
        notes: 'Harbor total=$167.50 (>$100.00)',
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Reconciled'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['Harbor total', 'Harbor total']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '>']);
  assert.equal(steps.body[1][steps.header.indexOf('Operand')], '$100.00');
  assert.ok(
    /uses Harbor total from step 1/.test(steps.body[1][steps.header.indexOf('Line Comment')]),
    `check must trace its variable: ${JSON.stringify(steps.body)}`
  );
});

test('excel: else-if conditional assignment renders ELSEIF rows', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Tiered Scaling', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic tiering',
        steps: [{
          sequence: 1, operation: 'expression',
          instruction: 'Scale the draft: Harbor scaled = vessel length / 100.0 if tide class in {High, Low} else vessel length if tide class = None',
          expression: 'Harbor scaled = vessel length / 100.0 if tide class in {High, Low} else vessel length if tide class = None',
          inputs: ['vessel length', 'tide class'], output: 'Harbor scaled',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Tiered Scaling'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['IF', 'Harbor scaled', '', 'ELSEIF', 'Harbor scaled', 'ENDIF']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['', '<--', '/', '', '<--', '']);
  assert.equal(steps.body[0][4], 'tide class in {High, Low}');
  assert.equal(steps.body[3][4], 'tide class = None');
});

test('excel: condition operation with assignment conditional renders branches', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Waiver Fee', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic waiver',
        steps: [{
          sequence: 2, operation: 'condition',
          instruction: 'Harbor fee is waived unless assessed: Harbor fee = 0.00 if harbor waived else max(100.00, Harbor base x 0.030)',
          expression: 'Harbor fee = 0.00 if harbor waived else max(100.00, Harbor base x 0.030)',
          inputs: ['Harbor base'], output: 'Harbor fee',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Waiver Fee'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['IF', 'Harbor fee', 'ELSE', 'Harbor fee', 'ENDIF']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['', '<--', '', '<--', '']);
  assert.equal(steps.body[0][4], 'harbor waived');
});

test('excel: parenthesized thousands expand arithmetically', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Credibility', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic credibility',
        steps: [{
          sequence: 1, operation: 'expression',
          instruction: 'Harbor net = (12,840 - 15,000) / (250,000 - 15,000)',
          expression: 'Harbor net = (12,840 - 15,000) / (250,000 - 15,000)',
          inputs: [], output: 'Harbor net',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Credibility'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.equal(steps.body[0][1], 'Harbor net');
  assert.equal(steps.body[0][2], '<--');
  const operands = steps.body.map((row) => row[4]).join(' ');
  for (const token of ['12,840', '15,000', '250,000']) {
    assert.ok(operands.includes(token), `operands must keep ${token}: ${operands}`);
  }
});

test('excel: worked stepwise sheets keep the stated inputs section', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Worked Case', kind: 'worked_example', sourcePages: [1],
        evidenceText: 'synthetic worked illustration',
        inputs: ['Harbor base', 'fee code=F-1'], outputs: ['Harbor total'],
        steps: ['Harbor total = $100 / 2 = 50.00 credits'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Worked Case'), strings);
  const idx = values.findIndex((row) => row.length === 1 && row[0] === 'Inputs');
  assert.ok(idx >= 0, 'worked stepwise sheet must keep an Inputs section');
  assert.deepEqual(values[idx + 1], ['Input', 'Source', 'Lookup keys']);
  const names = [];
  for (let i = idx + 2; i < values.length && values[i].length !== 1; i += 1) names.push(values[i][0]);
  assert.deepEqual(names, ['Harbor base', 'fee code=F-1']);
});

test('excel: nested conditional falls back to a verbatim row without review', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Harbor Nested Logic', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'synthetic nesting',
        steps: [{
          sequence: 1, operation: 'expression',
          instruction: 'Harbor fee = base amount if tide high else base amount if tide low else base amount',
          expression: 'Harbor fee = base amount if tide high else base amount if tide low else base amount',
          inputs: ['base amount'], output: 'Harbor fee',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Harbor Nested Logic'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.equal(steps.body.length, 1);
  assert.equal(steps.body[0][1], 'Harbor fee');
  assert.match(steps.body[0][4], /if tide high.*else base amount if tide low/);
});

test('excel: blank summary metadata writes empty cells, never shared-string numeric lookalikes', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [{
        name: 'Ledger Tariff', sourcePages: [1], evidenceText: 'ev',
        headers: ['Ledger Code'], rows: [['LXV'], ['LXW'], ['LXX']],
      }],
      routines: [{
        name: 'Ledger Calc', kind: 'formula', sourcePages: [1],
        evidenceText: 'ev', expressionText: 'tallage = base * 2',
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const tableXml = sheetXmlByName(zip, workbook, 'Table Summary');
  // Purpose (D), Applicability (E), Notes (K), Review status (O) are empty:
  // the XML must carry empty cells, not shared-string references that read
  // as literal numbers without shared-string resolution.
  for (const ref of ['D2', 'E2', 'K2', 'O2']) {
    assert.ok(tableXml.includes(`<c r="${ref}"/>`), `expected empty cell ${ref}`);
    assert.ok(!tableXml.includes(`<c r="${ref}" t=`), `blank ${ref} must not reference a shared string`);
  }
  const values = sheetRowsAsValues(tableXml, strings);
  assert.equal(values[1][3], '');
  assert.equal(values[1][14], '');
  assert.equal(values[1][12], '3');
  assert.equal(values[1][13], '1');
  const routineXml = sheetXmlByName(zip, workbook, 'Routine Summary');
  for (const ref of ['D2', 'E2', 'M2', 'N2']) {
    assert.ok(routineXml.includes(`<c r="${ref}"/>`), `expected empty cell ${ref}`);
  }
  const routineValues = sheetRowsAsValues(routineXml, strings);
  assert.equal(routineValues[1][12], '');
});

test('excel: genuine numeric metadata still exports as its own value', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [{
        name: 'Ledger Tariff', sourcePages: [1], evidenceText: 'ev',
        headers: ['Ledger Code'], rows: [['LXV']],
        purpose: '3', notes: '3 ledgers reviewed',
      }],
      routines: [],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Table Summary'), strings);
  assert.equal(values[1][3], '3');
  assert.equal(values[1][10], '3 ledgers reviewed');
});

test('excel: worked inputs resolve via header prefixes and cell codes', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [
        {
          name: 'Table L. Base Tallage by Ledger Class', sourcePages: [1], evidenceText: 'ev',
          headers: ['Ledger class code', 'Ledger class', 'Base tallage'],
          rows: [['LKV', 'Harbor Skiff', '800.00']],
        },
        {
          name: 'Table Z. Zone Factors', sourcePages: [1], evidenceText: 'ev',
          headers: ['Zone code', 'Zone narrative', 'Factor'],
          rows: [['ZSH', 'Suburban Harbor', '1.00']],
        },
        {
          name: 'Table T. Tenure Factors', sourcePages: [1], evidenceText: 'ev',
          headers: ['Tenure band', 'Definition', 'Factor'],
          rows: [['TNX-3', '4 or more years', '0.90']],
        },
        {
          name: 'Tally rule', sourcePages: [1], evidenceText: 'ev',
          headers: ['Policy ledger count', 'Tally rate'],
          rows: [['1 to 2', '0%'], ['3 to 10', '5%']],
        },
      ],
      routines: [{
        name: 'Ledger Worked Case', kind: 'worked_example', sourcePages: [1],
        evidenceText: 'synthetic worked illustration with expected values',
        dependsOn: [
          'Table L. Base Tallage by Ledger Class', 'Table Z. Zone Factors',
          'Table T. Tenure Factors', 'Tally rule',
        ],
        inputs: [
          'Ledger class Harbor Skiff LKV',
          'Zone Suburban Harbor ZSH',
          'Tenure 4 completed years TNX-3',
          'Policy ledger count 4 ledgers',
          'Mystery factor XQZ',
        ],
        outputs: ['$1.00 per ledger'],
        steps: [{ sequence: 1, instruction: '1. Base tallage', expression: 'Selected tallage for LKV', output: '$800.00' }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Worked Case'), strings);
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.header, ['Input', 'Source', 'Lookup keys']);
  const byInput = new Map(inputs.body.map((row) => [row[0], row[1]]));
  assert.equal(byInput.get('Ledger class Harbor Skiff LKV'), 'Table L. Base Tallage by Ledger Class');
  assert.equal(byInput.get('Zone Suburban Harbor ZSH'), 'Table Z. Zone Factors');
  assert.equal(byInput.get('Tenure 4 completed years TNX-3'), 'Table T. Tenure Factors');
  assert.equal(byInput.get('Policy ledger count 4 ledgers'), 'Tally rule');
  assert.equal(byInput.get('Mystery factor XQZ'), 'unresolved — verify');
});

test('excel: input codes shared by two tables stay unresolved', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [
        {
          name: 'Table A. Harbor Tallage', sourcePages: [1], evidenceText: 'ev',
          headers: ['Harbor code', 'Tallage'], rows: [['QZX', '10.00']],
        },
        {
          name: 'Table B. Inland Tallage', sourcePages: [1], evidenceText: 'ev',
          headers: ['Inland code', 'Tallage'], rows: [['QZX', '12.00']],
        },
      ],
      routines: [{
        name: 'Ledger Worked Case', kind: 'worked_example', sourcePages: [1],
        evidenceText: 'synthetic worked illustration with expected values',
        dependsOn: ['Table A. Harbor Tallage', 'Table B. Inland Tallage'],
        inputs: ['Harbor note QZX'],
        outputs: ['$1.00 per ledger'],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Worked Case'), strings);
  const inputs = sectionRows(values, 'Inputs');
  assert.equal(inputs.body[0][0], 'Harbor note QZX');
  assert.equal(inputs.body[0][1], 'unresolved — verify');
});

test('excel: same-subject sequential branches chain as IF/ELSEIF/ENDIF without invented else', () => {
  // A condition step stating two IF branches that assign the same subject
  // (no ELSE anywhere) renders one IF/ELSEIF/ENDIF chain in source order.
  // The structured expression carries only a branch fragment, so the clause
  // comes from the instruction; the explicit output is preserved on both
  // branch rows and no fallback is invented.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with two discount branches',
        conditions: [
          'If the policy covers 3 to 10 ledgers, the discount is 5% of the pre-discount tallage.',
          'If the policy covers 1 or 2 ledgers, the discount is 0%.',
        ],
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Tally discount: If the policy covers 3 to 10 ledgers, the discount is 5% of the pre-discount tallage. If the policy covers 1 or 2 ledgers, the discount is 0%.',
          operation: 'condition',
          expression: '5% of the pre-discount tallage',
          inputs: ['pre-discount tallage', 'Policy ledger count'],
          output: 'tally discount',
        }],
      }],
    })
  );
  for (const det of job.routines[0].conditions_detailed) {
    assert.equal(String(det.false_branch ?? ''), '');
  }
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  const instructions = steps.body.map((row) => row[1]);
  assert.deepEqual(instructions.filter((v) => v === 'IF').length, 1);
  assert.deepEqual(instructions.filter((v) => v === 'ELSEIF').length, 1);
  assert.deepEqual(instructions.filter((v) => v === 'ENDIF').length, 1);
  assert.ok(!instructions.includes('ELSE'), `invented ELSE row: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[0]), ['6.1', '6.2', '6.3', '6.4', '6.5']);
  assert.deepEqual(steps.body[0].slice(0, 6), ['6.1', 'IF', '', '', 'the policy covers 3 to 10 ledgers', '']);
  assert.deepEqual(steps.body[2].slice(0, 6), ['6.3', 'ELSEIF', '', '', 'the policy covers 1 or 2 ledgers', '']);
  assert.deepEqual(steps.body[4].slice(0, 6), ['6.5', 'ENDIF', '', '', '', '']);
  assert.ok(steps.body.some((row) => row[1] === 'tally discount' && String(row[4]).includes('5%')));
  assert.ok(steps.body.some((row) => row[1] === 'tally discount' && String(row[4]).includes('0%')));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: independent sequential branches keep separate IF groups', () => {
  // Sequential IF branches assigning different subjects are independent
  // conditions, not alternatives: each keeps its own IF/ENDIF group in
  // source order with no ELSEIF chaining and no ELSE invented.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with independent branches',
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Ledger checks: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the ledger is coastal, the surcharge is 2%.',
          operation: 'condition',
          expression: 'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the ledger is coastal, the surcharge is 2%.',
          output: 'ledger checks',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  const instructions = steps.body.map((row) => row[1]);
  assert.deepEqual(instructions.filter((v) => v === 'IF').length, 2);
  assert.deepEqual(instructions.filter((v) => v === 'ENDIF').length, 2);
  assert.ok(!instructions.includes('ELSEIF'), `invented ELSEIF row: ${JSON.stringify(steps.body)}`);
  assert.ok(!instructions.includes('ELSE'), `invented ELSE row: ${JSON.stringify(steps.body)}`);
  const operands = steps.body.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 3 to 10 ledgers'));
  assert.ok(operands.includes('the ledger is coastal'));
  assert.ok(operands.includes('5% of the pre-rebate tallage'));
  assert.ok(operands.includes('2%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});
test('excel: overlapping same-subject branches keep separate IF groups', () => {
  // Same assigned subject is not enough to chain: overlapping ranges may
  // both apply, so each branch keeps its own IF/ENDIF group in source
  // order with no ELSEIF chaining and no ELSE invented.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with overlapping branches',
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Ledger rebate bands: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 5 to 12 ledgers, the rebate is 2%.',
          operation: 'condition',
          expression: 'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 5 to 12 ledgers, the rebate is 2%.',
          output: 'ledger rebate',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  const instructions = steps.body.map((row) => row[1]);
  assert.deepEqual(instructions.filter((v) => v === 'IF').length, 2);
  assert.deepEqual(instructions.filter((v) => v === 'ENDIF').length, 2);
  assert.ok(!instructions.includes('ELSEIF'), `invented ELSEIF row: ${JSON.stringify(steps.body)}`);
  assert.ok(!instructions.includes('ELSE'), `invented ELSE row: ${JSON.stringify(steps.body)}`);
  const operands = steps.body.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 3 to 10 ledgers'));
  assert.ok(operands.includes('the policy covers 5 to 12 ledgers'));
  assert.ok(operands.includes('5% of the pre-rebate tallage'));
  assert.ok(operands.includes('2%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});
test('excel: explicit three-branch chain keeps source order without invented else', () => {
  // A source-stated IF/ELSEIF/ELSEIF chain (three condition branches, no
  // ELSE anywhere) renders every stage in source order with the step's
  // descriptive output on each branch row; no fallback is invented.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with three rebate bands',
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Ledger rebate: If the policy covers 1 or 2 ledgers, the rebate is 0%; else if the policy covers 3 to 5 ledgers, the rebate is 3%; else if the policy covers 6 to 10 ledgers, the rebate is 5%.',
        }],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].output, 'Ledger rebate');
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['IF', 'Ledger rebate', 'ELSEIF', 'Ledger rebate', 'ELSEIF', 'Ledger rebate', 'ENDIF']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.7']);
  const operands = steps.body.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 1 or 2 ledgers'));
  assert.ok(operands.includes('the policy covers 3 to 5 ledgers'));
  assert.ok(operands.includes('the policy covers 6 to 10 ledgers'));
  assert.ok(operands.includes('0%'));
  assert.ok(operands.includes('3%'));
  assert.ok(operands.includes('5%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: explicit ELSE branch is preserved verbatim in source order', () => {
  // A source-stated IF/OTHERWISE sentence keeps its false branch verbatim
  // in an ELSE row; conditions, values, and order are preserved exactly.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with a stated fallback',
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Ledger rebate: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage; otherwise the rebate is 0%.',
        }],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].output, 'Ledger rebate');
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['IF', 'Ledger rebate', 'ELSE', 'Ledger rebate', 'ENDIF']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['6.1', '6.2', '6.3', '6.4', '6.5']);
  const operands = steps.body.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 3 to 10 ledgers'));
  assert.ok(operands.includes('5% of the pre-rebate tallage'));
  assert.ok(operands.includes('0%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: sequential chain with a stated ELSE stays split with the ELSE intact', () => {
  // Two same-subject branches over disjoint ranges would chain — except
  // the first carries its own stated ELSE. Restructuring would corrupt the
  // fallback, so each branch keeps its own group with the stated ELSE
  // preserved verbatim.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with a stated fallback plus a second band',
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Ledger rebate bands: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. Otherwise the rebate is 1%. If the policy covers 1 or 2 ledgers, the rebate is 0%.',
          operation: 'condition',
          expression: 'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. Otherwise the rebate is 1%. If the policy covers 1 or 2 ledgers, the rebate is 0%.',
          output: 'ledger rebate',
        }],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[1]), ['IF', 'ledger rebate', 'ELSE', 'ledger rebate', 'ENDIF', 'IF', 'ledger rebate', 'ENDIF']);
  const operands = steps.body.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 3 to 10 ledgers'));
  assert.ok(operands.includes('the policy covers 1 or 2 ledgers'));
  assert.ok(operands.includes('5% of the pre-rebate tallage'));
  assert.ok(operands.includes('1%'));
  assert.ok(operands.includes('0%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: chained branch values reuse the producing step display name', () => {
  // Step 5 produces `Pre-rebate tallage`; the merged chain percent-of
  // branch reuses that display name in its operand while the valueless
  // branch and both conditions stay verbatim.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with a produced tallage and rebate chain',
        steps: [
          { sequence: 5, instruction: 'Step 5 — Pre-rebate tallage: Multiply the adjusted tallage by the tally factor.' },
          { sequence: 6, instruction: 'Step 6 — Ledger rebate: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 1 or 2 ledgers, the rebate is 0%.' },
        ],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].output, 'Pre-rebate tallage');
  assert.equal(job.routines[0].steps_detailed[1].output, 'Ledger rebate');
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  const chain = steps.body.filter((row) => String(row[0] ?? '').startsWith('6.'));
  assert.deepEqual(chain.map((row) => row[1]), ['IF', 'Ledger rebate', 'ELSEIF', 'Ledger rebate', 'ENDIF']);
  const operands = chain.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 3 to 10 ledgers'));
  assert.ok(operands.includes('the policy covers 1 or 2 ledgers'));
  assert.ok(operands.includes('5% of the Pre-rebate tallage'));
  assert.ok(operands.includes('0%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});

test('excel: factor without a producing lookup traces to its table with a keys caveat', () => {
  // Step 2 uses `territory factor` and names Table 2, but no lookup step
  // selects it: the using row traces the evidenced table and flags the
  // missing lookup keys instead of falling back silently.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Table 1. Base Tallages by Ledger Class', sourcePages: [1], evidenceText: 'base tallage schedule', headers: ['Ledger class', 'Base tallage'], rows: [['A', '800']] },
        { name: 'Table 2. Territory Tallage Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
      ],
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        steps: [
          'Step 1 — Base tallage: Select the base tallage for the ledger class from Table 1.',
          { sequence: 2, instruction: 'Step 2 — Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling', depends_on: ['Table 2'] },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const factorRow = steps.body.find((row) => row[4] === 'territory factor');
  assert.ok(factorRow, `missing factor row: ${JSON.stringify(steps.body)}`);
  assert.match(factorRow[6], /uses territory factor from Table 2\. Territory Tallage Factors \(lookup keys not stated — verify\)/);
});

test('excel: lookup-produced factor traces to its lookup step', () => {
  // The same factor selected by an explicit lookup step traces to that
  // lookup with no keys caveat.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Table 1. Base Tallages by Ledger Class', sourcePages: [1], evidenceText: 'base tallage schedule', headers: ['Ledger class', 'Base tallage'], rows: [['A', '800']] },
        { name: 'Table 2. Territory Tallage Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
      ],
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        steps: [
          'Step 1 — Base tallage: Select the base tallage for the ledger class from Table 1.',
          { sequence: 2, instruction: 'Step 2 — Territory factor: Look up the territory factor for the territory code from Table 2.', operation: 'lookup', inputs: ['territory code'], output: 'territory factor', depends_on: ['Table 2'] },
          { sequence: 3, instruction: 'Step 3 — Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling', depends_on: ['Table 2'] },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const factorRow = steps.body.find((row) => row[4] === 'territory factor');
  assert.ok(factorRow, `missing factor row: ${JSON.stringify(steps.body)}`);
  assert.match(factorRow[6], /uses territory factor from step 2/);
  assert.doesNotMatch(factorRow[6], /lookup keys not stated/);
});

test('excel: rounding row keeps its stated target in the operand', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tallage Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tallage procedure with rounding',
        steps: [{
          sequence: 8,
          instruction: 'Step 8 — Tallage rounding: Round only the final tallage to two decimal places using standard round-half-up rounding. Do not round intermediate calculations.',
          operation: 'round',
          expression: 'RoundHalfUp(final tallage, 2)',
          inputs: ['final tallage'],
          output: 'final annual tallage per ledger',
        }],
        inputs: ['final tallage'],
        outputs: ['final annual tallage per ledger'],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].operand, 'final tallage');
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tallage Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['8', 'final annual tallage per ledger', 'R', '', 'final tallage', '']);
  assert.notEqual(steps.body[0][6], '');
});

test('excel: worked inputs keep selected values with evidenced keys and transitive sources', () => {
  // The worked case depends on the rating procedure rather than every table
  // directly; the ledger-count input still resolves through the procedure's
  // tables. Selected values stay in the Input column and evidenced lookup
  // keys populate; the range-band selection keeps blank keys and the mystery
  // input stays unresolved.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [
        {
          name: 'Table L. Base Tallage by Ledger Class', sourcePages: [1], evidenceText: 'ev',
          headers: ['Ledger class code', 'Ledger class', 'Base tallage'],
          rows: [['LKV', 'Harbor Skiff', '800.00']],
        },
        {
          name: 'Table Z. Zone Factors', sourcePages: [1], evidenceText: 'ev',
          headers: ['Zone code', 'Zone narrative', 'Factor'],
          rows: [['ZSH', 'Suburban Harbor', '1.00']],
        },
        {
          name: 'Table T. Tenure Factors', sourcePages: [1], evidenceText: 'ev',
          headers: ['Tenure band', 'Definition', 'Factor'],
          rows: [['TNX-3', '4 or more years', '0.90']],
        },
        {
          name: 'Table M. Tally Limit Factors', sourcePages: [1], evidenceText: 'ev',
          headers: ['Tally limit', 'Factor'],
          rows: [['$500,000', '1.00'], ['$1,000,000', '1.25']],
        },
        {
          name: 'Table D. Tally Deductible Factors', sourcePages: [1], evidenceText: 'ev',
          headers: ['Tally deductible', 'Factor'],
          rows: [['$0', '1.00'], ['$500', '0.95']],
        },
        {
          name: 'Tally rule', sourcePages: [1], evidenceText: 'ev',
          headers: ['Policy ledger count', 'Tally rate'],
          rows: [['1 to 2', '0%'], ['3 to 10', '5%']],
        },
      ],
      routines: [
        {
          name: 'Ledger Rating Procedure', kind: 'formula', sourcePages: [1],
          evidenceText: 'synthetic rating procedure',
          expressionText: 'tallage = base * factor',
          dependsOn: [
            'Table L. Base Tallage by Ledger Class', 'Table Z. Zone Factors',
            'Table T. Tenure Factors', 'Table M. Tally Limit Factors',
            'Table D. Tally Deductible Factors', 'Tally rule',
          ],
          inputs: ['base', 'factor'],
        },
        {
          name: 'Ledger Worked Case', kind: 'worked_example', sourcePages: [1],
          evidenceText: 'synthetic worked illustration with expected values',
          dependsOn: [
            'Table L. Base Tallage by Ledger Class', 'Table Z. Zone Factors',
            'Table T. Tenure Factors', 'Table M. Tally Limit Factors',
            'Table D. Tally Deductible Factors', 'Ledger Rating Procedure',
          ],
          inputs: [
            'Ledger class Harbor Skiff (LKV)',
            'Zone Suburban Harbor (ZSH)',
            'Tenure 4 completed years (TNX-3)',
            'Tally limit $1,000,000',
            'Tally deductible $500',
            'Policy ledger count 4 ledgers',
            'Mystery factor XQZ',
          ],
          outputs: ['$1.00 per ledger'],
          steps: [{ sequence: 1, instruction: '1. Base tallage', expression: 'Selected tallage for LKV', output: '$800.00' }],
        },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Worked Case'), strings);
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.header, ['Input', 'Source', 'Lookup keys']);
  const byInput = new Map(inputs.body.map((row) => [row[0], row]));
  assert.deepEqual(byInput.get('Ledger class Harbor Skiff (LKV)').slice(1), ['Table L. Base Tallage by Ledger Class', 'Harbor Skiff (LKV)']);
  assert.deepEqual(byInput.get('Zone Suburban Harbor (ZSH)').slice(1), ['Table Z. Zone Factors', 'ZSH']);
  assert.deepEqual(byInput.get('Tenure 4 completed years (TNX-3)').slice(1), ['Table T. Tenure Factors', 'TNX-3']);
  assert.deepEqual(byInput.get('Tally limit $1,000,000').slice(1), ['Table M. Tally Limit Factors', '$1,000,000']);
  assert.deepEqual(byInput.get('Tally deductible $500').slice(1), ['Table D. Tally Deductible Factors', '$500']);
  assert.deepEqual(byInput.get('Policy ledger count 4 ledgers').slice(1), ['Tally rule', '']);
  assert.deepEqual(byInput.get('Mystery factor XQZ').slice(1), ['unresolved — verify', '']);
});

test('excel: stated-value branches share one descriptive output in an IF/ELSEIF chain', () => {
  // Live shape: a condition step with no explicit output whose branches
  // state `<subject> is <value>` for the same subject. Both branches carry
  // the step's descriptive label as their output in one IF/ELSEIF/ENDIF
  // chain, in source order, with no ELSE invented. Routine-level condition
  // rows keep their own bare-subject outputs; only the step output — the
  // one later steps reference — takes the descriptive label.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with two rebate branches',
        conditions: [
          'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage.',
          'If the policy covers 1 or 2 ledgers, the rebate is 0%.',
        ],
        steps: [{
          sequence: 6,
          instruction: 'Step 6 — Ledger rebate: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 1 or 2 ledgers, the rebate is 0%.',
        }],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].output, 'Ledger rebate');
  assert.equal(job.routines[0].conditions_detailed[0].output, 'rebate');
  assert.equal(job.routines[0].conditions_detailed[1].output, 'rebate');
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  const instructions = steps.body.map((row) => row[1]);
  assert.deepEqual(instructions.filter((v) => v === 'IF').length, 1);
  assert.deepEqual(instructions.filter((v) => v === 'ELSEIF').length, 1);
  assert.deepEqual(instructions.filter((v) => v === 'ENDIF').length, 1);
  assert.ok(!instructions.includes('ELSE'), `invented ELSE row: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[0]), ['6.1', '6.2', '6.3', '6.4', '6.5']);
  const operands = steps.body.map((row) => row[4]);
  assert.ok(operands.includes('the policy covers 3 to 10 ledgers'));
  assert.ok(operands.includes('the policy covers 1 or 2 ledgers'));
  assert.ok(steps.body.some((row) => row[1] === 'Ledger rebate' && row[2] === '<--' && row[4] === '5% of the pre-rebate tallage'));
  assert.ok(steps.body.some((row) => row[1] === 'Ledger rebate' && row[2] === '<--' && row[4] === '0%'));
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
  const conds = sectionRows(values, 'Conditions');
  assert.deepEqual(conds.body[0].slice(0, 3), ['1', 'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage.', 'the rebate is 5% of the pre-rebate tallage.']);
  assert.deepEqual(conds.body[1].slice(0, 3), ['2', 'If the policy covers 1 or 2 ledgers, the rebate is 0%.', 'the rebate is 0%.']);
});

test('excel: later step subtracting the branch value traces to the chained branches', () => {
  // The step after a same-subject branch chain subtracts the branch value
  // by its descriptive name: the subtraction operand traces back to the
  // branch rows, proving one consistent name across branches and use.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      routines: [{
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [1],
        evidenceText: 'synthetic tally procedure with rebate chain and subtraction',
        steps: [
          { sequence: 6, instruction: 'Step 6 — Ledger rebate: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 1 or 2 ledgers, the rebate is 0%.' },
          { sequence: 7, instruction: 'Step 7 — Final tallage: Subtract the ledger rebate from the pre-rebate tallage.' },
        ],
      }],
    })
  );
  assert.equal(job.routines[0].steps_detailed[0].output, 'Ledger rebate');
  assert.deepEqual(job.routines[0].steps_detailed[1].inputs, ['pre-rebate tallage', 'Ledger rebate']);
  assert.equal(job.routines[0].steps_detailed[1].expression, 'pre-rebate tallage - Ledger rebate');
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Ledger Tally Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const bySeq = new Map(steps.body.map((row) => [row[0], row]));
  assert.deepEqual(bySeq.get('6.2').slice(0, 6), ['6.2', 'Ledger rebate', '<--', '', '5% of the pre-rebate tallage', '']);
  assert.deepEqual(bySeq.get('6.4').slice(0, 6), ['6.4', 'Ledger rebate', '<--', '', '0%', '']);
  assert.equal(bySeq.get('7.2')[2], '-');
  assert.equal(bySeq.get('7.2')[4], 'Ledger rebate');
  assert.match(bySeq.get('7.2')[6], /uses Ledger rebate from step 6\.4/);
});

test('excel: generated parameterized lookup renders as a lookup row with prior-step trace', () => {
  // A generated lookup renders like an explicit one: `factor <-- table`
  // with the bound key, and downstream uses trace to the prior step with
  // no missing-keys caveat.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Schedule S. Cover Factors', sourcePages: [1], evidenceText: 'cover factor schedule', headers: ['Cover code', 'Factor'], rows: [['C1', '1.10']] },
      ],
      routines: [{
        name: 'Cover Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        inputs: ['Cover'],
        steps: [
          'Step 1 \u2014 Base amount: Select the base amount for the ledger class from Schedule B.',
          'Step 2 \u2014 Adjusted amount: Multiply the base amount by the cover factor from Schedule S.',
        ],
        steps_detailed: [
          { instruction: 'Step 1 \u2014 Base amount: Select the base amount for the ledger class from Schedule B.', operation: 'lookup', inputs: ['ledger class'], output: 'Base amount', depends_on: ['Schedule B'], evidence: 'Select the base amount for the ledger class from Schedule B.', source_pages: [2] },
          { instruction: 'Step 2 \u2014 Adjusted amount: Multiply the base amount by the cover factor from Schedule S.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount', depends_on: ['Schedule S'], evidence: 'Multiply the base amount by the cover factor from Schedule S.', source_pages: [2] },
        ],
      }],
    })
  );
  assert.equal(generateParameterizedLookups(job.routines[0], job.tables, job.routines), 1);
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Cover Rating Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const lookupRow = steps.body.find((row) => row[1] === 'cover factor' && row[2] === '<--');
  assert.ok(lookupRow, `missing generated lookup row: ${JSON.stringify(steps.body)}`);
  assert.equal(lookupRow[4], 'table:Schedule S. Cover Factors (Cover)');
  const factorRow = steps.body.find((row) => row[4] === 'cover factor');
  assert.ok(factorRow, `missing factor use row: ${JSON.stringify(steps.body)}`);
  assert.match(factorRow[6], /uses cover factor from step 2 \(Schedule S\. Cover Factors\)/);
  assert.doesNotMatch(factorRow[6], /lookup keys not stated/);
  assert.ok(steps.body.every((row) => row[2] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
});

test('excel: factor without step mentions traces to its table through routine fallback', () => {
  // Latest live-extraction shape: no step-level depends_on, routine names
  // the tables. The using row traces the evidenced table with the keys
  // caveat instead of dropping the trace silently.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
      ],
      routines: [{
        name: 'Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        dependsOn: ['Table 2. Territory Factors'],
        steps: [
          { sequence: 2, instruction: 'Step 2 \u2014 Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * Territory factor', inputs: ['Base tallage', 'Territory factor'], output: 'Zone scaling' },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Rating Procedure'), strings);
  const steps = sectionRows(values, 'Steps');
  const factorRow = steps.body.find((row) => row[4] === 'Territory factor');
  assert.ok(factorRow, `missing factor row: ${JSON.stringify(steps.body)}`);
  assert.match(factorRow[6], /uses Territory factor from Table 2\. Territory Factors \(lookup keys not stated \u2014 verify\)/);
});

test('excel: op-bearing worked steps render calculations with stated results', () => {
  // Latest live-extraction shape: explicit model operations with literal
  // worked values. Each step renders its output, operands, and stated
  // result — never REVIEW.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [],
      routines: [{
        name: 'Worked Example', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
        steps: [
          { sequence: 2, instruction: '2. Territory adjustment: $1,050.00 \u00d7 1.00', operation: 'multiply', expression: '$1,050.00 \u00d7 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '2. Territory adjustment', calculation: '$1,050.00 \u00d7 1.00', result: '$1,050.00' } },
          { sequence: 7, instruction: '7. Final before rounding: $1,122.1875 - $56.109375', operation: 'subtract', expression: '$1,122.1875 - $56.109375', inputs: ['$1,122.1875', '$56.109375'], output: '$1,066.078125', cells: { step: '7. Final before rounding', calculation: '$1,122.1875 - $56.109375', result: '$1,066.078125' } },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Worked Example'), strings);
  const steps = sectionRows(values, 'Steps');
  assert.ok(steps.body.length > 0, 'missing Steps section');
  assert.ok(steps.body.every((row) => row[2] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  const stated = steps.body.filter((row) => row[2] === '=');
  assert.deepEqual(stated.map((row) => [row[1], row[4]]), [['Territory adjustment', '$1,050.00'], ['Final before rounding', '$1,066.078125']]);
  const operands = new Set(steps.body.map((row) => row[4]));
  for (const want of ['$1,050.00', '1.00', '$1,122.1875', '$56.109375']) {
    assert.ok(operands.has(want), `missing operand ${want}: ${JSON.stringify(steps.body)}`);
  }
});

test('excel: rounding row shows the linked preceding output as operand', () => {
  // The rounding call names a value a preceding step states: the R row
  // carries that step's output as its operand instead of a blank cell.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 1 }),
      tables: [],
      routines: [{
        name: 'Worked Example', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
        steps: [
          { sequence: 7, instruction: '7. Final before rounding: $1,122.1875 - $56.109375', operation: 'subtract', expression: '$1,122.1875 - $56.109375', inputs: ['$1,122.1875', '$56.109375'], output: '$1,066.078125', cells: { step: '7. Final before rounding', calculation: '$1,122.1875 - $56.109375', result: '$1,066.078125' } },
          { sequence: 8, instruction: '8. Final annual premium: RoundHalfUp($1,066.078125, 2)', operation: 'round', expression: 'RoundHalfUp($1,066.078125, 2)', inputs: ['$1,066.078125'], output: '$1,066.08', cells: { step: '8. Final annual premium', calculation: 'RoundHalfUp($1,066.078125, 2)', result: '$1,066.08' } },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Worked Example'), strings);
  const steps = sectionRows(values, 'Steps');
  const roundRow = steps.body.find((row) => row[1] === 'Final annual premium' && row[2] === 'R');
  assert.ok(roundRow, `missing rounding row: ${JSON.stringify(steps.body)}`);
  assert.equal(roundRow[4], 'Final before rounding');
  assert.ok(steps.body.every((row) => row[2] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
});

test('excel: generated worked lookups render lookup and assigned-factor rows', () => {
  // The Worked Example chain reads Input -> lookup -> assigned factor ->
  // calculation: the lookup row names the table and key, and the stated
  // row carries the selected factor into the calculation below.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00'], ['URB', 'Urban core', '1.20']] },
      ],
      routines: [{
        name: 'Worked Example', kind: 'worked_example', sourcePages: [2], evidenceText: 'e',
        inputs: ['Territory: Suburban (SUB)'],
        outputs: ['Adjusted total: $1,050.00'],
        steps: [
          { sequence: 1, instruction: '1. Territory adjustment: $1,050.00 * 1.00', operation: 'multiply', expression: '$1,050.00 * 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '1. Territory adjustment', calculation: '$1,050.00 * 1.00', result: '$1,050.00' } },
        ],
      }],
    })
  );
  for (const t of job.tables) t.columns = inferTableColumns(t);
  assert.equal(generateWorkedExampleLookups(job.routines[0], job.tables), 1);
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Worked Example'), strings);
  const steps = sectionRows(values, 'Steps');
  const lookupRow = steps.body.find((row) => row[1] === 'Territory factor' && row[2] === '<--');
  assert.ok(lookupRow, `missing generated lookup row: ${JSON.stringify(steps.body)}`);
  assert.equal(lookupRow[4], 'table:Table 2. Territory Factors (SUB)');
  const statedRow = steps.body.find((row) => row[1] === 'Territory factor' && row[2] === '=');
  assert.ok(statedRow, `missing assigned-factor row: ${JSON.stringify(steps.body)}`);
  assert.equal(statedRow[4], '1.00');
  assert.ok(steps.body.every((row) => row[2] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
});

test('excel: generated lookup rows take letter-suffixed numbers and attribution', () => {
  // The lookup inserted between source steps 1 and 2 numbers as 1b and
  // attributes to (source step 1b): no collisions, no misattribution.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'synthetic.pdf', pageCount: 2 }),
      tables: [
        { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00'], ['URB', 'Urban core', '1.20']] },
      ],
      routines: [{
        name: 'Worked Example', kind: 'worked_example', sourcePages: [2], evidenceText: 'e',
        inputs: ['Territory: Suburban (SUB)'],
        outputs: ['Adjusted total: $1,050.00'],
        steps: [
          { sequence: 1, instruction: '1. Base: $500.00 * 2.00', operation: 'multiply', expression: '$500.00 * 2.00', inputs: ['$500.00', '2.00'], output: '$1,000.00', cells: { step: '1. Base', calculation: '$500.00 * 2.00', result: '$1,000.00' } },
          { sequence: 2, instruction: '2. Territory adjustment: $1,050.00 * 1.00', operation: 'multiply', expression: '$1,050.00 * 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '2. Territory adjustment', calculation: '$1,050.00 * 1.00', result: '$1,050.00' } },
        ],
      }],
    })
  );
  for (const t of job.tables) t.columns = inferTableColumns(t);
  assert.equal(generateWorkedExampleLookups(job.routines[0], job.tables), 1);
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Worked Example'), strings);
  const steps = sectionRows(values, 'Steps');
  const lookupRows = steps.body.filter((row) => row[1] === 'Territory factor');
  assert.deepEqual(lookupRows.map((row) => row[0]), ['1b.1', '1b.2']);
  assert.match(lookupRows[1][6], /\(source step 1b\)/);
  const seqs = steps.body.map((row) => row[0]);
  assert.equal(new Set(seqs).size, seqs.length, `duplicate step numbers: ${JSON.stringify(seqs)}`);
  assert.ok(steps.body.every((row) => row[2] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.ok(values.some((row) => row[0] === 'Step 1b evidence' && row[1] === 'Territory: Suburban (SUB)'), 'missing Step 1b evidence row');
});
