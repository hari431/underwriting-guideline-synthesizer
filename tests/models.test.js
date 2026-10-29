import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanStepInputValue, createJob, createDocument, findTableCandidates, normalizeJob, resolveTableReference } from '../src/models.js';

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
  assert.deepEqual(t.rows[1], ['0045', null]);
  assert.deepEqual(t.rows[2], ['0108', '0']);
  assert.deepEqual(t.rows[3], ['0200', '-1.25']);
  assert.equal(t.rows[1][1], null);
  assert.notEqual(t.rows[1][1], '0');
  const ragged = normalizeJob(createJob({ tables: [{ name: 'R', headers: ['A', 'B'], rows: [['1'], ['2', '3', '4']] }] }));
  assert.deepEqual(ragged.tables[0].rows, [['1'], ['2', '3', '4']]);
});

test('models: blank cells and sentinel markers normalize to null with originals preserved', () => {
  const job = normalizeJob(
    createJob({
      tables: [{
        name: 'Codes', sourcePages: [1], evidenceText: 'ev',
        headers: ['Code', 'Cost'],
        rows: [
          ['A1', ''],
          ['A2', '   '],
          ['A3', '[NOT SPECIFIED]'],
          ['A4', '[BLANK - N/A]'],
          ['A5', 'N/A'],
          ['A6', '[UNSPECIFIED]'],
          ['A7', 'TBD'],
          ['A8', '0'],
          ['A9', 'None'],
          ['A10', 'Hold for review'],
        ],
      }],
    })
  );
  const t = job.tables[0];
  assert.deepEqual(t.rows.map((r) => r[1]), [null, null, null, null, null, null, null, '0', 'None', 'Hold for review']);
  assert.deepEqual(t.rows.map((r) => r[0]), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']);
  assert.equal(t.original_cells['1:1'], '   ');
  assert.equal(t.original_cells['2:1'], '[NOT SPECIFIED]');
  assert.equal(t.original_cells['3:1'], '[BLANK - N/A]');
  assert.equal(t.original_cells['4:1'], 'N/A');
  assert.equal(t.original_cells['5:1'], '[UNSPECIFIED]');
  assert.equal(t.original_cells['6:1'], 'TBD');
  assert.ok(!('0:1' in (t.original_cells ?? {})), 'empty cells need no original record');
  assert.ok(!('7:1' in (t.original_cells ?? {})), 'legitimate values need no original record');
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
  assert.deepEqual(det[0].depends_on, ['Table 1']);
  assert.equal(det[0].interpretation_status, 'inferred');
  assert.equal(det[1].operation, 'lookup');
  assert.deepEqual(det[1].inputs, ['region']);
  assert.deepEqual(det[1].depends_on ?? [], []);
  assert.equal(det[2].operation, undefined);
  assert.equal(det[2].interpretation_status, undefined);
  assert.equal(det[3].operation, 'rounding');
  assert.equal(det[3].output, 'final_premium');
  assert.equal(det[3].operand, 'final_premium');
  assert.equal(det[4].operation, 'expression');
  assert.equal(det[4].output, 'final_premium');
  assert.deepEqual(det[4].inputs, ['base_premium', 'policy_fee']);
  assert.equal(det[4].expression, 'final_premium = base_premium + policy_fee');
  assert.equal(det[5].operation, undefined);
  assert.deepEqual(job.routines[0].steps[0], 'Step 1: Look up base_rate from Table 1 using driver class and territory.');
  assert.deepEqual(job.routines[0].steps[4], 'final_premium = base_premium + policy_fee, where policy_fee = 25.');
});

test('models: single-word captures reject articles and prepositions', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: ['Round the result down.', 'total = a + b'],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det[0].operation, 'rounding');
  assert.equal(det[0].output, undefined);
  assert.equal(det[0].operand, undefined);
  assert.deepEqual(det[1].inputs, ['a', 'b']);
});

test('models: lookup keys and table derive from "using key in table" wording', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          'Step 1: Look up base_rate using vehicle_class in the Base rating table.',
          'Look up driver_factor using years_licensed in the Driver experience factor table.',
          'Look up r using k in The Ledger.',
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 3);
  // Keys stay clean; the prose table mention becomes the table reference.
  assert.equal(det[0].operation, 'lookup');
  assert.equal(det[0].output, 'base_rate');
  assert.deepEqual(det[0].inputs, ['vehicle_class']);
  assert.deepEqual(det[0].depends_on, ['Base rating table']);
  assert.equal(det[1].operation, 'lookup');
  assert.equal(det[1].output, 'driver_factor');
  assert.deepEqual(det[1].inputs, ['years_licensed']);
  assert.deepEqual(det[1].depends_on, ['Driver experience factor table']);
  // A capitalized leading article is part of the name, not prose: keep verbatim.
  assert.deepEqual(det[2].inputs, ['k']);
  assert.deepEqual(det[2].depends_on, ['The Ledger']);
});

test('models: table mentions resolve exactly or by unique prefix only', () => {
  const tables = [
    { id: 'T1', name: 'Table 1 - Base Rates' },
    { id: 'T2', name: 'Table 10 - Surcharges' },
    { id: 'T3', name: 'Schedule A' },
  ];
  assert.equal(resolveTableReference(tables, 'Table 1 - Base Rates')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 't2')?.id, 'T2');
  assert.equal(resolveTableReference(tables, 'Table 1')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'Schedule A')?.id, 'T3');
  assert.equal(resolveTableReference(tables, 'Table 9'), null);
  assert.equal(resolveTableReference(tables, 'Table'), null);
  assert.equal(resolveTableReference([], 'Table 1'), null);
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

test('models: step grid cells pass through verbatim without becoming operations', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          {
            sequence: 1,
            instruction: 'LX-01 Ledger base fee Vehicle Units (2,000)',
            operation: 'multiply',
            expression: 'Vehicle Units (2,000)',
            cells: { Formula: 'Vehicle Units (2,000)', Basis: 'Flat amount', Factor: '1.000000', Empty: '  ' },
          },
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed[0];
  // No operator joins anything: the claimed operation demotes, but the
  // source cells survive verbatim as audit evidence with normalized roles.
  assert.equal(det.operation, undefined);
  assert.deepEqual(det.cells, { formula: 'Vehicle Units (2,000)', basis: 'Flat amount', factor: '1.000000' });
  // Cells count as explicit-extraction evidence: a second normalization
  // pass (as the pipeline performs) regenerates nothing away.
  const again = normalizeJob(job);
  assert.deepEqual(again.routines[0].steps_detailed[0].cells, det.cells);
});

test('models: lookups parse across Find/Retrieve/Select phrasings with normalized outputs', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          'Step 1: Find the base rate for occupancy_class in Table A.',
          'Step 2: Retrieve construction_factor from Table B using construction_code.',
          'Look up protection_factor using protection_class in Table C.',
          'Select the territory factor for territory from Table D.',
          'Find base_rate in Table A.',
          'Fetch discount_rate using customer_tier from Schedule Q.',
          'Obtain risk_score for account_age in Appendix R.',
          'Find the base-rate for class_code in Table A.',
          'Find time in review.',
          'Get approval from manager.',
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 10);
  assert.equal(det[0].operation, 'lookup');
  assert.equal(det[0].output, 'base_rate');
  assert.deepEqual(det[0].inputs, ['occupancy_class']);
  assert.deepEqual(det[0].depends_on, ['Table A']);
  assert.equal(det[1].operation, 'lookup');
  assert.equal(det[1].output, 'construction_factor');
  assert.deepEqual(det[1].inputs, ['construction_code']);
  assert.deepEqual(det[1].depends_on, ['Table B']);
  assert.equal(det[2].operation, 'lookup');
  assert.equal(det[2].output, 'protection_factor');
  assert.deepEqual(det[2].inputs, ['protection_class']);
  assert.deepEqual(det[2].depends_on, ['Table C']);
  assert.equal(det[3].operation, 'lookup');
  assert.equal(det[3].output, 'territory_factor');
  assert.deepEqual(det[3].inputs, ['territory']);
  assert.deepEqual(det[3].depends_on, ['Table D']);
  assert.equal(det[4].operation, 'lookup');
  assert.equal(det[4].output, 'base_rate');
  assert.deepEqual(det[4].depends_on, ['Table A']);
  assert.equal(det[5].operation, 'lookup');
  assert.equal(det[5].output, 'discount_rate');
  assert.deepEqual(det[5].inputs, ['customer_tier']);
  assert.deepEqual(det[5].depends_on, ['Schedule Q']);
  assert.equal(det[6].operation, 'lookup');
  assert.equal(det[6].output, 'risk_score');
  assert.deepEqual(det[6].inputs, ['account_age']);
  assert.deepEqual(det[6].depends_on, ['Appendix R']);
  assert.equal(det[7].operation, 'lookup');
  assert.equal(det[7].output, 'base_rate');
  assert.deepEqual(det[7].inputs, ['class_code']);
  // Prose without table structure stays minimal.
  assert.equal(det[8].operation, undefined);
  assert.equal(det[9].operation, undefined);
  assert.deepEqual(job.routines[0].steps[0], 'Step 1: Find the base rate for occupancy_class in Table A.');
});

test('models: conditions parse IF-comma-otherwise and WHEN variants with both branches', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Gate', kind: 'condition', sourcePages: [1], evidenceText: 'ev',
        conditions: [
          'If raw_premium is below 350, set adjusted_premium to 350; otherwise adjusted_premium equals raw_premium.',
          'Otherwise adjusted_premium equals raw_premium.',
          'When territory is remote, apply surcharge; otherwise apply standard rate.',
          'IF x THEN y OTHERWISE z',
          'If cost exceeds limit, refer for review.',
          'Unstructured note.',
        ],
      }],
    })
  );
  const det = job.routines[0].conditions_detailed;
  assert.equal(det.length, 6);
  assert.equal(det[0].condition, 'raw_premium is below 350');
  assert.equal(det[0].true_branch, 'set adjusted_premium to 350');
  assert.equal(det[0].false_branch, 'adjusted_premium equals raw_premium.');
  assert.equal(det[1].false_branch, 'adjusted_premium equals raw_premium.');
  assert.equal(det[1].condition, undefined);
  assert.equal(det[2].condition, 'territory is remote');
  assert.equal(det[2].true_branch, 'apply surcharge');
  assert.equal(det[2].false_branch, 'apply standard rate.');
  assert.equal(det[3].condition, 'x');
  assert.equal(det[3].true_branch, 'y');
  assert.equal(det[3].false_branch, 'z');
  assert.equal(det[4].condition, 'cost exceeds limit');
  assert.equal(det[4].true_branch, 'refer for review.');
  assert.equal(det[4].false_branch, undefined);
  assert.equal(det[5].condition, undefined);
  assert.equal(det[5].true_branch, undefined);
  assert.equal(det[5].original_text, 'Unstructured note.');
});

test('models: rounding Store-as and conditional steps keep intermediate stages separate', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          'Round adjusted_premium to the nearest whole currency unit using half-up rounding. Store the result as annual_premium.',
          'Round indicated_premium to the nearest dollar.',
          'Apply minimum. If raw_premium is below 350, set adjusted_premium to 350; otherwise adjusted_premium equals raw_premium.',
          'If x is above 5, set y to 1; otherwise y equals x.',
          'Building replacement cost exceeds threshold.',
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 5);
  assert.equal(det[0].operation, 'rounding');
  assert.equal(det[0].operand, 'adjusted_premium');
  assert.equal(det[0].output, 'annual_premium');
  assert.deepEqual(det[0].inputs, ['adjusted_premium']);
  assert.equal(det[1].operation, 'rounding');
  assert.equal(det[1].operand, 'indicated_premium');
  assert.equal(det[1].output, 'indicated_premium');
  assert.deepEqual(det[1].inputs ?? [], []);
  assert.equal(det[2].operation, 'condition');
  assert.equal(det[2].output, 'adjusted_premium');
  assert.deepEqual(det[2].inputs, ['raw_premium']);
  assert.match(det[2].expression ?? '', /If raw_premium is below 350/);
  assert.equal(det[3].operation, 'condition');
  assert.equal(det[3].output, 'y');
  assert.deepEqual(det[3].inputs, ['x']);
  assert.equal(det[4].operation, undefined);
});

test('models: bare-numbered steps parse without a Step prefix', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Widget Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          '1 Find the widget rate for widget_class in Schedule Q.',
          '2 Retrieve gadget_factor from Appendix R using gadget_code.',
          '3 widget_total = widget_rate × gadget_factor.',
          '4 Round widget_total to the nearest whole unit. Store the result as billed_total.',
          '5 Apply floor. If widget_total is below 100, set floored_total to 100; otherwise floored_total equals widget_total.',
          '2-factor review is required before binding.',
          '1.20 is the minimum retained value.',
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 7);
  assert.equal(det[0].operation, 'lookup');
  assert.equal(det[0].output, 'widget_rate');
  assert.deepEqual(det[0].inputs, ['widget_class']);
  assert.deepEqual(det[0].depends_on, ['Schedule Q']);
  assert.equal(det[1].operation, 'lookup');
  assert.equal(det[1].output, 'gadget_factor');
  assert.deepEqual(det[1].inputs, ['gadget_code']);
  assert.deepEqual(det[1].depends_on, ['Appendix R']);
  assert.equal(det[2].operation, 'expression');
  assert.equal(det[2].output, 'widget_total');
  assert.equal(det[2].expression, 'widget_total = widget_rate × gadget_factor');
  assert.deepEqual(det[2].inputs, ['widget_rate', 'gadget_factor']);
  assert.equal(det[3].operation, 'rounding');
  assert.equal(det[3].operand, 'widget_total');
  assert.equal(det[3].output, 'billed_total');
  assert.equal(det[4].operation, 'condition');
  assert.equal(det[4].output, 'floored_total');
  assert.deepEqual(det[4].inputs, ['widget_total']);
  // Hyphenated terms and leading decimals are not step numbers: stay minimal.
  assert.equal(det[5].operation, undefined);
  assert.equal(det[6].operation, undefined);
  assert.deepEqual(job.routines[0].steps[0], '1 Find the widget rate for widget_class in Schedule Q.');
});

test('models: trailing rule actions split from the condition without invented branches', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Widget eligibility', kind: 'condition', sourcePages: [1], evidenceText: 'ev',
        conditions: [
          'RULE-7 Widget count exceeds 10 units. Refer',
          'RULE-8 Account was opened before 2019 and paperwork is missing. Decline',
          'RULE-9 Risk score is low. Apply widget credit from the Widget table.',
          'Single unstructured note.',
        ],
      }],
    })
  );
  const det = job.routines[0].conditions_detailed;
  assert.equal(det.length, 4);
  assert.equal(det[0].condition, 'RULE-7 Widget count exceeds 10 units.');
  assert.equal(det[0].true_branch, 'Refer');
  assert.equal(det[0].false_branch, undefined);
  assert.equal(det[1].true_branch, 'Decline');
  assert.equal(det[1].false_branch, undefined);
  assert.equal(det[2].condition, 'RULE-9 Risk score is low.');
  assert.equal(det[2].true_branch, 'Apply widget credit from the Widget table.');
  assert.equal(det[2].false_branch, undefined);
  assert.equal(det[3].condition, undefined);
  assert.equal(det[3].true_branch, undefined);
  assert.equal(det[3].original_text, 'Single unstructured note.');
  assert.equal(job.routines[0].conditions[0], 'RULE-7 Widget count exceeds 10 units. Refer');
});

test('models: routine kinds normalize recognized types and keep unknown ones', () => {
  const job = normalizeJob(
    createJob({
      routines: [
        { name: 'E', kind: 'eligibility', sourcePages: [1], evidenceText: 'ev', conditions: ['RULE-1 Widget count is high. Refer'] },
        { name: 'C', kind: 'calculation', sourcePages: [1], evidenceText: 'ev', steps: ['Do first thing'] },
        { name: 'F', kind: 'calculation', sourcePages: [1], evidenceText: 'ev', expressionText: 'total = alpha_value + beta_value' },
        { name: 'S', kind: 'Calculation Steps', sourcePages: [1], evidenceText: 'ev', steps: ['Do first thing'] },
        { name: 'E2', kind: 'Eligibility screening rules', sourcePages: [1], evidenceText: 'ev', conditions: ['RULE-2 Widget count is high. Refer'] },
        { name: 'P', kind: 'Premium rating procedure', sourcePages: [1], evidenceText: 'ev', steps: ['Do first thing'] },
        { name: 'M', kind: 'mystery', sourcePages: [1], evidenceText: 'ev' },
      ],
    })
  );
  assert.deepEqual(job.routines.map((r) => r.kind), ['condition', 'calculation_steps', 'formula', 'calculation_steps', 'condition', 'calculation_steps', 'mystery']);
});

test('models: sparse explicit steps enrich from their own instructions', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Widget Calc', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        steps: [
          { sequence: 1, instruction: 'Find the widget rate for widget_class in Schedule Q.' },
          { sequence: 2, instruction: 'Look up factor', operation: 'lookup', output: 'f' },
          { sequence: 3, instruction: 'Initialize total', operation: 'assignment', expression: 'total = 0', output: 'total' },
        ],
      }],
    })
  );
  const det = job.routines[0].steps_detailed;
  assert.equal(det.length, 3);
  assert.equal(det[0].sequence, 1);
  assert.equal(det[0].operation, 'lookup');
  assert.equal(det[0].output, 'widget_rate');
  assert.deepEqual(det[0].inputs, ['widget_class']);
  assert.deepEqual(det[0].depends_on, ['Schedule Q']);
  assert.equal(det[0].interpretation_status, 'inferred');
  // Explicitly provided fields are never overwritten by the parse.
  assert.equal(det[1].operation, 'lookup');
  assert.equal(det[1].output, 'f');
  assert.equal(det[1].inputs, undefined);
  assert.equal(det[2].expression, 'total = 0');
  assert.equal(det[2].interpretation_status, undefined);
  assert.deepEqual(job.routines[0].steps[0], 'Find the widget rate for widget_class in Schedule Q.');
});

test('models: table aliases resolve via prefix both ways, keywords, and dash variants', () => {
  const tables = [
    { id: 'T1', name: 'Table A \u2014 Base property rate by occupancy class' },
    { id: 'T2', name: 'Table B \u2014 Construction factor' },
    { id: 'T3', name: 'Table C \u2014 Protection factor' },
  ];
  assert.equal(resolveTableReference(tables, 'Table A')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'Table A \u2014 Base property rate')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'Table A - Base property rate')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'Base property table')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'Protection factor table')?.id, 'T3');
  assert.equal(resolveTableReference(tables, 'factor table'), null);
  assert.equal(resolveTableReference(tables, 'Table'), null);
  assert.equal(resolveTableReference(tables, 'Table Z'), null);
  assert.equal(resolveTableReference([{ id: 'T1', name: 'Table A' }], 'Table A \u2014 Base property rate')?.id, 'T1');
});

test('models: table name and title are preserved as aliases for resolution', () => {
  const job = normalizeJob(
    createJob({
      tables: [
        { name: 'SYN-CODE Part A', title: 'Synthetic Widget Multipliers', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
        { name: 'Plain Table', title: 'Plain Table', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
      ],
    })
  );
  assert.equal(job.tables[0].name, 'Synthetic Widget Multipliers');
  assert.deepEqual(job.tables[0].aliases, ['SYN-CODE Part A']);
  assert.deepEqual(job.tables[1].aliases, []);
  assert.equal(resolveTableReference(job.tables, 'SYN-CODE Part A')?.id, job.tables[0].id);
  assert.equal(resolveTableReference(job.tables, 'Synthetic Widget Multipliers')?.id, job.tables[0].id);
  assert.equal(resolveTableReference(job.tables, 'Plain Table')?.id, job.tables[1].id);
});

test('models: codes embedded in display names become aliases; ranges and prose do not', () => {
  const job = normalizeJob(
    createJob({
      tables: [
        { name: 'Widget Base Rates (SYN-BASE)', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
        { name: 'Widget Credits - SYN-CRED Part A', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
        { name: 'Rider Matrix (RID-001 to RID-008)', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
        { name: 'Plain Matrix', sourcePages: [1], evidenceText: 'ev', headers: ['K'], rows: [['1']] },
      ],
    })
  );
  assert.deepEqual(job.tables[0].aliases, ['SYN-BASE']);
  assert.deepEqual(job.tables[1].aliases, ['SYN-CRED Part A']);
  assert.deepEqual(job.tables[2].aliases, []);
  assert.deepEqual(job.tables[3].aliases, []);
  assert.equal(resolveTableReference(job.tables, 'SYN-BASE')?.id, job.tables[0].id);
  assert.equal(resolveTableReference(job.tables, 'SYN-CRED Part A')?.id, job.tables[1].id);
});

test('models: pipeline and business-rule kinds follow evidenced structure; unknown kinds pass through', () => {
  const job = normalizeJob(
    createJob({
      routines: [
        { name: 'P', kind: 'rating_pipeline', sourcePages: [1], evidenceText: 'e', steps: ['Do first', 'Do second'] },
        { name: 'B', kind: 'business_rule', sourcePages: [1], evidenceText: 'e', expressionText: 'out = a + b' },
        { name: 'C', kind: 'underwriting rule', sourcePages: [1], evidenceText: 'e', conditions: ['IF x THEN y'] },
        { name: 'M', kind: 'mystery', sourcePages: [1], evidenceText: 'e' },
      ],
    })
  );
  assert.deepEqual(job.routines.map((r) => r.kind), ['calculation_steps', 'formula', 'condition', 'mystery']);
});

test('models: per-unit amounts stay in input labels; worked amounts still strip', () => {
  assert.equal(cleanStepInputValue('Harbor Fee per $100'), 'Harbor Fee per $100');
  assert.equal(cleanStepInputValue('Zone Rate (4.50%)'), 'Zone Rate');
  assert.equal(cleanStepInputValue('Net Premium: \u20B937,531.00'), 'Net Premium');
  assert.equal(cleanStepInputValue('20.00%'), '');
});

test('models: table keyword matching is singular/plural-insensitive in both directions', () => {
  const tables = [
    { id: 'T1', name: 'Table 2. Territory Factors' },
    { id: 'T2', name: 'Table B \u2014 Construction factor' },
  ];
  assert.equal(resolveTableReference(tables, 'territory factor')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'territory factors')?.id, 'T1');
  assert.equal(resolveTableReference(tables, 'construction factors')?.id, 'T2');
  assert.equal(resolveTableReference(tables, 'construction factor')?.id, 'T2');
});

test('models: exact keyword matches win over stemmed ones; stemmed ambiguity stays unresolved', () => {
  const exactFirst = [
    { id: 'T1', name: 'Harbor Factor Schedule' },
    { id: 'T2', name: 'Harbor Berth Factors' },
  ];
  assert.equal(resolveTableReference(exactFirst, 'harbor factor')?.id, 'T1');
  const stemmedDupes = [
    { id: 'T1', name: 'North Factors' },
    { id: 'T2', name: 'North Factors Schedule' },
  ];
  assert.equal(resolveTableReference(stemmedDupes, 'north factor'), null);
  assert.deepEqual(findTableCandidates(stemmedDupes, 'north factor').map((t) => t.id), ['T1', 'T2']);
  assert.deepEqual(findTableCandidates(stemmedDupes, 'hull factor'), []);
});
