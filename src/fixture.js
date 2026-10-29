// Offline PDF fixtures: reusable extraction artifacts for tests and local
// development. Loading a fixture never touches the PDF, the model, or any
// API, so it spends no MCU/model credits.
//
// Layout (one directory per PDF; see fixtures/pdf/README.md):
//   fixtures/pdf/<slug>/{manifest.json,pages.json,extraction.json,job.json}
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJobFromExtraction } from './pipeline.js';
import { buildWorkbookXlsx } from './excel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURES_DIR = path.join(here, '..', 'fixtures', 'pdf');

export function fixtureDir(slug, fixturesDir = DEFAULT_FIXTURES_DIR) {
  return path.join(fixturesDir, slug);
}

function assertSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(slug ?? ''))) {
    throw new Error(`Unknown fixture "${String(slug ?? '')}"`);
  }
}

/** Slugs of every saved PDF fixture (directories with a manifest.json). */
export async function listPdfFixtures(fixturesDir = DEFAULT_FIXTURES_DIR) {
  let names;
  try {
    names = await fs.readdir(fixturesDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    try {
      await fs.stat(path.join(fixturesDir, name, 'manifest.json'));
      out.push(name);
    } catch {
      // Not a fixture directory; skip.
    }
  }
  return out.sort();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Load a fixture's saved artifacts directly (no PDF reprocessing, no model).
 * Returns { manifest, pages, extraction, job } where job is the committed
 * snapshot; use buildJobFromFixture() to rebuild it with current code.
 */
export async function loadPdfFixture(slug, fixturesDir = DEFAULT_FIXTURES_DIR) {
  assertSlug(slug);
  const dir = fixtureDir(slug, fixturesDir);
  const [manifest, pagesFile, extraction, job] = await Promise.all([
    readJson(path.join(dir, 'manifest.json')),
    readJson(path.join(dir, 'pages.json')),
    readJson(path.join(dir, 'extraction.json')),
    readJson(path.join(dir, 'job.json')),
  ]);
  return {
    manifest,
    pages: pagesFile?.pages ?? [],
    pageCount: Number(pagesFile?.pageCount ?? manifest?.page_count ?? 0),
    extraction: {
      tables: extraction?.tables ?? [],
      routines: extraction?.routines ?? [],
    },
    job,
  };
}

/**
 * Rebuild a validated job from a fixture's raw extraction with the current
 * deterministic pipeline (normalize -> separate -> expand -> group ->
 * validate). Pure local computation; never calls the model/API.
 */
export async function buildJobFromFixture(slug, fixturesDir = DEFAULT_FIXTURES_DIR) {
  const { manifest, extraction, pageCount } = await loadPdfFixture(slug, fixturesDir);
  return buildJobFromExtraction(extraction, {
    filename: String(manifest?.source_filename ?? 'fixture.pdf'),
    pageCount,
  });
}

/**
 * Regenerate the Excel workbook for a fixture from its raw extraction with
 * current code. Returns { job, xlsx } with no PDF or model involvement.
 */
export async function buildWorkbookFromFixture(slug, fixturesDir = DEFAULT_FIXTURES_DIR) {
  const job = await buildJobFromFixture(slug, fixturesDir);
  const xlsx = buildWorkbookXlsx(job, { source: 'recorded' });
  return { job, xlsx };
}
