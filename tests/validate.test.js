import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createJob, normalizeJob } from '../src/models.js';
import { classifyFormula, validateJob } from '../src/validate.js';

function jobWith(overrides) {
  return normalizeJob(
    createJob({
      document: createDocument({ filename: 'g.pdf', pageCount: 3 }),
      ...overrides,
    })
  );
}

test('validate: clean job has no issues', () => {
  const job = jobWith({
    tables: [{ name: 'T', sourcePages: [1], evidenceText: 'ev', headers: ['A'], rows: [['1']] }],
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'a = b * 2' }],
  });
  assert.deepEqual(validateJob(job), []);
});

test('validate: missing pages and empty tables are errors', () => {
  const job = jobWith({
    tables: [{ name: 'NoPages', headers: ['A'], rows: [['1']] }, { name: 'Empty', sourcePages: [1], evidenceText: 'ev' }],
    routines: [{ name: 'OutOfRange', kind: 'formula', sourcePages: [9], evidenceText: 'ev', expressionText: 'a = 1' }],
  });
  const issues = validateJob(job);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.equal(errors.length, 3);
  assert.ok(errors.some((i) => /missing a source page/.test(i.message)));
  assert.ok(errors.some((i) => /is empty/.test(i.message)));
  assert.ok(errors.some((i) => /beyond document length/.test(i.message)));
});

test('validate: missing evidence text is a warning', () => {
  const job = jobWith({
    tables: [{ name: 'T', sourcePages: [1], headers: ['A'], rows: [['1']] }],
  });
  const issues = validateJob(job);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning');
  assert.match(issues[0].message, /no supporting evidence text/);
  assert.deepEqual(issues[0].source_pages, [1]);
});

test('validate: unfamiliar formula syntax is flagged for review, not invalid', () => {
  assert.equal(classifyFormula('base_premium = base_rate * territory_factor'), 'ok');
  assert.equal(classifyFormula('final_premium = base_premium + policy_fee'), 'ok');
  assert.equal(classifyFormula('IF x THEN y ELSE z'), 'conditional');
  assert.equal(classifyFormula('APPLY legacy_matrix_v2 surcharge curve'), 'review');
  assert.equal(classifyFormula('a = (b + 1'), 'review');
  assert.equal(classifyFormula(''), 'empty');

  const job = jobWith({
    routines: [{ name: 'G1', kind: 'formula', sourcePages: [3], evidenceText: 'ev', expressionText: 'APPLY legacy_matrix_v2 surcharge curve' }],
  });
  const issues = validateJob(job);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning');
  assert.match(issues[0].message, /cannot reliably interpret/);
  assert.match(issues[0].message, /not treated as invalid/);
});

test('validate: unparsed formula-like steps name the missing evidence class', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
      steps: [
        'LX-01 Ledger base fee schedule (2,000)',
        'Review the outcome with the team.',
      ],
    }],
  });
  const issues = validateJob(job);
  // The paren-bearing line reaches for formula syntax but states no
  // operation, assignment, or lookup: flagged with the evidence class.
  // Pure prose stays covered only by the aggregate check below.
  const stepFlags = issues.filter((i) => /states no confident operation/.test(i.message));
  assert.equal(stepFlags.length, 1);
  assert.match(stepFlags[0].message, /Step 1/);
  assert.match(stepFlags[0].message, /no explicit operator/);
  assert.match(stepFlags[0].message, /not treated as invalid/);
  assert.ok(issues.some((i) => /without an evidenced operation/.test(i.message)));
});

test('validate: unresolved dependencies and duplicates warn', () => {
  const job = jobWith({
    tables: [{ name: 'Dup', sourcePages: [1], evidenceText: 'e', headers: ['A'], rows: [['1']] }],
    routines: [
      { name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', dependsOn: ['No Such Table'] },
      { name: 'R1', kind: 'formula', sourcePages: [2], evidenceText: 'e', expressionText: 'b = 2' },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /matches no extracted table/.test(i.message)));
  assert.ok(issues.some((i) => /duplicated/.test(i.message)));
  assert.ok(issues.every((i) => i.severity === 'warning'));
});

test('validate: ragged rows and unknown kinds warn', () => {
  const job = jobWith({
    tables: [{ name: 'T', sourcePages: [1], evidenceText: 'e', headers: ['A', 'B'], rows: [['1']] }],
    routines: [{ name: 'R', kind: 'mystery', sourcePages: [1], evidenceText: 'e' }],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /column counts differing/.test(i.message)));
  assert.ok(issues.some((i) => /unrecognized kind/.test(i.message)));
});

test('validate: blank and duplicated column labels warn', () => {
  const job = jobWith({
    tables: [
      { name: 'Blank', sourcePages: [1], evidenceText: 'e', headers: ['A', ''], rows: [['1', '2']] },
      { name: 'Dup', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Key'], rows: [['a', 'b']] },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /blank column label/.test(i.message)));
  assert.ok(issues.some((i) => /duplicated column label/.test(i.message)));
  assert.ok(issues.every((i) => i.severity === 'warning'));
});

test('validate: duplicate rows and conflicting keys warn without deduplication', () => {
  const job = jobWith({
    tables: [{
      name: 'Factors', sourcePages: [1], evidenceText: 'e', headers: ['K', 'V'],
      rows: [['a', '1'], ['a', '1'], ['b', '2'], ['b', '3']],
    }],
  });
  assert.equal(job.tables[0].rows.length, 4);
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /duplicate row/.test(i.message)));
  assert.ok(issues.some((i) => /conflicting values for the same apparent lookup key/.test(i.message)));
});

test('validate: leading-zero identifiers and suspected continuations warn', () => {
  const job = jobWith({
    tables: [
      { name: 'First', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['0012', '1.10']] },
      { name: 'Second', sourcePages: [2], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['0045', '1.20']] },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /leading zeros/.test(i.message)));
  assert.ok(issues.some((i) => /continuation/.test(i.message)));
});

test('validate: refer and decline dispositions satisfy the fallback check symmetrically', () => {
  const job = jobWith({
    routines: [
      { name: 'Referred', kind: 'condition', sourcePages: [1], evidenceText: 'e', conditions: ['RULE-1 Widget count is high. Refer'] },
      { name: 'Declined', kind: 'condition', sourcePages: [1], evidenceText: 'e', conditions: ['RULE-2 Widget count is low. Decline'] },
      { name: 'NoFallback', kind: 'condition', sourcePages: [1], evidenceText: 'e', conditions: ['RULE-3 Widget count is steady. Apply widget credit.'] },
    ],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => i.target_id === 'R1' && /no explicit fallback/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /no explicit fallback/.test(i.message)));
  assert.ok(issues.some((i) => i.target_id === 'R3' && /no explicit fallback/.test(i.message)));
});

test('validate: condition fallback, lookup keys, and unresolved step refs warn', () => {
  const job = jobWith({
    routines: [
      { name: 'NoFallback', kind: 'condition', sourcePages: [1], evidenceText: 'e', conditions: ['IF x THEN y'] },
      {
        name: 'Lookup', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [{ sequence: 1, instruction: 'Look up factor', operation: 'lookup', output: 'f' }],
      },
      {
        name: 'Unresolved', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [{ sequence: 1, instruction: 'Use missing', inputs: ['undefined_variable'], output: 'out' }],
      },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /no explicit fallback/.test(i.message)));
  assert.ok(issues.some((i) => /has no lookup keys/.test(i.message)));
  assert.ok(issues.some((i) => /flagged as unresolved/.test(i.message)));
  assert.ok(issues.every((i) => i.severity === 'warning'));
});

test('validate: normalized kinds skip kind warnings but unknown kinds still warn', () => {
  const job = jobWith({
    routines: [
      { name: 'E', kind: 'eligibility', sourcePages: [1], evidenceText: 'e', conditions: ['RULE-1 Widget count is high. Refer'] },
      { name: 'C', kind: 'calculation', sourcePages: [1], evidenceText: 'e', steps: ['1 Find the widget rate for widget_class in Schedule Q.'] },
      { name: 'M', kind: 'mystery', sourcePages: [1], evidenceText: 'e' },
    ],
  });
  const kinds = job.routines.map((r) => r.kind);
  assert.deepEqual(kinds, ['condition', 'calculation_steps', 'mystery']);
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => i.target_id === 'R1' && /unrecognized kind/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /unrecognized kind/.test(i.message)));
  assert.ok(issues.some((i) => i.target_id === 'R3' && /unrecognized kind "mystery"/.test(i.message)));
});

test('validate: factor tables without units keep semantics warnings', () => {
  const job = jobWith({
    tables: [
      { name: 'Widget Factors', sourcePages: [1], evidenceText: 'Widget factor schedule', headers: ['Widget key', 'Factor'], rows: [['w1', '0.90']] },
      { name: 'Priced Widgets', sourcePages: [1], evidenceText: 'Widget prices in dollars per unit', headers: ['Widget key', 'Price'], rows: [['w1', '12.50']] },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => i.target_id === 'T1' && /unclear units/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'T2' && /unclear units/.test(i.message)));
});

test('validate: unclear-units check needs cents as a word, not a substring', () => {
  const job = jobWith({
    tables: [
      { name: 'Central Territory Factors', sourcePages: [1], evidenceText: 'Central territory factor schedule', headers: ['Territory', 'Factor'], rows: [['Metro Central', '1.30']] },
      { name: 'Widget Fees', sourcePages: [1], evidenceText: 'Widget fees stated in cents', headers: ['Widget key', 'Fee'], rows: [['w1', '25']] },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => i.target_id === 'T1' && /unclear units/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'T2' && /unclear units/.test(i.message)));
});

test('validate: step refs matching table columns resolve; unknown refs still flag', () => {
  const job = jobWith({
    tables: [{ name: 'Factors', sourcePages: [1], evidenceText: 'e', headers: ['Region Key', 'Value'], rows: [['a', '1']] }],
    routines: [{
      name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Look up value', operation: 'lookup', inputs: ['Region Key'], output: 'v' },
        { sequence: 2, instruction: 'Use missing', inputs: ['nowhere_defined'], output: 'w' },
      ],
    }],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /Region Key/.test(i.message)), 'column-matching key must not warn');
  assert.ok(issues.some((i) => /nowhere_defined/.test(i.message) && /flagged as unresolved/.test(i.message)));
  assert.ok(issues.every((i) => i.severity === 'warning'));
});

test('validate: computed breakdowns warn; real rating tables and unmatched totals do not', () => {
  const job = jobWith({
    tables: [
      { name: 'Breakdown', sourcePages: [1], evidenceText: 'e', headers: ['Item', 'Amount'], rows: [['Alpha', '10.00'], ['Beta', '20.00'], ['Total', '30.00']] },
      { name: 'Rounded Breakdown', sourcePages: [2], evidenceText: 'e', headers: ['Item', 'Amount'], rows: [['Alpha', '0.10'], ['Beta', '0.20'], ['Subtotal', '0.30']] },
      {
        name: 'Multi Key', sourcePages: [1], evidenceText: 'e', headers: ['Region', 'Band', 'Group', 'Modifier'],
        rows: [['R-A', '750', 'Group 1', '0.037'], ['R-A', '750', 'Group 2', '0.029'], ['R-B', '1500', 'Group 1', '0.041']],
      },
      { name: 'Codes', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['0012', '1.10'], ['0045', '1.20']] },
      { name: 'Unmatched Total Row', sourcePages: [1], evidenceText: 'e', headers: ['Item', 'Amount'], rows: [['Alpha', '10.00'], ['Beta', '20.00'], ['Total', '99.99']] },
    ],
  });
  const issues = validateJob(job);
  const breakdown = (id) => issues.filter((i) => i.target_id === id && /computed breakdown/.test(i.message));
  assert.equal(breakdown('T1').length, 1);
  assert.equal(breakdown('T2').length, 1);
  assert.equal(breakdown('T1')[0].severity, 'warning');
  assert.deepEqual(breakdown('T1')[0].source_pages, [1]);
  for (const id of ['T3', 'T4', 'T5']) {
    assert.deepEqual(breakdown(id), [], `${id} must not warn as a breakdown`);
  }
});

test('validate: suspected merged grids warn; clean and edge-blank tables do not', () => {
  const job = jobWith({
    tables: [
      { name: 'Blank Row', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['a', '1'], ['', ''], ['b', '2']] },
      { name: 'Blank Column', sourcePages: [1], evidenceText: 'e', headers: ['Key', '', 'Value'], rows: [['a', '', '1'], ['b', '', '2']] },
      { name: 'Repeated Header', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['a', '1'], ['Key', 'Value'], ['b', '2']] },
      { name: 'Embedded Note', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['a', '1'], ['continued below', ''], ['b', '2']] },
      { name: 'Clean', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['a', '1'], ['b', '2']] },
      { name: 'Trailing Blank', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['a', '1'], ['', '']] },
      { name: 'Leading Blank', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['', ''], ['a', '1']] },
    ],
  });
  const issues = validateJob(job);
  const merged = (id) => issues.filter((i) => i.target_id === id && /merged into one/.test(i.message));
  assert.ok(merged('T1').some((i) => /blank data row/.test(i.message)));
  assert.ok(merged('T2').some((i) => /blank column/.test(i.message)));
  assert.ok(merged('T3').some((i) => /repeats its column labels/.test(i.message)));
  assert.ok(merged('T4').some((i) => /single-value/.test(i.message)));
  assert.equal(merged('T1')[0].severity, 'warning');
  assert.deepEqual(merged('T1')[0].source_pages, [1]);
  for (const id of ['T5', 'T6', 'T7']) {
    assert.deepEqual(merged(id), [], `${id} must not warn as merged`);
  }
});

test('validate: calculation steps without operations warn; genuine steps do not', () => {
  const job = jobWith({
    tables: [{ name: 'Lookup One', sourcePages: [1], evidenceText: 'e', headers: ['Key', 'Value'], rows: [['a', '1']] }],
    routines: [
      {
        name: 'Prose Steps', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        steps: [
          'Look up alpha_value from Lookup One using alpha_key.',
          'Review the outcome with the team before proceeding.',
          'Contact the office for further guidance.',
        ],
      },
      {
        name: 'Genuine Strings', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [
          'Look up alpha_value from Lookup One using alpha_key.',
          'total_value = alpha_value + beta_value.',
          'Round total_value to the nearest whole unit.',
          'If total_value is below 100, set final_total to 100; otherwise final_total equals total_value.',
        ],
        inputs: ['alpha_key', 'beta_value'],
        outputs: ['final_total'],
      },
      {
        name: 'Genuine Objects', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [
          { sequence: 1, instruction: 'Look up factor', operation: 'lookup', inputs: ['alpha_key'], output: 'alpha_value', depends_on: ['Lookup One'] },
          { sequence: 2, instruction: 'Add margin', operation: 'expression', expression: 'total_value = alpha_value + 5', inputs: ['alpha_value'], output: 'total_value' },
        ],
      },
      { name: 'Prose Formula', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'APPLY legacy curve' },
    ],
  });
  const issues = validateJob(job);
  const noOps = (id) => issues.filter((i) => i.target_id === id && /without an evidenced operation/.test(i.message));
  const prose = noOps('R1');
  assert.equal(prose.length, 1);
  assert.match(prose[0].message, /2 steps/);
  assert.match(prose[0].message, /step 2, step 3/);
  assert.equal(prose[0].severity, 'warning');
  assert.deepEqual(prose[0].source_pages, [2]);
  for (const id of ['R2', 'R3', 'R4']) {
    assert.deepEqual(noOps(id), [], `${id} must not warn about missing operations`);
  }
});
