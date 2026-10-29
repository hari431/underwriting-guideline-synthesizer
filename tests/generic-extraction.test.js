import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createJob, inferTableColumns, normalizeJob } from '../src/models.js';
import { buildJobFromExtraction } from '../src/pipeline.js';
import { splitMergedTables } from '../src/table-split.js';
import { classifyFormula, validateJob } from '../src/validate.js';

// Generic extraction regressions for rating routines and tables. All fixtures
// use an invented ledger-fee domain with codes and variables that differ from
// every real document, so these tests cannot pass by accident from hardcoded
// document handling.

function ledgerJob({ tables = [], routines = [] } = {}) {
  return normalizeJob(
    createJob({
      document: createDocument({ filename: 'ledger-guideline.pdf', pageCount: 3 }),
      tables,
      routines,
    })
  );
}

test('generic: plain-word multi-assignment promotes with sequential evidence', () => {
  const job = ledgerJob({
    routines: [{
      name: 'LX — Ledger Totals',
      kind: 'calculation_steps',
      sourcePages: [2],
      evidenceText: 'synthetic ledger totals',
      steps: [{
        sequence: 1,
        instruction: 'Blend ledger amounts: Gross total = base amount + fee amount Net final = max(floor amount, Gross total)',
        operation: 'expression',
        expression: 'Net final = max(floor amount, Gross total)',
        inputs: ['floor amount', 'Gross total', 'base amount', 'fee amount'],
        output: 'Net final',
      }],
    }],
  });
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.expression, 'Gross total = base amount + fee amount; Net final = max(floor amount, Gross total)');
  assert.equal(det.output, 'Net final');
});

test('generic: rating and surcharge kinds map structurally without warnings', () => {
  const job = ledgerJob({
    routines: [
      { name: 'SYN-Rating', kind: 'rating', sourcePages: [1], evidenceText: 'ev', expressionText: 'net = base * factor' },
      { name: 'SYN-Surcharge', kind: 'surcharge calculation', sourcePages: [1], evidenceText: 'ev', steps: ['Add the ledger fee to the base.'] },
      { name: 'SYN-Eligibility', kind: 'underwriting eligibility', sourcePages: [1], evidenceText: 'ev', conditions: ['IF ledger count is high THEN refer.'] },
      { name: 'SYN-Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'ev', notes: 'Expected values: total = 10.' },
      { name: 'SYN-Mystery', kind: 'mystery', sourcePages: [1], evidenceText: 'ev', expressionText: 'a = 1' },
    ],
  });
  assert.deepEqual(job.routines.map((r) => r.kind), ['formula', 'calculation_steps', 'condition', 'worked_example', 'mystery']);
  const issues = validateJob(job);
  const kindWarnings = issues.filter((i) => /unrecognized kind/.test(i.message));
  assert.equal(kindWarnings.length, 1);
  assert.match(kindWarnings[0].message, /mystery/);
  assert.ok(issues.some((i) => /Worked example "SYN-Worked" preserves illustrative expected values/.test(i.message)));
});

test('generic: column type unit and role inference preserves labels', () => {
  const job = ledgerJob({
    tables: [{
      name: 'SYN-Ledger Tariff',
      sourcePages: [1],
      evidenceText: 'synthetic ledger tariff in dollars',
      headers: ['Ledger Code', 'Base Amount ($)', 'Ledger Notes'],
      rows: [['LX-01', '10.00', 'Standard ledger entry for review'], ['LX-02', '20.50', 'Expedited ledger entry for review']],
    }],
  });
  const built = buildJobFromExtraction(
    { tables: job.tables, routines: [] },
    { filename: 'ledger-guideline.pdf', pageCount: 3 }
  );
  const cols = built.tables[0].columns;
  assert.equal(cols[0].label, 'Ledger Code');
  assert.equal(cols[0].original_label, 'Ledger Code');
  assert.equal(cols[0].data_type, 'text');
  assert.equal(cols[0].role, 'key');
  assert.equal(cols[1].data_type, 'number');
  assert.equal(cols[1].role, 'output');
  assert.equal(cols[1].units, '$');
  assert.equal(cols[2].role, 'descriptive');
});

test('generic: base-code group refs resolve with multi-part step evidence', () => {
  const tables = [
    { name: 'Ledger Tariff SYN-GROUP Part A', sourcePages: [1], evidenceText: 'e', headers: ['Alpha Code', 'Alpha Factor'], rows: [['A1', '1.10']] },
    { name: 'Ledger Tariff SYN-GROUP Part B', sourcePages: [1], evidenceText: 'e', headers: ['Beta Code', 'Beta Factor'], rows: [['B1', '1.20']] },
  ];
  const withEvidence = ledgerJob({
    tables,
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      dependsOn: ['SYN-GROUP'],
      steps: [
        { sequence: 1, instruction: 'Use Alpha.', operation: 'lookup', inputs: ['Alpha Code'], output: 'a', depends_on: ['SYN-GROUP Part A'] },
        { sequence: 2, instruction: 'Use Beta.', operation: 'lookup', inputs: ['Beta Code'], output: 'b', depends_on: ['SYN-GROUP Part B'] },
      ],
    }],
  });
  const issues = validateJob(withEvidence);
  assert.ok(!issues.some((i) => /matches multiple tables/.test(i.message)), `unexpected ambiguity: ${issues.map((i) => i.message).join(' | ')}`);
  assert.ok(withEvidence.tables[0].continuation === null || withEvidence.tables[0].continuation === undefined);
  const built = buildJobFromExtraction({ tables, routines: withEvidence.routines }, { filename: 'g.pdf', pageCount: 3 });
  assert.equal(built.tables[0].continuation.logical_group, 'syn-group');
  assert.equal(built.tables[1].continuation.logical_group, 'syn-group');
});

test('generic: split parts carry their group relationship', () => {
  const { tables, splits } = splitMergedTables([{
    id: 'T9', name: 'Synthetic master grid', source_pages: [2], evidence_text: 'e',
    headers: ['Item', 'Rate P', 'Rate Q', 'Alpha Factor', 'Beta Credit'],
    columns: [],
    rows: [
      ['Item 1', '10', '20', 'Class A: 1.00', 'Tier 1: 5%'],
      ['Item 2', '11', '21', 'Class B: 1.25', 'Tier 2: 10%'],
      ['Item 3', '12', '22', 'Class C: 1.05', 'Tier 3: 15%'],
      ['Item 4', '13', '23', 'Class D: 1.20', 'Tier 4: 20%'],
    ],
  }]);
  assert.ok(splits.length >= 1);
  assert.ok(tables.length >= 2);
  for (const part of tables) {
    assert.equal(part.continuation.split_group, 'T9');
    assert.equal(part.continuation.split_of, tables.length);
  }
});

test('generic: summations indexed variables and math symbols stay interpretable', () => {
  assert.equal(classifyFormula('total = base[i] + factor[i]'), 'ok');
  assert.equal(classifyFormula('avg = SUM(w[i] * r[i]) / n'), 'ok');
  assert.equal(classifyFormula('net = base·factor + fee•tax'), 'ok');
  assert.equal(classifyFormula('IF count IN {1, 2, 3} THEN apply factor ELSE refer'), 'conditional');
  assert.equal(classifyFormula('IF rate ≤ 5 AND zone ≥ 2 THEN apply ELSE refer'), 'conditional');
  assert.equal(classifyFormula('total = base[i + factor'), 'review');
  assert.equal(classifyFormula('total: base plus factor'), 'review');
});

test('generic: nested conditions keep the inner branch verbatim', () => {
  const job = ledgerJob({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: ['IF ledger class is high THEN IF ledger zone is metro THEN apply metro factor ELSE apply base factor ELSE refer'],
    }],
  });
  const det = job.routines[0].conditions_detailed[0];
  assert.equal(det.condition, 'ledger class is high');
  assert.equal(det.true_branch, 'IF ledger zone is metro THEN apply metro factor ELSE apply base factor');
  assert.equal(det.false_branch, 'refer');
});

test('generic: keep-at-precision rounding parses without inventing targets', () => {
  const job = ledgerJob({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: ['Keep ledger_total at 4 decimal places.', 'Keep the meeting notes.'],
    }],
  });
  const [first, second] = job.routines[0].steps_detailed;
  assert.equal(first.operation, 'rounding');
  assert.equal(first.output, 'ledger_total');
  assert.equal(second.operation, undefined);
});

test('generic: indexed assignment inputs stay whole', () => {
  const job = ledgerJob({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: ['total = base[i] + factor[i]'],
    }],
  });
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.deepEqual(det.inputs, ['base[i]', 'factor[i]']);
  assert.equal(det.output, 'total');
});

test('generic: middle-dot multiplication parses as arithmetic', () => {
  const job = ledgerJob({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: ['net = base·factor'],
    }],
  });
  const det = job.routines[0].steps_detailed[0];
  assert.equal(det.operation, 'expression');
  assert.deepEqual(det.inputs, ['base', 'factor']);
});

test('generic: explicit missing markers warn while None stays silent', () => {
  const job = ledgerJob({
    tables: [{
      name: 'SYN-Gap', sourcePages: [1], evidenceText: 'e',
      headers: ['Ledger Code', 'Ledger Factor'],
      rows: [['LX-01', '1.10'], ['LX-02', '[NOT SPECIFIED]'], ['LX-03', 'None']],
    }],
    routines: [],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /marks row 2 column "Ledger Factor" as "\[NOT SPECIFIED\]"/.test(i.message)));
  assert.ok(!issues.some((i) => /"None"/.test(i.message) && /not populated/.test(i.message)));
});

test('generic: note-flagged gaps surface without inventing values', () => {
  const job = ledgerJob({
    routines: [{
      name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e',
      expressionText: 'net = base * factor',
      inputs: ['base', 'factor'],
      notes: 'FLAG FOR REVIEW: factor is undefined nowhere in the source. Also flag overlapping boundary between tiers.',
    }],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /notes flag a possible gap/.test(i.message)));
});

test('generic: range-notation inputs match indexed uses', () => {
  const job = ledgerJob({
    routines: [{
      name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e',
      expressionText: 'total = SUM(base[i] * factor[i])',
      inputs: ['base1..basen', 'factor for k=1 to 5', 'unused_drift'],
    }],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /declares input "base1\.\.basen"/.test(i.message)));
  assert.ok(!issues.some((i) => /declares input "factor for k=1 to 5"/.test(i.message)));
  assert.ok(issues.some((i) => /declares input "unused_drift"/.test(i.message)));
});

test('generic: inferred columns feed validation without inventing values', () => {
  const table = {
    name: 'SYN-Gap', sourcePages: [1], evidenceText: 'e',
    headers: ['Ledger Code', 'Ledger Factor'],
    rows: [['LX-01', '1.10'], ['LX-02', '']],
  };
  const cols = inferTableColumns({ headers: table.headers, columns: [], rows: table.rows });
  assert.equal(cols[1].role, 'output');
  const job = ledgerJob({ tables: [table], routines: [] });
  const built = buildJobFromExtraction({ tables: job.tables, routines: [] }, { filename: 'g.pdf', pageCount: 3 });
  const issues = validateJob(built);
  assert.ok(issues.some((i) => /missing value\(s\) in output column "Ledger Factor"/.test(i.message)));
});
