// Minimal local server for the RateCraft demo (zero dependencies).
// Serves the review UI plus a small JSON API. Run: npm start (PORT=3000).
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { processPdf, applyReviewEdits } from './pipeline.js';
import { saveExtraction, saveJob, loadJob, listJobs } from './store.js';
import { buildWorkbookXlsx } from './excel.js';
import { ModelDisabledError, isModelEnabled } from './extract.js';
import { loadDotEnv } from './dotenv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PUBLIC = path.join(ROOT, 'public');
const SAMPLE_PDF = path.join(ROOT, 'fixtures', 'sample-guideline.pdf');
const SAMPLE_RECORDING = path.join(ROOT, 'fixtures', 'recorded', 'sample-extract.json');

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'content-type': contentType, 'content-length': payload.length });
  res.end(payload);
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj));

// Download filename for Excel exports:
// `RateCraft_<upload stem>_<YYYY-MM-DD>.xlsx`. The stem drops a trailing
// `.pdf`, swaps whitespace for underscores, and keeps only filename-safe
// characters, so directory separators, quotes, and control characters from
// the upload name can never reach the Content-Disposition header or the
// filesystem. Empty or unusable names fall back to `Export`.
export function buildExportFilename(originalName, now = new Date()) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const date = [at.getFullYear(), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0')].join('-');
  return `RateCraft_${sanitizeExportStem(originalName)}_${date}.xlsx`;
}

function sanitizeExportStem(originalName) {
  const base = String(originalName ?? '').trim().split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.pdf$/i, '').trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/^[_.]+|[_.]+$/g, '');
  return stem || 'Export';
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function metaPath(storeDir, jobId) {
  return path.join(storeDir, `${jobId}.meta.json`);
}

async function saveMeta(storeDir, jobId, meta) {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(await metaPath(storeDir, jobId), JSON.stringify(meta), 'utf8');
}

async function loadMeta(storeDir, jobId) {
  try {
    return JSON.parse(await fs.readFile(await metaPath(storeDir, jobId), 'utf8'));
  } catch {
    return { source: 'recorded' };
  }
}

export function createServer({ storeDir = path.join(ROOT, 'jobs'), modelEnv = process.env } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return send(res, 200, await fs.readFile(path.join(PUBLIC, 'index.html')), CONTENT_TYPES['.html']);
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, modelEnabled: isModelEnabled(modelEnv) });
      }
      if (req.method === 'GET' && pathname === '/api/jobs') {
        return sendJson(res, 200, { ids: await listJobs(storeDir) });
      }
      if (req.method === 'POST' && pathname === '/api/demo/sample') {
        const pdf = await fs.readFile(SAMPLE_PDF);
        const { job, source, extraction } = await processPdf(pdf, {
          filename: 'sample-guideline.pdf',
          recordingPath: SAMPLE_RECORDING,
        });
        const id = randomUUID();
        await saveJob(storeDir, id, job);
        await saveExtraction(storeDir, id, extraction);
        await saveMeta(storeDir, id, { source });
        return sendJson(res, 201, { id, job, source });
      }
      if (req.method === 'POST' && pathname === '/api/jobs') {
        const pdf = await readBody(req, MAX_PDF_BYTES);
        const filename = String(req.headers['x-filename'] || 'upload.pdf').slice(0, 120);
        const { job, source, extraction } = await processPdf(pdf, { filename, modelOptions: { env: modelEnv } });
        const id = randomUUID();
        await saveJob(storeDir, id, job);
        await saveExtraction(storeDir, id, extraction);
        await saveMeta(storeDir, id, { source });
        return sendJson(res, 201, { id, job, source });
      }
      const jobMatch = /^\/api\/jobs\/([^/]+?)(\.xlsx)?$/.exec(pathname);
      if (jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        if (!/^[A-Za-z0-9-]+$/.test(id)) return sendJson(res, 404, { error: 'Unknown job' });
        if (req.method === 'GET' && jobMatch[2] === '.xlsx') {
          const job = await loadJob(storeDir, id);
          const meta = await loadMeta(storeDir, id);
          const xlsx = buildWorkbookXlsx(job, { source: meta.source ?? 'recorded' });
          res.writeHead(200, {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-length': xlsx.length,
            'content-disposition': `attachment; filename="${buildExportFilename(job?.document?.filename)}"`,
          });
          return res.end(xlsx);
        }
        if (req.method === 'GET' && !jobMatch[2]) {
          const job = await loadJob(storeDir, id);
          const meta = await loadMeta(storeDir, id);
          return sendJson(res, 200, { id, job, source: meta.source ?? 'recorded' });
        }
        if ((req.method === 'PUT' || req.method === 'PATCH') && !jobMatch[2]) {
          const raw = await readBody(req, MAX_JSON_BYTES);
          const edits = JSON.parse(raw.toString('utf8'));
          const job = await loadJob(storeDir, id);
          const next = applyReviewEdits(job, { tables: edits.tables, routines: edits.routines });
          await saveJob(storeDir, id, next);
          const meta = await loadMeta(storeDir, id);
          return sendJson(res, 200, { id, job: next, source: meta.source ?? 'recorded' });
        }
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof ModelDisabledError) {
        const body = {
          error: err.message,
          code: 'MODEL_DISABLED',
          hint: 'Custom PDF extraction needs the live Meta model. Use the offline sample, or set UNDERWRITEIQ_ENABLE_MODEL=1 with API credentials.',
        };
        if (err.details && typeof err.details === 'object') {
          body.document = {
            filename: String(err.details.filename ?? ''),
            pageCount: Number(err.details.pageCount ?? 0),
          };
        }
        return sendJson(res, 409, body);
      }
      if (err && err.code === 'ENOENT') return sendJson(res, 404, { error: 'Unknown job' });
      if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'Invalid JSON body' });
      if (/Not a PDF|No pages|Encrypted PDFs|too large/i.test(err.message || '')) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 500, { error: `Server error: ${err.message}` });
    }
  });
  return server;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  loadDotEnv(path.join(ROOT, '.env'));
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, () => {
    console.log(`RateCraft demo: open http://localhost:${port} in your browser`);
  });
}
