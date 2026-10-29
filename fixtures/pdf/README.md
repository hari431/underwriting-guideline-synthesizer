# PDF fixtures (offline, no model credits)

One directory per processed PDF. Each fixture preserves everything needed to
re-run the deterministic pipeline and regenerate the workbook **without the
PDF and without model/API calls**:

- `manifest.json` — source filename, byte size, SHA-256, page count, and the
  job the extraction was saved from.
- `pages.json` — local PDF text per page (`{ pageCount, pages }`), so the
  extraction prompt stays rebuildable for audit.
- `extraction.json` — raw extractor output (`{ tables, routines }`)
  exactly as produced, before normalization.
- `job.json` — normalized + validated job snapshot taken when the fixture
  was saved (reference copy; loaders rebuild from `extraction.json`).

## Adding a fixture

Process the PDF once (the only step that may call the model), then save the
already-persisted job artifacts — saving spends no model credits:

```sh
node scripts/save-fixture.js --pdf <path-to-pdf> --job <jobId> --name <slug>
```

`<jobId>` is a processed job in `jobs/` (see `jobs/<id>.json` /
`jobs/<id>.extract.json`). Keep slugs lowercase alphanumeric with dashes.

## Using a fixture

```js
import { buildJobFromFixture, buildWorkbookFromFixture } from './src/fixture.js';

const job = await buildJobFromFixture('<slug>'); // validated job, current code
const { job, xlsx } = await buildWorkbookFromFixture('<slug>'); // + workbook
```

Or regenerate a workbook from the shell (writes gitignored scratch):

```sh
node scripts/build-fixture-workbook.js <slug> [out.xlsx]
npm run fixture:workbook -- <slug>
```

## Size guidance

Fixtures are committed test data: keep each one small (this directory
currently holds only JSON — no PDFs, no workbooks). Regenerate workbooks
into `tmp/` instead of committing them.
