// Data model for UnderwriteIQ demo jobs.
// Every extracted object carries source_pages (1-based) and evidence_text
// (verbatim supporting snippet from the PDF) wherever available.

export const TABLE_PREFIX = 'T';
export const ROUTINE_PREFIX = 'R';
export const ISSUE_PREFIX = 'V';

export function createDocument({ filename, pageCount, page_count } = {}) {
  return {
    filename: String(filename ?? ''),
    page_count: Number(pageCount ?? page_count ?? 0),
  };
}

export function createRatingTable({
  id = null,
  name = '',
  sourcePages,
  source_pages,
  evidenceText,
  evidence_text,
  headers = [],
  rows = [],
  notes = '',
  confidence = null,
} = {}) {
  return {
    id,
    name: String(name ?? ''),
    source_pages: normalizePages(sourcePages ?? source_pages ?? []),
    evidence_text: String(evidenceText ?? evidence_text ?? ''),
    headers: (headers ?? []).map((h) => String(h ?? '')),
    rows: (rows ?? []).map((r) => (r ?? []).map((c) => String(c ?? ''))),
    notes: String(notes ?? ''),
    confidence: confidence ?? null,
  };
}

export function createRatingRoutine({
  id = null,
  name = '',
  kind = 'formula',
  sourcePages,
  source_pages,
  evidenceText,
  evidence_text,
  expressionText,
  expression_text,
  conditions = [],
  steps = [],
  dependsOn,
  depends_on,
  notes = '',
  confidence = null,
} = {}) {
  return {
    id,
    name: String(name ?? ''),
    kind: String(kind ?? 'formula'),
    source_pages: normalizePages(sourcePages ?? source_pages ?? []),
    evidence_text: String(evidenceText ?? evidence_text ?? ''),
    expression_text: String(expressionText ?? expression_text ?? ''),
    conditions: (conditions ?? []).map((c) => String(c ?? '')),
    steps: (steps ?? []).map((s) => String(s ?? '')),
    depends_on: (dependsOn ?? depends_on ?? []).map((d) => String(d ?? '')),
    notes: String(notes ?? ''),
    confidence: confidence ?? null,
  };
}

export function createValidationIssue({
  id = null,
  severity = 'warning',
  targetType,
  target_type,
  targetId,
  target_id,
  message = '',
  sourcePages,
  source_pages,
} = {}) {
  return {
    id,
    severity: severity === 'error' ? 'error' : 'warning',
    target_type: String(targetType ?? target_type ?? 'job'),
    target_id: String(targetId ?? target_id ?? ''),
    message: String(message ?? ''),
    source_pages: normalizePages(sourcePages ?? source_pages ?? []),
  };
}

export function createJob({ document, tables = [], routines = [], issues = [], status = 'draft' } = {}) {
  return {
    document,
    tables: tables.map((t) => createRatingTable(t)),
    routines: routines.map((r) => createRatingRoutine(r)),
    issues: issues.map((i) => createValidationIssue(i)),
    status: String(status ?? 'draft'),
    updated_at: new Date().toISOString(),
  };
}

// Deterministic normalization: trim strings, assign stable sequential IDs
// (T1.., R1.., V1..) to items missing one, preserve existing IDs.
export function normalizeJob(job) {
  const out = createJob(job);
  assignIds(out.tables, TABLE_PREFIX);
  assignIds(out.routines, ROUTINE_PREFIX);
  assignIds(out.issues, ISSUE_PREFIX);
  return out;
}

function assignIds(items, prefix) {
  let next = 1;
  const used = new Set(items.map((i) => i.id).filter(Boolean));
  for (const item of items) {
    if (!item.id) {
      while (used.has(`${prefix}${next}`)) next += 1;
      item.id = `${prefix}${next}`;
      used.add(item.id);
      next += 1;
    }
  }
  return items;
}

function normalizePages(pages) {
  const nums = (pages ?? [])
    .map((p) => Number(p))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b);
}
