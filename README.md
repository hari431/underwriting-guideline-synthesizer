# RateCraft (hackathon demo)

An AI-powered tool that transforms P&C insurance underwriting guideline PDFs into structured, traceable, Excel-ready requirements for rating and configuration workflows, using Meta AI models.

Demo scope: upload **one** guideline PDF, extract **rating tables** and **rating routines** (formulas, conditions, calculation steps, dependencies) with source-page references and evidence text, review them, and export a traceable **Excel workbook** with validation issues. No rating-engine code generation or platform-specific implementation.

Zero runtime dependencies — Node.js 20+ only.

## Workflow

1. **Upload** — open http://localhost:3000, upload one guideline PDF (`POST /api/jobs`, max 25 MB) or click **Load sample guideline (offline)** (`POST /api/demo/sample`), which replays a recorded extraction with no model call.
2. **Extraction** — the server ingests PDF text per page, runs extraction (live Meta model when enabled, otherwise recorded playback), then runs deterministic local stages: normalize → separate merged grids → expand record columns → infer column metadata → group step routines → validate. The raw extractor output is persisted beside the job (`jobs/<id>.extract.json`) for audit.
3. **Review** — the UI shows Extraction totals, Browse tabs (Tables / Routines with search, filter, pagination), a detail editor per item (titles, headers, cells, steps), and a grouped Review view (one collapsed card per item needing review, each issue shown once with source evidence). **Save edits & re-validate** re-runs deterministic validation only — it never calls the model.
4. **Export** — **Export Excel** downloads `ratecraft-<id>.xlsx`. Export with warnings is allowed; any `error` issue blocks the download until fixed.

Sidebar steps: Upload → Extract → Tables → Routines → Review → Export. Review completion reflects acknowledged/reviewed items, not page visits; editing an item clears its acknowledgement.

## Data model (implemented)

- **Rating tables**: id (`T1…`), name + aliases, `source_pages` + `evidence_text`, ordered headers/columns/rows (every cell preserved as text), plus purpose, applicability, effective period, footnotes, notes, continuation, review status, confidence when the source supports them.
- **Rating routines**: id (`R1…`), name, kind (`formula`, `condition`, `calculation_steps`, `worked_example`; anything else is preserved verbatim and warned about), `source_pages` + `evidence_text`, ordered `steps`/`conditions`/`depends_on` display lists plus structured `steps_detailed`/`conditions_detailed`/`dependencies` records, inputs/outputs, purpose, applicability, execution context, notes, review status, confidence.
- **Worked examples** (`worked_example`) preserve illustrative expected values verbatim in notes/steps for verification; they are never treated as normative definitions and always raise a verification warning.
- **Traceability**: extraction is instructed to include 1-based `source_pages` and verbatim `evidence_text` for every table and routine; steps, conditions, and dependencies carry their own page/location/evidence when stated. Missing page references (and empty tables / pages beyond the document length) are `error` issues; missing evidence text, unfamiliar formula syntax, unresolved dependencies, and all interpretive findings are `warning` issues flagged for review — never silently repaired or treated as invalid.
- **Preservation**: rows, columns, order, blanks, explicit zeroes, negatives, ranges, and special values are kept distinctly; duplicates are retained and flagged, not deduplicated; unknown operators, abbreviations, and undefined variables are kept verbatim and flagged, never invented.

Deterministic helpers (best-effort, strong-evidence-only, each flagged for verification): side-by-side grid separation, single-column `label: value` expansion into key/value or minimum/maximum/value columns, column type/role/unit inference, and grouping of adjacent single-expression routines into one multi-step routine. Ambiguous layouts pass through untouched for the validator to flag.

## Workbook sheets (actual)

Deterministic `.xlsx` build (fixed timestamps; byte-identical for the same job). Sheet order:

1. **Cover** — document name, page count, extraction source (`recorded`/`live`), table/routine/error/warning counts, and linked lists of included tables and routines (each name hyperlinks to its detail sheet).
2. **Table Summary** — one row per table: ID, Title, Aliases, Purpose, Applicability, Effective period, Source pages, Source location, Evidence text, Footnotes, Notes, Continuation, Row count, Column count, Review status. Titles link to the table sheets.
3. **Routine Summary** — one row per routine: ID, Name, Kind, Purpose, Applicability, Execution context, Inputs, Outputs, Expression, Source pages, Source location, Evidence text, Notes, Review status. Names link to the routine sheets.
4. **Table Columns** — one row per column definition: Table ID, Table title, Column #, Original label, Display label, Inferred type, Role, Units, Evidence.
5. **One sheet per rating table** (in job order; safe unique names ≤ 31 chars) — title in A1, header row, then data rows only.
6. **One sheet per routine** (in job order; safe unique names) — name in A1 plus identity details, then:
   - Stepwise routines (has steps or an expression, except `condition` kind): ordered **Steps** (`Step #`, `Instruction`, `Op`, `(`, `Operand`, `)`, `Line Comment`); multi-operator expressions expand to one row per operation with hierarchical numbers (`5.1`, `5.2`); conditionals expand to `IF`/`ELSEIF`/`ELSE`/`ENDIF` rows; steps with no evidenced operation show `REVIEW` in `Op`; worked examples add an **Inputs** block; then **Conditions**, **Unresolved items**, **Source evidence**.
   - `condition` routines and routines with neither steps nor expression (legacy layout): **Inputs**, **Steps**, **Final calculation**, **Conditions**, **Dependencies** (`Target`, `Type`, `Explicit/Inferred`, `Variable / Keys`), **Unresolved items**, **Source evidence**.
7. **Issues** — one row per validation issue: Issue ID, Severity, Target type, Target ID, Message, Source pages.

## Run

```sh
npm start
```

Then open http://localhost:3000 in your browser and click **Load sample guideline (offline)**. `PORT` overrides the default 3000.

## Test

```sh
npm test
```

Runs the full `node --test` suite (models, ingest, extraction routing, validation, Excel builder, pipeline, server, dotenv, fixtures, generic regression cases, and UI workflow/review/export/navigation/theme checks). All tests are offline — no model or API calls.

## Meta model setup (disabled by default)

Live extraction stays **off** until you explicitly enable it (no surprise API calls or billing). Local tests and the sample demo use recorded responses instead of the model.

```sh
Copy-Item .env.example .env   # then put your Meta API key in .env
npm run verify:model          # one minimal request to confirm auth + model
npm start
```

- `UNDERWRITEIQ_ENABLE_MODEL=1` explicitly opts in to Meta API calls; without it (or without a key) uploads fail fast with `409 MODEL_DISABLED` and a hint toward the offline sample — never a silent stub.
- `UNDERWRITEIQ_API_KEY` is sent as `Authorization: Bearer <key>`.
- `UNDERWRITEIQ_MODEL_URL` is the **full** chat-completions endpoint URL (`https://api.meta.ai/v1/chat/completions`), not the base URL; the app POSTs to it directly with `{ model, messages, temperature: 0 }`.
- `UNDERWRITEIQ_MODEL_NAME` defaults to `muse-spark-1.3`. URL/model fall back to these Meta hackathon defaults when unset, so only the flag + key are required.
- The server loads `.env` automatically (`src/dotenv.js`: `KEY=VALUE` lines, `#` comments, optional matching quotes, no expansion; missing file is a no-op); shell exports still work and take precedence. `.env` is gitignored — never commit it.
- `npm run verify:model` sends exactly one minimal `OK`-reply request, exits `2` without any network call when the flag/key is not configured, and never prints the key.

## Fixtures and offline rebuilds (no model credits)

- `fixtures/recorded/*.json` — recorded extractor responses used by the demo and tests.
- `fixtures/pdf/<slug>/{manifest.json,pages.json,extraction.json,job.json}` — saved PDF fixtures (local text, raw extraction, reference job snapshot). See [fixtures/pdf/README.md](fixtures/pdf/README.md).
- `npm run fixture:workbook -- <slug>` (or `node scripts/build-fixture-workbook.js <slug> [out.xlsx]`) regenerates a workbook from a fixture with current code into gitignored `tmp/` — no PDF, no model/API calls.
- `node scripts/save-fixture.js --pdf <path> --job <jobId> --name <slug>` saves a fixture from an already-processed job; saving itself never calls the model.
- `npm run sample` regenerates the synthetic sample PDF (`fixtures/sample-guideline.pdf`).

## Layout

- `src/pdf-extract.js` — text-based PDF ingest, per-page text (text-matrix line breaks, spacing, tab gutters; no table geometry)
- `src/extract.js` — model adapter (disabled by default) + recorded playback
- `src/models.js`, `src/store.js` — data model, file-backed job store (`jobs/<id>.json`, `.extract.json`, `.meta.json`)
- `src/table-split.js`, `src/routine-group.js` — deterministic separation/expansion/grouping (strong evidence only)
- `src/validate.js` — deterministic validation (errors for structural breaks; unfamiliar formulas warn, never invalidate)
- `src/excel.js` — deterministic `.xlsx` builder (Cover, Table Summary, Routine Summary, Table Columns, per-table sheets, per-routine sheets, Issues)
- `src/fixture.js`, `src/dotenv.js` — offline fixture loader, safe `.env` loader
- `src/pipeline.js`, `src/server.js`, `public/` — pipeline, local server, review UI
- `fixtures/` — synthetic sample PDF + recorded extraction + saved PDF fixtures
- `scripts/make-sample-pdf.js` — regenerates the sample PDF (`npm run sample`)
- `scripts/verify-model.js`, `scripts/save-fixture.js`, `scripts/build-fixture-workbook.js` — model check, fixture save/rebuild helpers

## Known limitations

- Text-based PDF ingest only: `src/pdf-extract.js` reads embedded text using text-matrix positions for line breaks, word spaces, and tab markers for wide same-line gutters, but performs no table-geometry or layout analysis, so it cannot tell from cell positions whether two adjacent grids are one table or two. The extraction prompt asks the model to keep independently titled/labelled grids separate, deterministic separation fires only on strong structural evidence, and validation flags suspected merges — but all three are best-effort heuristics over flattened text, not layout fixes. Adjacent-table separation is not claimed fixed until a fresh PDF run confirms it.
- Scanned-image PDFs and encrypted PDFs are out of scope.
- One PDF per run; spreadsheet workbooks are not accepted as upload input (the data model preserves a `source_type` field, but ingest and extraction cover PDFs only).
- Deterministic normalization (grid separation, record expansion, column inference, routine grouping) fires only on strong structural evidence and always adds a verification warning; ambiguous cases pass through untouched for analyst review.
- Live model extraction quality is best-effort and unverified beyond the recorded fixtures and structural tests; every extraction must be reviewed against its source evidence before reuse.
