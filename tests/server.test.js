// Server tests invoke the HTTP request listener directly with mock
// req/res objects (this sandbox blocks TCP binding).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const storeDir = path.join(here, '..', 'test-jobs-tmp');

after(async () => {
  await fs.rm(storeDir, { recursive: true, force: true });
});

function listener() {
  const server = createServer({ storeDir, modelEnv: {} });
  return server.listeners('request')[0];
}

function call(handle, { method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = body ? Readable.from([body]) : Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = headers;
    const res = {
      statusCode: 0,
      headersSent: {},
      writeHead(status, responseHeaders) {
        this.statusCode = status;
        this.headersSent = responseHeaders;
      },
      end(payload) {
        resolve({
          status: this.statusCode,
          headers: this.headersSent,
          body: payload ? Buffer.from(payload) : Buffer.alloc(0),
        });
      },
    };
    try {
      handle(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

const json = (r) => JSON.parse(r.body.toString('utf8'));

test('server: health reports model disabled by default', async () => {
  const res = await call(listener(), { method: 'GET', url: '/api/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), { ok: true, modelEnabled: false });
});

test('server: serves review UI', async () => {
  const res = await call(listener(), { method: 'GET', url: '/' });
  assert.equal(res.status, 200);
  assert.match(res.body.toString('utf8'), /RateCraft/);
  assert.match(res.body.toString('utf8'), /Export Excel/);
});

test('server: demo sample flow end to end (offline)', async () => {
  const handle = listener();
  const created = await call(handle, { method: 'POST', url: '/api/demo/sample' });
  assert.equal(created.status, 201);
  const { id, job, source } = json(created);
  assert.equal(source, 'recorded');
  assert.equal(job.tables.length, 2);
  assert.equal(job.routines.length, 4);

  const fetched = await call(handle, { method: 'GET', url: `/api/jobs/${id}` });
  assert.equal(fetched.status, 200);
  assert.equal(json(fetched).job.document.filename, 'sample-guideline.pdf');

  const xlsx = await call(handle, { method: 'GET', url: `/api/jobs/${id}.xlsx` });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers['content-type'], /spreadsheetml/);
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  assert.ok(xlsx.body.length > 1000);
});

test('server: demo flow persists raw extraction beside the job', async () => {
  const handle = listener();
  const created = await call(handle, { method: 'POST', url: '/api/demo/sample' });
  assert.equal(created.status, 201);
  const { id } = json(created);
  const raw = JSON.parse(await fs.readFile(path.join(storeDir, `${id}.extract.json`), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['routines', 'tables']);
  assert.equal(raw.tables.length, 2);
  assert.equal(raw.routines.length, 4);
});

test('server: edits re-validate and unknown jobs 404', async () => {
  const handle = listener();
  const created = await call(handle, { method: 'POST', url: '/api/demo/sample' });
  const { id, job } = json(created);
  const routines = job.routines.map((r) =>
    r.id === 'R4' ? { ...r, expression_text: 'surcharge = base * 0.05' } : r
  );
  const saved = await call(handle, {
    method: 'PUT',
    url: `/api/jobs/${id}`,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ tables: job.tables, routines })),
  });
  assert.equal(saved.status, 200);
  const next = json(saved).job;
  assert.ok(!next.issues.some((i) => i.target_id === 'R4' && /cannot reliably interpret/.test(i.message)));

  const missing = await call(handle, { method: 'GET', url: '/api/jobs/no-such-job' });
  assert.equal(missing.status, 404);
});

test('server: PDF upload without model config returns 409, not a silent stub', async () => {
  const pdf = await fs.readFile(path.join(here, '..', 'fixtures', 'sample-guideline.pdf'));
  const res = await call(listener(), {
    method: 'POST',
    url: '/api/jobs',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'custom.pdf' },
    body: pdf,
  });
  assert.equal(res.status, 409);
  assert.equal(json(res).code, 'MODEL_DISABLED');
});

test('server: upload 409 reports offline ingest details and offline-sample hint', async () => {
  const pdf = await fs.readFile(path.join(here, '..', 'fixtures', 'sample-guideline.pdf'));
  const res = await call(listener(), {
    method: 'POST',
    url: '/api/jobs',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'custom.pdf' },
    body: pdf,
  });
  assert.equal(res.status, 409);
  const body = json(res);
  assert.equal(body.code, 'MODEL_DISABLED');
  assert.ok(body.hint && /offline sample/i.test(body.hint), 'expected hint to point at offline sample');
  assert.ok(body.document, 'expected document ingest details on MODEL_DISABLED');
  assert.equal(body.document.filename, 'custom.pdf');
  assert.equal(body.document.pageCount, 3);
});
