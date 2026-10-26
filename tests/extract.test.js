import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ModelDisabledError,
  buildExtractionPrompt,
  extractWithModel,
  loadRecording,
  parseModelJson,
  runExtraction,
} from '../src/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const recording = path.join(here, '..', 'fixtures', 'recorded', 'sample-extract.json');

test('extract: live model is disabled without explicit flag + key', async () => {
  await assert.rejects(
    extractWithModel([{ page: 1, text: 'x' }], { env: {} }),
    (err) => err instanceof ModelDisabledError
  );
  await assert.rejects(
    extractWithModel([{ page: 1, text: 'x' }], { env: { UNDERWRITEIQ_ENABLE_MODEL: '1' } }),
    /Missing API key/
  );
});

test('extract: live model makes no network call when disabled', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  };
  await assert.rejects(extractWithModel([{ page: 1, text: 'x' }], { env: {}, fetchImpl }));
  assert.equal(calls, 0);
});

test('extract: enabled path posts prompt and parses JSON', async () => {
  let seenUrl = '';
  let seenBody = null;
  const fetchImpl = async (url, opts) => {
    seenUrl = url;
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"tables": [], "routines": []}' } }],
      }),
    };
  };
  const env = {
    UNDERWRITEIQ_ENABLE_MODEL: '1',
    UNDERWRITEIQ_API_KEY: 'test-key',
    UNDERWRITEIQ_MODEL_URL: 'https://model.example/v1/chat',
    UNDERWRITEIQ_MODEL_NAME: 'demo-model',
  };
  const out = await extractWithModel([{ page: 1, text: 'hello' }], { env, fetchImpl });
  assert.equal(seenUrl, 'https://model.example/v1/chat');
  assert.match(seenBody.messages[0].content, /PAGE 1/);
  assert.deepEqual(out, { tables: [], routines: [] });
});

test('extract: prompt requires source pages and evidence text', () => {
  const prompt = buildExtractionPrompt([{ page: 2, text: 'abc' }]);
  assert.match(prompt, /source_pages/);
  assert.match(prompt, /evidence_text/);
  assert.match(prompt, /PAGE 2/);
});

test('extract: parseModelJson strips code fences, rejects bad shapes', () => {
  assert.deepEqual(parseModelJson('```json\n{"tables": [], "routines": []}\n```'), {
    tables: [],
    routines: [],
  });
  assert.throws(() => parseModelJson('nope'), /not valid JSON/);
  assert.throws(() => parseModelJson('{"tables": []}'), /missing tables/);
});

test('extract: recorded response loads for offline tests', async () => {
  const out = await loadRecording(recording);
  assert.equal(out.tables.length, 2);
  assert.equal(out.routines.length, 4);
  assert.ok(out.tables.every((t) => t.source_pages.length > 0 && t.evidence_text));
  assert.ok(out.routines.every((r) => r.source_pages.length > 0 && r.evidence_text));
});

test('extract: runExtraction prefers recording, else enforces disabled error', async () => {
  const viaRecording = await runExtraction([{ page: 1, text: 'x' }], { recordingPath: recording });
  assert.equal(viaRecording.tables.length, 2);
  await assert.rejects(runExtraction([{ page: 1, text: 'x' }], { modelOptions: { env: {} } }), ModelDisabledError);
});
