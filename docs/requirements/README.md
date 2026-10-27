# RateCraft Requirements Reference

These documents define generic expected behavior for rating-table and rating-routine extraction. They are intended to be placed under `docs/requirements/` in the RateCraft repository.

## Files

- `rating-table-requirements.md` — generic table data model, preservation rules, validation, UI/export behavior, and synthetic examples.
- `rating-routine-requirements.md` — generic routine and step model, expressions, lookups, conditions, dependencies, evidence, and export behavior.
- `expected-output-examples.md` — synthetic examples for implementation and regression testing.

## Source and example handling

The uploaded workbooks were used to understand the kinds of structures that need to be supported. The Markdown files intentionally do not reproduce the original rates, factors, identifiers, business names, or routine calculations. Synthetic example values and calculation steps have been changed.

The examples are illustrative only. Production extraction must be grounded in each actual source document and must not hardcode example names, schemas, values, or formulas.

## Suggested repository placement

Copy the three requirements files into:

`docs/requirements/`

This is a requirements reference only; it does not itself change the application's code.
