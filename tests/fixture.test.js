import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildJobFromFixture, buildWorkbookFromFixture, listPdfFixtures, loadPdfFixture } from '../src/fixture.js';
import { routineSheetNames, tableSheetNames } from '../src/excel.js';

// Offline PDF fixtures: loading and rebuilding never touch the PDF, the
// model, or any API. Assertions stay structural (counts and labels derive
// from the loaded job); no PDF-specific values are hardcoded here.

// Minimal ZIP reader (mirrors tests/excel.test.js).
function readZip(buf) {
  const entries = new Map();
  let pos = 0;
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, (method === 8 ? inflateRawSync(payload) : Buffer.from(payload)).toString('utf8'));
    pos = dataStart + compSize;
  }
  return entries;
}

const unescapeXml = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

function sheetRowsAsValues(sheetXml, stringsXml) {
  const items = [...stringsXml.matchAll(/<si><t xml:space="preserve">(.*?)<\/t><\/si>/gs)].map((m) => unescapeXml(m[1]));
  const rows = [];
  for (const m of sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
    rows.push([...m[2].matchAll(/<c r="[A-Z]+\d+"(?: t="s"(?: s="\d+")?><v>(\d+)<\/v><\/c>|\/>)/g)].map((c) => (c[1] === undefined ? '' : (items[Number(c[1])] ?? ''))));
  }
  return rows;
}

function sectionRows(values, label) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
  if (idx < 0) return null;
  const header = values[idx + 1] ?? [];
  const body = [];
  for (let i = idx + 2; i < values.length; i += 1) {
    if (values[i].length === 1) break;
    body.push(values[i]);
  }
  return { header, body };
}

function blockRows(values, label) {
  const idx = values.findIndex((row) => row.length === 1 && row[0] === label);
  if (idx < 0) return null;
  const body = [];
  for (let i = idx + 1; i < values.length; i += 1) {
    if (values[i].length === 1) break;
    body.push(values[i]);
  }
  return body;
}

const SLUG = 'commercial-property-underwriting-requirements';

test('fixture: saved PDF fixture loads offline with all artifacts', async () => {
  const slugs = await listPdfFixtures();
  assert.ok(slugs.includes(SLUG), `expected saved fixture, got: ${slugs.join(', ')}`);
  const prevFlag = process.env.UNDERWRITEIQ_ENABLE_MODEL;
  const prevKey = process.env.UNDERWRITEIQ_API_KEY;
  delete process.env.UNDERWRITEIQ_ENABLE_MODEL;
  delete process.env.UNDERWRITEIQ_API_KEY;
  try {
    const { manifest, pages, pageCount, extraction, job } = await loadPdfFixture(SLUG);
    assert.equal(manifest.name, SLUG);
    assert.ok(pageCount > 0);
    assert.equal(pages.length, pageCount);
    assert.ok(pages.every((p) => typeof p.text === 'string'));
    assert.ok(extraction.tables.length > 0 && extraction.routines.length > 0);
    assert.ok(job.tables.length > 0 && job.routines.length > 0);
  } finally {
    if (prevFlag !== undefined) process.env.UNDERWRITEIQ_ENABLE_MODEL = prevFlag;
    if (prevKey !== undefined) process.env.UNDERWRITEIQ_API_KEY = prevKey;
  }
});

test('fixture: rebuilt job keeps traceability and resolvable issue targets', async () => {
  const job = await buildJobFromFixture(SLUG);
  for (const t of job.tables) {
    assert.ok(t.source_pages.length > 0, `table ${t.id} needs source pages`);
    assert.ok(String(t.evidence_text ?? '').trim(), `table ${t.id} needs evidence`);
  }
  for (const r of job.routines) {
    assert.ok(r.source_pages.length > 0, `routine ${r.id} needs source pages`);
    assert.ok(String(r.evidence_text ?? '').trim(), `routine ${r.id} needs evidence`);
  }
  const ids = new Set([...job.tables.map((t) => t.id), ...job.routines.map((r) => r.id)]);
  for (const issue of job.issues) {
    if (issue.target_type === 'table' || issue.target_type === 'routine') {
      assert.ok(ids.has(issue.target_id), `issue ${issue.id} targets missing ${issue.target_type} ${issue.target_id}`);
    }
  }
});

test('fixture: regenerated workbook carries sheets, steps, warnings, and evidence', async () => {
  const { job, xlsx } = await buildWorkbookFromFixture(SLUG);
  assert.ok(Buffer.isBuffer(xlsx) && xlsx.length > 1000);
  assert.equal(xlsx.subarray(0, 2).toString('binary'), 'PK');
  const zip = readZip(xlsx);
  const workbook = zip.get('xl/workbook.xml');
  const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  for (const fixed of ['Cover', 'Table Summary', 'Routine Summary', 'Issues']) {
    assert.ok(names.includes(fixed), `workbook missing sheet: ${fixed}`);
  }
  const strings = zip.get('xl/sharedStrings.xml');
  const byName = (name) => {
    const idx = names.indexOf(name);
    assert.ok(idx >= 0, `workbook missing sheet: ${name}`);
    return sheetRowsAsValues(zip.get(`xl/worksheets/sheet${idx + 1}.xml`), strings);
  };
  // One detail sheet per extracted table and routine.
  for (const name of [...tableSheetNames(job.tables), ...routineSheetNames(job.routines, tableSheetNames(job.tables))]) {
    assert.ok(names.includes(name), `workbook missing detail sheet: ${name}`);
  }
  // Routine steps render structured rows (no REVIEW) with source evidence.
  for (const name of routineSheetNames(job.routines, tableSheetNames(job.tables))) {
    const values = byName(name);
    const steps = sectionRows(values, 'Steps');
    assert.ok(steps && steps.body.length > 0, `${name} needs step rows`);
    const opIndex = steps.header.indexOf('Op');
    assert.ok(opIndex >= 0, `${name} steps need an Op column`);
    assert.ok(steps.body.every((row) => row[opIndex] !== 'REVIEW'), `${name} has REVIEW rows: ${JSON.stringify(steps.body)}`);
    const evidence = blockRows(values, 'Source evidence');
    assert.ok(evidence && evidence.some((row) => row[0] === 'Source pages'), `${name} needs source pages evidence`);
  }
  // Every validation issue is exported with its message.
  const issuesIdx = names.indexOf('Issues');
  const issueValues = sheetRowsAsValues(zip.get(`xl/worksheets/sheet${issuesIdx + 1}.xml`), strings);
  const flat = issueValues.map((row) => row.join(' | ')).join('\n');
  for (const issue of job.issues) {
    assert.ok(flat.includes(issue.message), `Issues sheet missing: ${issue.message}`);
  }
});
