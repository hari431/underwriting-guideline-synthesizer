// Deterministic validation for extracted jobs. Pure functions, no model calls.
// Policy: structural/traceability breaks are errors; anything interpretive —
// including unfamiliar formula syntax — is a warning flagged for review.
import { createValidationIssue } from './models.js';

export const ROUTINE_KINDS = ['formula', 'condition', 'calculation_steps'];

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
    const headerCount = table.headers.filter((h) => h.trim()).length;
    if (headerCount === 0 && table.rows.length === 0) {
      error('table', table.id, `Table "${table.name || table.id}" is empty (no headers or rows).`, table.source_pages);
    } else if (table.rows.length === 0) {
      warn('table', table.id, `Table "${table.name || table.id}" has headers but no rows.`, table.source_pages);
    } else if (headerCount > 0) {
      const ragged = table.rows.filter((r) => r.length !== table.headers.length).length;
      if (ragged > 0) {
        warn('table', table.id, `Table "${table.name || table.id}" has ${ragged} row(s) with column counts differing from headers.`, table.source_pages);
      }
    }
    checkConfidence('table', table, warn);
  }

  const knownNames = new Set(
    [...tables, ...routines].flatMap((item) => [item.id, item.name].filter(Boolean).map((s) => s.toLowerCase()))
  );
  for (const routine of routines) {
    checkTraceability('routine', routine);
    if (!ROUTINE_KINDS.includes(routine.kind)) {
      warn('routine', routine.id, `Routine "${routine.name || routine.id}" has unrecognized kind "${routine.kind}"; needs review.`, routine.source_pages);
    }
    if (routine.kind === 'formula' && !routine.expression_text.trim()) {
      warn('routine', routine.id, `Formula routine "${routine.name || routine.id}" has no expression text.`, routine.source_pages);
    }
    if (routine.kind === 'condition' && routine.conditions.filter((c) => c.trim()).length === 0) {
      warn('routine', routine.id, `Condition routine "${routine.name || routine.id}" has no conditions.`, routine.source_pages);
    }
    if (routine.kind === 'calculation_steps' && routine.steps.filter((s) => s.trim()).length === 0) {
      warn('routine', routine.id, `Calculation routine "${routine.name || routine.id}" has no steps.`, routine.source_pages);
    }
    if (routine.expression_text.trim()) {
      const verdict = classifyFormula(routine.expression_text);
      if (verdict === 'review') {
        warn('routine', routine.id, `Expression "${truncate(routine.expression_text)}" uses syntax the validator cannot reliably interpret; flagged for analyst review (not treated as invalid).`, routine.source_pages);
      }
    }
    for (const dep of routine.depends_on) {
      if (dep.trim() && !knownNames.has(dep.trim().toLowerCase())) {
        warn('routine', routine.id, `Routine "${routine.name || routine.id}" depends on "${dep}", which matches no extracted table or routine.`, routine.source_pages);
      }
    }
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

function truncate(s, max = 80) {
  const t = String(s).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
