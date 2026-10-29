// Deterministic validation for extracted jobs. Pure functions, no model calls.
// Policy: structural/traceability breaks are errors; anything interpretive —
// including unfamiliar formula syntax — is a warning flagged for review.
import { ROUTINE_KINDS, createValidationIssue, definedConstantTerms, findTableCandidates, isLogicalGroupReference, normalizeVariableKey, resolveRoutineReference, resolveTableReference, splitAssignmentSegment, splitHyphenSubtraction, splitTopLevel, tableReferenceTerms } from './models.js';
import { tableHasRecordColumn } from './table-split.js';

export { ROUTINE_KINDS };

const CONDITIONAL_KEYWORDS = /\b(if|then|else|case|when|and|or|not|in)\b/i;
const FORMULA_OPERATORS = /=|[+\-*/%()<>?×÷−·•\[\]{}^∑Σ≤≥≠∈]/;
const FORMULA_ALLOWED_CHARS = /^[A-Za-z0-9_+\-*/().<>=!% \t,?×÷−$;·•\[\]{}^∑Σ≤≥≠∈]+$/;
const FALLBACK_WORDS = /\b(else|otherwise|fallback|refer|decline|exception|default)\b/i;
const BARE_FALLBACK_CLAUSE = /^\s*(else|otherwise|fallback)\b/i;

// Classify a formula expression without ever calling it "invalid":
// 'ok' (reliably interpretable), 'conditional', or 'review' (flag for analyst).
// Currency amounts (`$750.00`) and `;`-separated multi-statement expressions
// are interpretable; each statement must carry its own operator or
// assignment. Colons stay excluded: a `:` inside a formula is either prose
// or a decoding artifact, both for the decoding check and review.
export function classifyFormula(expressionText) {
  const expr = String(expressionText ?? '').trim();
  if (!expr) return 'empty';
  if (!FORMULA_ALLOWED_CHARS.test(expr)) return 'review';
  if (CONDITIONAL_KEYWORDS.test(expr)) return 'conditional';
  if (!balancedParens(expr)) return 'review';
  const statements = splitTopLevel(expr, ';').map((s) => String(s ?? '').trim()).filter(Boolean);
  if (statements.length === 0) return 'review';
  for (const statement of statements) {
    if (!FORMULA_OPERATORS.test(statement)) return 'review';
    const sides = statement.split('=').filter((s) => s.trim());
    if (statement.includes('=') && sides.length < 2) return 'review';
  }
  return 'ok';
}

function balancedParens(expr) {
  const stack = [];
  const pairs = new Map([[')', '('], [']', '['], ['}', '{']]);
  for (const ch of expr) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs.has(ch)) {
      if (stack.pop() !== pairs.get(ch)) return false;
    }
  }
  return stack.length === 0;
}

/**
 * Validate a normalized job. Returns fresh ValidationIssue objects (no IDs;
 * callers assign IDs via normalizeJob or equivalent).
 */
export function validateJob(job) {
  const issues = [];
  const pageCount = job?.document?.page_count ?? 0;
  const tables = job?.tables ?? [];
  const routines = job?.routines ?? [];

  const warn = (targetType, targetId, message, sourcePages) =>
    issues.push(createValidationIssue({ severity: 'warning', targetType, targetId, message, sourcePages }));
  const error = (targetType, targetId, message, sourcePages) =>
    issues.push(createValidationIssue({ severity: 'error', targetType, targetId, message, sourcePages }));

  const checkTraceability = (type, item) => {
    if (item.source_pages.length === 0) {
      error(type, item.id, `${label(type)} "${item.name || item.id}" is missing a source page reference.`, []);
    } else if (pageCount > 0) {
      const bad = item.source_pages.filter((p) => p > pageCount);
      if (bad.length > 0) {
        error(type, item.id, `${label(type)} "${item.name || item.id}" references page(s) ${bad.join(', ')} beyond document length (${pageCount}).`, item.source_pages);
      }
    }
    if (!item.evidence_text || !item.evidence_text.trim()) {
      warn(type, item.id, `${label(type)} "${item.name || item.id}" has no supporting evidence text; verify against the PDF.`, item.source_pages);
    }
  };

  checkDuplicates(tables, 'table', warn);
  checkDuplicates(routines, 'routine', warn);

  for (const table of tables) {
    checkTraceability('table', table);
    const headerCount = (table.headers ?? []).filter((h) => String(h ?? '').trim()).length;
    if (headerCount === 0 && table.rows.length === 0) {
      error('table', table.id, `Table "${table.name || table.id}" is empty (no headers or rows).`, table.source_pages);
    } else if (table.rows.length === 0) {
      warn('table', table.id, `Table "${table.name || table.id}" has headers but no rows.`, table.source_pages);
    } else if (headerCount === 0 && table.rows.length > 0) {
      warn('table', table.id, `Table "${table.name || table.id}" has rows but no column labels; verify the header extraction.`, table.source_pages);
    } else if (headerCount > 0) {
      const ragged = table.rows.filter((r) => r.length !== table.headers.length).length;
      if (ragged > 0) {
        warn('table', table.id, `Table "${table.name || table.id}" has ${ragged} row(s) with column counts differing from headers.`, table.source_pages);
      }
    }
    checkColumnLabels(table, warn);
    checkDuplicateRowsAndConflicts(table, warn);
    checkLeadingZeroIdentifiers(table, warn);
    checkUnclearUnits(table, warn);
    checkMissingKeyOutputValues(table, warn);
    checkInconsistentColumnValues(table, warn);
    checkShortRowMisalignment(table, warn);
    checkUnreferencedSeriesMembers(table, tables, routines, warn);
    checkOverlappingRangeBands(table, warn);
    checkNonNumericOutliers(table, warn);
    checkExplicitMissingMarkers(table, warn);
    checkSuspectedBreakdown(table, warn);
    checkSuspectedMerge(table, warn);
    checkSuspectedRecordMerge(table, warn);
    checkDecodingIntegrity('table', table, warn);
    checkReportedContradictions('table', table, warn);
    checkReportedAmbiguities('table', table, warn);
    checkConfidence('table', table, warn);
  }
  checkSuspectedContinuations(tables, warn);

  const refCtx = buildReferenceContext(tables, routines);
  for (const routine of routines) {
    checkTraceability('routine', routine);
    if (!ROUTINE_KINDS.includes(routine.kind)) {
      warn('routine', routine.id, `Routine "${routine.name || routine.id}" has unrecognized kind "${routine.kind}"; needs review.`, routine.source_pages);
    }
    if (routine.kind === 'formula' && !String(routine.expression_text ?? '').trim()) {
      warn('routine', routine.id, `Formula routine "${routine.name || routine.id}" has no expression text.`, routine.source_pages);
    }
    if (routine.kind === 'condition' && (routine.conditions ?? []).filter((c) => String(c ?? '').trim()).length === 0) {
      warn('routine', routine.id, `Condition routine "${routine.name || routine.id}" has no conditions.`, routine.source_pages);
    }
    if (routine.kind === 'calculation_steps' && (routine.steps ?? []).filter((s) => String(s ?? '').trim()).length === 0) {
      warn('routine', routine.id, `Calculation routine "${routine.name || routine.id}" has no steps.`, routine.source_pages);
    }
    if (routine.kind === 'worked_example') {
      const notes = String(routine.notes ?? '');
      if (/cannot be derived|not derivable|expected value.*(cannot|unable|mismatch|discrepancy)|does not (derive|match|reconcile)/i.test(notes)) {
        const sentences = notes.split(/(?<=[.;\n])\s+/);
        const hit = sentences.find((s) => /cannot be derived|not derivable|expected value|does not (derive|match|reconcile)/i.test(s)) ?? notes;
        warn('routine', routine.id, `Worked example "${routine.name || routine.id}" reports expected values needing verification ("${truncate(hit.trim(), 120)}"); verify they derive from the stated inputs.`, routine.source_pages);
      } else if (notes.trim() || String(routine.evidence_text ?? '').trim()) {
        warn('routine', routine.id, `Worked example "${routine.name || routine.id}" preserves illustrative expected values; verify they derive from the stated inputs before reuse.`, routine.source_pages);
      } else {
        warn('routine', routine.id, `Worked example "${routine.name || routine.id}" has no expected values or evidence; verify against the source.`, routine.source_pages);
      }
    }
    if (String(routine.expression_text ?? '').trim()) {
      const verdict = classifyFormula(routine.expression_text);
      if (verdict === 'review') {
        warn('routine', routine.id, `Expression "${truncate(routine.expression_text)}" uses syntax the validator cannot reliably interpret; flagged for analyst review (not treated as invalid).`, routine.source_pages);
      }
    }
    for (const dep of routine.depends_on ?? []) {
      const target = String(dep ?? '').trim();
      if (target && !isResolvedReference(routine, target, refCtx)) {
        warn('routine', routine.id, unresolvedDependencyMessage(routine, target, refCtx), routine.source_pages);
      }
    }
    checkConditionBranches(routine, warn);
    checkConflictingConditions(routine, warn);
    checkUnstructuredStepConditions(routine, warn);
    checkStepFormulas(routine, warn);
    checkStepExpressionSyntax(routine, warn);
    checkStepsWithoutOperations(routine, warn);
    checkIncompleteStepLogic(routine, warn);
    checkLookupKeys(routine, warn);
    checkConflictingStepDefinitions(routine, warn);
    checkUnusedInputs(routine, warn);
    checkStructuredDependencies(routine, warn, refCtx);
    checkDecodingIntegrity('routine', routine, warn);
    checkReportedContradictions('routine', routine, warn);
    checkReportedAmbiguities('routine', routine, warn);
    checkConfidence('routine', routine, warn);
  }
  checkConflictingRoutineFormulas(routines, warn);
  checkConflictingStepDefinitionsAcrossRoutines(routines, warn);

  return issues;
}

function label(type) {
  return type === 'table' ? 'Table' : 'Routine';
}

function checkDuplicates(items, type, warn) {
  const seen = new Map();
  for (const item of items) {
    const name = (item.name || '').trim().toLowerCase();
    if (!name) continue;
    if (seen.has(name)) {
      warn(type, item.id, `${label(type)} name "${item.name}" is duplicated; check for double extraction.`, item.source_pages);
    } else {
      seen.set(name, true);
    }
  }
}

function checkConfidence(type, item, warn) {
  if (item.confidence != null && Number(item.confidence) < 0.5) {
    warn(type, item.id, `${label(type)} "${item.name || item.id}" has low extraction confidence (${item.confidence}).`, item.source_pages);
  }
}

function checkColumnLabels(table, warn) {
  const headers = table.headers ?? [];
  if (headers.length === 0) return;
  const blanks = headers.filter((h) => !String(h ?? '').trim()).length;
  if (blanks > 0 && table.rows.length > 0) {
    warn('table', table.id, `Table "${table.name || table.id}" has ${blanks} blank column label(s); verify the header extraction.`, table.source_pages);
  }
  const seen = new Map();
  const dups = new Set();
  for (const h of headers) {
    const key = String(h ?? '').trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) dups.add(String(h ?? '').trim());
    else seen.set(key, true);
  }
  if (dups.size > 0) {
    warn('table', table.id, `Table "${table.name || table.id}" has duplicated column label(s): ${[...dups].join(', ')}.`, table.source_pages);
  }
}

function checkDuplicateRowsAndConflicts(table, warn) {
  const rows = table.rows ?? [];
  if (rows.length < 2) return;
  const seen = new Map();
  let dupCount = 0;
  for (const row of rows) {
    const key = JSON.stringify(row);
    const count = seen.get(key) ?? 0;
    if (count >= 1) dupCount += 1;
    seen.set(key, count + 1);
  }
  if (dupCount > 0) {
    warn('table', table.id, `Table "${table.name || table.id}" has ${dupCount} duplicate row(s); retained for review without deduplication.`, table.source_pages);
  }
  const colCount = table.headers?.length ?? 0;
  if (colCount >= 2) {
    const keyToOutputs = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== colCount) continue;
      const key = JSON.stringify(row.slice(0, -1));
      const output = JSON.stringify(row[row.length - 1]);
      if (!keyToOutputs.has(key)) keyToOutputs.set(key, new Set());
      keyToOutputs.get(key).add(output);
    }
    let conflictKeys = 0;
    for (const outputs of keyToOutputs.values()) {
      if (outputs.size > 1) conflictKeys += 1;
    }
    if (conflictKeys > 0) {
      warn('table', table.id, `Table "${table.name || table.id}" has conflicting values for the same apparent lookup key in ${conflictKeys} key group(s); verify against the source.`, table.source_pages);
    }
  }
}

function checkLeadingZeroIdentifiers(table, warn) {
  const rows = table.rows ?? [];
  let example = null;
  for (const row of rows) {
    for (const cell of row ?? []) {
      const s = String(cell ?? '');
      if (/^0\d+$/.test(s)) {
        example = s;
        break;
      }
    }
    if (example) break;
  }
  if (example) {
    warn('table', table.id, `Table "${table.name || table.id}" contains numeric-looking identifiers with leading zeros (e.g., "${example}"); preserved as text — verify no leading zeros were lost.`, table.source_pages);
  }
}

const GENERIC_VALUE_TERMS = /\b(rate|factor|cost|premium|price|amount|charge|fee|modifier|multiplier)\b/i;
const UNITS_INDICATORS = /[$€£¥%‰]|percent|per\s*cent|dollar|\bcents?\b|euro|currency|\bper\b|annual|monthly|yearly|daily|\/year|\/month|\/day|basis\s*point/i;

function checkUnclearUnits(table, warn) {
  const headers = table.headers ?? [];
  const rows = table.rows ?? [];
  if (headers.length === 0 || rows.length === 0) return;
  const headerText = headers.join(' | ');
  const nameText = String(table.name ?? '');
  if (!GENERIC_VALUE_TERMS.test(`${nameText} ${headerText}`)) return;
  const context = [
    nameText,
    headerText,
    String(table.notes ?? ''),
    (table.footnotes ?? []).join(' | '),
    String(table.evidence_text ?? ''),
    (table.columns ?? []).map((c) => String(c?.units ?? '')).join(' | '),
  ].join(' | ');
  if (UNITS_INDICATORS.test(context)) return;
  let hasNumeric = false;
  for (const row of rows) {
    for (const cell of row ?? []) {
      const s = String(cell ?? '').trim().replace(/[$,%\s]/g, '');
      if (s !== '' && !Number.isNaN(Number(s))) {
        hasNumeric = true;
        break;
      }
    }
    if (hasNumeric) break;
  }
  if (!hasNumeric) return;
  warn('table', table.id, `Table "${table.name || table.id}" has unclear units or value semantics; verify currency, percentage, or factor meaning against the source.`, table.source_pages);
}

function checkMissingKeyOutputValues(table, warn) {
  const columns = table.columns ?? [];
  if (columns.length === 0 || (table.rows ?? []).length === 0) return;
  const roleIndexes = [];
  columns.forEach((col, idx) => {
    const role = String(col?.role ?? '').toLowerCase();
    if (/\b(key|lookup|input|output|value|result)\b/.test(role)) {
      roleIndexes.push({ idx, label: String(col?.label ?? col?.original_label ?? `column ${idx + 1}`), role: String(col?.role ?? '') });
    }
  });
  if (roleIndexes.length === 0) return;
  for (const { idx, label, role } of roleIndexes) {
    let blanks = 0;
    for (const row of table.rows) {
      const cell = idx < (row?.length ?? 0) ? String(row[idx] ?? '') : '';
      if (!cell.trim()) blanks += 1;
    }
    if (blanks > 0) {
      warn('table', table.id, `Table "${table.name || table.id}" has ${blanks} missing value(s) in ${role} column "${label}"; verify against the source.`, table.source_pages);
    }
  }
}

function parseGenericNumber(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[$€£¥,%\s]/g, '').replace(/,/g, '');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function checkInconsistentColumnValues(table, warn) {
  const rows = table.rows ?? [];
  const colCount = table.headers?.length ?? 0;
  if (rows.length < 2 || colCount === 0) return;
  for (let c = 0; c < colCount; c += 1) {
    const label = String(table.headers[c] ?? `column ${c + 1}`);
    let blanks = 0;
    let filled = 0;
    const nums = [];
    for (const row of rows) {
      // Only explicit empty cells count as column blanks. Cells missing
      // because the row is short carry no column attribution: the gap may
      // sit anywhere in the row (short rows get their own misalignment
      // warning), so blaming the trailing column would mislead.
      if (!Array.isArray(row) || c >= row.length) continue;
      const cell = String(row[c] ?? '');
      if (!cell.trim()) blanks += 1;
      else filled += 1;
      const n = parseGenericNumber(cell);
      if (n !== null) nums.push(n);
    }
    if (blanks > 0 && filled > 0 && blanks <= filled) {
      warn('table', table.id, `Table "${table.name || table.id}" has blank cell(s) in column "${label}" where other rows have values; verify against the source.`, table.source_pages);
    }
    if (nums.length >= 3) {
      const hasNeg = nums.some((n) => n < 0);
      const hasPos = nums.some((n) => n > 0);
      if (hasNeg && hasPos) {
        warn('table', table.id, `Table "${table.name || table.id}" has mixed negative and positive values in column "${label}"; verify against the source (not assumed wrong).`, table.source_pages);
      }
    }
  }
}

// A coded series member nothing uses: within one column, whole-cell codes
// sharing a letter prefix with numeric suffixes (`RID-001` … `RID-008`)
// form a series when at least three are present. A member warns only when
// it is referenced nowhere while at least three siblings co-occur in one
// routine step or routine-level expression: the step enumerates the series
// with this member skipped, so the omission may be intentional (an
// excluded member) or a dropped row — either way it needs analyst eyes,
// and the warning never judges which. Siblings scattered across unrelated
// steps stay silent, so partially used lookup keys never spam. Notes,
// evidence, names, and headers never count as references (commentary and
// labels are not uses), and the member's own cell never self-matches.
// Generic code shapes, never cell values.
const SERIES_CODE = /^([A-Z]+[-_.]?)(\d+)$/;
const SERIES_COOCCURRENCE = 3;

function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boundedCode(code) {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(code)}(?![A-Za-z0-9])`, 'i');
}

function routineStructuralUnits(routine) {
  const units = [];
  const stepTexts = [];
  for (const step of routine.steps_detailed ?? []) {
    stepTexts.push([step?.instruction, step?.expression, step?.operand, step?.output, ...(step?.inputs ?? []), ...(step?.depends_on ?? [])]
      .map((v) => String(v ?? '')).join('\n'));
  }
  units.push(...stepTexts);
  units.push([
    ...(routine.inputs ?? []), ...(routine.outputs ?? []), routine.expression_text,
    ...(routine.depends_on ?? []), ...(routine.dependencies ?? []).map((d) => d?.target),
  ].map((v) => String(v ?? '')).join('\n'));
  const conditionTexts = [
    ...(routine.conditions ?? []).map((c) => (typeof c === 'string' ? c : c?.condition)),
    ...(routine.conditions_detailed ?? []).flatMap((d) => [d?.condition, d?.true_branch, d?.false_branch, d?.referral_code]),
  ].map((v) => String(v ?? ''));
  if (conditionTexts.some((t) => t.trim())) units.push(conditionTexts.join('\n'));
  return units;
}

function isCodeReferenced(code, self, tables, routineUnits) {
  const bounded = boundedCode(code);
  if (routineUnits.some((units) => units.some((text) => bounded.test(text)))) return true;
  for (const table of tables) {
    for (const [rowIdx, row] of (table.rows ?? []).entries()) {
      for (const [colIdx, cell] of (row ?? []).entries()) {
        if (table.id === self.tableId && rowIdx === self.rowIdx && colIdx === self.colIdx) continue;
        if (bounded.test(String(cell ?? ''))) return true;
      }
    }
  }
  return false;
}

function checkUnreferencedSeriesMembers(table, tables, routines, warn) {
  const rows = table.rows ?? [];
  const colCount = table.headers?.length ?? 0;
  if (rows.length === 0 || colCount === 0) return;
  const routineUnits = (routines ?? []).map(routineStructuralUnits);
  for (let c = 0; c < colCount; c += 1) {
    const byPrefix = new Map();
    rows.forEach((row, rowIdx) => {
      if (!Array.isArray(row) || c >= row.length) return;
      const cell = String(row[c] ?? '').trim();
      const m = SERIES_CODE.exec(cell);
      if (!m) return;
      const prefix = m[1];
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Map());
      const members = byPrefix.get(prefix);
      if (!members.has(cell)) members.set(cell, { tableId: table.id, rowIdx, colIdx: c });
    });
    for (const [prefix, members] of byPrefix) {
      if (members.size < 3) continue;
      const codes = [...members.keys()];
      const patterns = new Map(codes.map((code) => [code, boundedCode(code)]));
      const referenced = codes.filter((code) => isCodeReferenced(code, members.get(code), tables, routineUnits));
      if (referenced.length === 0) continue;
      const label = String(table.headers[c] ?? `column ${c + 1}`);
      for (const code of codes) {
        if (referenced.includes(code)) continue;
        const siblings = codes.filter((other) => other !== code && referenced.includes(other));
        const enumerated = routineUnits.some((units) => units.some((text) =>
          siblings.filter((sibling) => patterns.get(sibling).test(text)).length >= SERIES_COOCCURRENCE));
        if (!enumerated) continue;
        warn('table', table.id, `Table "${table.name || table.id}" lists "${code}" in column "${label}" but no routine references it while ${referenced.length} of ${codes.length} "${prefix}" codes are used; verify whether the omission is intended.`, table.source_pages);
      }
    }
  }
}

// A row shorter than the headers maps values to columns positionally, so
// any value after the gap may sit under the wrong header: the gap itself
// may be medial, not trailing. Warn per short row (capped) without
// claiming which column lost the value. Generic shape, never cell values.
function checkShortRowMisalignment(table, warn) {
  const rows = table.rows ?? [];
  const colCount = table.headers?.length ?? 0;
  if (colCount === 0) return;
  const short = [];
  rows.forEach((row, idx) => {
    if (Array.isArray(row) && row.length < colCount) short.push({ idx: idx + 1, cells: row.length });
  });
  if (short.length === 0) return;
  for (const { idx, cells } of short.slice(0, 3)) {
    warn('table', table.id, `Table "${table.name || table.id}" row ${idx} has ${cells} value(s) for ${colCount} columns; verify which column each value belongs to — values after a gap may sit under the wrong header.`, table.source_pages);
  }
  if (short.length > 3) {
    warn('table', table.id, `Table "${table.name || table.id}" has ${short.length - 3} more short row(s); verify each row's column mapping against the source.`, table.source_pages);
  }
}

// Parse one range-band cell (`$5,001 to $10,000`, `25-55`, `Class 9`) into
// { min, max } (equal for single values) or null when the cell is not
// purely one range or single value. Currency, commas, and percents are
// accepted; surrounding label words are allowed, but extra numbers or a
// missing `to`/dash separator reject the cell.
const RANGE_AMOUNT = '[$€£¥]?\\s*\\d[\\d,]*(?:\\.\\d+)?\\s*%?';

function rangeAmountValue(token) {
  const cleaned = String(token ?? '').replace(/[$€£¥,%\s]/g, '').replace(/,/g, '');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseRangeBand(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const matches = [...s.matchAll(new RegExp(RANGE_AMOUNT, 'g'))];
  if (matches.length === 1) {
    const rest = (s.slice(0, matches[0].index) + s.slice(matches[0].index + matches[0][0].length)).trim();
    if (/\d/.test(rest)) return null;
    const v = rangeAmountValue(matches[0][0]);
    return v === null ? null : { min: v, max: v };
  }
  if (matches.length === 2) {
    const between = s.slice(matches[0].index + matches[0][0].length, matches[1].index);
    if (!/(?:\bto\b|-|–|—)/i.test(between)) return null;
    const rest = (s.slice(0, matches[0].index) + between.replace(/(?:\bto\b|-|–|—)/gi, ' ') + s.slice(matches[1].index + matches[1][0].length)).trim();
    if (/\d/.test(rest)) return null;
    const a = rangeAmountValue(matches[0][0]);
    const b = rangeAmountValue(matches[1][0]);
    if (a === null || b === null) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return null;
}

// Overlapping range bands in a band column: two bands covering a common
// value read as contradictory lookup keys. Structural and conservative:
// the column needs at least two genuine ranges (min < max), every
// non-blank cell must parse (columns mixing ranges with `Any` or open
// forms are skipped), and single values never overlap each other — only
// range-vs-range (or range-vs-point) overlaps warn, naming the source
// cells verbatim.
function checkOverlappingRangeBands(table, warn) {
  const rows = table.rows ?? [];
  const colCount = table.headers?.length ?? 0;
  if (rows.length < 2 || colCount === 0) return;
  for (let c = 0; c < colCount; c += 1) {
    const label = String(table.headers[c] ?? `column ${c + 1}`);
    const bands = [];
    let strict = true;
    rows.forEach((row, idx) => {
      const cell = c < (row?.length ?? 0) ? String(row[c] ?? '') : '';
      if (!cell.trim()) return;
      const parsed = parseRangeBand(cell);
      if (!parsed) {
        strict = false;
        return;
      }
      bands.push({ idx, cell: cell.trim(), ...parsed });
    });
    if (!strict) continue;
    const ranges = bands.filter((b) => b.min < b.max);
    if (ranges.length < 2) continue;
    let warned = false;
    for (let i = 0; i < bands.length && !warned; i += 1) {
      for (let j = i + 1; j < bands.length; j += 1) {
        const a = bands[i];
        const b = bands[j];
        if (a.min === a.max && b.min === b.max) continue;
        if (a.min > b.max || b.min > a.max) continue;
        const lo = Math.max(a.min, b.min);
        const hi = Math.min(a.max, b.max);
        const coverage = lo === hi ? `both cover ${lo}` : `both cover ${lo} to ${hi}`;
        warn('table', table.id, `Table "${table.name || table.id}" has overlapping range bands in column "${label}" ("${truncate(a.cell, 40)}" and "${truncate(b.cell, 40)}" ${coverage}); verify the boundary against the source.`, table.source_pages);
        warned = true;
        break;
      }
    }
  }
}

// Non-numeric values inside an otherwise-numeric column (`Terminate Rating`
// among multipliers): the odd rows may carry a disposition or rejection
// instead of a lookup result. Warns only when numerics clearly dominate
// (at least three, and at least twice the non-numeric count), quoting the
// source values verbatim without judging them wrong.
function checkNonNumericOutliers(table, warn) {
  const rows = table.rows ?? [];
  const colCount = table.headers?.length ?? 0;
  if (rows.length < 4 || colCount === 0) return;
  for (let c = 0; c < colCount; c += 1) {
    const label = String(table.headers[c] ?? `column ${c + 1}`);
    let numeric = 0;
    const odd = [];
    const seen = new Set();
    for (const row of rows) {
      const cell = c < (row?.length ?? 0) ? String(row[c] ?? '') : '';
      if (!cell.trim()) continue;
      if (parseGenericNumber(cell) !== null) {
        numeric += 1;
        continue;
      }
      if (!seen.has(cell.trim())) {
        seen.add(cell.trim());
        odd.push(cell.trim());
      }
    }
    if (odd.length === 0 || numeric < 3 || numeric < odd.length * 2) continue;
    const quoted = odd.slice(0, 3).map((v) => `"${truncate(v, 40)}"`).join(', ');
    const more = odd.length > 3 ? ` and ${odd.length - 3} more` : '';
    warn('table', table.id, `Table "${table.name || table.id}" has non-numeric value(s) (${quoted}${more}) in otherwise-numeric column "${label}"; verify against the source.`, table.source_pages);
  }
}

// Explicit missing-value markers (`[NOT SPECIFIED]`, `N/A`, `TBD`) in data
// cells: the source leaves the value unpopulated. Flagged in any table size
// (unlike statistical outliers), quoting the marker verbatim. Standalone
// "None" is a legitimate "no adjustment" value in rating tables, never a
// missing marker, so it stays silent. Generic marker phrases, never values.
const EXPLICIT_MISSING_MARKER = /^\[?\s*(not specified|n\/a|\bna\b|tbd|to be determined|missing|unknown|not available|unpopulated)\s*\]?$/i;

function checkExplicitMissingMarkers(table, warn) {
  const rows = table.rows ?? [];
  const colCount = table.headers?.length ?? 0;
  if (rows.length === 0 || colCount === 0) return;
  const hits = [];
  const seen = new Set();
  rows.forEach((row, idx) => {
    for (let c = 0; c < colCount; c += 1) {
      const cell = c < (row?.length ?? 0) ? String(row[c] ?? '') : '';
      const trimmed = cell.trim();
      if (!trimmed || !EXPLICIT_MISSING_MARKER.test(trimmed)) continue;
      if (/^none$/i.test(trimmed)) continue;
      const key = `${c}:${trimmed.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ row: idx + 1, col: c, label: String(table.headers[c] ?? `column ${c + 1}`), cell: trimmed });
      if (hits.length >= 3) break;
    }
    if (hits.length >= 3) return;
  });
  for (const hit of hits) {
    warn('table', table.id, `Table "${table.name || table.id}" marks row ${hit.row} column "${hit.label}" as "${truncate(hit.cell, 40)}" (value not populated in source); verify before reuse.`, table.source_pages);
  }
}

// Uncertain text decoding: Unicode replacement or control characters, or
// a colon inside a number that is not clock time (`1:0`, `$750:00` —
// decimal points the extractor misread). Times (`10:30`) never match.
// Scans every analyst-visible field once per table/routine and quotes the
// suspect snippet verbatim, so corrupted values are flagged rather than
// silently accepted. Generic character shapes, never field contents.
const DECODING_FFFD = String.fromCharCode(0xfffd);
const DECODING_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function suspectColonNumber(text) {
  const re = /\d+:\d+/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    if (/^\d{1,2}:\d{2}$/.test(m[0])) continue;
    return m[0];
  }
  return null;
}

function decodingEvidence(label, value) {
  const s = String(value ?? '');
  if (!s) return null;
  const fffdAt = s.indexOf(DECODING_FFFD);
  if (fffdAt >= 0) {
    return { label, snippet: s.slice(Math.max(0, fffdAt - 20), fffdAt + 20) };
  }
  if (DECODING_CONTROL_CHARS.test(s)) {
    const m = DECODING_CONTROL_CHARS.exec(s);
    const at = m ? m.index : 0;
    return { label, snippet: s.slice(Math.max(0, at - 20), at + 20) };
  }
  const colon = suspectColonNumber(s);
  if (colon) {
    const at = s.indexOf(colon);
    return { label, snippet: s.slice(Math.max(0, at - 20), at + colon.length + 20) };
  }
  return null;
}

function checkDecodingIntegrity(type, item, warn) {
  const fields = [];
  if (type === 'table') {
    fields.push(['name', item.name]);
    (item.headers ?? []).forEach((h, i) => fields.push([`header ${i + 1}`, h]));
    (item.rows ?? []).forEach((row, i) => {
      (row ?? []).forEach((cell, j) => fields.push([`row ${i + 1} column ${j + 1}`, cell]));
    });
    fields.push(['purpose', item.purpose], ['applicability', item.applicability]);
    fields.push(['notes', item.notes], ['evidence', item.evidence_text]);
    (item.footnotes ?? []).forEach((f, i) => fields.push([`footnote ${i + 1}`, f]));
  } else {
    fields.push(['name', item.name]);
    fields.push(['expression', item.expression_text]);
    (item.steps ?? []).forEach((s, i) => fields.push([`step ${stepSeq({ sequence: i + 1 }, i)}`, typeof s === 'string' ? s : (s?.instruction ?? '')]));
    (item.steps_detailed ?? []).forEach((d, i) => {
      const tag = `step ${stepSeq(d, i)}`;
      fields.push([`${tag} instruction`, d?.instruction], [`${tag} expression`, d?.expression]);
      fields.push([`${tag} operand`, d?.operand], [`${tag} evidence`, d?.evidence]);
    });
    (item.conditions ?? []).forEach((c, i) => fields.push([`condition ${i + 1}`, typeof c === 'string' ? c : (c?.condition ?? '')]));
    fields.push(['notes', item.notes], ['evidence', item.evidence_text]);
    fields.push(['purpose', item.purpose], ['applicability', item.applicability]);
  }
  for (const [field, value] of fields) {
    const hit = decodingEvidence(field, value);
    if (hit) {
      warn(type, item.id, `${field === 'name' ? `${label(type)} "${item.name || item.id}"` : `${label(type)} "${item.name || item.id}" ${hit.label}`} has text suggesting uncertain decoding ("${truncate(String(hit.snippet ?? '').replace(/\s+/g, ' ').trim(), 60)}"); verify the characters against the source.`, item.source_pages);
      return;
    }
  }
}

// Contradictions the extraction itself reports in notes (`conflicting
// alternative formula ... flagged as conflict`): surface them as issues
// quoting the reporting sentence, without choosing a winner. Only
// conflict-family wording counts; ordinary review notes stay silent.
const CONTRADICTION_MARKERS = /\bconflicts?\b|\bconflicting\b|\bconflicted\b|\bcontradict(?:s|ed|ion|ory)?\b|\binconsisten(?:t|cy|cies)\b/i;

function checkReportedContradictions(type, item, warn) {
  const notes = String(item?.notes ?? '');
  if (!notes || !CONTRADICTION_MARKERS.test(notes)) return;
  const sentences = notes.split(/(?<=[.;\n])\s+/);
  const hits = sentences.filter((s) => CONTRADICTION_MARKERS.test(s));
  for (const hit of (hits.length > 0 ? hits.slice(0, 3) : [notes])) {
    warn(type, item.id, `${label(type)} "${item.name || item.id}" notes report a possible contradiction ("${truncate(hit.trim(), 120)}"); verify which definition applies — flagged without choosing one.`, item.source_pages);
  }
}

// Ambiguities the extraction itself flags in notes (`FLAG FOR REVIEW: X is
// undefined ...`, `flag overlapping boundary ...`): surface them as issues
// quoting the reporting sentence. Requires the model's own flagging verb
// plus an ambiguity term, so ordinary descriptive notes stay silent.
const AMBIGUITY_FLAG = /\bflag\b/i;
const AMBIGUITY_TERMS = /\bundefined\b|\bnot defined\b|\bno .* defines\b|\boverlapping\b|\bcollision\b|\bboundary\b|\bmissing\b|\bambiguous\b|\bambiguity\b|\bnot specified\b|\bgap\b/i;

function checkReportedAmbiguities(type, item, warn) {
  const notes = String(item?.notes ?? '');
  if (!notes || !AMBIGUITY_FLAG.test(notes) || !AMBIGUITY_TERMS.test(notes)) return;
  const sentences = notes.split(/(?<=[.;\n])\s+/);
  const hits = sentences.filter((s) => AMBIGUITY_FLAG.test(s) && AMBIGUITY_TERMS.test(s));
  const fallback = hits.length > 0 ? hits : sentences.filter((s) => AMBIGUITY_TERMS.test(s));
  for (const hit of (fallback.length > 0 ? fallback.slice(0, 3) : [notes])) {
    warn(type, item.id, `${label(type)} "${item.name || item.id}" notes flag a possible gap ("${truncate(hit.trim(), 140)}"); verify against the source — flagged without inventing a value.`, item.source_pages);
  }
}

function checkSuspectedContinuations(tables, warn) {
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i];
      const b = tables[j];
      if (!a.headers?.length || !b.headers?.length) continue;
      if (a.headers.length !== b.headers.length) continue;
      const same = a.headers.every((h, idx) => String(h ?? '').trim().toLowerCase() === String(b.headers[idx] ?? '').trim().toLowerCase());
      if (!same) continue;
      warn('table', b.id, `Table "${b.name || b.id}" has identical column labels to table "${a.name || a.id}" (${a.id}); check for a multi-page or multi-sheet continuation.`, b.source_pages);
    }
  }
}

// A row labeled as a total whose value equals the sum of the same column
// over the other rows is the signature of a worked illustration computed
// for one instance, not reusable lookup data. Conservative: the warning
// requires both the generic total label and the arithmetic confirmation,
// so ordinary multi-key tables and coded lists never match.
const TOTAL_ROW_LABEL = /^\s*(grand\s+)?(sub\s*)?totals?\s*$/i;

function firstNonBlankCell(row) {
  for (const cell of row ?? []) {
    const s = String(cell ?? '').trim();
    if (s) return s;
  }
  return '';
}

function checkSuspectedBreakdown(table, warn) {
  const rows = table.rows ?? [];
  if (rows.length < 2) return;
  rows.forEach((row, idx) => {
    const label = firstNonBlankCell(row);
    if (!TOTAL_ROW_LABEL.test(label)) return;
    const width = Math.max(table.headers?.length ?? 0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
    for (let c = 0; c < width; c += 1) {
      const total = parseGenericNumber(row?.[c]);
      if (total === null) continue;
      let sum = 0;
      let count = 0;
      let clean = true;
      for (let i = 0; i < rows.length; i += 1) {
        if (i === idx) continue;
        const cell = c < (rows[i]?.length ?? 0) ? String(rows[i][c] ?? '') : '';
        const n = parseGenericNumber(cell);
        if (cell.trim() === '' || n === null) {
          clean = false;
          break;
        }
        sum += n;
        count += 1;
      }
      if (!clean || count < 2) continue;
      const tolerance = 0.005 * count + 1e-9 * Math.abs(total);
      if (Math.abs(sum - total) <= tolerance) {
        warn('table', table.id, `Table "${table.name || table.id}" looks like an instance-specific computed breakdown rather than a reusable rating table (data row ${idx + 1} "${label}" matches the column sum); verify before reuse.`, table.source_pages);
        return;
      }
    }
  });
}

function isBlankRow(row) {
  return (row ?? []).every((c) => !String(c ?? '').trim());
}

// Structural signatures of two adjacent independent grids merged into one
// table: a blank row or column with data on both sides, a repeated header
// row, or an embedded single-value row. Each warns at most once per table.
// Conservative: edge blanks never warn, and the repeated-header signal needs
// at least two matching labels, so ordinary tables never match.
function checkSuspectedMerge(table, warn) {
  const rows = table.rows ?? [];
  if (rows.length === 0) return;
  const name = `"${table.name || table.id}"`;
  const nonBlank = rows.map((r) => !isBlankRow(r));
  const first = nonBlank.indexOf(true);
  const last = nonBlank.lastIndexOf(true);
  for (let i = first + 1; i < last; i += 1) {
    if (!nonBlank[i]) {
      warn('table', table.id, `Table ${name} has a blank data row (${i + 1}) separating data on both sides; verify adjacent tables were not merged into one.`, table.source_pages);
      break;
    }
  }
  const width = Math.max(table.headers?.length ?? 0, ...rows.map((r) => r?.length ?? 0));
  const colHasData = [];
  for (let c = 0; c < width; c += 1) {
    const headerFilled = String(table.headers?.[c] ?? '').trim() !== '';
    const cellFilled = rows.some((r) => String(r?.[c] ?? '').trim() !== '');
    colHasData.push(headerFilled || cellFilled);
  }
  const cFirst = colHasData.indexOf(true);
  const cLast = colHasData.lastIndexOf(true);
  for (let c = cFirst + 1; c < cLast; c += 1) {
    if (!colHasData[c]) {
      warn('table', table.id, `Table ${name} has a blank column (column ${c + 1}) separating data on both sides; verify adjacent tables were not merged into one.`, table.source_pages);
      break;
    }
  }
  const headerKeys = (table.headers ?? []).map((h) => String(h ?? '').trim().toLowerCase());
  if (headerKeys.filter(Boolean).length >= 2) {
    const repeated = rows.findIndex((row) => {
      if (isBlankRow(row)) return false;
      const w = Math.max(headerKeys.length, row?.length ?? 0);
      for (let c = 0; c < w; c += 1) {
        if (String(row?.[c] ?? '').trim().toLowerCase() !== (headerKeys[c] ?? '')) return false;
      }
      return true;
    });
    if (repeated >= 0) {
      warn('table', table.id, `Table ${name} repeats its column labels in data row ${repeated + 1}; verify adjacent tables were not merged into one.`, table.source_pages);
    }
  }
  if (width >= 2) {
    for (let i = first + 1; i < last; i += 1) {
      if (isBlankRow(rows[i])) continue;
      const filled = (rows[i] ?? []).filter((c) => String(c ?? '').trim() !== '');
      if (filled.length === 1) {
        warn('table', table.id, `Table ${name} has an embedded single-value data row (${i + 1}, "${truncate(String(filled[0]), 40)}") with data on both sides; verify adjacent tables or sections were not merged into one.`, table.source_pages);
        break;
      }
    }
  }
}

// A column whose every value embeds its own key ("label: value") is a
// self-contained record: the signature of an independent grid flattened into
// one column. When such a column still sits beside other columns, adjacent
// grids may have been merged into one table. A single record column that
// survived expansion is ambiguous flattened text, not a confident split, so
// it is flagged on its own terms. Times, ratios, and schemes never count as
// embedded keys (see table-split.js).
function checkSuspectedRecordMerge(table, warn) {
  const rows = table.rows ?? [];
  const width = Math.max(table.headers?.length ?? 0, ...rows.map((r) => r?.length ?? 0));
  if (!tableHasRecordColumn(table)) return;
  if (width < 2) {
    warn('table', table.id, `Table "${table.name || table.id}" is a single column of "label: value" text that could not be confidently split into key/value columns; verify against the source.`, table.source_pages);
    return;
  }
  warn('table', table.id, `Table "${table.name || table.id}" has column(s) whose values each embed their own key (e.g., "label: value"); verify adjacent tables were not merged into one.`, table.source_pages);
}

function checkConditionBranches(routine, warn) {
  const texts = (routine.conditions ?? []).map((c) => String(c ?? '').trim()).filter(Boolean);
  const detailed = routine.conditions_detailed ?? [];
  if (texts.length === 0 && detailed.length === 0) return;
  if (texts.length === 0) {
    const hasStructuredFallback = detailed.some((d) => String(d?.false_branch ?? '').trim() || String(d?.referral_code ?? '').trim());
    if (!hasStructuredFallback) {
      warn('routine', routine.id, `Condition routine "${routine.name || routine.id}" has no explicit fallback or ELSE branch; verify the fallback behavior against the source.`, routine.source_pages);
    }
    return;
  }
  // Each condition needs its own fallback evidence: an inline fallback word,
  // a structured false branch or referral, or a sibling bare ELSE/OTHERWISE
  // clause (split IF/ELSE pairs). One condition's fallback never shields an
  // unrelated condition. Applies to every routine kind: a condition without
  // a fallback is ambiguous wherever it appears.
  const detailByText = new Map();
  for (const d of detailed) {
    const key = String(d?.original_text ?? d?.condition ?? '').trim();
    if (key && !detailByText.has(key)) detailByText.set(key, d);
  }
  const hasBareFallback = texts.some((t) => BARE_FALLBACK_CLAUSE.test(t));
  texts.forEach((text, idx) => {
    const det = detailByText.get(text) ?? (detailed.length === texts.length ? detailed[idx] : null);
    if (det && (String(det?.false_branch ?? '').trim() || String(det?.referral_code ?? '').trim())) return;
    if (FALLBACK_WORDS.test(text)) return;
    if (hasBareFallback) return;
    const which = texts.length > 1 ? `Condition ${idx + 1} ` : 'Condition ';
    warn('routine', routine.id, `${which}("${truncate(text, 60)}") states no explicit fallback or ELSE branch; verify the fallback behavior against the source.`, routine.source_pages);
  });
}

// Explicit conditional or applicability language inside a step whose
// structured form carries no branch (`... applies strictly to ...`,
// `... otherwise ...`): the condition would otherwise vanish from the
// structured output silently. Steps that already parsed to a condition
// operation, steps without any structured operation (covered by the
// incomplete-step warning), and routines carrying structured conditions
// (which may cover the step) stay silent. The fallback is never guessed.
const STEP_CONDITION_MARKERS = [
  /\botherwise\b/i,
  /\bif\b[\s\S]{0,100}?\bthen\b/i,
  /\bapplies?\b(?:\s+[A-Za-z-]+){0,2}\s+to\b/i,
  /\bonly\s+(?:for|when|if|where|in)\b/i,
  /\bsubject\s+to\b/i,
  /\bprovided\s+that\b/i,
  /\bin\s+the\s+case\s+of\b/i,
];
const PRONOUN_ELSE = /(?:some|any|every|no)(?:one|body|thing)\s+$/i;
const STEP_CONDITION_OPERATIONS = new Set(['condition', 'conditional', 'if', 'elseif', 'else']);

function stepStatesCondition(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (STEP_CONDITION_MARKERS.some((re) => re.test(s))) return true;
  const elseRe = /\belse\b/gi;
  let m;
  while ((m = elseRe.exec(s)) !== null) {
    if (!PRONOUN_ELSE.test(s.slice(0, m.index))) return true;
  }
  return false;
}

function checkUnstructuredStepConditions(routine, warn) {
  if ((routine.conditions_detailed ?? []).length > 0) return;
  for (const [idx, step] of (routine.steps_detailed ?? []).entries()) {
    const operation = String(step?.operation ?? '').trim().toLowerCase();
    if (!operation || STEP_CONDITION_OPERATIONS.has(operation)) continue;
    const instruction = String(step?.instruction ?? '');
    if (!stepStatesCondition(instruction)) continue;
    warn('routine', routine.id, `Step ${stepSeq(step, idx)} states an applicability condition ("${truncate(instruction.trim(), 100)}") with no structured branch; verify the condition and its fallback against the source.`, step?.source_pages?.length ? step.source_pages : routine.source_pages);
  }
}

function checkStepFormulas(routine, warn) {
  const steps = routine.steps ?? [];
  steps.forEach((step, idx) => {
    const text = String(step ?? '').trim();
    if (!text) return;
    if (hasOperationEvidence(stepDetailForStep(routine, idx, String(step ?? '')))) return;
    // Pure prose without operator-like characters is covered by the aggregate
    // "without an evidenced operation" check; flag only text that reaches for
    // formula syntax yet states no confident operation. The verdict keys off
    // the missing evidence class — no explicit operator, assignment, or
    // table reference — never off which characters happen to appear, so
    // equivalent steps warn consistently regardless of charset accidents.
    if (!FORMULA_OPERATORS.test(text)) return;
    if (CONDITIONAL_KEYWORDS.test(text) && !text.includes('=')) return;
    warn('routine', routine.id, `Step ${idx + 1} ("${truncate(text, 60)}") states no confident operation — no explicit operator, '=' assignment, or table lookup; flagged for analyst review (not treated as invalid).`, routine.source_pages);
  });
}

// Steps in a calculation routine that carry no structured operation
// evidence at all (no operation, expression, operand, inputs, output, or
// table reference) read as descriptive text, not executable logic. Scoped
// to calculation routines only, and conservative: any evidenced field
// counts, so genuine lookups, assignments, rounding, and conditionals —
// including explicitly structured steps whose verb is vague — never match.
function stepSeq(step, index) {
  const seq = step?.sequence;
  return seq !== undefined && seq !== null && String(seq) !== '' ? String(seq) : String(index + 1);
}

// Step-level formula syntax review: evidenced calculations (expression or
// assignment steps) whose formula the validator cannot reliably interpret
// warn with step attribution, mirroring the routine-level expression check.
// Descriptive prose without an operation stays with the aggregate checks.
function checkStepExpressionSyntax(routine, warn) {
  (routine.steps_detailed ?? []).forEach((step, idx) => {
    const op = String(step?.operation ?? '').toLowerCase();
    if (op !== 'expression' && op !== 'assignment') return;
    const expr = String(step?.expression ?? '').trim();
    if (!expr || classifyFormula(expr) !== 'review') return;
    const pages = step?.source_pages?.length ? step.source_pages : routine.source_pages;
    warn('routine', routine.id, `Step ${stepSeq(step, idx)} expression "${truncate(expr)}" uses syntax the validator cannot reliably interpret; flagged for analyst review (not treated as invalid).`, pages);
  });
}

function stepDetailForStep(routine, index, text) {
  const detailed = routine.steps_detailed ?? [];
  const steps = routine.steps ?? [];
  if (detailed.length > 0 && detailed.length === steps.length) return detailed[index] ?? null;
  return detailed.find((d) => String(d?.instruction ?? d?.original_text ?? '') === text) ?? null;
}

function hasOperationEvidence(det) {
  if (!det) return false;
  if ([det.operation, det.expression, det.operand, det.output].some((v) => String(v ?? '').trim() !== '')) return true;
  if ((det.inputs ?? []).some((v) => String(v ?? '').trim() !== '')) return true;
  return (det.depends_on ?? []).some((v) => String(v ?? '').trim() !== '');
}

function checkStepsWithoutOperations(routine, warn) {
  if (routine.kind !== 'calculation_steps') return;
  const steps = routine.steps ?? [];
  if (steps.length === 0) return;
  const missing = [];
  steps.forEach((step, idx) => {
    const text = String(step ?? '');
    if (!text.trim()) return;
    const det = stepDetailForStep(routine, idx, text);
    if (hasOperationEvidence(det)) return;
    const seq = det?.sequence !== undefined && det?.sequence !== null && String(det.sequence) !== ''
      ? String(det.sequence)
      : String(idx + 1);
    missing.push(seq);
  });
  if (missing.length === 0) return;
  const plural = missing.length === 1 ? '' : 's';
  const reads = missing.length === 1 ? 'it reads' : 'they read';
  warn('routine', routine.id, `Routine "${routine.name || routine.id}" has ${missing.length} step${plural} without an evidenced operation (step ${missing.join(', step ')}); ${reads} as descriptive text — verify the source states executable logic.`, routine.source_pages);
}

// Calculations and rounding that state no target variable are incomplete
// logic, not descriptive prose: worked fragments ("LX-01 + LX-02") and
// summary rounding ("Rounded ... to nearest ...") keep their evidenced
// operation but warn so an analyst verifies the intended target.
function checkIncompleteStepLogic(routine, warn) {
  if (routine.kind !== 'calculation_steps') return;
  const detailed = routine.steps_detailed ?? [];
  if (detailed.length === 0) return;
  detailed.forEach((step, idx) => {
    const op = String(step?.operation ?? '').toLowerCase();
    const text = String(step?.instruction ?? step?.original_text ?? '');
    if (!text.trim()) return;
    const seq = step?.sequence !== undefined && step?.sequence !== null && String(step.sequence) !== ''
      ? String(step.sequence)
      : String(idx + 1);
    const pages = step?.source_pages?.length ? step.source_pages : routine.source_pages;
    if ((op === 'expression' || op === 'assignment') && !String(step?.output ?? '').trim()) {
      const evidenced = String(step?.expression ?? '').trim() || String(step?.operand ?? '').trim()
        || (step?.inputs ?? []).some((v) => String(v ?? '').trim() !== '');
      if (!evidenced) return;
      warn('routine', routine.id, `Step ${seq} ("${truncate(text, 60)}") states a calculation without a target variable; flagged as incomplete — verify the intended output against the source.`, pages);
    } else if (op === 'rounding' && !String(step?.output ?? '').trim() && !String(step?.operand ?? '').trim()) {
      warn('routine', routine.id, `Rounding step ${seq} ("${truncate(text, 60)}") has no target variable; flagged as incomplete — verify what is rounded against the source.`, pages);
    }
  });
}

function checkLookupKeys(routine, warn) {
  const detailed = routine.steps_detailed ?? [];
  detailed.forEach((step) => {
    const op = String(step?.operation ?? '').toLowerCase();
    if (!op.includes('lookup') && !op.includes('look-up') && !op.includes('table')) return;
    const inputs = step?.inputs ?? [];
    const hasKeys = Array.isArray(inputs) ? inputs.filter((v) => String(v ?? '').trim()).length > 0 : false;
    const seq = step?.sequence ?? step?.instruction ?? '';
    if (!hasKeys) {
      warn('routine', routine.id, `Lookup step${seq !== '' ? ` ${seq}` : ''} ("${truncate(String(step?.instruction ?? step?.expression ?? step?.operand ?? ''), 60)}") has no lookup keys; verify the keys and referenced table against the source.`, step?.source_pages?.length ? step.source_pages : routine.source_pages);
    }
  });
}

// Right-hand side of an `output = rhs` assignment form, or '' when the text
// states no assignment.
function assignmentRhs(text) {
  const idx = String(text ?? '').indexOf('=');
  if (idx < 0) return '';
  return String(text).slice(idx + 1).replace(/\.\s*$/, '').trim();
}

// A bare literal or single identifier: initialization and aliasing, not a
// computed definition. Such pairs (for example `x = 0` then `x = input`)
// never count as conflicting formulas.
function isTrivialRhs(rhs) {
  const s = String(rhs ?? '').trim();
  if (!s) return true;
  if (isNumericReference(s)) return true;
  return /^[A-Za-z_]\w*$/.test(s);
}

function formulaKey(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}

// Two computed definitions of one output with different formulas read as a
// possible source contradiction: flag for review, never silently pick one.
function checkConflictingStepDefinitions(routine, warn) {
  const byOutput = new Map();
  (routine.steps_detailed ?? []).forEach((step, idx) => {
    const output = String(step?.output ?? '').trim();
    const expr = String(step?.expression ?? '').trim();
    if (!output || !expr) return;
    const key = normalizeVariableKey(output);
    if (!key) return;
    if (!byOutput.has(key)) byOutput.set(key, []);
    byOutput.get(key).push({ seq: stepSeq(step, idx), name: output, expr });
  });
  for (const defs of byOutput.values()) {
    if (defs.length < 2) continue;
    const computed = defs.filter((d) => !isTrivialRhs(assignmentRhs(d.expr)));
    const distinct = [...new Set(computed.map((d) => formulaKey(d.expr)))];
    if (distinct.length < 2) continue;
    const first = computed.find((d) => formulaKey(d.expr) === distinct[0]);
    const second = computed.find((d) => formulaKey(d.expr) === distinct[1]);
    warn('routine', routine.id, `Steps ${first.seq} and ${second.seq} both assign "${first.name}" with different formulas ("${truncate(first.expr, 60)}" vs "${truncate(second.expr, 60)}"); verify which definition applies — flagged as a possible contradiction (not treated as invalid).`, routine.source_pages);
  }
}

// Declared inputs used nowhere in the routine's own steps, conditions,
// expression, or dependencies: possible drift or a mistyped name. Inputs
// the routine actually reads stay silent.
const IDENT_TOKEN = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*(?:\[[^\[\]{}();,=<>!+\-*/]+\])?/g;

function singleAssignmentTarget(expr) {
  const segments = splitTopLevel(String(expr ?? ''), ';').map((s) => String(s ?? '').trim()).filter(Boolean);
  if (segments.length !== 1) return null;
  const split = splitAssignmentSegment(segments[0]);
  if (!split) return null;
  return { output: split.output, rhs: split.rhs, expr: segments[0] };
}

// One condition stated with different branches: same contradiction policy
// as conflicting formulas — flag for review, never silently pick one.
function checkConflictingConditions(routine, warn) {
  const detailed = routine.conditions_detailed ?? [];
  if (detailed.length < 2) return;
  const byCondition = new Map();
  detailed.forEach((entry, idx) => {
    const condition = String(entry?.condition ?? '').trim();
    if (!condition) return;
    const key = normalizeVariableKey(condition);
    if (!key) return;
    const branches = [
      String(entry?.true_branch ?? '').trim(),
      String(entry?.false_branch ?? '').trim(),
      String(entry?.referral_code ?? '').trim(),
    ].join('|');
    if (!byCondition.has(key)) byCondition.set(key, []);
    byCondition.get(key).push({ idx, condition, branches });
  });
  for (const defs of byCondition.values()) {
    if (defs.length < 2) continue;
    const distinct = [...new Set(defs.map((d) => d.branches.replace(/\s+/g, ' ').toLowerCase()))];
    if (distinct.length < 2 || distinct.some((b) => !b.replace(/\|/g, '').trim())) continue;
    const first = defs.find((d) => d.branches.replace(/\s+/g, ' ').toLowerCase() === distinct[0]);
    const second = defs.find((d) => d.branches.replace(/\s+/g, ' ').toLowerCase() === distinct[1]);
    warn('routine', routine.id, `Conditions ${first.idx + 1} and ${second.idx + 1} state the same condition ("${truncate(first.condition, 60)}") with different branches; verify which branch applies — flagged as a possible contradiction (not treated as invalid).`, routine.source_pages);
  }
}

// Two routines computing one output with different formulas: same
// contradiction policy as within-routine steps, reported on the later
// routine. Multi-statement expressions stay with the step-level check.
// Worked examples are illustrative instance values, never normative
// definitions, so they are excluded from contradiction detection.
function checkConflictingRoutineFormulas(routines, warn) {
  const seen = new Map();
  for (const r of routines ?? []) {
    if (String(r?.kind ?? '') === 'worked_example') continue;
    const parsed = singleAssignmentTarget(r?.expression_text);
    if (!parsed) continue;
    const key = normalizeVariableKey(parsed.output);
    if (!key) continue;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { routine: r, ...parsed });
      continue;
    }
    if (formulaKey(prior.expr) === formulaKey(parsed.expr)) continue;
    if (isTrivialRhs(prior.rhs) || isTrivialRhs(parsed.rhs)) continue;
    warn('routine', r.id, `Routines "${prior.routine.name || prior.routine.id}" and "${r.name || r.id}" both assign "${parsed.output}" with different formulas ("${truncate(prior.expr, 60)}" vs "${truncate(parsed.expr, 60)}"); verify which definition applies — flagged as a possible contradiction (not treated as invalid).`, r.source_pages);
  }
}

// One output computed by steps in different routines with different
// formulas: same contradiction policy as within-routine steps, reported on
// the later routine. Trivial re-statements (literals, aliases) never count.
// Worked examples are illustrative instance values, never normative
// definitions, so they are excluded from contradiction detection.
function checkConflictingStepDefinitionsAcrossRoutines(routines, warn) {
  const byOutput = new Map();
  for (const r of routines ?? []) {
    if (String(r?.kind ?? '') === 'worked_example') continue;
    (r?.steps_detailed ?? []).forEach((step, idx) => {
      const output = String(step?.output ?? '').trim();
      const expr = String(step?.expression ?? '').trim();
      if (!output || !expr) return;
      const key = normalizeVariableKey(output);
      if (!key) return;
      if (!byOutput.has(key)) byOutput.set(key, []);
      byOutput.get(key).push({ routine: r, seq: stepSeq(step, idx), name: output, expr });
    });
  }
  for (const defs of byOutput.values()) {
    const routinesSeen = new Set(defs.map((d) => d.routine));
    if (routinesSeen.size < 2) continue;
    const computed = defs.filter((d) => !isTrivialRhs(assignmentRhs(d.expr)));
    const distinct = [...new Set(computed.map((d) => formulaKey(d.expr)))];
    if (distinct.length < 2) continue;
    const first = computed.find((d) => formulaKey(d.expr) === distinct[0]);
    const second = computed.find((d) => formulaKey(d.expr) === distinct[1]);
    if (first.routine === second.routine) continue;
    warn('routine', second.routine.id, `Step ${second.seq} of routine "${second.routine.name || second.routine.id}" and step ${first.seq} of routine "${first.routine.name || first.routine.id}" both assign "${second.name}" with different formulas ("${truncate(second.expr, 50)}" vs "${truncate(first.expr, 50)}"); verify which definition applies — flagged as a possible contradiction (not treated as invalid).`, second.routine.source_pages);
  }
}

function checkUnusedInputs(routine, warn) {
  if (String(routine?.kind ?? '') === 'worked_example') return;
  const inputs = (routine.inputs ?? []).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (inputs.length === 0) return;
  // Values this routine defines (its inputs, outputs, and step outputs):
  // an unspaced hyphen beside one of them reads as subtraction
  // (`fee_factor-1.0` uses fee_factor), while hyphenated codes (`HD-001`)
  // stay whole — the same rule as assignment parsing, so usage scanning
  // never hides a variable inside an arithmetic token.
  const definedHere = new Set(
    [...(routine.inputs ?? []), ...(routine.outputs ?? []), ...((routine.steps_detailed ?? []).map((s) => s?.output))]
      .map((v) => String(v ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const used = new Set();
  const addName = (value) => {
    const s = String(value ?? '').trim();
    if (!s) return;
    used.add(s.toLowerCase());
    const key = normalizeVariableKey(s);
    if (key) used.add(key);
  };
  const addTokens = (text) => {
    for (const m of splitHyphenSubtraction(String(text ?? ''), definedHere).matchAll(IDENT_TOKEN)) addName(m[0]);
  };
  addTokens(routine.expression_text);
  for (const s of routine.steps ?? []) addTokens(typeof s === 'string' ? s : (s?.instruction ?? s?.text ?? ''));
  for (const d of routine.steps_detailed ?? []) {
    addTokens(d?.instruction);
    addTokens(d?.expression);
    addTokens(d?.operand);
    addTokens(d?.original_text);
    for (const v of d?.inputs ?? []) addName(v);
  }
  for (const c of routine.conditions ?? []) {
    addTokens(typeof c === 'string' ? c : (c?.condition ?? c?.true_branch ?? c?.false_branch ?? ''));
  }
  for (const d of routine.conditions_detailed ?? []) {
    addTokens(d?.condition);
    addTokens(d?.true_branch);
    addTokens(d?.false_branch);
  }
  for (const dep of [...(routine.depends_on ?? []), ...((routine.dependencies ?? []).map((d) => d?.target))]) {
    addTokens(dep);
  }
  for (const name of inputs) {
    if (isNumericReference(name)) continue;
    const key = normalizeVariableKey(name);
    if (used.has(name.toLowerCase()) || (key && used.has(key))) continue;
    if (rangeInputUsed(name, used)) continue;
    warn('routine', routine.id, `Routine "${routine.name || routine.id}" declares input "${name}", which is used nowhere in its steps, conditions, expression, or dependencies; verify the name against the source.`, routine.source_pages);
  }
}

// Range-notation inputs (`Payroll1..Payrolln`, `CPk for k=1 to 5`) name a
// family used through indexed variables (`Payroll[i]`, `CPk`): the base term
// (before range prose) or its prefix in any used token evidences use. Plain
// inputs without range structure never match here. Generic notation shapes,
// never variable names.
function rangeInputUsed(name, used) {
  const s = String(name ?? '').trim();
  if (!s) return false;
  const rangeMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*1?\s*\.\.\s*\1?\s*n\b/i.exec(s)
    || /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:for|where|with|when)\b/i.exec(s);
  const base = rangeMatch ? rangeMatch[1] : null;
  if (!base) {
    const first = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\[\]]+\])?/.exec(s);
    if (first && /\b(for|where|with|when|from|to)\b/i.test(s)) {
      const token = first[0].toLowerCase();
      const tokenKey = normalizeVariableKey(token);
      return used.has(token) || (Boolean(tokenKey) && used.has(tokenKey));
    }
    return false;
  }
  const lower = base.toLowerCase();
  const key = normalizeVariableKey(base);
  for (const u of used) {
    if (u.startsWith(lower) || (key && String(u).startsWith(key))) return true;
  }
  return false;
}

// Reference-resolution context for one job: every category of defined name a
// dependency target or step reference may legitimately point at. Matching is
// both verbatim (lowercased) and spacing/punctuation-insensitive (normalized),
// so "Hull Code" matches "hull_code". Generic: built from the job, never from
// hardcoded names.
function buildReferenceContext(tables, routines) {
  const lower = (s) => String(s ?? '').trim().toLowerCase();
  const lowered = (list) => new Set((list ?? []).map(lower).filter(Boolean));
  const normalized = (set) => new Set([...set].map((s) => normalizeVariableKey(s)).filter(Boolean));
  const tableTerms = tableReferenceTerms(tables);
  const routineOutputs = lowered((routines ?? []).flatMap((r) => r.outputs ?? []));
  const stepOutputs = lowered((routines ?? []).flatMap((r) => (r.steps_detailed ?? []).map((s) => s?.output)));
  const constants = definedConstantTerms(routines);
  const ownInputs = new Map();
  for (const r of routines ?? []) {
    const terms = lowered(r.inputs ?? []);
    ownInputs.set(r, { lower: terms, normalized: normalized(terms) });
  }
  return {
    tables: tables ?? [],
    routines: routines ?? [],
    knownNames: new Set(
      [...(tables ?? []), ...(routines ?? [])].flatMap((item) => [item.id, item.name, ...(item.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase()))
    ),
    tableTerms,
    normalizedTableTerms: normalized(tableTerms),
    routineOutputs,
    normalizedRoutineOutputs: normalized(routineOutputs),
    stepOutputs,
    normalizedStepOutputs: normalized(stepOutputs),
    constants,
    normalizedConstants: normalized(constants),
    ownInputs,
  };
}

function isNumericReference(value) {
  const s = String(value ?? '').trim().replace(/,/g, '');
  return s !== '' && /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s);
}

// True when a dependency target or step reference names something the job
// defines: a table or routine (by id, name, code token, or alias), a declared
// input of this routine, an output of any routine (cross-routine flows),
// an intermediate step output, a table column or lookup key, a defined
// constant, or a numeric literal. Anything else is a genuine unresolved
// reference. A declared input or intermediate output is never flagged merely
// because it is not a table column.
function isResolvedReference(routine, target, ctx) {
  const name = String(target ?? '').trim();
  if (!name || isNumericReference(name)) return true;
  const lower = name.toLowerCase();
  if (ctx.knownNames.has(lower)) return true;
  if (resolveRoutineReference(ctx.routines, name)) return true;
  const own = ctx.ownInputs.get(routine);
  if (own?.lower.has(lower)) return true;
  if (ctx.routineOutputs.has(lower)) return true;
  if (ctx.stepOutputs.has(lower)) return true;
  if (ctx.tableTerms.has(lower)) return true;
  if (ctx.constants.has(lower)) return true;
  const key = normalizeVariableKey(name);
  if (key) {
    if (own?.normalized.has(key)) return true;
    if (ctx.normalizedRoutineOutputs.has(key)) return true;
    if (ctx.normalizedStepOutputs.has(key)) return true;
    if (ctx.normalizedTableTerms.has(key)) return true;
    if (ctx.normalizedConstants.has(key)) return true;
  }
  if (resolveTableReference(ctx.tables, name)) return true;
  const candidates = findTableCandidates(ctx.tables ?? [], name);
  if (candidates.length > 1 && isLogicalGroupReference(candidates, name)
    && routineUsesMultipleGroupParts(routine, candidates)) return true;
  return false;
}

// True when the routine's step inputs match columns from at least two parts
// of a logical table group, evidencing that a base-code reference names the
// whole group (each part used) rather than one ambiguous part. Without such
// step-level evidence the base code stays ambiguous and warns.
function routineUsesMultipleGroupParts(routine, candidates) {
  const steps = routine?.steps_detailed ?? [];
  if (steps.length === 0) return false;
  const inputs = [];
  for (const step of steps) {
    for (const raw of step?.inputs ?? []) {
      const s = String(raw ?? '').trim();
      if (s) inputs.push(s);
    }
  }
  if (inputs.length === 0) return false;
  const lowered = new Set(inputs.map((s) => s.toLowerCase()));
  const normalized = new Set(inputs.map((s) => normalizeVariableKey(s)).filter(Boolean));
  let matched = 0;
  for (const table of candidates) {
    const cols = [...(table?.headers ?? []), ...(table?.columns ?? []).map((c) => c?.label ?? c?.original_label)];
    const hit = cols.some((h) => {
      const s = String(h ?? '').trim();
      if (!s) return false;
      if (lowered.has(s.toLowerCase())) return true;
      const key = normalizeVariableKey(s);
      return Boolean(key && normalized.has(key));
    });
    if (hit) matched += 1;
    if (matched >= 2) return true;
  }
  return false;
}

// A dependency target that matches several tables is ambiguous, not
// unresolved: name the candidates so the analyst can disambiguate against
// the source. Anything else keeps the unresolved wording.
function unresolvedDependencyMessage(routine, target, refCtx) {
  const candidates = findTableCandidates(refCtx?.tables ?? [], target).filter(
    (t, i, arr) => arr.indexOf(t) === i
  );
  if (candidates.length > 1) {
    const names = candidates.map((t) => `"${t?.name || t?.id}"`).join(', ');
    return `Routine "${routine.name || routine.id}" depends on "${target}", which matches multiple tables (${names}); verify which table applies.`;
  }
  return `Routine "${routine.name || routine.id}" depends on "${target}", which matches no extracted table, routine, input, or output.`;
}

function unresolvedStepMessage(routine, step, name, refCtx) {
  const seq = step?.sequence !== undefined && step?.sequence !== '' ? ` ${step.sequence}` : '';
  const candidates = findTableCandidates(refCtx?.tables ?? [], name).filter(
    (t, i, arr) => arr.indexOf(t) === i
  );
  if (candidates.length > 1) {
    const names = candidates.map((t) => `"${t?.name || t?.id}"`).join(', ');
    return `Step${seq} references "${name}", which matches multiple tables (${names}); verify which table applies.`;
  }
  return `Step${seq} references "${name}", which matches no defined input, step output, routine output, table, column, routine, or constant; flagged as unresolved.`;
}

// Terms a step defines for itself in its own instruction or expression:
// the target of every standalone `=` assignment and the retrieved value of
// every `<verb> <phrase> from (the) table(s)` retrieval phrase (its last
// identifier: `Retrieve harbor rate HarborRate from Fee Schedule ...`
// defines HarborRate). Lookup keys (`matching PORT-01`) and surrounding
// prose are never collected. References to these terms are step-internal,
// never unresolved. Generic syntax, never variable names.
const STEP_RETRIEVAL_VERBS = '(?:retrieves?|retrieved|look\\s*-?\\s*up|lookup|finds?|found|fetch(?:es|ed)?|obtains?|obtained|gets?|got|selects?|selected|reads?|determines?|determined|locates?|located|extracts?|extracted)';
const STEP_RETRIEVAL_SOURCES = '(?:tables?|schedules?|appendix|appendices|exhibits?)';

function stepDefinedTerms(step) {
  const lower = new Set();
  const normalized = new Set();
  const add = (term) => {
    const s = String(term ?? '').trim();
    if (!s) return;
    lower.add(s.toLowerCase());
    const key = normalizeVariableKey(s);
    if (key) normalized.add(key);
  };
  const texts = [step?.instruction, step?.expression, step?.original_text];
  for (const raw of texts) {
    const s = String(raw ?? '');
    if (!s) continue;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] !== '=') continue;
      const prev = s[i - 1] ?? '';
      const next = s[i + 1] ?? '';
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=' || next === '>') continue;
      const m = /([A-Za-z_]\w*)\s*$/.exec(s.slice(0, i));
      if (m) add(m[1]);
    }
    const pattern = new RegExp(`${STEP_RETRIEVAL_VERBS}\\s+(.+?)\\s+from\\s+(?:the\\s+)?(?:[A-Za-z0-9_-]+\\s+){0,3}?${STEP_RETRIEVAL_SOURCES}\\b`, 'gi');
    let m;
    while ((m = pattern.exec(s)) !== null) {
      const ids = String(m[1] ?? '').match(/[A-Za-z_]\w*/g) ?? [];
      if (ids.length > 0) add(ids[ids.length - 1]);
    }
  }
  return { lower, normalized };
}

function isStepDefined(name, definedHere) {
  if (!definedHere) return false;
  const lower = String(name ?? '').trim().toLowerCase();
  if (definedHere.lower.has(lower)) return true;
  const key = normalizeVariableKey(name);
  return Boolean(key && definedHere.normalized.has(key));
}

function checkStructuredDependencies(routine, warn, refCtx) {
  const deps = routine.dependencies ?? [];
  for (const dep of deps) {
    const target = String(dep?.target ?? '').trim();
    if (target && !isResolvedReference(routine, target, refCtx)) {
      warn('routine', routine.id, unresolvedDependencyMessage(routine, target, refCtx), dep?.source_pages?.length ? dep.source_pages : routine.source_pages);
    }
  }
  const detailed = routine.steps_detailed ?? [];
  if (detailed.length === 0) return;
  for (const step of detailed) {
    const definedHere = stepDefinedTerms(step);
    const refs = [...(step?.inputs ?? []), ...(step?.depends_on ?? [])];
    for (const ref of refs) {
      const name = String(ref ?? '').trim();
      if (!name || isStepDefined(name, definedHere) || isResolvedReference(routine, name, refCtx)) continue;
      warn('routine', routine.id, unresolvedStepMessage(routine, step, name, refCtx), step?.source_pages?.length ? step.source_pages : routine.source_pages);
    }
  }
}

function truncate(s, max = 80) {
  const t = String(s).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
