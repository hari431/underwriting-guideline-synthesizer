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
      [...m[2].matchAll(/<c r="[A-Z]+\d+"(?: t="s"(?: s="\d+")?><v>(\d+)<\/v><\/c>|\/>)/g)]
        .map((c) => (c[1] === undefined ? '' : (items[Number(c[1])] ?? '')))
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

// ---------- trailing-assignment regressions ----------
// Calculation steps that state prose before an explicit `output = rhs`
// assignment (after a colon, with lookup context, or several assignments
// separated by semicolons) must derive the structured operation instead of
// staying REVIEW. Function-call right-hand sides keep the call as one
// operand without treating the function name as a variable. Synthetic
// ledger fixtures only; no production names or values.

test('steps: trailing assignment after prose parses as expression', () => {
  const r = ledgerRoutine([
    'Step 1: Retrieve base tariff Rbase from Schedule L matching tier and zone. Compute gross base: Premstep1=declared_value*Rbase',
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'Premstep1');
  assert.equal(det.expression, 'Premstep1 = declared_value*Rbase');
  assert.deepEqual(det.inputs, ['declared_value', 'Rbase']);
  assert.equal(det.interpretation_status, 'inferred');
});

test('steps: trailing assignment workbook splits into continuation rows', () => {
  const job = layoutJob([
    'Step 1: Retrieve base tariff Rbase from Schedule L matching tier and zone. Compute gross base: Premstep1=declared_value*Rbase',
  ]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'Premstep1', '<--', '', 'declared_value', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '*', '', 'Rbase', '']);
});

test('steps: semicolon-separated assignments keep the final output', () => {
  const r = ledgerRoutine([
    'Step 7: Retrieve discount rate Dncb from Schedule L. Discount and net: Discncb=Premstep6*Dncb; Premstep7=Premstep6-Discncb',
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'Premstep7');
  assert.equal(det.expression, 'Discncb = Premstep6*Dncb; Premstep7 = Premstep6 - Discncb');
  assert.deepEqual(det.inputs, ['Premstep6', 'Dncb']);
  const job = layoutJob([
    'Step 7: Retrieve discount rate Dncb from Schedule L. Discount and net: Discncb=Premstep6*Dncb; Premstep7=Premstep6-Discncb',
  ]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 4);
  assert.deepEqual(steps.body.map((row) => row[0]), ['7.1', '7.2', '7.3', '7.4']);
  assert.deepEqual(steps.body[0].slice(0, 6), ['7.1', 'Discncb', '<--', '', 'Premstep6', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['7.2', '', '*', '', 'Dncb', '']);
  assert.deepEqual(steps.body[2].slice(0, 6), ['7.3', 'Premstep7', '<--', '', 'Premstep6', '']);
  assert.deepEqual(steps.body[3].slice(0, 6), ['7.4', '', '-', '', 'Discncb', '']);
  assert.match(steps.body[3][6], /uses Discncb from step 7\.1/);
});

test('steps: function-call right-hand side stays one operand without function inputs', () => {
  const r = ledgerRoutine([
    'Step 15: Round the aggregate premium to two decimals using half-up rounding: Prempretax=round_half_up(Premstep14;2)',
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'rounding');
  assert.equal(det.output, 'Prempretax');
  assert.deepEqual(det.inputs, ['Premstep14']);
  const job = layoutJob([
    'Step 15: Round the aggregate premium to two decimals using half-up rounding: Prempretax=round_half_up(Premstep14;2)',
  ]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.equal(steps.body[0][1], 'Prempretax');
  assert.equal(steps.body[0][2], 'R');
  assert.ok(steps.body[0][4].includes('Premstep14'));
});

test('steps: function factor in arithmetic splits around the call', () => {
  const job = layoutJob([{
    sequence: 1,
    instruction: 'Ledger rider premium',
    operation: 'expression',
    expression: 'PremiumZ=declared_value*RateZ(vehicle_age)',
    inputs: ['declared_value', 'vehicle_age'],
    output: 'PremiumZ',
  }]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'PremiumZ', '<--', '', 'declared_value', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '*', '', 'RateZ(vehicle_age)', '']);
});

test('steps: currency amount in arithmetic splits as one value operand', () => {
  const job = layoutJob([
    'Step 14: If ledger cover is applicable, add fixed charge: Premstep14=Premstep13+$37.50',
  ]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  const kinds = steps.body.map((row) => row[1]);
  assert.ok(kinds.includes('IF'));
  assert.ok(kinds.includes('ENDIF'));
  const first = steps.body.find((row) => row[1] === 'Premstep14' && row[2] === '<--');
  assert.ok(first, `expected branch ledger assignment, got: ${JSON.stringify(steps.body)}`);
  assert.equal(first[4], 'Premstep13');
  const cont = steps.body.find((row) => row[1] === '' && row[2] === '+');
  assert.ok(cont, `expected branch continuation row, got: ${JSON.stringify(steps.body)}`);
  assert.equal(cont[4], '$37.50');
});

test('steps: multi-operand branch assignment splits into continuation rows', () => {
  const job = layoutJob([
    'If opt_rider == TRUE, compute rider cost: Premstep9=Premstep8+PremiumZ',
  ]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  const kinds = steps.body.map((row) => row[1]);
  assert.ok(kinds.includes('IF'));
  assert.ok(kinds.includes('ENDIF'));
  const first = steps.body.find((row) => row[1] === 'Premstep9' && row[2] === '<--');
  assert.ok(first, `expected branch assignment, got: ${JSON.stringify(steps.body)}`);
  assert.equal(first[4], 'Premstep8');
  const cont = steps.body.find((row) => row[1] === '' && row[2] === '+');
  assert.ok(cont, `expected branch continuation row, got: ${JSON.stringify(steps.body)}`);
  assert.equal(cont[4], 'PremiumZ');
});

test('steps: lookup context without an assignment stays REVIEW', () => {
  const line = 'Retrieve base tariff Rbase from Schedule L matching tier and zone.';
  const r = ledgerRoutine([line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.output, undefined);
  assert.equal(det.expression, undefined);
});

// ---------- reference-format lookup regressions ----------
// Table lookups render as one row: the retrieved variable under
// Instruction, `<--` under Op, and exactly one table invocation with its
// keys under Operand. Synthetic ledger fixtures only.

test('steps: table lookup renders one invocation row per reference format', () => {
  const job = layoutJob(
    ['Step 2: Retrieve ledger_factor from Schedule L using ledger_class.'],
    [{
      name: 'Schedule L', sourcePages: [1], evidenceText: 'ledger rate schedule',
      headers: ['Ledger Class', 'Rate'], rows: [['C1', '12.00']],
    }]
  );
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'lookup');
  assert.equal(det.output, 'ledger_factor');
  assert.deepEqual(det.inputs, ['ledger_class']);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['2', 'ledger_factor', '<--', '', 'table:Schedule L (ledger_class)', '']);
});

test('steps: multi-key lookup keeps one invocation operand row', () => {
  const job = layoutJob(
    ['Look up ledger_rate from Schedule L using ledger_class and ledger_tier.'],
    [{
      name: 'Schedule L', sourcePages: [1], evidenceText: 'ledger rate schedule',
      headers: ['Ledger Class', 'Tier', 'Rate'], rows: [['C1', 'T1', '12.00']],
    }]
  );
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', 'ledger_rate', '<--', '', 'table:Schedule L (ledger_class, ledger_tier)', '']);
});

// ---------- code-led phrase calculation regressions ----------
// Breakdown rows stating a leading code, a descriptive label, and a phrase
// calculation with worked-amount groups (`CODE label PhraseA (1,000) ×
// PhraseB (2.50%) [trailing worked columns]`) must isolate the operator
// core: the code becomes the output, each amount group stays attached to
// its phrase for the expression, and reusable operands strip to clean
// terms. Trailing worked columns never leak into operands. Synthetic
// ledger fixtures only; no production names or values.

test('steps: code-led phrase multiplication isolates operands from label', () => {
  const line = 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)';
  const r = ledgerRoutine([line]);
  assert.deepEqual(r.steps, [line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'LX-01');
  assert.equal(det.expression, 'Vehicle Units (2,000) × Zone Rate (4.50%)');
  assert.deepEqual(det.inputs, ['Vehicle Units', 'Zone Rate']);
  assert.equal(det.interpretation_status, 'inferred');
});

test('steps: code-led phrase workbook splits with clean reusable operands', () => {
  const line = 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%)';
  const job = layoutJob([line]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'LX-01', '<--', '', 'Vehicle Units', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '×', '', 'Zone Rate', '']);
  assert.ok(!steps.body[0][4].includes('2,000'), 'worked amount must not leak into Operand');
  assert.ok(!steps.body[1][4].includes('4.50'), 'worked amount must not leak into Operand');
  assert.ok(!job.issues.some((i) => /without an evidenced operation/.test(i.message)));
});

test('steps: code-led phrase with trailing worked columns strips the tail', () => {
  const line = 'LX-01 Ledger base fee Vehicle Units (2,000) × Zone Rate (4.50%) 2,000 Units 0.045000 90.00';
  const r = ledgerRoutine([line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'LX-01');
  assert.equal(det.expression, 'Vehicle Units (2,000) × Zone Rate (4.50%)');
  assert.deepEqual(det.inputs, ['Vehicle Units', 'Zone Rate']);
  const job = layoutJob([line]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 2);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1.1', 'LX-01', '<--', '', 'Vehicle Units', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['1.2', '', '×', '', 'Zone Rate', '']);
});

test('steps: code-led three-part phrase addition splits in source order', () => {
  const line = 'LX-SUM Ledger staged total Base Amount (100) + Fee Amount (20) + Tax Amount (5)';
  const job = layoutJob([line]);
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'LX-SUM');
  assert.deepEqual(det.inputs, ['Base Amount', 'Fee Amount', 'Tax Amount']);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 3);
  assert.deepEqual(steps.body.map((row) => row[0]), ['1.1', '1.2', '1.3']);
  assert.deepEqual(steps.body.map((row) => row[2]), ['<--', '+', '+']);
  assert.deepEqual(steps.body.map((row) => row[4]), ['Base Amount', 'Fee Amount', 'Tax Amount']);
  assert.equal(steps.body[0][1], 'LX-SUM');
  assert.equal(steps.body[1][1], '');
  assert.equal(steps.body[2][1], '');
});

// ---------- ambiguous breakdown-row negatives ----------
// These shapes state no explicit operator, assignment, or lookup: a
// bracket range with a factor, "applied on" prose with a percent,
// "rate: X% on BASE" wording, tier/range qualifiers, and a trailing
// value phrase beside an amount. Each must stay REVIEW with its source
// text preserved — inferring ×, a table, or an operand from actuarial
// plausibility would be guessing. In particular, positional value
// extraction is unsound: the same trailing position holds a base in one
// row and a value phrase in another, so neither can be isolated
// reliably. Synthetic ledger fixtures only.

function assertStaysReview(line) {
  const r = ledgerRoutine([line]);
  assert.deepEqual(r.steps, [line]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.output, undefined);
  assert.equal(det.expression, undefined);
  const job = layoutJob([line]);
  const steps = sectionRows(routineSheetValues(job, 'LX — Ledger Fee Calc'), 'Steps');
  assert.equal(steps.body.length, 1);
  assert.deepEqual(steps.body[0].slice(0, 6), ['1', line, 'REVIEW', '', '', '']);
}

test('steps: bracket range with factor stays REVIEW without lookup syntax', () => {
  // No lookup verb, table reference, or operator: the range selects an
  // instance bracket and the factor value is instance-specific.
  assertStaysReview('LX-F1 Ledger age loading Standard ledger bracket (25–55 Years) Flat Factor 1.000000 0.00');
});

test('steps: applied-on prose with percent stays REVIEW without an operator', () => {
  // "applied on" is prose, not ×; negative signs mark value polarity,
  // not subtraction; no operator joins the base and the percent.
  assertStaysReview('LX-D1 Ledger discount Earned discount applied on Base Gross (20.00%) Subtotal Ledger -0.200000 -6,560.00');
});

test('steps: colon rate with on-phrase stays REVIEW without an operator', () => {
  // The colon labels the rate and "on" is a preposition; neither states
  // the multiplication joining the base and the percent.
  assertStaysReview('LX-R1 Ledger rider Actuarial fixed rate: 0.750% on Ledger Value 0.007500 7,500.00');
});

test('steps: tier and range qualifiers stay REVIEW without a table reference', () => {
  // Tier and range phrases qualify applicability; with no lookup verb or
  // table reference no table invocation can be evidenced.
  assertStaysReview('LX-S1 Ledger statutory tariff Mandated rate for items > 1,000cc up to 1,500cc Engine Tier 2 Statutory 3,416.00');
});

test('steps: trailing value phrase stays REVIEW without a delimiter', () => {
  // No `=` or operator delimits the value phrase from the description,
  // and the same trailing position holds a base elsewhere — see the
  // applied-on shape above — so positional extraction would guess.
  assertStaysReview('LX-P1 Ledger cover (Owner, 15 Lakhs SI) Fixed Annual Standard 375.00');
});

// ---------- code-evidenced REVIEW display ----------
// A REVIEW step whose source grid row evidences a `code` cell shows the code
// alone under Instruction with Operand left blank: a description in Operand
// would read as a calculation operand, which a flagged row must never imply.
// Op stays REVIEW and the complete verbatim text is kept in Source evidence.
// No operation is inferred — the model data is untouched. Steps without a
// code cell keep the full text under Instruction.

function evidenceBlock(values) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === 'Source evidence');
  if (idx < 0) return null;
  const body = [];
  for (let i = idx + 1; i < values.length; i += 1) {
    if (values[i].length === 1) break;
    body.push(values[i]);
  }
  return body;
}

test('steps: REVIEW with evidenced code shows code-only Instruction and description Operand', () => {
  const line = 'LX-F1 Ledger factor loading Standard bracket Flat Factor 1.000000';
  const plain = { sequence: 3, instruction: 'Step 3: Fixed annual standard.' };
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
            sequence: 2,
            instruction: line,
            cells: {
              code: 'LX-F1',
              formula: 'Ledger factor loading Standard bracket',
              basis: 'Flat Factor',
              factor: '1.000000',
              amount: '0.00',
            },
          },
          plain,
        ],
      }],
    })
  );
  // Model data is untouched: no operation, output, or table link invented.
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.output, undefined);
  assert.equal(det.depends_on, undefined);
  assert.equal(det.instruction, line);
  assert.equal(job.routines[0].steps[0], line);
  job.issues = validateJob(job);
  assert.ok(job.issues.some((i) => /without an evidenced operation/.test(i.message)));
  const values = routineSheetValues(job, 'LX — Ledger Fee Calc');
  const steps = sectionRows(values, 'Steps');
  assert.deepEqual(steps.body, [
    ['2', 'LX-F1', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 2)'],
    ['3', 'Step 3: Fixed annual standard.', 'REVIEW', '', '', '', 'Needs review — no evidenced operation (source step 3)'],
  ]);
  // Operand stays blank: no structured operand is evidenced, and the prose
  // description must not pose as one. The full phrase appears nowhere in Steps.
  assert.equal(steps.body[0][4], '');
  assert.ok(!steps.body.flat().includes(line));
  // The complete original text survives in Source evidence.
  const evidence = evidenceBlock(values);
  assert.ok(evidence.some((row) => row[0] === 'Step 2 text' && row[1] === line));
});

test('steps: multi-word assignment outputs keep their full name; verbs do not join them', () => {
  const r = ledgerRoutine([
    'Step 1: Ledger step2 = Ledgerstep1 x Feeconst',
    'Step 2: Calculate ledger_net = ledger_gross - ledger_fee',
  ]);
  assert.equal(r.steps_detailed[0].output, 'Ledger step2');
  assert.equal(r.steps_detailed[0].expression, 'Ledger step2 = Ledgerstep1 x Feeconst');
  assert.deepEqual(r.steps_detailed[0].inputs, ['Ledgerstep1', 'Feeconst']);
  assert.equal(r.steps_detailed[1].output, 'ledger_net');
  assert.deepEqual(r.steps_detailed[1].inputs, ['ledger_gross', 'ledger_fee']);
});

test('steps: infix x reads as multiply but a variable named x survives', () => {
  const r = ledgerRoutine([
    'Step 1: net = base x factor',
    'Step 2: y = x * 2',
  ]);
  assert.equal(r.steps_detailed[0].expression, 'net = base x factor');
  assert.deepEqual(r.steps_detailed[0].inputs, ['base', 'factor']);
  assert.equal(r.steps_detailed[1].expression, 'y = x * 2');
  assert.deepEqual(r.steps_detailed[1].inputs, ['x']);
});

test('steps: unseparated assignments in one instruction parse in source order', () => {
  const r = ledgerRoutine([
    'Step 1: Sum the riders: Ledger riders = LX-R1+LX-R2 Ledger subtotal = Ledger core + Ledger riders',
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'Ledger subtotal');
  assert.equal(det.expression, 'Ledger riders = LX-R1+LX-R2; Ledger subtotal = Ledger core + Ledger riders');
  assert.deepEqual(det.inputs, ['LX-R1', 'LX-R2', 'Ledger core']);
});

test('steps: ambiguous instruction boundaries never promote into the expression', () => {
  const instruction = 'Blend: Gross levy = subtotal + fire levy final = max(minimum, gross)';
  const r = ledgerRoutine([{
    sequence: 1,
    instruction,
    operation: 'expression',
    expression: 'levy final = max(minimum, gross)',
    inputs: ['minimum', 'gross'],
    output: 'levy final',
  }]);
  const det = r.steps_detailed[0];
  // The first assignment's boundary is uncertain ("subtotal +" tails into
  // the next output), so the structured expression stays exactly as stated.
  assert.equal(det.expression, 'levy final = max(minimum, gross)');
  assert.equal(det.output, 'levy final');
  assert.equal(det.instruction, instruction);
});

test('steps: instruction assignments promote into a single-assignment expression in order', () => {
  const r = ledgerRoutine([{
    sequence: 1,
    instruction: 'Sum the riders: Ledger riders = LX-R1+LX-R2 Ledger subtotal = Ledger core + Ledger riders',
    operation: 'expression',
    expression: 'Ledger subtotal = Ledger core + Ledger riders',
    inputs: ['Ledger core', 'LX-R1', 'LX-R2'],
    output: 'Ledger subtotal',
  }]);
  const det = r.steps_detailed[0];
  assert.equal(det.expression, 'Ledger riders = LX-R1+LX-R2; Ledger subtotal = Ledger core + Ledger riders');
  assert.equal(det.output, 'Ledger subtotal');
  assert.equal(det.instruction, 'Sum the riders: Ledger riders = LX-R1+LX-R2 Ledger subtotal = Ledger core + Ledger riders');
});

test('steps: promotion never fires when the expression disagrees with the instruction', () => {
  const r = ledgerRoutine([{
    sequence: 1,
    instruction: 'Blend: Ledger riders = LX-R1+LX-R2 Ledger subtotal = Ledger core + Ledger riders',
    operation: 'expression',
    expression: 'Ledger subtotal = Ledger core - Ledger riders',
    inputs: ['Ledger core', 'Ledger riders'],
    output: 'Ledger subtotal',
  }]);
  assert.equal(r.steps_detailed[0].expression, 'Ledger subtotal = Ledger core - Ledger riders');
});

test('steps: chained equality with a worked result parses as an assignment', () => {
  const r = ledgerRoutine(['Ledger total = $12,500 / 100.0 = 125.0000 credits']);
  assert.deepEqual(r.steps, ['Ledger total = $12,500 / 100.0 = 125.0000 credits']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Ledger total = $12,500 / 100.0');
  assert.equal(det.output, 'Ledger total');
  assert.deepEqual(det.inputs ?? [], []);
});

test('steps: chained multi-statement with rounding arrows parses in order', () => {
  const r = ledgerRoutine(['Alpha net = 3.40 x 1.180 = 4.0120→ 4.012; Alpha gross = 2.10 x 1.050 = 2.2050→ 2.205']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Alpha net = 3.40 x 1.180; Alpha gross = 2.10 x 1.050');
  assert.equal(det.output, 'Alpha gross');
  assert.deepEqual(det.inputs ?? [], []);
});

test('steps: chained prose result stays unparsed instead of inventing a value', () => {
  const r = ledgerRoutine(['Alpha total = base amount + fee amount = final amount']);
  assert.equal(r.steps_detailed[0].operation, undefined);
  assert.equal(r.steps_detailed[0].expression, undefined);
});

test('steps: where-clause double equality is not chained equality', () => {
  const r = ledgerRoutine(['net = gross - levy where levy = 5']);
  assert.equal(r.steps_detailed[0].operation, undefined);
  assert.equal(r.steps_detailed[0].expression, undefined);
});

test('steps: chained equality links multi-part worked evaluations', () => {
  const r = ledgerRoutine(['Ledger net = Round(850.0000 x 5.7773, 2) = Round(4910.705, 2) = $4,910.71']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Ledger net = Round(850.0000 x 5.7773, 2)');
  assert.equal(det.output, 'Ledger net');
  assert.deepEqual(det.inputs ?? [], []);
});

test('steps: chained worked result ignores arrow restatements', () => {
  const r = ledgerRoutine(['Alpha share = 12,840 / 235,000 = 0.054638→ floor at 0.150']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Alpha share = 12,840 / 235,000');
  assert.equal(det.output, 'Alpha share');
});

test('steps: chained middle rejects implication arrows', () => {
  // A bare value right of `=>` is not a yields-clause evaluation (no
  // arithmetic left side), so the arrow still fails safe to unparsed.
  const r = ledgerRoutine(['Alpha = 0.040 => 1.000 = 0.960']);
  assert.equal(r.steps_detailed[0].operation, undefined);
  assert.equal(r.steps_detailed[0].expression, undefined);
});

test('steps: worked notes promote to ordered calculation steps', () => {
  const r = ledgerRoutine([], {
    kind: 'worked_example',
    evidenceText: 'synthetic worked illustration',
    notes: 'Expected values verbatim for review: Ledger total = $12,500 / 100.0 = 125.0000 credits; Fee table (F-1): Harbor fee=$30.00, Harbor dues=$12.50; Harbor grand = 125.00 + 42.50 = $167.50. All values reconcile.',
  });
  assert.equal(r.kind, 'worked_example');
  assert.deepEqual(r.steps, [
    'Expected values verbatim for review: Ledger total = $12,500 / 100.0 = 125.0000 credits',
    'Fee table (F-1): Harbor fee=$30.00, Harbor dues=$12.50',
    'Harbor grand = 125.00 + 42.50 = $167.50',
  ]);
  assert.deepEqual(r.steps_detailed.map((d) => d.sequence), [1, 2, 3]);
  assert.equal(r.steps_detailed[0].operation, 'expression');
  assert.equal(r.steps_detailed[0].expression, 'Ledger total = $12,500 / 100.0');
  assert.equal(r.steps_detailed[0].output, 'Ledger total');
  assert.equal(r.steps_detailed[1].expression, 'Harbor fee = $30.00; Harbor dues = $12.50');
  assert.equal(r.steps_detailed[2].expression, 'Harbor grand = 125.00 + 42.50');
  assert.ok(r.steps_detailed.every((d) => Array.isArray(d.source_pages) && d.source_pages.length > 0));
  assert.match(r.notes, /All values reconcile/);
});

test('steps: worked promotion skips prose and keeps ambiguous segments for review', () => {
  // The yields-clause evaluation shape now structures; a second assignment
  // right of `=>` stays ambiguous for review.
  const notes = 'Summary of illustrative results; Alpha fee = 0.040 => fee total = 0.960; Ledger total = $100 / 2 = 50.00 credits';
  const r = ledgerRoutine([], { kind: 'worked_example', notes });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps_detailed[0].operation, undefined);
  assert.equal(r.steps_detailed[0].expression, undefined);
  assert.equal(r.steps_detailed[1].operation, 'expression');
  assert.equal(r.notes, notes);
});

test('steps: chained worked result ignores trailing citations', () => {
  const r = ledgerRoutine(['Ledger net = Round(49,479.31 x 1.035, 2) = Round(51,211.08585, 2) = $51,211.09 (CG-2404 +3.5%)']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Ledger net = Round(49,479.31 x 1.035, 2)');
  assert.equal(det.output, 'Ledger net');
});

test('steps: yields-clause splits assignment and bare evaluation', () => {
  const r = ledgerRoutine(['Fee table (F-1): Seeded=0.040 => (1.000-Seeded)=0.960']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'Seeded = 0.040; (1.000 - Seeded) = 0.960');
  assert.equal(det.output, 'Seeded');
  assert.deepEqual(det.inputs ?? [], []);
});

test('steps: yields-clause with assigned right side stays unparsed', () => {
  const r = ledgerRoutine(['Alpha flag = 1 => Beta flag = 2']);
  assert.equal(r.steps_detailed[0].operation, undefined);
  assert.equal(r.steps_detailed[0].expression, undefined);
});

test('steps: bare equality without an output variable still structures', () => {
  const r = ledgerRoutine(['Harbor flat total: 2 x $150.00 = $300.00']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, '2 x $150.00 = $300.00');
  assert.equal(det.output, undefined);
  assert.deepEqual(det.inputs ?? [], []);
});

test('steps: bare prose-sum equality still structures', () => {
  const r = ledgerRoutine(['Harbor manifest: sum of assessed components = 1.791']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, 'sum of assessed components = 1.791');
  assert.equal(det.output, undefined);
});

test('steps: assigned equality keeps its output instead of a bare row', () => {
  const r = ledgerRoutine(['Alpha count = 5']);
  assert.equal(r.steps_detailed[0].output, 'Alpha count');
});

test('steps: worked promotion splits comma-joined chained evaluations', () => {
  const notes = 'Ep = 100 x 0.350 = $35.00, Ee = 100 x 0.650 = $65.00';
  const r = ledgerRoutine([], { kind: 'worked_example', notes });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps_detailed[0].expression, 'Ep = 100 x 0.350');
  assert.equal(r.steps_detailed[0].output, 'Ep');
  assert.equal(r.steps_detailed[1].expression, 'Ee = 100 x 0.650');
  assert.equal(r.steps_detailed[1].output, 'Ee');
  assert.deepEqual(r.steps_detailed.map((d) => d.sequence), [1, 2]);
});

test('steps: worked promotion keeps simple comma bindings in one step', () => {
  const r = ledgerRoutine([], { kind: 'worked_example', notes: 'Fee table (F-1): Harbor fee=$30.00, Harbor dues=$12.50' });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps_detailed[0].expression, 'Harbor fee = $30.00; Harbor dues = $12.50');
});

test('steps: worked promotion splits trailing comparison checks', () => {
  const r = ledgerRoutine([], { kind: 'worked_example', notes: 'Harbor total=$167.50 (>$100.00)' });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps_detailed[0].operation, 'expression');
  assert.equal(r.steps_detailed[0].expression, 'Harbor total = $167.50');
  assert.equal(r.steps_detailed[0].output, 'Harbor total');
  assert.equal(r.steps_detailed[1].operation, 'condition');
  assert.equal(r.steps_detailed[1].expression, 'Harbor total > $100.00');
  assert.deepEqual(r.steps_detailed[1].inputs, ['Harbor total']);
});

test('steps: chained steps record their stated results', () => {
  const r = ledgerRoutine(['Ledger total = $12,500 / 100.0 = 125.0000 credits']);
  assert.deepEqual(r.steps_detailed[0].stated_results, [{ output: 'Ledger total', value: '125.0000 credits' }]);
});

test('steps: chained multi-steps record per-part stated results', () => {
  const r = ledgerRoutine(['Alpha net = 3.40 x 1.180 = 4.0120; Alpha gross = 2.10 x 1.050 = 2.2050']);
  assert.deepEqual(r.steps_detailed[0].stated_results, [
    { output: 'Alpha net', value: '4.0120' },
    { output: 'Alpha gross', value: '2.2050' },
  ]);
});

test('steps: worked promotion splits newline-separated chains in order', () => {
  const notes = 'Ep = 100 x 0.350 = $35.00\nEe = 100 x 0.650 = $65.00';
  const r = ledgerRoutine([], { kind: 'worked_example', notes });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps_detailed[0].expression, 'Ep = 100 x 0.350');
  assert.deepEqual(r.steps_detailed[0].stated_results, [{ output: 'Ep', value: '$35.00' }]);
  assert.equal(r.steps_detailed[1].expression, 'Ee = 100 x 0.650');
  assert.deepEqual(r.steps_detailed[1].stated_results, [{ output: 'Ee', value: '$65.00' }]);
  assert.deepEqual(r.steps_detailed.map((d) => d.sequence), [1, 2]);
  assert.equal(r.notes, notes);

  const numbered = ledgerRoutine([], { kind: 'worked_example', notes: '1. Ep = 100 x 0.350 = $35.00\n2. Ee = 100 x 0.650 = $65.00' });
  assert.equal(numbered.steps.length, 2);
  assert.equal(numbered.steps_detailed[0].output, 'Ep');
  assert.equal(numbered.steps_detailed[1].output, 'Ee');
});

test('steps: worked promotion rescues chains joined to prose by comma', () => {
  const tail = ledgerRoutine([], { kind: 'worked_example', notes: 'Ep = 100 x 0.350 = $35.00, per vessel review' });
  assert.equal(tail.steps.length, 1);
  assert.equal(tail.steps_detailed[0].expression, 'Ep = 100 x 0.350');
  assert.deepEqual(tail.steps_detailed[0].stated_results, [{ output: 'Ep', value: '$35.00' }]);

  const head = ledgerRoutine([], { kind: 'worked_example', notes: 'Per vessel review, Ee = 100 x 0.650 = $65.00' });
  assert.equal(head.steps.length, 1);
  assert.equal(head.steps_detailed[0].expression, 'Ee = 100 x 0.650');
  assert.deepEqual(head.steps_detailed[0].stated_results, [{ output: 'Ee', value: '$65.00' }]);
  assert.equal(head.notes, 'Per vessel review, Ee = 100 x 0.650 = $65.00');
});

test('steps: worked promotion keeps incomplete comma parts for review', () => {
  const r = ledgerRoutine([], { kind: 'worked_example', notes: 'Ep = 100 x 0.350 = $35.00, Ee = 100 +' });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps_detailed[0].operation, 'expression');
  assert.equal(r.steps_detailed[0].output, 'Ep');
  assert.equal(r.steps_detailed[1].instruction, 'Ee = 100 +');
  assert.equal(r.steps_detailed[1].operation, undefined);
  assert.equal(r.steps_detailed[1].expression, undefined);
});

test('steps: worked promotion preserves thousands separators and parenthesized commas', () => {
  const r = ledgerRoutine([], { kind: 'worked_example', notes: 'Et = $48,000 x 0.580 = $27,840.00; Out = max(1.0, 0.5) = 1.0, Fee = min(2.0, 3.0) = 2.0' });
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps_detailed[0].expression, 'Et = $48,000 x 0.580');
  assert.deepEqual(r.steps_detailed[0].stated_results, [{ output: 'Et', value: '$27,840.00' }]);
  assert.equal(r.steps_detailed[1].expression, 'Out = max(1.0, 0.5)');
  assert.equal(r.steps_detailed[2].expression, 'Fee = min(2.0, 3.0)');
});

test('steps: worked promotion splits labeled parenthesized checks; notes stay put', () => {
  const r = ledgerRoutine([], { kind: 'worked_example', notes: 'Ratio = 3/4 = 0.75 (check: Ratio > 0.5)' });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps_detailed[0].expression, 'Ratio = 3/4');
  assert.deepEqual(r.steps_detailed[0].stated_results, [{ output: 'Ratio', value: '0.75' }]);
  assert.equal(r.steps_detailed[1].operation, 'condition');
  assert.equal(r.steps_detailed[1].expression, 'Ratio > 0.5');

  const cited = ledgerRoutine([], { kind: 'worked_example', notes: 'Pmod = Round(49,479.31 x 1.035, 2) = $51,211.09 (CG-2404 +3.5%)' });
  assert.equal(cited.steps.length, 1);
  assert.equal(cited.steps_detailed[0].expression, 'Pmod = Round(49,479.31 x 1.035, 2)');
  assert.deepEqual(cited.steps_detailed[0].stated_results, [{ output: 'Pmod', value: '$51,211.09' }]);
});

test('steps: worked promotion regression over a mixed worked note', () => {
  const notes = 'Expected values verbatim: Net base = $12,500 / 100.0 = 125.0000 units; Rate table (R-2): Base rate=$3.40, Tier factor=1.180; Loaded = 3.40 x 1.180 = 4.0120; Capped total = $167.50 (>$100.00). All values reconcile.';
  const r = ledgerRoutine([], { kind: 'worked_example', notes });
  assert.deepEqual(r.steps_detailed.map((d) => d.sequence), [1, 2, 3, 4, 5]);
  assert.equal(r.steps_detailed[0].output, 'Net base');
  assert.deepEqual(r.steps_detailed[0].stated_results, [{ output: 'Net base', value: '125.0000 units' }]);
  assert.equal(r.steps_detailed[1].expression, 'Base rate = $3.40; Tier factor = 1.180');
  assert.equal(r.steps_detailed[2].output, 'Loaded');
  assert.deepEqual(r.steps_detailed[2].stated_results, [{ output: 'Loaded', value: '4.0120' }]);
  assert.equal(r.steps_detailed[3].output, 'Capped total');
  assert.equal(r.steps_detailed[4].operation, 'condition');
  assert.ok(r.steps_detailed.every((d) => Array.isArray(d.source_pages) && d.source_pages.length > 0));
  assert.equal(r.notes, notes);

  const formula = ledgerRoutine([], { kind: 'formula', notes, expressionText: '' });
  assert.equal(formula.steps.length, 0);
  assert.equal(formula.steps_detailed.length, 0);
});

test('steps: worked promotion leaves stepped examples and plain routines alone', () => {
  const stepped = ledgerRoutine(['Ledger total = $100 / 2 = 50.00 credits'], {
    kind: 'worked_example', notes: 'Ledger total = $100 / 2 = 50.00 credits',
  });
  assert.equal(stepped.steps.length, 1);
  const plain = ledgerRoutine([], { notes: 'Alpha = 1 + 2 = 3.00' });
  assert.equal(plain.steps.length, 0);
  const expressed = ledgerRoutine([], { kind: 'worked_example', notes: 'Alpha = 1 + 2 = 3.00', expressionText: 'Alpha = beta + 2' });
  assert.equal(expressed.steps.length, 0);
});

// ---------- imperative routine-procedure regressions ----------
// Ordered rating procedures state each operation as an imperative sentence
// with a result label ("Base tallage: Select ...", "Zone scaling: Multiply
// ... by ..."). The label names the step result; the clause states the
// operation, operands, and table source. Synthetic ledger fixtures only.

test('steps: label-prefixed lookup structures with the label as output', () => {
  const r = ledgerRoutine(['Step 1 — Base tallage: Select the base annual tallage for the ledger class from Table L.']);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'lookup');
  assert.equal(det.output, 'Base tallage');
  assert.deepEqual(det.inputs, ['ledger class']);
  assert.deepEqual(det.depends_on, ['Table L']);
  assert.equal(det.interpretation_status, 'inferred');
  assert.equal(r.steps[0], 'Step 1 — Base tallage: Select the base annual tallage for the ledger class from Table L.');
});

test('steps: imperative multiply and subtract structure with verbatim operands', () => {
  const r = ledgerRoutine([
    'Step 2 — Zone scaling: Multiply the base tallage by the zone factor from Table Z.',
    'Step 7 — Net tallage: Subtract the ledger rebate from the pre-rebate tallage.',
  ]);
  const [first, second] = r.steps_detailed;
  assert.equal(first.operation, 'expression');
  assert.equal(first.expression, 'base tallage * zone factor');
  assert.deepEqual(first.inputs, ['base tallage', 'zone factor']);
  assert.equal(first.output, 'Zone scaling');
  assert.deepEqual(first.depends_on, ['Table Z']);
  assert.equal(second.operation, 'expression');
  assert.equal(second.expression, 'pre-rebate tallage - ledger rebate');
  assert.deepEqual(second.inputs, ['pre-rebate tallage', 'ledger rebate']);
  assert.equal(second.output, 'Net tallage');
  assert.equal(second.depends_on, undefined);
});

test('steps: imperative add and divide forms structure', () => {
  const r = ledgerRoutine([
    'Add the ledger fee to the base tallage.',
    'Divide the gross tallage by the ledger count.',
  ]);
  assert.equal(r.steps_detailed[0].operation, 'expression');
  assert.equal(r.steps_detailed[0].expression, 'ledger fee + base tallage');
  assert.equal(r.steps_detailed[1].operation, 'expression');
  assert.equal(r.steps_detailed[1].expression, 'gross tallage / ledger count');
});

test('steps: step-result backrefs resolve to the referenced step output', () => {
  const r = ledgerRoutine([
    'Step 1 — Base tallage: Select the base tallage for the ledger class from Table L.',
    'Step 2 — Zone scaling: Multiply the base tallage by the zone factor from Table Z.',
    'Step 3 — Tenure scaling: Multiply the Step 2 result by the tenure factor from Table T.',
  ]);
  assert.deepEqual(r.steps_detailed[2].inputs, ['Zone scaling', 'tenure factor']);
  const dangling = ledgerRoutine(['Multiply the Step 9 result by the zone factor.']);
  assert.deepEqual(dangling.steps_detailed[0].inputs, ['Step 9 result', 'zone factor']);
});

test('steps: sequential conditionals do not leak nested variables into inputs', () => {
  const r = ledgerRoutine([
    'Step 6 — Ledger rebate: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 1 or 2 ledgers, the rebate is 0%.',
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'condition');
  assert.equal(det.inputs, undefined);
});

test('steps: stated-value conditional step keeps its branch subject as output', () => {
  const r = ledgerRoutine([
    'Step 6 — Ledger rebate: If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage. If the policy covers 1 or 2 ledgers, the rebate is 0%.',
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'condition');
  assert.equal(det.output, 'rebate');
  assert.equal(det.inputs, undefined);
});

test('steps: conditional branches without a stated value keep no output', () => {
  const r = ledgerRoutine([
    'Step 6 — Ledger review: If the ledger count is high, the tallage is reviewed annually.',
    'Step 7 — Ledger handling: If the ledger count is high, apply the tallage adjustment.',
  ]);
  assert.equal(r.steps_detailed[0].operation, 'condition');
  assert.equal(r.steps_detailed[0].output, undefined);
  assert.equal(r.steps_detailed[1].operation, 'condition');
  assert.equal(r.steps_detailed[1].output, undefined);
});

test('steps: rounding captures multi-word targets and skips labels and negations', () => {
  const r = ledgerRoutine([
    'Step 8 — Rounding: Round only the final tallage to two decimal places using standard round-half-up rounding. Do not round intermediate tallages.',
  ]);
  assert.equal(r.steps_detailed[0].operation, 'rounding');
  assert.equal(r.steps_detailed[0].operand, 'final tallage');
  assert.equal(r.steps_detailed[0].output, 'final tallage');
  const temporal = ledgerRoutine(['Final tallage before rounding']);
  assert.equal(temporal.steps_detailed[0].operation, undefined);
  const negated = ledgerRoutine(['Do not round intermediate tallages.']);
  assert.equal(negated.steps_detailed[0].operation, undefined);
});

test('steps: imperative prose without both operands stays unparsed', () => {
  const r = ledgerRoutine(['Multiply the tallage.', 'Note: review tallages annually.']);
  for (const det of r.steps_detailed) {
    assert.equal(det.operation, undefined);
    assert.equal(det.expression, undefined);
    assert.equal(det.output, undefined);
    assert.equal(det.interpretation_status, undefined);
  }
});

// ---------- explicit worked-calculation promotion regressions ----------
// Worked illustrations carry per-step calculation expressions with stated
// results but no operation field. Arithmetic, call-form, and past-tense
// lookup expressions promote to structured steps with the step label as the
// output variable and the bare amount kept as a stated result — never
// dropped, never invented.

test('steps: explicit arithmetic expression promotes with label output and stated result', () => {
  const r = explicitLedgerRoutine([
    { sequence: 2, instruction: '2. Zone scaling', expression: '$1,050.00 × 1.00', output: '$1,050.00' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, '$1,050.00 × 1.00');
  assert.equal(det.output, 'Zone scaling');
  assert.deepEqual(det.stated_results, [{ output: 'Zone scaling', value: '$1,050.00' }]);
  assert.equal(det.interpretation_status, 'inferred');
});

test('steps: explicit call-form expression promotes instead of staying unparsed', () => {
  const r = explicitLedgerRoutine([
    { sequence: 8, instruction: '8. Final tallage', expression: 'RoundHalfUp($1,066.078125, 2)', output: '$1,066.08' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'Final tallage');
  assert.deepEqual(det.stated_results, [{ output: 'Final tallage', value: '$1,066.08' }]);
});

test('steps: explicit arithmetic keeps its expression over a rounding-word label', () => {
  const r = explicitLedgerRoutine([
    { sequence: 7, instruction: '7. Net before rounding', expression: '$1,122.1875 - $56.109375', output: '$1,066.078125' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.output, 'Net before rounding');
  assert.deepEqual(det.stated_results, [{ output: 'Net before rounding', value: '$1,066.078125' }]);
});

test('steps: explicit past-tense lookup promotes with key and stated value', () => {
  const r = explicitLedgerRoutine([
    { sequence: 1, instruction: '1. Base tallage', expression: 'Selected tallage for LXV', output: '$1,050.00' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'lookup');
  assert.equal(det.output, 'Base tallage');
  assert.deepEqual(det.inputs, ['LXV']);
  assert.deepEqual(det.stated_results, [{ output: 'Base tallage', value: '$1,050.00' }]);
});

test('steps: explicit prose expression without evidence stays unparsed with output kept', () => {
  const r = explicitLedgerRoutine([
    { sequence: 1, instruction: '1. Base tallage', expression: 'the applicable tallage', output: '$1,050.00' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.expression, 'the applicable tallage');
  assert.equal(det.output, '$1,050.00');
  assert.equal(det.interpretation_status, undefined);
});

// ---------- label-colon worked-calculation regressions ----------
// Live extractions sometimes state each worked step as `N. Label:
// <calculation>` with the stated result in `output`. The label names the
// step's result exactly like the bare `N. Label` form, so promotion must
// read through the colon: arithmetic, subtraction, call-form rounding,
// and past-tense lookups structure with the label as output and the bare
// amount kept as a stated result — never dropped, never invented. Prose
// labels and prose suffixes stay unparsed instead of gaining outputs.

test('steps: label-colon arithmetic promotes with label output and stated result', () => {
  const r = explicitLedgerRoutine([
    { sequence: 2, instruction: '2. Zone scaling: $1,050.00 × 1.00', expression: '$1,050.00 × 1.00', output: '$1,050.00' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.equal(det.expression, '$1,050.00 × 1.00');
  assert.equal(det.output, 'Zone scaling');
  assert.deepEqual(det.stated_results, [{ output: 'Zone scaling', value: '$1,050.00' }]);
  assert.equal(det.interpretation_status, 'inferred');
});

test('steps: label-colon subtraction and call-form rounding promote in order', () => {
  const r = explicitLedgerRoutine([
    { sequence: 7, instruction: '7. Net before rounding: $1,122.1875 - $56.109375', expression: '$1,122.1875 - $56.109375', output: '$1,066.078125' },
    { sequence: 8, instruction: '8. Final tallage: RoundHalfUp($1,066.078125, 2)', expression: 'RoundHalfUp($1,066.078125, 2)', output: '$1,066.08' },
  ]);
  const [sub, round] = r.steps_detailed;
  assert.equal(sub.operation, 'expression');
  assert.equal(sub.output, 'Net before rounding');
  assert.deepEqual(sub.stated_results, [{ output: 'Net before rounding', value: '$1,066.078125' }]);
  assert.equal(round.operation, 'expression');
  assert.equal(round.output, 'Final tallage');
  assert.deepEqual(round.stated_results, [{ output: 'Final tallage', value: '$1,066.08' }]);
});

test('steps: label-colon past-tense lookup promotes with key and stated value', () => {
  const r = explicitLedgerRoutine([
    { sequence: 1, instruction: '1. Base tallage: Selected tallage for LXV', expression: 'Selected tallage for LXV', output: '$800.00' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, 'lookup');
  assert.equal(det.output, 'Base tallage');
  assert.deepEqual(det.inputs, ['LXV']);
  assert.deepEqual(det.stated_results, [{ output: 'Base tallage', value: '$800.00' }]);
});

test('steps: assignment inside the expression beats an imperative colon label', () => {
  const r = explicitLedgerRoutine([
    { sequence: 2, instruction: '2. Compute base tallage: Tloaded = Tbase × Fzone', expression: 'Tloaded = Tbase × Fzone' },
    { sequence: 3, instruction: '3. Add catastrophe surcharge: Tsurcharged = Tloaded + Lwind', expression: 'Tsurcharged = Tloaded + Lwind', output: '$1,200.00' },
  ]);
  const [first, second] = r.steps_detailed;
  assert.equal(first.operation, 'expression');
  assert.equal(first.output, 'Tloaded');
  assert.equal(first.stated_results, undefined);
  assert.equal(second.operation, 'expression');
  assert.equal(second.output, 'Tsurcharged');
  assert.deepEqual(second.stated_results, [{ output: 'Tsurcharged', value: '$1,200.00' }]);
});

test('steps: label-colon prose without calculation evidence stays unparsed', () => {
  const r = explicitLedgerRoutine([
    { sequence: 1, instruction: '1. Tallage note: review tallages annually', expression: 'review tallages annually' },
  ]);
  const det = r.steps_detailed[0];
  assert.equal(det.operation, undefined);
  assert.equal(det.expression, 'review tallages annually');
  assert.equal(det.output, undefined);
  assert.equal(det.interpretation_status, undefined);
});

test('steps: overlong and backref colon labels gain no invented output', () => {
  const r = explicitLedgerRoutine([
    { sequence: 2, instruction: '2. The result after applying every ledger factor carefully: $1,050.00 × 1.00', expression: '$1,050.00 × 1.00', output: '$1,050.00' },
    { sequence: 3, instruction: '3. Step 2 result: $1,050.00 × 0.90', expression: '$1,050.00 × 0.90', output: '$945.00' },
  ]);
  for (const det of r.steps_detailed) {
    assert.equal(det.operation, 'expression');
    assert.equal(det.output, undefined);
    assert.equal(det.stated_results, undefined);
  }
});

test('steps: label-colon worked steps render arithmetic rows without REVIEW', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 2 }),
      routines: [{
        name: 'LX — Worked Tallage Case',
        kind: 'worked_example',
        sourcePages: [2],
        evidenceText: 'synthetic worked illustration with expected values',
        steps: [
          { sequence: 2, instruction: '2. Zone scaling: $1,050.00 × 1.00', expression: '$1,050.00 × 1.00', output: '$1,050.00' },
          { sequence: 7, instruction: '7. Net before rounding: $1,122.1875 - $56.109375', expression: '$1,122.1875 - $56.109375', output: '$1,066.078125' },
          { sequence: 8, instruction: '8. Final tallage: RoundHalfUp($1,066.078125, 2)', expression: 'RoundHalfUp($1,066.078125, 2)', output: '$1,066.08' },
        ],
        notes: 'Expected values preserved verbatim: $1,050.00, $1,066.078125, $1,066.08.',
      }],
    })
  );
  job.issues = validateJob(job);
  const steps = sectionRows(routineSheetValues(job, 'LX — Worked Tallage Case'), 'Steps');
  const opIndex = steps.header.indexOf('Op');
  assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `unexpected REVIEW rows: ${JSON.stringify(steps.body)}`);
  assert.deepEqual(steps.body.map((row) => row[0]), ['2.1', '2.2', '2.3', '7.1', '7.2', '7.3', '8.1', '8.2']);
  assert.deepEqual(steps.body[0].slice(0, 6), ['2.1', 'Zone scaling', '<--', '', '$1,050.00', '']);
  assert.deepEqual(steps.body[1].slice(0, 6), ['2.2', '', '×', '', '1.00', '']);
  assert.deepEqual(steps.body[2].slice(0, 6), ['2.3', 'Zone scaling', '=', '', '$1,050.00', '']);
  assert.deepEqual(steps.body[4].slice(0, 6), ['7.2', '', '-', '', '$56.109375', '']);
  assert.deepEqual(steps.body[6].slice(0, 6), ['8.1', 'Final tallage', '<--', '', 'RoundHalfUp($1,066.078125, 2)', '']);
  assert.deepEqual(steps.body[7].slice(0, 6), ['8.2', 'Final tallage', '=', '', '$1,066.08', '']);
  assert.ok(steps.body.every((row) => row.length === 7 && row[6] !== ''));
});
