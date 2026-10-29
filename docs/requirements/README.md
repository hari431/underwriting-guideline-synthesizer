# RateCraft Requirements Reference

These documents define generic expected behavior for rating-table and rating-routine extraction. They live in `docs/requirements/` in the RateCraft repository.

## Files

- `rating-table-requirements.md` — generic table data model, preservation rules, validation, UI/export behavior, and synthetic examples.
- `rating-routine-requirements.md` — generic routine and step model, expressions, lookups, conditions, dependencies, evidence, and export behavior.
- `expected-output-examples.md` — synthetic examples for implementation and regression testing.

## Implementation status key

Each requirement section carries a status so readers can tell what the
current code and tests support:

- **Implemented and verified** — behavior exists in the code and is covered by the test suite.
- **Best-effort** — deterministic heuristics that fire only on strong structural evidence and always flag their output for verification; ambiguous cases pass through untouched.
- **Unverified capability** — the pipeline attempts it (typically via the extraction model), but correctness is not proven beyond fixtures and structural tests; every result must be reviewed against source evidence.
- **Future work** — explicitly out of scope for the current implementation.

When a status is not stated beside a rule, assume **Unverified capability** for model-dependent extraction fidelity and **Implemented and verified** for deterministic handling (normalization, validation, UI, export) as described in that file.

## Source and example handling

Generic example values and calculation shapes in these files are illustrative only. Production extraction must be grounded in each actual source document and must not hardcode example names, schemas, values, or formulas.

These requirements stay generic on purpose: they name no source document, fixture, workbook, rate, factor, identifier, or formula from any real or synthetic input. Tests check structure, source fidelity, ordering, row counts, evidence linkage, and safe handling of ambiguity — never hardcoded answers.

## Scope notes (current implementation)

- Ingest covers text-based PDFs only: one PDF per run. Spreadsheet files are not accepted as upload input; the data model preserves a `source_type` field, but spreadsheet ingest is **Future work**.
- Scanned-image and encrypted PDFs are out of scope.
- Live model extraction is disabled by default and is an **Unverified capability**; recorded fixtures and the deterministic pipeline (normalize, separate, validate, review, export) are **Implemented and verified**.

This is a requirements reference only; it does not itself change the application's code.
