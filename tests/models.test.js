import test from 'node:test';
import assert from 'node:assert/strict';
import { assignmentTargetFromBranch, cleanStepInputValue, conditionsMutuallyExclusive, createJob, createDocument, createRatingRoutine, diagnoseFactorLookup, factorNameFromTable, findTableCandidates, generateParameterizedLookups, generatedStepSequence, generateWorkedExampleLookups, inferTableColumns, normalizeJob, resolveExplicitTableReference, resolveTableReference, resolveWorkedInputRow, splitBranchIsValue, splitSequentialConditionParts, stepInputTables } from '../src/models.js';

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

test('models: stated-value branches keep their subject as the condition output', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Tally Procedure', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        conditions: [
          'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage.',
          'If the policy covers 1 or 2 ledgers, the rebate is 0%.',
        ],
      }],
    })
  );
  const det = job.routines[0].conditions_detailed;
  assert.equal(det.length, 2);
  assert.equal(det[0].condition, 'the policy covers 3 to 10 ledgers');
  assert.equal(det[0].true_branch, 'the rebate is 5% of the pre-rebate tallage.');
  assert.equal(det[0].output, 'rebate');
  assert.equal(det[0].false_branch, undefined);
  assert.equal(det[1].condition, 'the policy covers 1 or 2 ledgers');
  assert.equal(det[1].true_branch, 'the rebate is 0%.');
  assert.equal(det[1].output, 'rebate');
  assert.equal(det[1].false_branch, undefined);
  assert.deepEqual(job.routines[0].conditions, [
    'If the policy covers 3 to 10 ledgers, the rebate is 5% of the pre-rebate tallage.',
    'If the policy covers 1 or 2 ledgers, the rebate is 0%.',
  ]);
});

test('models: structured condition outputs pass through verbatim', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Tally Procedure', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        conditions: [{ condition: 'ledger count is high', true_branch: 'rebate is 5%', output: 'rebate' }],
      }],
    })
  );
  assert.equal(job.routines[0].conditions_detailed[0].output, 'rebate');
});

test('models: branches without a stated value keep no condition output', () => {
  const job = normalizeJob(
    createJob({
      routines: [{
        name: 'Tally Procedure', kind: 'calculation_steps', sourcePages: [1], evidenceText: 'ev',
        conditions: [
          'If the ledger count is high, the tallage is reviewed annually.',
          'If the ledger count is high, apply the tallage adjustment.',
          'If the ledger count is high, it is 5%.',
          'IF ledger class is high THEN IF ledger zone is metro THEN apply metro factor ELSE apply base factor ELSE refer',
        ],
      }],
    })
  );
  const det = job.routines[0].conditions_detailed;
  assert.equal(det.length, 4);
  for (const entry of det) {
    assert.equal(entry.output, undefined);
  }
  assert.equal(det[0].true_branch, 'the tallage is reviewed annually.');
  assert.equal(det[3].true_branch, 'IF ledger zone is metro THEN apply metro factor ELSE apply base factor');
  assert.equal(det[3].false_branch, 'refer');
});

test('models: branch readers shared with the chain renderer agree on subjects and parts', () => {
  // assignmentTargetFromBranch and splitSequentialConditionParts are the
  // shared contract behind same-subject chain detection: every branch form
  // the renderer may chain resolves to the same subject reading here.
  assert.equal(assignmentTargetFromBranch('the rebate is 5% of the pre-rebate tallage.'), 'rebate');
  assert.equal(assignmentTargetFromBranch('rebate is 0%'), 'rebate');
  assert.equal(assignmentTargetFromBranch('set tally_total to 350'), 'tally_total');
  assert.equal(assignmentTargetFromBranch('band_total = base + margin'), 'band_total');
  assert.equal(assignmentTargetFromBranch('refer for manual review'), null);
  assert.equal(splitBranchIsValue('the ledger is coastal'), null);
  assert.deepEqual(
    splitSequentialConditionParts('If the policy covers 3 to 10 ledgers, the rebate is 5%. If the policy covers 1 or 2 ledgers, the rebate is 0%.'),
    [
      'If the policy covers 3 to 10 ledgers, the rebate is 5%',
      'If the policy covers 1 or 2 ledgers, the rebate is 0%',
    ]
  );
  assert.equal(splitSequentialConditionParts('If the policy covers 3 to 10 ledgers, the rebate is 5%.'), null);
  assert.equal(splitSequentialConditionParts('Review tallages annually.'), null);
});
test('models: mutual exclusivity needs disjoint coverage of one measure', () => {
  // Disjoint ranges on identical measure wording establish exclusivity;
  // overlaps, touching endpoints, differing measures, thresholds, and
  // numberless prose all decline so chains are never inferred.
  assert.equal(conditionsMutuallyExclusive('the policy covers 3 to 10 vehicles', 'the policy covers 1 or 2 vehicles'), true);
  assert.equal(conditionsMutuallyExclusive('the policy covers 3 to 10 vehicles', 'the policy covers 5 to 12 vehicles'), false);
  assert.equal(conditionsMutuallyExclusive('the policy covers 1 to 5 vehicles', 'the policy covers 5 to 10 vehicles'), false);
  assert.equal(conditionsMutuallyExclusive('the policy covers 3 to 10 vehicles', 'the policy covers 1 or 2 trailers'), false);
  assert.equal(conditionsMutuallyExclusive('fleet size exceeds 30 units', 'fleet size exceeds 25 units'), false);
  assert.equal(conditionsMutuallyExclusive('the policy covers up to 10 vehicles', 'the policy covers 1 or 2 vehicles'), false);
  assert.equal(conditionsMutuallyExclusive('the ledger is coastal', 'the ledger is inland'), false);
  assert.equal(conditionsMutuallyExclusive('the policy covers 5 vehicles', 'the policy covers 6 to 10 vehicles'), true);
  assert.equal(conditionsMutuallyExclusive('the policy covers 3 to 10 vehicles', 'the policy covers 3 to 10 vehicles'), false);
});
test('models: stepInputTables attributes inputs to step-named tables', () => {
  // Shared contract behind factor warnings and trace comments: an input
  // using a table the step names attributes to that table — unless the
  // input names the table itself, no table resolves, or none is named.
  const tables = [
    { name: 'Table 2. Territory Tallage Factors' },
    { name: 'Table 3. Driver Experience Factors' },
  ];
  const names = (step, input) => stepInputTables(step, tables, input).map((t) => t.name);
  assert.deepEqual(names({ depends_on: ['Table 2'] }, 'territory factor'), ['Table 2. Territory Tallage Factors']);
  assert.deepEqual(names({ depends_on: ['Table 2', 'Table 3'] }, 'factor'), ['Table 2. Territory Tallage Factors', 'Table 3. Driver Experience Factors']);
  assert.deepEqual(names({ depends_on: ['Table 2'] }, 'Table 2'), []);
  assert.deepEqual(names({ depends_on: ['Table 99'] }, 'territory factor'), []);
  assert.deepEqual(names({}, 'territory factor'), []);
  assert.deepEqual(names({ depends_on: ['Table 2'] }, ''), []);
});

// ---------- parameterized lookup generation ----------

function coverFactorTable() {
  return { name: 'Schedule S. Cover Factors', sourcePages: [1], evidenceText: 'cover factor schedule', headers: ['Cover code', 'Factor'], rows: [['C1', '1.10'], ['C2', '1.20']] };
}

function coverRatingRoutine() {
  return {
    name: 'Cover Rating Procedure', kind: 'calculation_steps', source_pages: [2], evidence_text: 'e',
    inputs: ['Cover'],
    outputs: [],
    steps: [
      'Step 1 \u2014 Base amount: Select the base amount for the ledger class from Schedule B.',
      'Step 2 \u2014 Adjusted amount: Multiply the base amount by the cover factor from Schedule S.',
      'Step 3 \u2014 Total amount: Add the fee to the Cover Factor from Schedule S.',
    ],
    steps_detailed: [
      { instruction: 'Step 1 \u2014 Base amount: Select the base amount for the ledger class from Schedule B.', operation: 'lookup', inputs: ['ledger class'], output: 'Base amount', depends_on: ['Schedule B'], evidence: 'Select the base amount for the ledger class from Schedule B.', source_pages: [2] },
      { instruction: 'Step 2 \u2014 Adjusted amount: Multiply the base amount by the cover factor from Schedule S.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount', depends_on: ['Schedule S'], evidence: 'Multiply the base amount by the cover factor from Schedule S.', source_pages: [2] },
      { instruction: 'Step 3 \u2014 Total amount: Add the fee to the Cover Factor from Schedule S.', operation: 'expression', expression: 'Cover Factor + fee', inputs: ['Cover Factor', 'fee'], output: 'Total amount', depends_on: ['Schedule S'], evidence: 'Add the fee to the Cover Factor from Schedule S.', source_pages: [2] },
    ],
  };
}

test('models: factor lookup diagnosis succeeds with an input-bound key column', () => {
  const d = diagnoseFactorLookup(coverRatingRoutine(), 1, 'cover factor', coverFactorTable());
  assert.equal(d.status, 'ok');
  assert.equal(d.keyColumn, 'Cover code');
  assert.equal(d.valueColumn, 'Factor');
  assert.equal(d.binding, 'Cover');
  assert.equal(d.bindingSource, 'input');
});

test('models: factor lookup diagnosis lets an exact match beat a partial match across sources', () => {
  // Inputs no longer outrank preceding outputs: the exact header match
  // wins wherever it is evidenced, without any source-order tie-break.
  const routine = coverRatingRoutine();
  routine.steps_detailed[0].output = 'Cover code';
  const d = diagnoseFactorLookup(routine, 1, 'cover factor', coverFactorTable());
  assert.equal(d.status, 'ok');
  assert.equal(d.binding, 'Cover code');
  assert.equal(d.bindingSource, 'step');
});

test('models: factor lookup diagnosis binds a preceding step output', () => {
  const routine = coverRatingRoutine();
  routine.inputs = [];
  routine.steps_detailed[0].output = 'Cover code';
  const d = diagnoseFactorLookup(routine, 1, 'cover factor', coverFactorTable());
  assert.equal(d.status, 'ok');
  assert.equal(d.binding, 'Cover code');
  assert.equal(d.bindingSource, 'step');
});

test('models: factor lookup diagnosis ignores outputs of later steps', () => {
  const routine = coverRatingRoutine();
  routine.inputs = [];
  routine.steps_detailed[2].output = 'Cover';
  const d = diagnoseFactorLookup(routine, 1, 'cover factor', coverFactorTable());
  assert.equal(d.status, 'no-binding');
  assert.equal(d.keyColumn, 'Cover code');
  assert.equal(d.valueColumn, 'Factor');
});

test('models: factor lookup diagnosis reports an unsupported key', () => {
  const routine = coverRatingRoutine();
  routine.inputs = [];
  const d = diagnoseFactorLookup(routine, 1, 'cover factor', coverFactorTable());
  assert.equal(d.status, 'no-binding');
  assert.equal(d.keyColumn, 'Cover code');
  assert.equal(d.valueColumn, 'Factor');
  assert.equal(d.binding, '');
});

test('models: factor lookup diagnosis reports ambiguous key columns', () => {
  const table = { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Territory description', 'Factor'], rows: [['SUB', 'Suburban', '1.00']] };
  const routine = { inputs: ['Territory'], steps_detailed: [{ inputs: ['territory factor'], output: 'Zone scaling' }] };
  const d = diagnoseFactorLookup(routine, 0, 'territory factor', table);
  assert.equal(d.status, 'ambiguous-key-column');
  assert.deepEqual(d.keyCandidates, ['Territory code', 'Territory description']);
  assert.equal(d.valueColumn, 'Factor');
});

test('models: factor lookup diagnosis reports a missing key column', () => {
  const table = { name: 'Table 2. Territory Factors', headers: ['Region', 'Factor'], rows: [['R1', '1.00']] };
  const routine = { inputs: ['Territory'], steps_detailed: [{ inputs: ['territory factor'], output: 'Zone scaling' }] };
  const d = diagnoseFactorLookup(routine, 0, 'territory factor', table);
  assert.equal(d.status, 'no-key-column');
  assert.equal(d.valueColumn, 'Factor');
});

test('models: factor lookup diagnosis reports a missing factor column', () => {
  const table = { name: 'Schedule S. Cover Rates', headers: ['Cover code', 'Rate'], rows: [['C1', '1.10']] };
  const routine = { inputs: ['Cover'], steps_detailed: [{ inputs: ['cover factor'], output: 'Adjusted' }] };
  const d = diagnoseFactorLookup(routine, 0, 'cover factor', table);
  assert.equal(d.status, 'no-value-column');
  assert.equal(d.keyColumn, '');
});

test('models: factor lookup diagnosis reports an ambiguous factor column', () => {
  const table = { name: 'Schedule S. Cover Factors', headers: ['Cover code', 'Factor', 'Factor percent'], rows: [['C1', '1.10', '110%']] };
  const routine = { inputs: ['Cover'], steps_detailed: [{ inputs: ['cover factor'], output: 'Adjusted' }] };
  const d = diagnoseFactorLookup(routine, 0, 'cover factor', table);
  assert.equal(d.status, 'ambiguous-value-column');
  assert.deepEqual(d.valueCandidates, ['Factor', 'Factor percent']);
});

test('models: parameterized lookup generation inserts a lookup step before first use', () => {
  const routine = coverRatingRoutine();
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 1);
  assert.equal(routine.steps.length, 4);
  assert.equal(routine.steps_detailed.length, 4);
  assert.equal(routine.steps[1], 'Look up the cover factor from Schedule S using Cover.');
  assert.deepEqual(routine.steps_detailed[1], {
    instruction: 'Look up the cover factor from Schedule S using Cover.',
    operation: 'lookup',
    inputs: ['Cover'],
    output: 'cover factor',
    depends_on: ['Schedule S'],
    evidence: 'Multiply the base amount by the cover factor from Schedule S.',
    source_pages: [2],
    interpretation_status: 'inferred',
  });
  assert.equal(routine.steps_detailed[2].output, 'Adjusted amount');
  assert.equal(routine.steps_detailed[3].output, 'Total amount');
});

test('models: generated lookup recases downstream references to the canonical factor name', () => {
  const routine = coverRatingRoutine();
  generateParameterizedLookups(routine, [coverFactorTable()]);
  const third = routine.steps_detailed[3];
  assert.deepEqual(third.inputs, ['cover factor', 'fee']);
  assert.equal(third.expression, 'cover factor + fee');
  assert.deepEqual(routine.steps_detailed[2].inputs, ['Base amount', 'cover factor']);
});

test('models: lookup generation is idempotent and preserves explicit lookups', () => {
  const routine = coverRatingRoutine();
  const table = coverFactorTable();
  assert.equal(generateParameterizedLookups(routine, [table]), 1);
  const snapshot = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, [table]), 0);
  assert.equal(JSON.stringify(routine), snapshot);
  const explicit = coverRatingRoutine();
  explicit.steps.splice(1, 0, 'Step 1b \u2014 Cover factor: Look up the Cover Factor from Schedule S using Cover.');
  explicit.steps_detailed.splice(1, 0, { instruction: 'Look up the Cover Factor from Schedule S using Cover.', operation: 'lookup', inputs: ['Cover'], output: 'Cover Factor', depends_on: ['Schedule S'], evidence: 'e', source_pages: [2] });
  assert.equal(generateParameterizedLookups(explicit, [table]), 0);
  assert.equal(explicit.steps_detailed.length, 4);
  assert.deepEqual(explicit.steps_detailed[2].inputs, ['Base amount', 'cover factor']);
});

test('models: lookup generation skips factors that are routine inputs', () => {
  const routine = coverRatingRoutine();
  routine.inputs = ['Cover', 'cover factor'];
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 0);
  assert.equal(JSON.stringify(routine), before);
});

test('models: lookup generation skips factors naming no extracted table', () => {
  const routine = coverRatingRoutine();
  for (const s of routine.steps_detailed) {
    if (s.output === 'Adjusted amount' || s.output === 'Total amount') s.depends_on = ['Schedule Z'];
  }
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 0);
  assert.equal(JSON.stringify(routine), before);
});

test('models: lookup generation skips factors matching several tables', () => {
  const tables = [
    coverFactorTable(),
    { name: 'Table 9. Cover Factors Riders', headers: ['Rider code', 'Factor'], rows: [['R1', '1.00']] },
  ];
  const routine = coverRatingRoutine();
  routine.steps_detailed[1].depends_on = ['Schedule S', 'Table 9'];
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, tables), 0);
  assert.equal(JSON.stringify(routine), before);
});

test('models: lookup generation skips factors used from different tables', () => {
  const tables = [
    coverFactorTable(),
    { name: 'Table 9. Cover Factors Riders', headers: ['Cover code', 'Factor'], rows: [['C1', '1.05']] },
  ];
  const routine = coverRatingRoutine();
  routine.steps_detailed[2].depends_on = ['Table 9'];
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, tables), 0);
  assert.equal(JSON.stringify(routine), before);
});

test('models: lookup generation never borrows another routine\u2019s inputs', () => {
  const routine = coverRatingRoutine();
  routine.inputs = [];
  const worked = { name: 'Worked Example', kind: 'worked_example', inputs: ['Cover: C1'], steps: [], steps_detailed: [] };
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()], [routine, worked]), 0);
  assert.equal(JSON.stringify(routine), before);
});

test('models: lookup generation binds a preceding step output', () => {
  const routine = coverRatingRoutine();
  routine.inputs = [];
  routine.steps_detailed[0].output = 'Cover code';
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 1);
  assert.equal(routine.steps[1], 'Look up the cover factor from Schedule S using Cover code.');
  assert.deepEqual(routine.steps_detailed[1].inputs, ['Cover code']);
});

test('models: lookup generation emits one lookup per factor', () => {
  const tables = [
    coverFactorTable(),
    { name: 'Schedule M. Mode Factors', sourcePages: [1], evidenceText: 'mode factor schedule', headers: ['Mode code', 'Factor'], rows: [['M1', '0.95']] },
  ];
  const routine = {
    name: 'Rating', kind: 'procedure', source_pages: [2], evidence_text: 'e',
    inputs: ['Cover', 'Mode'],
    outputs: [],
    steps: ['Use cover.', 'Use mode.'],
    steps_detailed: [
      { instruction: 'Use cover.', operation: 'expression', expression: 'Base * cover factor', inputs: ['Base', 'cover factor'], output: 'Adjusted', depends_on: ['Schedule S'], evidence: 'Use cover.', source_pages: [2] },
      { instruction: 'Use mode.', operation: 'expression', expression: 'Adjusted * mode factor', inputs: ['Adjusted', 'mode factor'], output: 'Total', depends_on: ['Schedule M'], evidence: 'Use mode.', source_pages: [2] },
    ],
  };
  assert.equal(generateParameterizedLookups(routine, tables), 2);
  assert.equal(routine.steps.length, 4);
  assert.equal(routine.steps_detailed.length, 4);
  assert.equal(routine.steps_detailed[0].output, 'cover factor');
  assert.equal(routine.steps_detailed[2].output, 'mode factor');
  assert.deepEqual(routine.steps_detailed[2].inputs, ['Mode']);
});

test('models: lookup generation anchors on the first generatable use', () => {
  // An earlier use without table evidence does not block generation: the
  // lookup anchors on the first evidenced use, and only downstream
  // references take the canonical name.
  const routine = coverRatingRoutine();
  routine.steps_detailed[2].depends_on = [];
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 1);
  assert.equal(routine.steps[1], 'Look up the cover factor from Schedule S using Cover.');
  assert.deepEqual(routine.steps_detailed[3].inputs, ['cover factor', 'fee']);
});

test('models: generated lookups survive repeated normalization', () => {
  const job = normalizeJob(createJob({
    document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
    tables: [coverFactorTable()],
    routines: [coverRatingRoutine()],
  }));
  const routine = job.routines[0];
  assert.equal(generateParameterizedLookups(routine, job.tables, job.routines), 1);
  const twice = normalizeJob(normalizeJob(job));
  const steps = twice.routines[0].steps_detailed;
  assert.equal(steps.filter((s) => s.operation === 'lookup' && s.output === 'cover factor').length, 1);
  assert.equal(twice.routines[0].steps.length, steps.length);
  assert.equal(twice.routines[0].steps[1], 'Look up the cover factor from Schedule S using Cover.');
});

test('models: factor lookup diagnosis reports an ambiguous binding', () => {
  // Two inputs overlap the key column with no exact or specificity
  // winner: no lookup may guess, so the candidates are named for review.
  const routine = coverRatingRoutine();
  routine.inputs = ['Cover', 'Cover region'];
  const d = diagnoseFactorLookup(routine, 1, 'cover factor', coverFactorTable());
  assert.equal(d.status, 'ambiguous-binding');
  assert.deepEqual(d.bindingCandidates, ['Cover', 'Cover region']);
  assert.equal(d.binding, '');
});

test('models: factor lookup diagnosis is independent of candidate order', () => {
  const table = coverFactorTable();
  const forward = coverRatingRoutine();
  forward.inputs = ['Cover', 'Cover region'];
  const reversed = coverRatingRoutine();
  reversed.inputs = ['Cover region', 'Cover'];
  const a = diagnoseFactorLookup(forward, 1, 'cover factor', table);
  const b = diagnoseFactorLookup(reversed, 1, 'cover factor', table);
  assert.equal(a.status, 'ambiguous-binding');
  assert.deepEqual(a, b);
});

test('models: factor lookup diagnosis lets an exact match beat a partial match', () => {
  // Exact header agreement wins in either order: source order never
  // breaks the tie.
  const table = coverFactorTable();
  for (const inputs of [['Cover', 'Cover code'], ['Cover code', 'Cover']]) {
    const routine = coverRatingRoutine();
    routine.inputs = inputs;
    const d = diagnoseFactorLookup(routine, 1, 'cover factor', table);
    assert.equal(d.status, 'ok');
    assert.equal(d.binding, 'Cover code');
    assert.equal(d.bindingSource, 'input');
  }
});

test('models: factor lookup diagnosis lets unique specificity win without an exact match', () => {
  // No input equals the header, but one shares strictly more words: that
  // most-evidenced candidate binds.
  const table = { name: 'Schedule S. Cover Factors', headers: ['Policy cover code', 'Factor'], rows: [['P1', '1.10']] };
  const routine = { inputs: ['Code', 'Cover code'], steps_detailed: [{ inputs: ['cover factor'], output: 'Adjusted' }] };
  const d = diagnoseFactorLookup(routine, 0, 'cover factor', table);
  assert.equal(d.status, 'ok');
  assert.equal(d.keyColumn, 'Policy cover code');
  assert.equal(d.binding, 'Cover code');
});

test('models: factor lookup diagnosis collapses duplicate and case-variant inputs', () => {
  // Identical and case-variant surfaces denote one variable, not two
  // candidates.
  const table = coverFactorTable();
  const dupes = coverRatingRoutine();
  dupes.inputs = ['Cover', 'Cover'];
  assert.equal(diagnoseFactorLookup(dupes, 1, 'cover factor', table).status, 'ok');
  const cased = coverRatingRoutine();
  cased.inputs = ['cover', 'Cover'];
  const d = diagnoseFactorLookup(cased, 1, 'cover factor', table);
  assert.equal(d.status, 'ok');
  assert.equal(d.binding, 'Cover');
});

test('models: lookup generation skips factors with an ambiguous binding', () => {
  const routine = coverRatingRoutine();
  routine.inputs = ['Cover', 'Cover region'];
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 0);
  assert.equal(JSON.stringify(routine), before);
});

test('models: lookup generation binds the exact match in either candidate order', () => {
  for (const inputs of [['Cover', 'Cover code'], ['Cover code', 'Cover']]) {
    const routine = coverRatingRoutine();
    routine.inputs = inputs;
    assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 1);
    assert.equal(routine.steps[1], 'Look up the cover factor from Schedule S using Cover code.');
    assert.deepEqual(routine.steps_detailed[1].inputs, ['Cover code']);
  }
});

// ---------- factor attribution fallback + explicit table resolution ----------

test('models: stepInputTables falls back to routine dependencies without step mentions', () => {
  // Latest live-extraction shape: the step states no table, the routine
  // does. The factor attributes to its unique table; without routine
  // evidence the old behavior stands.
  const table = coverFactorTable();
  const routine = { depends_on: ['Schedule S. Cover Factors'], steps_detailed: [] };
  const step = { operation: 'expression', inputs: ['Base amount', 'cover factor'], output: 'Adjusted' };
  assert.deepEqual(stepInputTables(step, [table], 'cover factor', routine).map((t) => t.name), ['Schedule S. Cover Factors']);
  assert.deepEqual(stepInputTables(step, [table], 'cover factor'), []);
  assert.deepEqual(stepInputTables(step, [table], 'cover factor', {}), []);
});

test('models: stepInputTables prefers step mentions over routine fallback', () => {
  // An explicit but unresolvable step mention is not overridden by the
  // routine: the step's own (broken) reference stands for review.
  const table = coverFactorTable();
  const routine = { depends_on: ['Schedule S. Cover Factors'] };
  const step = { operation: 'expression', inputs: ['cover factor'], output: 'X', depends_on: ['Schedule Z'] };
  assert.deepEqual(stepInputTables(step, [table], 'cover factor', routine), []);
});

test('models: stepInputTables fallback keeps ambiguous attribution ambiguous', () => {
  const tables = [
    coverFactorTable(),
    { name: 'Table 9. Cover Factors Riders', headers: ['Rider code', 'Factor'], rows: [['R1', '1.00']] },
  ];
  const routine = { depends_on: ['Schedule S. Cover Factors', 'Table 9. Cover Factors Riders'] };
  const step = { operation: 'expression', inputs: ['cover factor'], output: 'X' };
  assert.deepEqual(
    stepInputTables(step, tables, 'cover factor', routine).map((t) => t.name),
    ['Schedule S. Cover Factors', 'Table 9. Cover Factors Riders']);
});

test('models: resolveExplicitTableReference resolves explicit mentions only', () => {
  const tables = [
    { id: 'T1', name: 'Table 1. Base Rates', aliases: ['SYN-BASE'] },
    { id: 'T2', name: 'Table 2. Territory Factors' },
    { id: 'TA', name: 'Table A - Base property rate' },
  ];
  assert.equal(resolveExplicitTableReference(tables, 'Table 2. Territory Factors')?.id, 'T2');
  assert.equal(resolveExplicitTableReference(tables, 'T2')?.id, 'T2');
  assert.equal(resolveExplicitTableReference(tables, 'Table 2')?.id, 'T2');
  assert.equal(resolveExplicitTableReference(tables, 'SYN-BASE')?.id, 'T1');
  assert.equal(resolveExplicitTableReference(tables, 'Base property table')?.id, 'TA');
  assert.equal(resolveExplicitTableReference(tables, 'territory factor'), null);
  assert.equal(resolveExplicitTableReference(tables, 'Territory Factors'), null);
  assert.equal(resolveExplicitTableReference(tables, 'base premium'), null);
  assert.equal(resolveExplicitTableReference(tables, ''), null);
});

test('models: resolveExplicitTableReference refuses ambiguous prefixes', () => {
  const tables = [
    { id: 'T2', name: 'Table 2. Territory Factors' },
    { id: 'T2B', name: 'Table 2 - Territory Surcharges' },
  ];
  assert.equal(resolveExplicitTableReference(tables, 'Table 2'), null);
  assert.equal(resolveExplicitTableReference(tables, 'Table 2 - Territory Surcharges')?.id, 'T2B');
});

test('models: lookup generation uses routine fallback evidence with a bound key', () => {
  // Steps without depends_on still generate when the routine names one
  // table and the key binds: the generated lookup cites the table name.
  const table = coverFactorTable();
  const routine = {
    name: 'Cover Rating Procedure', kind: 'calculation_steps', source_pages: [2], evidence_text: 'e',
    inputs: ['Cover'],
    outputs: [],
    depends_on: ['Schedule S. Cover Factors'],
    steps: [
      'Step 1 \u2014 Base amount: Select the base amount.',
      'Step 2 \u2014 Adjusted amount: Multiply the base amount by the cover factor from Schedule S.',
    ],
    steps_detailed: [
      { instruction: 'Step 1 \u2014 Base amount: Select the base amount.', operation: 'lookup', inputs: ['ledger class'], output: 'Base amount', evidence: 'Select the base amount.', source_pages: [2] },
      { instruction: 'Step 2 \u2014 Adjusted amount: Multiply the base amount by the cover factor from Schedule S.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount', evidence: 'Multiply the base amount by the cover factor from Schedule S.', source_pages: [2] },
    ],
  };
  assert.equal(generateParameterizedLookups(routine, [table]), 1);
  assert.equal(routine.steps[1], 'Look up the cover factor from Schedule S. Cover Factors using Cover.');
  assert.deepEqual(routine.steps_detailed[1].depends_on, ['Schedule S. Cover Factors']);
});

test('models: lookup generation stays silent for fallback attribution without a binding', () => {
  // Fallback evidence triggers attribution but never a lookup by itself:
  // the live-extraction shape (no step mentions, no key) generates nothing.
  const table = coverFactorTable();
  const routine = {
    name: 'Cover Rating Procedure', kind: 'calculation_steps', source_pages: [2], evidence_text: 'e',
    inputs: [],
    outputs: [],
    depends_on: ['Schedule S. Cover Factors'],
    steps: ['Use cover.'],
    steps_detailed: [
      { instruction: 'Use cover.', operation: 'expression', expression: 'Base * cover factor', inputs: ['Base', 'cover factor'], output: 'Adjusted', evidence: 'Use cover.', source_pages: [2] },
    ],
  };
  const before = JSON.stringify(routine);
  assert.equal(generateParameterizedLookups(routine, [table]), 0);
  assert.equal(JSON.stringify(routine), before);
});

// ---------- operation-bearing worked-example steps ----------

function opBearingWorkedStep(operation, instruction, expression, output) {
  return {
    sequence: 2, instruction, operation, expression,
    inputs: ['$1,050.00', '1.00'], output,
    cells: { step: '2. Territory adjustment', calculation: '$1,050.00 \u00d7 1.00', result: '$1,050.00' },
  };
}

function normalizeWorkedStep(step) {
  const routine = createRatingRoutine({ name: 'Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'e', steps: [step] });
  return routine.steps_detailed[0];
}

test('models: op-bearing worked multiply preserves label output and stated result', () => {
  // Model-provided operation with literal worked values: the operation
  // canonicalizes, the label becomes the output, and the bare amount is
  // kept as a stated result instead of being stripped.
  const d = normalizeWorkedStep(opBearingWorkedStep('multiply', '2. Territory adjustment: $1,050.00 \u00d7 1.00', '$1,050.00 \u00d7 1.00', '$1,050.00'));
  assert.equal(d.operation, 'expression');
  assert.equal(d.output, 'Territory adjustment');
  assert.equal(d.inputs, undefined);
  assert.deepEqual(d.stated_results, [{ output: 'Territory adjustment', value: '$1,050.00' }]);
  assert.equal(d.expression, '$1,050.00 \u00d7 1.00');
});

test('models: op-bearing worked subtract and round preserve values and verbs', () => {
  const sub = normalizeWorkedStep(opBearingWorkedStep('subtract', '7. Final before rounding: $1,122.1875 - $56.109375', '$1,122.1875 - $56.109375', '$1,066.078125'));
  assert.equal(sub.operation, 'expression');
  assert.equal(sub.output, 'Final before rounding');
  assert.deepEqual(sub.stated_results, [{ output: 'Final before rounding', value: '$1,066.078125' }]);
  const rnd = normalizeWorkedStep({ sequence: 8, instruction: '8. Final annual premium: RoundHalfUp($1,066.078125, 2)', operation: 'round', expression: 'RoundHalfUp($1,066.078125, 2)', inputs: ['$1,066.078125'], output: '$1,066.08', cells: { step: '8. Final annual premium', calculation: 'RoundHalfUp($1,066.078125, 2)', result: '$1,066.08' } });
  assert.equal(rnd.operation, 'rounding');
  assert.equal(rnd.output, 'Final annual premium');
  assert.deepEqual(rnd.stated_results, [{ output: 'Final annual premium', value: '$1,066.08' }]);
});

test('models: op-bearing named outputs pass through without invented stated results', () => {
  // Ordinary rating-routine shape: model operation plus a named output
  // stays exactly as evidenced — nothing adopted, nothing invented.
  const d = normalizeWorkedStep({ sequence: 2, instruction: 'Step 2 \u2014 Territory adjustment: Multiply the base premium by the territory factor.', operation: 'multiply', expression: 'base premium \u00d7 territory factor', inputs: ['base premium', 'territory factor'], output: 'Step 2 result' });
  assert.equal(d.operation, 'expression');
  assert.equal(d.output, 'Step 2 result');
  assert.deepEqual(d.inputs, ['base premium', 'territory factor']);
  assert.equal(d.stated_results, undefined);
});

test('models: op-absent and op-present worked steps converge on the same values', () => {
  // The operation source must not decide value preservation: the same
  // worked evidence keeps the same output and stated result either way.
  const withOp = normalizeWorkedStep(opBearingWorkedStep('multiply', '2. Territory adjustment: $1,050.00 \u00d7 1.00', '$1,050.00 \u00d7 1.00', '$1,050.00'));
  const bare = { ...opBearingWorkedStep('multiply', '2. Territory adjustment: $1,050.00 \u00d7 1.00', '$1,050.00 \u00d7 1.00', '$1,050.00') };
  delete bare.operation;
  const withoutOp = normalizeWorkedStep(bare);
  assert.equal(withOp.output, withoutOp.output);
  assert.deepEqual(withOp.stated_results, withoutOp.stated_results);
  assert.equal(withOp.expression, withoutOp.expression);
});

test('models: op-bearing steps without an output stay bare', () => {
  // Positive control: an incomplete calculation (operation and
  // expression but no amount evidencing the output slot) adopts nothing.
  const d = normalizeWorkedStep({ sequence: 2, instruction: '2. Territory adjustment', operation: 'multiply', expression: '$1,050.00 \u00d7 1.00', cells: { step: '2. Territory adjustment', calculation: '$1,050.00 \u00d7 1.00', result: '' } });
  assert.equal(d.operation, 'expression');
  assert.equal(d.output, undefined);
  assert.equal(d.stated_results, undefined);
});

test('models: op-bearing worked values without a label stay unadopted', () => {
  // Positive control: a bare amount with no label evidence to adopt must
  // not invent a target; sanitization still removes the literal.
  const d = normalizeWorkedStep({ sequence: 2, operation: 'multiply', expression: '$5.00 \u00d7 2', inputs: ['$5.00', '2'], output: '$10.00' });
  assert.equal(d.output, undefined);
  assert.equal(d.stated_results, undefined);
});

test('models: contradicted model operations demote without adopting values', () => {
  // Positive control: an operation the evidence contradicts (multiply
  // over a selection statement) demotes as before and gains no adopted
  // output — ambiguity stays visible instead of rendering clean.
  const d = normalizeWorkedStep({ sequence: 1, instruction: '1. Base premium: Selected rate for LDV', operation: 'multiply', expression: 'Selected rate for LDV', inputs: ['Vehicle class'], output: '$1,050.00', cells: { step: '1. Base premium', calculation: 'Selected rate for LDV', result: '$1,050.00' } });
  assert.equal(d.operation, undefined);
  assert.equal(d.output, undefined);
  assert.equal(d.stated_results, undefined);
});

test('models: op-bearing worked values survive repeated normalization', () => {
  const job = normalizeJob(createJob({
    document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
    tables: [],
    routines: [{ name: 'Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'e', steps: [opBearingWorkedStep('multiply', '2. Territory adjustment: $1,050.00 \u00d7 1.00', '$1,050.00 \u00d7 1.00', '$1,050.00')] }],
  }));
  const twice = normalizeJob(job);
  const d = twice.routines[0].steps_detailed[0];
  assert.equal(d.output, 'Territory adjustment');
  assert.deepEqual(d.stated_results, [{ output: 'Territory adjustment', value: '$1,050.00' }]);
  assert.equal(twice.routines[0].steps.length, twice.routines[0].steps_detailed.length);
});

// ---------- rounding operand linking ----------

function roundingWorkedRoutine() {
  return {
    name: 'Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
    steps: [
      { sequence: 7, instruction: '7. Final before rounding: $1,122.1875 - $56.109375', operation: 'subtract', expression: '$1,122.1875 - $56.109375', inputs: ['$1,122.1875', '$56.109375'], output: '$1,066.078125', cells: { step: '7. Final before rounding', calculation: '$1,122.1875 - $56.109375', result: '$1,066.078125' } },
      { sequence: 8, instruction: '8. Final annual premium: RoundHalfUp($1,066.078125, 2)', operation: 'round', expression: 'RoundHalfUp($1,066.078125, 2)', inputs: ['$1,066.078125'], output: '$1,066.08', cells: { step: '8. Final annual premium', calculation: 'RoundHalfUp($1,066.078125, 2)', result: '$1,066.08' } },
    ],
  };
}

test('models: rounding operand links to the preceding stated value', () => {
  // The call argument exactly equals the preceding step's stated value,
  // so the operand names that step's output; the rounding result stays.
  const routine = createRatingRoutine(roundingWorkedRoutine());
  const d = routine.steps_detailed[1];
  assert.equal(d.operation, 'rounding');
  assert.equal(d.output, 'Final annual premium');
  assert.equal(d.operand, 'Final before rounding');
});

test('models: rounding operand requires a unique stated-value match', () => {
  // Two preceding steps state the same value: no operand is guessed, but
  // the rounding output and stated result are still preserved.
  const routine = createRatingRoutine({
    name: 'Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
    steps: [
      { sequence: 6, instruction: '6. First tally: $25.00 \u00d7 2', operation: 'multiply', expression: '$25.00 \u00d7 2', inputs: ['$25.00', '2'], output: '$50.00', cells: { step: '6. First tally', calculation: '$25.00 \u00d7 2', result: '$50.00' } },
      { sequence: 7, instruction: '7. Second tally: $10.00 \u00d7 5', operation: 'multiply', expression: '$10.00 \u00d7 5', inputs: ['$10.00', '5'], output: '$50.00', cells: { step: '7. Second tally', calculation: '$10.00 \u00d7 5', result: '$50.00' } },
      { sequence: 8, instruction: '8. Rounded tally: RoundHalfUp($50.00, 2)', operation: 'round', expression: 'RoundHalfUp($50.00, 2)', inputs: ['$50.00'], output: '$50.00', cells: { step: '8. Rounded tally', calculation: 'RoundHalfUp($50.00, 2)', result: '$50.00' } },
    ],
  });
  const d = routine.steps_detailed[2];
  assert.equal(d.operation, 'rounding');
  assert.equal(d.output, 'Rounded tally');
  assert.equal(d.operand, undefined);
});

test('models: rounding without a matching stated value stays targetless', () => {
  const again = createRatingRoutine({
    name: 'Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
    steps: [
      { sequence: 7, instruction: '7. Final before rounding: $1,122.1875 - $56.109375', operation: 'subtract', expression: '$1,122.1875 - $56.109375', inputs: ['$1,122.1875', '$56.109375'], output: '$1,066.078125', cells: { step: '7. Final before rounding', calculation: '$1,122.1875 - $56.109375', result: '$1,066.078125' } },
      { sequence: 8, instruction: '8. Final annual premium: RoundHalfUp($9.99, 2)', operation: 'round', expression: 'RoundHalfUp($9.99, 2)', inputs: ['$9.99'], output: '$9.99', cells: { step: '8. Final annual premium', calculation: 'RoundHalfUp($9.99, 2)', result: '$9.99' } },
    ],
  });
  assert.equal(again.steps_detailed[1].operand, undefined);
});

test('models: explicit rounding operands are never overwritten', () => {
  const raw = roundingWorkedRoutine();
  raw.steps[1].operand = 'Final premium';
  const routine = createRatingRoutine(raw);
  assert.equal(routine.steps_detailed[1].operand, 'Final premium');
});

test('models: rounding operand linking needs a call-form expression', () => {
  // A rounding operation over prose states no callable value: no operand
  // is linked even with preceding stated values present.
  const routine = createRatingRoutine({
    name: 'Worked', kind: 'worked_example', sourcePages: [1], evidenceText: 'e',
    steps: [
      { sequence: 7, instruction: '7. Final before rounding: $1,122.1875 - $56.109375', operation: 'subtract', expression: '$1,122.1875 - $56.109375', inputs: ['$1,122.1875', '$56.109375'], output: '$1,066.078125', cells: { step: '7. Final before rounding', calculation: '$1,122.1875 - $56.109375', result: '$1,066.078125' } },
      { sequence: 8, instruction: '8. Final annual premium', operation: 'round', expression: 'the rounded total', output: 'Final annual premium' },
    ],
  });
  const d = routine.steps_detailed[1];
  assert.equal(d.operation, 'rounding');
  assert.equal(d.operand, undefined);
});

test('models: linked rounding operands survive repeated normalization', () => {
  const job = normalizeJob(createJob({
    document: createDocument({ filename: 'g.pdf', pageCount: 1 }),
    tables: [],
    routines: [roundingWorkedRoutine()],
  }));
  const twice = normalizeJob(job);
  const d = twice.routines[0].steps_detailed[1];
  assert.equal(d.operation, 'rounding');
  assert.equal(d.output, 'Final annual premium');
  assert.equal(d.operand, 'Final before rounding');
});

test('models: numeric key-worded columns classify as keys, not outputs', () => {
  // Currency-valued lookup dimensions (liability limits, deductibles) are
  // keys even though their cells are numeric: header wording decides.
  const limit = inferTableColumns({
    headers: ['Liability limit', 'Factor'],
    columns: [],
    rows: [['$500,000', '1.00'], ['$1,000,000', '1.25']],
  });
  assert.equal(limit[0].role, 'key');
  assert.equal(limit[1].role, 'output');
  const deductible = inferTableColumns({
    headers: ['Collision deductible', 'Factor'],
    columns: [],
    rows: [['$0', '1.00'], ['$500', '0.95']],
  });
  assert.equal(deductible[0].role, 'key');
  assert.equal(deductible[1].role, 'output');
});

test('models: value-worded headers keep output precedence', () => {
  // A header naming the value itself stays an output even when it also
  // carries a key-dimension word.
  const cols = inferTableColumns({
    headers: ['Territory factor', 'Limit amount'],
    columns: [],
    rows: [['1.00', '500'], ['1.25', '750']],
  });
  assert.equal(cols[0].role, 'output');
  assert.equal(cols[1].role, 'output');
});

test('models: factor names derive mechanically from table titles', () => {
  assert.equal(factorNameFromTable({ name: 'Table 2. Territory Factors' }), 'Territory factor');
  assert.equal(factorNameFromTable({ name: 'Table 3. Driver Experience Factors' }), 'Driver experience factor');
  assert.equal(factorNameFromTable({ name: 'Schedule S. Cover Factors' }), 'Cover factor');
  assert.equal(factorNameFromTable({ name: 'Table 9. BI Liability Factors' }), 'BI liability factor');
  assert.equal(factorNameFromTable({ name: 'Fleet discount rule' }), 'Fleet discount rule');
  assert.equal(factorNameFromTable({ name: 'Table 2' }), '');
  assert.equal(factorNameFromTable({}), '');
});

test('models: worked inputs resolve to exact table rows', () => {
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['URB', '1.20'], ['SUB', '1.00']] },
    { name: 'Table 4. Liability Limit Factors', headers: ['Liability limit', 'Factor'], columns: [{ label: 'Liability limit', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['$500,000', '1.00'], ['$1,000,000', '1.25']] },
  ];
  const code = resolveWorkedInputRow('Territory: Suburban (SUB)', tables);
  assert.ok(code);
  assert.equal(code.table, tables[0]);
  assert.equal(code.tableIndex, 0);
  assert.equal(code.rowIndex, 1);
  assert.equal(code.key, 'SUB');
  assert.equal(code.tier, 'code');
  assert.equal(code.value, '1.00');
  const amount = resolveWorkedInputRow('Liability limit: $1,000,000', tables);
  assert.ok(amount);
  assert.equal(amount.table, tables[1]);
  assert.equal(amount.tableIndex, 1);
  assert.equal(amount.rowIndex, 1);
  assert.equal(amount.key, '$1,000,000');
  assert.equal(amount.tier, 'amount');
  assert.equal(amount.label, 'Liability limit');
  assert.equal(amount.value, '1.25');
});

test('models: worked row resolution rejects near-misses and ambiguity', () => {
  const clean = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['URB', '1.20'], ['SUB', '1.00']] },
  ];
  assert.equal(resolveWorkedInputRow('Territory: Suburban (SUX)', clean), null);
  assert.equal(resolveWorkedInputRow('Territory: Suburban (sub)', clean), null);
  assert.equal(resolveWorkedInputRow('Policy vehicle count: 4 vehicles', clean), null);
  assert.equal(resolveWorkedInputRow('$500', clean), null);
  const dupRows = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['SUB', '1.00'], ['SUB', '1.20']] },
  ];
  assert.equal(resolveWorkedInputRow('Territory: Suburban (SUB)', dupRows), null);
  const dupTables = clean.concat([
    { name: 'Table 9. Other Factors', headers: ['Code', 'Factor'], columns: [{ label: 'Code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['SUB', '0.50']] },
  ]);
  assert.equal(resolveWorkedInputRow('Territory: Suburban (SUB)', dupTables), null);
  const noValue = [
    { name: 'Fleet discount rule', headers: ['Policy vehicle count', 'Fleet discount rate'], columns: [{ label: 'Policy vehicle count', role: 'key' }, { label: 'Fleet discount rate', role: 'key' }], rows: [['C1', '0%']] },
  ];
  assert.equal(resolveWorkedInputRow('Count: (C1)', noValue), null);
});

test('models: worked example generates instance lookups before their calculations', () => {
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['URB', '1.20'], ['SUB', '1.00']] },
    { name: 'Table 4. Liability Limit Factors', headers: ['Liability limit', 'Factor'], columns: [{ label: 'Liability limit', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['$500,000', '1.00'], ['$1,000,000', '1.25']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)', 'Liability limit: $1,000,000'],
    outputs: [],
    depends_on: ['Table 2. Territory Factors', 'Table 4. Liability Limit Factors'],
    steps: [
      '1. Base premium: Selected rate for LDV',
      '2. Territory adjustment: $1,050.00 * 1.00',
      '3. Liability adjustment: $1,050.00 * 1.25',
    ],
    steps_detailed: [
      { instruction: '1. Base premium: Selected rate for LDV', operation: 'lookup', inputs: ['LDV'], output: 'Base premium', depends_on: ['Table 1. Base Annual Rate by Vehicle Class'], evidence: 'e1', source_pages: [2], stated_results: [{ output: 'Base premium', value: '$1,050.00' }] },
      { instruction: '2. Territory adjustment: $1,050.00 * 1.00', operation: 'expression', expression: '$1,050.00 * 1.00', inputs: [], output: 'Territory adjustment', evidence: 'e2', source_pages: [2], stated_results: [{ output: 'Territory adjustment', value: '$1,050.00' }] },
      { instruction: '3. Liability adjustment: $1,050.00 * 1.25', operation: 'expression', expression: '$1,050.00 * 1.25', inputs: [], output: 'Liability adjustment', evidence: 'e3', source_pages: [2], stated_results: [{ output: 'Liability adjustment', value: '$1,312.50' }] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 2);
  assert.equal(routine.steps_detailed.length, 5);
  assert.equal(routine.steps.length, 5);
  const sub = routine.steps_detailed[1];
  assert.equal(sub.operation, 'lookup');
  assert.equal(sub.instruction, 'Look up the Territory factor from Table 2. Territory Factors using SUB.');
  assert.equal(sub.output, 'Territory factor');
  assert.deepEqual(sub.inputs, ['SUB']);
  assert.deepEqual(sub.depends_on, ['Table 2. Territory Factors']);
  assert.equal(sub.evidence, 'Territory: Suburban (SUB)');
  assert.deepEqual(sub.source_pages, [2]);
  assert.equal(sub.interpretation_status, 'inferred');
  assert.deepEqual(sub.stated_results, [{ output: 'Territory factor', value: '1.00' }]);
  assert.equal(routine.steps_detailed[2].output, 'Territory adjustment');
  const lim = routine.steps_detailed[3];
  assert.equal(lim.instruction, 'Look up the Liability limit factor from Table 4. Liability Limit Factors using Liability limit.');
  assert.equal(lim.output, 'Liability limit factor');
  assert.deepEqual(lim.inputs, ['Liability limit']);
  assert.deepEqual(lim.stated_results, [{ output: 'Liability limit factor', value: '1.25' }]);
  assert.equal(routine.steps_detailed[4].output, 'Liability adjustment');
  assert.equal(routine.steps[1], sub.instruction);
  assert.equal(routine.steps[3], lim.instruction);
});

test('models: worked lookup generation leaves reusable procedures untouched', () => {
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['SUB', '1.00']] },
  ];
  const routine = {
    name: 'Rating Procedure', kind: 'calculation_steps', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)'],
    outputs: [],
    depends_on: [],
    steps: ['Apply: Base * 1.00'],
    steps_detailed: [
      { instruction: 'Apply: Base * 1.00', operation: 'expression', expression: 'Base * 1.00', inputs: ['Base'], output: 'Adjusted', evidence: 'e', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 0);
  assert.equal(routine.steps_detailed.length, 1);
});

test('models: worked lookup generation never duplicates its own output', () => {
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['SUB', '1.00']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)'],
    outputs: [],
    depends_on: [],
    steps: ['1. Territory adjustment: $1,050.00 * 1.00'],
    steps_detailed: [
      { instruction: '1. Territory adjustment: $1,050.00 * 1.00', operation: 'expression', expression: '$1,050.00 * 1.00', inputs: [], output: 'Territory adjustment', evidence: 'e', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 1);
  assert.equal(generateWorkedExampleLookups(routine, tables), 0);
  assert.equal(routine.steps_detailed.length, 2);
});

test('models: conflicting worked selections for one factor generate nothing', () => {
  // Two instance selections for the same factor disagree on the row: no
  // lookup is invented and the analyst sees the raw inputs instead.
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['URB', '1.20'], ['SUB', '1.00']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)', 'Territory: Urban core (URB)'],
    outputs: [],
    depends_on: [],
    steps: ['1. First: Base * 1.00', '2. Second: Base * 1.20'],
    steps_detailed: [
      { instruction: '1. First: Base * 1.00', operation: 'expression', expression: 'Base * 1.00', inputs: [], output: 'First', evidence: 'e1', source_pages: [2] },
      { instruction: '2. Second: Base * 1.20', operation: 'expression', expression: 'Base * 1.20', inputs: [], output: 'Second', evidence: 'e2', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 0);
  assert.equal(routine.steps_detailed.length, 2);
});

test('models: worked lookup generation skips keys an explicit lookup already binds', () => {
  const tables = [
    { name: 'Table 1. Base Annual Rate by Vehicle Class', headers: ['Vehicle class code', 'Base annual rate per vehicle'], columns: [{ label: 'Vehicle class code', role: 'key' }, { label: 'Base annual rate per vehicle', role: 'output' }], rows: [['LDV', '$1,050.00']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Vehicle class: Light Delivery Van (LDV)'],
    outputs: [],
    depends_on: [],
    steps: ['1. Base premium: Selected rate for LDV'],
    steps_detailed: [
      { instruction: '1. Base premium: Selected rate for LDV', operation: 'lookup', inputs: ['LDV'], output: 'Base premium', evidence: 'e1', source_pages: [2], stated_results: [{ output: 'Base premium', value: '$1,050.00' }] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 0);
  assert.equal(routine.steps_detailed.length, 1);
});

test('models: amount-keyed worked lookups without a label stay unresolved', () => {
  const tables = [
    { name: 'Table 5. Collision Deductible Factors', headers: ['Collision deductible', 'Factor'], columns: [{ label: 'Collision deductible', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['$0', '1.00'], ['$500', '0.95']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['$500'],
    outputs: [],
    depends_on: [],
    steps: ['1. Adjustment: Base * 0.95'],
    steps_detailed: [
      { instruction: '1. Adjustment: Base * 0.95', operation: 'expression', expression: 'Base * 0.95', inputs: [], output: 'Adjustment', evidence: 'e', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 0);
  assert.equal(routine.steps_detailed.length, 1);
});

test('models: worked lookups without a unique consumer anchor at first factor use', () => {
  // The input-plus-row evidence still earns a lookup, but with no unique
  // consuming calculation it anchors before the first factor use — or at
  // the start when nothing consumes the value yet.
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['SUB', '1.00']] },
  ];
  const shared = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)'],
    outputs: [],
    depends_on: [],
  };
  const multi = {
    ...shared,
    steps: ['1. First: Base + Fee', '2. Second: Base * 1.00', '3. Third: Base * 1.00'],
    steps_detailed: [
      { instruction: '1. First: Base + Fee', operation: 'expression', expression: 'Base + Fee', inputs: [], output: 'First', evidence: 'e1', source_pages: [2] },
      { instruction: '2. Second: Base * 1.00', operation: 'expression', expression: 'Base * 1.00', inputs: [], output: 'Second', evidence: 'e2', source_pages: [2] },
      { instruction: '3. Third: Base * 1.00', operation: 'expression', expression: 'Base * 1.00', inputs: [], output: 'Third', evidence: 'e3', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(multi, tables), 1);
  assert.equal(multi.steps_detailed[1].output, 'Territory factor');
  assert.equal(multi.steps_detailed[2].output, 'Second');
  const none = {
    ...shared,
    steps: ['1. First: Base + Fee'],
    steps_detailed: [
      { instruction: '1. First: Base + Fee', operation: 'expression', expression: 'Base + Fee', inputs: [], output: 'First', evidence: 'e1', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(none, tables), 1);
  assert.equal(none.steps_detailed[0].output, 'Territory factor');
  assert.equal(none.steps_detailed[1].output, 'First');
});

test('models: worked example outputs never suppress procedure lookup generation', () => {
  // A worked example illustrating the same factor must not mark the
  // reusable procedure's factor as produced: the procedure still earns
  // its own parameterized lookup.
  const routine = coverRatingRoutine();
  const worked = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Cover: (C1)'],
    outputs: [],
    steps: ['Look up the cover factor from Schedule S. Cover Factors using C1.'],
    steps_detailed: [
      { instruction: 'Look up the cover factor from Schedule S. Cover Factors using C1.', operation: 'lookup', inputs: ['C1'], output: 'cover factor', depends_on: ['Schedule S. Cover Factors'], evidence: 'Cover: (C1)', source_pages: [2], stated_results: [{ output: 'cover factor', value: '1.10' }] },
    ],
  };
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()], [routine, worked]), 1);
});

test('models: generated step sequences suffix and bump deterministically', () => {
  assert.equal(generatedStepSequence({ sequence: 1 }), '1b');
  assert.equal(generatedStepSequence({ sequence: '2' }), '2b');
  assert.equal(generatedStepSequence({ sequence: '1b' }), '1c');
  assert.equal(generatedStepSequence({ sequence: '2z' }), '2zb');
  assert.equal(generatedStepSequence({ sequence: 'A' }), 'Ab');
  assert.equal(generatedStepSequence({ sequence: 'a' }), 'ab');
  assert.equal(generatedStepSequence({}), '');
  assert.equal(generatedStepSequence(undefined), '');
  assert.equal(generatedStepSequence({ sequence: '' }), '');
});

test('models: generated worked lookups take letter-suffixed sequences', () => {
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['URB', '1.20'], ['SUB', '1.00']] },
    { name: 'Table 4. Liability Limit Factors', headers: ['Liability limit', 'Factor'], columns: [{ label: 'Liability limit', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['$500,000', '1.00'], ['$1,000,000', '1.25']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)', 'Liability limit: $1,000,000'],
    outputs: [],
    depends_on: [],
    steps: ['1. Territory adjustment: $1,050.00 * 1.00', '2. Liability adjustment: $1,050.00 * 1.25'],
    steps_detailed: [
      { sequence: 1, instruction: '1. Territory adjustment: $1,050.00 * 1.00', operation: 'expression', expression: '$1,050.00 * 1.00', inputs: [], output: 'Territory adjustment', evidence: 'e1', source_pages: [2] },
      { sequence: 2, instruction: '2. Liability adjustment: $1,050.00 * 1.25', operation: 'expression', expression: '$1,050.00 * 1.25', inputs: [], output: 'Liability adjustment', evidence: 'e2', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 2);
  // SUB lookup anchors at the start with no preceding step: no sequence,
  // keeping positional numbering.
  assert.equal(routine.steps_detailed[0].sequence, undefined);
  assert.equal(routine.steps_detailed[0].output, 'Territory factor');
  // Liability lookup follows source step 1: letter-suffixed, never
  // colliding with source step 2.
  assert.equal(routine.steps_detailed[2].sequence, '1b');
  assert.equal(routine.steps_detailed[2].output, 'Liability limit factor');
  assert.equal(routine.steps_detailed[3].sequence, 2);
});

test('models: adjacent generated lookups bump the letter suffix', () => {
  // Both values are consumed by the same calculation, so both lookups
  // anchor together: 1b then 1c.
  const tables = [
    { name: 'Table 2. Territory Factors', headers: ['Territory code', 'Factor'], columns: [{ label: 'Territory code', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['SUB', '1.00']] },
    { name: 'Table 4. Liability Limit Factors', headers: ['Liability limit', 'Factor'], columns: [{ label: 'Liability limit', role: 'key' }, { label: 'Factor', role: 'output' }], rows: [['$1,000,000', '1.25']] },
  ];
  const routine = {
    name: 'Worked Example', kind: 'worked_example', source_pages: [2], evidence_text: 'e',
    inputs: ['Territory: Suburban (SUB)', 'Liability limit: $1,000,000'],
    outputs: [],
    depends_on: [],
    steps: ['1. First: Base + Fee', '2. Second: 1.00 + 1.25'],
    steps_detailed: [
      { sequence: 1, instruction: '1. First: Base + Fee', operation: 'expression', expression: 'Base + Fee', inputs: [], output: 'First', evidence: 'e1', source_pages: [2] },
      { sequence: 2, instruction: '2. Second: 1.00 + 1.25', operation: 'expression', expression: '1.00 + 1.25', inputs: [], output: 'Second', evidence: 'e2', source_pages: [2] },
    ],
  };
  assert.equal(generateWorkedExampleLookups(routine, tables), 2);
  assert.equal(routine.steps_detailed[1].sequence, '1b');
  assert.equal(routine.steps_detailed[1].output, 'Territory factor');
  assert.equal(routine.steps_detailed[2].sequence, '1c');
  assert.equal(routine.steps_detailed[2].output, 'Liability limit factor');
  assert.equal(routine.steps_detailed[3].sequence, 2);
});

test('models: generated parameterized lookups take letter-suffixed sequences', () => {
  const routine = coverRatingRoutine();
  routine.steps_detailed[0].sequence = 1;
  routine.steps_detailed[1].sequence = 2;
  routine.steps_detailed[2].sequence = 3;
  assert.equal(generateParameterizedLookups(routine, [coverFactorTable()]), 1);
  assert.equal(routine.steps_detailed[1].sequence, '1b');
  assert.equal(routine.steps_detailed[2].sequence, 2);
});

test('models: generated lookup sequences survive renormalization', () => {
  const job = normalizeJob(createJob({
    document: createDocument({ filename: 'g.pdf', pageCount: 2 }),
    tables: [
      { name: 'Table 2. Territory Factors', sourcePages: [1], evidenceText: 'territory factor schedule', headers: ['Territory code', 'Description', 'Factor'], rows: [['SUB', 'Suburban', '1.00'], ['URB', 'Urban core', '1.20']] },
    ],
    routines: [{
      name: 'Worked Example', kind: 'worked_example', sourcePages: [2], evidenceText: 'e',
      inputs: ['Territory: Suburban (SUB)'],
      outputs: ['Adjusted total: $1,050.00'],
      steps: [
        { sequence: 1, instruction: '1. Base: $500.00 * 2.00', operation: 'multiply', expression: '$500.00 * 2.00', inputs: ['$500.00', '2.00'], output: '$1,000.00', cells: { step: '1. Base', calculation: '$500.00 * 2.00', result: '$1,000.00' } },
        { sequence: 2, instruction: '2. Territory adjustment: $1,050.00 * 1.00', operation: 'multiply', expression: '$1,050.00 * 1.00', inputs: ['$1,050.00', '1.00'], output: '$1,050.00', cells: { step: '2. Territory adjustment', calculation: '$1,050.00 * 1.00', result: '$1,050.00' } },
      ],
    }],
  }));
  for (const t of job.tables) t.columns = inferTableColumns(t);
  const worked = job.routines[0];
  assert.equal(generateWorkedExampleLookups(worked, job.tables), 1);
  assert.equal(worked.steps_detailed[1].sequence, '1b');
  const again = normalizeJob(job);
  const reworked = again.routines[0];
  assert.equal(reworked.steps_detailed.length, 3);
  assert.equal(reworked.steps.length, 3);
  assert.equal(reworked.steps_detailed[1].operation, 'lookup');
  assert.equal(reworked.steps_detailed[1].sequence, '1b');
  assert.equal(reworked.steps_detailed[1].output, 'Territory factor');
  assert.equal(reworked.steps[1], reworked.steps_detailed[1].instruction);
  assert.equal(generateWorkedExampleLookups(reworked, again.tables), 0);
});

test('models: mixed value-worded columns with half numeric cells stay outputs', () => {
  // Annotation cells (scope notes, exclusions) never flip a rate column
  // into a key: at least half numeric keeps the value wording's verdict.
  const cols = inferTableColumns({
    headers: ['Policy vehicle count', 'Fleet discount rate'],
    columns: [],
    rows: [['1 to 2', '0%'], ['3 to 10', '5%'], ['More than 10', 'Outside the scope of this guide']],
  });
  assert.equal(cols[0].role, 'key');
  assert.equal(cols[1].role, 'output');
});

test('models: key wording still beats value wording on mixed columns', () => {
  // 'Rate code' is identifying despite the value word and the numeric cell.
  const cols = inferTableColumns({
    headers: ['Rate code'],
    columns: [],
    rows: [['R1'], ['5']],
  });
  assert.equal(cols[0].role, 'key');
});

test('models: value-worded columns with few numeric cells stay unknown', () => {
  const cols = inferTableColumns({
    headers: ['Factor'],
    columns: [],
    rows: [['High'], ['High'], ['1.5']],
  });
  assert.equal(cols[0].role ?? '', '');
});
