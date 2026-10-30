import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createJob, generateParameterizedLookups, generateWorkedExampleLookups, inferTableColumns, normalizeJob } from '../src/models.js';
import { classifyFormula, evaluateNumericExpression, validateJob } from '../src/validate.js';

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
  assert.equal(classifyFormula('rate2 = rate1 × fconst'), 'ok');
  assert.equal(classifyFormula('rate5 = rate4 × (1.0 − cspk)'), 'ok');
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
    tables: [{ name: 'T', sourcePages: [1], evidenceText: 'e', headers: ['A', 'B'], rows: [['1'], ['2', '3', '4']] }],
    routines: [{ name: 'R', kind: 'mystery', sourcePages: [1], evidenceText: 'e' }],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /more values than headers/.test(i.message)));
  assert.ok(issues.some((i) => /values after a gap may sit under the wrong header/.test(i.message)));
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

test('validate: dependency on a table alias resolves without warning', () => {
  const job = jobWith({
    tables: [{ name: 'SYN-CODE Part A', title: 'Synthetic Widget Multipliers', sourcePages: [1], evidenceText: 'e', headers: ['K'], rows: [['1']] }],
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = b * 2', dependsOn: ['SYN-CODE Part A'] }],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /matches no extracted table/.test(i.message)));
});

test('validate: step expressions with uninterpretable syntax warn with step attribution', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'x = a * (1:0 - b)', operation: 'assignment', expression: 'x = a * (1:0 - b)', output: 'x' },
        { sequence: 2, instruction: 'y = a + b', operation: 'assignment', expression: 'y = a + b', output: 'y' },
      ],
    }],
  });
  const issues = validateJob(job);
  const syntax = issues.filter((i) => /cannot reliably interpret/.test(i.message));
  assert.equal(syntax.length, 1);
  assert.match(syntax[0].message, /Step 1/);
});

test('validate: fallback check covers every condition on any routine kind', () => {
  const job = jobWith({
    routines: [
      {
        name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = b * 2',
        conditions: ['Where factor = 0.05 for ZONE_A; 0 otherwise.'],
      },
      {
        name: 'R2', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [{ sequence: 1, instruction: 'a = b * 2', operation: 'assignment', expression: 'a = b * 2', output: 'a' }],
        conditions: ['This adjustment applies strictly to ZONE_A risks.'],
      },
      {
        name: 'R3', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: ['IF widget_count is high THEN apply widget credit', 'ELSE refer for review'],
      },
    ],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => i.target_id === 'R1' && /no explicit fallback/.test(i.message)));
  assert.ok(issues.some((i) => i.target_id === 'R2' && /no explicit fallback/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R3' && /no explicit fallback/.test(i.message)));
});

test('validate: conflicting definitions of one output warn; init-then-assign stays silent', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'total = a + b', operation: 'assignment', expression: 'total = a + b', output: 'total' },
        { sequence: 2, instruction: 'total = a * b', operation: 'assignment', expression: 'total = a * b', output: 'total' },
        { sequence: 3, instruction: 'x = 0', operation: 'assignment', expression: 'x = 0', output: 'x' },
        { sequence: 4, instruction: 'x = coverage_limit', operation: 'assignment', expression: 'x = coverage_limit', output: 'x' },
      ],
    }],
  });
  const issues = validateJob(job);
  const conflicts = issues.filter((i) => /different formulas/.test(i.message));
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].message, /"total"/);
  assert.match(conflicts[0].message, /not treated as invalid/);
});

test('validate: cross-routine conflicting formulas warn', () => {
  const job = jobWith({
    routines: [
      { name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'total = a + b' },
      { name: 'R2', kind: 'formula', sourcePages: [2], evidenceText: 'e', expressionText: 'total = a * b' },
      { name: 'R3', kind: 'formula', sourcePages: [2], evidenceText: 'e', expressionText: 'other = a + b' },
    ],
  });
  const issues = validateJob(job);
  const conflicts = issues.filter((i) => /different formulas/.test(i.message));
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].message, /"total"/);
});

test('validate: declared inputs used nowhere warn as possible drift', () => {
  const job = jobWith({
    routines: [
      {
        name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e',
        expressionText: 'a = used_var * 2', inputs: ['used_var', 'orphan_var'], outputs: ['a'],
      },
      {
        name: 'R2', kind: 'formula', sourcePages: [1], evidenceText: 'e',
        expressionText: 'b = c * 2', inputs: ['c'], outputs: ['b'],
        conditions: ['Where c = 1 for ZONE_A; 0 otherwise.'],
      },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => i.target_id === 'R1' && /"orphan_var"/.test(i.message) && /used nowhere/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R1' && /"used_var"/.test(i.message) && /used nowhere/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /used nowhere/.test(i.message)));
});

test('validate: spaced multi-word inputs match spaced usage runs', () => {
  const job = jobWith({
    routines: [{
      name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e',
      expressionText: 'fee comp = sum(wk x fee alpha) + Pay1',
      inputs: ['wk', 'fee alpha', 'Pay1', 'orphan_var'], outputs: ['fee comp'],
    }],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /"orphan_var"/.test(i.message) && /used nowhere/.test(i.message)));
  assert.ok(!issues.some((i) => /"fee alpha"/.test(i.message) && /used nowhere/.test(i.message)),
    `spaced input must resolve: ${issues.map((i) => i.message).join(' | ')}`);
});

test('validate: comma-joined step outputs resolve each named part', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1, operation: 'expression',
          instruction: 'Harbor riders = HD-R1 + HD-R2; Harbor subtotal = Harbor core + Harbor riders',
          expression: 'Harbor riders = HD-R1 + HD-R2; Harbor subtotal = Harbor core + Harbor riders',
          output: 'Harbor riders, Harbor subtotal',
        },
        {
          sequence: 2, operation: 'expression',
          instruction: 'Harbor mean = Harbor subtotal / 2',
          expression: 'Harbor mean = Harbor subtotal / 2',
          inputs: ['Harbor subtotal', 'Harbor riders', 'ghost_var'], output: 'Harbor mean',
        },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/Harbor subtotal/.test(msgs), `joined output part must resolve: ${msgs}`);
  assert.ok(!/Harbor riders/.test(msgs), `joined output part must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"ghost_var"/.test(i.message) && /flagged as unresolved/.test(i.message)), `genuine gap must warn: ${msgs}`);
});

test('validate: currency amounts and multi-statement formulas are interpretable; colons stay review', () => {
  assert.equal(classifyFormula('total = max($750.00, round_half_up(subtotal, 2))'), 'ok');
  assert.equal(classifyFormula('a = x * y; b = a - z'), 'ok');
  assert.equal(classifyFormula('gross = subtotal + levy; final = max($750.00, gross)'), 'ok');
  assert.equal(classifyFormula('rate = base * (1:0 - credit)'), 'review');
  assert.equal(classifyFormula('a = x * y; APPLY legacy curve'), 'review');
});

test('validate: ambiguous table references name candidates instead of claiming no match', () => {
  const job = jobWith({
    tables: [
      { name: 'Harbor Dues Tariff HB-DUES Part A', sourcePages: [1], evidenceText: 'e', headers: ['K'], rows: [['a']] },
      { name: 'Harbor Dues Tariff HB-DUES Part B', sourcePages: [1], evidenceText: 'e', headers: ['K'], rows: [['b']] },
    ],
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', dependsOn: ['HB-DUES'] }],
  });
  const issues = validateJob(job);
  const dep = issues.find((i) => /depends on "HB-DUES"/.test(i.message));
  assert.ok(dep, `expected ambiguity warning, got: ${issues.map((i) => i.message).join(' | ')}`);
  assert.match(dep.message, /matches multiple tables/);
  assert.match(dep.message, /Part A/);
  assert.match(dep.message, /Part B/);
});

test('validate: same-step assignments and retrievals resolve; keys stay unresolved', () => {
  const job = jobWith({
    tables: [{ name: 'Fee Schedule', sourcePages: [1], evidenceText: 'Fee Schedule with fees in dollars', headers: ['Code', 'Fee'], rows: [['F1', '10']] }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1, operation: 'expression',
          instruction: 'Retrieve harbor rate HarborRate from Fee Schedule matching PORT-01. Gross total = HarborRate * units',
          expression: 'Gross total = HarborRate * units', inputs: ['HarborRate', 'PORT-01', 'units'], output: 'Gross total',
        },
        {
          sequence: 2, operation: 'expression',
          instruction: 'Add the surcharge: Net total = Gross total + SurchargeAmt',
          expression: 'Net total = Gross total + SurchargeAmt', inputs: ['Gross total', 'SurchargeAmt'], output: 'Net total',
        },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/HarborRate/.test(msgs), `retrieved value must resolve: ${msgs}`);
  assert.ok(!/Gross total/.test(msgs), `prior step output must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"PORT-01"/.test(i.message) && /flagged as unresolved/.test(i.message)), `lookup key must stay unresolved: ${msgs}`);
  assert.ok(issues.some((i) => /"units"/.test(i.message) && /flagged as unresolved/.test(i.message)), `undefined symbol must stay unresolved: ${msgs}`);
  assert.ok(issues.some((i) => /"SurchargeAmt"/.test(i.message) && /flagged as unresolved/.test(i.message)), `undefined symbol must stay unresolved: ${msgs}`);
});

test('validate: retrieval phrases define each listed item despite spacing', () => {
  const job = jobWith({
    tables: [{ name: 'Fee Schedule', sourcePages: [1], evidenceText: 'Fee Schedule with fees in dollars', headers: ['Code', 'Fee'], rows: [['F1', '10']] }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{
        sequence: 1, operation: 'expression',
        instruction: 'Retrieve ledger base Alpha base and Alpha factor from Fee Schedule. Alpha total = Alpha base + Alpha factor',
        expression: 'Alpha total = Alpha base + Alpha factor',
        inputs: ['Alpha base', 'Alpha factor', 'ghost_var'], output: 'Alpha total',
      }],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/Alpha base/.test(msgs), `first retrieved item must resolve: ${msgs}`);
  assert.ok(!/Alpha factor/.test(msgs), `second retrieved item must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"ghost_var"/.test(i.message) && /flagged as unresolved/.test(i.message)), `genuine gap must warn: ${msgs}`);
});

test('validate: Let definitions resolve same-step references', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{
        sequence: 1, operation: 'expression',
        instruction: 'Let flat charge be the sum of fees (Fee Index), and let surcharge rate be 3.5%. Harbor total = Harbor base + flat charge + surcharge rate',
        expression: 'Harbor total = Harbor base + flat charge + surcharge rate',
        inputs: ['Harbor base', 'flat charge', 'surcharge rate', 'ghost_var'], output: 'Harbor total',
      }],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/flat charge/.test(msgs), `Let-defined value must resolve: ${msgs}`);
  assert.ok(!/surcharge rate/.test(msgs), `Let-defined value must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"Harbor base"/.test(i.message) && /flagged as unresolved/.test(i.message)), `external input must warn: ${msgs}`);
  assert.ok(issues.some((i) => /"ghost_var"/.test(i.message) && /flagged as unresolved/.test(i.message)), `genuine gap must warn: ${msgs}`);
});

test('validate: unparseable worked calculations flag for review while parsed ones stay silent', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      // The yields-clause evaluation shape now structures; a second assignment
      // right of `=>` stays ambiguous for review.
      notes: 'Ledger total = $100 / 2 = 50.00 credits; Alpha fee = 0.040 => fee total = 0.960',
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(issues.some((i) => /Step 2.*states no confident operation/.test(i.message)), `ambiguous segment must warn: ${msgs}`);
  assert.ok(!/Step 1.*(states no confident operation|uses syntax)/.test(msgs), `parsed segment must stay silent: ${msgs}`);
});

test('validate: worked derived steps never contradict reusable routines', () => {
  const job = jobWith({
    routines: [
      {
        name: 'R1', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [{ sequence: 1, operation: 'expression', instruction: 'Ledger total = base amount + fee amount', expression: 'Ledger total = base amount + fee amount', inputs: ['base amount', 'fee amount'], output: 'Ledger total' }],
      },
      {
        name: 'W', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
        notes: 'Ledger total = $100 / 2 = 50.00 credits',
      },
    ],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /contradiction/.test(i.message)), `worked values must stay illustrative: ${issues.map((i) => i.message).join(' | ')}`);
});

test('validate: hyphen-subtraction operands count as used; codes stay whole', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e',
      expressionText: 'net = base x (1.0 + (load-1.0)-credit)',
      inputs: ['base', 'load', 'credit'], outputs: ['net'],
    }],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /used nowhere/.test(i.message)), `subtraction operands are used: ${issues.map((i) => i.message).join(' | ')}`);
});

test('validate: code-shaped cell values resolve references; plain words do not', () => {
  const job = jobWith({
    tables: [{
      name: 'Rider Matrix', sourcePages: [1], evidenceText: 'e', headers: ['Rider ID', 'Fee'],
      rows: [['RID-001', '10'], ['RID-002', '20'], ['None', '0']],
    }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'rider_total = RID-001 + RID-002', operation: 'expression', expression: 'rider_total = RID-001 + RID-002', inputs: ['RID-001', 'RID-002', 'RID-999'], output: 'rider_total' }],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/"RID-001"/.test(msgs), `defined code must resolve: ${msgs}`);
  assert.ok(!/"RID-002"/.test(msgs), `defined code must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"RID-999"/.test(i.message) && /flagged as unresolved/.test(i.message)), `undefined code must warn: ${msgs}`);
});

test('validate: overlapping range bands warn; disjoint and mixed columns stay silent', () => {
  const overlap = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['$1,000 to $2,500', '1.05'], ['$2,501 to $5,000', '1.00'], ['$5,000 to $9,999', '0.96']],
    }],
  });
  const overlapIssues = validateJob(overlap).filter((i) => /overlapping range bands/.test(i.message));
  assert.equal(overlapIssues.length, 1);
  assert.match(overlapIssues[0].message, /\$2,501 to \$5,000/);
  assert.match(overlapIssues[0].message, /\$5,000 to \$9,999/);

  const disjoint = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['$1,000 to $2,500', '1.05'], ['$2,501 to $5,000', '1.00']],
    }],
  });
  assert.ok(!validateJob(disjoint).some((i) => /overlapping range bands/.test(i.message)));

  const mixed = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['1 to 3 Units', '1.05'], ['Any', '1.00'], ['1 to 3 Units', '0.96']],
    }],
  });
  assert.ok(!validateJob(mixed).some((i) => /overlapping range bands/.test(i.message)));
});

test('validate: non-numeric values in otherwise-numeric columns warn', () => {
  const job = jobWith({
    tables: [{
      name: 'Factors', sourcePages: [1], evidenceText: 'e', headers: ['Tier', 'Factor'],
      rows: [['T1', '0.85'], ['T2', '0.92'], ['T3', '1.00'], ['T4', 'Hold for review']],
    }],
  });
  const issues = validateJob(job).filter((i) => /non-numeric value/.test(i.message));
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /"Hold for review"/);
  assert.match(issues[0].message, /"Factor"/);

  const texty = jobWith({
    tables: [{
      name: 'Factors', sourcePages: [1], evidenceText: 'e', headers: ['Tier', 'Note'],
      rows: [['T1', 'low'], ['T2', 'high'], ['T3', 'mid'], ['T4', 'hold']],
    }],
  });
  assert.ok(!validateJob(texty).some((i) => /non-numeric value/.test(i.message)));
});

test('validate: uncertain decoding is flagged; clock times stay silent', () => {
  const fffd = String.fromCharCode(0xfffd);
  const job = jobWith({
    tables: [{
      name: `Rates${fffd}`, sourcePages: [1], evidenceText: 'e', headers: ['A'], rows: [['1']],
    }],
    routines: [
      { name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = b * (1:0 - c)' },
      { name: 'R2', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = b * 2', notes: 'Reviewed at 10:30 daily.' },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => i.target_type === 'table' && /uncertain decoding/.test(i.message)), 'replacement char must flag');
  assert.ok(issues.some((i) => i.target_id === 'R1' && /uncertain decoding/.test(i.message) && /1:0/.test(i.message)), 'colon decimal must flag');
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /uncertain decoding/.test(i.message)), 'clock time must stay silent');
});

test('validate: reported contradictions surface without choosing a winner', () => {
  const job = jobWith({
    routines: [
      { name: 'R1', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = b * 2', notes: 'Alternative formula c = b + 2 preserved as conflicting; verify which applies.' },
      { name: 'R2', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = b * 2', notes: 'Source value preserved verbatim for analyst review.' },
    ],
  });
  const issues = validateJob(job);
  const hit = issues.find((i) => i.target_id === 'R1' && /possible contradiction/.test(i.message));
  assert.ok(hit, `conflict note must surface: ${issues.map((i) => i.message).join(' | ')}`);
  assert.match(hit.message, /without choosing one/);
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /possible contradiction/.test(i.message)));
});

test('validate: same condition with different branches warns; identical branches stay silent', () => {
  const job = jobWith({
    routines: [
      {
        name: 'R1', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: [
          { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Apply deep-draft fee' },
          { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Waive the fee' },
        ],
      },
      {
        name: 'R2', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: [
          { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Apply deep-draft fee' },
          { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Apply deep-draft fee' },
        ],
      },
    ],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => i.target_id === 'R1' && /different branches/.test(i.message) && /possible contradiction/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /different branches/.test(i.message)));
});

test('validate: cross-routine step definitions of one output warn', () => {
  const job = jobWith({
    routines: [
      {
        name: 'R1', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [{ sequence: 1, instruction: 'shared_total = a + b', operation: 'assignment', expression: 'shared_total = a + b', output: 'shared_total' }],
      },
      {
        name: 'R2', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        steps: [{ sequence: 1, instruction: 'shared_total = a * b', operation: 'assignment', expression: 'shared_total = a * b', output: 'shared_total' }],
      },
    ],
  });
  const issues = validateJob(job);
  const hit = issues.find((i) => i.target_id === 'R2' && /both assign "shared_total" with different formulas/.test(i.message));
  assert.ok(hit, `expected cross-routine conflict, got: ${issues.map((i) => i.message).join(' | ')}`);
  assert.match(hit.message, /possible contradiction/);
});

test('validate: series member skipped by an enumerating step warns; scattered uses stay silent', () => {
  const job = jobWith({
    tables: [{
      name: 'Rider Matrix', sourcePages: [1], evidenceText: 'Rider matrix in dollars', headers: ['Rider ID', 'Fee'],
      rows: [['RID-001', '10'], ['RID-002', '20'], ['RID-003', '30'], ['RID-004', '40']],
    }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'rider_total = RID-001 + RID-002 + RID-003', operation: 'expression', expression: 'rider_total = RID-001 + RID-002 + RID-003', inputs: ['RID-001', 'RID-002', 'RID-003'], output: 'rider_total' }],
    }],
  });
  const issues = validateJob(job);
  const hit = issues.find((i) => i.target_type === 'table' && /"RID-004"/.test(i.message));
  assert.ok(hit, `expected series omission warning, got: ${issues.map((i) => i.message).join(' | ')}`);
  assert.match(hit.message, /3 of 4 "RID-" codes are used/);
  assert.match(hit.message, /verify whether the omission is intended/);

  const scattered = jobWith({
    tables: [{
      name: 'Zone Table', sourcePages: [1], evidenceText: 'Zone table in dollars', headers: ['Zone', 'Factor'],
      rows: [['ZONE_1', '1.0'], ['ZONE_2', '1.1'], ['ZONE_3', '1.2'], ['ZONE_4', '1.3'], ['ZONE_5', '1.4']],
    }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'a = ZONE_1 + ZONE_2', operation: 'expression', expression: 'a = ZONE_1 + ZONE_2', inputs: ['ZONE_1', 'ZONE_2'], output: 'a' },
        { sequence: 2, instruction: 'b = ZONE_4 + ZONE_5', operation: 'expression', expression: 'b = ZONE_4 + ZONE_5', inputs: ['ZONE_4', 'ZONE_5'], output: 'b' },
      ],
    }],
  });
  assert.ok(!validateJob(scattered).some((i) => /"ZONE_3"/.test(i.message) && /omission is intended/.test(i.message)));
});

test('validate: series coverage ignores notes and self-matches; full use stays silent', () => {
  const job = jobWith({
    tables: [{
      name: 'Rider Matrix', sourcePages: [1], evidenceText: 'Rider matrix in dollars', headers: ['Rider ID', 'Fee'],
      rows: [['RID-001', '10'], ['RID-002', '20'], ['RID-003', '30']],
    }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      notes: 'RID-003 is intentionally excluded from the aggregation.',
      steps: [{ sequence: 1, instruction: 'rider_total = RID-001 + RID-002', operation: 'expression', expression: 'rider_total = RID-001 + RID-002', inputs: ['RID-001', 'RID-002'], output: 'rider_total' }],
    }],
  });
  // Only two siblings co-occur, below the enumeration gate: silent either way.
  assert.ok(!validateJob(job).some((i) => /"RID-003"/.test(i.message) && /omission is intended/.test(i.message)));

  const full = jobWith({
    tables: [{
      name: 'Rider Matrix', sourcePages: [1], evidenceText: 'Rider matrix in dollars', headers: ['Rider ID', 'Fee'],
      rows: [['RID-001', '10'], ['RID-002', '20'], ['RID-003', '30']],
    }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'rider_total = RID-001 + RID-002 + RID-003', operation: 'expression', expression: 'rider_total = RID-001 + RID-002 + RID-003', inputs: ['RID-001', 'RID-002', 'RID-003'], output: 'rider_total' }],
    }],
  });
  assert.ok(!validateJob(full).some((i) => /omission is intended/.test(i.message)));
});

test('validate: conditional language in unstructured steps warns without guessing the fallback', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Levy = round(subtotal x 0.025). This levy applies strictly to ZONE_A properties.', operation: 'expression', expression: 'Levy = round(subtotal x 0.025)', inputs: ['subtotal'], output: 'Levy' },
        { sequence: 2, instruction: 'total = base + fee; 0 otherwise', operation: 'expression', expression: 'total = base + fee', inputs: ['base', 'fee'], output: 'total' },
        { sequence: 3, instruction: 'net = gross - discount where discount = 5', operation: 'expression', expression: 'net = gross - discount', inputs: ['gross', 'discount'], output: 'net' },
      ],
    }],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /Step 1 states an applicability condition/.test(i.message) && /no structured branch/.test(i.message)), `step 1 must warn: ${issues.map((i) => i.message).join(' | ')}`);
  assert.ok(issues.some((i) => /Step 2 states an applicability condition/.test(i.message)), 'step 2 must warn');
  assert.ok(!issues.some((i) => /Step 3 states an applicability condition/.test(i.message)), 'definitional where-clause must stay silent');
});

test('validate: structured conditions shield steps from the unstructured-condition warning', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      conditions: ['If total is below 100, set total to 100; otherwise total stands.'],
      steps: [
        { sequence: 1, instruction: 'If total is below 100, set total to 100; otherwise total stands.', operation: 'condition', expression: '', inputs: ['total'], output: 'total' },
        { sequence: 2, instruction: 'Levy = round(subtotal x 0.025). This levy applies strictly to ZONE_A properties.', operation: 'expression', expression: 'Levy = round(subtotal x 0.025)', inputs: ['subtotal'], output: 'Levy' },
        'Ask someone else to review the schedule.',
      ],
    }],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /applicability condition/.test(i.message)), `structured and prose-only steps must stay silent: ${issues.map((i) => i.message).join(' | ')}`);
});

test('validate: short rows warn misalignment; explicit blanks keep column attribution', () => {
  const job = jobWith({
    tables: [{
      name: 'Factors', sourcePages: [1], evidenceText: 'Factor table in dollars', headers: ['Tier', 'Low', 'High'],
      rows: [['T1', '0.85', '0.90'], ['T2', '0.92']],
    }],
  });
  const issues = validateJob(job);
  const hit = issues.find((i) => /row 2 has 2 value\(s\) for 3 columns/.test(i.message));
  assert.ok(hit, `expected misalignment warning, got: ${issues.map((i) => i.message).join(' | ')}`);
  assert.match(hit.message, /may sit under the wrong header/);
  assert.ok(!issues.some((i) => /blank cell\(s\) in column/.test(i.message)), 'short rows must not blame a trailing column');

  const explicit = jobWith({
    tables: [{
      name: 'Factors', sourcePages: [1], evidenceText: 'Factor table in dollars', headers: ['Tier', 'Low', 'High'],
      rows: [['T1', '0.85', '0.90'], ['T2', '', '0.95'], ['T3', '0.80', '0.88'], ['T4', '0.81', '0.89']],
    }],
  });
  assert.ok(validateJob(explicit).some((i) => /blank cell\(s\) in column "Low"/.test(i.message)), 'explicit blanks keep column attribution');
});

// ---------- bounded arithmetic consistency (G3) ----------
// Recomputation warnings are filtered by /recomputing/ so these tests stay
// independent of every other validator check.

test('validate: matching step arithmetic stays silent', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        'Alpha net = 3.40 x 1.180 = 4.0120',
        'Ledger total = $12,500 / 100.0 = 125.0000 credits',
      ],
    }],
  });
  assert.deepEqual(
    validateJob(job).filter((i) => /recomputing/.test(i.message)), [],
    'consistent worked chains must not warn'
  );
});

test('validate: rounding mismatch warns with step, stated, computed, and difference', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: ['Pprem = Round(850.0000 x 5.7773, 2) = 4910.00'],
    }],
  });
  const issues = validateJob(job);
  const arithmetic = issues.filter((i) => /recomputing/.test(i.message));
  assert.equal(arithmetic.length, 1);
  assert.equal(arithmetic[0].severity, 'warning');
  assert.match(arithmetic[0].message, /Step 1/);
  assert.match(arithmetic[0].message, /Pprem/);
  assert.match(arithmetic[0].message, /4910\.00/);
  assert.match(arithmetic[0].message, /4910\.71/);
  assert.match(arithmetic[0].message, /difference/);
  // Source values are preserved, never auto-corrected.
  assert.deepEqual(job.routines[0].steps_detailed[0].stated_results, [{ output: 'Pprem', value: '4910.00' }]);
});

test('validate: symbolic step expressions stay silent for arithmetic', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: ['Rate step2 = Ratestep1 x Fconst = 9.99'],
    }],
  });
  assert.deepEqual(
    validateJob(job).filter((i) => /recomputing/.test(i.message)), [],
    'unresolvable identifiers must not be manufactured into numbers'
  );
});

test('validate: steps with missing operands stay silent for arithmetic', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Alpha = 3.40 x', operation: 'expression', expression: 'Alpha = 3.40 x', output: 'Alpha', stated_results: [{ output: 'Alpha', value: '9.99' }] },
      ],
    }],
  });
  assert.deepEqual(
    validateJob(job).filter((i) => /recomputing/.test(i.message)), [],
    'incomplete right-hand sides must not be evaluated'
  );
});

test('validate: floating-point arithmetic within tolerance stays silent', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: ['Gamma = 0.10 + 0.20 = 0.30'],
    }],
  });
  assert.deepEqual(
    validateJob(job).filter((i) => /recomputing/.test(i.message)), [],
    '0.10 + 0.20 must not warn against stated 0.30'
  );
});

// ---------- rating-band gaps, endpoints, condition ranges, precedence (G5) ----------

test('validate: numeric gaps between rating bands warn; whole-unit adjacency stays silent', () => {
  const job = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['1 to 3 Units', '1.05'], ['5 to 9 Units', '0.96']],
    }],
  });
  const gaps = validateJob(job).filter((i) => /possible gap between range bands/.test(i.message));
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].message, /1 to 3 Units/);
  assert.match(gaps[0].message, /5 to 9 Units/);
  assert.match(gaps[0].message, /between 3 and 5/);
  assert.match(gaps[0].message, /without inferring a boundary/);
  assert.equal(gaps[0].severity, 'warning');

  const adjacent = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['$1,000 to $2,500', '1.05'], ['$2,501 to $5,000', '1.00']],
    }],
  });
  assert.ok(!validateJob(adjacent).some((i) => /possible gap between range bands/.test(i.message)),
    'consecutive whole-unit bands are the contiguous idiom');

  const enumeration = jobWith({
    tables: [{
      name: 'Tiers', sourcePages: [1], evidenceText: 'e', headers: ['Tier', 'Factor'],
      rows: [['1', '1.05'], ['2', '1.00'], ['4', '0.96']],
    }],
  });
  assert.ok(!validateJob(enumeration).some((i) => /possible gap between range bands/.test(i.message)),
    'pure single-value columns are enumerations, not bands');
});

test('validate: interior band overlaps keep the overlap message', () => {
  const job = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['1 to 10 Units', '1.05'], ['5 to 15 Units', '0.96']],
    }],
  });
  const overlaps = validateJob(job).filter((i) => /overlapping range bands/.test(i.message));
  assert.equal(overlaps.length, 1);
  assert.match(overlaps[0].message, /both cover 5 to 10/);
});

test('validate: shared endpoints flag unclear inclusivity; explicit bounds resolve silently', () => {
  const shared = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['$10,000', '1.10'], ['$10,000 to $25,000', '1.05'], ['$30,000 to $40,000', '0.96']],
    }],
  });
  const sharedIssues = validateJob(shared);
  const endpoints = sharedIssues.filter((i) => /sharing the endpoint value/.test(i.message));
  assert.equal(endpoints.length, 1);
  assert.match(endpoints[0].message, /10000/);
  assert.match(endpoints[0].message, /\$10,000 to \$25,000/);
  assert.match(endpoints[0].message, /one band or both/);

  const exclusive = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['<25', '1.10'], ['25 to 50', '1.05'], ['60 to 90', '0.96']],
    }],
  });
  assert.ok(!validateJob(exclusive).some((i) => /endpoint value|overlapping range bands/.test(i.message)),
    'an explicitly exclusive bound leaves no dual coverage');

  const dual = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['<=25', '1.10'], ['>=25', '1.05'], ['60 to 90', '0.96'], ['100 to 120', '0.90']],
    }],
  });
  const dualOverlaps = validateJob(dual).filter((i) => /overlapping range bands/.test(i.message));
  assert.ok(dualOverlaps.some((i) => /both cover 25/.test(i.message)),
    'two explicitly inclusive bounds genuinely overlap');
});

test('validate: overlapping condition ranges warn with the shared variable and region', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [
        { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Apply deep-draft fee' },
        { condition: 'Harbor draft exceeds 25 feet', true_branch: 'Waive the fee' },
      ],
    }],
  });
  const overlaps = validateJob(job).filter((i) => /may both apply/.test(i.message));
  assert.equal(overlaps.length, 1);
  assert.match(overlaps[0].message, /Harbor draft/);
  assert.match(overlaps[0].message, /above 30/);
  assert.match(overlaps[0].message, /without choosing one|which takes precedence/);
  assert.equal(overlaps[0].severity, 'warning');

  const touching = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [
        { condition: 'Vessel length >= 50 feet', true_branch: 'Apply fee' },
        { condition: 'Vessel length <= 50 feet', true_branch: 'Waive fee' },
      ],
    }],
  });
  const touchIssues = validateJob(touching).filter((i) => /may both apply/.test(i.message));
  assert.equal(touchIssues.length, 1);
  assert.match(touchIssues[0].message, /at exactly 50/);
});

test('validate: precedence cues are quoted without applying them', () => {
  const cued = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      notes: 'Rule A and Rule B conflict. Higher section number controls unless overridden by memo.',
      steps: [
        { sequence: 1, instruction: 'shared_total = a + b', operation: 'assignment', expression: 'shared_total = a + b', output: 'shared_total' },
        { sequence: 2, instruction: 'shared_total = a * b', operation: 'assignment', expression: 'shared_total = a * b', output: 'shared_total' },
      ],
    }],
  });
  const cuedIssues = validateJob(cued).filter((i) => /different formulas/.test(i.message));
  assert.equal(cuedIssues.length, 1);
  assert.match(cuedIssues[0].message, /Higher section number controls/);
  assert.match(cuedIssues[0].message, /without applying it/);

  const plain = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'shared_total = a + b', operation: 'assignment', expression: 'shared_total = a + b', output: 'shared_total' },
        { sequence: 2, instruction: 'shared_total = a * b', operation: 'assignment', expression: 'shared_total = a * b', output: 'shared_total' },
      ],
    }],
  });
  const plainIssues = validateJob(plain).filter((i) => /different formulas/.test(i.message));
  assert.equal(plainIssues.length, 1);
  assert.ok(!/precedence rule/.test(plainIssues[0].message), 'no cue, no citation');

  const supersedes = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'Section 114 supersedes standard discounts.',
      conditions: [
        { condition: 'Fleet size > 10 units', true_branch: 'Apply fleet discount' },
        { condition: 'Fleet size > 5 units', true_branch: 'Charge full rate' },
      ],
    }],
  });
  const rangeIssues = validateJob(supersedes).filter((i) => /may both apply/.test(i.message));
  assert.equal(rangeIssues.length, 1);
  assert.match(rangeIssues[0].message, /supersedes standard discounts/);
});

test('validate: boundary and conflict warnings do not duplicate', () => {
  const shared = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e', headers: ['Band', 'Factor'],
      rows: [['$10,000', '1.10'], ['$10,000 to $25,000', '1.05'], ['$25,001 to $40,000', '0.96']],
    }],
  });
  assert.equal(validateJob(shared).filter((i) => /range bands|endpoint value/.test(i.message)).length, 1);

  const identical = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [
        { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Apply deep-draft fee' },
        { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Waive the fee' },
      ],
    }],
  });
  const identicalIssues = validateJob(identical);
  assert.ok(identicalIssues.some((i) => /different branches/.test(i.message)));
  assert.ok(!identicalIssues.some((i) => /may both apply/.test(i.message)),
    'identical conditions stay with the identical-condition check');
});

test('validate: missing markers warn once without duplicating blank-column warnings', () => {
  const job = jobWith({
    tables: [{
      name: 'Codes', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'],
      columns: [{ label: 'Code', role: 'key' }, { label: 'Cost', role: 'output' }],
      rows: [['A1', '1.10'], ['A2', '[N/A]'], ['A3', '']],
    }],
  });
  const issues = validateJob(job);
  const markers = issues.filter((i) => /not populated in source/.test(i.message));
  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /marks row 2 column "Cost" as "\[N\/A\]"/);
  const missing = issues.filter((i) => /missing value\(s\) in output column "Cost"/.test(i.message));
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /has 1 missing value/, 'marker cell stays with the marker check');
});

test('validate: page citations matching recorded pages stay silent', () => {
  const job = jobWith({
    tables: [{ name: 'Base Rates', sourcePages: [2], evidenceText: 'e', headers: ['Code', 'Rate'], rows: [['A1', '1.10']] }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [3], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'Retrieve Rbase from Table Base Rates (Page 2) matching the territory.', operation: 'lookup', expression: 'Rstep1 = Rbase', inputs: ['Code'], output: 'Rstep1' }],
    }],
  });
  assert.deepEqual(validateJob(job).filter((i) => /citation/.test(i.message)), []);
});

test('validate: page citations conflicting with recorded pages warn without rewriting', () => {
  const job = jobWith({
    tables: [{ name: 'Base Rates', sourcePages: [2], evidenceText: 'e', headers: ['Code', 'Rate'], rows: [['A1', '1.10']] }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [3], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'Retrieve Rbase from Table Base Rates (Page 1) matching the territory.', operation: 'lookup', expression: 'Rstep1 = Rbase', inputs: ['Code'], output: 'Rstep1' }],
    }],
  });
  const cites = validateJob(job).filter((i) => /citation/.test(i.message));
  assert.equal(cites.length, 1);
  assert.equal(cites[0].severity, 'warning');
  assert.match(cites[0].message, /Step 1/);
  assert.match(cites[0].message, /Base Rates/);
  assert.match(cites[0].message, /Page 1/);
  assert.match(cites[0].message, /page\(s\) 2/);
  assert.match(cites[0].message, /preserved, not corrected/);
  assert.equal(
    job.routines[0].steps_detailed[0].instruction,
    'Retrieve Rbase from Table Base Rates (Page 1) matching the territory.'
  );
});

test('validate: known table, column, and input references resolve silently', () => {
  const job = jobWith({
    tables: [{ name: 'Base Rates', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Rate'], rows: [['A1', '1.10']] }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      inputs: ['territory'],
      steps: [{ sequence: 1, instruction: 'Cost = Rate + 0.05', operation: 'expression', expression: 'Cost = Rate + 0.05', inputs: ['Rate', 'territory'], output: 'Cost' }],
      dependsOn: ['Base Rates'],
    }],
  });
  const stray = validateJob(job).filter((i) => /matches no|flagged as unresolved|matches multiple tables/.test(i.message));
  assert.deepEqual(stray, []);
});

test('validate: genuinely unresolved references still warn', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'Cost = ghost_var + 1', operation: 'expression', expression: 'Cost = ghost_var + 1', inputs: ['ghost_var'], output: 'Cost' }],
      dependsOn: ['No Such Table Anywhere'],
    }],
  });
  const issues = validateJob(job);
  assert.ok(issues.some((i) => /"ghost_var".*flagged as unresolved/.test(i.message)));
  assert.ok(issues.some((i) => /"No Such Table Anywhere", which matches no extracted table/.test(i.message)));
});

test('validate: repeated note sentences warn once per rule', () => {
  const repeated = jobWith({
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', notes: 'Rule A conflicts with Rule B. Rule A conflicts with Rule B.' }],
  });
  assert.equal(validateJob(repeated).filter((i) => /possible contradiction/.test(i.message)).length, 1);

  const fragment = jobWith({
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', notes: 'Conflicting alternative preserved separately; flagged as conflicting with the main steps.' }],
  });
  assert.equal(validateJob(fragment).filter((i) => /possible contradiction/.test(i.message)).length, 1);
});

test('validate: distinct note sentences stay separate warnings', () => {
  const job = jobWith({
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', notes: 'Rule A conflicts with Rule B. Rule C contradicts Rule D instead.' }],
  });
  assert.equal(validateJob(job).filter((i) => /possible contradiction/.test(i.message)).length, 2);

  const gaps = jobWith({
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', notes: 'Flag the missing lookup range. Also flag the undefined surcharge factor.' }],
  });
  assert.equal(validateJob(gaps).filter((i) => /possible gap/.test(i.message)).length, 2);
});

test('validate: short rows never attribute missing values to a column', () => {
  const job = jobWith({
    tables: [{
      name: 'Codes', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost', 'Note'],
      columns: [{ label: 'Code', role: 'key' }, { label: 'Cost', role: 'output' }, { label: 'Note', role: 'output' }],
      rows: [['A1', '1.10', 'x'], ['A2'], ['A3', '', 'y']],
    }],
  });
  const issues = validateJob(job);
  const missing = issues.filter((i) => /missing value\(s\) in output column "Cost"/.test(i.message));
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /has 1 missing value/, 'only the explicit blank counts, never the short-row gap');
  assert.equal(issues.filter((i) => /values after a gap may sit under the wrong header/.test(i.message)).length, 1);
});

test('validate: ragged summary covers only over-long rows', () => {
  const long = jobWith({
    tables: [{ name: 'T', sourcePages: [1], evidenceText: 'e', headers: ['A', 'B'], rows: [['1', '2'], ['3', '4', '5']] }],
  });
  assert.ok(validateJob(long).some((i) => /more values than headers/.test(i.message)));

  const shortOnly = jobWith({
    tables: [{ name: 'T', sourcePages: [1], evidenceText: 'e', headers: ['A', 'B', 'C'], rows: [['1', '2', '3'], ['4', '5']] }],
  });
  const shortIssues = validateJob(shortOnly);
  assert.ok(!shortIssues.some((i) => /column counts differing|more values than headers/.test(i.message)),
    'the short-row detail already names the row');
  assert.ok(shortIssues.some((i) => /values after a gap may sit under the wrong header/.test(i.message)));
});

test('validate: quoted citation conditions skip the fallback demand', () => {
  const quoted = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [
        'RULE-CONF-B1 (Section 8.2): "The factor must be applied sequentially after the base."',
        'RULE-CONF-B2 (Section 6.1): "The factors are additive adjustments applied concurrently."',
      ],
    }],
  });
  assert.deepEqual(validateJob(quoted).filter((i) => /no explicit fallback/.test(i.message)), []);

  const conditionalQuote = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: ['Note: "Active" status applies if the count exceeds 5.'],
    }],
  });
  assert.ok(validateJob(conditionalQuote).some((i) => /no explicit fallback/.test(i.message)),
    'quoted text with conditional language still needs a fallback');

  const plain = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: ['Widget count is steady. Apply widget credit.'],
    }],
  });
  assert.ok(validateJob(plain).some((i) => /no explicit fallback/.test(i.message)));

  const structured = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [{ condition: '"Quoted rule text."', true_branch: 'Apply the cap' }],
    }],
  });
  assert.ok(validateJob(structured).some((i) => /no explicit fallback/.test(i.message)),
    'explicit branch structure still needs its fallback reviewed');
});

test('validate: marker cells and short rows warn independently', () => {
  const job = jobWith({
    tables: [{
      name: 'Codes', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost', 'Note'],
      rows: [['A1', '[TBD]', 'x'], ['A2', '1.20']],
    }],
  });
  const issues = validateJob(job);
  assert.equal(issues.filter((i) => /not populated in source/.test(i.message)).length, 1);
  assert.equal(issues.filter((i) => /values after a gap may sit under the wrong header/.test(i.message)).length, 1);
});

test('validate: disjoint and consistent rules stay silent; worked examples stay illustrative', () => {
  const disjoint = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [
        { condition: 'Harbor draft > 30 feet', true_branch: 'Apply deep-draft fee' },
        { condition: 'Harbor draft < 20 feet', true_branch: 'Waive the fee' },
      ],
    }],
  });
  assert.ok(!validateJob(disjoint).some((i) => /may both apply/.test(i.message)));

  const consistent = jobWith({
    routines: [{
      name: 'R', kind: 'condition', sourcePages: [1], evidenceText: 'e',
      conditions: [
        { condition: 'Harbor draft exceeds 30 feet', true_branch: 'Apply deep-draft fee' },
        { condition: 'Harbor draft exceeds 25 feet', true_branch: 'Apply deep-draft fee' },
      ],
    }],
  });
  assert.ok(!validateJob(consistent).some((i) => /may both apply/.test(i.message)),
    'overlapping conditions with the same branch agree');

  const worked = jobWith({
    routines: [{
      name: 'W', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'shared_total = a + b', operation: 'assignment', expression: 'shared_total = a + b', output: 'shared_total' },
        { sequence: 2, instruction: 'shared_total = a * b', operation: 'assignment', expression: 'shared_total = a * b', output: 'shared_total' },
      ],
    }],
  });
  assert.ok(!validateJob(worked).some((i) => /different formulas/.test(i.message)),
    'illustrative worked steps are not normative definitions');
});

// ---------- generic validation defect fixes: literals, bindings, constants ----------

test('validate: currency, percent, and signed literals in step refs resolve; unknown symbols still warn', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1,
          instruction: 'Class premium', expression: '( $450,000 / 100 ) × $3.45',
          inputs: ['$450,000', '$3.45'], output: '$15,525.00',
        },
        {
          sequence: 2,
          instruction: 'Schedule credit', expression: '$14,742.08 × (−0.05)',
          inputs: ['$14,742.08', '−0.05', '0.00%'], output: '−$737.10',
        },
        {
          sequence: 3, operation: 'expression',
          instruction: 'Use missing', expression: 'ghost_var + 1',
          inputs: ['ghost_var'], output: 'out',
        },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  for (const lit of ['$450,000', '$3.45', '$14,742.08', '−0.05', '0.00%']) {
    assert.ok(!issues.some((i) => i.message.includes(`"${lit}"`) && /flagged as unresolved/.test(i.message)),
      `literal ${lit} must resolve: ${msgs}`);
  }
  assert.ok(issues.some((i) => /"ghost_var".*flagged as unresolved/.test(i.message)),
    `genuinely undefined symbol must still warn: ${msgs}`);
});

test('validate: var=value step bindings resolve; bindings of undefined refs still warn', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1,
          instruction: 'Base premium', expression: '850 × $26.60',
          inputs: ['E=850', 'Rcombined=$26.60'], output: '$22,610.00',
        },
        {
          sequence: 2,
          instruction: 'Bad binding', expression: 'X + 1',
          inputs: ['X=undefined_var'], output: 'out',
        },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!issues.some((i) => /"E=850"/.test(i.message)), `literal binding must resolve: ${msgs}`);
  assert.ok(!issues.some((i) => /"Rcombined=\$26\.60"/.test(i.message)), `currency binding must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"X=undefined_var"/.test(i.message) && /flagged as unresolved/.test(i.message)),
    `binding of an undefined ref must still warn: ${msgs}`);
});

test('validate: constants with currency and unicode minus define terms; bare undefined refs still warn', () => {
  const job = jobWith({
    routines: [
      {
        name: 'Defs', kind: 'condition', sourcePages: [1], evidenceText: 'Credit −5.0% (Squestionnaire = −0.05). Floor Rfloor = $0.060.',
        conditions: ['IF x THEN y ELSE z'],
      },
      {
        name: 'Uses', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
        steps: [
          { sequence: 1, instruction: 'M = Floss × (1 + Squestionnaire)', operation: 'expression', expression: 'M = Floss × (1 + Squestionnaire)', inputs: ['Floss', 'Squestionnaire'], output: 'M' },
          { sequence: 2, instruction: 'F = max(A, Rfloor)', operation: 'expression', expression: 'F = max(A, Rfloor)', inputs: ['A', 'Rfloor'], output: 'F' },
          { sequence: 3, instruction: 'G = ghost_var + 1', operation: 'expression', expression: 'G = ghost_var + 1', inputs: ['ghost_var'], output: 'G' },
        ],
        inputs: ['Floss', 'A'],
      },
    ],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/"Squestionnaire"/.test(msgs), `unicode-minus constant must resolve: ${msgs}`);
  assert.ok(!/"Rfloor"/.test(msgs), `currency constant must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"ghost_var".*flagged as unresolved/.test(i.message)),
    `genuinely undefined symbol must still warn: ${msgs}`);
});

test('validate: parenthesized header symbols resolve refs; unrelated symbols still warn', () => {
  const job = jobWith({
    tables: [{
      name: 'Factors', sourcePages: [1], evidenceText: 'e',
      headers: ['Class Code', 'Liability Factor (Fclass_liab)', 'Driver Factor (Fdriver)'],
      rows: [['0120', '1.00', '1.00']],
    }],
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'P = B × Fclass_liab × Fdriver', operation: 'expression', expression: 'P = B × Fclass_liab × Fdriver', inputs: ['B', 'Fclass_liab', 'Fdriver'], output: 'P' },
        { sequence: 2, instruction: 'Q = ghost_var + 1', operation: 'expression', expression: 'Q = ghost_var + 1', inputs: ['ghost_var'], output: 'Q' },
      ],
      inputs: ['B'],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!/"Fclass_liab"/.test(msgs), `header symbol must resolve: ${msgs}`);
  assert.ok(!/"Fdriver"/.test(msgs), `header symbol must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"ghost_var".*flagged as unresolved/.test(i.message)),
    `genuinely undefined symbol must still warn: ${msgs}`);
});

test('validate: prior-step currency outputs with separators resolve; threshold-form refs need defined variables', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1,
          instruction: 'Manual premium', expression: '( $450,000 / 100 ) × $3.45',
          inputs: ['$450,000', '$3.45'], output: '$15,525.00',
        },
        {
          sequence: 2,
          instruction: 'Total', expression: '$15,525.00 + $187.00',
          inputs: ['$15,525.00', '$187.00'], output: '$15,712.00',
        },
        {
          sequence: 3, instruction: 'Expense constant', expression: 'Flat charge (STD < $200k)',
          inputs: ['STD < $200k'], output: '$160.00',
        },
        {
          sequence: 4, instruction: 'Bad qualifier', expression: 'Flat charge (GhostVar < $200k)',
          inputs: ['GhostVar < $200k'], output: '$160.00',
        },
      ],
    },
    {
      name: 'S', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [{ sequence: 1, instruction: 'STD = SP + 1', operation: 'expression', expression: 'STD = SP + 1', inputs: ['SP'], output: 'STD' }],
      inputs: ['SP'],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!issues.some((i) => /"\$15,525\.00"/.test(i.message) && /flagged as unresolved/.test(i.message)),
    `prior-step currency output must resolve: ${msgs}`);
  assert.ok(!issues.some((i) => /"STD < \$200k"/.test(i.message) && /flagged as unresolved/.test(i.message)),
    `threshold qualifier over a defined variable must resolve: ${msgs}`);
  assert.ok(issues.some((i) => /"GhostVar < \$200k"/.test(i.message) && /flagged as unresolved/.test(i.message)),
    `threshold qualifier over an undefined variable must still warn: ${msgs}`);
});

// ---------- formula and routine-kind recognition ----------

test('validate: Greek-letter, Round2/Round0, max, and sum expressions are interpretable; unsafe syntax stays review', () => {
  assert.equal(classifyFormula('Πgross = ΠCSL + ΠPIP + ΠOTC + ΠCOLL'), 'ok');
  assert.equal(classifyFormula('Πunit_final = max( Round0( Πunit_raw × (1 − Dfleet) ), $450 )'), 'ok');
  assert.equal(classifyFormula('ΠCSL = Round2( BCSL × Fclass × Fuse × Fdriver × ILF )'), 'ok');
  assert.equal(classifyFormula('MP = ∑ [ ( Payroll / 100 ) × Rate ]'), 'ok');
  assert.equal(classifyFormula('Πa = (Πb + 1'), 'review');
  assert.equal(classifyFormula('STD = ( SP × ( 1 ± SCHED ) ) + DVIC'), 'review');

  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'ΠCSL = Round2( BCSL × ILF )', operation: 'expression', expression: 'ΠCSL = Round2( BCSL × ILF )', inputs: ['BCSL', 'ILF'], output: 'ΠCSL' },
        { sequence: 2, instruction: 'STD = ( SP × ( 1 ± SCHED ) ) + DVIC', operation: 'assignment', expression: 'STD = ( SP × ( 1 ± SCHED ) ) + DVIC', inputs: ['SP', 'SCHED', 'DVIC'], output: 'STD' },
      ],
      inputs: ['BCSL', 'ILF', 'SP', 'SCHED', 'DVIC'],
    }],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => /Step 1 expression/.test(i.message) && /cannot reliably interpret/.test(i.message)),
    `Greek/Round2 expression must stay silent: ${issues.map((i) => i.message).join(' | ')}`);
  assert.ok(issues.some((i) => /Step 2 expression/.test(i.message) && /cannot reliably interpret/.test(i.message)),
    'ambiguous ± expression must stay flagged for review');
});

test('validate: lookup and floor_check are recognized kinds; unknown kinds still warn', () => {
  const job = jobWith({
    routines: [
      { name: 'L', kind: 'lookup', sourcePages: [1], evidenceText: 'e', conditions: ['80% Coinsurance = 1.000 (Base)'] },
      { name: 'F', kind: 'floor_check', sourcePages: [1], evidenceText: 'e', conditions: ['Net rate cannot be less than Rfloor = $0.060.'] },
      { name: 'M', kind: 'mystery', sourcePages: [1], evidenceText: 'e' },
    ],
  });
  const issues = validateJob(job);
  assert.ok(!issues.some((i) => i.target_id === 'R1' && /unrecognized kind/.test(i.message)));
  assert.ok(!issues.some((i) => i.target_id === 'R2' && /unrecognized kind/.test(i.message)));
  assert.ok(issues.some((i) => i.target_id === 'R3' && /unrecognized kind "mystery"/.test(i.message)));
});

test('validate: prose parentheticals are not formula syntax; operator-bearing steps still flag', () => {
  const job = jobWith({
    routines: [{
      name: 'R', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      steps: [
        'All intermediate factors are maintained to four (4) decimal places without truncation.',
        'Floor check (max with floor).',
        'Apply (factor + 2) to the base.',
      ],
    }],
  });
  const issues = validateJob(job);
  const flags = issues.filter((i) => /states no confident operation/.test(i.message));
  assert.ok(!flags.some((i) => /four \(4\) decimal/.test(i.message)), 'prose number gloss must stay silent');
  assert.ok(!flags.some((i) => /Floor check/.test(i.message)), 'prose gloss must stay silent');
  assert.ok(flags.some((i) => /Apply \(factor/.test(i.message)), 'operator-bearing step must still flag');
});

// ---------- range-band grouping ----------

test('validate: identical bands under different key groups stay silent; same-group overlaps still warn', () => {
  const grouped = jobWith({
    tables: [{
      name: 'Radius', sourcePages: [1], evidenceText: 'e',
      headers: ['Use Code', 'Category', 'Operating Radius', 'Factor'],
      columns: [{ label: 'Use Code', role: 'key' }, { label: 'Category', role: 'key' }, { label: 'Operating Radius', role: 'key' }, { label: 'Factor', role: 'output' }],
      rows: [
        ['U-SRV-I', 'Service', 'Intermediate (51 – 200 miles)', '1.10'],
        ['U-COM-I', 'Commercial', 'Intermediate (51 – 200 miles)', '1.30'],
      ],
    }],
  });
  assert.deepEqual(validateJob(grouped).filter((i) => /overlapping range bands|sharing the endpoint value/.test(i.message)), [],
    'identical bands under different use codes are not a conflict');

  const sameGroup = jobWith({
    tables: [{
      name: 'Radius', sourcePages: [1], evidenceText: 'e',
      headers: ['Use Code', 'Category', 'Operating Radius', 'Factor'],
      columns: [{ label: 'Use Code', role: 'key' }, { label: 'Category', role: 'key' }, { label: 'Operating Radius', role: 'key' }, { label: 'Factor', role: 'output' }],
      rows: [
        ['U-SRV-I', 'Service', 'Intermediate (51 – 200 miles)', '1.10'],
        ['U-SRV-I', 'Service', 'Extended (100 – 300 miles)', '1.30'],
      ],
    }],
  });
  const overlaps = validateJob(sameGroup).filter((i) => /overlapping range bands/.test(i.message));
  assert.equal(overlaps.length, 1, `same-group overlap must still warn: ${validateJob(sameGroup).map((i) => i.message).join(' | ')}`);
  assert.match(overlaps[0].message, /both cover 100 to 200/);

  const sameGroupEndpoint = jobWith({
    tables: [{
      name: 'Bands', sourcePages: [1], evidenceText: 'e',
      headers: ['Tier', 'Band', 'Factor'],
      columns: [{ label: 'Tier', role: 'key' }, { label: 'Band', role: 'key' }, { label: 'Factor', role: 'output' }],
      rows: [
        ['T1', '$10,000', '1.10'],
        ['T1', '$10,000 to $25,000', '1.05'],
        ['T1', '$30,000 to $40,000', '0.96'],
      ],
    }],
  });
  assert.ok(validateJob(sameGroupEndpoint).some((i) => /sharing the endpoint value/.test(i.message)),
    'same-group shared endpoints stay flagged without inferring inclusivity');
});

// ---------- condition completeness ----------

test('validate: lookup mappings, bounded rules, definitions, and regardless-clauses skip fallback; lone IF still warns', () => {
  const job = jobWith({
    routines: [
      {
        name: 'Lookup', kind: 'lookup', sourcePages: [1], evidenceText: 'e',
        conditions: ['80% Coinsurance = 1.000 (Base)', '90% Coinsurance = 0.950'],
      },
      {
        name: 'Bounded', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: ['Payroll is subject to a statutory minimum of $52,000 and a statutory maximum cap of $156,000.'],
      },
      {
        name: 'Defined', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: ['Garaging jurisdiction is determined by the physical address where the unit is stored.'],
      },
      {
        name: 'Regardless', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: ['Vans garaged in postal codes 88201–88204 must rate at Territory 02 regardless of boundary proximity.'],
      },
      {
        name: 'LoneIf', kind: 'condition', sourcePages: [1], evidenceText: 'e',
        conditions: ['IF operating terminal is within 5 miles of the boundary THEN Territory 01 rates apply'],
      },
    ],
  });
  const issues = validateJob(job);
  for (const id of ['R1', 'R2', 'R3', 'R4']) {
    assert.ok(!issues.some((i) => i.target_id === id && /no explicit fallback/.test(i.message)),
      `${id} states a complete rule and must stay silent: ${issues.map((i) => i.message).join(' | ')}`);
  }
  assert.ok(issues.some((i) => i.target_id === 'R5' && /no explicit fallback/.test(i.message)),
    'lone IF without ELSE must still warn');
});

// ---------- worked-example arithmetic ----------

test('validate: explicit worked arithmetic checks silently when matching and warns on mismatch without changing values', () => {
  const job = jobWith({
    routines: [{
      name: 'W', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1,
          instruction: 'Base premium', expression: '850 × $26.60',
          inputs: ['E=850', 'Rcombined=$26.60'], output: '$22,610.00',
        },
        {
          sequence: 2, operation: 'expression',
          instruction: 'Loaded rate', expression: '$0.2500 × 1.150 × 1.200 × 0.950 × 1.150 = $0.3768',
          output: '',
        },
        {
          sequence: 3,
          instruction: 'Total', expression: '$1,640.41 + $275.40',
          output: '$9,999.99',
        },
        {
          sequence: 4,
          instruction: 'Symbolic', expression: 'E × Rcombined',
          inputs: ['E', 'Rcombined'], output: '$22,610.00',
        },
        {
          sequence: 5,
          instruction: 'Credit', expression: '( $13,981.69 − $5,000.00 ) × 0.091',
          inputs: ['$13,981.69', '$5,000.00', '0.091'], output: '−$817.33',
        },
      ],
    }],
  });
  const before = JSON.stringify(job.routines[0].steps_detailed);
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const arithmetic = issues.filter((i) => /recomputing/.test(i.message));
  assert.ok(!arithmetic.some((i) => /Step 1/.test(i.message)), `matching bare expression must stay silent: ${msgs}`);
  const step2 = arithmetic.find((i) => /Step 2/.test(i.message));
  assert.ok(step2, `bare-equality mismatch must warn: ${msgs}`);
  assert.match(step2.message, /\$0\.3768/);
  assert.match(step2.message, /0\.3769125/);
  assert.match(step2.message, /difference/);
  assert.match(step2.message, /preserved, not corrected/);
  assert.ok(arithmetic.some((i) => /Step 3/.test(i.message)), `output mismatch must warn: ${msgs}`);
  assert.ok(!arithmetic.some((i) => /Step 4/.test(i.message)), `symbolic expression must stay silent: ${msgs}`);
  assert.ok(!arithmetic.some((i) => /Step 5/.test(i.message)), `sign-convention magnitude match must stay silent: ${msgs}`);
  assert.equal(JSON.stringify(job.routines[0].steps_detailed), before, 'source values must never be modified');
});

test('validate: stated results on bare worked expressions verify silently when matching and warn on mismatch', () => {
  const job = jobWith({
    routines: [{
      name: 'W', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
      steps: [
        {
          sequence: 1, operation: 'expression',
          instruction: 'Zone scaling', expression: '$1,050.00 × 1.00',
          output: 'Zone scaling', stated_results: [{ output: 'Zone scaling', value: '$1,050.00' }],
        },
        {
          sequence: 2, operation: 'expression',
          instruction: 'Tenure scaling', expression: '$1,050.00 × 0.90',
          output: 'Tenure scaling', stated_results: [{ output: 'Tenure scaling', value: '$999.99' }],
        },
      ],
    }],
  });
  const before = JSON.stringify(job.routines[0].steps_detailed);
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const arithmetic = issues.filter((i) => /recomputing/.test(i.message));
  assert.ok(!arithmetic.some((i) => /Step 1/.test(i.message)), `matching stated result must stay silent: ${msgs}`);
  const step2 = arithmetic.find((i) => /Step 2/.test(i.message));
  assert.ok(step2, `stated-result mismatch must warn: ${msgs}`);
  assert.match(step2.message, /\$999\.99/);
  assert.match(step2.message, /945/);
  assert.match(step2.message, /preserved, not corrected/);
  assert.equal(JSON.stringify(job.routines[0].steps_detailed), before, 'source values must never be modified');
});

test('validate: RoundHalfUp call form evaluates like round_half_up', () => {
  assert.equal(evaluateNumericExpression('RoundHalfUp($1,066.078125, 2)'), 1066.08);
  assert.equal(evaluateNumericExpression('round_half_up(1.005, 2)'), 1.01);
  assert.equal(evaluateNumericExpression('RoundHalfUp(2.5, 0)'), 3);
});

test('validate: inflected factor refs name their table yet stay unresolved without a lookup', () => {
  const factorEvidence = 'Factors are unitless multipliers applied per vehicle';
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: factorEvidence, headers: ['Territory code', 'Factor'], rows: [['URB', '1.20']] },
      { name: 'Table 3. Driver Experience Factors', sourcePages: [1], evidenceText: factorEvidence, headers: ['Experience band', 'Factor'], rows: [['EXP-1', '1.20']] },
      { name: 'North Factors', sourcePages: [1], evidenceText: factorEvidence, headers: ['Zone key', 'Factor'], rows: [['a', '1']] },
      { name: 'North Factors Schedule', sourcePages: [1], evidenceText: factorEvidence, headers: ['Region key', 'Factor'], rows: [['a', '1']] },
    ],
    routines: [{
      name: 'Rating Procedure', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'e',
      conditions: ['If the policy covers 3 to 10 vehicles, the discount is 5% of the pre-discount premium.'],
      steps: [
        'Base premium = 100',
        'Step 2 \u2014 Territory adjustment: Multiply the base premium by the territory factor from Table 2.',
        'Step 3 \u2014 Driver adjustment: Multiply the Step 2 result by the driver experience factor from Table 3.',
        'North pick = north factor',
        'Hull pick = hull factor',
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  // Table-name matching (exact or singular/plural-insensitive) identifies
  // the candidate table, but a factor value used in a calculation must be
  // introduced by an explicit lookup step: with none present, each factor
  // is retained as unresolved with its table named.
  const territory = issues.find((i) => /Step uses "territory factor" from Table "Table 2\. Territory Factors"/.test(i.message));
  assert.ok(territory, `unproduced factor must warn with its table: ${msgs}`);
  assert.match(territory.message, /no lookup step selecting it/);
  assert.match(territory.message, /flagged as unresolved/);
  const driver = issues.find((i) => /Step uses "driver experience factor" from Table "Table 3\. Driver Experience Factors"/.test(i.message));
  assert.ok(driver, `unproduced factor must warn with its table: ${msgs}`);
  assert.match(driver.message, /no lookup step selecting it/);
  assert.match(driver.message, /flagged as unresolved/);
  assert.ok(issues.some((i) => /"hull factor"/.test(i.message) && /flagged as unresolved/.test(i.message)), `genuine gap must warn: ${msgs}`);
  const north = issues.find((i) => /"north factor"/.test(i.message));
  assert.ok(north, `ambiguous ref must warn: ${msgs}`);
  assert.match(north.message, /matches multiple tables/);
  assert.match(north.message, /North Factors/);
  assert.ok(issues.some((i) => /no explicit fallback/.test(i.message)), `genuine missing fallback must still warn: ${msgs}`);
});

test('validate: factor from a named table without a producing lookup stays unresolved', () => {
  // Step 2 uses `territory factor` for a calculation and names Table 2,
  // but no lookup step selects it: the table is evidenced, the lookup is
  // not, so the reference is retained as unresolved for analyst review
  // instead of silently resolving by table-name match.
  const job = jobWith({
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
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const hit = issues.find((i) => /Step 2 uses "territory factor" from Table "Table 2\. Territory Tallage Factors"/.test(i.message));
  assert.ok(hit, `unproduced factor must warn with its table: ${msgs}`);
  assert.match(hit.message, /no lookup step selecting it/);
  assert.match(hit.message, /no lookup key or selected value evidenced/);
  assert.match(hit.message, /flagged as unresolved/);
  assert.ok(!issues.some((i) => /"ledger class"/.test(i.message)), `lookup keys must stay silent: ${msgs}`);
  assert.ok(!issues.some((i) => /"Base tallage"/.test(i.message)), `produced values must stay silent: ${msgs}`);
});

test('validate: lookup-produced factor resolves without warning', () => {
  // The same factor selected by an explicit lookup step is introduced:
  // downstream calculations referencing the lookup output stay silent.
  const job = jobWith({
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
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!issues.some((i) => /"territory factor"/.test(i.message)), `introduced factor must stay silent: ${msgs}`);
});

test('validate: factor naming no resolvable table keeps the generic unresolved warning', () => {
  // No table evidence at all: the reference keeps the generic unresolved
  // wording rather than the table-attributed factor message.
  const job = jobWith({
    tables: [
      { name: 'Table 1. Base Tallages by Ledger Class', sourcePages: [1], evidenceText: 'base tallage schedule', headers: ['Ledger class', 'Base tallage'], rows: [['A', '800']] },
    ],
    routines: [{
      name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      steps: [
        'Step 1 — Base tallage: Select the base tallage for the ledger class from Table 1.',
        { sequence: 2, instruction: 'Step 2 — Zone scaling: Multiply the base tallage by the Bermuda triangle factor.', operation: 'expression', expression: 'Base tallage * Bermuda triangle factor', inputs: ['Base tallage', 'Bermuda triangle factor'], output: 'Zone scaling', depends_on: ['Table 99'] },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(issues.some((i) => /Step 2 references "Bermuda triangle factor", which matches no defined input/.test(i.message) && /flagged as unresolved/.test(i.message)), `tableless factor must warn generically: ${msgs}`);
  assert.ok(!issues.some((i) => /uses "Bermuda triangle factor" from Table/.test(i.message)), `no table must mean no factor message: ${msgs}`);
});

test('validate: downstream reuse of an evidenced lookup key stays silent', () => {
  // `ledger class` is step 1's lookup key; reusing it downstream with the
  // same table named is not an unproduced factor.
  const job = jobWith({
    tables: [
      { name: 'Table L. Ledger Class Tallages', sourcePages: [1], evidenceText: 'ledger class schedule', headers: ['Ledger class', 'Base tallage'], rows: [['A', '800']] },
    ],
    routines: [{
      name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Step 1 — Base tallage: Select the base tallage for the ledger class from Table L.', operation: 'lookup', inputs: ['ledger class'], output: 'Base tallage', depends_on: ['Table L'] },
        { sequence: 2, instruction: 'Step 2 — Tally check: Add the ledger class weight to the base tallage.', operation: 'expression', expression: 'Base tallage + ledger class', inputs: ['Base tallage', 'ledger class'], output: 'Tally check', depends_on: ['Table L'] },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!issues.some((i) => /"ledger class"/.test(i.message)), `reused lookup key must stay silent: ${msgs}`);
});

test('validate: factor matching several named tables names each as unresolved', () => {
  // `factor` matches both named tables and no lookup selects it: the
  // warning names every candidate table instead of choosing one.
  const job = jobWith({
    tables: [
      { name: 'Table 1. Base Tallages by Ledger Class', sourcePages: [1], evidenceText: 'base tallage schedule', headers: ['Ledger class', 'Base tallage'], rows: [['A', '800']] },
      { name: 'Table 2. Territory Tallage Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
      { name: 'Table 3. Driver Experience Factors', sourcePages: [1], evidenceText: 'driver factor schedule', headers: ['Experience band', 'Definition', 'Factor'], rows: [['EXP-3', 'Experienced', '0.90']] },
    ],
    routines: [{
      name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      steps: [
        'Step 1 — Base tallage: Select the base tallage for the ledger class from Table 1.',
        { sequence: 2, instruction: 'Step 2 — Zone scaling: Multiply the base tallage by the factor.', operation: 'expression', expression: 'Base tallage * factor', inputs: ['Base tallage', 'factor'], output: 'Zone scaling', depends_on: ['Table 2', 'Table 3'] },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const hit = issues.find((i) => /Step 2 uses "factor", which matches tables \("Table 2\. Territory Tallage Factors", "Table 3\. Driver Experience Factors"\)/.test(i.message));
  assert.ok(hit, `multi-table factor must name each table: ${msgs}`);
  assert.match(hit.message, /no lookup step selecting it/);
  assert.match(hit.message, /flagged as unresolved/);
});

test('validate: unresolved factor warning explains the missing lookup key binding', () => {
  // Table, key column and factor column are unambiguous, but no routine
  // input or preceding step provides the key: the warning names the
  // identified columns and the missing binding for analyst review.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Tallage Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
    ],
    routines: [{
      name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Step 1 — Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling', depends_on: ['Table 2'] },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const hit = issues.find((i) => /Step 1 uses "territory factor" from Table "Table 2\. Territory Tallage Factors"/.test(i.message));
  assert.ok(hit, `unproduced factor must warn with its table: ${msgs}`);
  assert.match(hit.message, /no lookup step selecting it/);
  assert.match(hit.message, /key column "Territory code" and factor column "Factor"/);
  assert.match(hit.message, /no routine input or preceding step provides the lookup key/);
  assert.match(hit.message, /flagged as unresolved/);
});

test('validate: unresolved factor warning names ambiguous key columns', () => {
  // `Territory code` and `Territory description` both match the factor, so
  // no single key column is identifiable: the warning names the candidates
  // instead of guessing which one selects the factor.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Tallage Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Territory description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
    ],
    routines: [{
      name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      inputs: ['Territory'],
      steps: [
        { sequence: 1, instruction: 'Step 1 — Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling', depends_on: ['Table 2'] },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const hit = issues.find((i) => /Step 1 uses "territory factor" from Table "Table 2\. Territory Tallage Factors"/.test(i.message));
  assert.ok(hit, `unproduced factor must warn with its table: ${msgs}`);
  assert.match(hit.message, /key column is ambiguous \("Territory code", "Territory description"\)/);
  assert.match(hit.message, /flagged as unresolved/);
});

test('validate: generated parameterized lookup silences the factor warning', () => {
  // Mirrors the pipeline: generation runs before validation, so a supported
  // lookup produces the factor and neither the factor nor its key warns.
  const job = jobWith({
    tables: [
      { name: 'Schedule S. Cover Factors', sourcePages: [1], evidenceText: 'cover factor schedule', headers: ['Cover code', 'Factor'], rows: [['C1', '1.10']] },
    ],
    routines: [{
      name: 'Cover Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      inputs: ['Cover'],
      steps: [
        'Step 1 — Base amount: Select the base amount for the ledger class from Schedule B.',
        'Step 2 — Adjusted amount: Multiply the base amount by the cover factor from Schedule S.',
      ],
      steps_detailed: [
        { instruction: 'Step 1 — Base amount: Select the base amount for the ledger class from Schedule B.', operation: 'lookup', inputs: ['ledger class'], output: 'Base amount', depends_on: ['Schedule B'], evidence: 'Select the base amount for the ledger class from Schedule B.', source_pages: [2] },
        { instruction: 'Step 2 — Adjusted amount: Multiply the base amount by the cover factor from Schedule S.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount', depends_on: ['Schedule S'], evidence: 'Multiply the base amount by the cover factor from Schedule S.', source_pages: [2] },
      ],
    }],
  });
  assert.equal(generateParameterizedLookups(job.routines[0], job.tables, job.routines), 1);
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!issues.some((i) => /"cover factor"/.test(i.message)), `produced factor must stay silent: ${msgs}`);
  assert.ok(!issues.some((i) => /"Cover"/.test(i.message)), `bound lookup key must stay silent: ${msgs}`);
});

test('validate: unresolved factor warning names ambiguous binding candidates', () => {
  // Two inputs overlap the key column with no exact or specificity
  // winner: no lookup is generated and the warning names both candidates,
  // identically regardless of input order.
  const build = (inputs) => jobWith({
    tables: [
      { name: 'Schedule S. Cover Factors', sourcePages: [1], evidenceText: 'cover factor schedule', headers: ['Cover code', 'Factor'], rows: [['C1', '1.10']] },
    ],
    routines: [{
      name: 'Cover Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      inputs,
      steps: [
        { sequence: 1, instruction: 'Step 1 — Adjusted amount: Multiply the base amount by the cover factor from Schedule S.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount', depends_on: ['Schedule S'] },
      ],
    }],
  });
  const messages = [['Cover', 'Cover region'], ['Cover region', 'Cover']].map((inputs) => {
    const issues = validateJob(build(inputs));
    const msgs = issues.map((i) => i.message).join(' | ');
    const hit = issues.find((i) => /Step 1 uses "cover factor" from Table "Schedule S\. Cover Factors"/.test(i.message));
    assert.ok(hit, `unproduced factor must warn with its table: ${msgs}`);
    return hit.message;
  });
  assert.equal(messages[0], messages[1]);
  assert.match(messages[0], /lookup key binding is ambiguous \("Cover", "Cover region"\)/);
  assert.match(messages[0], /flagged as unresolved/);
});

test('validate: factors attribute through routine dependencies when steps state none', () => {
  // Latest live-extraction shape: routine-level dependencies present,
  // step-level absent, capitalized factor inputs. Each factor attributes
  // to its unique table and warns unresolved with its diagnosis.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 't', headers: ['Territory code', 'Territory description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] },
      { name: 'Table 3. Driver Experience Factors', sourcePages: [1], evidenceText: 't', headers: ['Experience band', 'Definition', 'Factor'], rows: [['EXP-3', 'Senior', '0.90']] },
    ],
    routines: [{
      name: 'Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      dependsOn: ['Table 2. Territory Factors', 'Table 3. Driver Experience Factors'],
      steps: [
        { sequence: 2, instruction: 'Step 2 — Territory adjustment: Multiply the base premium by the territory factor from Table 2.', operation: 'expression', expression: 'Base premium * Territory factor', inputs: ['Base premium', 'Territory factor'], output: 'Step 2 result' },
        { sequence: 3, instruction: 'Step 3 — Driver adjustment: Multiply the Step 2 result by the driver experience factor from Table 3.', operation: 'expression', expression: 'Step 2 result * Driver experience factor', inputs: ['Step 2 result', 'Driver experience factor'], output: 'Step 3 result' },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const territory = issues.find((i) => /Step 2 uses "Territory factor" from Table "Table 2\. Territory Factors"/.test(i.message));
  assert.ok(territory, `fallback attribution must warn with its table: ${msgs}`);
  assert.match(territory.message, /key column is ambiguous \("Territory code", "Territory description"\)/);
  const driver = issues.find((i) => /Step 3 uses "Driver experience factor" from Table "Table 3\. Driver Experience Factors"/.test(i.message));
  assert.ok(driver, `fallback attribution must warn with its table: ${msgs}`);
  assert.match(driver.message, /no routine input or preceding step provides the lookup key/);
});

test('validate: explicit lookup resolves its factor under routine-level attribution', () => {
  // Fallback attribution is not a lookup, but a genuine lookup step still
  // introduces its factor: the factor stays silent with no step mentions.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 't', headers: ['Territory code', 'Factor'], rows: [['SUB', '1.00']] },
    ],
    routines: [{
      name: 'Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      inputs: ['Territory'],
      dependsOn: ['Table 2. Territory Factors'],
      steps: [
        { sequence: 1, instruction: 'Step 1 — Territory factor: Look up the territory factor from Table 2 using Territory.', operation: 'lookup', inputs: ['Territory'], output: 'Territory factor' },
        { sequence: 2, instruction: 'Step 2 — Zone scaling: Multiply the base tallage by the Territory factor.', operation: 'expression', expression: 'Base tallage * Territory factor', inputs: ['Base tallage', 'Territory factor'], output: 'Zone scaling' },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.ok(!issues.some((i) => /"Territory factor"/.test(i.message)), `introduced factor must stay silent: ${msgs}`);
  assert.ok(!issues.some((i) => /"Territory"/.test(i.message)), `bound lookup key must stay silent: ${msgs}`);
});

test('validate: explicit table references resolve without warnings', () => {
  // A step input naming the table itself — short form or full title —
  // keeps resolving; only bare value mentions lost the fuzzy fallback.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 't', headers: ['Territory code', 'Factor'], rows: [['SUB', '1.00']] },
    ],
    routines: [{
      name: 'Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Step 1 — Check tables.', operation: 'expression', expression: 'X', inputs: ['Table 2', 'Table 2. Territory Factors'], output: 'X' },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const routineRefs = issues.filter((i) => i.target_type === 'routine' && /references|uses/.test(i.message));
  assert.ok(!routineRefs.some((i) => /"Table 2"/.test(i.message)), `short table reference must stay silent: ${msgs}`);
  assert.ok(!routineRefs.some((i) => /"Table 2\. Territory Factors"/.test(i.message)), `full table reference must stay silent: ${msgs}`);
});

test('validate: ambiguous routine-level attribution stays ambiguous', () => {
  // The routine names two factor tables and the step names none: a factor
  // matching both keeps the ambiguous-table warning, never a guess.
  const job = jobWith({
    tables: [
      { name: 'Schedule S. Cover Factors', sourcePages: [1], evidenceText: 't', headers: ['Cover code', 'Factor'], rows: [['C1', '1.10']] },
      { name: 'Table 9. Cover Factors Riders', sourcePages: [1], evidenceText: 't', headers: ['Rider code', 'Factor'], rows: [['R1', '1.00']] },
    ],
    routines: [{
      name: 'Cover Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      dependsOn: ['Schedule S. Cover Factors', 'Table 9. Cover Factors Riders'],
      steps: [
        { sequence: 1, instruction: 'Step 1 — Adjusted amount: Multiply the base amount by the cover factor.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount' },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const hit = issues.find((i) => /Step 1 uses "cover factor", which matches tables \("Schedule S\. Cover Factors", "Table 9\. Cover Factors Riders"\)/.test(i.message));
  assert.ok(hit, `multi-table factor must name each table: ${msgs}`);
  assert.match(hit.message, /flagged as unresolved/);
});

test('validate: missing dependencies keep the generic unresolved warning', () => {
  // No step mentions and no routine mentions: the factor keeps the
  // generic warning instead of resolving through a fuzzy table-title
  // match. This is the false-resolution regression test.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 't', headers: ['Territory code', 'Factor'], rows: [['SUB', '1.00']] },
    ],
    routines: [{
      name: 'Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      steps: [
        { sequence: 1, instruction: 'Step 1 — Zone scaling: Multiply the base tallage by the territory factor.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling' },
      ],
    }],
  });
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const hit = issues.find((i) => /Step 1 references "territory factor", which matches no defined input/.test(i.message));
  assert.ok(hit, `unattributed factor must keep the generic warning: ${msgs}`);
});

test('validate: worked lookups resolve while the procedure keeps missing-key warnings', () => {
  // Generating Worked Example instance lookups must not silence the
  // reusable procedure's missing-key warnings; the generated steps
  // themselves carry full evidence and stay silent.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Tallage Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00'], ['URB', 'Urban core', '1.20']] },
    ],
    routines: [
      {
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        inputs: ['Base tallage'],
        steps: [
          { sequence: 1, instruction: 'Step 1 - Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling', depends_on: ['Table 2'] },
        ],
      },
      {
        name: 'Worked Example', kind: 'worked_example', sourcePages: [2], evidenceText: 'e',
        inputs: ['Territory: Suburban (SUB)'],
        outputs: ['Adjusted total: $1,050.00'],
        steps: [
          { sequence: 1, instruction: '1. Territory adjustment: $1,050.00 * 1.00', operation: 'multiply', expression: '$1,050.00 * 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '1. Territory adjustment', calculation: '$1,050.00 * 1.00', result: '$1,050.00' } },
        ],
      },
    ],
  });
  for (const t of job.tables) t.columns = inferTableColumns(t);
  const worked = job.routines.find((r) => r.kind === 'worked_example');
  assert.equal(generateWorkedExampleLookups(worked, job.tables), 1);
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const proc = issues.filter((i) => i.target_id === 'R1');
  assert.equal(proc.length, 1, `procedure must keep exactly its factor warning: ${msgs}`);
  assert.match(proc[0].message, /Step 1 uses "territory factor" from Table "Table 2\. Territory Tallage Factors"/);
  assert.match(proc[0].message, /no lookup step selecting it/);
  const r2Issues = issues.filter((i) => i.target_id === 'R2');
  assert.equal(r2Issues.length, 1, `worked example must keep only its standard note: ${msgs}`);
  assert.match(r2Issues[0].message, /preserves illustrative expected values/);
});

test('validate: procedure keeps its factor warning when a worked example selects the same factor', () => {
  // The worked example's instance lookup ('Territory factor' for SUB) must
  // not count as introducing the reusable procedure's factor: the procedure
  // keeps its missing-key warning until its own inputs are established.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00'], ['URB', 'Urban core', '1.20']] },
    ],
    routines: [
      {
        name: 'Ledger Tally Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
        inputs: ['Base tallage'],
        steps: [
          { sequence: 1, instruction: 'Step 1 - Zone scaling: Multiply the base tallage by the territory factor from Table 2.', operation: 'expression', expression: 'Base tallage * territory factor', inputs: ['Base tallage', 'territory factor'], output: 'Zone scaling', depends_on: ['Table 2'] },
        ],
      },
      {
        name: 'Worked Example', kind: 'worked_example', sourcePages: [2], evidenceText: 'e',
        inputs: ['Territory: Suburban (SUB)'],
        outputs: ['Adjusted total: $1,050.00'],
        steps: [
          { sequence: 1, instruction: '1. Territory adjustment: $1,050.00 * 1.00', operation: 'multiply', expression: '$1,050.00 * 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '1. Territory adjustment', calculation: '$1,050.00 * 1.00', result: '$1,050.00' } },
        ],
      },
    ],
  });
  for (const t of job.tables) t.columns = inferTableColumns(t);
  const worked = job.routines.find((r) => r.kind === 'worked_example');
  assert.equal(generateWorkedExampleLookups(worked, job.tables), 1);
  assert.equal(worked.steps_detailed[0].output, 'Territory factor');
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const proc = issues.filter((i) => i.target_id === 'R1');
  assert.equal(proc.length, 1, `procedure must keep exactly its factor warning: ${msgs}`);
  assert.match(proc[0].message, /Step 1 uses "territory factor" from Table "Table 2\. Territory Factors"/);
  assert.match(proc[0].message, /no lookup step selecting it/);
  const r2Issues = issues.filter((i) => i.target_id === 'R2');
  assert.equal(r2Issues.length, 1, `worked example must keep only its standard note: ${msgs}`);
  assert.match(r2Issues[0].message, /preserves illustrative expected values/);
});

test('validate: worked example resolves its own lookup outputs in named uses', () => {
  // Same-routine introduction still holds for worked examples: a worked
  // calculation naming the factor its own lookup selected stays silent.
  const job = jobWith({
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00'], ['URB', 'Urban core', '1.20']] },
    ],
    routines: [
      {
        name: 'Worked Example', kind: 'worked_example', sourcePages: [2], evidenceText: 'e',
        inputs: ['Territory: Suburban (SUB)'],
        outputs: ['Adjusted total: $1,050.00'],
        dependsOn: ['Table 2. Territory Factors'],
        steps: [
          { sequence: 1, instruction: '1. Territory adjustment: $1,050.00 * 1.00', operation: 'multiply', expression: '$1,050.00 * 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '1. Territory adjustment', calculation: '$1,050.00 * 1.00', result: '$1,050.00' } },
          { sequence: 2, instruction: '2. Check: Territory factor * 2', operation: 'expression', expression: 'Territory factor * 2', inputs: ['Territory factor'], output: 'Check' },
        ],
      },
    ],
  });
  for (const t of job.tables) t.columns = inferTableColumns(t);
  const worked = job.routines[0];
  assert.equal(generateWorkedExampleLookups(worked, job.tables), 1);
  const issues = validateJob(job);
  const msgs = issues.map((i) => i.message).join(' | ');
  const own = issues.filter((i) => i.target_id === 'R1');
  assert.equal(own.length, 1, `worked example must keep only its standard note: ${msgs}`);
  assert.match(own[0].message, /preserves illustrative expected values/);
});
