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
