# RateCraft — Underwriting Requirements Extraction & Analyst-Review Tool (hackathon demo)

RateCraft turns P&C insurance underwriting guideline PDFs into structured, traceable Excel requirements. It extracts rating tables and rating routines with source-page references and evidence text, flags what needs a human decision, and exports a review-ready workbook.

Zero runtime dependencies — Node.js 20+ only. Demo scope: one guideline PDF per run. No rating-engine code generation or platform-specific implementation.

## Problem

Underwriting guidelines bury rating logic in long PDFs: rate tables, formulas, conditions, calculation steps, and dependencies. Manually transcribing them into rating or configuration work is slow, error-prone, and hard to trace back to the source page. RateCraft speeds up the first draft and keeps every item linked to its evidence — but the analyst still decides what is correct.

## Key capabilities

- Extracts **rating tables** (headers, rows, cells preserved as text) and **rating routines** (formulas, conditions, calculation steps, dependencies) with 1-based `source_pages` and verbatim `evidence_text`.
- Runs deterministic local checks after extraction: structural breaks are `error` issues, interpretive or uncertain findings are `warning` issues. Errors block Excel export; warnings export with flags.
- Review UI with totals, searchable Tables / Routines tabs, per-item editing, and a grouped Review view (one card per item needing review, each issue shown once with its evidence).
- Traceable Excel workbook with summary sheets, one sheet per table/routine, and an Issues sheet.
- Audit trail: raw extractor output is persisted beside each job (`jobs/<id>.extract.json`).

## Workflow

1. **Upload PDF** — open http://localhost:3000 and upload one guideline PDF (`POST /api/jobs`, max 25 MB), or click **Load sample guideline (offline)** (`POST /api/demo/sample`) to replay a recorded extraction with no model call.
2. **Extract requirements** — the server ingests PDF text per page, runs extraction (live Meta model when enabled, otherwise recorded playback), then deterministic local stages: normalize → separate merged grids → expand record columns → infer column metadata → group step routines → validate.
3. **Review warnings / source evidence** — check Extraction totals, browse and edit tables and routines, then work through the grouped Review view. **Save edits & re-validate** re-runs deterministic validation only — it never calls the model. Editing an item clears its acknowledgement.
4. **Export Excel** — **Export Excel** downloads the workbook. Export with warnings is allowed; any `error` issue blocks the download until fixed.

Sidebar steps: Upload → Extract → Tables → Routines → Review → Export.

## Intended users

- Business analysts and underwriting analysts drafting rating requirements from guideline PDFs.
- Rating / policy-configuration analysts who need a traceable starting point (with source evidence) before entering rules in their own system.
- Hackathon judges evaluating an analyst-in-the-loop extraction demo.

## Accuracy and review expectations

- **Extraction can vary between runs.** Live model output is best-effort and may differ run to run, even with `temperature: 0`.
- **Validation and the Excel build are deterministic for identical raw inputs** (same extractor output plus same edits produces the same issues and the same workbook bytes).
- **Human review is required.** Every extraction must be checked against its source evidence before reuse. RateCraft does not verify that rates are correct and does not replace actuarial, underwriting, or compliance review.

## Excel export

Download filename:

`RateCraft_<OriginalPDFFileName>_<YYYY-MM-DD>.xlsx`

The stem is the uploaded PDF name without `.pdf`, sanitized for header/filesystem safety (whitespace → underscores, unsafe characters → underscores, max 80 chars; falls back to `Export`). The date is the export date. Workbook bytes are deterministic (fixed timestamps; byte-identical for the same job on repeat exports).

Sheets, in order: **Cover** (document, counts, linked table/routine lists), **Table Summary**, **Routine Summary**, **Table Columns**, one sheet per rating table, one sheet per routine (ordered steps/conditions/dependencies plus source evidence), and **Issues** (one row per validation issue).

## Run

```sh
npm start
```

Then open http://localhost:3000 and click **Load sample guideline (offline)**. `PORT` overrides the default 3000.

## Test

```sh
npm test
```

Runs the full offline `node --test` suite (models, ingest, extraction routing, validation, Excel builder, pipeline, server, fixtures, and UI workflow/review/export checks). No model or API calls.

## Meta model setup (disabled by default)

Live extraction stays **off** until you explicitly enable it.

```sh
Copy-Item .env.example .env   # then put your Meta API key in .env
npm run verify:model          # one minimal request to confirm auth + model
npm start
```

- `UNDERWRITEIQ_ENABLE_MODEL=1` opts in to Meta API calls; without it (or without a key) uploads fail fast with `409 MODEL_DISABLED` and a hint toward the offline sample — never a silent stub.
- `UNDERWRITEIQ_API_KEY` is sent as `Authorization: Bearer <key>`.
- `UNDERWRITEIQ_MODEL_URL` is the full chat-completions endpoint URL (`https://api.meta.ai/v1/chat/completions`); the app POSTs `{ model, messages, temperature: 0 }` to it directly.
- `UNDERWRITEIQ_MODEL_NAME` defaults to `muse-spark-1.3`.
- `.env` is gitignored — never commit it. `npm run verify:model` sends one minimal request and never prints the key.

## Current limitations

- Text-based PDF ingest only: embedded text with text-matrix line breaks and spacing, no table-geometry or layout analysis. Adjacent-grid separation is best-effort; suspected merges are flagged, not silently fixed.
- Scanned-image PDFs and encrypted PDFs are out of scope.
- One PDF per run. Deterministic helpers (grid separation, record expansion, column inference, routine grouping) fire only on strong evidence and always add a verification warning; ambiguous cases pass through for analyst review.
- Live extraction quality is unverified beyond the recorded fixtures and structural tests.
