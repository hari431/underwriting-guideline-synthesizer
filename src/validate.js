// Deterministic validation for extracted jobs. Pure functions, no model calls.
// Policy: structural/traceability breaks are errors; anything interpretive —
// including unfamiliar formula syntax — is a warning flagged for review.
import { ROUTINE_KINDS, createValidationIssue, definedConstantTerms, normalizeVariableKey, resolveRoutineReference, resolveTableReference, tableReferenceTerms } from './models.js';

export { ROUTINE_KINDS };

const CONDITIONAL_KEYWORDS = /\b(if|then|else|case|when|and|or|not|in)\b/i;
const FORMULA_OPERATORS = /=|[+\-*/%()<>?]/;
const FORMULA_ALLOWED_CHARS = /^[A-Za-z0-9_+\-*/().<>=!% \t,?]+$/;

// Classify a formula expression without ever calling it "invalid":
// 'ok' (reliably interpretable), 'conditional', or 'review' (flag for analyst).
export function classifyFormula(expressionText) {
  const expr = String(expressionText ?? '').trim();
  if (!expr) return 'empty';
  if (!FORMULA_ALLOWED_CHARS.test(expr)) return 'review';
  if (CONDITIONAL_KEYWORDS.test(expr)) return 'conditional';
  if (!FORMULA_OPERATORS.test(expr)) return 'review';
  if (!balancedParens(expr)) return 'review';
  const sides = expr.split('=').filter((s) => s.trim());
  if (expr.includes('=') && sides.length < 2) return 'review';
  return 'ok';
}

function balancedParens(expr) {
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
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
    if (String(routine.expression_text ?? '').trim()) {
      const verdict = classifyFormula(routine.expression_text);
      if (verdict === 'review') {
        warn('routine', routine.id, `Expression "${truncate(routine.expression_text)}" uses syntax the validator cannot reliably interpret; flagged for analyst review (not treated as invalid).`, routine.source_pages);
      }
    }
    for (const dep of routine.depends_on ?? []) {
      const target = String(dep ?? '').trim();
      if (target && !isResolvedReference(routine, target, refCtx)) {
        warn('routine', routine.id, `Routine "${routine.name || routine.id}" depends on "${dep}", which matches no extracted table, routine, input, or output.`, routine.source_pages);
      }
    }
    checkConditionFallback(routine, warn);
    checkStepFormulas(routine, warn);
    checkLookupKeys(routine, warn);
    checkStructuredDependencies(routine, warn, refCtx);
    checkConfidence('routine', routine, warn);
  }

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
const UNITS_INDICATORS = /[$€£¥%‰]|percent|per\s*cent|dollar|cent|euro|currency|\bper\b|annual|monthly|yearly|daily|\/year|\/month|\/day|basis\s*point/i;

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
      if (!Array.isArray(row) || c >= row.length) {
        blanks += 1;
        continue;
      }
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

function checkConditionFallback(routine, warn) {
  if (routine.kind !== 'condition') return;
  const conds = routine.conditions ?? [];
  const detailed = routine.conditions_detailed ?? [];
  if (conds.filter((c) => String(c ?? '').trim()).length === 0 && detailed.length === 0) return;
  const hasStructuredFallback = detailed.some((d) => String(d?.false_branch ?? '').trim() || String(d?.referral_code ?? '').trim());
  if (hasStructuredFallback) return;
  const joined = conds.join('\n');
  if (/\b(else|otherwise|fallback|refer|decline|exception|default)\b/i.test(joined)) return;
  warn('routine', routine.id, `Condition routine "${routine.name || routine.id}" has no explicit fallback or ELSE branch; verify the fallback behavior against the source.`, routine.source_pages);
}

function checkStepFormulas(routine, warn) {
  const steps = routine.steps ?? [];
  steps.forEach((step, idx) => {
    const text = String(step ?? '').trim();
    if (!text) return;
    if (!FORMULA_OPERATORS.test(text)) return;
    if (CONDITIONAL_KEYWORDS.test(text) && !text.includes('=')) return;
    const verdict = classifyFormula(text);
    if (verdict === 'review') {
      warn('routine', routine.id, `Step ${idx + 1} ("${truncate(text, 60)}") uses syntax the validator cannot reliably interpret; flagged for analyst review (not treated as invalid).`, routine.source_pages);
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
      [...(tables ?? []), ...(routines ?? [])].flatMap((item) => [item.id, item.name].filter(Boolean).map((s) => s.toLowerCase()))
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
  return false;
}

function checkStructuredDependencies(routine, warn, refCtx) {
  const deps = routine.dependencies ?? [];
  for (const dep of deps) {
    const target = String(dep?.target ?? '').trim();
    if (target && !isResolvedReference(routine, target, refCtx)) {
      warn('routine', routine.id, `Routine "${routine.name || routine.id}" depends on "${target}", which matches no extracted table, routine, input, or output.`, dep?.source_pages?.length ? dep.source_pages : routine.source_pages);
    }
  }
  const detailed = routine.steps_detailed ?? [];
  if (detailed.length === 0) return;
  for (const step of detailed) {
    const refs = [...(step?.inputs ?? []), ...(step?.depends_on ?? [])];
    for (const ref of refs) {
      const name = String(ref ?? '').trim();
      if (!name || isResolvedReference(routine, name, refCtx)) continue;
      warn('routine', routine.id, `Step${step?.sequence !== undefined && step?.sequence !== '' ? ` ${step.sequence}` : ''} references "${name}", which matches no defined input, step output, routine output, table, column, routine, or constant; flagged as unresolved.`, step?.source_pages?.length ? step.source_pages : routine.source_pages);
    }
  }
}

function truncate(s, max = 80) {
  const t = String(s).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
