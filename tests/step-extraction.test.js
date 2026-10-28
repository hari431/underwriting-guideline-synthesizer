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
  assert.equal(det.output, undefined);
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
    ['1', 'LX-01 + LX-02', '+', '', 'LX-01 + LX-02', '', 'Calculate LX-01 + LX-02 (source step 1; output not stated — verify)'],
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
