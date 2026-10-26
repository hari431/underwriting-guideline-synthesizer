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
