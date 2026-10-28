import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildWorkbookXlsx, routineSheetNames, tableSheetNames } from '../src/excel.js';
import { createDocument, createJob, definedConstantTerms, normalizeJob, resolveRoutineReference } from '../src/models.js';
import { validateJob } from '../src/validate.js';

// Generic rating-analyser regressions: dependency validation (declared
// inputs, defined constants, intermediate outputs, cross-routine references,
// table lookup keys, genuine unresolved references) and seven-column routine
// step rendering (compound expressions, parentheses, rounding). Fixtures use a
// synthetic harbor-fee domain with routine and variable names that differ
// from every other fixture, so these tests cannot pass by accident from
// hardcoded sample handling.

function jobWith({ tables = [], routines = [], pageCount = 2 } = {}) {
  return normalizeJob(
    createJob({
      document: createDocument({ filename: 'harbor-guideline.pdf', pageCount }),
      tables,
      routines,
    })
  );
}

function harborTables() {
  return [
    {
      name: 'Pilot Rate Schedule', sourcePages: [1], evidenceText: 'Pilot Rate Schedule in dollars per call',
      headers: ['Hull Code', 'Pilot Rate'], rows: [['H1', '120.00'], ['H2', '150.00']],
    },
    {
      name: 'Tide Factor Table', sourcePages: [1], evidenceText: 'Tide Factor Table with factor per tide class',
      headers: ['Tide Class', 'Factor'], rows: [['High', '1.10'], ['Low', '0.95']],
    },
  ];
}

function harborBaseFee() {
  return {
    name: 'HB-1 — Harbor Base Fee',
    kind: 'calculation_steps',
    sourcePages: [2],
    evidenceText: 'HB-1 steps: look up pilot_rate, tide_factor; length_units = vessel_length / 100; base_charge = length_units * pilot_rate * tide_factor.',
    steps: [
      'Step 1. Look up pilot_rate from Pilot Rate Schedule using hull_code.',
      'Step 2. Look up tide_factor from Tide Factor Table using tide_class.',
      'Step 3. Calculate length_units = vessel_length / 100.',
      'Step 4. Calculate base_charge = length_units * pilot_rate * tide_factor.',
    ],
    dependsOn: ['Pilot Rate Schedule', 'Tide Factor Table', 'vessel_length', 'hull_code', 'tide_class'],
    inputs: ['vessel_length', 'hull_code', 'tide_class'],
    outputs: ['base_charge'],
  };
}

function harborTotalFee() {
  return {
    name: 'HB-2 — Harbor Total Fee',
    kind: 'calculation_steps',
    sourcePages: [2],
    evidenceText: 'HB-2 steps: subtotal_due = base_charge + harbor_fee, where harbor_fee = 120; round subtotal_due, store as total_due.',
    notes: 'Fixed value: harbor_fee = 120.',
    steps: [
      'Step 1. Calculate subtotal_due = base_charge + harbor_fee, where harbor_fee = 120.',
      'Step 2. Round subtotal_due to the nearest whole coin. Store the result as total_due.',
    ],
    dependsOn: ['HB-1', 'base_charge', 'harbor_fee'],
    inputs: ['base_charge', 'harbor_fee'],
    outputs: ['total_due'],
  };
}

function harborDraftNote() {
  return {
    name: 'HB-9 — Harbor Draft Note',
    kind: 'calculation_steps',
    sourcePages: [2],
    evidenceText: 'HB-9 draft note with unresolved references.',
    steps: [
      { sequence: 1, instruction: 'Use the missing draft value', inputs: ['never_defined_anywhere'], output: 'draft_out' },
    ],
    dependsOn: ['No Such Schedule', 'mystery_variable'],
  };
}

test('rating: declared inputs, constants, keys, and cross-routine outputs resolve', () => {
  const job = jobWith({ tables: harborTables(), routines: [harborBaseFee(), harborTotalFee()] });
  const issues = validateJob(job);
  assert.deepEqual(issues, [], `expected zero issues, got: ${issues.map((i) => i.message).join(' | ')}`);
});

test('rating: genuine unresolved references still warn with useful messages', () => {
  const job = jobWith({ tables: harborTables(), routines: [harborBaseFee(), harborTotalFee(), harborDraftNote()] });
  const issues = validateJob(job);
  assert.equal(issues.length, 3);
  assert.ok(issues.every((i) => i.severity === 'warning'));
  assert.ok(issues.every((i) => i.target_id === 'R3'));
  const byTarget = (name) => issues.find((i) => i.message.includes(name));
  assert.ok(byTarget('No Such Schedule')?.message.includes('matches no extracted table, routine, input, or output'));
  assert.ok(byTarget('mystery_variable')?.message.includes('matches no extracted table, routine, input, or output'));
  const stepIssue = byTarget('never_defined_anywhere');
  assert.ok(stepIssue?.message.includes('flagged as unresolved'));
  assert.ok(stepIssue?.message.includes('Step 1'));
});

test('rating: routine codes resolve to one routine and stay ambiguous otherwise', () => {
  const routines = [
    { id: 'R1', name: 'HB-1 — Harbor Base Fee' },
    { id: 'R2', name: 'HB-2 — Harbor Total Fee' },
  ];
  assert.equal(resolveRoutineReference(routines, 'R2')?.id, 'R2');
  assert.equal(resolveRoutineReference(routines, 'HB-1 — Harbor Base Fee')?.id, 'R1');
  assert.equal(resolveRoutineReference(routines, 'HB-1')?.id, 'R1');
  assert.equal(resolveRoutineReference(routines, 'hb-2')?.id, 'R2');
  assert.equal(resolveRoutineReference(routines, 'Harbor'), null);
  assert.equal(resolveRoutineReference(routines, 'Fee'), null);
  assert.equal(resolveRoutineReference(routines, 'HB-9'), null);
  assert.equal(resolveRoutineReference(routines, ''), null);
  assert.equal(resolveRoutineReference(routines, 'H'), null);
  assert.equal(resolveRoutineReference([], 'HB-1'), null);
});

test('rating: defined constants collect from notes, where-clauses, and literal steps', () => {
  const terms = definedConstantTerms([
    { notes: 'Fixed value: harbor_fee = 120.' },
    { expression_text: 'total_due = north_due + south_due, where south_due = 5.' },
    { steps: ['Initialize basis_count = 1 before lookup.'] },
    { steps_detailed: [{ instruction: 'Seed it', expression: 'seed_value = 3' }] },
  ]);
  assert.ok(terms.has('harbor_fee'));
  assert.ok(terms.has('south_due'));
  assert.ok(terms.has('basis_count'));
  assert.ok(terms.has('seed_value'));
  assert.ok(!terms.has('total_due'));
  assert.ok(!terms.has('north_due'));
  assert.equal(definedConstantTerms([{ notes: 'no assignments here' }]).size, 0);
});

test('rating: numeric literals in step inputs are values, not references', () => {
  const job = jobWith({
    tables: harborTables(),
    routines: [{
      name: 'HB-3 — Harbor Scaling',
      kind: 'calculation_steps',
      sourcePages: [2],
      evidenceText: 'HB-3 scales raw_value by a literal divisor.',
      steps: [
        { sequence: 1, instruction: 'Scale it', operation: 'expression', expression: 'scaled_value = raw_value / 100', inputs: ['raw_value', '100'], output: 'scaled_value' },
      ],
      inputs: ['raw_value'],
      outputs: ['scaled_value'],
    }],
  });
  assert.deepEqual(validateJob(job), []);
});

// ---------- workbook assertions ----------

function readZip(buf) {
  const entries = new Map();
  let pos = 0;
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    entries.set(name, raw.toString('utf8'));
    pos = dataStart + compSize;
  }
  return entries;
}

function unescapeXml(s) {
  return String(s ?? '').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function sheetRowsAsValues(sheetXml, stringsXml) {
  const items = [...stringsXml.matchAll(/<si><t xml:space="preserve">(.*?)<\/t><\/si>/gs)].map((m) => unescapeXml(m[1]));
  const rows = [];
  for (const m of sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
    rows.push(
      [...m[2].matchAll(/<c r="[A-Z]+\d+" t="s"(?: s="\d+")?><v>(\d+)<\/v><\/c>/g)]
        .map((c) => items[Number(c[1])] ?? '')
    );
  }
  return rows;
}

function routineSheetValues(job, routineName) {
  const xlsx = buildWorkbookXlsx(job, { source: 'recorded' });
  const zip = readZip(xlsx);
  const strings = zip.get('xl/sharedStrings.xml');
  const workbook = zip.get('xl/workbook.xml');
  const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  const sheets = routineSheetNames(job.routines, tableSheetNames(job.tables));
  const idx = job.routines.findIndex((r) => r.name === routineName);
  const sheetIdx = names.indexOf(sheets[idx]);
  assert.ok(sheetIdx >= 0, `workbook missing sheet for ${routineName}`);
  return sheetRowsAsValues(zip.get(`xl/worksheets/sheet${sheetIdx + 1}.xml`), strings);
}

function sectionRows(values, label) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
  if (idx < 0) return null;
  const body = [];
  for (let i = idx + 2; i < values.length; i += 1) {
    if (values[i].length === 1) break;
    body.push(values[i]);
  }
  return { header: values[idx + 1] ?? [], body };
}

function blockRows(values, label) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
  if (idx < 0) return null;
  const body = [];
  for (let i = idx + 1; i < values.length; i += 1) {
    if (values[i].length === 1) break;
    body.push(values[i]);
  }
  return body;
}

const STEPS_HEADER = ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment'];

test('rating: compound expression expands with hierarchical numbers in source order', () => {
  const job = jobWith({
    routines: [{
      name: 'Harbor Surcharge Calc', kind: 'formula', sourcePages: [1], evidenceText: 'surcharge formula',
      expressionText: 'surcharge_total = mooring_fee * tide_factor * season_factor',
    }],
  });
  job.issues = validateJob(job);
  assert.deepEqual(job.issues, []);
  assert.deepEqual(job.routines[0].inputs, ['mooring_fee', 'tide_factor', 'season_factor']);
  const steps = sectionRows(routineSheetValues(job, 'Harbor Surcharge Calc'), 'Steps');
  assert.deepEqual(steps.header, STEPS_HEADER);
  assert.deepEqual(steps.body, [
    ['1.1', 'surcharge_total', '<--', '', 'mooring_fee', '', 'Start surcharge_total from mooring_fee (source step 1)'],
    ['1.2', '', '*', '', 'tide_factor', '', 'Apply * tide_factor to continue surcharge_total from prior step (source step 1)'],
    ['1.3', '', '*', '', 'season_factor', '', 'Apply * season_factor to continue surcharge_total from prior step (source step 1)'],
  ]);
});

test('rating: parentheses render in the bracket columns without changing grouping', () => {
  const job = jobWith({
    routines: [{
      name: 'Harbor Net Calc', kind: 'formula', sourcePages: [1], evidenceText: 'net formula',
      expressionText: 'net_due = (gross_due - credit_amount) * harbor_factor',
    }],
  });
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'Harbor Net Calc'), 'Steps');
  assert.deepEqual(steps.header, STEPS_HEADER);
  assert.deepEqual(steps.body, [
    ['1.1', 'net_due', '<--', '(', 'gross_due', '', 'Start net_due from gross_due (source step 1)'],
    ['1.2', '', '-', '', 'credit_amount', ')', 'Apply - credit_amount to continue net_due from prior step (source step 1)'],
    ['1.3', '', '*', '', 'harbor_factor', '', 'Apply * harbor_factor to continue net_due from prior step (source step 1)'],
  ]);
});

test('rating: mixed operators keep source order across expanded rows', () => {
  const job = jobWith({
    routines: [{
      name: 'Harbor Mixed Calc', kind: 'formula', sourcePages: [1], evidenceText: 'mixed formula',
      expressionText: 'mixed_total = dock_fee + tax_amount * levy_rate',
    }],
  });
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'Harbor Mixed Calc'), 'Steps');
  assert.deepEqual(steps.body.map((row) => row[0]), ['1.1', '1.2', '1.3']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '+', '*']);
  assert.deepEqual(steps.body.map((row) => row[4]), ['dock_fee', 'tax_amount', 'levy_rate']);
});

test('rating: intermediate from an expanded group traces to its definition start', () => {
  const job = jobWith({
    routines: [{
      name: 'Harbor Staged Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'staged calc',
      steps: [
        'Step 1. Calculate mid_total = north_fee * south_fee.',
        'Step 2. Calculate grand_total = mid_total + east_fee.',
        'Step 3. Round grand_total to the nearest whole coin. Store the result as billed_total.',
      ],
      inputs: ['north_fee', 'south_fee', 'east_fee'],
      outputs: ['billed_total'],
    }],
  });
  job.issues = validateJob(job);
  assert.deepEqual(job.issues, []);
  const steps = sectionRows(routineSheetValues(job, 'Harbor Staged Calc'), 'Steps');
  assert.deepEqual(steps.body.map((row) => row[0]), ['1.1', '1.2', '2.1', '2.2', '3']);
  assert.deepEqual(steps.body[2], ['2.1', 'grand_total', '<--', '', 'mid_total', '', 'uses mid_total from step 1.1']);
  assert.deepEqual(steps.body[4], ['3', 'billed_total', 'R', '', 'grand_total to the nearest whole coin', '', 'uses grand_total from step 2.1']);
});

test('rating: workbook carries corrected steps, evidence, and only genuine warnings', () => {
  const job = jobWith({ tables: harborTables(), routines: [harborBaseFee(), harborTotalFee(), harborDraftNote()] });
  job.issues = validateJob(job);
  assert.equal(job.issues.length, 3);

  const base = routineSheetValues(job, 'HB-1 — Harbor Base Fee');
  const baseSteps = sectionRows(base, 'Steps');
  assert.deepEqual(baseSteps.header, STEPS_HEADER);
  assert.deepEqual(baseSteps.body.map((row) => row[0]), ['1', '2', '3.1', '3.2', '4.1', '4.2', '4.3']);
  assert.ok(baseSteps.body[4][6].includes('uses length_units from step 3.1'));
  assert.equal(sectionRows(base, 'Unresolved items'), null);
  const baseEvidence = blockRows(base, 'Source evidence');
  assert.ok(baseEvidence.some((row) => row[0] === 'Source pages' && row[1] === '2'));
  assert.ok(baseEvidence.some((row) => row[0] === 'Evidence' && row[1].includes('HB-1')));

  const total = routineSheetValues(job, 'HB-2 — Harbor Total Fee');
  const totalSteps = sectionRows(total, 'Steps');
  assert.deepEqual(totalSteps.body.map((row) => row[0]), ['1.1', '1.2', '2']);
  assert.deepEqual(totalSteps.body[0], ['1.1', 'subtotal_due', '<--', '', 'base_charge', '', 'uses base_charge from HB-1 — Harbor Base Fee']);
  assert.deepEqual(totalSteps.body[1][2], '+');
  assert.ok(total.some((row) => row[0] === 'Notes' && row[1].includes('harbor_fee = 120')));
  assert.equal(sectionRows(total, 'Unresolved items'), null);

  const draft = routineSheetValues(job, 'HB-9 — Harbor Draft Note');
  const unresolved = sectionRows(draft, 'Unresolved items');
  assert.ok(unresolved !== null && unresolved.body.length === 3);
  assert.ok(unresolved.body.some((row) => row[2].includes('No Such Schedule')));
  assert.ok(unresolved.body.some((row) => row[2].includes('mystery_variable')));
  assert.ok(unresolved.body.some((row) => row[2].includes('never_defined_anywhere')));

  const xlsx = buildWorkbookXlsx(job, { source: 'recorded' });
  const zip = readZip(xlsx);
  const strings = zip.get('xl/sharedStrings.xml');
  const workbook = zip.get('xl/workbook.xml');
  const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  const sheet = (name) => sheetRowsAsValues(zip.get(`xl/worksheets/sheet${names.indexOf(name) + 1}.xml`), strings);
  assert.equal(sheet('Issues').length, 4); // header + 3 genuine warnings
  assert.ok(sheet('Cover').some((row) => row[0] === 'Errors' && row[1] === '0'));
  assert.ok(sheet('Cover').some((row) => row[0] === 'Warnings' && row[1] === '3'));
});
