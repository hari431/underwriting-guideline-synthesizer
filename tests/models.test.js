import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, createDocument, normalizeJob } from '../src/models.js';

test('normalizeJob assigns stable sequential IDs and preserves evidence', () => {
  const job = normalizeJob(
    createJob({
      document: createDocument({ filename: 'guide.pdf', pageCount: 3 }),
      tables: [
        { name: 'Base rates', sourcePages: [2, 2, 1], evidenceText: 'Table 1: base rates', headers: ['A'], rows: [['1']] },
      ],
      routines: [{ name: 'Calc', kind: 'formula', sourcePages: [3], expressionText: 'a + b' }],
      issues: [{ severity: 'warning', message: 'check this', sourcePages: [3] }],
    })
  );
  assert.equal(job.tables[0].id, 'T1');
  assert.deepEqual(job.tables[0].source_pages, [1, 2]);
  assert.equal(job.tables[0].evidence_text, 'Table 1: base rates');
  assert.equal(job.routines[0].id, 'R1');
  assert.equal(job.issues[0].id, 'V1');
});

test('normalizeJob keeps pre-existing IDs', () => {
  const job = normalizeJob(
    createJob({
      tables: [{ id: 'T7', name: 'x' }, { name: 'y' }],
    })
  );
  assert.equal(job.tables[0].id, 'T7');
  assert.equal(job.tables[1].id, 'T1');
});

test('models: preserves leading zeros, precision, blanks, order, and ragged rows', () => {
  const job = normalizeJob(
    createJob({
      tables: [{
        name: 'Codes', sourcePages: [1], evidenceText: 'ev',
        headers: ['Code', 'Cost'],
        rows: [['0012', '1.10'], ['0045', ''], ['0108', '0'], ['0200', '-1.25']],
      }],
    })
  );
  const t = job.tables[0];
  assert.deepEqual(t.rows[0], ['0012', '1.10']);
  assert.deepEqual(t.rows[1], ['0045', '']);
  assert.deepEqual(t.rows[2], ['0108', '0']);
  assert.deepEqual(t.rows[3], ['0200', '-1.25']);
  assert.equal(t.rows[1][1], '');
  assert.notEqual(t.rows[1][1], '0');
  const ragged = normalizeJob(createJob({ tables: [{ name: 'R', headers: ['A', 'B'], rows: [['1'], ['2', '3', '4']] }] }));
  assert.deepEqual(ragged.tables[0].rows, [['1'], ['2', '3', '4']]);
});

test('models: columns preserve original labels, order, and metadata', () => {
  const job = normalizeJob(
    createJob({
      tables: [{
        name: 'Factors', sourcePages: [1], evidenceText: 'ev',
        headers: ['Region', 'Modifier'],
        columns: [
          { label: 'Region', original_label: 'Region', order: 1, role: 'lookup key' },
          { label: 'Modifier', original_label: 'Modifier', order: 2, data_type: 'number', role: 'output value', units: 'multiplier' },
        ],
        rows: [['R-A', '0.037']],
      }],
    })
  );
  const t = job.tables[0];
  assert.equal(t.columns.length, 2);
  assert.equal(t.columns[0].original_label, 'Region');
  assert.equal(t.columns[1].data_type, 'number');
  assert.equal(t.columns[1].role, 'output value');
  assert.equal(t.columns[1].units, 'multiplier');
  assert.deepEqual(t.headers, ['Region', 'Modifier']);
  // Review edit to headers updates display labels but keeps originals.
  const edited = normalizeJob(
    createJob({
      tables: [{ ...t, headers: ['Region key', 'Modifier'] }],
    })
  );
  assert.equal(edited.tables[0].headers[0], 'Region key');
  assert.equal(edited.tables[0].columns[0].label, 'Region key');
  assert.equal(edited.tables[0].columns[0].original_label, 'Region');
});

test('models: preserves optional table and routine metadata without fabrication', () => {
  const job = normalizeJob(
    createJob({
      tables: [{
        name: 'T', sourcePages: [1], evidenceText: 'ev', headers: ['A'], rows: [['1']],
        purpose: 'Example purpose', applicability: 'Example scope', effective_period: '2026',
        footnotes: ['Note one'], notes: 'Extra note',
      }],
      routines: [{
        name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'a = 1',
        purpose: 'Calc', applicability: 'Each item', execution_context: 'per item',
        inputs: ['coverage_limit'], outputs: ['item_premium'],
      }],
    })
  );
  assert.equal(job.tables[0].purpose, 'Example purpose');
  assert.deepEqual(job.tables[0].footnotes, ['Note one']);
  assert.equal(job.routines[0].execution_context, 'per item');
  assert.deepEqual(job.routines[0].inputs, ['coverage_limit']);
  const bare = normalizeJob(createJob({ tables: [{ name: 'B', headers: ['A'], rows: [['1']] }] }));
  assert.equal(bare.tables[0].purpose, '');
  assert.equal(bare.tables[0].applicability, '');
  assert.deepEqual(bare.tables[0].footnotes, []);
});

test('models: inputs and outputs derive from explicit assignments only', () => {
  const job = normalizeJob(
    createJob({
      routines: [
        { name: 'Calc', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'total = base * factor + 2' },
        { name: 'Kept', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'a = b', inputs: ['custom_in'], outputs: ['custom_out'] },
        { name: 'Odd', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'APPLY legacy curve' },
        { name: 'Branched', kind: 'condition', sourcePages: [1], evidenceText: 'ev', expressionText: 'IF x THEN y' },
      ],
    })
  );
  const [calc, kept, odd, branched] = job.routines;
  assert.deepEqual(calc.outputs, ['total']);
  assert.deepEqual(calc.inputs, ['base', 'factor']);
  assert.deepEqual(kept.inputs, ['custom_in']);
  assert.deepEqual(kept.outputs, ['custom_out']);
  assert.deepEqual(odd.inputs, []);
  assert.deepEqual(odd.outputs, []);
  assert.deepEqual(branched.inputs, []);
  assert.deepEqual(branched.outputs, []);
});

test('models: step operations derive from explicit wording without invention', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          'Step 1: Look up base_rate from Table 1 using driver class and territory.',
          'Look up factor using region.',
          'Look over the results carefully.',
          'Round final_premium to the nearest dollar.',
          'final_premium = base_premium + policy_fee, where policy_fee = 25.',
          'Review with the underwriter.',
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 6);
  assert.equal(det[0].operation, 'lookup');
  assert.equal(det[0].output, 'base_rate');
  assert.deepEqual(det[0].inputs, ['driver class', 'territory']);
  assert.equal(det[0].interpretation_status, 'inferred');
  assert.equal(det[1].operation, 'lookup');
  assert.deepEqual(det[1].inputs, ['region']);
  assert.equal(det[2].operation, undefined);
  assert.equal(det[2].interpretation_status, undefined);
  assert.equal(det[3].operation, 'rounding');
  assert.equal(det[3].output, 'final_premium');
  assert.ok(det[3].operand.includes('nearest dollar'));
  assert.equal(det[4].operation, 'expression');
  assert.equal(det[4].output, 'final_premium');
  assert.deepEqual(det[4].inputs, ['base_premium', 'policy_fee']);
  assert.ok(det[4].expression.includes('where policy_fee = 25'));
  assert.equal(det[5].operation, undefined);
  assert.deepEqual(job.routines[0].steps[0], 'Step 1: Look up base_rate from Table 1 using driver class and territory.');
});

test('models: condition branches and referral codes derive from explicit wording', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Gate', kind: 'condition', sourcePages: [1], evidenceText: 'ev',
        conditions: [
          'IF territory IN (T01, T02) THEN apply factor',
          'ELSE refer to underwriter (code REF-X1).',
          'IF x THEN y ELSE z',
          'Unstructured note.',
        ],
      }],
    })
  );
  const det = job.routines[0].conditions_detailed;
  assert.equal(det.length, 4);
  assert.equal(det[0].condition, 'territory IN (T01, T02)');
  assert.equal(det[0].true_branch, 'apply factor');
  assert.equal(det[0].interpretation_status, 'inferred');
  assert.equal(det[1].false_branch, 'refer to underwriter (code REF-X1).');
  assert.equal(det[1].referral_code, 'REF-X1');
  assert.equal(det[2].condition, 'x');
  assert.equal(det[2].true_branch, 'y');
  assert.equal(det[2].false_branch, 'z');
  assert.equal(det[3].true_branch, undefined);
  assert.equal(det[3].referral_code, undefined);
  assert.equal(det[3].original_text, 'Unstructured note.');
  assert.deepEqual(job.routines[0].conditions[1], 'ELSE refer to underwriter (code REF-X1).');
});

test('models: structured steps, conditions, and dependencies preserved with string views', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          { sequence: 1, instruction: 'Initialize x', operation: 'assignment', expression: 'x = 0', output: 'x' },
          { sequence: 3, instruction: 'Look up factor', operation: 'lookup', inputs: ['territory_key'], output: 'base_factor' },
        ],
        conditions: [{ condition: 'x in set', true_branch: 'use factor', false_branch: 'refer', referral_code: 'REF-1' }],
        dependencies: [{ source: 'R1', target: 'Base table', relationship_type: 'lookup' }],
      }],
    })
  );
  const r = job.routines[0];
  assert.deepEqual(r.steps, ['Initialize x', 'Look up factor']);
  assert.equal(r.steps_detailed.length, 2);
  assert.equal(r.steps_detailed[1].sequence, 3);
  assert.equal(r.steps_detailed[1].operation, 'lookup');
  assert.deepEqual(r.steps_detailed[1].inputs, ['territory_key']);
  assert.equal(r.conditions_detailed[0].referral_code, 'REF-1');
  assert.equal(r.dependencies[0].target, 'Base table');
  assert.deepEqual(r.depends_on, ['Base table']);
});
