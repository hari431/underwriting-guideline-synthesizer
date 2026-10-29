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
