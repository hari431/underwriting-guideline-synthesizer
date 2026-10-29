// Regenerate a fixture workbook locally (no PDF, no model/API calls).
// Usage: node scripts/build-fixture-workbook.js <slug> [out.xlsx]
// Defaults to tmp/<slug>.xlsx (tmp/ is gitignored scratch).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbookFromFixture } from '../src/fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error('Usage: node scripts/build-fixture-workbook.js <slug> [out.xlsx]');
  const out = process.argv[3] || path.join(ROOT, 'tmp', `${slug}.xlsx`);
  const { job, xlsx } = await buildWorkbookFromFixture(slug);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, xlsx);
  console.log(`Wrote ${out} (${xlsx.length} bytes): ${job.tables.length} tables, ${job.routines.length} routines, ${job.issues.length} issues.`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
