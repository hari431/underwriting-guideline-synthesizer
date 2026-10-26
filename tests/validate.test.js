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
