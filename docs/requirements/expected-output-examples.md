# Generic Expected Output Examples

## Purpose

This document gives the implementation and test team examples of the structure RateCraft should produce. The examples are synthetic and intentionally use changed names, factor values, and calculation steps. They are not production rating guidance.

## Example 1 — Rating table

### Source-like input (synthetic)

A document contains a table titled “Example Deductible Modifier” with columns for region, deductible band, risk group, and modifier. It has multiple rows and a short footnote stating that the modifier applies to eligible risks during a stated effective period.

### Expected UI behavior

- Show the table title and any stated purpose/applicability.
- Display all source columns and rows in a readable grid.
- Preserve identifiers, numeric precision, and source order.
- Show the source page and supporting evidence.
- Display the footnote and effective period as table metadata.
- Flag unclear units or ambiguous key definitions without guessing.

### Expected Excel behavior

- Export the table metadata separately from its data.
- Export each source row as structured cells/columns, not as a single pipe-separated string.
- Preserve the original column labels and order.
- Retain all rows, including duplicates, while flagging suspected duplicates.
- Include source references and any review issues.

## Example 2 — Rating routine

### Source-like input (synthetic)

A routine initializes a coverage limit, reads an input parameter, looks up a base factor and a modifier using different keys, calculates an intermediate premium, applies another adjustment, and rounds the result. A referenced adjustment is not defined in the available source.

### Expected UI behavior

- Show a routine summary with applicability and execution context when stated.
- Display every operation in source order.
- Make lookup keys, expressions, output variables, and dependencies inspectable.
- Show the undefined adjustment as an unresolved dependency.
- Preserve evidence for each step and indicate which interpretations need review.

### Expected Excel behavior

- Export one row per routine step with sequence, instruction, operation, expression/operand, output, and evidence.
- Export dependencies as separate rows.
- Preserve original numbering and gaps.
- Do not invent the missing adjustment or pretend the routine is fully specified.
- Keep the workbook consistent with the reviewed UI.

## Example 3 — Conditional rule

### Source-like input (synthetic)

“If the selected territory is in the permitted set, use the matching factor; otherwise send the case for manual review.”

### Expected structured output

| Field | Expected content |
|---|---|
| Rule type | Conditional |
| Condition | Selected territory is in the permitted set |
| True branch | Use the matching factor |
| False branch | Refer for manual review |
| Evidence | Exact supporting source text and location |
| Review status | Needs review if the permitted set or matching factor is not fully defined |

## Example 4 — Generalization test

Use a second source with different table titles, different numbers of columns, text-valued lookup keys, a multi-page continuation table, and a routine whose calculation steps are described in prose instead of a numbered grid.

Expected result: RateCraft should use the same generic data model and export rules without requiring code changes or special-casing the source names or values.

## Test principle

Examples define the expected shape and fidelity of extraction, not a list of hardcoded answers. Tests should check structure, source fidelity, ordering, row counts, evidence linkage, and safe handling of ambiguity.
