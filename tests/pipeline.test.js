import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processPdf, applyReviewEdits } from '../src/pipeline.js';
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
