import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, createJob, normalizeJob } from '../src/models.js';
import { groupStepRoutines } from '../src/routine-group.js';
import { processPdf } from '../src/pipeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Fully synthetic chain fixtures: abstract stage/variable names so the tests
// exercise generic grouping structure only — no domain titles or formulas.
function chainRoutine(num, expression, extra = {}) {
  const padded = String(num).padStart(2, '0');
  return {
    name: `PIPE-STEP-${padded}: Synthetic stage ${num}`,
    kind: 'formula',
    sourcePages: [1],
    evidenceText: `Synthetic step ${num}: ${expression}`,
    expressionText: expression,
    ...extra,
  };
}

function syntheticChain() {
  return [
    chainRoutine(1, 'rate1 = base_rate', { inputs: ['base_rate'], outputs: ['rate1'] }),
    chainRoutine(2, 'rate2 = rate1 * zone_factor', {
      dependsOn: ['PIPE-STEP-01'],
      inputs: ['rate1', 'zone_factor'],
      outputs: ['rate2'],
    }),
    chainRoutine(3, 'total = rate2 + flat_fee', {
      dependsOn: ['PIPE-STEP-02'],
      inputs: ['rate2', 'flat_fee'],
      outputs: ['total'],
    }),
  ];
}

function normalizeRoutines(routines) {
  return normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), routines })
  ).routines;
}

test('routine-group: consecutive numbered chain groups into one ordered routine', () => {
  const { routines, groupings } = groupStepRoutines(normalizeRoutines(syntheticChain()));
  assert.equal(routines.length, 1);
  assert.equal(groupings.length, 1);
  const [grouped] = routines;
  assert.equal(grouped.kind, 'calculation_steps');
  assert.equal(grouped.name, 'PIPE-STEP-01 to PIPE-STEP-03');
  assert.deepEqual(grouped.steps, [
    'rate1 = base_rate',
    'rate2 = rate1 * zone_factor',
    'total = rate2 + flat_fee',
  ]);
  assert.deepEqual(grouped.steps_detailed.map((s) => s.sequence), [1, 2, 3]);
  assert.deepEqual(grouped.steps_detailed.map((s) => s.output), ['rate1', 'rate2', 'total']);
  assert.ok(grouped.steps_detailed.every((s) => s.operation === 'assignment' && s.evidence && s.source_pages.length > 0));
  // Intermediates produced and consumed inside the pipeline drop out of the
  // routine-level inputs/outputs; external values stay.
  assert.deepEqual([...grouped.inputs].sort(), ['base_rate', 'flat_fee', 'zone_factor']);
  assert.deepEqual([...grouped.outputs], ['total']);
  // Internal routine references resolve inside the group; external ones stay.
  assert.deepEqual(grouped.depends_on, []);
  assert.deepEqual(grouped.source_pages, [1]);
  assert.deepEqual(groupings[0].memberNames, [
    'PIPE-STEP-01: Synthetic stage 1',
    'PIPE-STEP-02: Synthetic stage 2',
    'PIPE-STEP-03: Synthetic stage 3',
  ]);
});

test('routine-group: distinct names never group', () => {
  const routines = normalizeRoutines([
    { name: 'Alpha base', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'b = a * 2', inputs: ['a'], outputs: ['b'] },
    { name: 'Beta total', kind: 'formula', sourcePages: [1], evidenceText: 'ev', expressionText: 'c = b + 1', inputs: ['b'], outputs: ['c'] },
  ]);
  const { routines: out, groupings } = groupStepRoutines(routines);
  assert.equal(out.length, 2);
  assert.equal(groupings.length, 0);
});

test('routine-group: number gaps split runs; broken chains stay separate', () => {
  const gapped = normalizeRoutines([
    chainRoutine(1, 'rate1 = base_rate', { inputs: ['base_rate'], outputs: ['rate1'] }),
    chainRoutine(2, 'rate2 = rate1 * zone_factor', { inputs: ['rate1', 'zone_factor'], outputs: ['rate2'] }),
    chainRoutine(4, 'total = rate2 + flat_fee', { inputs: ['rate2', 'flat_fee'], outputs: ['total'] }),
  ]);
  const gappedOut = groupStepRoutines(gapped);
  assert.equal(gappedOut.routines.length, 2);
  assert.equal(gappedOut.routines[0].steps.length, 2);
  assert.equal(gappedOut.routines[1].steps.length, 0);

  const unchained = normalizeRoutines([
    chainRoutine(1, 'rate1 = base_rate', { inputs: ['base_rate'], outputs: ['rate1'] }),
    chainRoutine(2, 'other = lone * 3', { inputs: ['lone'], outputs: ['other'] }),
  ]);
  const unchainedOut = groupStepRoutines(unchained);
  assert.equal(unchainedOut.routines.length, 2);
  assert.equal(unchainedOut.groupings.length, 0);
});

test('routine-group: routines with their own steps or no expression stay separate', () => {
  const routines = normalizeRoutines([
    chainRoutine(1, 'rate1 = base_rate', { inputs: ['base_rate'], outputs: ['rate1'] }),
    {
      name: 'PIPE-STEP-02: Synthetic prose stage',
      kind: 'formula',
      sourcePages: [1],
      evidenceText: 'Synthetic descriptive stage without a stated expression.',
      steps: [{ sequence: 1, instruction: 'Review the synthetic schedule.' }],
    },
  ]);
  const { routines: out, groupings } = groupStepRoutines(routines);
  assert.equal(out.length, 2);
  assert.equal(groupings.length, 0);
});

test('routine-group: grouped routine survives re-normalization with carried details', () => {
  const { routines } = groupStepRoutines(normalizeRoutines(syntheticChain()));
  const again = normalizeJob(
    createJob({ document: createDocument({ filename: 'g.pdf', pageCount: 3 }), routines })
  ).routines;
  assert.equal(again.length, 1);
  assert.equal(again[0].kind, 'calculation_steps');
  assert.equal(again[0].steps.length, 3);
  assert.equal(again[0].steps_detailed.length, 3);
  assert.deepEqual(again[0].steps_detailed.map((s) => s.operation), ['assignment', 'assignment', 'assignment']);
  assert.deepEqual(again[0].steps_detailed.map((s) => s.output), ['rate1', 'rate2', 'total']);
});

test('routine-group: pipeline groups the recorded step chain and flags it for verification', async () => {
  const buf = await fs.readFile(path.join(here, '..', 'fixtures', 'sample-guideline.pdf'));
  const { job } = await processPdf(buf, {
    filename: 'sample-guideline.pdf',
    recordingPath: path.join(here, '..', 'fixtures', 'recorded', 'step-chain-extract.json'),
  });
  assert.equal(job.routines.length, 1);
  assert.equal(job.routines[0].steps.length, 3);
  assert.deepEqual(job.routines[0].source_pages, [1, 2]);
  assert.ok(job.issues.some((i) =>
    i.target_type === 'routine'
    && /grouped into one 3-step routine/.test(i.message)
    && /verify/.test(i.message)));
  assert.ok(job.issues.every((i) => i.id && i.id.startsWith('V')));
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
});

test('routine-group: multi-statement steps drop their own intermediates from step inputs', () => {
  const routines = normalizeRoutines([
    chainRoutine(1, 'rate1 = base_rate', { inputs: ['base_rate'], outputs: ['rate1'] }),
    {
      ...chainRoutine(2, 'part = rate1 + fee; total = part + tax', { inputs: ['rate1', 'fee', 'part', 'tax'], outputs: ['part', 'total'] }),
    },
  ]);
  const { routines: out } = groupStepRoutines(routines);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].steps_detailed[1].output, 'total');
  assert.deepEqual(out[0].steps_detailed[1].inputs, ['rate1', 'fee', 'tax']);
});
