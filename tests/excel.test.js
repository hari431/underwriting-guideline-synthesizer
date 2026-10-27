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
  assert.ok(b1.some((row) => row[0] === 'Inputs' && row[1] === 'base_rate; territory_factor'));
  assert.ok(b1.some((row) => row[0] === 'Outputs' && row[1] === 'base_premium'));
  assert.ok(b1.some((row) => row[0] === 'Expression' && row[1] === 'base_premium = base_rate * territory_factor'));
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

  // G1: unfamiliar wording kept verbatim with nothing invented, flagged instead.
  const g1 = byIndex(3);
  assert.ok(g1.some((row) => row[0] === 'Expression' && row[1] === 'APPLY legacy_matrix_v2 surcharge curve'));
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

test('excel: routine steps heading and headers are bold, contents are not', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
      routines: [
        {
          name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
          steps: ['Step 1: Do first thing', 'Step 2: Do second thing'],
          conditions: ['IF x THEN y'],
        },
        { name: 'Plain', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'a = 1' },
      ],
    })
  );
  job.issues = validateJob(job);
  const zip = readZip(buildWorkbookXlsx(job, { source: 'recorded' }));
  const workbook = zip.get('xl/workbook.xml');
  const strings = zip.get('xl/sharedStrings.xml');
  const calcXml = sheetXmlByName(zip, workbook, 'Calc');
  const values = sheetRowsAsValues(calcXml, strings);
  const rowNumOf = (label) => values.findIndex((row) => row.length === 1 && row[0] === label) + 1;
  // Steps heading and column headers are bold; step data is untouched.
  const stepsLabel = rowNumOf('Steps');
  assert.deepEqual(rowCellStyles(calcXml, stepsLabel), ['1']);
  const headerStyles = rowCellStyles(calcXml, stepsLabel + 1);
  assert.ok(headerStyles.length > 0 && headerStyles.every((s) => s === '1'));
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.body.map((row) => row[1]), ['Step 1: Do first thing', 'Step 2: Do second thing']);
  steps.body.forEach((_, i) => {
    assert.ok(rowCellStyles(calcXml, stepsLabel + 2 + i).every((s) => s === null));
  });
  // Overview title stays bold; other sections stay unstyled.
  assert.deepEqual(rowCellStyles(calcXml, 1), ['1']);
  assert.ok(rowCellStyles(calcXml, rowNumOf('Conditions')).every((s) => s === null));
  const evidence = blockRows(values, 'Source evidence');
  const evidenceLabel = values.findIndex((row) => row.length === 1 && row[0] === 'Source evidence') + 1;
  assert.ok(rowCellStyles(calcXml, evidenceLabel).every((s) => s === null));
  evidence.forEach((_, i) => {
    assert.ok(rowCellStyles(calcXml, evidenceLabel + 1 + i).every((s) => s === null));
  });
  // A routine without steps keeps only its title row bold.
  const plainXml = sheetXmlByName(zip, workbook, 'Plain');
  const plainValues = sheetRowsAsValues(plainXml, strings);
  plainValues.forEach((_, i) => {
    const styles = rowCellStyles(plainXml, i + 1);
    if (i === 0) assert.deepEqual(styles, ['1']);
    else assert.ok(styles.every((s) => s === null));
  });
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
