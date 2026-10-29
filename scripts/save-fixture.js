// Save a reusable offline fixture for one processed PDF.
//
// Reuses already-saved job artifacts (raw extraction + normalized job) and
// re-extracts the PDF text locally. Never calls the model/API, so saving a
// fixture spends no MCU/model credits.
//
// Usage:
//   node scripts/save-fixture.js --pdf <path> --job <jobId> --name <slug> [--fixtures <dir>]
//
// Layout (generic; one directory per PDF):
//   fixtures/pdf/<slug>/{manifest.json,pages.json,extraction.json,job.json}
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../src/pdf-extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

function arg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return def;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) throw new Error(`Missing value for --${name}`);
  return val;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function main() {
  const pdfPath = arg('pdf');
  const jobId = arg('job');
  let name = arg('name', '');
  const fixturesDir = arg('fixtures', path.join(ROOT, 'fixtures', 'pdf'));
  const jobsDir = arg('jobs', path.join(ROOT, 'jobs'));
  if (!pdfPath) throw new Error('Usage: node scripts/save-fixture.js --pdf <path> --job <jobId> --name <slug>');
  if (!jobId) throw new Error('Missing --job <jobId> (a processed job in jobs/)');
  if (!name) throw new Error('Missing --name <slug> (fixture directory name)');
  name = slugify(name);
  if (!name) throw new Error('Could not derive a fixture name from --name');

  const pdfBuffer = await fs.readFile(pdfPath);
  const { pageCount, pages } = extractPdfText(pdfBuffer);
  const extractionRaw = await fs.readFile(path.join(jobsDir, `${jobId}.extract.json`), 'utf8');
  const jobRaw = await fs.readFile(path.join(jobsDir, `${jobId}.json`), 'utf8');
  const extraction = JSON.parse(extractionRaw);
  const job = JSON.parse(jobRaw);

  const dir = path.join(fixturesDir, name);
  await fs.mkdir(dir, { recursive: true });
  const sha256 = createHash('sha256').update(pdfBuffer).digest('hex');
  const manifest = {
    fixture_format: 1,
    name,
    source_filename: path.basename(pdfPath),
    source_bytes: pdfBuffer.length,
    source_sha256: sha256,
    page_count: pageCount,
    text_chars: pages.reduce((n, p) => n + String(p.text ?? '').length, 0),
    extraction_source: { job_id: jobId, document_filename: String(job?.document?.filename ?? '') },
    artifacts: ['manifest.json', 'pages.json', 'extraction.json', 'job.json'],
    notes: 'Offline fixture: pages.json is local PDF text (no model); extraction.json is the raw extractor output; job.json is the normalized+validated job snapshot used to regenerate the workbook without PDF reprocessing or model/API calls.',
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'pages.json'), JSON.stringify({ pageCount, pages }, null, 2), 'utf8');
  await fs.writeFile(
    path.join(dir, 'extraction.json'),
    JSON.stringify({ tables: extraction?.tables ?? [], routines: extraction?.routines ?? [] }, null, 2),
    'utf8'
  );
  await fs.writeFile(path.join(dir, 'job.json'), `${JSON.stringify(job, null, 2)}\n`, 'utf8');

  const files = await fs.readdir(dir);
  let bytes = 0;
  for (const f of files) bytes += (await fs.stat(path.join(dir, f))).size;
  console.log(`Saved fixture "${name}" (${files.length} files, ${(bytes / 1024).toFixed(1)} KB) to ${dir}`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
