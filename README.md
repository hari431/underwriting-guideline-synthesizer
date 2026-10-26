# UnderwriteIQ (hackathon demo)

An AI-powered tool that transforms P&C insurance underwriting guideline PDFs into structured, traceable, Excel-ready requirements for rating and configuration workflows, using Meta AI models.

Demo scope: upload **one** guideline PDF, extract **rating tables** and **rating routines** (formulas, conditions, calculation steps, dependencies) with source-page references and evidence text, review them, and export a traceable **Excel workbook** with validation issues. No Gosu generation or Guidewire implementation.

Zero runtime dependencies — Node.js 20+ only.

## Run

```sh
npm start
```

Then open http://localhost:3000 in your browser and click **Load sample guideline (offline)**.

## Test

```sh
npm test
```

## Meta model setup (disabled by default)

Live extraction stays **off** until you explicitly enable it (no surprise API calls or billing). Local tests and the sample demo use the recorded response in `fixtures/recorded/`.

```sh
export UNDERWRITEIQ_ENABLE_MODEL=1
export UNDERWRITEIQ_API_KEY="<key>"
export UNDERWRITEIQ_MODEL_URL="<chat-completions endpoint>"
export UNDERWRITEIQ_MODEL_NAME="<model>"
npm start
```

## Layout

- `src/pdf-extract.js` — text-based PDF ingest, per-page text
- `src/extract.js` — model adapter (disabled by default) + recorded playback
- `src/models.js`, `src/store.js` — data model, file-backed job store
- `src/validate.js` — deterministic validation (unfamiliar formulas warn, never invalidate)
- `src/excel.js` — deterministic `.xlsx` builder (Cover, Tables, Routines, Issues)
- `src/pipeline.js`, `src/server.js`, `public/` — pipeline, local server, review UI
- `fixtures/` — synthetic sample PDF + recorded extraction
- `scripts/make-sample-pdf.js` — regenerates the sample PDF (`npm run sample`)
