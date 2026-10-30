import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processPdf, applyReviewEdits, buildJobFromExtraction } from '../src/pipeline.js';
import { createDocument, createJob, normalizeJob } from '../src/models.js';
import { validateJob } from '../src/validate.js';
import { ModelDisabledError } from '../src/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePdf = path.join(here, '..', 'fixtures', 'sample-guideline.pdf');
const recording = path.join(here, '..', 'fixtures', 'recorded', 'sample-extract.json');

test('pipeline: sample PDF + recording yields validated job', async () => {
  const buf = await fs.readFile(samplePdf);
  const { job, source } = await processPdf(buf, {
    filename: 'sample-guideline.pdf',
    recordingPath: recording,
  });
  assert.equal(source, 'recorded');
  assert.equal(job.document.page_count, 3);
  assert.equal(job.tables.length, 2);
  assert.equal(job.routines.length, 4);
  assert.ok(job.tables.every((t) => t.id && t.source_pages.length > 0 && t.evidence_text));
  assert.ok(job.routines.every((r) => r.id && r.source_pages.length > 0 && r.evidence_text));
  const errors = job.issues.filter((i) => i.severity === 'error');
  assert.equal(errors.length, 0);
  assert.ok(job.issues.some((i) => i.target_id === 'R4' && /cannot reliably interpret/.test(i.message)));
});

test('pipeline: processPdf returns raw extraction untouched for auditability', async () => {
  const buf = await fs.readFile(samplePdf);
  const { job, extraction } = await processPdf(buf, {
    filename: 'sample-guideline.pdf',
    recordingPath: recording,
  });
  const recorded = JSON.parse(await fs.readFile(recording, 'utf8'));
  assert.deepEqual(extraction.tables, recorded.tables);
  assert.deepEqual(extraction.routines, recorded.routines);
  // Normalized job carries IDs the raw output lacks: the two differ.
  assert.ok(job.tables.every((t) => t.id));
  assert.ok(!recorded.tables.every((t) => t.id));
});

test('pipeline: live extraction without config raises ModelDisabledError', async () => {
  const buf = await fs.readFile(samplePdf);
  await assert.rejects(processPdf(buf, { modelOptions: { env: {} } }), ModelDisabledError);
});

test('pipeline: reviewer edits re-validate without model calls', async () => {
  const buf = await fs.readFile(samplePdf);
  const { job } = await processPdf(buf, { recordingPath: recording });
  const edited = applyReviewEdits(job, {
    routines: job.routines.map((r) =>
      r.id === 'R4' ? { ...r, expression_text: 'surcharge = base * 0.05' } : r
    ),
  });
  assert.ok(!edited.issues.some((i) => i.target_id === 'R4' && /cannot reliably interpret/.test(i.message)));
  assert.ok(edited.issues.every((i) => i.id && i.id.startsWith('V')));
});

// ---------- table continuation linking (G1) ----------

function continuationJob(tables) {
  return buildJobFromExtraction({ tables, routines: [] }, { filename: 'g.pdf', pageCount: 12 });
}

test('pipeline: adjacent-page matching headers link without merging rows', () => {
  const built = continuationJob([
    { name: 'Schedule alpha', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['A1', '1.10']] },
    { name: 'Schedule beta', sourcePages: [2], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['A2', '1.20']] },
  ]);
  assert.equal(built.tables.length, 2);
  assert.notEqual(built.tables[0].id, built.tables[1].id);
  assert.ok(built.tables[0].continuation && built.tables[1].continuation, 'both parts must link');
  assert.equal(built.tables[0].continuation.logical_group, built.tables[1].continuation.logical_group);
  assert.equal(built.tables[0].continuation.group_size, '2'); // continuation scalars normalize to strings
  assert.deepEqual(built.tables[0].rows, [['A1', '1.10']]);
  assert.deepEqual(built.tables[1].rows, [['A2', '1.20']]);
});

test('pipeline: explicit continuation cues link non-adjacent parts', () => {
  const built = continuationJob([
    { name: 'Rate Schedule', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['A1', '1.10']] },
    { name: 'Rate Schedule (continued)', sourcePages: [9], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['A2', '1.20']] },
  ]);
  assert.ok(built.tables[0].continuation && built.tables[1].continuation, 'explicit cue must link across a page gap');
  assert.equal(built.tables[0].continuation.logical_group, built.tables[1].continuation.logical_group);
  assert.deepEqual(built.tables[0].rows, [['A1', '1.10']]);
  assert.deepEqual(built.tables[1].rows, [['A2', '1.20']]);
});

test('pipeline: same-stem tables with different headers stay distinct with ambiguity retained', () => {
  const tables = [
    { name: 'Ledger Tariff SYN-GROUP Part A', sourcePages: [1], evidenceText: 'e', headers: ['Alpha Code', 'Alpha Factor'], rows: [['A1', '1.10']] },
    { name: 'Ledger Tariff SYN-GROUP Part B', sourcePages: [1], evidenceText: 'e', headers: ['Beta Code', 'Beta Factor'], rows: [['B1', '1.20']] },
  ];
  const built = continuationJob(tables);
  assert.equal(built.tables[0].continuation.logical_group, 'syn-group');
  assert.equal(built.tables[1].continuation.logical_group, 'syn-group');
  assert.notEqual(built.tables[0].id, built.tables[1].id);
  assert.deepEqual(built.tables[0].rows, [['A1', '1.10']]);
  assert.deepEqual(built.tables[1].rows, [['B1', '1.20']]);

  const bare = normalizeJob(createJob({
    document: createDocument({ filename: 'g.pdf', pageCount: 3 }),
    tables: built.tables,
    routines: [{ name: 'R', kind: 'formula', sourcePages: [1], evidenceText: 'e', expressionText: 'a = 1', dependsOn: ['SYN-GROUP'] }],
  }));
  const dep = validateJob(bare).find((i) => /depends on "SYN-GROUP"/.test(i.message));
  assert.ok(dep && /matches multiple tables/.test(dep.message), 'bare stem ref without per-part evidence stays ambiguous');
});

test('pipeline: same-page identical tables without cues stay unlinked', () => {
  const built = continuationJob([
    { name: 'Schedule alpha', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['A1', '1.10']] },
    { name: 'Schedule beta', sourcePages: [1], evidenceText: 'e', headers: ['Code', 'Cost'], rows: [['A2', '1.20']] },
  ]);
  assert.ok(built.tables[0].continuation === null || built.tables[0].continuation === undefined);
  assert.ok(built.tables[1].continuation === null || built.tables[1].continuation === undefined);
});

// ---------- parameterized lookup generation ----------

function lookupExtraction({ inputs } = {}) {
  return {
    tables: [
      { name: 'Schedule S. Cover Factors', sourcePages: [1], evidenceText: 'cover factor schedule', headers: ['Cover code', 'Factor'], rows: [['C1', '1.10'], ['C2', '1.20']] },
    ],
    routines: [{
      name: 'Cover Rating Procedure', kind: 'calculation_steps', sourcePages: [2], evidenceText: 'e',
      inputs: inputs ?? ['Cover'],
      steps: [
        'Step 1 — Base amount: Select the base amount for the ledger class from Schedule B.',
        'Step 2 — Adjusted amount: Multiply the base amount by the cover factor from Schedule S.',
      ],
      steps_detailed: [
        { instruction: 'Step 1 — Base amount: Select the base amount for the ledger class from Schedule B.', operation: 'lookup', inputs: ['ledger class'], output: 'Base amount', depends_on: ['Schedule B'], evidence: 'Select the base amount for the ledger class from Schedule B.', source_pages: [2] },
        { instruction: 'Step 2 — Adjusted amount: Multiply the base amount by the cover factor from Schedule S.', operation: 'expression', expression: 'Base amount * cover factor', inputs: ['Base amount', 'cover factor'], output: 'Adjusted amount', depends_on: ['Schedule S'], evidence: 'Multiply the base amount by the cover factor from Schedule S.', source_pages: [2] },
      ],
    }],
  };
}

test('pipeline: buildJobFromExtraction generates a parameterized lookup before validation', () => {
  const job = buildJobFromExtraction(lookupExtraction(), { filename: 'p.pdf', pageCount: 2 });
  const routine = job.routines[0];
  assert.equal(routine.steps.length, 3);
  assert.equal(routine.steps_detailed.length, 3);
  assert.equal(routine.steps[1], 'Look up the cover factor from Schedule S using Cover.');
  const generated = routine.steps_detailed[1];
  assert.equal(generated.operation, 'lookup');
  assert.deepEqual(generated.inputs, ['Cover']);
  assert.equal(generated.output, 'cover factor');
  assert.deepEqual(generated.depends_on, ['Schedule S']);
  const msgs = job.issues.map((i) => i.message).join(' | ');
  assert.ok(!job.issues.some((i) => /"cover factor"/.test(i.message)), `produced factor must stay silent: ${msgs}`);
});

test('pipeline: reviewer edits regenerate lookups without model calls', () => {
  const stored = normalizeJob(createJob({
    document: createDocument({ filename: 'p.pdf', pageCount: 2 }),
    ...lookupExtraction(),
  }));
  assert.equal(stored.routines[0].steps_detailed.length, 2);
  const edited = applyReviewEdits(stored, {});
  const routine = edited.routines[0];
  assert.equal(routine.steps_detailed.length, 3);
  assert.equal(routine.steps_detailed[1].operation, 'lookup');
  assert.equal(routine.steps_detailed[1].output, 'cover factor');
  const msgs = edited.issues.map((i) => i.message).join(' | ');
  assert.ok(!edited.issues.some((i) => /"cover factor"/.test(i.message)), `produced factor must stay silent: ${msgs}`);
});

test('pipeline: procedure without key support keeps the unresolved factor warning', () => {
  const job = buildJobFromExtraction(lookupExtraction({ inputs: [] }), { filename: 'p.pdf', pageCount: 2 });
  const routine = job.routines[0];
  assert.equal(routine.steps_detailed.length, 2);
  assert.ok(!routine.steps_detailed.some((s) => s.output === 'cover factor'), 'no lookup may be generated without a bound key');
  const msgs = job.issues.map((i) => i.message).join(' | ');
  const hit = job.issues.find((i) => /uses "cover factor" from Table "Schedule S\. Cover Factors"/.test(i.message));
  assert.ok(hit, `unsupported factor must warn with its table: ${msgs}`);
  assert.match(hit.message, /no routine input or preceding step provides the lookup key/);
});
