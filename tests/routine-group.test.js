import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, createJob, normalizeJob, normalizeVariableKey } from '../src/models.js';
import { groupStepRoutines } from '../src/routine-group.js';
import { buildJobFromExtraction, processPdf } from '../src/pipeline.js';

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

test('routine-group: independent business rules and alternative formulas never join a chain', () => {
  const routines = normalizeRoutines([
    ...syntheticChain(),
    {
      name: 'ALT-ADD: Synthetic alternative composition', kind: 'business_rule', sourcePages: [2],
      evidenceText: 'Synthetic alternative formula for the same composition.',
      expressionText: 'alt_total = base_rate + flat_fee', inputs: ['base_rate', 'flat_fee'], outputs: ['alt_total'],
    },
  ]);
  assert.equal(routines[3].kind, 'formula');
  const { routines: out, groupings } = groupStepRoutines(routines);
  assert.equal(groupings.length, 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'calculation_steps');
  assert.equal(out[0].steps.length, 3);
  assert.equal(out[1].name, 'ALT-ADD: Synthetic alternative composition');
  assert.equal(out[1].kind, 'formula');
});

test('routine-group: forward-reference prerequisite pair groups producer-first under the parent', () => {
  // Distinct unnumbered names (no trailing numbers, so the numbered-chain
  // rule cannot fire): the earlier routine consumes an intermediate the
  // later adjacent routine produces. Live extractions split this shape into
  // two routine entries; the pipeline must restore one parent routine with
  // the prerequisite step ordered first.
  const consumer = {
    name: 'SYN-ALPHA: Synthetic composite valuation',
    kind: 'calculation',
    sourcePages: [1],
    evidenceText: 'Synthetic composite: alpha = base + beta * gamma',
    expressionText: 'alpha = base + beta * gamma',
    inputs: ['base', 'beta', 'gamma'],
    outputs: ['alpha'],
  };
  const producer = {
    name: 'SYN-BETA: Synthetic factor definition',
    kind: 'calculation',
    sourcePages: [2],
    evidenceText: 'Synthetic factor: beta = min(1.0, delta / scale)',
    expressionText: 'beta = min(1.0, delta / scale)',
    inputs: ['delta', 'scale'],
    outputs: ['beta'],
  };
  const { routines, groupings } = groupStepRoutines(normalizeRoutines([consumer, producer]));
  assert.equal(routines.length, 1);
  assert.equal(groupings.length, 1);
  assert.equal(groupings[0].reason, 'prerequisite');
  const [grouped] = routines;
  assert.equal(grouped.kind, 'calculation_steps');
  assert.equal(grouped.name, 'SYN-ALPHA: Synthetic composite valuation');
  assert.deepEqual(grouped.steps, [
    'beta = min(1.0, delta / scale)',
    'alpha = base + beta * gamma',
  ]);
  assert.deepEqual(grouped.steps_detailed.map((s) => s.sequence), [1, 2]);
  assert.deepEqual(grouped.steps_detailed.map((s) => s.output), ['beta', 'alpha']);
  assert.ok(grouped.steps_detailed.every((s) => s.operation === 'assignment' && s.evidence && s.source_pages.length > 0));
  assert.deepEqual([...grouped.inputs].sort(), ['base', 'delta', 'gamma', 'scale']);
  assert.deepEqual([...grouped.outputs], ['alpha']);
  assert.deepEqual(grouped.source_pages, [1, 2]);
  assert.deepEqual(groupings[0].memberNames, [
    'SYN-ALPHA: Synthetic composite valuation',
    'SYN-BETA: Synthetic factor definition',
  ]);
  assert.deepEqual(groupings[0].links[0].variables, ['beta']);
});

test('routine-group: prerequisite grouping flags verification through the pipeline', () => {
  const job = buildJobFromExtraction(
    {
      tables: [],
      routines: [
        {
          name: 'SYN-ALPHA: Synthetic composite valuation', kind: 'calculation',
          source_pages: [1], evidence_text: 'alpha = base + beta',
          expression_text: 'alpha = base + beta', inputs: ['base', 'beta'], outputs: ['alpha'],
        },
        {
          name: 'SYN-BETA: Synthetic factor definition', kind: 'calculation',
          source_pages: [2], evidence_text: 'beta = delta * 2',
          expression_text: 'beta = delta * 2', inputs: ['delta'], outputs: ['beta'],
        },
      ],
    },
    { filename: 'g.pdf', pageCount: 2 }
  );
  assert.equal(job.routines.length, 1);
  assert.equal(job.routines[0].steps.length, 2);
  const warning = job.issues.find((i) => i.target_type === 'routine' && /grouped into one 2-step routine/.test(i.message));
  assert.ok(warning, `expected grouping warning, got: ${job.issues.map((i) => i.message).join(' | ')}`);
  assert.match(warning.message, /consumes "beta" produced by/);
  assert.match(warning.message, /verify/);
  assert.equal(job.issues.filter((i) => i.severity === 'error').length, 0);
});

test('routine-group: worked examples never join a prerequisite chain', () => {
  const formula = (name, expression, inputs, outputs) => ({
    name, kind: 'calculation', sourcePages: [1], evidenceText: `ev: ${expression}`,
    expressionText: expression, inputs, outputs,
  });
  const asProducer = normalizeRoutines([
    formula('SYN-USE: Synthetic consumer', 'alpha = base + beta', ['base', 'beta'], ['alpha']),
    { ...formula('SYN-WORKED: Synthetic illustration', 'beta = 10', [], ['beta']), kind: 'worked_example' },
  ]);
  assert.equal(groupStepRoutines(asProducer).routines.length, 2);
  const asConsumer = normalizeRoutines([
    { ...formula('SYN-WORKED: Synthetic illustration', 'alpha = base + beta', ['base', 'beta'], ['alpha']), kind: 'worked_example' },
    formula('SYN-DEF: Synthetic definition', 'beta = delta * 2', ['delta'], ['beta']),
  ]);
  assert.equal(groupStepRoutines(asConsumer).routines.length, 2);
});

test('routine-group: condition-bearing rules never join a prerequisite chain', () => {
  const routines = normalizeRoutines([
    {
      name: 'SYN-USE: Synthetic consumer', kind: 'calculation', sourcePages: [1],
      evidenceText: 'ev', expressionText: 'alpha = base + beta', inputs: ['base', 'beta'], outputs: ['alpha'],
    },
    {
      name: 'SYN-RULE: Synthetic guarded rule', kind: 'calculation', sourcePages: [1],
      evidenceText: 'ev', expressionText: 'beta = delta * 2', inputs: ['delta'], outputs: ['beta'],
      conditions: ['IF delta is large THEN cap beta.'],
    },
  ]);
  const { routines: out, groupings } = groupStepRoutines(routines);
  assert.equal(out.length, 2);
  assert.equal(groupings.length, 0);
});

test('routine-group: cyclic variable links never group', () => {
  const pair = normalizeRoutines([
    {
      name: 'SYN-FIRST: Synthetic cyclic first', kind: 'calculation', sourcePages: [1],
      evidenceText: 'ev', expressionText: 'exx = why + 1', inputs: ['why'], outputs: ['exx'],
    },
    {
      name: 'SYN-SECOND: Synthetic cyclic second', kind: 'calculation', sourcePages: [1],
      evidenceText: 'ev', expressionText: 'why = exx + 1', inputs: ['exx'], outputs: ['why'],
    },
  ]);
  const { routines: out, groupings } = groupStepRoutines(pair);
  assert.equal(out.length, 2);
  assert.equal(groupings.length, 0);
});

test('routine-group: fixture prerequisite split regroups under the parent routine', async () => {
  // Reproduces the live split shape from the tracked CGL fixture without
  // hardcoding fixture names: finds (structurally) one multi-step routine
  // with an internal producer->consumer step pair, replaces it with two
  // adjacent single-expression routines in consumer-first order, and
  // requires the pipeline to restore one ordered parent routine.
  const fixturePath = path.join(here, '..', 'fixtures', 'pdf', 'commercial-general-liability-rating-manual', 'extraction.json');
  const manifest = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const tables = manifest.tables ?? [];
  const routines = manifest.routines ?? [];
  const key = (v) => normalizeVariableKey(v);
  let found = null;
  for (let idx = 0; idx < routines.length && !found; idx += 1) {
    const steps = (routines[idx].steps ?? []).filter((s) => s && typeof s === 'object');
    for (const producer of steps) {
      for (const consumer of steps) {
        if (producer === consumer) continue;
        const out = String(producer.output ?? '').trim();
        const exprP = String(producer.expression ?? '').trim();
        const exprC = String(consumer.expression ?? '').trim();
        const outC = String(consumer.output ?? '').trim();
        if (!out || !exprP || !exprC || !outC || key(outC) === key(out)) continue;
        if (!(consumer.inputs ?? []).some((v) => key(v) === key(out))) continue;
        found = { idx, producer, consumer };
        break;
      }
      if (found) break;
    }
  }
  assert.ok(found, 'fixture needs a routine with an internal producer/consumer step pair');
  const parent = routines[found.idx];
  const pages = parent.source_pages ?? [1];
  const splitPair = [
    {
      name: `${parent.name} — consumer`,
      kind: 'calculation',
      source_pages: pages,
      evidence_text: String(found.consumer.instruction ?? found.consumer.expression ?? ''),
      expression_text: String(found.consumer.expression ?? ''),
      inputs: [...(found.consumer.inputs ?? [])],
      outputs: [String(found.consumer.output ?? '')],
    },
    {
      name: `${parent.name} — prerequisite`,
      kind: 'calculation',
      source_pages: pages,
      evidence_text: String(found.producer.instruction ?? found.producer.expression ?? ''),
      expression_text: String(found.producer.expression ?? ''),
      inputs: [...(found.producer.inputs ?? [])],
      outputs: [String(found.producer.output ?? '')],
    },
  ];
  const expected = buildJobFromExtraction({ tables, routines }, { filename: 'fixture.pdf', pageCount: 21 });
  const rebuilt = buildJobFromExtraction(
    { tables, routines: [...routines.slice(0, found.idx), ...splitPair, ...routines.slice(found.idx + 1)] },
    { filename: 'fixture.pdf', pageCount: 21 }
  );
  assert.equal(rebuilt.routines.length, expected.routines.length);
  const merged = rebuilt.routines.find((r) => r.name === splitPair[0].name);
  assert.ok(merged, 'split pair must regroup under the consumer parent name');
  assert.equal(merged.kind, 'calculation_steps');
  assert.deepEqual(merged.steps, [splitPair[1].expression_text, splitPair[0].expression_text]);
  assert.deepEqual(merged.steps_detailed.map((s) => s.sequence), [1, 2]);
  const intermediate = key(splitPair[1].outputs[0]);
  assert.ok(!(merged.outputs ?? []).some((v) => key(v) === intermediate), 'intermediate stays a step output, not a routine output');
  assert.ok((merged.inputs ?? []).length > 0 && (merged.outputs ?? []).length > 0);
  const warning = rebuilt.issues.find((i) =>
    i.target_type === 'routine' && String(i.target_id ?? '') === String(merged.id) && /grouped into one 2-step routine/.test(i.message));
  assert.ok(warning, `expected prerequisite grouping warning, got: ${rebuilt.issues.map((i) => i.message).join(' | ')}`);
  assert.match(warning.message, /consumes .* produced by/);
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
