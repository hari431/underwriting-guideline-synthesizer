import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildWorkbookXlsx, routineSheetNames, tableSheetNames } from '../src/excel.js';
import { createDocument, createJob, normalizeJob } from '../src/models.js';
import { validateJob } from '../src/validate.js';

// Generic step-extraction regressions: explicit arithmetic (bare, unicode,
// embedded, result-form), lookups, rounding statements, descriptive prose,
// and incomplete expressions. Fixtures use an invented ledger-fee domain with
// codes and variables that differ from every real document, so these tests
// cannot pass by accident from hardcoded sample handling.

function ledgerRoutine(steps, extra = {}) {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps,
        ...extra,
      }],
    })
  );
  return job.routines[0];
}

test('steps: bare code arithmetic structures without inventing an output', () => {
  const r = ledgerRoutine(['LX-01 + LX-02']);
  assert.deepEqual(r.steps, ['LX-01 + LX-02']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'LX-01 + LX-02');
  assert.deepEqual(det.inputs, ['LX-01', 'LX-02']);
  assert.equal(det.output, undefined);
  assert.equal(det.interpretation_status, 'inferred');
});

test('steps: result-form arithmetic keeps an explicit output and drops a worked value', () => {
  const r = ledgerRoutine(['LX-01 + LX-02 = LX-NET', 'LX-01 + LX-02 = 1,240.00']);
  assert.equal(r.steps_detailed[0].operation, 'expression');
  assert.equal(r.steps_detailed[0].expression, 'LX-01 + LX-02');
  assert.equal(r.steps_detailed[0].output, 'LX-NET');
  assert.deepEqual(r.steps_detailed[0].inputs, ['LX-01', 'LX-02']);
  assert.equal(r.steps_detailed[1].operation, 'expression');
  assert.equal(r.steps_detailed[1].expression, 'LX-01 + LX-02');
  assert.equal(r.steps_detailed[1].output, undefined);
  assert.deepEqual(r.steps_detailed[1].inputs, ['LX-01', 'LX-02']);
  assert.deepEqual(r.steps[1], 'LX-01 + LX-02 = 1,240.00');
});

test('steps: unicode multiplication with parenthetical values structures', () => {
  const r = ledgerRoutine(['Base Widget (2,000) × Zone Rate (4.50%)']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Base Widget (2,000) × Zone Rate (4.50%)');
  assert.deepEqual(det.inputs, ['Base Widget', 'Zone Rate']);
  assert.equal(det.output, undefined);
});

test('steps: embedded arithmetic core extracts from a labelled breakdown line', () => {
  const r = ledgerRoutine(['LX-NET Ledger net subtotal LX-01 + LX-02 — 1,240.00']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'LX-01 + LX-02');
  assert.deepEqual(det.inputs, ['LX-01', 'LX-02']);
  assert.equal(det.output, 'LX-NET');
  assert.deepEqual(r.steps[0], 'LX-NET Ledger net subtotal LX-01 + LX-02 — 1,240.00');
});

test('steps: lookups parse with structure; prose without structure stays minimal', () => {
  const r = ledgerRoutine([
    'Find the ledger rate for ledger_class in Schedule L.',
    'Find time in review.',
  ]);
  assert.equal(r.steps_detailed[0].operation, 'lookup');
  assert.equal(r.steps_detailed[0].output, 'ledger_rate');
  assert.deepEqual(r.steps_detailed[0].inputs, ['ledger_class']);
  assert.deepEqual(r.steps_detailed[0].depends_on, ['Schedule L']);
  assert.equal(r.steps_detailed[1].operation, undefined);
  assert.equal(r.steps_detailed[1].expression, undefined);
  assert.equal(r.steps_detailed[1].interpretation_status, undefined);
});

test('steps: rounding parses in directive and summary forms without inventing targets', () => {
  const r = ledgerRoutine([
    'Rounded Half-Up to Nearest Coin',
    'Round ledger_total to the nearest whole coin. Store the result as billed_total.',
    'Total 100 + fee, rounded to nearest coin',
  ]);
  assert.equal(r.steps_detailed[0].operation, 'rounding');
  assert.equal(r.steps_detailed[0].output, undefined);
  assert.equal(r.steps_detailed[0].operand, undefined);
  assert.equal(r.steps_detailed[0].interpretation_status, 'inferred');
  assert.equal(r.steps_detailed[1].operation, 'rounding');
  assert.equal(r.steps_detailed[1].operand, 'ledger_total');
  assert.equal(r.steps_detailed[1].output, 'billed_total');
  assert.deepEqual(r.steps_detailed[1].inputs, ['ledger_total']);
  assert.equal(r.steps_detailed[2].operation, 'rounding');
  assert.equal(r.steps_detailed[2].output, undefined);
});

test('steps: descriptive text stays verbatim without invented operations', () => {
  const lines = [
    'Standard ledger bracket (2–10 years).',
    'Fixed annual standard.',
    'Review P/C guidelines.',
    'Apply risk - adjusted factor.',
    'Earned discount applied on base gross (20.00%).',
  ];
  const r = ledgerRoutine(lines);
  assert.deepEqual(r.steps, lines);
  for (const det of r.steps_detailed) {
    assert.equal(det.operation, undefined);
    assert.equal(det.expression, undefined);
    assert.equal(det.output, undefined);
    assert.equal(det.interpretation_status, undefined);
  }
});

test('steps: incomplete expressions stay unparsed instead of inventing operands', () => {
  const lines = ['ledger_total = ', 'alpha_rate + ', '+ beta_fee', 'LX-01 + LX-02 = '];
  const r = ledgerRoutine(lines);
  assert.deepEqual(r.steps, lines);
  for (const det of r.steps_detailed) {
    assert.equal(det.operation, undefined);
    assert.equal(det.expression, undefined);
    assert.equal(det.output, undefined);
    assert.equal(det.inputs, undefined);
    assert.equal(det.interpretation_status, undefined);
  }
});

test('steps: source order, labels, pages, and evidence are preserved', () => {
  const lines = ['Step 1: LX-01 + LX-02', 'Step 4: Rounded Half-Up to Nearest Coin', 'Step 9: Fixed annual standard.'];
  const r = ledgerRoutine(lines);
  assert.deepEqual(r.steps, lines);
  assert.deepEqual(r.source_pages, [2]);
  assert.equal(r.evidence_text, 'synthetic ledger calculation steps');
  assert.equal(r.steps_detailed[0].operation, 'expression');
  assert.equal(r.steps_detailed[1].operation, 'rounding');
  assert.equal(r.steps_detailed[2].operation, undefined);
});

// ---------- workbook + validation assertions ----------

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

function mixedJob() {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: ['LX-01 + LX-02', 'Rounded Half-Up to Nearest Coin', 'Fixed annual standard.'],
      }],
    })
  );
  job.issues = validateJob(job);
  return job;
}

test('steps: workbook shows evidenced operations and reserves REVIEW for unparsed lines', () => {
  const job = mixedJob();
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.deepEqual(steps.body, [
    ['1', 'LX-01 + LX-02', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 1)'],
    ['2', 'Rounded Half-Up to Nearest Coin', 'R', '', 'Half-Up to Nearest Coin', '', 'Round Half-Up to Nearest Coin (source step 2)'],
    ['3', 'Fixed annual standard.', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 3)'],
  ]);
});

test('steps: incomplete calculations warn without blocking export', () => {
  const job = mixedJob();
  assert.ok(job.issues.every((i) => i.severity === 'warning'));
  assert.ok(job.issues.some((i) => /calculation without a target variable/.test(i.message) && /Step 1/.test(i.message)));
  assert.ok(job.issues.some((i) => /Rounding step 2/.test(i.message) && /no target/.test(i.message)));
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message) && /step 3/.test(i.message)));
  const unresolved = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Unresolved items');
  assert.ok(unresolved !== null && unresolved.body.length >= 3);
});

test('steps: complete structured steps warn about nothing', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      tables: [{
        name: 'Schedule L', sourcePages: [1], evidenceText: 'ledger rate schedule in dollars per class',
        headers: ['Ledger Class', 'Rate'], rows: [['C1', '12.00']],
      }],
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          'Find the ledger rate for ledger_class in Schedule L.',
          'ledger_total = ledger_rate + base_fee.',
          'Round ledger_total to the nearest whole coin. Store the result as billed_total.',
        ],
        dependsOn: ['Schedule L', 'ledger_class', 'base_fee'],
        inputs: ['ledger_class', 'base_fee'],
        outputs: ['billed_total'],
      }],
    })
  );
  const issues = validateJob(job);
  assert.deepEqual(issues, [], `expected zero issues, got: ${issues.map((i) => i.message).join(' | ')}`);
});

test('steps: mixed breakdown workbook builds are byte-deterministic', () => {
  const a = buildWorkbookXlsx(mixedJob(), { source: 'recorded' });
  const b = buildWorkbookXlsx(mixedJob(), { source: 'recorded' });
  assert.ok(a.equals(b), 'expected identical bytes for identical input');
});

// ---------- explicit-step normalization regressions ----------
// Model-provided steps sometimes carry word operations (multiply/add/round)
// with worked-example amounts mixed into inputs/outputs. Generic
// normalization must place explicit lookups, arithmetic, intermediate
// outputs, and rounding in the correct columns, keep worked values as
// evidence only, and demote descriptive prose without an evidenced
// operator to unparsed (marked for review) instead of inventing logic.

function explicitLedgerRoutine(stepObjects) {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: stepObjects,
      }],
    })
  );
  return job.routines[0];
}

test('steps: explicit word operations normalize with worked values stripped', () => {
  const r = explicitLedgerRoutine([
    {
      sequence: 1,
      instruction: 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)',
      operation: 'multiply',
      expression: 'Vehicle Units (2,000) × Zone Rate (4.50%)',
      inputs: ['Vehicle Units (2,000)', 'Zone Rate (4.50%)'],
      output: 'LX-01 = 90.00',
    },
    {
      sequence: 4,
      instruction: 'LX-NET Ledger net subtotal LX-01 + LX-02',
      operation: 'add',
      expression: 'LX-01 + LX-02',
      inputs: ['LX-01', 'LX-02'],
      output: 'LX-NET = 1,240.00',
    },
  ]);
  assert.deepEqual(r.steps, [
    'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)',
    'LX-NET Ledger net subtotal LX-01 + LX-02',
  ]);
  const [first, second] = r.steps_detailed;
  assert.equal(first.operation, 'expression');
  assert.equal(first.expression, 'Vehicle Units (2,000) × Zone Rate (4.50%)');
  assert.deepEqual(first.inputs, ['Vehicle Units', 'Zone Rate']);
  assert.equal(first.output, 'LX-01');
  assert.equal(second.operation, 'expression');
  assert.equal(second.expression, 'LX-01 + LX-02');
  assert.deepEqual(second.inputs, ['LX-01', 'LX-02']);
  assert.equal(second.output, 'LX-NET');
});

test('steps: explicit lookup and rounding place targets correctly without worked amounts', () => {
  const r = explicitLedgerRoutine([
    {
      sequence: 6,
      instruction: 'LX-TP Ledger statutory tariff Mandated rate for widget class',
      operation: 'lookup',
      expression: 'Mandated rate for widget class',
      inputs: ['Widget Tier 2'],
      output: 'LX-TP = 340.00',
    },
    {
      sequence: 10,
      instruction: 'Rounded Half-Up to Nearest Coin',
      operation: 'round',
      expression: 'Rounded Half-Up to Nearest Coin',
      inputs: ['LX-TOTAL'],
      output: '1,240.00',
    },
  ]);
  const [lookup, rounding] = r.steps_detailed;
  assert.equal(lookup.operation, 'lookup');
  assert.equal(lookup.output, 'LX-TP');
  assert.deepEqual(lookup.inputs, ['Widget Tier 2']);
  assert.equal(rounding.operation, 'rounding');
  assert.equal(rounding.output, undefined);
  assert.deepEqual(rounding.inputs, ['LX-TOTAL']);
  assert.deepEqual(r.steps[1], 'Rounded Half-Up to Nearest Coin');
});

test('steps: explicit word operation without an evidenced operator stays unparsed', () => {
  const instruction = 'Ledger factor loading Standard bracket Flat Factor 1.000000';
  const r = explicitLedgerRoutine([
    {
      sequence: 2,
      instruction,
      operation: 'multiply',
      expression: 'Standard bracket Flat Factor 1.000000',
      inputs: ['Standard bracket'],
      output: 'LX-F1 = 0.00',
    },
  ]);
  assert.deepEqual(r.steps, [instruction]);
  const det = r.steps_detailed[0];
  assert.equal(det.instruction, instruction);
  assert.equal(det.operation, undefined);
  assert.equal(det.expression, undefined);
  assert.equal(det.output, undefined);
  assert.equal(det.inputs, undefined);
  assert.equal(det.interpretation_status, undefined);
});

test('steps: explicit-step workbook splits calculations and flags long descriptives', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          {
            sequence: 1,
            instruction: 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)',
            operation: 'multiply',
            expression: 'Vehicle Units (2,000) × Zone Rate (4.50%)',
            inputs: ['Vehicle Units (2,000)', 'Zone Rate (4.50%)'],
            output: 'LX-01 = 90.00',
          },
          {
            sequence: 2,
            instruction: 'LX-F1 Ledger factor loading Standard bracket Flat Factor 1.000000',
            operation: 'multiply',
            expression: 'Standard bracket Flat Factor 1.000000',
            inputs: ['Standard bracket'],
            output: 'LX-F1 = 0.00',
          },
          {
            sequence: 10,
            instruction: 'Rounded Half-Up to Nearest Coin',
            operation: 'round',
            expression: 'Rounded Half-Up to Nearest Coin',
            inputs: ['LX-TOTAL'],
            output: '1,240.00',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.deepEqual(steps.header, ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment']);
  assert.equal(steps.body.length, 4);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'LX-01', '<--', '', 'Vehicle Units', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '×', '', 'Zone Rate', '']);
  assert.ok(!steps.body[0][4].includes('90.00'), 'worked amount must not leak into Operand');
  assert.deepEqual(steps.body[2].slice(0, 6), ['2', 'LX-F1 Ledger factor loading Standard bracket Flat Factor 1.000000', 'REVIEW', '', '', '']);
  assert.deepEqual(steps.body[3].slice(0, 6), ['10', 'Rounded Half-Up to Nearest Coin', 'R', '', 'Half-Up to Nearest Coin', '']);
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message) && /step 2/.test(i.message)));
  assert.ok(job.issues.some((i) => /Rounding step 10/.test(i.message) && /no target/.test(i.message)));
});

// ---------- explicit rate-routine column regressions ----------
// Explicit model steps must map to the established seven columns with clean
// output variables, operators (<--, +, *, R), and operands — not long
// descriptive text in Instruction or unnecessary REVIEW rows. Synthetic
// ledger fixtures only; no production names or values.

test('steps: explicit assignment with output and value phrase stays as assignment', () => {
  const r = explicitLedgerRoutine([
    {
      sequence: 7,
      instruction: 'LX-PA Ledger personal cover Fixed Annual Standard',
      operation: 'assignment',
      expression: 'Fixed Annual Standard',
      inputs: ['Standard'],
      output: 'LX-PA = 375.00',
    },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'assignment');
  assert.equal(det.output, 'LX-PA');
  assert.equal(det.expression, 'Fixed Annual Standard');
  assert.deepEqual(det.inputs, ['Standard']);
});

test('steps: explicit assignment workbook shows clean output with <-- and value operand', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          {
            sequence: 7,
            instruction: 'LX-PA Ledger personal cover Fixed Annual Standard',
            operation: 'assignment',
            expression: 'Fixed Annual Standard',
            inputs: ['Standard'],
            output: 'LX-PA = 375.00',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['7', 'LX-PA', '<--', '', 'Fixed Annual Standard', '']);
  assert.ok(!job.issues.some((i) => /without an evidenced operation/.test(i.message)));
});

test('steps: explicit calculation with output renders clean and expands hyphenated codes', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          {
            sequence: 4,
            instruction: 'LX-NET Ledger net subtotal LX-01 + LX-02',
            operation: 'add',
            expression: 'LX-01 + LX-02',
            inputs: ['LX-01', 'LX-02'],
            output: 'LX-NET = 1,240.00',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['4.1', 'LX-NET', '<--', '', 'LX-01', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['4.2', '', '+', '', 'LX-02', '']);
});

test('steps: explicit multiplication splits phrase operands into continuation rows', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          {
            sequence: 1,
            instruction: 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)',
            operation: 'multiply',
            expression: 'Vehicle Units (2,000) × Zone Rate (4.50%)',
            inputs: ['Vehicle Units (2,000)', 'Zone Rate (4.50%)'],
            output: 'LX-01 = 90.00',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'LX-01', '<--', '', 'Vehicle Units', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '×', '', 'Zone Rate', '']);
  assert.ok(!steps.body[0][4].includes('90.00'), 'worked output amount must not leak into Operand');
});

test('steps: explicit lookup with keys but no table renders clean assignment', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          {
            sequence: 6,
            instruction: 'LX-TP Ledger statutory tariff Mandated rate for widget class',
            operation: 'lookup',
            expression: 'Mandated rate for widget class',
            inputs: ['Widget Tier 2'],
            output: 'LX-TP = 340.00',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'lookup');
  assert.equal(det.output, 'LX-TP');
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['6', 'LX-TP', '<--', '', 'Widget Tier 2', '']);
});

test('steps: explicit rounding with hyphenated target renders clean with source and wording', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [
          {
            sequence: 10,
            instruction: 'Round LX-TOTAL to the nearest whole coin. Store the result as LX-BILLED.',
            operation: 'round',
            expression: 'Round LX-TOTAL to the nearest whole coin',
            inputs: ['LX-TOTAL'],
            output: 'LX-BILLED',
          },
        ],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.equal(steps.body[0][0], '10');
  assert.equal(steps.body[0][1], 'LX-BILLED');
  assert.equal(steps.body[0][2], 'R');
  assert.ok(steps.body[0][4].includes('LX-TOTAL'), `operand should carry source, got: ${steps.body[0][4]}`);
  assert.ok(steps.body[0][4].includes('nearest whole coin'), `operand should carry wording, got: ${steps.body[0][4]}`);
});

// ---------- code-led plain-string step regressions ----------
// Breakdown rows extracted as plain strings ("CODE description ...") must
// map a leading code to Instruction with Op <-- and the stated remainder
// as Operand — not REVIEW — while genuinely ambiguous multi-part lines
// without a code or explicit operator stay REVIEW. Synthetic ledger
// fixtures only; no production names or values.

test('steps: code-led mixed label and calculation stays REVIEW without isolated operands', () => {
  const line = 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)';
  const r = ledgerRoutine([line]);
  assert.deepEqual(r.steps, [line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.output, undefined);
  assert.equal(det.expression, undefined);
});

test('steps: code-led mixed workbook stays REVIEW without isolated operands', () => {
  const line = 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [line],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', line, 'REVIEW', '', '', '']);
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message)));
});

test('steps: code-led long description without operator stays REVIEW', () => {
  const line = 'LX-F1 Ledger factor loading Standard bracket Flat Factor 1.000000';
  const r = ledgerRoutine([line]);
  assert.deepEqual(r.steps, [line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.output, undefined);
  assert.equal(det.expression, undefined);
});

test('steps: code-led long description workbook stays REVIEW', () => {
  const line = 'LX-F1 Ledger factor loading Standard bracket Flat Factor 1.000000';
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [line],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', line, 'REVIEW', '', '', '']);
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message)));
});

test('steps: multi-part line without code or operator stays REVIEW', () => {
  const line = 'TOTAL LEDGER PREMIUM PAYABLE Net Premium: 37,531.00 | Statutory Levy @ 18.00%: 6,755.58';
  const r = ledgerRoutine([line]);
  assert.deepEqual(r.steps, [line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.expression, undefined);
  assert.equal(det.output, undefined);
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps: [line],
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', line, 'REVIEW', '', '', '']);
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message)));
});

// ---------- reference-layout mapping regressions ----------
// Instruction holds only the output variable, a condition keyword, or a
// source-supported name — never an arithmetic expression. Op holds <--,
// a condition marker, or one arithmetic operator. Operand holds exactly
// one variable, table invocation, calculated variable, or code parameter
// per row; multi-operand calculations split into continuation rows with
// blank Instruction in source order. Synthetic fixtures only.

function layoutJob(steps, tables = []) {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      tables,
      routines: [{
        name: 'LX — Ledger Fee Calc',
        kind: 'calculation_steps',
        sourcePages: [2],
        evidenceText: 'synthetic ledger calculation steps',
        steps,
      }],
    })
  );
  job.issues = validateJob(job);
  return job;
}

test('steps: addition with leading code splits into continuation rows', () => {
  const job = layoutJob(['LX-NET Ledger net subtotal LX-01 + LX-02']);
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'LX-NET');
  assert.equal(det.expression, 'LX-01 + LX-02');
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'LX-NET', '<--', '', 'LX-01', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '+', '', 'LX-02', '']);
});

test('steps: table lookup renders one invocation operand row', () => {
  const job = layoutJob(
    ['Look up ledger_rate from Schedule L using ledger_class.'],
    [{
      name: 'Schedule L', sourcePages: [1], evidenceText: 'ledger rate schedule',
      headers: ['Ledger Class', 'Rate'], rows: [['C1', '12.00']],
    }]
  );
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', 'ledger_rate', '<--', '', 'table:Schedule L (ledger_class)', '']);
});

test('steps: condition renders IF branch rows with single operands', () => {
  const job = layoutJob(['If ledger_class is Tier 2, set ledger_rate to high_rate, otherwise set ledger_rate to low_rate.']);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  const kinds = steps.body.map((row) => row[1]);
  assert.ok(kinds.includes('IF'), `expected IF row, got: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('ELSE'), `expected ELSE row, got: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('ENDIF'), `expected ENDIF row, got: ${JSON.stringify(kinds)}`);
  const branchTrue = steps.body.find((row) => row[1] === 'ledger_rate' && row[2] === '<--' && row[4] === 'high_rate');
  const branchFalse = steps.body.find((row) => row[1] === 'ledger_rate' && row[2] === '<--' && row[4] === 'low_rate');
  assert.ok(branchTrue, `expected true branch ledger_rate <-- high_rate, got: ${JSON.stringify(steps.body)}`);
  assert.ok(branchFalse, `expected false branch ledger_rate <-- low_rate, got: ${JSON.stringify(steps.body)}`);
});

test('steps: multi-row expression keeps source order across continuation rows', () => {
  const job = layoutJob([{
    sequence: 5,
    instruction: 'LX-SUM Ledger staged total',
    operation: 'add',
    expression: 'LX-01 + LX-02 + LX-03',
    inputs: ['LX-01', 'LX-02', 'LX-03'],
    output: 'LX-SUM',
  }]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 3);
  assert.deepEqual(steps.body.map((row) => row[0]), ['5.1', '5.2', '5.3']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '+', '+']);
  assert.deepEqual(steps.body.map((row) => row[4]), ['LX-01', 'LX-02', 'LX-03']);
  assert.equal(steps.body[0][1], 'LX-SUM');
  assert.equal(steps.body[1][1], '');
  assert.equal(steps.body[2][1], '');
});

test('steps: short code-led value maps as single-operand assignment', () => {
  const job = layoutJob(['LX-STD Standard']);
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'assignment');
  assert.equal(det.output, 'LX-STD');
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', 'LX-STD', '<--', '', 'Standard', '']);
});
