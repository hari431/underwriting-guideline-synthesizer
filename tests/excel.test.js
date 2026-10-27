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

  // B1: inputs/outputs populated from the explicit assignment; wording kept.
  const b1 = byIndex(0);
  assert.deepEqual(b1[0], ['B1 - Base premium formula']);
  assert.ok(!b1.some((row) => row.length === 2 && (row[0] === 'Inputs' || row[0] === 'Outputs' || row[0] === 'Expression')));
  assert.deepEqual(sectionRows(b1, 'Inputs').body, [
    ['base_rate', 'Table 1 - Base Rate by Driver Class', ''],
    ['territory_factor', 'Table 2 - Territory Factor', ''],
  ]);
  assert.deepEqual(sectionRows(b1, 'Final calculation').body, [['base_premium = base_rate * territory_factor', 'base_premium']]);
  assert.equal(sectionRows(b1, 'Steps'), null);

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

  // F1: ordered operations with traced tables, keys, results, and sources.
  const f1 = byIndex(2);
  const f1steps = sectionRows(f1, 'Steps');
  assert.deepEqual(f1steps.header, ['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
  assert.deepEqual(f1steps.body.map((row) => row[0]), ['1', '2', '3', '4']);
  assert.deepEqual(f1steps.body.map((row) => row[2]), ['lookup', 'lookup', 'expression', 'rounding']);
  assert.deepEqual(f1steps.body[0], ['1', 'Look up base_rate from Table 1 using driver class.', 'lookup', 'driver class', 'lookup Table 1 - Base Rate by Driver Class → base_rate']);
  assert.deepEqual(f1steps.body[1], ['2', 'Look up territory_factor from Table 2 using territory.', 'lookup', 'territory', 'lookup Table 2 - Territory Factor → territory_factor']);
  assert.deepEqual(f1steps.body[2], ['3', 'final_premium = base_premium + policy_fee, where policy_fee = 25.', 'expression', 'final_premium = base_premium + policy_fee', 'uses base_premium from B1 - Base premium formula']);
  assert.deepEqual(f1steps.body[3], ['4', 'Round final_premium to the nearest dollar.', 'rounding', 'final_premium', '']);
  assert.equal(sectionRows(f1, 'Lookups'), null);
  assert.deepEqual(sectionRows(f1, 'Final calculation').body, [['final_premium = base_premium + policy_fee', 'final_premium']]);

  // G1: unfamiliar wording kept verbatim with nothing invented, flagged instead.
  const g1 = byIndex(3);
  assert.deepEqual(sectionRows(g1, 'Final calculation').body, [['APPLY legacy_matrix_v2 surcharge curve', '']]);
  assert.equal(sectionRows(g1, 'Steps'), null);
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

test('excel: routine sheet keeps steps, conditions, and dependencies as separate rows', () => {
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
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
  assert.equal(steps.body.length, 2);
  assert.equal(steps.body[0][0], '1'); // original numbering gaps preserved
  assert.equal(steps.body[1][0], '3');
  assert.equal(steps.body[0][1], 'Step 1: first');
  assert.equal(steps.body[1][1], 'Step 3: third');
  assert.ok(steps.body.every((row) => row.length === 5));
  const conditions = sectionRows(values, 'Conditions');
  assert.equal(conditions.body.length, 2);
  assert.equal(conditions.body[0][1], 'IF x THEN y');
  assert.equal(conditions.body[1][1], 'ELSE refer');
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body.map((row) => row[0]), ['Base', 'Elsewhere']);
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

test('excel: routine sheet preserves structured operations, operands, and lookups', () => {
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
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['1', '2', '4']); // gaps preserved
  assert.deepEqual(steps.body.map((row) => row[2]), ['assignment', 'lookup', 'rounding']);
  assert.deepEqual(steps.body[0], ['1', 'Initialize limit', 'assignment', 'x = 0', '']);
  assert.deepEqual(steps.body[1], ['2', 'Look up factor', 'lookup', 'key_a; key_b', 'lookup → f']);
  assert.deepEqual(steps.body[2], ['4', 'Round result', 'rounding', 'round to whole', '']);
  assert.equal(sectionRows(values, 'Lookups'), null); // lookup detail lives in the step row
});

test('excel: line comments trace routine outputs and flag unresolved tables', () => {
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
  assert.deepEqual(steps.body[0], ['1', 'Compute total', 'expression', 'total = shared + fee', 'uses shared from Upstream']);
  assert.deepEqual(steps.body[1], ['2', 'Look up rate', 'lookup', 'K', 'lookup "Table 9" → rate; table unresolved — verify']);
  assert.equal(sectionRows(values, 'Lookups'), null);
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
  const firstDeps = sectionRows(first, 'Dependencies');
  assert.deepEqual(firstDeps.body.map((row) => row[0]), ['Missing Asset']);
  assert.equal(sectionRows(second, 'Dependencies'), null);
  const firstUnresolved = sectionRows(first, 'Unresolved items');
  assert.ok(firstUnresolved !== null && firstUnresolved.body.length >= 1);
  assert.ok(firstUnresolved.body.some((row) => row[2].includes('Missing Asset')));
  assert.equal(sectionRows(second, 'Unresolved items'), null);
  assert.ok(sectionRows(second, 'Steps') !== null);
  assert.equal(sectionRows(first, 'Steps'), null);
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
  const tablesBlock = blockRows(values, 'Included Rate Tables');
  assert.deepEqual(tablesBlock, [['T1', 'First Table'], ['T2', 'Second Table']]);
  const routinesBlock = blockRows(values, 'Included Rate Routines');
  assert.deepEqual(routinesBlock, [['R1', 'First Routine'], ['R2', 'Second Routine']]);
  // Each name links to its detail worksheet.
  const tableSheets = tableSheetNames(job.tables);
  const routineSheets = routineSheetNames(job.routines, tableSheets);
  const links = new Map(hyperlinksIn(coverXml).map((l) => [l.ref, l.location]));
  const tablesLabel = values.findIndex((row) => row.length === 1 && row[0] === 'Included Rate Tables');
  tableSheets.forEach((sheet, i) => {
    assert.equal(links.get(cellRef(tablesLabel + 1 + i, 1)), expectedLocation(sheet));
  });
  const routinesLabel = values.findIndex((row) => row.length === 1 && row[0] === 'Included Rate Routines');
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
  const calcValues = assertRoutineFormatting('Calc', ['Steps', 'Final calculation', 'Conditions', 'Dependencies', 'Source evidence']);
  assert.deepEqual(sectionRows(calcValues, 'Steps').header, ['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
  assert.deepEqual(sectionRows(calcValues, 'Steps').body.map((row) => row[1]), ['Step 1: Do first thing', 'Step 2: Do second thing']);
  // No empty sections are added for visual consistency.
  assert.equal(sectionRows(calcValues, 'Inputs'), null);
  assert.equal(sectionRows(calcValues, 'Unresolved items'), null);

  // Formula-only routine: same title/heading/header styling, no Steps section.
  const plainValues = assertRoutineFormatting('Plain', ['Inputs', 'Final calculation', 'Dependencies', 'Source evidence']);
  assert.deepEqual(sectionRows(plainValues, 'Inputs').header, ['Input', 'Source', 'Lookup keys']);
  assert.deepEqual(sectionRows(plainValues, 'Final calculation').header, ['Calculation', 'Output']);
  assert.equal(sectionRows(plainValues, 'Steps'), null);
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

test('excel: input sources map variables to tables and routines without guessing', () => {
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

  // B1: each input maps to its source table; tables alone are not enough.
  const b1 = byName('B1 - Base premium formula');
  const b1inputs = sectionRows(b1, 'Inputs');
  assert.deepEqual(b1inputs.header, ['Input', 'Source', 'Lookup keys']);
  assert.deepEqual(b1inputs.body, [
    ['base_rate', 'Table 1 - Base Rate by Driver Class', ''],
    ['territory_factor', 'Table 2 - Territory Factor', ''],
  ]);
  const b1deps = sectionRows(b1, 'Dependencies');
  assert.deepEqual(b1deps.header, ['Target', 'Type', 'Explicit/Inferred', 'Variable / Keys']);
  assert.deepEqual(b1deps.body, [
    ['Table 1 - Base Rate by Driver Class', 'table', 'explicit', 'base_rate'],
    ['Table 2 - Territory Factor', 'table', 'explicit', 'territory_factor'],
  ]);

  // F1: routine input traces to its producing routine; undefined input is
  // marked unresolved rather than guessed.
  const f1 = byName('F1 - Final premium calculation');
  const f1inputs = sectionRows(f1, 'Inputs');
  assert.deepEqual(f1inputs.body, [
    ['base_premium', 'B1 - Base premium formula', ''],
    ['policy_fee', 'unresolved — verify', ''],
  ]);
  // Dependencies stay consistent with Steps: explicit routine links plus the
  // tables retrieved by the lookup steps, each with its variable and keys.
  const f1deps = sectionRows(f1, 'Dependencies');
  assert.deepEqual(f1deps.body, [
    ['B1 - Base premium formula', 'routine', 'explicit', 'base_premium'],
    ['T1 - Territory eligibility condition', 'routine', 'explicit', ''],
    ['Table 1 - Base Rate by Driver Class', 'table', 'inferred', 'base_rate (keys: driver class)'],
    ['Table 2 - Territory Factor', 'table', 'inferred', 'territory_factor (keys: territory)'],
  ]);
  const f1steps = sectionRows(f1, 'Steps');
  assert.deepEqual(f1steps.body[0][4], 'lookup Table 1 - Base Rate by Driver Class → base_rate');
  assert.deepEqual(f1steps.body[2][4], 'uses base_premium from B1 - Base premium formula');

  // T1 has no inputs, so no mapping section is shown.
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
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
  assert.deepEqual(steps.body[0], ['1', 'Look up x', 'lookup', 'my_key', 'lookup Lookup Table → x']);
  assert.deepEqual(steps.body[1], ['2', 'Compute y', 'expression', 'y = x * 2', 'uses x from step 1 (Lookup Table)']);
  // The inferred table link matches the lookup step; the external factor
  // without evidence is flagged rather than assigned a guessed source.
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [['Lookup Table', 'table', 'inferred', 'x (keys: my_key)']]);
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.body, [['factor', 'unresolved — verify', '']]);
});

test('excel: dependencies identify the producing routine and output variable', () => {
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
  assert.deepEqual(steps.body[0][4], 'uses shared from Upstream');
  assert.deepEqual(steps.body[1][4], 'lookup "Table 9" → rate; table unresolved — verify');
  // Dependencies mirror the same links: the producing routine with its
  // output variable, plus the attempted table lookup with keys.
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.header, ['Target', 'Type', 'Explicit/Inferred', 'Variable / Keys']);
  assert.deepEqual(deps.body, [
    ['Upstream', 'routine', 'inferred', 'shared'],
    ['Table 9', '', 'inferred', 'rate (keys: K)'],
  ]);
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.body, [['fee', 'unresolved — verify', '']]);
  // A primary input with no evidence of any source stays a parameter.
  const up = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Upstream'), strings);
  assert.deepEqual(sectionRows(up, 'Inputs').body, [['base', 'input parameter', '']]);
});

test('excel: routine sheet follows rating execution flow (Collision_PC_RR)', () => {
  // Models the Collision_PC_RR rate routine from the reference ratebook:
  // lookup steps first, intermediate assignments and a chained multiply,
  // then the terminal assignment plus rounding. Reference ops map to model
  // vocabulary ('<--' to lookup/assignment, 'R' to rounding); the chained
  // multiply keeps the source '*' op verbatim, and the rounding operand '1'
  // is carried through without interpreting its precision meaning.
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ratebook.pdf', pageCount: 1 }),
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
        name: 'Collision_PC_RR', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'Collision coverage rating steps 1-8.',
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
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'Collision_PC_RR'), strings);

  // Flow order: Inputs, then lookups/intermediate steps, then final
  // calculation; traceability sections follow, not lead.
  const labelIndex = (label) => values.findIndex((row) => row.length === 1 && row[0] === label);
  const inputsAt = labelIndex('Inputs');
  const stepsAt = labelIndex('Steps');
  const finalAt = labelIndex('Final calculation');
  assert.ok(inputsAt >= 0 && stepsAt > inputsAt && finalAt > stepsAt, 'expected Inputs, Steps, Final calculation in order');
  assert.ok(labelIndex('Dependencies') > finalAt);
  assert.ok(labelIndex('Source evidence') > finalAt);
  assert.equal(labelIndex('Input sources'), -1);
  assert.ok(!values.some((row) => row[0] === 'Expression'), 'formula must not lead the sheet');

  // Inputs: required variables with source or origin where supported.
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.header, ['Input', 'Source', 'Lookup keys']);
  assert.deepEqual(inputs.body, [
    ['AssignedDriver.DriverAge', 'input parameter', ''],
    ['Coverage.Deductible', 'input parameter', ''],
    ['Vehicle.VehicleAge', 'input parameter', ''],
    ['Coverage.Name', 'input parameter', ''],
  ]);

  // Steps: lookups with keys and returned variables, then intermediate
  // calculations in execution order, each traced to its source.
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
  assert.deepEqual(steps.body.map((row) => row[0]), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(steps.body[0], ['1', 'CollisionDriverVehicleFactor', 'lookup', 'AssignedDriver.DriverAge; Coverage.Deductible; Vehicle.VehicleAge', 'lookup Collision Driver Vehicle Factor → CollisionDriverVehicleFactor']);
  assert.deepEqual(steps.body[1], ['2', 'BaseRateFactor', 'lookup', 'Coverage.Name', 'lookup Base Rate → BaseRateFactor']);
  assert.deepEqual(steps.body[5], ['6', '', '*', 'CollisionDriverVehicleFactor', 'uses CollisionDriverVehicleFactor from step 1 (Collision Driver Vehicle Factor)']);
  assert.deepEqual(steps.body[6], ['7', 'TermAmount', 'assignment', 'TermAmount = AdjustedRate', 'uses AdjustedRate from step 5']);
  assert.deepEqual(steps.body[7], ['8', '', 'rounding', '1', 'uses TermAmount from step 7']);

  // Final calculation: the terminal computation restated verbatim with its
  // output. No single expression was stated, so the last non-rounding step
  // is shown; the trailing rounding stays separate in Steps above.
  const final = sectionRows(values, 'Final calculation');
  assert.deepEqual(final.header, ['Calculation', 'Output']);
  assert.deepEqual(final.body, [['TermAmount = AdjustedRate', 'TermAmount']]);

  // Dependencies stay consistent with the lookup steps.
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [
    ['Collision Driver Vehicle Factor', 'table', 'explicit', 'CollisionDriverVehicleFactor (keys: AssignedDriver.DriverAge; Coverage.Deductible; Vehicle.VehicleAge)'],
    ['Base Rate', 'table', 'explicit', 'BaseRateFactor (keys: Coverage.Name)'],
  ]);
});

test('excel: CALC-001 multiplication and half-up rounding stay separate operations', () => {
  // Faithful fixture from underwriteiq_sample_commercial_auto_guidelines (1).pdf p.2:
  // Step 4 calculates with ×, Step 5 rounds half-up. No expression_text was
  // extracted, so the workbook must not promote the rounding step to Final.
  const steps = [
    'Step 1: Look up base_rate using vehicle_class in the Base rate table.',
    'Step 2: Look up territory_factor using territory in the Territory factor table.',
    'Step 3: Look up driver_factor using years_licensed in the Driver experience factor table.',
    'Step 4: Calculate indicated_premium = base_rate × territory_factor × driver_factor.',
    'Step 5: Round indicated_premium to the nearest whole currency unit using standard half-up rounding.',
  ];
  const evidence = 'Routine ID: CALC-001 — Annual Base Premium. Inputs: vehicle_class, territory, years_licensed. Step 4: Calculate indicated_premium = base_rate × territory_factor × driver_factor. Step 5: Round indicated_premium to the nearest whole currency unit using standard half-up rounding.';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'underwriteiq_sample_commercial_auto_guidelines (1).pdf', pageCount: 2 }),
      tables: [
        { name: 'Base rate table', sourcePages: [1], evidenceText: 'Base rate table', headers: ['Vehicle class', 'Base rate (annual)'], rows: [['V1', '1200']] },
        { name: 'Territory factor table', sourcePages: [1], evidenceText: 'Territory factor table', headers: ['Territory', 'Factor'], rows: [['T1', '0.85']] },
        { name: 'Driver experience factor table', sourcePages: [1], evidenceText: 'Driver experience factor table', headers: ['Years licensed', 'Factor'], rows: [['Less than 2', '1.40']] },
      ],
      routines: [{
        name: 'CALC-001 — Annual Base Premium',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: evidence,
        expressionText: '',
        steps,
        dependsOn: ['Base rate table', 'Territory factor table', 'Driver experience factor table'],
        inputs: ['vehicle_class', 'territory', 'years_licensed'],
        outputs: ['indicated_premium'],
      }],
    })
  );
  job.issues = validateJob(job);

  // Steps 1-3 map each lookup key to its result variable and source table.
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 5);
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'lookup', 'lookup', 'expression', 'rounding']);
  assert.deepEqual(det[0].inputs, ['vehicle_class']);
  assert.equal(det[0].output, 'base_rate');
  assert.deepEqual(det[0].depends_on, ['Base rate table']);
  assert.deepEqual(det[1].inputs, ['territory']);
  assert.equal(det[1].output, 'territory_factor');
  assert.deepEqual(det[1].depends_on, ['Territory factor table']);
  assert.deepEqual(det[2].inputs, ['years_licensed']);
  assert.equal(det[2].output, 'driver_factor');
  assert.deepEqual(det[2].depends_on, ['Driver experience factor table']);

  // Step 4 is a structured multiplication expression preserving the source ×.
  assert.equal(det[3].operation, 'expression');
  assert.equal(det[3].expression, 'indicated_premium = base_rate × territory_factor × driver_factor');
  assert.equal(det[3].output, 'indicated_premium');
  assert.deepEqual(det[3].inputs, ['base_rate', 'territory_factor', 'driver_factor']);
  assert.equal(det[4].operation, 'rounding');
  assert.equal(det[4].output, 'indicated_premium');

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, 'CALC-001 — Annual Base Premium'), strings);

  // Inputs lists only the true external inputs, each a lookup key parameter.
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.body, [
    ['vehicle_class', 'input parameter', ''],
    ['territory', 'input parameter', ''],
    ['years_licensed', 'input parameter', ''],
  ]);

  // Steps keep both operations separately in source order.
  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['lookup', 'lookup', 'lookup', 'expression', 'rounding']);
  assert.deepEqual(stepsSection.body[0], ['1', steps[0], 'lookup', 'vehicle_class', 'lookup Base rate table → base_rate']);
  assert.deepEqual(stepsSection.body[1], ['2', steps[1], 'lookup', 'territory', 'lookup Territory factor table → territory_factor']);
  assert.deepEqual(stepsSection.body[2], ['3', steps[2], 'lookup', 'years_licensed', 'lookup Driver experience factor table → driver_factor']);
  assert.equal(stepsSection.body[3][3], 'indicated_premium = base_rate × territory_factor × driver_factor');
  assert.equal(stepsSection.body[3][4], 'uses base_rate from step 1 (Base rate table); uses territory_factor from step 2 (Territory factor table); uses driver_factor from step 3 (Driver experience factor table)');
  assert.equal(stepsSection.body[4][3], 'indicated_premium');

  // Final calculation is the multiplication, not the rounding step.
  const final = sectionRows(values, 'Final calculation');
  assert.deepEqual(final.body, [['indicated_premium = base_rate × territory_factor × driver_factor', 'indicated_premium']]);

  // Dependencies carry each retrieved variable with its lookup keys.
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [
    ['Base rate table', 'table', 'explicit', 'base_rate (keys: vehicle_class)'],
    ['Territory factor table', 'table', 'explicit', 'territory_factor (keys: territory)'],
    ['Driver experience factor table', 'table', 'explicit', 'driver_factor (keys: years_licensed)'],
  ]);

  // Source evidence is preserved verbatim.
  const evidenceRows = blockRows(values, 'Source evidence');
  assert.ok(evidenceRows.some((row) => row[0] === 'Source pages' && row[1] === '2'));
  assert.ok(evidenceRows.some((row) => row[0] === 'Evidence' && row[1].includes('CALC-001')));
});

test('excel: PROP multi-stage lookups keep raw/adjusted/annual separate and resolve tables', () => {
  const steps = [
    'Step 1: Find the base rate for occupancy_class in Table A.',
    'Step 2: Retrieve construction_factor from Table B using construction_code.',
    'Step 3: Look up protection_factor using protection_class in Table C.',
    'Step 4: Select the territory factor for territory from Table D.',
    'Step 5: Calculate raw_premium = (insured_value / 1000) × base_rate × construction_factor × protection_factor × territory_factor.',
    'Step 6: Apply a minimum annual premium of 350 currency units. If raw_premium is below 350, set adjusted_premium to 350; otherwise adjusted_premium equals raw_premium.',
    'Step 7: Round adjusted_premium to the nearest whole currency unit using half-up rounding. Store the result as annual_premium.',
  ];
  const intermediate = 'raw_premium = (insured_value / 1000) × base_rate × construction_factor × protection_factor × territory_factor';
  const evidence = 'Routine ID: PROP-CALC-02 — Annual Property Premium. Inputs: occupancy_class, construction_code, protection_class, territory, insured_value. Step 5: Calculate raw_premium. Step 6: minimum premium conditional. Step 7: rounding to annual_premium.';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'property-guidelines.pdf', pageCount: 3 }),
      tables: [
        { name: 'Table A - Base property rate', sourcePages: [1], evidenceText: 'Table A schedule (annual rate per 1,000)', headers: ['Occupancy class', 'Base rate'], rows: [['O1', '1.20']] },
        { name: 'Table B - Construction factor', sourcePages: [1], evidenceText: 'Table B schedule (annual factor per class)', headers: ['Construction code', 'Factor'], rows: [['C1', '0.80']] },
        { name: 'Table C - Protection factor', sourcePages: [1], evidenceText: 'Table C schedule (annual factor per class)', headers: ['Protection class', 'Factor'], rows: [['P1', '0.90']] },
        { name: 'Table D - Territory surcharge', sourcePages: [2], evidenceText: 'Table D schedule (annual surcharge per territory)', headers: ['Territory', 'Factor'], rows: [['Urban', '1.20']] },
      ],
      routines: [{
        name: 'PROP-CALC-02 - Annual Property Premium',
        kind: 'calculation_steps',
        sourcePages: [3],
        evidenceText: evidence,
        expressionText: intermediate,
        steps,
        conditions: ['If raw_premium is below 350, set adjusted_premium to 350; otherwise adjusted_premium equals raw_premium.'],
        dependsOn: ['Table A', 'Table B', 'Table C', 'Table D'],
        inputs: ['occupancy_class', 'construction_code', 'protection_class', 'territory', 'insured_value'],
        outputs: ['annual_premium'],
      }],
    })
  );
  job.issues = validateJob(job);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(!job.issues.some((i) => /matches no extracted table/.test(i.message)), 'short table aliases must resolve');

  const det = job.routines[0].steps_detailed;
  assert.deepEqual(det.map((d) => d.operation), ['lookup', 'lookup', 'lookup', 'lookup', 'expression', 'condition', 'rounding']);
  assert.deepEqual(det.map((d) => d.output), ['base_rate', 'construction_factor', 'protection_factor', 'territory_factor', 'raw_premium', 'adjusted_premium', 'annual_premium']);
  assert.deepEqual(det[0].inputs, ['occupancy_class']);
  assert.deepEqual(det[0].depends_on, ['Table A']);
  assert.deepEqual(det[1].inputs, ['construction_code']);
  assert.deepEqual(det[4].inputs, ['insured_value', 'base_rate', 'construction_factor', 'protection_factor', 'territory_factor']);
  assert.deepEqual(det[5].inputs, ['raw_premium']);
  assert.deepEqual(det[6].inputs, ['adjusted_premium']);

  const cond = job.routines[0].conditions_detailed;
  assert.equal(cond.length, 1);
  assert.equal(cond[0].condition, 'raw_premium is below 350');
  assert.equal(cond[0].true_branch, 'set adjusted_premium to 350');
  assert.equal(cond[0].false_branch, 'adjusted_premium equals raw_premium.');

  const zip = readZip(buildWorkbookXlsx(job, { source: 'live' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const routineSheet = routineSheetNames(job.routines, tableSheetNames(job.tables))[0];
  const values = sheetRowsAsValues(sheetXmlByName(zip, workbook, routineSheet), strings);

  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.body, [
    ['occupancy_class', 'input parameter', ''],
    ['construction_code', 'input parameter', ''],
    ['protection_class', 'input parameter', ''],
    ['territory', 'input parameter', ''],
    ['insured_value', 'unresolved — verify', ''],
  ]);

  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['lookup', 'lookup', 'lookup', 'lookup', 'expression', 'condition', 'rounding']);
  assert.deepEqual(stepsSection.body[0], ['1', steps[0], 'lookup', 'occupancy_class', 'lookup Table A - Base property rate → base_rate']);
  assert.deepEqual(stepsSection.body[1], ['2', steps[1], 'lookup', 'construction_code', 'lookup Table B - Construction factor → construction_factor']);
  assert.deepEqual(stepsSection.body[3], ['4', steps[3], 'lookup', 'territory', 'lookup Table D - Territory surcharge → territory_factor']);
  assert.equal(stepsSection.body[4][3], intermediate);
  assert.match(stepsSection.body[4][4], /uses base_rate from step 1/);
  assert.match(stepsSection.body[4][4], /uses construction_factor from step 2/);
  assert.match(stepsSection.body[5][4], /uses raw_premium from step 5/);
  assert.match(stepsSection.body[6][4], /uses adjusted_premium from step 6/);

  // Final is the terminal annual stage, not the intermediate raw formula.
  const final = sectionRows(values, 'Final calculation');
  assert.equal(final.body.length, 1);
  assert.equal(final.body[0][1], 'annual_premium');
  assert.notEqual(final.body[0][0], intermediate);
  assert.match(final.body[0][0], /annual_premium|Round adjusted_premium/);

  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [
    ['Table A', 'table', 'explicit', 'base_rate (keys: occupancy_class)'],
    ['Table B', 'table', 'explicit', 'construction_factor (keys: construction_code)'],
    ['Table C', 'table', 'explicit', 'protection_factor (keys: protection_class)'],
    ['Table D', 'table', 'explicit', 'territory_factor (keys: territory)'],
  ]);

  const condSection = sectionRows(values, 'Conditions');
  assert.equal(condSection.body[0][1], 'If raw_premium is below 350, set adjusted_premium to 350; otherwise adjusted_premium equals raw_premium.');
  assert.equal(condSection.body[0][2], 'set adjusted_premium to 350');
  assert.equal(condSection.body[0][3], 'adjusted_premium equals raw_premium.');

  const evidenceRows = blockRows(values, 'Source evidence');
  assert.ok(evidenceRows.some((row) => row[0] === 'Source pages' && row[1] === '3'));
  assert.ok(evidenceRows.some((row) => row[0] === 'Evidence' && row[1].includes('PROP-CALC-02')));
});

test('excel: parenthetical title text never sources an input and stages stay distinct', () => {
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

  // The parenthetical qualifier mentions account_value, but the schedule only
  // provides widget_rate: the external input is never sourced from that table.
  const inputs = sectionRows(values, 'Inputs');
  assert.deepEqual(inputs.body, [
    ['widget_class', 'input parameter', ''],
    ['gadget_code', 'input parameter', ''],
    ['account_value', 'unresolved — verify', ''],
  ]);

  const stepsSection = sectionRows(values, 'Steps');
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '2', '3', '4', '5']);
  assert.deepEqual(stepsSection.body.map((row) => row[2]), ['lookup', 'lookup', 'expression', 'condition', 'rounding']);
  assert.equal(stepsSection.body[0][3], 'widget_class');
  assert.equal(stepsSection.body[0][4], 'lookup Schedule Q - Widget rate (annual rate per 1,000 of account_value) → widget_rate');
  assert.equal(stepsSection.body[1][4], 'lookup Schedule R - Gadget factor → gadget_factor');
  assert.equal(stepsSection.body[2][3], intermediate);
  assert.match(stepsSection.body[2][4], /uses widget_rate from step 1/);
  assert.match(stepsSection.body[2][4], /uses gadget_factor from step 2/);
  assert.match(stepsSection.body[3][4], /uses gross_total from step 3/);
  assert.match(stepsSection.body[4][4], /uses net_total from step 4/);

  // Final is the terminal billed stage, not the intermediate gross formula.
  const final = sectionRows(values, 'Final calculation');
  assert.equal(final.body.length, 1);
  assert.equal(final.body[0][1], 'billed_total');
  assert.notEqual(final.body[0][0], intermediate);
  assert.match(final.body[0][0], /billed_total|Round net_total/);

  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [
    ['Schedule Q', 'table', 'explicit', 'widget_rate (keys: widget_class)'],
    ['Schedule R', 'table', 'explicit', 'gadget_factor (keys: gadget_code)'],
  ]);
});

test('excel: intermediate expression keeps its own output when no later stage is evidenced', () => {
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
  const final = sectionRows(values, 'Final calculation');
  assert.deepEqual(final.body, [[expr, 'gross_total']]);
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
  assert.deepEqual(stepsSection.body.map((row) => row[0]), ['1', '3']);
});

test('excel: intermediate expression is not promoted to final when steps show later stages', () => {
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
  const final = sectionRows(values, 'Final calculation');
  assert.equal(final.body.length, 1);
  assert.equal(final.body[0][1], 'final_total');
  assert.notEqual(final.body[0][0], interim);
  assert.match(final.body[0][0], /final_total/);
  const deps = sectionRows(values, 'Dependencies');
  assert.deepEqual(deps.body, [
    ['Lookup One', 'table', 'explicit', 'alpha_value (keys: alpha_key)'],
    ['Lookup Two', 'table', 'explicit', 'beta_value (keys: beta_key)'],
  ]);
});
