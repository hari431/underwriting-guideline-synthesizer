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
Copy-Item .env.example .env   # then put your Meta API key in .env
npm run verify:model          # one minimal request to confirm auth + model
npm start
```

`UNDERWRITEIQ_MODEL_URL` is the **full** chat-completions endpoint URL (`https://api.meta.ai/v1/chat/completions`), not the base URL. URL/model fall back to the Meta hackathon defaults when unset, so only the flag + key are required. The server loads `.env` automatically; shell exports still work and take precedence. `.env` is gitignored — never commit it.

## Layout

- `src/pdf-extract.js` — text-based PDF ingest, per-page text
- `src/extract.js` — model adapter (disabled by default) + recorded playback
- `src/models.js`, `src/store.js` — data model, file-backed job store
- `src/validate.js` — deterministic validation (unfamiliar formulas warn, never invalidate)
- `src/excel.js` — deterministic `.xlsx` builder (Cover, Tables, Routines, Issues)
- `src/pipeline.js`, `src/server.js`, `public/` — pipeline, local server, review UI
- `fixtures/` — synthetic sample PDF + recorded extraction
- `scripts/make-sample-pdf.js` — regenerates the sample PDF (`npm run sample`)
