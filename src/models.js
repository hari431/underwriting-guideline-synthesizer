// Data model for RateCraft demo jobs.
// Every extracted object carries source_pages (1-based) and evidence_text
// (verbatim supporting snippet from the PDF) wherever available.
// Optional descriptive fields are preserved only when the source provides
// them; nothing is fabricated to fill the schema.

export const TABLE_PREFIX = 'T';
export const ROUTINE_PREFIX = 'R';
export const ISSUE_PREFIX = 'V';

// Canonical routine kinds. Model-provided kinds normalize to one of these
// when recognized (see normalizeRoutineKind); anything else is preserved
// verbatim so validation can warn about genuinely unknown types.
// worked_example marks illustrative calculations with expected values: they
// are preserved for verification, never treated as normative definitions.
export const ROUTINE_KINDS = ['formula', 'condition', 'calculation_steps', 'worked_example', 'lookup', 'floor_check'];

export function createDocument({ filename, pageCount, page_count } = {}) {
  return {
    filename: String(filename ?? ''),
    page_count: Number(pageCount ?? page_count ?? 0),
  };
}

export function createRatingTable({
  id = null,
  table_id,
  name = '',
  title,
  aliases = [],
  sourcePages,
  source_pages,
  source_type,
  sourceType,
  source_location,
  sourceLocation,
  evidenceText,
  evidence_text,
  evidence,
  headers = [],
  columns = [],
  rows = [],
  original_cells,
  originalCells,
  purpose = '',
  applicability = '',
  effective_period,
  effectivePeriod = '',
  footnotes = [],
  notes = '',
  continuation = null,
  review_status,
  reviewStatus = '',
  confidence = null,
} = {}) {
  const { headers: normHeaders, columns: normColumns } = normalizeHeadersAndColumns({ headers, columns });
  const { rows: normRows, originalCells: freshOriginals } = normalizeRows(rows);
  // Display name plus every distinct source label (asset code, title) as
  // aliases, so dependency references to any of them resolve. The display
  // name itself is never duplicated into aliases.
  const displayName = String(title ?? name ?? '');
  const seenLabels = new Set([displayName.trim().toLowerCase()]);
  const normAliases = [];
  const aliasInputs = [name, title, ...(Array.isArray(aliases) ? aliases : [aliases])];
  for (const entry of aliasInputs) {
    const label = String(entry ?? '').trim();
    if (!label || seenLabels.has(label.toLowerCase())) continue;
    seenLabels.add(label.toLowerCase());
    normAliases.push(label);
  }
  // Asset codes embedded in the display name answer as aliases too, so
  // references to the code resolve without inventing labels.
  for (const label of embeddedNameAliases(displayName)) {
    if (seenLabels.has(label.toLowerCase())) continue;
    seenLabels.add(label.toLowerCase());
    normAliases.push(label);
  }
  return {
    id: id ?? table_id ?? null,
    name: displayName,
    aliases: normAliases,
    source_pages: normalizePages(sourcePages ?? source_pages ?? []),
    source_type: String(source_type ?? sourceType ?? ''),
    source_location: String(source_location ?? sourceLocation ?? ''),
    evidence_text: String(evidenceText ?? evidence_text ?? evidence ?? ''),
    headers: normHeaders,
    columns: normColumns,
    rows: normRows,
    original_cells: mergeOriginalCells(normRows, freshOriginals, original_cells ?? originalCells),
    purpose: String(purpose ?? ''),
    applicability: String(applicability ?? ''),
    effective_period: String(effective_period ?? effectivePeriod ?? ''),
    footnotes: normalizeStringList(footnotes),
    notes: String(notes ?? ''),
    continuation: normalizeContinuation(continuation),
    review_status: String(review_status ?? reviewStatus ?? ''),
    confidence: confidence ?? null,
  };
}

// A trailing prose sentence after a calculation (`... = $13,065.21. All
// values reconcile.`) is meta-commentary, not part of the formula: strip it
// for parsing (the notes keep it verbatim) only when it states no
// calculation of its own. Anything else passes through untouched.
function stripTrailingProseSentence(segment) {
  const text = String(segment ?? '').trim();
  const m = /^([\s\S]*?\S)\s*\.\s+[A-Z][\s\S]*$/.exec(text);
  if (!m) return text;
  if (text.slice(m[1].length).includes('=')) return text;
  return m[1].trim();
}

// Ordered calculation steps for a stepless worked example, derived
// mechanically from its expected-values notes: each `;`-separated segment
// stating an explicit calculation (`=`) becomes a step in notes order,
// comma-joined chained evaluations split into ordered steps, and a
// trailing parenthesized comparison becomes its own check step after its
// statement; a standalone bare comparison promotes the same way.
// carrying the routine source pages; narrative segments stay in the notes
// verbatim instead of becoming steps. Parsing itself is left to the normal
// step machinery, so explicit formulas structure and genuinely ambiguous
// segments stay unparsed for review. Generic syntax, never note contents.
// Split comma-joined statements stating separate evaluations (`Ep = ... =
// $1, Ee = ... = $2`) into ordered parts. Only when at least one part
// states a chained evaluation; parts without `=` then drop (or promote as
// bare comparisons) while plain comma bindings (`A=$1, B=$2`) stay one step
// for the multi-output reader. Thousands separators and parenthesized
// commas never split.

function splitCommaStatements(body) {
  const text = String(body ?? '');
  if (!text.includes(',')) return [text];
  const parts = splitTopLevelComma(text).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (parts.length < 2) return [text];
  const eqCounts = parts.map((p) => {
    let n = 0;
    for (let i = 0; i < p.length; i += 1) if (isStandaloneEquals(p, i)) n += 1;
    return n;
  });
  if (!eqCounts.some((n) => n >= 2)) return [text];
  return parts;
}

// Split a trailing parenthesized comparison (`Out=$1 (> $0)`) into its main
// statement and a check step. The check restates the comparison against the
// main statement's evidenced output (or its own explicit variable when the
// parenthesis names one); the verbatim parenthesis is kept as the check's
// original text. A leading `label:` inside the parenthesis is skipped when
// detecting the comparison. Anything else stays whole.
function splitTrailingComparison(part) {
  const text = String(part ?? '').trim();
  if (!text.includes('=')) return null;
  const m = /\(([^()]*)\)\s*$/.exec(text);
  if (!m) return null;
  const inner = m[1].trim().replace(/^([A-Za-z_][A-Za-z0-9_. -]*):\s+(.+)$/, '$2').trim();
  const main = text.slice(0, m.index).trim();
  if (!main.includes('=')) return null;
  let output = '';
  let op = '';
  let right = '';
  const led = /^(>=|<=|>|<)\s*(.+?)\s*$/.exec(inner);
  if (led) {
    const split = splitAssignmentSegment(main) ?? splitChainedEquality(main);
    if (!split || !split.output) return null;
    output = split.output;
    op = led[1];
    right = led[2].trim();
  } else {
    const cmp = /^(.+?)\s*(>=|<=|>|<)\s*(.+?)\s*$/.exec(inner);
    if (!cmp) return null;
    const statedLeft = cmp[1].trim();
    if (cmp[2] === '>' && /-$/.test(statedLeft)) return null;
    if (cmp[2] === '<' && /^[-=]/.test(cmp[3].trim())) return null;
    const run = trailingOutputRun(statedLeft, 4);
    if (!run || run.start !== 0) return null;
    output = run.output;
    op = cmp[2];
    right = cmp[3].trim();
  }
  if (!output || !op || !right) return null;
  if (!/[A-Za-z0-9_$,]/.test(right)) return null;
  return { main, check: `${output} ${op} ${right}`, verbatim: m[0].trim() };
}

function promoteWorkedNotesToSteps({ notes, sourcePages }) {
  const pages = normalizePages(sourcePages ?? []);
  const segments = splitTopLevel(String(notes ?? ''), ';')
    .flatMap((s) => String(s ?? '').split(/\n+/))
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  const steps = [];
  const push = (instruction, originalText) => {
    const step = { sequence: steps.length + 1, instruction, source_pages: [...pages] };
    if (originalText) step.original_text = originalText;
    steps.push(step);
  };
  for (const segment of segments) {
    const body = stripTrailingProseSentence(segment);
    for (const part of splitCommaStatements(body)) {
      const split = splitTrailingComparison(part);
      if (split) {
        push(split.main);
        push(split.check, split.verbatim);
        continue;
      }
      if (!part.includes('=')) {
        if (tryParseBareComparison(part)) push(part);
        continue;
      }
      push(part);
    }
  }
  return steps;
}

export function createRatingRoutine({
  id = null,
  routine_id,
  name = '',
  title,
  kind = 'formula',
  sourcePages,
  source_pages,
  source_type,
  sourceType,
  source_location,
  sourceLocation,
  evidenceText,
  evidence_text,
  evidence,
  expressionText,
  expression_text,
  conditions = [],
  conditions_detailed,
  conditionsDetailed = [],
  steps = [],
  steps_detailed,
  stepsDetailed = [],
  dependsOn,
  depends_on,
  dependencies = [],
  inputs = [],
  outputs = [],
  purpose = '',
  applicability = '',
  execution_context,
  executionContext = '',
  notes = '',
  review_status,
  reviewStatus = '',
  confidence = null,
} = {}) {
  const normSteps = normalizeStepLists({ steps, steps_detailed: steps_detailed ?? stepsDetailed });
  const normConds = normalizeConditionLists({ conditions, conditions_detailed: conditions_detailed ?? conditionsDetailed });
  const normDeps = normalizeDependencyLists({ depends_on: dependsOn ?? depends_on, dependencies });
  const expressionTextStr = String(expressionText ?? expression_text ?? '');
  // Worked examples carry illustrative instance selections (`Tally limit
  // $1,000,000`), not reusable variables: their inputs stay verbatim while
  // every other kind still cleans to reusable terms.
  const isWorkedExample = normalizeRoutineKind(kind, {
    steps: normSteps.steps,
    stepsDetailed: normSteps.steps_detailed,
    expressionText: expressionTextStr,
    conditions: normConds.conditions,
    conditionsDetailed: normConds.conditions_detailed,
  }) === 'worked_example';
  let normInputs = normalizeStringList(inputs)
    .map((v) => (isWorkedExample ? String(v ?? '').trim() : cleanStepInputValue(v)))
    .filter((v) => v && String(v).trim());
  let normOutputs = normalizeStringList(outputs)
    .map(cleanStepOutputValue)
    .filter((v) => v && String(v).trim());
  if ((isEffectivelyEmpty(normInputs) || isEffectivelyEmpty(normOutputs)) && expressionTextStr.trim()) {
    const parsed = parseAssignmentOperands(expressionTextStr);
    if (parsed) {
      if (isEffectivelyEmpty(normInputs) && parsed.inputs.length > 0) normInputs = parsed.inputs;
      if (isEffectivelyEmpty(normOutputs) && parsed.outputs.length > 0) normOutputs = parsed.outputs;
    }
  }
  const normKind = isWorkedExample ? 'worked_example' : normalizeRoutineKind(kind, {
    steps: normSteps.steps,
    stepsDetailed: normSteps.steps_detailed,
    expressionText: expressionTextStr,
    conditions: normConds.conditions,
    conditionsDetailed: normConds.conditions_detailed,
  });
  let finalSteps = normSteps.steps;
  let finalDetailed = normSteps.steps_detailed;
  resolveStepBackrefs(finalDetailed);
  const hasSteps = finalSteps.some((s) => String(s ?? '').trim()) || finalDetailed.length > 0;
  if (normKind === 'worked_example' && !hasSteps && !expressionTextStr.trim()) {
    const promoted = promoteWorkedNotesToSteps({ notes: String(notes ?? ''), sourcePages: sourcePages ?? source_pages ?? [] });
    if (promoted.length > 0) {
      const promotedSteps = normalizeStepLists({ steps: promoted });
      finalSteps = promotedSteps.steps;
      finalDetailed = promotedSteps.steps_detailed;
      resolveStepBackrefs(finalDetailed);
    }
  }
  canonicalizeStepReferences(finalDetailed);
  return {
    id: id ?? routine_id ?? null,
    name: String(title ?? name ?? ''),
    kind: normKind,
    source_pages: normalizePages(sourcePages ?? source_pages ?? []),
    source_type: String(source_type ?? sourceType ?? ''),
    source_location: String(source_location ?? sourceLocation ?? ''),
    evidence_text: String(evidenceText ?? evidence_text ?? evidence ?? ''),
    expression_text: expressionTextStr,
    conditions: normConds.conditions,
    conditions_detailed: normConds.conditions_detailed,
    steps: finalSteps,
    steps_detailed: finalDetailed,
    depends_on: normDeps.depends_on,
    dependencies: normDeps.dependencies,
    inputs: normInputs,
    outputs: normOutputs,
    purpose: String(purpose ?? ''),
    applicability: String(applicability ?? ''),
    execution_context: String(execution_context ?? executionContext ?? ''),
    notes: String(notes ?? ''),
    review_status: String(review_status ?? reviewStatus ?? ''),
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

// Recognized blank/missing markers: generic missing-value vocabulary only
// (never domain wording). Standalone "None" is a legitimate "no
// adjustment" value, never a marker.
export const BLANK_SENTINEL_PATTERN = /^\[?\s*(not specified|unspecified|blank(?:\s*-\s*n\/a)?|n\/a|\bna\b|tbd|to be determined|missing|unknown|not available|unpopulated)\s*\]?$/i;

export function isBlankSentinel(text) {
  const s = String(text ?? '').trim();
  if (!s || /^none$/i.test(s)) return false;
  return BLANK_SENTINEL_PATTERN.test(s);
}

function normalizeCellValue(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean' || typeof c === 'bigint') return String(c);
  if (typeof c === 'object') {
    if (typeof c.value === 'string' || typeof c.value === 'number') return String(c.value);
    if (typeof c.text === 'string') return c.text;
    return String(c.label ?? c.name ?? '');
  }
  return String(c);
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return { rows: [], originalCells: {} };
  const originalCells = {};
  const out = rows.map((r, ri) => {
    const arr = Array.isArray(r) ? r : [r];
    return arr.map((c, ci) => {
      const raw = normalizeCellValue(c);
      if (raw === '') return null;
      if (raw.trim() === '' || isBlankSentinel(raw)) {
        originalCells[`${ri}:${ci}`] = raw;
        return null;
      }
      return raw;
    });
  });
  return { rows: out, originalCells };
}

// Merge re-derived cell originals with carried ones (review round-trips):
// carried entries survive only for cells that are still null with no fresh
// record, so reviewer-filled cells never keep stale originals.
function mergeOriginalCells(rows, fresh, incoming) {
  const out = { ...fresh };
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const [key, value] of Object.entries(incoming)) {
      if (!/^\d+:\d+$/.test(key) || key in out) continue;
      const original = String(value ?? '');
      if (!original) continue;
      const [rs, cs] = key.split(':').map(Number);
      const row = rows[rs];
      if (!Array.isArray(row) || cs >= row.length || row[cs] !== null) continue;
      out[key] = original;
    }
  }
  return out;
}

function normalizeStringList(value) {
  if (value === null || value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
      return String(v.label ?? v.name ?? v.variable ?? v.field ?? v.value ?? v.text ?? '');
    }
    return String(v);
  });
}

function normalizeOneColumn(entry, index) {
  if (entry === null || entry === undefined) {
    return { label: '', original_label: '', order: index + 1 };
  }
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
    const label = String(entry);
    return { label, original_label: label, order: index + 1 };
  }
  if (typeof entry === 'object') {
    const original = String(entry.original_label ?? entry.label ?? entry.name ?? entry.header ?? entry.title ?? '');
    const label = String(entry.label ?? entry.name ?? entry.header ?? original);
    const orderNum = Number(entry.order);
    const out = {
      label,
      original_label: original || label,
      order: Number.isInteger(orderNum) && orderNum > 0 ? orderNum : index + 1,
    };
    const dataType = entry.data_type ?? entry.type ?? entry.datatype;
    if (dataType !== undefined && dataType !== null && String(dataType) !== '') out.data_type = String(dataType);
    if (entry.role !== undefined && entry.role !== null && String(entry.role) !== '') out.role = String(entry.role);
    const units = entry.units ?? entry.unit ?? entry.currency;
    if (units !== undefined && units !== null && String(units) !== '') out.units = String(units);
    const evidence = entry.evidence ?? entry.evidence_text;
    if (evidence !== undefined && evidence !== null && String(evidence) !== '') out.evidence = String(evidence);
    if (entry.display_label !== undefined && entry.display_label !== null && String(entry.display_label) !== '') {
      out.display_label = String(entry.display_label);
    }
    if (entry.confidence !== undefined && entry.confidence !== null) out.confidence = entry.confidence;
    return out;
  }
  return { label: String(entry), original_label: String(entry), order: index + 1 };
}

function normalizeHeadersAndColumns({ headers, columns }) {
  const hdrInput = Array.isArray(headers) ? headers.map((h) => String(h ?? '')) : [];
  const colInput = Array.isArray(columns) ? columns : [];
  let cols = colInput.map((c, i) => normalizeOneColumn(c, i));
  if (cols.length === 0 && hdrInput.length > 0) {
    cols = hdrInput.map((h, i) => ({ label: h, original_label: h, order: i + 1 }));
    return { headers: hdrInput, columns: cols };
  }
  if (hdrInput.length === 0 && cols.length > 0) {
    return { headers: cols.map((c) => c.label), columns: cols };
  }
  if (hdrInput.length > 0 && cols.length > 0) {
    const max = Math.max(hdrInput.length, cols.length);
    const mergedHeaders = [];
    const mergedCols = [];
    for (let i = 0; i < max; i += 1) {
      const h = hdrInput[i] ?? cols[i]?.label ?? '';
      const old = cols[i];
      mergedHeaders.push(String(h ?? ''));
      if (old) {
        mergedCols.push({
          ...old,
          label: String(h ?? old.label ?? ''),
          original_label: String(old.original_label ?? old.label ?? h ?? ''),
        });
      } else {
        mergedCols.push({ label: String(h ?? ''), original_label: String(h ?? ''), order: i + 1 });
      }
    }
    return { headers: mergedHeaders, columns: mergedCols };
  }
  return { headers: [], columns: [] };
}

function normalizeContinuation(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const s = String(value);
    return s ? s : null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (k === 'source_pages' || k === 'sourcePages') {
        out.source_pages = normalizePages(v);
      } else if (typeof v === 'object') {
        out[k] = v;
      } else {
        out[k] = String(v);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return String(value);
}

function displayTextOfStep(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'object') {
    return String(obj.instruction ?? obj.text ?? obj.expression ?? obj.operand ?? obj.operation ?? obj.name ?? '');
  }
  return String(obj);
}

function normalizeOneStep(entry, index) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') return null;
  if (typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {};
  const seq = Number(entry.sequence ?? entry.step ?? entry.order ?? entry.number);
  if (Number.isInteger(seq)) out.sequence = seq;
  else if (entry.sequence !== undefined && entry.sequence !== null && String(entry.sequence) !== '') {
    out.sequence = String(entry.sequence);
  }
  const instruction = entry.instruction ?? entry.text ?? entry.name;
  if (instruction !== undefined && instruction !== null) out.instruction = String(instruction);
  if (entry.operation !== undefined && entry.operation !== null && String(entry.operation) !== '') {
    out.operation = String(entry.operation);
  }
  if (entry.expression !== undefined && entry.expression !== null) out.expression = String(entry.expression);
  if (entry.operand !== undefined && entry.operand !== null) out.operand = String(entry.operand);
  if (entry.inputs !== undefined) out.inputs = normalizeStringList(entry.inputs);
  if (entry.output !== undefined && entry.output !== null) out.output = String(entry.output);
  if (entry.stated_results !== undefined && entry.stated_results !== null && Array.isArray(entry.stated_results)) {
    const stated = [];
    for (const s of entry.stated_results) {
      const output = String(s?.output ?? '').trim();
      const value = String(s?.value ?? '').trim();
      if (!output || !value) continue;
      stated.push({ output, value });
    }
    if (stated.length > 0) out.stated_results = stated;
  }
  if (entry.depends_on !== undefined || entry.dependsOn !== undefined) {
    out.depends_on = normalizeStringList(entry.depends_on ?? entry.dependsOn);
  }
  const pages = entry.source_pages ?? entry.sourcePages;
  if (pages !== undefined) out.source_pages = normalizePages(pages);
  const loc = entry.source_location ?? entry.sourceLocation;
  if (loc !== undefined && loc !== null && String(loc) !== '') out.source_location = String(loc);
  const ev = entry.evidence ?? entry.evidence_text ?? entry.evidenceText;
  if (ev !== undefined && ev !== null) out.evidence = String(ev);
  const status = entry.interpretation_status ?? entry.interpretationStatus ?? entry.status;
  if (status !== undefined && status !== null && String(status) !== '') out.interpretation_status = String(status);
  if (entry.original_text !== undefined && entry.original_text !== null) out.original_text = String(entry.original_text);
  // Source grid cells carried verbatim for auditability (see the extraction
  // prompt's cells guidance): every string-valued role entry passes through
  // untouched, whatever the role names are. Cells are evidence, never
  // interpretation — downstream parsing and validation must not treat them
  // as an operation, operand, or dependency.
  if (entry.cells !== undefined && entry.cells !== null && typeof entry.cells === 'object' && !Array.isArray(entry.cells)) {
    const cells = {};
    for (const [key, value] of Object.entries(entry.cells)) {
      const role = String(key ?? '').trim().toLowerCase();
      if (!role || value === undefined || value === null) continue;
      const text = String(value);
      if (!text.trim()) continue;
      cells[role] = text;
    }
    if (Object.keys(cells).length > 0) out.cells = cells;
  }
  promoteInstructionAssignments(out);
  promoteExplicitStepExpression(out);
  enrichSparseStep(out);
  sanitizeExplicitStep(out);
  enrichRoundingTarget(out);
  return out;
}

// When a step's instruction states several assignments in source order but
// its structured expression carries only the last one, promote the full
// ordered sequence into the expression so every assignment keeps its row
// group and order downstream. Evidence-gated: the instruction must parse
// cleanly to at least two assignments and its last segment must equal the
// structured expression (or the expression must be empty on an
// assignment-like step); anything else keeps the model's structure with
// the instruction retained verbatim. Generic syntax, never step contents.
function promoteInstructionAssignments(out) {
  if (!out || !String(out.instruction ?? '').trim()) return;
  const expr = String(out.expression ?? '').trim();
  if (expr && splitTopLevel(expr, ';').filter((s) => String(s ?? '').trim()).length > 1) return;
  const scanned = parseTrailingAssignments(out.instruction);
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\.\s*$/, '').toLowerCase();
  if (scanned && scanned.segments.length >= 2) {
    const last = scanned.segments[scanned.segments.length - 1];
    if (!expr) {
      const op = String(out.operation ?? '').toLowerCase();
      if (!op || op === 'expression' || op === 'assignment') {
        out.expression = scanned.expression;
        if (!String(out.output ?? '').trim()) out.output = scanned.output;
        if (!out.operation) out.operation = 'expression';
      }
      return;
    }
    const existing = splitAssignmentSegment(expr);
    if (existing && norm(existing.output) === norm(last.output) && norm(existing.rhs) === norm(last.rhs)) {
      out.expression = scanned.expression;
    }
    return;
  }
  if (!expr) return;
  anchoredPromotion(out, expr, norm);
}

// Anchored fallback for instructions where plain-word boundaries defeat the
// syntactic scan (for example a right-hand side ending in plain words before
// the next multi-word output). The model's own structured expression anchors
// the split: it must be a single assignment whose output occurs once with '='
// in the instruction, and the text before that occurrence must parse cleanly
// to at least one assignment. The prefix assignments then prepend the
// structured expression in source order. Generic syntax, never step contents.
function anchoredPromotion(out, expr, norm) {
  const existing = splitAssignmentSegment(expr);
  if (!existing) return;
  const instruction = String(out.instruction ?? '');
  const outputPattern = existing.output.trim().split(/\s+/).map((w) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (!outputPattern) return;
  const matches = [...instruction.matchAll(new RegExp(`\\b${outputPattern}\\b\\s*=(?![=>])`, 'gi'))];
  if (matches.length !== 1) return;
  const at = matches[0].index ?? -1;
  if (at <= 0) return;
  const prefix = instruction.slice(0, at);
  if (!prefix.includes('=')) return;
  const parsed = parseTrailingAssignments(prefix);
  if (!parsed || parsed.segments.length < 1) return;
  const lastPrefix = parsed.segments[parsed.segments.length - 1];
  if (norm(lastPrefix.output) === norm(existing.output) && norm(lastPrefix.rhs) === norm(existing.rhs)) return;
  const rhsText = String(existing.rhs ?? '');
  const referencesPrefix = parsed.segments.some((seg) => {
    const pattern = String(seg.output ?? '').trim().split(/\s+/).map((w) =>
      w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return pattern && new RegExp(`\\b${pattern}\\b`, 'i').test(rhsText);
  });
  if (!referencesPrefix) return;
  out.expression = `${parsed.expression}; ${existing.output} = ${existing.rhs}`;
}

// Fill a sparse explicit step object from its own instruction text: when the
// source states the operation only in prose ('Find ... in Table Q'), derive
// the structured fields so Operation/Operand/Comment populate. Explicitly
// provided fields are never overwritten.
function enrichSparseStep(out) {
  if (!out || out.operation) return;
  const instruction = out.instruction;
  if (!instruction || !String(instruction).trim()) return;
  const parsed = deriveStepDetail(instruction);
  if (!parsed || !parsed.operation) return;
  out.operation = parsed.operation;
  if (parsed.expression !== undefined && out.expression === undefined) out.expression = parsed.expression;
  if (parsed.operand !== undefined && out.operand === undefined) out.operand = parsed.operand;
  if (parsed.inputs !== undefined && out.inputs === undefined) out.inputs = parsed.inputs;
  if (parsed.output !== undefined && out.output === undefined) out.output = parsed.output;
  if (parsed.stated_results !== undefined && out.stated_results === undefined) out.stated_results = parsed.stated_results;
  if (parsed.depends_on !== undefined && out.depends_on === undefined) out.depends_on = parsed.depends_on;
  if (!out.interpretation_status) out.interpretation_status = 'inferred';
}

// Fill a missing rounding target on an explicit rounding step from its own
// instruction text (`Round only the final tallage to ...`): the target is
// explicit source wording recognized by the shared rounding-target grammar,
// never inferred. Steps whose instruction states no target keep no operand,
// so validation and the workbook keep flagging them for review.
function enrichRoundingTarget(out) {
  if (!out || String(out.operation ?? '').toLowerCase() !== 'rounding') return;
  if (String(out.operand ?? '').trim()) return;
  const parsed = tryParseRoundingAnywhere(out.instruction);
  if (!parsed || !parsed.operand) return;
  out.operand = parsed.operand;
  if (!String(out.output ?? '').trim() && parsed.output) out.output = parsed.output;
  if ((!out.inputs || out.inputs.length === 0) && parsed.inputs) out.inputs = parsed.inputs;
}

function normalizeStepLists({ steps, steps_detailed }) {
  const rawSteps = Array.isArray(steps) ? steps : [];
  const rawDetailed = Array.isArray(steps_detailed) ? steps_detailed : [];
  const display = rawSteps.map((s) => displayTextOfStep(s));
  const hasExplicitObjects = rawSteps.some((s) => s !== null && typeof s === 'object' && !Array.isArray(s));
  if (!hasExplicitObjects) {
    // Plain-string steps: keep explicit-looking carried details, regenerate
    // auto-derived ones so details stay in sync with reviewer edits. Entries
    // without a confident parse stay minimal so nothing is invented.
    const carried = rawDetailed.map((d, i) => normalizeOneStep(d, i));
    const detailed = [];
    for (let i = 0; i < display.length; i += 1) {
      const existing = carried[i];
      if (existing && Object.keys(existing).length > 0 && !looksDerivedStep(existing)) {
        detailed.push(existing);
      } else {
        const fresh = normalizeOneStep(deriveStepDetail(display[i]), i);
        if (fresh && Object.keys(fresh).length > 0) detailed.push(fresh);
      }
    }
    return { steps: display, steps_detailed: detailed };
  }
  const detailedFromSteps = [];
  rawSteps.forEach((s, i) => {
    const norm = normalizeOneStep(s, i);
    if (norm) {
      if (!norm.original_text && typeof display[i] === 'string' && display[i]) norm.original_text = display[i];
      detailedFromSteps.push({ index: i, value: norm });
    }
  });
  const detailed = rawDetailed
    .map((d, i) => normalizeOneStep(d, i))
    .filter((d) => d && Object.keys(d).length > 0);
  if (detailedFromSteps.length > 0 && detailed.length === 0) {
    const merged = display.map((text, i) => {
      const found = detailedFromSteps.find((e) => e.index === i);
      if (found) return found.value;
      return null;
    }).filter(Boolean);
    return { steps: display, steps_detailed: merged.length === display.length ? merged : detailedFromSteps.map((e) => e.value) };
  }
  if (detailedFromSteps.length > 0 && detailed.length > 0) {
    return { steps: display, steps_detailed: detailed };
  }
  if (detailedFromSteps.length > 0) {
    return { steps: display, steps_detailed: detailedFromSteps.map((e) => e.value) };
  }
  return { steps: display, steps_detailed: detailed };
}

function displayTextOfCondition(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'object') {
    return String(obj.condition ?? obj.text ?? obj.true_branch ?? obj.false_branch ?? obj.name ?? '');
  }
  return String(obj);
}

function normalizeOneCondition(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') return null;
  if (typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {};
  if (entry.condition !== undefined && entry.condition !== null) out.condition = String(entry.condition);
  if (entry.true_branch !== undefined && entry.true_branch !== null) out.true_branch = String(entry.true_branch);
  if (entry.false_branch !== undefined && entry.false_branch !== null) out.false_branch = String(entry.false_branch);
  if (entry.output !== undefined && entry.output !== null) out.output = String(entry.output);
  const referral = entry.referral_code ?? entry.referralCode ?? entry.referral;
  if (referral !== undefined && referral !== null && String(referral) !== '') out.referral_code = String(referral);
  const pages = entry.source_pages ?? entry.sourcePages;
  if (pages !== undefined) out.source_pages = normalizePages(pages);
  const loc = entry.source_location ?? entry.sourceLocation;
  if (loc !== undefined && loc !== null && String(loc) !== '') out.source_location = String(loc);
  const ev = entry.evidence ?? entry.evidence_text ?? entry.evidenceText;
  if (ev !== undefined && ev !== null) out.evidence = String(ev);
  const status = entry.interpretation_status ?? entry.interpretationStatus ?? entry.status;
  if (status !== undefined && status !== null && String(status) !== '') out.interpretation_status = String(status);
  if (entry.original_text !== undefined && entry.original_text !== null) out.original_text = String(entry.original_text);
  return Object.keys(out).length > 0 ? out : null;
}

function hasSubstantiveValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value) !== '';
}

// True when a normalized step entry looks auto-derived (safe to regenerate)
// rather than explicitly extracted (must be preserved). Source grid cells
// count as explicit-extraction evidence, so carried cells survive
// re-normalization instead of being regenerated away.
function looksDerivedStep(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const substantive = ['sequence', 'operation', 'expression', 'operand', 'inputs', 'output', 'depends_on', 'source_pages', 'source_location', 'evidence'];
  if (entry.cells && typeof entry.cells === 'object' && Object.keys(entry.cells).length > 0) return false;
  if (!substantive.some((k) => hasSubstantiveValue(entry[k]))) return true;
  return entry.interpretation_status === 'inferred'
    && entry.sequence === undefined
    && (entry.source_pages === undefined || entry.source_pages.length === 0)
    && !entry.source_location
    && !entry.evidence;
}

function looksDerivedCondition(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const substantive = ['condition', 'true_branch', 'false_branch', 'referral_code', 'output', 'source_pages', 'source_location', 'evidence'];
  if (!substantive.some((k) => hasSubstantiveValue(entry[k]))) return true;
  return entry.interpretation_status === 'inferred'
    && (entry.source_pages === undefined || entry.source_pages.length === 0)
    && !entry.source_location
    && !entry.evidence;
}

function normalizeConditionLists({ conditions, conditions_detailed }) {
  const rawConds = Array.isArray(conditions) ? conditions : [];
  const rawDetailed = Array.isArray(conditions_detailed) ? conditions_detailed : [];
  const display = rawConds.map((c) => displayTextOfCondition(c));
  const hasExplicitObjects = rawConds.some((c) => c !== null && typeof c === 'object' && !Array.isArray(c));
  if (!hasExplicitObjects) {
    // Plain-string conditions: keep explicit-looking carried details,
    // regenerate auto-derived ones so branches stay in sync with edits.
    const carried = rawDetailed.map((d) => normalizeOneCondition(d));
    const detailed = [];
    for (let i = 0; i < display.length; i += 1) {
      const existing = carried[i];
      if (existing && !looksDerivedCondition(existing)) {
        detailed.push(existing);
      } else {
        const fresh = normalizeOneCondition(deriveConditionDetail(display[i]));
        if (fresh) detailed.push(fresh);
      }
    }
    return { conditions: display, conditions_detailed: detailed };
  }
  const fromEmbedded = [];
  rawConds.forEach((c) => {
    const norm = normalizeOneCondition(c);
    if (norm) {
      if (!norm.original_text) {
        const text = displayTextOfCondition(c);
        if (text) norm.original_text = text;
      }
      fromEmbedded.push(norm);
    }
  });
  const detailed = rawDetailed.map((d) => normalizeOneCondition(d)).filter(Boolean);
  if (fromEmbedded.length > 0 && detailed.length === 0) return { conditions: display, conditions_detailed: fromEmbedded };
  if (detailed.length > 0) return { conditions: display, conditions_detailed: detailed };
  if (fromEmbedded.length > 0) return { conditions: display, conditions_detailed: fromEmbedded };
  return { conditions: display, conditions_detailed: [] };
}

function displayTextOfDependency(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'object') {
    return String(obj.target ?? obj.name ?? obj.depends_on ?? obj.value ?? '');
  }
  return String(obj);
}

function normalizeOneDependency(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') return null;
  if (typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {};
  if (entry.source !== undefined && entry.source !== null) out.source = String(entry.source);
  const target = entry.target ?? entry.name ?? entry.depends_on ?? entry.value;
  if (target !== undefined && target !== null) out.target = String(target);
  const type = entry.relationship_type ?? entry.type ?? entry.kind;
  if (type !== undefined && type !== null && String(type) !== '') out.relationship_type = String(type);
  const explicit = entry.explicit ?? entry.inferred;
  if (explicit !== undefined && explicit !== null && String(explicit) !== '') out.explicit = String(explicit);
  else if (typeof entry.explicit === 'boolean') out.explicit = entry.explicit ? 'explicit' : 'inferred';
  const pages = entry.source_pages ?? entry.sourcePages;
  if (pages !== undefined) out.source_pages = normalizePages(pages);
  const ev = entry.evidence ?? entry.evidence_text ?? entry.evidenceText;
  if (ev !== undefined && ev !== null) out.evidence = String(ev);
  return Object.keys(out).length > 0 ? out : null;
}

function isEffectivelyEmpty(list) {
  return !Array.isArray(list) || list.length === 0 || list.every((v) => !String(v ?? '').trim());
}

// Generic connective words excluded when collecting identifiers from an
// expression. Plain English, not domain vocabulary.
const NON_IDENTIFIER_WORDS = new Set(['and', 'or', 'not', 'if', 'then', 'else', 'when', 'where']);

// Extra guard for single-word captures (rounding targets, lookup outputs),
// where an article or preposition would otherwise be mistaken for a variable.
const NON_CAPTURE_WORDS = new Set([
  ...NON_IDENTIFIER_WORDS,
  'with', 'using', 'from', 'to', 'by', 'per', 'in', 'on', 'of', 'for', 'the', 'a', 'an', 'as', 'is',
]);

// Generic English verbs/prepositions/comparatives filtered when extracting
// variables from conditional prose. Plain language, not domain vocabulary.
const CONDITION_FILTER_WORDS = new Set([
  ...NON_CAPTURE_WORDS,
  'otherwise', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'does', 'do', 'did', 'exceeds', 'exceed', 'exceeding', 'exceeded',
  'below', 'above', 'greater', 'less', 'lesser', 'more', 'than',
  'equal', 'equals', 'set', 'sets',
]);

// Canonical key for variable matching: case, spacing, underscore, and
// punctuation variants of the same name compare equal ("base rate" matches
// "base_rate"). Used for traceability, never for display.
export function normalizeVariableKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function acceptableCapture(word) {
  const w = String(word ?? '').trim();
  return w !== '' && !NON_CAPTURE_WORDS.has(w.toLowerCase());
}

function identifiersOf(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*(?:\[[^\[\]{}();,=<>!+\-*/]+\])?/g)) {
    const key = m[0].toLowerCase();
    if (seen.has(key) || NON_IDENTIFIER_WORDS.has(key)) continue;
    seen.add(key);
    out.push(m[0]);
  }
  return out;
}

// A standalone `x`/`X` between two operand-like neighbors reads as
// multiplication (`Base x Factor`), while a variable named x (`y = x * 2`)
// is untouched: both neighbors must be operand characters, so an `x` after
// `=`, an operator, or at the edge stays a variable. Generic operator
// position, never variable names. Applied only to assignment right-hand
// sides and arithmetic evidence — never to bare prose, where dimensions
// (`2 x 4`) and plain words must stay literal.
const INFIX_X_MULTIPLY = /(?<=[A-Za-z0-9_)\]%])\s+[xX]\s+(?=[A-Za-z0-9_($])/g;

export function normalizeInfixMultiply(text) {
  return String(text ?? '').replace(INFIX_X_MULTIPLY, ' * ');
}

function splitMainClause(text) {
  const t = String(text ?? '');
  const idx = t.search(/,\s*(where|with)\b/i);
  return idx < 0 ? t : t.slice(0, idx);
}

// Split text on a delimiter that appears at parenthesis depth zero, so
// statement separators (`;`) split while function arguments (`f(a;b)`)
// stay intact. Generic syntax, never domain vocabulary. Exported for the
// Excel routine-step renderer, which expands each assignment segment into
// its own row group.
export function splitTopLevel(text, delimiter = ';') {
  const s = String(text ?? '');
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// True when `=` at index i is a standalone assignment rather than part of
// a comparison (`==`, `!=`, `<=`, `>=`).
function isStandaloneEquals(s, i) {
  if (s[i] !== '=') return false;
  const prev = s[i - 1] ?? '';
  const next = s[i + 1] ?? '';
  return prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>'
    && next !== '=' && next !== '>';
}

// Directive verbs opening an assignment statement (`Calculate out = ...`):
// stripped before output extraction so the verb never joins the output
// name, while genuine multi-word variables (`Ledger total`) keep their full
// name. Generic wording, never variable names.
const OUTPUT_LEAD_VERBS = /^(?:calculate[sd]?|calculating|compute[sd]?|computing|determine[sd]?|determining|derive[sd]?|deriving|evaluate[sd]?|evaluating|set|let)\s+/i;

// Trailing plain-word run before `=` (one to three words by default):
// `out`, `Ledger total`. Longer runs are truncated phrases, not evidenced
// outputs, and runs containing articles, prepositions, or connectives
// (`where y`, `the base`) are prose — both yield null so the text stays
// unparsed instead of mis-splitting. Chained equality passes four: the
// worked-result restatement corroborates the longer spaced variable.
function trailingOutputRun(left, maxWords = 3) {
  const orig = String(left ?? '');
  const s = orig.replace(/\s+$/, '').replace(OUTPUT_LEAD_VERBS, '');
  const m = /(?:^|[:;,()\s])([A-Za-z_]\w*(?:[ \t]+[A-Za-z_]\w*)*)$/.exec(s);
  if (!m) return null;
  const output = m[1].replace(/[ \t]+/g, ' ').trim();
  if (!output) return null;
  const words = output.split(' ');
  if (words.length > maxWords) return null;
  // Multi-word runs containing articles, prepositions, or connectives are
  // prose (`the base`); single tokens only refuse true connectives, so
  // one-letter variables (`a`, `x`) stay valid outputs.
  const stopWords = words.length > 1 ? NON_CAPTURE_WORDS : NON_IDENTIFIER_WORDS;
  if (words.some((w) => stopWords.has(w.toLowerCase()))) return null;
  // Locate the run in the original (pre-strip) text so segment slicing and
  // the arithmetic-operand check use true positions.
  const locator = new RegExp(`${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*$`);
  const at = locator.exec(orig);
  return { output, start: at ? at.index : 0 };
}

// Split one `output = rhs` assignment segment. The output is the trailing
// plain-word run before a standalone `=` (single or multi-word source
// variables alike, up to three words by default); hyphenated or dotted
// codes (`LX-NET = ...`) and operator-bearing left sides (`a + b = ...`)
// stay unparsed instead of partially matching. Returns { output, rhs } or
// null for comparisons, prose, and incomplete fragments. Generic syntax,
// never variable names. Callers re-splitting chained-equality output pass
// four to match what the step parser evidences.
export function splitAssignmentSegment(segment, maxWords = 3) {
  const seg = String(segment ?? '').trim().replace(/\.\s*$/, '').trim();
  if (!seg || !seg.includes('=')) return null;
  const equals = [];
  for (let i = 0; i < seg.length; i += 1) {
    if (isStandaloneEquals(seg, i)) equals.push(i);
  }
  if (equals.length !== 1) return null;
  const left = seg.slice(0, equals[0]);
  const rhs = seg.slice(equals[0] + 1).trim().replace(/[.,]\s*$/, '').trim();
  if (!rhs || !/[A-Za-z0-9_₹$€£¥]/.test(rhs)) return null;
  if (/^[=<>!]/.test(rhs) || /[+*/×÷%-]\s*$/.test(rhs)) return null;
  const run = trailingOutputRun(left, maxWords);
  if (!run) return null;
  // The output must not be the trailing operand of arithmetic left of `=`
  // (`a + b = ...` is a result form, not an assignment to `b`); prose
  // punctuation before the run (`... rounding: out = ...`) is fine.
  if (/[+*/×÷%-]\s*$/.test(left.slice(0, run.start))) return null;
  return { output: run.output, rhs };
}

// Arithmetic evidence inside a chained-equality middle: an operator, parens,
// or infix `x` multiply. A middle without one (`X = a = 5`) restates an
// alias rather than a calculation and stays unparsed.
const CHAINED_MIDDLE_OPERATOR = /[+*/%()×÷·•−^-]|\s+x\s+/i;

// Prose that disqualifies a chained-equality middle: conditions, clauses,
// and connectives (`net = gross - levy where levy = 5` is a where-clause,
// not a worked chain). Whole words only, never identifier fragments.
const CHAINED_MIDDLE_PROSE = /\b(where|whereas|with|when|if|then|else|and|or|not)\b/i;

// A worked result restating a chained calculation: a number with optional
// currency, percent, and unit words (`850.0000 units`, `$12,684.67`). A
// trailing arrow restatement (`4.0120→ 4.012`, `0.054638→ floor at 0.150`)
// is cut before the check: the arrow always introduces a restatement or
// adjustment note, kept verbatim in the instruction. Anything not starting
// with a number is prose, not a result.
function isWorkedResult(result) {
  let s = String(result ?? '').trim();
  if (!s) return false;
  s = s.replace(/(→|->)\s*[\s\S]*$/, '').trim();
  s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return /^[$€£¥₹]?\s*\d[\d,]*(\.\d+)?\s*%?(?:\s+[A-Za-z_][\w.-]*)*\s*$/.test(s);
}

// True when a chained-equality middle reads as pure arithmetic: an operator
// or infix `x` present, no clause words, and no implication arrows,
// colons, or quotes (`a => b`, `a: b`) that mark prose or a second claim.
// A worked value restated after a chained calculation, cleaned the same way
// isWorkedResult validates it: a trailing arrow restatement (`4.0120 -> 4.012`)
// and a trailing parenthetical are cut, keeping the primary stated value
// verbatim for the structured record. The instruction keeps the full text.
function cleanWorkedResult(result) {
  let s = String(result ?? '').trim().replace(/\.\s*$/, '').trim();
  s = s.replace(/(\u2192|->)\s*[\s\S]*$/, '').trim();
  s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return s;
}

// Split on commas that separate statements: depth-zero commas not followed
// by a digit, so thousands separators (`27,840`) and function arguments
// (`Round(x,2)`) never split. Generic punctuation rule, never contents.
function splitTopLevelComma(text) {
  const s = String(text ?? '');
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0 && !/[0-9]/.test(s[i + 1] ?? '')) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// Split a yields-clause (`out = value => (expr) = result`): the left side
// states a lookup or value assignment and the right side evaluates a derived
// expression against it. Returns [assignment, bare] segment shapes for the
// shared builder, or null unless both sides evidence the shape -- a clean
// assignment left of `=>` and an arithmetic left side with a worked numeric
// result right of it. A variable-like right side (`a => b = 2`) is a second
// claim, not an evaluation, and stays unparsed. Generic syntax, never names.
function splitYieldsClause(segment) {
  const seg = String(segment ?? '').trim().replace(/\.\s*$/, '').trim();
  if (!seg || !seg.includes('=>')) return null;
  let depth = 0;
  let at = -1;
  for (let i = 0; i + 1 < seg.length; i += 1) {
    const ch = seg[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === '=' && seg[i + 1] === '>') { at = i; break; }
  }
  if (at < 0) return null;
  const left = seg.slice(0, at).trim();
  const right = seg.slice(at + 2).trim();
  if (!left || !right) return null;
  const assigned = splitAssignmentSegment(left);
  if (!assigned) return null;
  const eqs = [];
  for (let i = 0; i < right.length; i += 1) {
    if (isStandaloneEquals(right, i)) eqs.push(i);
  }
  if (eqs.length !== 1) return null;
  const lhs = right.slice(0, eqs[0]).trim();
  const value = right.slice(eqs[0] + 1).trim().replace(/[.,]\s*$/, '').trim();
  if (!lhs || !value) return null;
  const run = trailingOutputRun(lhs, 4);
  if (run && !/(?:[+\-*/%()])|(?:\s+x\s+)/i.test(lhs.slice(0, run.start))) return null;
  if (!CHAINED_MIDDLE_OPERATOR.test(lhs)) return null;
  if (!isWorkedResult(value)) return null;
  return [
    assigned,
    { output: '', rhs: `${lhs} = ${cleanWorkedResult(value)}`, bare: true },
  ];
}

function isChainedMiddle(middle) {
  const m = String(middle ?? '').trim();
  if (!m || !/[A-Za-z0-9_₹$€£¥]/.test(m)) return false;
  if (/^[=<>!]/.test(m) || /[+*/×÷%-]\s*$/.test(m)) return false;
  if (!CHAINED_MIDDLE_OPERATOR.test(m)) return false;
  if (CHAINED_MIDDLE_PROSE.test(m)) return false;
  if (/[:!?'"]/.test(m)) return false;
  if (/=>|->|→/.test(m)) return false;
  return true;
}

// Split one chained-equality segment (`out = <arithmetic> [= <worked
// evaluation>...] = <worked result>`): the output assigns the first
// arithmetic middle while each following link re-evaluates it and the
// trailing number restates its worked value. Returns { output, rhs: first
// middle } or null unless every part evidences the shape -- a variable
// output, arithmetic middles, and a numeric result -- so comparisons,
// where-clauses, and prose chains stay unparsed. Generic syntax, never
// variable names.
function splitChainedEquality(segment) {
  const seg = String(segment ?? '').trim().replace(/\.\s*$/, '').trim();
  if (!seg || !seg.includes('=')) return null;
  const equals = [];
  for (let i = 0; i < seg.length; i += 1) {
    if (isStandaloneEquals(seg, i)) equals.push(i);
  }
  if (equals.length < 2) return null;
  const left = seg.slice(0, equals[0]);
  const middles = [];
  for (let k = 0; k + 1 < equals.length; k += 1) {
    middles.push(seg.slice(equals[k] + 1, equals[k + 1]).trim());
  }
  const result = seg.slice(equals[equals.length - 1] + 1).trim().replace(/[.,]\s*$/, '').trim();
  if (!middles.every(isChainedMiddle)) return null;
  if (!isWorkedResult(result)) return null;
  const run = trailingOutputRun(left, 4);
  if (!run) return null;
  if (/[+*/×÷%-]\s*$/.test(left.slice(0, run.start))) return null;
  return { output: run.output, rhs: middles[0], stated: cleanWorkedResult(result) };
}

// Split an instruction stating several assignments without `;` separators
// (`Alpha = a+b Beta final = Alpha+c`): every standalone `=` evidences an
// output (the trailing plain-word run before it) and each segment spans
// from one output start to the next, in source order. Returns the segment
// list or null when any boundary is uncertain — prose between assignments,
// an operator-tailed right-hand side, or an output-looking fragment that
// reaches into the previous right-hand side all fail safe to null.
function scanInstructionAssignments(main) {
  const s = String(main ?? '');
  if (s.includes(';')) return null;
  const equals = [];
  for (let i = 0; i < s.length; i += 1) {
    if (isStandaloneEquals(s, i)) equals.push(i);
  }
  if (equals.length < 2) return null;
  const outputs = [];
  for (const eq of equals) {
    const run = trailingOutputRun(s.slice(0, eq));
    if (!run) return null;
    // The run must not be the trailing operand of arithmetic (`a + b = ...`
    // is a result form, not an assignment to `b`).
    const sincePrevEq = s.slice(outputs.length > 0 ? outputs[outputs.length - 1].eq + 1 : 0, run.start);
    if (/[+*/×÷%-]\s*$/.test(sincePrevEq)) return null;
    outputs.push({ ...run, eq });
  }
  // Every output must begin after the previous `=`; otherwise the run
  // reached back into earlier text and the boundary is uncertain.
  for (let i = 1; i < outputs.length; i += 1) {
    if (outputs[i].start <= outputs[i - 1].eq) return null;
  }
  const segments = [];
  for (let i = 0; i < outputs.length; i += 1) {
    const start = outputs[i].start;
    const end = i + 1 < outputs.length ? outputs[i + 1].start : s.length;
    if (end <= outputs[i].eq) return null;
    const rhs = s.slice(outputs[i].eq + 1, end).trim().replace(/[.,]\s*$/, '').trim();
    if (!rhs || !/[A-Za-z0-9_₹$€£¥]/.test(rhs)) return null;
    if (/^[=<>!]/.test(rhs) || /[+*/×÷%-]\s*$/.test(rhs)) return null;
    const between = s.slice(outputs[i].eq + 1, end);
    if (between.includes('=')) return null;
    segments.push({ output: outputs[i].output, rhs });
  }
  return segments;
}

// Collect input variables from an assignment right-hand side into
// `inputs` (source order, deduplicated). Consecutive words with no
// operator between them form one multi-word variable (`Ledger core`),
// since adjacent words cannot be separate variables in valid arithmetic;
// connectives (`and`, `or`) break runs, function names (a run directly
// followed by `(`) are skipped, and same-step `defined` outputs never
// count. Generic syntax, never variable names.
function assignmentInputVars(rhs, definedLower, seenLower, inputs) {
  const s = String(rhs ?? '');
  const wordRe = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*(?:\[[^\[\]{}();,=<>!+\-*/]+\])?/g;
  let run = [];
  let lastEnd = -1;
  const flush = (afterPos) => {
    if (run.length === 0) return;
    let words = run;
    run = [];
    if (/^\s*\(/.test(s.slice(afterPos))) words = words.slice(0, -1);
    if (words.length === 0) return;
    const phrase = words.join(' ');
    const key = phrase.toLowerCase();
    if (definedLower.has(key) || seenLower.has(key)) return;
    seenLower.add(key);
    inputs.push(phrase);
  };
  let m;
  while ((m = wordRe.exec(s)) !== null) {
    if (lastEnd >= 0) {
      const gap = s.slice(lastEnd, m.index);
      if (!/^[ \t]+$/.test(gap) || /^\s*\(/.test(s.slice(lastEnd))) flush(lastEnd);
    }
    const bare = !m[0].includes('-') && !m[0].includes('.') && NON_IDENTIFIER_WORDS.has(m[0].toLowerCase());
    if (bare) {
      flush(m.index);
      lastEnd = m.index + m[0].length;
      continue;
    }
    run.push(m[0]);
    lastEnd = m.index + m[0].length;
  }
  flush(lastEnd < 0 ? 0 : lastEnd);
}

// Build the { segments, expression, output, inputs } result shared by the
// `;`-separated and scanned assignment paths. Right-hand sides keep their
// source text (including `x` multiply); inputs derive from a normalized
// copy so infix `x` never becomes a variable. Within-step definitions and
// function names never count as inputs.
function buildAssignmentResult(segments) {
  if (!segments || segments.length === 0) return null;
  const assigned = segments.filter((s) => !s.bare);
  const defined = new Set(assigned.map((s) => String(s.output ?? '').toLowerCase()).filter(Boolean));
  for (const s of segments) s.rhs = splitHyphenSubtraction(s.rhs, defined);
  const expression = segments.map((s) => (s.bare ? s.rhs : `${s.output} = ${s.rhs}`)).join('; ');
  const output = assigned.length > 0 ? assigned[assigned.length - 1].output : '';
  const seen = new Set();
  const inputs = [];
  for (const s of segments) assignmentInputVars(normalizeInfixMultiply(s.rhs), defined, seen, inputs);
  const result = { segments, expression, output, inputs };
  const stated = [];
  for (const s of segments) {
    if (s.stated && s.output) stated.push({ output: s.output, value: s.stated });
  }
  if (stated.length > 0) result.stated_results = stated;
  return result;
}

// Function names called in an expression (`round_half_up(...)`, `min(...)`):
// identifiers immediately followed by an opening parenthesis. Such names
// are invocations, never variable references, so they are excluded from
// step inputs. Generic call syntax, never function names.
function functionNamesIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

// An unspaced hyphen between identifier parts (`Premstep6-Discncb`,
// `fee_factor-1.0`) reads as subtraction only when either side names a value
// defined by the same step; otherwise it stays a hyphenated code (`OD-01`,
// `HD-001`). Inserts spaces around such hyphens so tokenizers split the
// subtraction while codes stay whole. Generic: driven by same-step
// outputs, never by names. Exported for the Excel renderer and the
// validator, which apply the same split.
export function splitHyphenSubtraction(rhs, definedLower) {
  const defined = definedLower instanceof Set ? definedLower
    : new Set((Array.isArray(definedLower) ? definedLower : []).map((s) => String(s ?? '').toLowerCase()));
  if (defined.size === 0) return String(rhs ?? '');
  return String(rhs ?? '').replace(/([A-Za-z0-9_]+)-([A-Za-z0-9_][A-Za-z0-9_]*)/g, (m, left, right) => {
    if (defined.has(String(left).toLowerCase()) || defined.has(String(right).toLowerCase())) {
      return `${left} - ${right}`;
    }
    return m;
  });
}

function identifiersExcludingFunctions(text) {
  const funcs = functionNamesIn(text);
  if (funcs.size === 0) return identifiersOf(text);
  return identifiersOf(text).filter((v) => !funcs.has(String(v).toLowerCase()));
}

// Parse explicit `output = rhs` assignments stated anywhere in a step body:
// after a colon (`Compute base: out=a*b`), with lookup context, several
// assignments separated by top-level semicolons (`a=x*y; b=a-z`), or
// several assignments stated in sequence without separators
// (`Alpha = a+b Beta final = Alpha+c`). Outputs may be single or
// multi-word source variables. Each segment must carry exactly one
// standalone `=` with a valid output and a non-empty right-hand side;
// anything else yields null so prose, comparisons, and incomplete
// fragments stay unparsed. Returns
// { segments: [{ output, rhs }], expression, output, inputs } or null.
// Inputs exclude same-step intermediate outputs and function names so
// within-step definitions never warn as unresolved references.
function parseTrailingAssignments(body) {
  const main = splitMainClause(String(body ?? ''));
  if (!main || !main.includes('=')) return null;
  const rawSegments = splitTopLevel(main, ';').map((s) => String(s ?? '').trim()).filter(Boolean);
  if (rawSegments.length > 1) {
    // `;`-separated statements: every segment must parse; anything else
    // fails the whole body rather than guessing across fragments.
    const segments = [];
    for (const raw of rawSegments) {
      const yields = splitYieldsClause(raw);
      if (yields) {
        segments.push(...yields);
        continue;
      }
      const split = splitAssignmentSegment(raw);
      if (!split) return null;
      segments.push(split);
    }
    return buildAssignmentResult(segments);
  }
  const yields = splitYieldsClause(rawSegments[0] ?? '');
  if (yields) return buildAssignmentResult(yields);
  const single = splitAssignmentSegment(rawSegments[0] ?? '');
  if (single) return buildAssignmentResult([single]);
  const scanned = scanInstructionAssignments(main);
  if (scanned) return buildAssignmentResult(scanned);
  return null;
}

// Parse worked steps mixing plain and chained-equality assignments
// (`A = 3.40 x 1.180 = 4.0120; B = $380.54`): every `;`-separated statement
// must parse as one or the other, with at least one chained segment (pure
// single-assignment bodies stay with parseTrailingAssignments). Returns the
// same { segments, expression, output, inputs } shape, with worked results
// excluded from the expression — the instruction keeps them verbatim.
function parseChainedAssignments(body) {
  const main = splitMainClause(String(body ?? ''));
  if (!main || !main.includes('=')) return null;
  const rawSegments = splitTopLevel(main, ';').map((s) => String(s ?? '').trim()).filter(Boolean);
  if (rawSegments.length === 0) return null;
  let sawChained = false;
  const segments = [];
  for (const raw of rawSegments) {
    const single = splitAssignmentSegment(raw);
    if (single) {
      segments.push(single);
      continue;
    }
    const yields = splitYieldsClause(raw);
    if (yields) {
      segments.push(...yields);
      continue;
    }
    const chained = splitChainedEquality(raw);
    if (!chained) return null;
    sawChained = true;
    segments.push(chained);
  }
  if (!sawChained) return null;
  return buildAssignmentResult(segments);
}

// Parse an explicit top-level assignment `output = rhs`. The output leads
// the text (one to three plain words: `out`, `Ledger total`); prose,
// comparisons, and incomplete fragments yield null. Right-hand sides keep
// their source text while inputs derive from a normalized copy, so infix
// `x` multiply and function names never become variables. Exported for the
// Excel routine-step renderer and routine input/output derivation.
export function parseAssignmentOperands(text) {
  const t = String(text ?? '').trim();
  if (!t || /^(if|else|when|otherwise)\b/i.test(t)) return null;
  const main = splitMainClause(t).replace(/^\s+/, '').replace(OUTPUT_LEAD_VERBS, '');
  const m = /^\s*([A-Za-z_]\w*(?:[ \t]+[A-Za-z_]\w*)*)\s*=(?![=>])\s*([\s\S]+?)\s*$/.exec(main);
  if (!m || !m[2].trim()) return null;
  const output = m[1].replace(/[ \t]+/g, ' ').trim();
  const words = output.split(' ');
  if (words.length > 3) return null;
  const stopWords = words.length > 1 ? NON_CAPTURE_WORDS : NON_IDENTIFIER_WORDS;
  if (words.some((w) => stopWords.has(w.toLowerCase()))) return null;
  if (/^[=<>!]/.test(m[2].trim())) return null;
  const inputs = [];
  assignmentInputVars(normalizeInfixMultiply(m[2]), new Set([output.toLowerCase()]), new Set(), inputs);
  return { inputs, outputs: [output] };
}

function stripStepLabel(text) {
  const withoutStep = String(text ?? '').replace(/^\s*(?:step\s*\d+\s*[:.)\-—–]?\s*)+/i, '');
  // Bare numbering ('1 Find ...', '1. Find ...', '(1) Find ...') strips only
  // when a letter follows, so quantities, decimals, and hyphenated terms
  // ('350 units', '1.20 ...', '2-factor ...') are never touched.
  return withoutStep.replace(/^\s*(?:\(\d{1,3}\)\s*|\d{1,3}\s*[:.)]\s*|\d{1,2}\s+)(?=[A-Za-z])/, '').trim();
}

function splitKeys(text) {
  return String(text ?? '')
    .split(/\s+and\s+|,/i)
    .map((k) => k.trim().replace(/[.]+$/, '').trim())
    .map((k) => k.replace(/^(the|a|an)\s+/i, '').trim())
    .filter(Boolean);
}

// Drop a lowercase prose article from a table mention ("in the Base rating
// table" refers to "Base rating table"). Capitalized names stay verbatim so a
// table actually named "The Ledger" keeps its exact reference.
// A result label standing before an imperative clause (`Base tallage:
// Select ...`, `Zone scaling: Multiply ... by ...`). The label names the
// step's result; the clause states the operation. Split only when the clause
// opens with a confident imperative verb — assignments, bare arithmetic,
// and conditionals already handle embedded forms without a split, so they
// never trigger one. Returns { label, clause } or null. Generic punctuation
// shape, never label contents.
const IMPERATIVE_VERBS = '(?:multiply|multiplies|divide|divides|add|adds|subtract|subtracts)';

function isVerbClauseStart(clause) {
  const text = String(clause ?? '');
  if (new RegExp(`^${LOOKUP_VERBS}\\b`, 'i').test(text)) return true;
  return new RegExp(`^${IMPERATIVE_VERBS}\\b`, 'i').test(text);
}

function splitLabelClause(body) {
  const text = String(body ?? '');
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const label = text.slice(0, at).trim();
  const clause = text.slice(at + 1).trim();
  if (!label || !clause) return null;
  if (!/[A-Za-z]/.test(label)) return null;
  if (/=/.test(label)) return null;
  if (label.split(/\s+/).filter(Boolean).length > 4) return null;
  if (!isVerbClauseStart(clause)) return null;
  return { label, clause };
}

// True for a `Step N result`-style label: a back-reference to another step,
// never a result name, so it must not become an output variable.
function isStepBackrefLabel(label) {
  return /^(?:the\s+)?step\s+\d{1,4}\s+(?:result|output|value)s?$/i.test(String(label ?? '').trim());
}

// Explicit imperative arithmetic (`Multiply A by B`, `Divide A by B`,
// `Add A to B`, `Subtract A from B`): both operands stated in words with a
// canonical operator. Returns { expression, inputs, depends_on } or null
// unless both operands are evidenced. Operand phrases stay verbatim (minus
// articles); only the operator glyph is canonicalized. A trailing table
// mention (`from Table Z`) is stripped from the second operand into
// depends_on; a trailing `from`/`in` phrase without a table word stays
// unparsed instead of guessing the attachment. Generic verbs and syntax,
// never operand contents.
function tryParseImperativeArithmetic(clause) {
  const text = String(clause ?? '').trim().replace(/\.\s*$/, '').trim();
  if (!text) return null;
  const forms = [
    { verb: /^(multiply|multiplies)\b/i, prep: 'by', op: '*', order: 'ab' },
    { verb: /^(divide|divides)\b/i, prep: 'by', op: '/', order: 'ab' },
    { verb: /^(add|adds)\b/i, prep: 'to', op: '+', order: 'ab' },
    { verb: /^(subtract|subtracts)\b/i, prep: 'from', op: '-', order: 'ba' },
  ];
  for (const form of forms) {
    if (!form.verb.test(text)) continue;
    const rest = text.replace(form.verb, '').trim();
    // Greedy first operand: the LAST preposition splits, so an operand that
    // itself contains the preposition word keeps its full phrase.
    const m = new RegExp(`^(.+)\\s+${form.prep}\\s+(.+)$`, 'i').exec(rest);
    if (!m) return null;
    let first = cleanImperativeOperand(m[1]);
    let second = m[2].trim();
    let table = '';
    const trailing = /\s+(?:from|in)\s+(.+?)\s*$/.exec(second);
    if (trailing && /=/.test(trailing[1])) return null;
    if (trailing && /\b(tables?|schedules?|appendix|appendices|exhibits?)\b/i.test(trailing[1])) {
      table = stripLeadingArticle(trailing[1].replace(/[.;]+\s*$/, '').trim());
      second = second.slice(0, trailing.index).trim();
    } else if (/\s+(?:from|in)\s+/i.test(second)) {
      return null;
    }
    second = cleanImperativeOperand(second);
    if (!first || !second) return null;
    const [left, right] = form.order === 'ba' ? [second, first] : [first, second];
    return {
      expression: `${left} ${form.op} ${right}`,
      inputs: [left, right],
      depends_on: table ? [table] : [],
    };
  }
  return null;
}

// One imperative operand phrase: verbatim minus a leading article and final
// punctuation. Empty without both: prose fragments, nested verbs, and
// assignments never become operands. Generic shape, never contents.
function cleanImperativeOperand(fragment) {
  const s = String(fragment ?? '').trim().replace(/[.;]+\s*$/, '').trim()
    .replace(/^(the|a|an)\s+/i, '').trim();
  if (!s || !/[A-Za-z]/.test(s)) return '';
  if (s.includes('=') || s.includes(';')) return '';
  if (/,\s*[A-Za-z]/.test(s)) return '';
  if (s.split(/\s+/).filter(Boolean).length > 6) return '';
  if (new RegExp(`^(?:${LOOKUP_VERBS}|${IMPERATIVE_VERBS}|round|if|when)\\b`, 'i').test(s)) return '';
  return s;
}

// Nested conditional clauses inside a branch (`... premium. If the policy
// covers 1 or 2 ledgers, ...`) restate their own conditions; their
// identifiers must not count as branch overlap when deriving the outer
// condition's inputs, or fragments like `policy`/`covers` become false
// inputs. Generic clause shape, never variable names.
function stripNestedConditionClauses(text) {
  return String(text ?? '').replace(/\b(?:if|when)\b[^.;]*/gi, ' ');
}

// A rounding target phrase: one to three plain words, none an article,
// preposition, connective, or adverb. Generic wording, never variable names.
function isRoundingTargetPhrase(phrase) {
  const words = String(phrase ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  return words.every((w) => acceptableCapture(w)
    && !NON_CAPTURE_WORDS.has(w.toLowerCase())
    && !/^(only|just)$/i.test(w));
}

// A function-call evaluation (`RoundHalfUp(x, 2)`): an identifier glued to a
// balanced argument list. Spaced parens (`Rate (4.50%)`) are worked-amount
// detail, never calls. Generic call syntax, never function names.
function isCallFormExpression(expr) {
  const s = String(expr ?? '').trim();
  if (!/\b[A-Za-z_]\w*\(/.test(s)) return false;
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && s.includes(')');
}

// The step label (instruction minus numbering) as an output variable: a
// short lettered phrase with no clause punctuation, assignment, or amount.
// A `Label: calculation` instruction reads its label through the colon the
// same way, since the label still names the step's result; a step
// back-reference (`Step 2 result`) never becomes a variable. Anything else
// yields '' so prose never poses as a variable.
function stepLabelForOutput(instruction) {
  let label = stripStepLabel(String(instruction ?? '')).trim().replace(/[.;]+\s*$/, '').trim();
  if (!label || !/[A-Za-z]/.test(label)) return '';
  const colon = label.indexOf(':');
  if (colon >= 0) {
    const prefix = label.slice(0, colon).trim().replace(/[.;]+\s*$/, '').trim();
    const suffix = label.slice(colon + 1).trim();
    if (!suffix) return '';
    label = prefix;
  }
  if (!label || /[=;]/.test(label)) return '';
  if (label.includes(':')) return '';
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return '';
  if (isNumericFragment(label)) return '';
  if (isStepBackrefLabel(label)) return '';
  return label;
}

// A past-tense lookup statement (`Selected tallage for LXV`): a lookup verb
// in past tense with an object and a `for` key. Returns { inputs: [key] } or
// null. Generic verbs and syntax, never object or key contents.
const PAST_LOOKUP_VERBS = '(?:selected|retrieved|found|obtained|determined|located|extracted|looked\\s+up)';

function tryParsePastTenseLookup(expr) {
  const m = new RegExp(`^${PAST_LOOKUP_VERBS}\\s+(.+?)\\s+for\\s+(.+?)\\s*$`, 'i')
    .exec(String(expr ?? '').trim().replace(/[.;]+\s*$/, ''));
  if (!m) return null;
  const key = m[2].trim().replace(/^(the|a|an)\s+/i, '').trim();
  if (!key || !/[A-Za-z0-9]/.test(key)) return null;
  if (key.split(/\s+/).filter(Boolean).length > 6) return null;
  return { inputs: [key] };
}

// A grid-row step whose instruction merges the row label and calculation
// (`2. Territory adjustment $1,050.00 × 1.00`) with the calculation also
// stated in `expression`: the extractor's own `cells.step` segmentation
// names the label, confirmed when the instruction opens with that segment
// and the remainder restates the expression. Returns the label or ''.
// Without that agreement the merge is ambiguous and stays unlabeled.
function explicitMergedGridLabel(out) {
  const cells = out?.cells && typeof out.cells === 'object' ? out.cells : null;
  const segKey = cells ? Object.keys(cells).find((k) => String(k ?? '').trim().toLowerCase() === 'step') : undefined;
  const seg = segKey ? String(cells[segKey] ?? '').trim() : '';
  if (!seg) return '';
  const inst = String(out?.instruction ?? '').trim();
  const expr = String(out?.expression ?? '').trim();
  if (!inst || !expr || !inst.startsWith(seg)) return '';
  const rest = inst.slice(seg.length).trim().replace(/^[:.;\-–—]+\s*/, '').replace(/[.;]+\s*$/, '').trim();
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!rest || norm(rest) !== norm(expr.replace(/[.;]+\s*$/, ''))) return '';
  return stepLabelForOutput(seg);
}
// Promote an explicit model-provided expression that states its own
// calculation but carries no operation: bare arithmetic (`$1,050.00 × 1.00`),
// call-form evaluations (`RoundHalfUp(...)`), and past-tense lookup
// statements (`Selected tallage for LXV`). The step label becomes the output
// variable and a bare worked amount becomes a stated result — both
// preserved, never dropped or invented. Prose without such evidence stays
// unparsed. Runs before instruction-word derivation so explicit structure
// beats re-derivation.
function promoteExplicitStepExpression(out) {
  if (!out || out.operation) return;
  const expr = String(out.expression ?? '').trim();
  if (!expr) return;
  const label = explicitMergedGridLabel(out) || stepLabelForOutput(out.instruction);
  // An assignment inside the expression names its own target (`Rloaded =
  // ...` computes Rloaded): it beats the instruction label, which may be
  // an imperative phrase (`Compute base loaded rate`) rather than a name.
  const exprTarget = splitAssignmentSegment(expr)?.output ?? '';
  const adoptOutput = () => {
    const rawOutput = String(out.output ?? '').trim();
    const cleaned = cleanStepOutputValue(rawOutput);
    if (cleaned) {
      out.output = cleaned;
      return;
    }
    const target = exprTarget || label;
    if (rawOutput && target) {
      const existing = Array.isArray(out.stated_results) ? out.stated_results : [];
      if (!existing.some((s) => String(s?.output ?? '') === target && String(s?.value ?? '') === rawOutput)) {
        out.stated_results = [...existing, { output: target, value: rawOutput }];
      }
    }
    if (target) out.output = target;
    else delete out.output;
  };
  if (hasArithmeticEvidence(expr) || isCallFormExpression(expr)) {
    out.operation = 'expression';
    adoptOutput();
    if (!out.interpretation_status) out.interpretation_status = 'inferred';
    return;
  }
  const lookup = tryParsePastTenseLookup(expr);
  if (lookup) {
    out.operation = 'lookup';
    out.inputs = lookup.inputs;
    adoptOutput();
    if (!out.interpretation_status) out.interpretation_status = 'inferred';
  }
}

// Resolve `Step N result`-style back-references in structured step inputs to
// the referenced step's evidenced output, in both inputs and the derived
// expression. Dangling references (no step N, or step N states no output)
// stay verbatim so validation keeps flagging them. The instruction keeps the
// source wording either way. Generic reference shape, never step contents.
const STEP_BACKREF = /^(?:the\s+)?step\s+(\d{1,4})\s+(?:result|output|value)s?$/i;

// Step numbers evidencing one detail entry: its explicit sequence plus any
// number its instruction opens with (`Step 2 — ...`, `2. Label`), so
// `Step N result` references resolve whether steps were extracted as objects
// or plain strings. First entry wins per number; unnumbered steps answer to
// no number rather than guessing by position. Generic numbering shapes,
// never step contents.
function stepSequenceKeys(det) {
  const keys = [];
  const seq = det?.sequence;
  if (seq !== undefined && seq !== null && String(seq).trim() !== '') {
    const n = Number(String(seq).trim());
    keys.push(Number.isInteger(n) ? String(n) : String(seq).trim());
  }
  const text = String(det?.instruction ?? det?.original_text ?? '');
  const m = /^\s*(?:step\s*(\d{1,4})\b|\(?(\d{1,3})\)?\s*[:.)\]-]\s(?=[A-Za-z]))/i.exec(text);
  const num = m ? (m[1] ?? m[2]) : null;
  if (num) {
    const key = String(Number.parseInt(num, 10));
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function resolveStepBackrefs(detailed) {
  if (!Array.isArray(detailed) || detailed.length === 0) return;
  const bySeq = new Map();
  for (const d of detailed) {
    if (!d || typeof d !== 'object') continue;
    for (const key of stepSequenceKeys(d)) {
      if (!bySeq.has(key)) bySeq.set(key, d);
    }


  }
  for (const d of detailed) {
    if (!d || !Array.isArray(d.inputs) || d.inputs.length === 0) continue;
    d.inputs = d.inputs.map((raw) => {
      const m = STEP_BACKREF.exec(String(raw ?? '').trim());
      if (!m) return raw;
      const target = bySeq.get(String(Number.parseInt(m[1], 10)));
      const output = String(target?.output ?? '').trim();
      if (!output) return raw;
      if (String(d.expression ?? '').includes(String(raw ?? '').trim())) {
        d.expression = String(d.expression ?? '').split(String(raw ?? '').trim()).join(output);
      }
      return output;
    });
  }
}

function stripLeadingArticle(text) {
  return String(text ?? '').replace(/^(the|a|an)\s+/, '').trim();
}

// Normalize table text for dash/space-insensitive comparison.
function normalizeTableText(value) {
  return String(value ?? '')
    .replace(/[\u2010-\u2015\u2212-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Asset codes embedded in a table's display name: a parenthesized code
// (`... (SYN-BASE)`) and a trailing qualified code
// (`... SYN-CRED Part A`, with generic document-structure qualifiers).
// Parenthesized ranges or prose (`(RID-001 to RID-008)`) and ordinary
// trailing words (`... Matrix`) never match, so they contribute no alias.
// Generic code shapes, never table names.
const TRAILING_QUALIFIER = '(?:Part|Section|Appendix|Schedule|Annex|Phase|Stage)';

function embeddedNameAliases(displayName) {
  const out = [];
  const s = String(displayName ?? '');
  for (const m of s.matchAll(/\(([A-Z][A-Z0-9_.-]*)\)/g)) {
    if (m[1].length >= 2) out.push(m[1]);
  }
  const trail = new RegExp(
    `((?=[A-Z0-9_.-]*[A-Z])[A-Z0-9]+[-_.][A-Z0-9_.-]*(?:\\s+${TRAILING_QUALIFIER}\\s+[A-Z0-9]+)?)\\s*$`
  ).exec(s);
  if (trail) out.push(trail[1].replace(/\s+/g, ' ').trim());
  return [...new Set(out)];
}

function isWordBoundaryPrefix(longer, shorter) {
  if (!longer.startsWith(shorter) || longer.length === shorter.length) return false;
  return !/[a-z0-9]/.test(longer[shorter.length] ?? '');
}

// Significant keywords of a table mention: drop one leading article and the
// generic word "table" so "the Protection factor table" becomes
// ["protection", "factor"] while a code like "Table A" keeps ["a"].
function tableMentionKeywords(text) {
  const norm = normalizeTableText(text);
  let words = norm.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length > 0 && (words[0] === 'the' || words[0] === 'a' || words[0] === 'an')) {
    words = words.slice(1);
  }
  return words.filter((w) => w !== 'table' && w !== 'tables');
}
// Singular/plural-insensitive keyword form: generic English plural
// inflections only (`factors` to `factor`, `policies` to `policy`,
// `classes` to `class`). Short words stay untouched so codes, numbers,
// and abbreviations never conflate. Both mention and table words pass
// through the same form, so agreement evidences the same word.
function singularKeyword(word) {
  const w = String(word ?? '');
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Every source label a table answers to: its display name plus aliases
// (asset codes, alternate titles). Matching runs over all of them.
function tableMatchNames(table) {
  const names = [table?.name, ...(table?.aliases ?? [])];
  return [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))];
}

// Every table a mention could refer to, in resolution-priority order: the
// exact id/name/alias match first, else word-boundary prefix matches in
// either direction, else keyword-subset matches (exact words first, then a
// singular/plural-insensitive fallback). Callers needing one
// confident table use resolveTableReference; callers reporting ambiguity
// use the full list. Generic matching, never table names.
export function findTableCandidates(tables, mention) {
  const raw = String(mention ?? '').trim();
  if (!raw) return [];
  const key = raw.toLowerCase();
  const keyNorm = normalizeTableText(raw);
  const list = Array.isArray(tables) ? tables : [];
  const exact = list.find((t) =>
    String(t?.id ?? '').trim().toLowerCase() === key
    || tableMatchNames(t).some((n) => n.toLowerCase() === key || normalizeTableText(n) === keyNorm));
  if (exact) return [exact];
  const prefixCandidates = list.filter((t) => tableMatchNames(t).some((n) => {
    const nameNorm = normalizeTableText(n);
    if (!nameNorm || !keyNorm || nameNorm === keyNorm) return false;
    return isWordBoundaryPrefix(nameNorm, keyNorm) || isWordBoundaryPrefix(keyNorm, nameNorm);
  }));
  if (prefixCandidates.length > 0) return prefixCandidates;
  const keywords = tableMentionKeywords(raw);
  if (keywords.length === 0) return [];
  const tableWords = (t) => new Set(tableMatchNames(t).flatMap((n) => normalizeTableText(n).split(/[^a-z0-9]+/).filter(Boolean)));
  const exactHits = list.filter((t) => {
    const words = tableWords(t);
    return keywords.every((k) => words.has(k));
  });
  if (exactHits.length > 0) return exactHits;
  // Singular/plural fallback: a mention inflected differently from the
  // table name (`territory factor` for `Territory Factors`) still names
  // the same table. Exact-word matches above keep priority, so this only
  // fires when nothing matched verbatim; uniqueness still decides.
  const stems = keywords.map(singularKeyword);
  return list.filter((t) => {
    const stemmed = new Set([...tableWords(t)].map(singularKeyword));
    return stems.every((s) => stemmed.has(s));
  });
}

// Resolve a table mention to an extracted table: exact id/name/alias match
// first (dash-insensitive), else a unique word-boundary prefix in either
// direction (short "Table 1" to long "Table 1 - ..." and long mentions to
// short extracted names), else a unique keyword-subset match for valid
// aliases ("Base property table" to "Table A - Base property rate"), with
// a singular/plural-insensitive fallback ("territory factor" to
// "Table 2. Territory Factors") when nothing matched verbatim.
// Returns the table or null when there is no single confident match.
export function resolveTableReference(tables, mention) {
  const candidates = findTableCandidates(tables, mention);
  return candidates.length === 1 ? candidates[0] : null;
}

// Table mentions evidenced at routine level: declared dependencies plus
// structured dependency targets. Generic plumbing, never contents.
function routineDependencyMentions(routine) {
  const deps = Array.isArray(routine?.dependencies) ? routine.dependencies.map((d) => d?.target) : [];
  return [...(routine?.depends_on ?? []), ...deps].map((m) => String(m ?? '').trim()).filter(Boolean);
}

// Words marking an explicit table mention. Generic document vocabulary,
// never table contents.
const TABLE_REFERENCE_WORDS = /\b(table|tables|schedule|schedules|appendix|appendices|exhibit|exhibits)\b/i;

// Resolve a mention to the table it explicitly references: an exact
// recorded id/name/alias, a unique word-boundary prefix in either
// direction ("Table 2", "Table 2 continued"), or a mention carrying an
// explicit table word ("base property table") that matches one table.
// Bare value mentions ("territory factor") never resolve through mere
// word overlap with a table title. Returns the table or null.
export function resolveExplicitTableReference(tables, mention) {
  const raw = String(mention ?? '').trim();
  const list = Array.isArray(tables) ? tables : [];
  if (!raw || list.length === 0) return null;
  const key = raw.toLowerCase();
  const keyNorm = normalizeTableText(raw);
  const exact = list.filter((t) =>
    String(t?.id ?? '').trim().toLowerCase() === key
    || tableMatchNames(t).some((n) => n.toLowerCase() === key || normalizeTableText(n) === keyNorm));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const prefix = list.filter((t) => tableMatchNames(t).some((n) => {
    const nameNorm = normalizeTableText(n);
    if (!nameNorm || !keyNorm || nameNorm === keyNorm) return false;
    return isWordBoundaryPrefix(nameNorm, keyNorm) || isWordBoundaryPrefix(keyNorm, nameNorm);
  }));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) return null;
  if (!TABLE_REFERENCE_WORDS.test(raw)) return null;
  const fuzzy = findTableCandidates(list, raw);
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

// Tables a step input draws on: the step's own `depends_on` mentions (or
// the routine's when the step states none) that resolve to tables and
// whose terms the input matches — excluding inputs
// that name a table itself (equal to or a word-boundary prefix of the table
// name), which are references rather than values drawn from the table.
// Returns the matched tables ([] when none). Generic name matching, never
// table contents. Shared by validation (unproduced-factor warnings) and the
// workbook (factor trace comments) so both agree on the same attribution.
export function stepInputTables(step, tables, name, routine = null) {
  const raw = String(name ?? '').trim();
  if (!raw) return [];
  const stepMentions = [...(step?.depends_on ?? [])].map((m) => String(m ?? '').trim()).filter(Boolean);
  // Fallback evidence when the step states no table: the routine's own
  // dependencies. Attribution only — never a lookup or an assignment.
  const mentions = stepMentions.length > 0 ? stepMentions : routineDependencyMentions(routine);
  if (mentions.length === 0) return [];
  const list = Array.isArray(tables) ? tables : [];
  const resolved = [];
  for (const m of mentions) {
    const t = resolveTableReference(list, m);
    if (t && !resolved.includes(t)) resolved.push(t);
  }
  if (resolved.length === 0) return [];
  return findTableCandidates(resolved, raw).filter((t) => !namesTableItself(t, raw));
}

// True when a reference names the table itself rather than a value within
// it: equal to or a word-boundary prefix of one of the table's match names
// (`Table 2` for `Table 2. Territory Factors`), so table-name references
// never read as factor usages.
function namesTableItself(table, raw) {
  const mention = normalizeTableText(raw);
  if (!mention) return false;
  return tableMatchNames(table).some((n) => {
    const norm = normalizeTableText(n);
    return norm === mention || isWordBoundaryPrefix(norm, mention);
  });
}

// Shared reference predicates for factor lookups, moved from validate.js
// unchanged so generation and validation classify references identically.
export function isNumericReference(value) {
  const s = String(value ?? '').trim().replace(/,/g, '');
  return s !== '' && /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s);
}

// A stated literal value rather than a symbolic reference: plain numbers
// plus the punctuation sources wrap them in — one leading sign (ASCII or
// unicode minus), one leading currency symbol, thousands separators, and
// one trailing percent (`$15,525.00`, `−$737.10`, `0.00%`). Anything else
// (identifiers, suffixed forms like `$200k`, prose) is not a literal.
export function isLiteralReference(value) {
  if (isNumericReference(value)) return true;
  let s = String(value ?? '').trim().replace(/,/g, '');
  if (!s) return false;
  s = s.replace(/^[+\-−]/, '').trim();
  s = s.replace(/^[$€£¥₹]\s*/, '');
  s = s.replace(/%\s*$/, '');
  if (!s) return false;
  return /^(\d+(\.\d*)?|\.\d+)$/.test(s);
}

// Lookup-flavored step operations, mirroring the lookup-key check: steps
// that introduce values from tables rather than computing from inputs.
export function isLookupLikeOperation(op) {
  const o = String(op ?? '').toLowerCase();
  return o.includes('lookup') || o.includes('look-up') || o.includes('table');
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

export function stepDefinedTerms(step) {
  const lower = new Set();
  const normalized = new Set();
  const add = (term) => {
    const s = String(term ?? '').trim();
    if (!s) return;
    lower.add(s.toLowerCase());
    const key = normalizeVariableKey(s);
    if (key) normalized.add(key);
  };
  // Declared step references, used as queries below: a retrieval phrase
  // only ever defines names the step itself states, so prose inside the
  // phrase can never resolve anything by accident.
  const queries = [...(step?.inputs ?? []), ...(step?.depends_on ?? [])]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
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
      // Each listed item (`base rates BRprem and BRprod`) defines its own
      // trailing variable: a declared reference resolves when it matches a
      // trailing token run of one item, spacing-insensitive, so `T Fprem`
      // matches `... factors T Fprem` while bare prose (`factors`) never
      // does. Token boundaries are exact — suffix substrings do not count.
      for (const segment of String(m[1] ?? '').split(/\s+and\s+|,/i)) {
        const keys = (segment.match(/[A-Za-z_]\w*/g) ?? []).map((t) => normalizeVariableKey(t));
        if (keys.length === 0) continue;
        for (const q of queries) {
          const qk = normalizeVariableKey(q);
          if (!qk) continue;
          for (let i = 0; i < keys.length; i += 1) {
            if (keys.slice(i).join('') === qk) {
              add(q);
              break;
            }
          }
        }
      }
    }
    // Explicit same-step definitions (`Let Feeflat be the sum ...`) define
    // exactly the named phrase, however spaced. Whole phrases only: unlike
    // retrieval items, the phrase carries no surrounding prose to trim.
    const letPattern = /\blet\s+(.+?)\s+be\b/gi;
    let letMatch;
    while ((letMatch = letPattern.exec(s)) !== null) {
      for (const part of String(letMatch[1] ?? '').split(/\s+and\s+|,/i)) {
        add(part.trim());
      }
    }
  }
  return { lower, normalized };
}

export function isStepDefined(name, definedHere) {
  if (!definedHere) return false;
  const lower = String(name ?? '').trim().toLowerCase();
  if (definedHere.lower.has(lower)) return true;
  const key = normalizeVariableKey(name);
  return Boolean(key && definedHere.normalized.has(key));
}

// Stemmed word set of a label: lowercase alphanumeric tokens through the
// shared singular/plural-insensitive form, so `Factors` meets `factor`.
// Generic token logic, never label contents.
function stemmedLabelWords(value) {
  const words = String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(words.map(singularKeyword));
}

// A factor mention split into its head word (the last keyword: `factor` in
// `territory factor`) and its qualifier words (the rest). Purely numeric
// qualifier words never count: numbers do not name concepts, so a stray
// `2` can never match a key column.
function factorMentionParts(name) {
  const keywords = tableMentionKeywords(name).map((w) => singularKeyword(w));
  const head = keywords.length > 0 ? keywords[keywords.length - 1] : '';
  const qualifier = new Set(keywords.slice(0, -1).filter((w) => /[a-z]/.test(w)));
  return { head, qualifier };
}

// Headers of a table: extracted headers, falling back to inferred column
// labels when headers are absent. Verbatim source labels, never altered.
function lookupTableHeaders(table) {
  const headers = Array.isArray(table?.headers)
    ? table.headers.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  if (headers.length > 0) return headers;
  return (Array.isArray(table?.columns) ? table.columns : [])
    .map((c) => String(c?.label ?? c?.original_label ?? '').trim())
    .filter(Boolean);
}

// Multi-output steps join their targets (`output: "A, B"`): each part is a
// defined term of its own. Mirrors the validator's output splitting.
function splitOutputParts(value) {
  return String(value ?? '').split(';')
    .flatMap((part) => String(part ?? '').split(/,(?!\d)/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Every binding candidate for one factor use: routine inputs plus
// preceding-step outputs (strictly before stepIndex), sharing a stemmed
// word with the key column header. Later steps and other routines never
// bind: a key must be evidenced before its use, in its own routine.
function collectBindingCandidates(routine, stepIndex, keyColumn) {
  const headerWords = stemmedLabelWords(keyColumn);
  const out = [];
  if (headerWords.size === 0) return out;
  const overlaps = (label) => {
    for (const w of stemmedLabelWords(label)) {
      if (headerWords.has(w)) return true;
    }
    return false;
  };
  for (const raw of routine?.inputs ?? []) {
    const s = String(raw ?? '').trim();
    if (s && overlaps(s)) out.push({ name: s, source: 'input' });
  }
  const detailed = Array.isArray(routine?.steps_detailed) ? routine.steps_detailed : [];
  for (let i = 0; i < stepIndex && i < detailed.length; i += 1) {
    for (const part of splitOutputParts(detailed[i]?.output)) {
      if (overlaps(part)) out.push({ name: part, source: 'step' });
    }
  }
  return out;
}

// Display member for one candidate group: the member verbatim-equal to the
// key column header when present, else the ASCII-first member. Order-free:
// members of a group denote the same variable.
function bindingGroupMember(members, keyColumn) {
  const verbatim = members.find((m) => m.name === keyColumn);
  if (verbatim) return verbatim;
  return [...members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
}

// Representative surface per candidate group, sorted case-insensitively
// so ambiguity reports read identically regardless of source order.
function namedBindingCandidates(entries, keyColumn) {
  return entries
    .map(([, members]) => bindingGroupMember(members, keyColumn).name)
    .sort((a, b) => {
      const al = a.toLowerCase();
      const bl = b.toLowerCase();
      if (al !== bl) return al < bl ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

// One binding from many candidates, or none: candidates group by
// normalized variable, so duplicates and case variants are one candidate.
// A lone group binds; across groups an exact header match wins when it is
// alone; otherwise the uniquely most-evidenced (most shared words)
// candidate wins. Anything else is ambiguous — source order never breaks
// a tie and nothing is guessed.
function selectUniqueBinding(candidates, keyColumn) {
  const groups = new Map();
  for (const c of candidates) {
    const key = normalizeVariableKey(c.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  if (groups.size === 0) return { status: 'none', candidates: [] };
  const headerKey = normalizeVariableKey(keyColumn);
  const headerWords = stemmedLabelWords(keyColumn);
  const scoreOf = (members) => {
    let n = 0;
    for (const w of stemmedLabelWords(bindingGroupMember(members, keyColumn).name)) {
      if (headerWords.has(w)) n += 1;
    }
    return n;
  };
  const entries = [...groups.entries()];
  if (entries.length === 1) {
    const winner = bindingGroupMember(entries[0][1], keyColumn);
    return { status: 'ok', name: winner.name, source: winner.source, candidates: [] };
  }
  const exact = entries.filter(([key]) => key === headerKey);
  if (exact.length === 1) {
    const winner = bindingGroupMember(exact[0][1], keyColumn);
    return { status: 'ok', name: winner.name, source: winner.source, candidates: [] };
  }
  if (exact.length > 1) return { status: 'ambiguous', candidates: namedBindingCandidates(exact, keyColumn) };
  const scored = entries.map((entry) => ({ entry, score: scoreOf(entry[1]) }));
  const best = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === best);
  if (winners.length === 1) {
    const winner = bindingGroupMember(winners[0].entry[1], keyColumn);
    return { status: 'ok', name: winner.name, source: winner.source, candidates: [] };
  }
  return { status: 'ambiguous', candidates: namedBindingCandidates(entries, keyColumn) };
}

// Whether one factor use supports a parameterized lookup from its table:
// the factor column is the unique header holding the mention's head word,
// the key column is the unique remaining header sharing a qualifier word,
// and the key binds to a routine input or preceding-step output. Returns
// the identified columns and binding, or the first check that fails so
// callers can explain exactly what needs analyst review. Generic word
// agreement only; table contents are never read.
export function diagnoseFactorLookup(routine, stepIndex, name, table) {
  const headers = lookupTableHeaders(table);
  const { head, qualifier } = factorMentionParts(name);
  const blank = { status: '', keyColumn: '', valueColumn: '', keyCandidates: [], valueCandidates: [], binding: '', bindingSource: '', bindingCandidates: [] };
  const valueHits = head ? headers.filter((h) => stemmedLabelWords(h).has(head)) : [];
  if (valueHits.length === 0) return { ...blank, status: 'no-value-column' };
  if (valueHits.length > 1) return { ...blank, status: 'ambiguous-value-column', valueCandidates: [...valueHits] };
  const valueColumn = valueHits[0];
  const keyHits = headers.filter((h) => h !== valueColumn && [...stemmedLabelWords(h)].some((w) => qualifier.has(w)));
  if (keyHits.length === 0) return { ...blank, status: 'no-key-column', valueColumn };
  if (keyHits.length > 1) {
    return { ...blank, status: 'ambiguous-key-column', valueColumn, keyCandidates: [...keyHits] };
  }
  const keyColumn = keyHits[0];
  const selection = selectUniqueBinding(collectBindingCandidates(routine, stepIndex, keyColumn), keyColumn);
  if (selection.status === 'none') return { ...blank, status: 'no-binding', keyColumn, valueColumn };
  if (selection.status === 'ambiguous') {
    return { ...blank, status: 'ambiguous-binding', keyColumn, valueColumn, bindingCandidates: selection.candidates };
  }
  return { ...blank, status: 'ok', keyColumn, valueColumn, binding: selection.name, bindingSource: selection.source };
}

// Terms introduced without any table: literals, this routine's inputs,
// every routine's step and routine outputs, defined constants, and this
// routine's lookup keys. Mirrors the validator's factor-introduced check
// so generation fires exactly where validation would flag.
function collectProducedTerms(routines, routine) {
  const lower = new Set();
  const normalized = new Set();
  const addRaw = (raw) => {
    const l = String(raw ?? '').trim().toLowerCase();
    if (!l) return;
    lower.add(l);
    const k = normalizeVariableKey(raw);
    if (k) normalized.add(k);
  };
  const addSplit = (raw) => {
    for (const part of splitOutputParts(raw)) addRaw(part);
  };
  for (const r of routines) {
    for (const s of r?.steps_detailed ?? []) addSplit(s?.output);
    for (const o of r?.outputs ?? []) addSplit(o);
  }
  for (const raw of routine?.inputs ?? []) addRaw(raw);
  for (const c of definedConstantTerms(routines)) addRaw(c);
  for (const s of routine?.steps_detailed ?? []) {
    if (!isLookupLikeOperation(s?.operation)) continue;
    for (const raw of s?.inputs ?? []) addRaw(raw);
  }
  return { lower, normalized };
}

function isProducedTerm(produced, name) {
  if (isLiteralReference(name)) return true;
  const lower = String(name ?? '').trim().toLowerCase();
  if (produced.lower.has(lower)) return true;
  const key = normalizeVariableKey(name);
  return Boolean(key && produced.normalized.has(key));
}

// The insertion plan for one factor, or null when generation is unsafe:
// any use naming several tables suppresses the factor (production must
// never hide table ambiguity), all evidenced uses must agree on one table
// and the same key/value columns, and the first evidenced use must
// diagnose clean. Insertion anchors before that first evidenced use.
function planFactorLookup(routine, sites, tables, offset) {
  if (sites.some((s) => s.tables.length > 1)) return null;
  const evidenced = sites.filter((s) => s.tables.length === 1);
  if (evidenced.length === 0) return null;
  const table = evidenced[0].tables[0];
  if (!evidenced.every((s) => s.tables[0] === table)) return null;
  const first = evidenced[0];
  const diagnosis = diagnoseFactorLookup(routine, first.index + offset, first.name, table);
  if (diagnosis.status !== 'ok') return null;
  const columnsAgree = evidenced.every((s) => {
    const d = diagnoseFactorLookup(routine, s.index + offset, s.name, table);
    return d.keyColumn === diagnosis.keyColumn && d.valueColumn === diagnosis.valueColumn;
  });
  if (!columnsAgree) return null;
  return { index: first.index + offset, name: first.name, table, binding: diagnosis.binding };
}

// The using step's own table mention resolving to the lookup table,
// verbatim so downstream resolution and rendering agree. Falls back to
// the table's own name when no mention resolves (unreachable through the
// attribution gate: the mention evidenced the table).
function tableMentionFor(step, tables, table) {
  for (const raw of step?.depends_on ?? []) {
    const mention = String(raw ?? '').trim();
    if (mention && resolveTableReference(tables, mention) === table) return mention;
  }
  return String(table?.name ?? table?.id ?? '');
}

// Splice one parameterized lookup before its first evidenced use, keeping
// display strings and details positionally aligned, then recase downstream
// references to the canonical (first-seen) factor name — the same
// producer-display rule normalization applies, so re-normalization is a
// no-op. Instructions, evidence, and source order stay verbatim.
function insertFactorLookup(routine, detailed, tables, anchor, key) {
  const useStep = detailed[anchor.index] ?? {};
  const mention = tableMentionFor(useStep, tables, anchor.table);
  const instruction = `Look up the ${anchor.name} from ${mention} using ${anchor.binding}.`;
  const pages = Array.isArray(useStep.source_pages) && useStep.source_pages.length > 0
    ? [...useStep.source_pages]
    : [...(routine?.source_pages ?? [])];
  const generated = {
    instruction,
    operation: 'lookup',
    inputs: [anchor.binding],
    output: anchor.name,
    depends_on: [mention],
    evidence: String(useStep.evidence ?? useStep.instruction ?? routine?.evidence_text ?? ''),
    source_pages: pages,
    interpretation_status: 'inferred',
  };
  const display = Array.isArray(routine?.steps) ? routine.steps : null;
  const aligned = display !== null && display.length > 0 && display.length === detailed.length;
  detailed.splice(anchor.index, 0, generated);
  if (aligned) display.splice(anchor.index, 0, instruction);
  const producers = new Map([[key, anchor.name]]);
  for (let i = anchor.index + 1; i < detailed.length; i += 1) {
    const step = detailed[i];
    if (!step || typeof step !== 'object') continue;
    if (!Array.isArray(step.inputs) || step.inputs.length === 0) continue;
    const original = [...step.inputs];
    step.inputs = original.map((term) => producers.get(normalizeVariableKey(term)) || term);
    if (typeof step.expression === 'string' && step.expression) {
      step.expression = canonicalizeExpressionTerms(step.expression, original, step.operand, producers);
    }
  }
}

// Insert parameterized lookup assignments for table-driven factors used in
// calculations. A factor earns a lookup only when its routine explicitly
// references one table for it, the table's key and factor columns are
// unambiguous, and the key binds to a routine input or preceding-step
// output of the same routine — worked-example values from other routines
// never bind. Explicit lookups, produced values, ambiguous tables, and
// ambiguous columns keep their existing behavior: no step is invented and
// validation keeps flagging the gap. Mutates the routine in place (like
// canonicalization) and returns the number of steps inserted; re-running
// after normalization inserts nothing further.
export function generateParameterizedLookups(routine, tables, routines = [routine]) {
  const detailed = Array.isArray(routine?.steps_detailed) ? routine.steps_detailed : [];
  if (detailed.length === 0) return 0;
  const list = Array.isArray(tables) ? tables : [];
  const all = Array.isArray(routines) && routines.length > 0 ? routines : [routine];
  const produced = collectProducedTerms(all, routine);
  const sitesByFactor = new Map();
  detailed.forEach((step, index) => {
    if (!step || typeof step !== 'object' || isLookupLikeOperation(step.operation)) return;
    const definedHere = stepDefinedTerms(step);
    const seen = new Set();
    for (const raw of step.inputs ?? []) {
      const name = String(raw ?? '').trim();
      if (!name || isStepDefined(name, definedHere)) continue;
      const key = normalizeVariableKey(name);
      if (!key || seen.has(key) || isProducedTerm(produced, name)) continue;
      seen.add(key);
      let group = sitesByFactor.get(key);
      if (!group) {
        group = { sites: [] };
        sitesByFactor.set(key, group);
      }
      group.sites.push({ index, name, tables: stepInputTables(step, list, name, routine) });
    }
  });
  let generated = 0;
  let offset = 0;
  for (const [key, group] of sitesByFactor) {
    const anchor = planFactorLookup(routine, group.sites, list, offset);
    if (!anchor) continue;
    insertFactorLookup(routine, detailed, list, anchor, key);
    generated += 1;
    offset += 1;
  }
  return generated;
}

// Base asset code shared by split parts of one logical table: the uppercase
// hyphenated code with any trailing Part/Section qualifier stripped
// ("TBL-PROT-CRED Part A" and "TBL-PROT-CRED Part B" share "tbl-prot-cred").
// Returns the lowercased base code or '' when the table carries no such
// code. Generic code shapes, never table names.
const LOGICAL_PART_SUFFIX = new RegExp(`\\s+${TRAILING_QUALIFIER}\\s+[A-Z0-9]+\\s*$`, 'i');

export function tableLogicalGroupKey(table) {
  const names = [table?.name, ...(table?.aliases ?? [])];
  for (const raw of names) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const stripped = s.replace(LOGICAL_PART_SUFFIX, '').trim();
    const codes = [...stripped.matchAll(/\b([A-Z][A-Z0-9]*(?:[-_.][A-Z0-9]+)+)\b/g)]
      .map((m) => m[1]);
    if (codes.length > 0) return codes[codes.length - 1].toLowerCase();
  }
  return '';
}

// Normalized header signature for continuation matching: lowercased,
// whitespace-collapsed labels joined in order. Empty when the table has no
// non-blank headers, so headerless tables never match each other.
export function tableHeaderKey(table) {
  const segments = (table?.headers ?? [])
    .map((h) => String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0) return '';
  return segments.join('|');
}

export function tablePageSpan(table) {
  const pages = table?.source_pages ?? [];
  if (pages.length === 0) return null;
  return { min: Math.min(...pages), max: Math.max(...pages) };
}

// True when two page spans touch without overlapping: the signature of one
// table continuing onto the next page. Same-page and overlapping spans are
// not continuations.
export function tablePagesAdjacent(a, b) {
  const sa = tablePageSpan(a);
  const sb = tablePageSpan(b);
  if (!sa || !sb) return false;
  return sa.max + 1 === sb.min || sb.max + 1 === sa.min;
}

// Explicit continuation language: continu* verbs and Part markers. Generic
// English, never table names or contents.
const CONTINUATION_CUE_WORD = /\bcontinu(?:e[ds]?|ing)\b/i;
const CONTINUATION_PART_WORD = /\bpart\s+(?:\d+|[ivxlcdm]+|[a-z])(?:\s+of\s+(?:\d+|[ivxlcdm]+))?\b/i;

export function tableHasContinuationCue(table) {
  const joined = [table?.name, table?.notes, ...(table?.footnotes ?? []), table?.evidence_text]
    .map((t) => String(t ?? '')).join('\n');
  return CONTINUATION_CUE_WORD.test(joined) || CONTINUATION_PART_WORD.test(joined);
}

// Base-name slug with continuation qualifiers stripped ('Schedule (continued)'
// and 'Schedule Part 1' both reduce to 'schedule'), for pairing explicitly
// cued parts. Empty when no base name remains.
export function tableContinuationBase(table) {
  const base = String(table?.name ?? '')
    .replace(/^\s*part\s+(?:\d+|[ivxlcdm]+|[a-z])(?:\s+of\s+(?:\d+|[ivxlcdm]+))?\s*[:\-–—]?\s*/i, '')
    .replace(/\s+part\s+(?:\d+|[ivxlcdm]+|[a-z])(?:\s+of\s+(?:\d+|[ivxlcdm]+))?\s*$/i, '')
    .replace(/\s*\([^()]*\bcontinu(?:e[ds]?|ing)\b[^()]*\)\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return base;
}

// True when every table in the list shares one non-empty logical group key
// (split parts of the same logical table) and the mention names that base
// code. A base-code reference to the group ("TBL-PROT-CRED" for Part A and
// Part B) is then a confident group reference, not an ambiguous match.
export function isLogicalGroupReference(tables, mention) {
  const list = Array.isArray(tables) ? tables.filter(Boolean) : [];
  if (list.length < 2) return false;
  const key = String(mention ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!key) return false;
  const groups = new Set(list.map(tableLogicalGroupKey).filter(Boolean));
  if (groups.size !== 1) return false;
  const group = [...groups][0];
  return key === group || key.replace(/-/g, '') === group.replace(/-/g, '');
}

// Generic column role hints from header wording. Rating-domain key/value/note
// families, never specific table or column names. Value patterns decide when
// headers are silent; headers decide when values are ambiguous (numeric codes
// stay keys via "code", numeric factors stay outputs via "factor").
const COLUMN_KEY_TERMS = /\b(code|codes|id|ids|key|keys|category|categories|type|types|class|classes|zone|zones|territory|territories|band|bands|tier|tiers|group|groups|grade|grades|schedule|schedules|limit|limits|deductible|deductibles|peril|perils|occupancy|construction|hazard|industry|description)\b/i;
const COLUMN_VALUE_TERMS = /\b(rate|rates|factor|factors|premium|premiums|cost|costs|price|prices|amount|amounts|charge|charges|fee|fees|modifier|modifiers|multiplier|multipliers|loading|loadings|surcharge|surcharges|credit|credits|debit|debits|relativity|relativities|ratio|ratios|percent|percentage|value|values|result|results|loss|losses|limit|limits)\b/i;
const COLUMN_NOTE_TERMS = /\b(note|notes|constraint|constraints|requirement|requirements|comment|comments|evidence|footnote|footnotes|instruction|instructions|remark|remarks|condition|conditions|eligibility|audit|certification|documentation|warranty|warranties)\b/i;

function columnCells(table, idx) {
  const out = [];
  for (const row of table?.rows ?? []) {
    if (!Array.isArray(row) || idx >= row.length) continue;
    out.push(String(row[idx] ?? ''));
  }
  return out;
}

function isColumnNumericValue(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return false;
  if (/^0\d+$/.test(s)) return false;
  const cleaned = s.replace(/[$€£¥₹,\s]/g, '').replace(/%$/, '');
  if (!cleaned) return false;
  return /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned);
}

function isCodeLikeValue(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s.length > 32 || /\s{2,}/.test(s)) return false;
  if (/^0\d+$/.test(s)) return true;
  if (/^[A-Z][A-Z0-9]*([-_.][A-Z0-9]+)+$/.test(s)) return true;
  if (/^[A-Z]+-\d+[A-Z0-9-]*$/.test(s)) return true;
  return false;
}

function inferColumnUnits(header, cells) {
  const h = String(header ?? '');
  const nonBlank = cells.filter((c) => String(c ?? '').trim());
  if (nonBlank.length === 0) return '';
  const headerLower = h.toLowerCase();
  const perMatch = /\bper\s*\$?\s*\d[\d,]*\b/i.exec(h) ?? /\bper\s+[a-z]+\b/i.exec(h);
  if (perMatch && nonBlank.every(isColumnNumericValue)) return perMatch[0].trim();
  if (/%|percent/i.test(h) && nonBlank.every((c) => /%|percent/i.test(String(c)) || isColumnNumericValue(c))) {
    if (/%/.test(h) || nonBlank.every((c) => String(c).includes('%'))) return '%';
  }
  if (/[$€£¥₹]/.test(h) && nonBlank.every(isColumnNumericValue)) {
    const cur = /[$€£¥₹]/.exec(h);
    return cur ? cur[0] : '';
  }
  if (nonBlank.every((c) => String(c ?? '').trim().startsWith('$') && isColumnNumericValue(c))) return '$';
  if (nonBlank.every((c) => String(c ?? '').trim().endsWith('%') && isColumnNumericValue(String(c).replace(/%$/, '')))) return '%';
  if (/\b(dollar|dollars|currency)\b/i.test(headerLower) && nonBlank.every(isColumnNumericValue)) return '$';
  return '';
}

function inferColumnRole(header, cells) {
  const h = String(header ?? '').trim();
  const nonBlank = cells.filter((c) => String(c ?? '').trim());
  if (nonBlank.length === 0) return '';
  if (h && COLUMN_NOTE_TERMS.test(h)) {
    const avgLen = nonBlank.reduce((n, c) => n + String(c).length, 0) / nonBlank.length;
    if (avgLen >= 12 || nonBlank.some((c) => String(c).trim().split(/\s+/).length >= 3)) return 'descriptive';
  }
  const allNumeric = nonBlank.every(isColumnNumericValue);
  if (h && COLUMN_VALUE_TERMS.test(h) && allNumeric) return 'output';
  if (h && /\b(code|codes|id|ids|key|keys)\b/i.test(h)) return 'key';
  if (h && COLUMN_KEY_TERMS.test(h) && !allNumeric) return 'key';
  if (nonBlank.every(isCodeLikeValue)) return 'key';
  const unique = new Set(nonBlank.map((c) => String(c ?? '').trim().toLowerCase()));
  if (unique.size === nonBlank.length && nonBlank.length >= 2 && !allNumeric) return 'key';
  if (allNumeric) return 'output';
  if (h) return '';
  return '';
}

function inferColumnDataType(header, cells) {
  const nonBlank = cells.filter((c) => String(c ?? '').trim());
  if (nonBlank.length === 0) return '';
  if (nonBlank.every(isColumnNumericValue)) return 'number';
  if (nonBlank.every((c) => !isColumnNumericValue(c))) return 'text';
  return '';
}

// Deterministic column type/unit/role inference. Fills only absent fields
// when header wording and cell values agree; uncertain columns stay unknown
// (no field) so nothing is invented. Original labels are never altered.
// Returns a new columns array; the input table is untouched.
export function inferTableColumns(table) {
  const headers = table?.headers ?? [];
  const columns = table?.columns ?? [];
  const width = Math.max(headers.length, columns.length);
  if (width === 0) return columns;
  return Array.from({ length: width }, (_, idx) => {
    const base = columns[idx] && typeof columns[idx] === 'object' ? { ...columns[idx] } : null;
    const header = headers[idx] ?? base?.label ?? '';
    const cells = columnCells(table, idx);
    const nonBlank = cells.filter((c) => String(c ?? '').trim());
    if (nonBlank.length === 0) return base ?? { label: String(header ?? ''), original_label: String(header ?? ''), order: idx + 1 };
    const out = base ?? { label: String(header ?? ''), original_label: String(header ?? ''), order: idx + 1 };
    const evidenceBits = [];
    if (!out.data_type) {
      const inferred = inferColumnDataType(header, cells);
      if (inferred) {
        out.data_type = inferred;
        evidenceBits.push(`${nonBlank.length} ${inferred === 'number' ? 'numeric' : 'text'} value(s)`);
      }
    }
    if (!out.units) {
      const inferred = inferColumnUnits(header, cells);
      if (inferred) {
        out.units = inferred;
        evidenceBits.push(`units "${inferred}" from header/values`);
      }
    }
    if (!out.role) {
      const inferred = inferColumnRole(header, cells);
      if (inferred) {
        out.role = inferred;
        evidenceBits.push(`role ${inferred} from header/values`);
      }
    }
    if (evidenceBits.length > 0 && !out.evidence) {
      out.evidence = `Inferred from ${evidenceBits.join('; ')} in column "${String(header ?? `column ${idx + 1}`)}".`;
    }
    return out;
  });
}

// Whitespace-delimited code tokens of a routine id or name, lowercased with
// surrounding punctuation stripped, so "HB-1" survives as one token while
// dashes and commas never glue words together. Tokens shorter than two
// characters are dropped as too weak to identify a routine.
function routineNameTokens(name) {
  return String(name ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/^[-—–:;.,()[\]{}"'`]+|[-—–:;.,()[\]{}"'`]+$/g, '').trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

// Resolve a routine mention to an extracted routine: exact id/name match
// first (case-insensitive), else a mention that equals a whitespace-delimited
// code token in exactly one routine's id or name ("HB-1" in
// "HB-1 — Harbor Total Fee"). Returns the routine or null when there is no
// single confident match. Generic: driven by tokens, never by names.
export function resolveRoutineReference(routines, mention) {
  const raw = String(mention ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const list = Array.isArray(routines) ? routines : [];
  const exact = list.find((r) =>
    String(r?.id ?? '').trim().toLowerCase() === key
    || String(r?.name ?? '').trim().toLowerCase() === key);
  if (exact) return exact;
  if (key.length < 2) return null;
  const matches = list.filter((r) =>
    routineNameTokens(r?.id).includes(key)
    || routineNameTokens(r?.name).includes(key));
  return matches.length === 1 ? matches[0] : null;
}

// A variable assigned to a numeric literal in routine text, e.g. "Fixed
// value: harbor_fee = 120." or "..., where basis = 1". Only the variable name
// is collected; values stay in the source text for display. Currency symbols
// and unicode minus signs are value punctuation ("Rfloor = $0.060",
// "S = −0.05" define their variables the same way).
const CONSTANT_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[-+−]?\s*[$€£¥₹]?\s*\d+(?:\.\d+)?/g;

function constantNamesIn(text, out) {
  const s = String(text ?? '');
  if (!s) return;
  CONSTANT_ASSIGNMENT.lastIndex = 0;
  let m;
  while ((m = CONSTANT_ASSIGNMENT.exec(s)) !== null) {
    out.add(String(m[1]).toLowerCase());
  }
}

function constantNamesInStep(step, out) {
  if (step === null || step === undefined) return;
  if (typeof step === 'string') {
    constantNamesIn(step, out);
    return;
  }
  if (typeof step !== 'object' || Array.isArray(step)) return;
  constantNamesIn(step.instruction ?? step.text, out);
  constantNamesIn(step.expression, out);
  constantNamesIn(step.operand, out);
  constantNamesIn(step.original_text, out);
  for (const ref of [...(step.inputs ?? []), ...(step.depends_on ?? [])]) constantNamesIn(ref, out);
}

// Lowercased names assigned numeric literals anywhere in any routine's own
// text (notes, evidence, expression, steps, step inputs, conditions). Global like routine
// outputs: a fixed value evidenced once resolves references to it. Generic:
// driven by assignment syntax, never by variable names.
export function definedConstantTerms(routines) {
  const out = new Set();
  for (const r of Array.isArray(routines) ? routines : []) {
    constantNamesIn(r?.notes, out);
    constantNamesIn(r?.evidence_text, out);
    constantNamesIn(r?.expression_text, out);
    for (const s of r?.steps ?? []) constantNamesInStep(s, out);
    for (const s of r?.steps_detailed ?? []) constantNamesInStep(s, out);
    for (const c of r?.conditions ?? []) {
      constantNamesIn(typeof c === 'string' ? c : (c?.condition ?? c?.true_branch ?? c?.false_branch ?? ''), out);
    }
  }
  return out;
}

// A code-shaped cell value: uppercase letter-led groups joined by
// separators (`RID-001`, `AREA_1`, `FEE-WAIVE`). Plain words (`None`, `Any`),
// numbers, and prose never match, so only references to coded values
// resolve against row contents.
const CODE_CELL_VALUE = /^[A-Z][A-Z0-9]*([-_.][A-Z0-9]+)+$/;

function codeCellTerms(table, out) {
  for (const row of table?.rows ?? []) {
    for (const cell of row ?? []) {
      const s = String(cell ?? '').trim();
      if (!s || s.length > 24 || /\s/.test(s)) continue;
      const parts = s.includes('/') || s.includes(',') || s.includes(';')
        ? s.split(/[/,;]/).map((p) => p.trim())
        : [s];
      for (const part of parts) {
        if (CODE_CELL_VALUE.test(part)) out.push(part);
        else if (/^[A-Z][A-Z0-9]{1,7}$/.test(part)) out.push(part);
      }
    }
  }
}

// A parenthesized single token in a header or label (`Liability Factor
// (Fclass_liab)`) is the source's own symbol for that column: references to
// the symbol name the table structure. Multi-word glosses (`(Zero Losses
// Reported)`), currency (`($100k)`), bare numbers, and single letters stay
// out — too weak or not symbols. Generic punctuation shape, never names.
function parenthesizedSymbolTerms(table, out) {
  const labels = [table?.name, ...(table?.aliases ?? []), ...(table?.headers ?? []),
    ...((table?.columns ?? []).map((c) => c?.label ?? c?.original_label))];
  for (const raw of labels) {
    for (const m of String(raw ?? '').matchAll(/\(([^()\s]{2,32})\)/g)) {
      if (/^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(m[1]) && !/^\d+(\.\d+)?$/.test(m[1])) out.push(m[1]);
    }
  }
}

// Lowercased id/name/alias/header/label terms identifying extracted
// tables, plus code-shaped cell values, for matching references against
// defined table structure.
// Whole-cell code values of one table (separator-joined codes plus short
// uppercase tokens): the identifiers inputs and lookup keys reference.
// Shared by validation term collection and workbook input resolution.
export function tableCellCodes(table) {
  const out = [];
  codeCellTerms(table, out);
  return [...new Set(out)];
}

// Code-shaped tokens inside a free-text reference: separator-joined codes
// plus short uppercase tokens. Shared shape with tableCellCodes so workbook
// input resolution matches validator term collection exactly.
export function extractCellCodeTokens(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g)) {
    const tok = m[0];
    if (CODE_CELL_VALUE.test(tok) || /^[A-Z][A-Z0-9]{1,7}$/.test(tok)) out.push(tok);
  }
  return [...new Set(out)];
}

export function tableReferenceTerms(tables) {
  const terms = [];
  for (const t of Array.isArray(tables) ? tables : []) {
    terms.push(
      t?.id,
      t?.name,
      ...(t?.aliases ?? []),
      ...(t?.headers ?? []),
      ...(t?.columns ?? []).map((c) => c?.label ?? c?.original_label)
    );
    codeCellTerms(t, terms);
    parenthesizedSymbolTerms(t, terms);
  }
  return new Set(
    terms
      .filter((s) => s !== undefined && s !== null)
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );
}

// Generic lookup verbs across guideline wordings. "Look up" is unambiguous;
// other verbs only count as lookups when paired with explicit table and/or
// key structure (from/in/using/for), so prose like "Find the results" stays
// minimal. Plain English, not domain vocabulary.
const LOOKUP_VERBS = '(?:look\\s*-?\\s*up|lookup|find|retrieve|select|get|fetch|obtain|determine|read|locate|extract)';

function isLookupVerbStart(body) {
  return new RegExp(`^${LOOKUP_VERBS}\\b`, 'i').test(String(body ?? ''));
}

function isClassicLookupStart(body) {
  return /^look\s*-?\s*up\b/i.test(String(body ?? '')) || /^lookup\b/i.test(String(body ?? ''));
}

// Normalize a lookup output phrase ("the base rate" to "base_rate") while
// preserving single-token variables verbatim. Returns '' when no confident
// variable remains.
function normalizeLookupOutput(phrase) {
  let s = String(phrase ?? '').trim().replace(/[.;]+$/, '').trim();
  s = s.replace(/^(the|a|an)\s+/i, '').trim();
  if (!s) return '';
  s = s.replace(/[\s\u2010-\u2015\u2212-]+/g, '_');
  s = s.replace(/[^A-Za-z0-9_]/g, '');
  s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s || !acceptableCapture(s)) return '';
  return s;
}

function cleanTableMention(text) {
  const s = stripLeadingArticle(String(text ?? '').trim().replace(/[.;]+$/, '').trim());
  return s.trim();
}

// Try generic lookup patterns in specificity order. Returns
// {output, inputs, depends_on} or null when no confident structure matches.
function tryParseLookup(body) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  const end = '\\s*[.;]*\\s*$';
  const patterns = [
    // Verb output from Table using keys
    new RegExp(`^${LOOKUP_VERBS}\\s+(.+?)\\s+from\\s+(.+?)\\s+using\\s+(.+?)${end}`, 'i'),
    // Verb output using keys in/from Table
    new RegExp(`^${LOOKUP_VERBS}\\s+(.+?)\\s+using\\s+(.+?)\\s+(?:in|from)\\s+(.+?)${end}`, 'i'),
    // Verb output for keys in/from Table
    new RegExp(`^${LOOKUP_VERBS}\\s+(.+?)\\s+for\\s+(.+?)\\s+(?:in|from)\\s+(.+?)${end}`, 'i'),
    // Verb output in/from Table (no keys stated)
    new RegExp(`^${LOOKUP_VERBS}\\s+(.+?)\\s+(?:in|from)\\s+(.+?)${end}`, 'i'),
    // Verb output using keys (no table stated)
    new RegExp(`^${LOOKUP_VERBS}\\s+(.+?)\\s+using\\s+(.+?)${end}`, 'i'),
  ];
  const fromUsing = patterns[0].exec(text);
  if (fromUsing) {
    const output = normalizeLookupOutput(fromUsing[1]);
    const table = cleanTableMention(fromUsing[2]);
    const inputs = splitKeys(fromUsing[3]);
    if (output || inputs.length > 0 || table) {
      return { output, inputs, depends_on: table ? [table] : [] };
    }
    return { output: '', inputs: [], depends_on: [] };
  }
  const usingIn = patterns[1].exec(text);
  if (usingIn) {
    const output = normalizeLookupOutput(usingIn[1]);
    const inputs = splitKeys(usingIn[2]);
    const table = cleanTableMention(usingIn[3]);
    return { output, inputs, depends_on: table ? [table] : [] };
  }
  const forIn = patterns[2].exec(text);
  if (forIn) {
    const output = normalizeLookupOutput(forIn[1]);
    const inputs = splitKeys(forIn[2]);
    const table = cleanTableMention(forIn[3]);
    return { output, inputs, depends_on: table ? [table] : [] };
  }
  const inFrom = patterns[3].exec(text);
  if (inFrom) {
    const output = normalizeLookupOutput(inFrom[1]);
    const table = cleanTableMention(inFrom[2]);
    // Guard: without keys, require a table-like mention so "Find time in
    // review" does not become a lookup. A table mention names a table.
    if (!table || !/\btable\b/i.test(table)) return null;
    return { output, inputs: [], depends_on: table ? [table] : [] };
  }
  const usingOnly = patterns[4].exec(text);
  if (usingOnly) {
    const output = normalizeLookupOutput(usingOnly[1]);
    const inputs = splitKeys(usingOnly[2]);
    if (!output && inputs.length === 0) return null;
    return { output, inputs, depends_on: [] };
  }
  return null;
}

// Split a branch tail on its top-level ELSE/OTHERWISE (depth 0, outside any
// nested IF/WHEN). Nested branches stay verbatim inside the true branch so
// "IF A THEN IF B THEN X ELSE Y ELSE Z" keeps "IF B THEN X ELSE Y" whole.
// Returns [trueBranch, falseBranch] or null when no top-level ELSE exists.
function splitTopLevelElse(rest) {
  const s = String(rest ?? '').trim();
  if (!s) return null;
  const tokens = [...s.matchAll(/\b(if|when|else|otherwise)\b/gi)];
  let depth = 0;
  let splitAt = -1;
  let splitLen = 0;
  for (const tok of tokens) {
    const word = tok[1].toLowerCase();
    if (word === 'if' || word === 'when') depth += 1;
    else if (word === 'else' || word === 'otherwise') {
      if (depth === 0) { splitAt = tok.index; splitLen = tok[0].length; break; }
      depth = Math.max(0, depth - 1);
    }
  }
  if (splitAt < 0) return null;
  const before = s.slice(0, splitAt).trim().replace(/[;.,]+\s*$/, '').trim();
  const after = s.slice(splitAt + splitLen).trim().replace(/^,/, '').trim();
  if (!before || !after) return null;
  return [before, after];
}

// Parse explicit conditional branch wording: IF/WHEN with THEN or a comma,
// ELSE/OTHERWISE as the false branch in either order. Returns
// {condition?, true_branch?, false_branch?} or null when no confident
// structure matches. Original text is preserved by callers.
function parseConditionalBranches(text) {
  const full = String(text ?? '').trim();
  if (!full) return null;
  const elseSplit = (rest) => {
    const parts = splitTopLevelElse(rest);
    return parts ? [, parts[0], parts[1]] : null;
  };
  const ifThen = /^\s*(?:if|when)\s+(.+?)\s+then\s+(.+?)\s*$/i.exec(full);
  if (ifThen && ifThen[1].trim() && ifThen[2].trim()) {
    const condition = ifThen[1].trim();
    const rest = ifThen[2].trim();
    const split = elseSplit(rest);
    if (split) {
      return { condition, true_branch: split[1].trim(), false_branch: split[2].trim() };
    }
    return { condition, true_branch: rest };
  }
  const withElse = /^\s*(?:if|when)\s+(.+?)\s*,\s*(.+?)\s*(?:[;.,]\s*)?(?:else|otherwise)\s*,?\s+(.+?)\s*$/i.exec(full);
  if (withElse && withElse[1].trim() && withElse[2].trim() && withElse[3].trim()) {
    return {
      condition: withElse[1].trim(),
      true_branch: withElse[2].trim(),
      false_branch: withElse[3].trim(),
    };
  }
  const commaOnly = /^\s*(?:if|when)\s+(.+?)\s*,\s*(.+?)\s*$/i.exec(full);
  if (commaOnly && commaOnly[1].trim() && commaOnly[2].trim()) {
    return { condition: commaOnly[1].trim(), true_branch: commaOnly[2].trim() };
  }
  const elseOnly = /^\s*(?:else|otherwise)\s*,?\s*(.+?)\s*$/i.exec(full);
  if (elseOnly && elseOnly[1].trim()) {
    return { false_branch: elseOnly[1].trim() };
  }
  return null;
}

function extractConditionalClause(body) {
  const text = String(body ?? '');
  if (/^\s*(?:if|when|else|otherwise)\b/i.test(text)) return text.trim();
  const m = /\b(?:if|when)\b/i.exec(text);
  if (!m) return null;
  return text.slice(m.index).trim();
}

// Assignment target of one branch ("set X to", "X is set to", "store as X",
// "X = ...", "X equals ...", "X is <stated value>"). Generic syntax, not
// domain vocabulary. Exported for the Excel chain renderer so the
// same-subject merge gate reads branches exactly as normalization does.
export function assignmentTargetFromBranch(branch) {
  const text = String(branch ?? '');
  if (!text.trim()) return null;
  let m = /\bset\s+([A-Za-z_]\w*)\s+to\b/i.exec(text);
  if (m && acceptableCapture(m[1])) return m[1];
  m = /\b([A-Za-z_]\w*)\s+is\s+set\s+to\b/i.exec(text);
  if (m && acceptableCapture(m[1])) return m[1];
  m = /\bstore\b.*?as\s+([A-Za-z_]\w*)/i.exec(text);
  if (m && acceptableCapture(m[1])) return m[1];
  m = /\b([A-Za-z_]\w*)\s*=\s*\S+/.exec(text);
  if (m && acceptableCapture(m[1])) return m[1];
  m = /\b([A-Za-z_]\w*)\s+equals?\s+/i.exec(text);
  if (m && acceptableCapture(m[1])) return m[1];
  const stated = splitBranchIsValue(text);
  if (stated) return stated.subject;
  return null;
}

// Pronouns that never name a calculated value in a stated-value branch
// (`it is 5%` states no reusable subject). Generic English, never domain
// vocabulary.
const BRANCH_SUBJECT_PRONOUNS = new Set([
  'i', 'me', 'my', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its',
  'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those', 'there',
]);

// A stated-value branch (`the discount is 5% of X`, `rebate is 0%`): a
// short subject naming the calculated value, then is/are, then a
// numeric-led stated value. Returns { subject, value } with the subject's
// leading article dropped, or null when the shape is not evidenced —
// nested conditionals, prose values, pronouns, and connective-led
// subjects never match. Generic syntax, never branch contents. Exported
// for the Excel branch renderer so stored and fresh jobs pair the same
// subject with the same value.
export function splitBranchIsValue(branch) {
  const text = String(branch ?? '').trim().replace(/\.\s*$/, '').trim();
  if (!text) return null;
  if (/^(if|when|then|else|otherwise)\b/i.test(text)) return null;
  const word = '[A-Za-z_][\\w]*(?:[-.][\\w]+)*';
  const m = new RegExp(`^(?:(the|a|an)\\s+)?(${word}(?:\\s+${word}){0,3})\\s+(is|are)\\s+([\\s\\S]+?)\\s*$`, 'i').exec(text);
  if (!m) return null;
  const subject = m[2].replace(/\s+/g, ' ').trim();
  const words = subject.split(' ');
  if (words.some((w) => CONDITION_FILTER_WORDS.has(w.toLowerCase()))) return null;
  if (words.some((w) => BRANCH_SUBJECT_PRONOUNS.has(w.toLowerCase()))) return null;
  if (words.some((w) => /^(if|when|then|else|otherwise)$/i.test(w))) return null;
  const value = m[4].trim();
  if (!/^[-+₹$€£¥\d.\u2212]/.test(value)) return null;
  if (!/\d/.test(value)) return null;
  return { subject, value };
}

// Split a conditional clause stating several sequential IF/WHEN sentences
// (`IF A, X. IF B, Y.`) into its parts in source order, or null when the
// clause holds fewer than two. Shared by step-output naming and the Excel
// chain renderer so both agree on the same boundaries. Generic sentence
// shapes, never branch contents.
export function splitSequentialConditionParts(clause) {
  const parts = String(clause ?? '')
    .split(/(?<=[.;?!])\s+(?=(?:if|when)\b)/i)
    .map((s) => String(s ?? '').trim().replace(/[.;]+$/, '').trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

// Normalized assignment subject shared by every sequential IF part of a
// conditional clause, or an empty string when any part states no confident
// subject or the parts disagree. Single-IF clauses qualify trivially
// through the same per-part reading.
function unanimousBranchSubjectKey(clause) {
  const parts = splitSequentialConditionParts(clause) ?? [String(clause ?? '').trim()];
  let key = '';
  for (const part of parts) {
    const parsed = parseConditionalBranches(part);
    const subject = parsed
      ? (assignmentTargetFromBranch(parsed.true_branch) ?? assignmentTargetFromBranch(parsed.false_branch))
      : null;
    const subjectKey = subject ? normalizeVariableKey(subject) : '';
    if (!subjectKey) return '';
    if (!key) key = subjectKey;
    else if (key !== subjectKey) return '';
  }
  return key;
}

// True when the branch subject's words are the step label's trailing words
// (`discount` in `Fleet discount`), compared case-insensitively: the label
// names the same value more fully. Unrelated labels, and subjects longer
// than the label, stay false so the label is never adopted without
// demonstrated agreement.
function labelExtendsSubject(label, subject) {
  const labelWords = String(label ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const subjectWords = String(subject ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (labelWords.length === 0 || subjectWords.length === 0) return false;
  if (subjectWords.length > labelWords.length) return false;
  return subjectWords.every((word, i) => word === labelWords[labelWords.length - subjectWords.length + i]);
}

// A conditional step's descriptive output: the step label (`Step 6 — Fleet
// discount: If ...`) when the instruction carries that label before a
// colon, every sequential branch assigns the same subject matching the
// derived output, and the label extends the branch subject. The label is
// source evidence for the fuller name, so both branches and later steps
// referencing it stay consistent without inventing a technical variable.
// Returns '' unless every check holds.
function descriptiveConditionOutput(instruction, clause, output) {
  if (!output) return '';
  const label = stepLabelForOutput(instruction);
  if (!label) return '';
  const stripped = stripStepLabel(instruction).trim();
  if (!stripped.startsWith(label)) return '';
  if (!stripped.slice(label.length).trimStart().startsWith(':')) return '';
  const unanimous = unanimousBranchSubjectKey(clause);
  if (!unanimous || unanimous !== normalizeVariableKey(output)) return '';
  if (!labelExtendsSubject(label, output)) return '';
  return label;
}
// Canonicalize each step's downstream references to the exact display name
// of the producing step — the nearest preceding step with the same
// normalized output and a structured operation — including capitalization:
// input terms take the producer's display name, and the same term
// occurrences in the step expression follow, so the calculation chain names
// one value one way. Operands naming a produced variable canonicalize the
// same way, carrying an in-place output (same variable as the operand) with
// them. Definitions keep their own form: step outputs naming a new value,
// and references without a structured producer, stay untouched, as do
// instructions, evidence, and cells.
function canonicalizeStepReferences(detailed) {
  const list = Array.isArray(detailed) ? detailed : [];
  const producers = new Map();
  for (const det of list) {
    if (!det || typeof det !== 'object') continue;
    const inputs = Array.isArray(det.inputs) ? det.inputs : [];
    if (inputs.length > 0) {
      det.inputs = inputs.map((term) => producers.get(normalizeVariableKey(term)) || term);
      if (typeof det.expression === 'string' && det.expression) {
        det.expression = canonicalizeExpressionTerms(det.expression, inputs, det.operand, producers);
      }
    }
    const operand = String(det.operand ?? '').trim();
    if (operand) {
      const display = producers.get(normalizeVariableKey(operand));
      if (display && display !== operand) {
        const inPlace = normalizeVariableKey(det.output) === normalizeVariableKey(operand);
        det.operand = display;
        if (inPlace) det.output = display;
      }
    }
    const stepOp = String(det.operation ?? '').toLowerCase();
    if ((stepOp === 'condition' || stepOp === 'conditional' || stepOp === 'if') && typeof det.expression === 'string' && det.expression) {
      det.expression = canonicalizeBranchValueRefs(det.expression, producers);
    }
    const output = String(det.output ?? '').trim();
    const operation = String(det.operation ?? '').trim();
    if (output && operation && normalizeVariableKey(output)) {
      producers.set(normalizeVariableKey(output), output);
    }
  }
}

// Rewrite reference-term occurrences in a step expression to producer
// display names: each evidenced term (inputs plus operand) recases
// case-insensitively as a whole phrase, so `fleet discount` becomes `Fleet
// discount` while longer identifiers never match. Terms with no producer
// pass through untouched.
function canonicalizeExpressionTerms(expression, inputs, operand, producers) {
  let out = String(expression ?? '');
  const seen = new Set();
  const terms = [...(Array.isArray(inputs) ? inputs : []), operand];
  for (const term of terms) {
    const display = producers.get(normalizeVariableKey(term));
    if (!display) continue;
    const pattern = termPattern(term);
    if (!pattern) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${pattern}(?![A-Za-z0-9_-])`, 'gi'), () => display);
  }
  return out;
}

// A whole-phrase pattern for one reference term: words joined by flexible
// whitespace, regex-escaped, or null when the term holds no words. Shared
// by input-term and branch-value recasing.
function termPattern(term) {
  const words = String(term ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
}

// Literal first-occurrence replacement (never regex, never `$`-substituted).
function replaceFirst(haystack, needle, replacement) {
  const s = String(haystack ?? '');
  const n = String(needle ?? '');
  if (!n) return s;
  const i = s.indexOf(n);
  return i < 0 ? s : s.slice(0, i) + String(replacement ?? '') + s.slice(i + n.length);
}

// The referenced phrase of a partitive branch value (`5% of the X` → `X`),
// or '' unless the value leads with an amount followed by `of` and a
// trailing phrase. Generic partitive shape, never contents.
function partitiveTail(value) {
  const m = /^\s*\S+(?:\s+\S+)*?\s+of\s+(.+?)\s*$/i.exec(String(value ?? ''));
  if (!m) return '';
  return String(m[1] ?? '').replace(/^(the|a|an)\s+/i, '').trim();
}

// Recase partitive branch-value references in a conditional step expression
// to producer display names: each stated-value branch whose `of`-tail names
// a produced variable takes the producer's exact display name, spliced back
// through the branch substring so conditions, percentages, and order stay
// verbatim. Tails naming nothing produced pass through untouched.
function canonicalizeBranchValueRefs(expression, producers) {
  let out = String(expression ?? '');
  if (!out || producers.size === 0) return out;
  const parts = splitSequentialConditionParts(out) ?? [out];
  for (const part of parts) {
    const parsed = parseConditionalBranches(part);
    if (!parsed) continue;
    for (const branch of [parsed.true_branch, parsed.false_branch]) {
      if (!branch) continue;
      const stated = splitBranchIsValue(branch);
      if (!stated) continue;
      const tail = partitiveTail(stated.value);
      if (!tail) continue;
      const display = producers.get(normalizeVariableKey(tail));
      if (!display || display === tail) continue;
      const pattern = termPattern(tail);
      if (!pattern) continue;
      const newValue = stated.value.replace(new RegExp(`(?<![A-Za-z0-9_-])${pattern}(?![A-Za-z0-9_-])`, 'i'), () => display);
      if (newValue === stated.value) continue;
      const newBranch = replaceFirst(branch, stated.value, newValue);
      if (newBranch === branch) continue;
      out = replaceFirst(out, branch, newBranch);
    }
  }
  return out;
}

// Threshold markers that leave a numeric coverage unbounded (`exceeds 30`,
// `up to 10`, `1 or more`): exclusivity can never be established, so such
// conditions always decline. Generic comparison wording, never measure
// contents. Symbolic comparators decline the same way.
const EXCLUSIVITY_THRESHOLD_WORDS = /\b(exceeds|exceed|exceeding|more than|greater than|less than|fewer than|at least|at most|up to|or more|or less|over|above|under|below)\b/i;
const EXCLUSIVITY_SYMBOLS = /[><=]/;
const EXCLUSIVITY_NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const EXCLUSIVITY_GAP = /^[\s,–—-]*(to|through|thru|or)?[\s,–—-]*$/i;
const EXCLUSIVITY_GAP_JOINER = /to|through|thru|or|[,–—-]/i;

// Numeric coverage of one condition as { residue, min, max }, or null when
// the condition does not state exactly one bounded numeric cluster: no
// numbers, threshold markers, symbolic comparators, or numbers outside the
// cluster all decline. Spans (`3 to 10`, `3-10`) and enumerations (`1 or 2`,
// `1, 2, 3`) bound coverage; `and`-joined numbers never cluster
// (conjunction, not alternation). The residue is the condition wording with
// the cluster folded to `#`, so identical measures compare equal.
function conditionCoverage(condition) {
  const text = String(condition ?? '');
  if (!text.trim() || EXCLUSIVITY_SYMBOLS.test(text)) return null;
  if (EXCLUSIVITY_THRESHOLD_WORDS.test(text)) return null;
  const matches = [...text.matchAll(EXCLUSIVITY_NUMBER)];
  if (matches.length === 0) return null;
  const numbers = [];
  for (const m of matches) {
    const value = Number(m[0].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    let start = m.index;
    let signed = value;
    const sign = text[start - 1];
    if ((sign === '-' || sign === '−') && !/[\d–—-]/.test(text[start - 2] ?? '')) {
      start -= 1;
      signed = -signed;
    }
    const end = m.index + m[0].replace(/,+$/, '').length;
    numbers.push({ value: signed, start, end });
  }
  for (let i = 1; i < numbers.length; i += 1) {
    const gap = text.slice(numbers[i - 1].end, numbers[i].start).replace(/[%‰$€£¥]/g, '');
    if (!gap.trim() || !EXCLUSIVITY_GAP.test(gap) || !EXCLUSIVITY_GAP_JOINER.test(gap)) return null;
  }
  const residue = (text.slice(0, numbers[0].start) + '#' + text.slice(numbers[numbers.length - 1].end))
    .toLowerCase().replace(/\s+/g, ' ').trim();
  const values = numbers.map((n) => n.value);
  return { residue, min: Math.min(...values), max: Math.max(...values) };
}

// True when two condition wordings are demonstrably mutually exclusive:
// identical measure wording around one bounded numeric cluster each, with
// strictly disjoint coverage. Touching endpoints, thresholds, and prose
// stay false: exclusivity must be established, never guessed. Exported for
// the Excel chain renderer so same-subject branches chain only over
// disjoint conditions.
export function conditionsMutuallyExclusive(a, b) {
  const first = conditionCoverage(a);
  const second = conditionCoverage(b);
  if (!first || !second) return false;
  if (first.residue !== second.residue) return false;
  return first.max < second.min || second.max < first.min;
}

// Right-hand variables of one branch: values read (after equals, after
// "set X to Y", or assignment right-hand sides), excluding prose.
function rhsVarsFromBranch(branch) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!acceptableCapture(v)) return;
    if (CONDITION_FILTER_WORDS.has(String(v).toLowerCase())) return;
    const key = normalizeVariableKey(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  const text = String(branch ?? '');
  if (!text.trim()) return out;
  for (const m of text.matchAll(/\b[A-Za-z_]\w*\s+equals?\s+([A-Za-z_]\w*)/gi)) push(m[1]);
  for (const m of text.matchAll(/\bset\s+[A-Za-z_]\w*\s+to\s+([A-Za-z_]\w*)/gi)) push(m[1]);
  for (const m of text.matchAll(/\b[A-Za-z_]\w*\s+is\s+set\s+to\s+([A-Za-z_]\w*)/gi)) push(m[1]);
  for (const m of text.matchAll(/\b[A-Za-z_]\w*\s*=\s*([^;]+)/g)) {
    for (const v of identifiersOf(m[1] ?? '')) {
      if (CONDITION_FILTER_WORDS.has(v.toLowerCase())) continue;
      push(v);
    }
  }
  return out;
}

// Condition variables worth tracing: snake_case or short identifiers, or
// words that also appear in the branches. Multi-word prose without branch
// overlap stays out so eligibility prose does not become false inputs.
function conditionInputVars(condition, branchText, output) {
  const condIds = identifiersOf(condition ?? '')
    .filter((v) => acceptableCapture(v) && !CONDITION_FILTER_WORDS.has(v.toLowerCase()));
  if (condIds.length === 0) return [];
  const branchKeys = new Set(identifiersOf(branchText ?? '').map((v) => normalizeVariableKey(v)));
  const outKey = output ? normalizeVariableKey(output) : '';
  const out = [];
  const seen = new Set();
  for (const v of condIds) {
    const key = normalizeVariableKey(v);
    if (!key || key === outKey || seen.has(key)) continue;
    if (v.includes('_') || v.length <= 2 || branchKeys.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

// A numeric literal for operand purposes: digits with optional thousands
// separators, decimals, sign, percent, currency, or one layer of
// parentheses (accounting style). Such fragments are values, never variable
// references, so they never become step inputs.
const NUMERIC_PAREN_WRAPPER = /^\(\s*(.+?)\s*\)$/;
function isNumericFragment(text) {
  let s = String(text ?? '').trim();
  const paren = NUMERIC_PAREN_WRAPPER.exec(s);
  if (paren) s = paren[1].trim();
  s = s.replace(/^[₹$€£¥\s]+|[₹$€£¥\s]+$/g, '').replace(/%$/, '').replace(/,/g, '').trim();
  return /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s);
}

// A parenthetical group holding only a value ("(2,000)", "(4.50%)") is
// instance data, not part of the operand name: strip it for the input term.
// The full fragment stays verbatim in the step expression.
function cleanArithmeticOperand(fragment) {
  const cleaned = String(fragment ?? '')
    .replace(/\(\s*[₹$€£¥\d,.\s%+-]+\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(fragment ?? '').trim();
}

function balancedParensLocal(text) {
  let depth = 0;
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

// Clause punctuation that turns a line into labelled prose rather than a
// bare calculation: key/value separators, pipes, sentence marks, and
// bracket groups. En/em dashes are prose separators too, never arithmetic,
// so ranges ("2–10") and result tails ("— 1,240.00") never parse as minus.
const BARE_REJECT_CHARS = /[;:|?!=\[\]{}–—−]/;

// A whole-expression operand: a code, variable, number, or short phrase —
// never a labelled clause, quantity prose ("50 split"), or a computed
// amount tail ("CPA ₹100").
function operandLikeWhole(fragment) {
  const frag = String(fragment ?? '').trim();
  if (!frag || BARE_REJECT_CHARS.test(frag)) return false;
  const withoutParens = frag.replace(/\([^()]*\)/g, ' ');
  if (withoutParens.includes(',') && !/^\d[\d,]*(\.\d+)?%?$/.test(frag)) return false;
  // A digit-led fragment carrying letters is a measured amount, not an
  // arithmetic operand ("1,000cc"); letter-led codes ("LX-01") pass.
  if (/[-+]?\d[\d,.\s%]*[A-Za-z]/.test(withoutParens)) return false;
  // Bare currency outside parentheses is a computed amount tail; values in
  // parentheses ("Base (2,000)") are legitimate operand detail.
  if (/[₹$€£¥]/.test(withoutParens)) return false;
  const tokens = frag.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;
  if (tokens.length === 1) return true;
  // Multi-word operands need a value group or a uniformly capitalized term;
  // mixed-case phrases ("Apply discount") are surrounding prose.
  if (/\([^()]*\)/.test(frag)) return true;
  return tokens.every((t) => /^[A-Z0-9]/.test(t));
}

// Strict operands for minus-only lines, where a spaced hyphen is as likely
// editorial ("risk - adjusted") as arithmetic: single codes, capitalized
// terms, or numbers — never plain lowercase words or phrases.
function strictMinusOperand(fragment) {
  const frag = String(fragment ?? '').trim();
  if (!frag || /\s/.test(frag) || BARE_REJECT_CHARS.test(frag)) return false;
  if (frag.length < 2) return false;
  if (/^\d[\d,]*(\.\d+)?%?$/.test(frag)) return true;
  if (/^[A-Z]/.test(frag)) return true;
  return /^[A-Za-z_]/.test(frag) && /[0-9_.-]/.test(frag);
}

// Split a bare calculation on explicit binary operators: + * / × ÷ anywhere,
// ASCII hyphen only when spaced on both sides (hyphenated codes and unary
// signs never split). Returns {operands, ops} or null when no operator joins
// two sides.
function splitArithmeticOperands(text) {
  const s = String(text ?? '');
  const operands = [];
  const ops = [];
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    let op = null;
    if (ch === '+' || ch === '*' || ch === '/' || ch === '×' || ch === '÷' || ch === '·' || ch === '•' || ch === '−' || ch === '^') {
      op = ch;
    } else if (ch === '-' && (s[i - 1] === ' ' || s[i - 1] === '\t') && (s[i + 1] === ' ' || s[i + 1] === '\t')) {
      op = '-';
    }
    if (op) {
      operands.push(s.slice(start, i));
      ops.push(op);
      start = i + 1;
    }
  }
  operands.push(s.slice(start));
  if (ops.length === 0) return null;
  return { operands, ops };
}

function dedupeInputs(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = String(term ?? '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

// Generic word operations the model sometimes emits instead of the canonical
// 'expression'/'rounding' kinds. Plain English arithmetic verbs, never domain
// vocabulary. Symbolic glyphs ('*', '+', '<--') bypass this mapping and stay
// verbatim so explicit symbolic rows keep rendering as explicit-op rows.
const ARITHMETIC_WORD_OPS = new Set([
  'multiply', 'multiplies', 'multiplied', 'multiplication', 'product', 'times',
  'add', 'adds', 'added', 'addition', 'sum', 'plus',
  'subtract', 'subtracts', 'subtracted', 'subtraction', 'minus', 'difference',
  'divide', 'divides', 'divided', 'division', 'quotient',
  'calculate', 'calculates', 'calculated', 'calculation',
  'compute', 'computes', 'computed', 'computation',
]);
const ROUNDING_WORD_OPS = new Set(['round', 'rounds', 'rounded', 'rounding', 'roundoff', 'round-off']);

// A step output carrying a worked-example value ("LX-01 = 1,240.00") keeps
// only its evidenced target code; a bare worked amount ("1,240.00",
// "₹44,287.00") yields no reusable output at all. The full source text
// stays verbatim in the step instruction/evidence. Exported for the Excel
// routine-step renderer so stored jobs predating normalization still
// display cleaned reusable columns.
export function cleanStepOutputValue(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  const eqIdx = s.indexOf('=');
  if (eqIdx >= 0) {
    const left = s.slice(0, eqIdx).trim().replace(/[.;]+$/, '').trim();
    s = left;
  } else {
    s = s.replace(/[.;]+$/, '').trim();
  }
  if (!s || isNumericFragment(s)) return '';
  return s;
}

// True for a numeric token that reads as a worked amount rather than part
// of a key: currency/percent/comma/decimal forms or multi-digit values.
// Plain small integers ("Tier 2", "Table 1") stay so keys are never
// corrupted by stripping.
function isWorkedAmountToken(token) {
  const s = String(token ?? '').trim();
  if (!s) return false;
  if (/^\d{1,3}$/.test(s)) return false;
  return isNumericFragment(s);
}

// A step input with worked-example detail keeps only its reusable term:
// parenthetical values ("Zone Rate (4.50%)" to "Zone Rate"), leading
// currency amounts ("₹1,000,000 IDV" to "IDV"), and trailing amount clauses
// ("Net Premium: ₹37,531.00" to "Net Premium") are stripped. Pure values
// ("20.00%", "0.750%") yield '' so they never become reusable inputs.
// A per-unit amount qualifier ("Harbor Fee per $100") is part of the label
// and is kept, so the term still matches the source column. Ambiguous
// descriptive text is otherwise retained verbatim for review.
// Exported for the Excel renderer (see cleanStepOutputValue).
export function cleanStepInputValue(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/\(\s*[₹$€£¥\d,.\s%+-]+\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || isNumericFragment(s)) return '';
  const kept = [];
  for (const tok of s.split(/\s+/)) {
    let stripped = tok.replace(/^[:;|@,(){}"'`]+|[:;|@,(){}"'`]+$/g, '');
    if (stripped && !/^[A-Za-z_][\w.-]*\[[^\[\]]+\]$/.test(stripped)) {
      stripped = stripped.replace(/^[\[\]]+|[\[\]]+$/g, '');
    }
    if (!stripped) continue;
    if (/^[₹$€£¥%‰]+$/.test(stripped)) continue;
    if (isWorkedAmountToken(stripped)) {
      const prev = kept.length > 0 ? String(kept[kept.length - 1]).toLowerCase() : '';
      if (prev !== 'per' && prev !== '/') continue;
    }
    kept.push(stripped);
  }
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (!out || isNumericFragment(out)) return '';
  return out;
}

// Explicit arithmetic evidence: an operator joining two sides (infix `x`
// counts: `Base x Factor`), or an assignment form ("Basis = 1") with a
// target and a right-hand side. Call-form evaluations also count; otherwise prose is not
// arithmetic.
function hasArithmeticEvidence(expr) {
  const s = String(expr ?? '').trim();
  if (!s) return false;
  if (splitArithmeticOperands(normalizeInfixMultiply(s))) return true;
  if (isCallFormExpression(s)) return true;
  const eq = /^(.*?)\s*=\s*(.+?)\s*$/.exec(s.replace(/\.\s*$/, ''));
  return Boolean(eq && eq[1].trim() && eq[2].trim());
}

// Drop a model-provided operation whose evidence does not support it. The
// instruction, sequence, and source references stay so the ambiguous text
// is retained and flagged for review; only the unsupported structured
// interpretation is removed.
function demoteExplicitStepToUnparsed(out) {
  delete out.operation;
  delete out.expression;
  delete out.operand;
  delete out.inputs;
  delete out.output;
  delete out.depends_on;
  delete out.interpretation_status;
  delete out.stated_results;
}

// Canonicalize a model-provided step operation and strip worked-example
// values from its reusable fields. Word arithmetic ("multiply"/"add")
// becomes 'expression' only with an evidenced operator or assignment;
// "round" becomes 'rounding'; lookups always keep their verb (missing keys
// are flagged by validation); assignments keep an explicit target with its
// stated value (an "=" form, or an output paired with an expression or
// operand). Anything else demotes to unparsed so descriptive text never
// renders as executable logic. Symbolic glyph operations and already-clean
// canonical steps pass through untouched. Exported for the Excel renderer
// so stored jobs predating normalization display the same cleaned columns.
export function sanitizeExplicitStep(out) {
  if (!out || !out.operation) return;
  const origOp = String(out.operation).trim();
  if (!origOp) return;
  if (out.output !== undefined) {
    const cleaned = cleanStepOutputValue(out.output);
    if (cleaned) out.output = cleaned;
    else delete out.output;
  }
  if (out.inputs !== undefined) {
    const cleaned = (out.inputs ?? []).map(cleanStepInputValue).filter((v) => v && String(v).trim());
    if (cleaned.length > 0) out.inputs = dedupeInputs(cleaned);
    else delete out.inputs;
  }
  if (/^[^A-Za-z0-9\s]+$/.test(origOp)) return;
  const low = origOp.toLowerCase();
  let canonical = null;
  if (ARITHMETIC_WORD_OPS.has(low)) canonical = 'expression';
  else if (ROUNDING_WORD_OPS.has(low) || low === 'r') canonical = 'rounding';
  else if (low.includes('lookup') || low.includes('look-up')) canonical = 'lookup';
  else if (low === 'expression' || low === 'assignment') canonical = low;
  else if (low === 'condition' || low === 'conditional' || low === 'if' || low === 'elseif' || low === 'else') {
    canonical = low === 'conditional' ? 'condition' : low;
  } else {
    if (hasArithmeticEvidence(String(out.expression ?? out.operand ?? ''))) canonical = 'expression';
    else {
      demoteExplicitStepToUnparsed(out);
      return;
    }
  }
  if (canonical === 'expression') {
    if (!hasArithmeticEvidence(String(out.expression ?? out.operand ?? ''))) {
      demoteExplicitStepToUnparsed(out);
      return;
    }
    out.operation = 'expression';
  } else if (canonical === 'rounding') {
    out.operation = 'rounding';
  } else if (canonical === 'lookup') {
    out.operation = 'lookup';
  } else if (canonical === 'assignment') {
    const output = String(out.output ?? '').trim();
    const exprText = String(out.expression ?? '').trim();
    const operandText = String(out.operand ?? '').trim();
    const combined = exprText || operandText;
    const eq = /^(.*?)\s*=\s*(.+?)\s*$/.exec(combined.replace(/\.\s*$/, ''));
    const hasEqualsForm = Boolean(eq && eq[1].trim() && eq[2].trim());
    if (!hasEqualsForm && (!output || !combined)) {
      demoteExplicitStepToUnparsed(out);
      return;
    }
    out.operation = 'assignment';
  } else {
    out.operation = canonical;
  }
}

// Parse a whole step line as one arithmetic expression. Returns
// {expression, inputs} or null when the line is not safely readable as bare
// arithmetic.
function tryWholeArithmetic(text) {
  const split = splitArithmeticOperands(text);
  if (!split) return null;
  const operands = split.operands.map((o) => String(o ?? '').trim());
  if (operands.some((o) => !o)) return null;
  if (split.ops.every((o) => o === '-')) {
    if (!operands.every(strictMinusOperand)) return null;
  } else {
    if (!operands.every(operandLikeWhole)) return null;
    // A lone single character beside a phrase or a slash is an abbreviation
    // ("P/C guidelines", "a/b testing"), not a variable in arithmetic.
    if (operands.some((o) => o.length === 1)
      && (operands.some((o) => /\s/.test(o)) || split.ops.includes('/'))) {
      return null;
    }
  }
  const inputs = [];
  for (const o of operands) {
    const cleaned = cleanArithmeticOperand(o);
    if (!cleaned || isNumericFragment(cleaned)) continue;
    inputs.push(cleaned);
  }
  return { expression: String(text ?? '').trim(), inputs: dedupeInputs(inputs) };
}

function matchEmbeddedToken(s, at) {
  const rest = s.slice(at);
  const word = /^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*(?:\.[A-Za-z0-9_]+)*/.exec(rest);
  if (word) return word[0];
  const num = /^\d[\d,]*(?:\.\d+)?%?/.exec(rest);
  if (num) return num[0];
  return null;
}

// Strict single-token operands for arithmetic embedded in labelled prose:
// codes, capitalized terms, dotted keys, underscored variables, or numbers —
// each at least two characters so abbreviations ("P/C") and bare letters
// never seed a run. Returns false for connective words ("and", "or").
function embeddedTokenOk(token) {
  if (!token || token.length < 2) return false;
  if (NON_CAPTURE_WORDS.has(String(token).toLowerCase())) return false;
  return true;
}

// Code-like tokens (capitals, digits, underscores, dots, hyphens)
// self-delimit against adjacent prose; plain lowercase words need signal
// boundaries and never join a minus run.
function embeddedTokenStrict(token) {
  return /[A-Z0-9_.-]/.test(String(token ?? ''));
}

// Find one maximal run of strict single-token operands joined by explicit
// operators inside a labelled line ("Subtotal LX-01 + LX-02 — 1,240.00").
// Phrase operands with fuzzy boundaries are rejected: only the operator core
// with clean token edges is extracted. Returns {expression, inputs} or null.
function tryEmbeddedArithmetic(text) {
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    const token = matchEmbeddedToken(s, i);
    if (!token || !embeddedTokenOk(token)) {
      i += 1;
      continue;
    }
    const prev = s.slice(0, i);
    if (!embeddedTokenStrict(token) && /[A-Za-z0-9]\s+$/.test(prev)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_.-]$/.test(prev)) {
      i += 1;
      continue;
    }
    const operands = [token];
    const ops = [];
    let j = i + token.length;
    for (;;) {
      const gap = /^\s*/.exec(s.slice(j))[0];
      let k = j + gap.length;
      const ch = s[k];
      let op = null;
      if (ch === '+' || ch === '*' || ch === '/' || ch === '×' || ch === '÷') op = ch;
      else if (ch === '-' && gap.length > 0 && /^\s/.test(s.slice(k + 1, k + 2))) op = '-';
      if (!op) break;
      k += 1;
      k += /^\s*/.exec(s.slice(k))[0].length;
      const next = matchEmbeddedToken(s, k);
      if (!next || !embeddedTokenOk(next)) break;
      operands.push(next);
      ops.push(op);
      j = k + next.length;
    }
    if (operands.length < 2) {
      i += 1;
      continue;
    }
    // The run must not continue the arithmetic chain on either side: a
    // longer chain with a fuzzy edge is prose, not an extractable core.
    if (/[+*/×÷]\s*$/.test(prev) || /(?:^|\s)-\s*$/.test(prev)) {
      i = j;
      continue;
    }
    const after = s.slice(j);
    if (/^\s*[+*/×÷]/.test(after) || /^\s*-\s/.test(after)) {
      i = j;
      continue;
    }
    // Minus runs need strict operands throughout ("risk - adjusted" is
    // prose); plus-style runs may join plain words ("cost + tax" reads as
    // arithmetic).
    if (ops.includes('-') && !operands.every(embeddedTokenStrict)) {
      i = j;
      continue;
    }
    // No partial token on the right, and a non-code final operand must not
    // continue into prose.
    if (/^[A-Za-z0-9_.-]/.test(after)) {
      i = j;
      continue;
    }
    if (/^\s+[A-Za-z0-9]/.test(after) && !embeddedTokenStrict(operands[operands.length - 1])) {
      i = j;
      continue;
    }
    const inputs = [];
    for (const o of operands) {
      const cleaned = cleanArithmeticOperand(o);
      if (!cleaned || isNumericFragment(cleaned)) continue;
      inputs.push(cleaned);
    }
    return { expression: s.slice(i, j), inputs: dedupeInputs(inputs) };
  }
  return null;
}

// Parse explicit arithmetic without a leading assignment: result form
// ("A + B = C", "A + B = 1.00"), a whole-line expression, or an embedded
// operator core. Returns {expression, inputs, output?} or null. No output,
// operand, or execution order is invented: targetless calculations keep
// their verbatim line and are flagged incomplete by validation.
// Parse a bare evaluated equality (`2 x $150.00 = $300.00`, `sum of parts =
// 1.791`): an arithmetic or sum-worded left side with a worked numeric
// value and no output variable anywhere. A `label:` prefix is stripped so
// the calculation core keeps the row; the instruction stays verbatim. Only
// reached when every assigned and bare-arithmetic reading failed, so
// result-form lines keep their existing shape. Never invents an output:
// validation flags the unstated target for the analyst.
function tryParseBareEquality(body) {
  const main = splitMainClause(String(body ?? ''));
  if (!main || !main.includes('=')) return null;
  const eqs = [];
  for (let i = 0; i < main.length; i += 1) {
    if (isStandaloneEquals(main, i)) eqs.push(i);
  }
  if (eqs.length !== 1) return null;
  let lhs = main.slice(0, eqs[0]).trim();
  const value = main.slice(eqs[0] + 1).trim().replace(/[.,]\s*$/, '').trim();
  if (!lhs || !value) return null;
  if (!isWorkedResult(value)) return null;
  const run = trailingOutputRun(lhs, 4);
  if (run && run.start === 0) return null;
  const colon = lhs.lastIndexOf(':');
  if (colon >= 0) {
    const core = lhs.slice(colon + 1).trim();
    if (core) lhs = core;
  }
  const arithmetical = CHAINED_MIDDLE_OPERATOR.test(lhs);
  const sumWorded = /^(sum|total|difference|product)\s+of\b/i.test(lhs);
  if (!arithmetical && !sumWorded) return null;
  const expression = `${lhs} = ${cleanWorkedResult(value)}`;
  const inputs = [];
  if (arithmetical) {
    assignmentInputVars(normalizeInfixMultiply(lhs), new Set(), new Set(), inputs);
  }
  return { expression, inputs };
}

// Parse a bare symbolic comparison (`Preconciled > minimum premium`) as a
// check condition: a variable-like left side, one comparator, and a stated
// threshold. Only reached for `=`-less lines every other reading rejected,
// so worked evaluations and prose never land here. Arrows (`->`) are not
// comparators.
function tryParseBareComparison(body) {
  const main = splitMainClause(String(body ?? ''));
  if (!main || main.includes('=') || main.includes(';')) return null;
  const m = /^(.+?)\s*(>=|<=|>|<)\s*(.+?)\s*$/.exec(main.trim());
  if (!m) return null;
  const left = m[1].trim();
  const op = m[2];
  const right = m[3].trim();
  if (!left || !right) return null;
  if (op === '>' && /-$/.test(left)) return null;
  if (op === '<' && /^[-=]/.test(right)) return null;
  if (!/[A-Za-z0-9_$,]/.test(right)) return null;
  if (/[?;]/.test(right)) return null;
  const run = trailingOutputRun(left, 4);
  if (!run) return null;
  const inputs = [run.output];
  if (/^[A-Za-z_]\w*$/.test(right) && acceptableCapture(right)) inputs.push(right);
  return { expression: `${run.output} ${op} ${right}`, inputs };
}

function tryParseBareArithmetic(body) {
  const text = String(body ?? '').trim().replace(/\.\s*$/, '');
  if (!text || !balancedParensLocal(text)) return null;
  // Labelled, piped, questioned, or multi-clause lines are prose, not bare
  // calculations.
  if (/[;:|?!]/.test(text)) return null;
  if (/,\s*[A-Za-z]/.test(text)) return null;
  const eq = /^(.*)\s*=\s*(.+?)\s*$/.exec(text);
  if (eq && !eq[1].includes('=')) {
    const lhs = eq[1].trim();
    const rhs = eq[2].trim();
    const parsed = tryWholeArithmetic(lhs) ?? tryEmbeddedArithmetic(lhs);
    if (!parsed) return null;
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rhs) && acceptableCapture(rhs)) {
      return { expression: parsed.expression, inputs: parsed.inputs, output: rhs };
    }
    if (isNumericFragment(rhs)) return { expression: parsed.expression, inputs: parsed.inputs };
    return null;
  }
  if (text.includes('=')) return null;
  return tryWholeArithmetic(text) ?? tryEmbeddedArithmetic(text);
}

// Rounding stated outside the directive position ("Rounded Half-Up to ...",
// "..., rounded to nearest ...", "Keep X at N decimal places"). The target
// is captured only in strict shapes ("round <variable> to ...",
// "keep <variable> at ...") so rounding modes ("Half-Up") never become
// variables; anything else yields the operation without an invented target.
// Labels (`Rounding:`), temporal references (`before rounding`), and
// negations (`do not round`) never count as rounding directives.
function tryParseRoundingAnywhere(body) {
  const s = String(body ?? '');
  const keep = /\b(?:keep|retain)\s+(?:the\s+)?([A-Za-z_]\w*)\s+at\s+\d+\s+(?:decimal\s+places|decimals|places)\b/i.exec(s);
  if (keep && acceptableCapture(keep[1])) {
    return { operation: 'rounding', operand: keep[1], output: keep[1] };
  }
  const matches = [...s.matchAll(/\bround(?:ed|ing|s)?\b/gi)];
  const m = matches.find((cand) => {
    const before = s.slice(0, cand.index ?? 0);
    const rest = s.slice((cand.index ?? 0) + cand[0].length);
    if (/^\s*:/.test(rest)) return false;
    if (/\b(?:before|after)\s+$/i.test(before)) return false;
    return !/\b(?:do\s+not|don't|never|without|no)\s+$/i.test(before);
  });
  if (!m) return null;
  const after = s.slice(m.index + m[0].length);
  const out = { operation: 'rounding' };
  const target = /^\s*(?:only\s+|just\s+)?(?:the\s+|a\s+|an\s+)?([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*){0,2})\s+to\b/i.exec(after);
  let operand = '';
  if (target && isRoundingTargetPhrase(target[1])) operand = target[1].replace(/\s+/g, ' ').trim();
  const stored = /\bstore\b.*?as\s+([A-Za-z_]\w*)/i.exec(s);
  const storedOutput = stored && acceptableCapture(stored[1]) ? stored[1] : '';
  if (operand) out.operand = operand;
  if (storedOutput) {
    out.output = storedOutput;
    if (operand && normalizeVariableKey(storedOutput) !== normalizeVariableKey(operand)) {
      out.inputs = [operand];
    }
  } else if (operand) {
    out.output = operand;
  }
  return out;
}

// Breakdown rows extracted as plain strings ("CODE value"): a leading code
// token identifies the row's output only when the remainder is a single
// short value (no operators, no multi-part markers, at most a few words).
// Operator-bearing remainders are handled by the arithmetic parsers above;
// anything longer without an isolatable core stays REVIEW. Only the
// evidenced code and remainder are used; no names or values are invented.
// Bare calculations ("LX-01 + LX-02"), incomplete fragments, "=" forms
// (output conflict), and reference pointers ("see ...") are excluded so
// they keep their existing handling (parsed arithmetic or REVIEW).
// Generic syntax (code shape, operators, term length), never domain
// vocabulary.
function tryParseLeadingCodeAssignment(body) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  const m = /^([A-Z0-9]{2,}-[A-Z0-9]+)\s+(.+?)\s*$/.exec(text);
  if (!m) return null;
  const output = m[1];
  const remainder = m[2].trim().replace(/\.\s*$/, '').trim();
  if (!remainder) return null;
  if (/^[+*/×÷%=-]/.test(remainder)) return null;
  if (/[+*/×÷%-]\s*$/.test(remainder)) return null;
  if (/=\s*$/.test(remainder)) return null;
  if (remainder.includes('=')) return null;
  if (/^(see|refer|check|consult|cf)\b/i.test(remainder)) return null;
  if (/[;:|?!]/.test(remainder)) return null;
  if (hasArithmeticEvidence(remainder) && !isCallFormExpression(remainder)) return null;
  if (remainder.split(/\s+/).filter(Boolean).length > 4) return null;
  return { operation: 'assignment', output, expression: remainder };
}

// Output label standing before an isolated calculation core inside a
// labelled breakdown line ("OD-NET Net Subtotal OD-01 + DISC-01"). A
// leading code token yields just the code; any other non-empty prefix
// yields the trimmed label (trailing label punctuation stripped). The
// reference layout requires Instruction to hold the output, never the
// arithmetic expression, so the evidenced prefix becomes the output and
// the isolated core keeps the operands. Returns null when the expression
// opens the line (bare calculation with no label to evidence an output).
function inferCalculationOutput(body, expression) {
  const text = String(body ?? '');
  const core = String(expression ?? '').trim();
  if (!text || !core) return null;
  const idx = text.indexOf(core);
  if (idx <= 0) return null;
  const prefix = text.slice(0, idx).trim().replace(/[:;.]+\s*$/, '').trim();
  if (!prefix) return null;
  const code = /^([A-Z0-9]{2,}-[A-Z0-9]+)\b/.exec(prefix);
  if (code) return code[1];
  return prefix;
}

// Split text on top-level arithmetic operators, tracking paren depth so
// amount groups never split. `+ * / × ÷` split anywhere; ASCII hyphen
// splits only when spaced (hyphenated codes never split); bare `%` never
// splits (percents in breakdown lines are values, not modulo). Returns
// { parts, ops } or null when no operator joins two sides.
function splitTopLevelOperators(text) {
  const s = String(text ?? '');
  const parts = [];
  const ops = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (depth === 0) {
      if (ch === '+' || ch === '*' || ch === '/' || ch === '×' || ch === '÷' || ch === '·' || ch === '•' || ch === '−' || ch === '^') {
        parts.push(current);
        ops.push(ch);
        current = '';
        continue;
      }
      if (ch === '-' && /\s/.test(s[i - 1] ?? ' ') && /\s/.test(s[i + 1] ?? ' ')) {
        parts.push(current);
        ops.push(ch);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  if (ops.length === 0) return null;
  return { parts, ops };
}

// A single operand word inside a phrase: starts uppercase or numeric and
// carries no parens, operators, or label punctuation. Lowercase words
// are label prose or trailing detail, never operand terms.
function isOperandWord(token) {
  const t = String(token ?? '').trim();
  if (!t) return false;
  if (/[()+\-*/×÷%=;|?!:@]/.test(t)) return false;
  return /^[A-Z0-9]/.test(t);
}

// Trailing amount group (`(2,000)`, `(4.50%)`) at the end of a segment:
// instance values attached to an operand phrase. Letters disqualify
// (grouping or code detail, never a worked amount). Returns the group
// text or '' when none is evidenced.
function trailingAmountGroup(segment) {
  const m = /\(\s*[₹$€£¥\d,.\s%+-]+\s*\)\s*$/.exec(String(segment ?? ''));
  return m ? m[0].trim() : '';
}

// Trailing operand phrase on the label side: up to two trailing
// capitalized-or-numeric words plus an optional amount group. Capped so
// descriptive labels are never absorbed; the full source text stays in
// the instruction. Returns { term, core } or null.
function trailingOperandPhrase(segment) {
  let s = String(segment ?? '').trim().replace(/[.;]+\s*$/, '').trim();
  if (!s) return null;
  let amount = '';
  const group = trailingAmountGroup(s);
  if (group) {
    amount = group;
    s = s.slice(0, s.length - group.length).trim();
  }
  const tokens = s.split(/\s+/).filter(Boolean);
  const words = [];
  for (let i = tokens.length - 1; i >= 0 && words.length < 2; i -= 1) {
    const tok = tokens[i].replace(/[,;:]+$/, '');
    if (!isOperandWord(tok) || isWorkedAmountToken(tok)) break;
    words.unshift(tok);
  }
  if (words.length === 0) return null;
  const term = words.join(' ');
  return { term, core: amount ? `${term} ${amount}` : term };
}

// Leading operand phrase on the operator side: capitalized-or-numeric
// words plus an optional amount group, stopping at bare amounts,
// lowercase prose, or any paren group. Bounded by the operator, so it
// takes all words to its boundary (validated to four or fewer, like
// every phrase operand). Returns { term, core } or null.
function leadingOperandPhrase(segment) {
  const s = String(segment ?? '').trim().replace(/[.;]+\s*$/, '').trim();
  if (!s) return null;
  const tokens = s.split(/\s+/).filter(Boolean);
  const words = [];
  let amount = '';
  for (const tok of tokens) {
    if (tok.includes('(') || tok.includes(')')) {
      if (words.length > 0 && /^\(\s*[₹$€£¥\d,.\s%+-]+\s*\)$/.test(tok)) {
        amount = tok;
      }
      break;
    }
    const clean = tok.replace(/[,;:]+$/, '');
    if (!isOperandWord(clean) || isWorkedAmountToken(clean)) break;
    words.push(clean);
    if (words.length > 4) return null;
  }
  if (words.length === 0) return null;
  const term = words.join(' ');
  return { term, core: amount ? `${term} ${amount}` : term };
}

// A middle operand phrase stands wholly between two operators:
// capitalized-or-numeric words with at most one trailing amount group,
// four words or fewer. Returns { term, core } or null.
function wholeOperandPhrase(segment) {
  let s = String(segment ?? '').trim().replace(/[.;]+\s*$/, '').trim();
  if (!s) return null;
  let amount = '';
  const group = trailingAmountGroup(s);
  if (group) {
    amount = group;
    s = s.slice(0, s.length - group.length).trim();
  }
  if (/[()]/.test(s)) return null;
  const tokens = s.split(/\s+/).filter(Boolean).map((t) => t.replace(/[,;:]+$/, ''));
  if (tokens.length === 0 || tokens.length > 4) return null;
  for (const tok of tokens) {
    if (!isOperandWord(tok) || isWorkedAmountToken(tok)) return null;
  }
  const term = tokens.join(' ');
  return { term, core: amount ? `${term} ${amount}` : term };
}

// A code-led breakdown row with a phrase calculation: leading output
// code, descriptive label, then operator-joined phrases with
// worked-amount groups and optional trailing worked columns
// (`CODE label PhraseA (1,000) × PhraseB (2.50%) [tail]`). Isolates the
// operator core so the code becomes the output and each phrase becomes
// one operand; amount groups stay in the expression (stripped for inputs
// and workbook operands) and trailing columns are ignored. Single-letter
// terms are abbreviations, never operands. Returns null unless every
// operand isolates cleanly, so partial structure never poses as a
// confident parse. Generic syntax (code shape, operators, phrase bounds),
// never domain vocabulary.
function tryParseCodeLedPhraseArithmetic(body) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  const code = /^([A-Z0-9]{2,}-[A-Z0-9]+)\s+(.+?)\s*$/.exec(text);
  if (!code) return null;
  const output = code[1];
  const rest = code[2];
  if (!/[+*/×÷-]/.test(rest)) return null;
  const split = splitTopLevelOperators(rest);
  if (!split || split.parts.length < 2) return null;
  const { parts, ops } = split;
  const first = trailingOperandPhrase(parts[0]);
  if (!first) return null;
  const last = leadingOperandPhrase(parts[parts.length - 1]);
  if (!last) return null;
  const mids = [];
  for (let i = 1; i < parts.length - 1; i += 1) {
    const mid = wholeOperandPhrase(parts[i]);
    if (!mid) return null;
    mids.push(mid);
  }
  const cores = [first.core, ...mids.map((m) => m.core), last.core];
  const terms = [first.term, ...mids.map((m) => m.term), last.term];
  if (terms.some((t) => t.length < 2)) return null;
  const expression = cores[0] + ops.map((op, i) => ` ${op} ${cores[i + 1]}`).join('');
  return { operation: 'expression', output, expression, inputs: dedupeInputs(terms) };
}

// Derive step operation/expression/operand/inputs/output from explicit
// wording. Only confident syntactic patterns produce fields; anything else
// yields a minimal entry so the source text is never embellished.
function deriveStepDetail(text) {
  const entry = { instruction: String(text ?? '') };
  const full = String(text ?? '').trim();
  if (!full) return entry;
  const body = stripStepLabel(full);
  // A `Label: <imperative clause>` step parses its clause for the operation
  // while the label names the result; anything else parses the whole body.
  const labeled = splitLabelClause(body);
  const verbText = labeled ? labeled.clause : body;
  const labelOutput = labeled && !isStepBackrefLabel(labeled.label) ? labeled.label : '';
  let derived = false;
  const lookupParsed = isLookupVerbStart(verbText) ? tryParseLookup(verbText) : null;
  if (isClassicLookupStart(verbText)) {
    entry.operation = 'lookup';
    derived = true;
    if (lookupParsed) {
      if (labelOutput || lookupParsed.output) entry.output = labelOutput || lookupParsed.output;
      if (lookupParsed.inputs.length > 0) entry.inputs = lookupParsed.inputs;
      if (lookupParsed.depends_on.length > 0) entry.depends_on = lookupParsed.depends_on;
    }
  } else if (lookupParsed) {
    entry.operation = 'lookup';
    derived = true;
    if (labelOutput || lookupParsed.output) entry.output = labelOutput || lookupParsed.output;
    if (lookupParsed.inputs.length > 0) entry.inputs = lookupParsed.inputs;
    if (lookupParsed.depends_on.length > 0) entry.depends_on = lookupParsed.depends_on;
  } else if (/^round\b/i.test(body)) {
    entry.operation = 'rounding';
    derived = true;
    const anchored = /^round\s+(?:only\s+|just\s+)?(?:the\s+|a\s+|an\s+)?([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*){0,2})\s+to\b/i.exec(body);
    const single = /^round\s+([A-Za-z_]\w*)/i.exec(body);
    const target = (anchored && isRoundingTargetPhrase(anchored[1]) ? anchored : single);
    let operand = '';
    let proseOutput = false;
    if (target && isRoundingTargetPhrase(target[1])) operand = target[1].replace(/\s+/g, ' ').trim();
    const stored = /\bstore\b.*?as\s+([A-Za-z_]\w*)/i.exec(body);
    const storedOutput = stored && acceptableCapture(stored[1]) ? stored[1] : '';
    if (operand) entry.operand = operand;
    if (storedOutput) {
      entry.output = storedOutput;
      if (operand && normalizeVariableKey(storedOutput) !== normalizeVariableKey(operand)) {
        entry.inputs = [operand];
      }
    } else if (operand) {
      entry.output = operand;
      proseOutput = true;
    }
    // A rounding directive carrying an explicit assignment (`Round ...:
    // out=round_fn(x;2)`) evidences its target and source through the
    // assignment; prose targets never become variables.
    if (!entry.output || proseOutput) {
      const trailing = parseTrailingAssignments(body);
      if (trailing) {
        entry.output = trailing.output;
        if (trailing.inputs.length > 0) entry.inputs = trailing.inputs;
      }
    }
  } else {
    const clause = extractConditionalClause(body);
    const parsed = clause ? parseConditionalBranches(clause) : null;
    if (parsed && (parsed.condition || parsed.true_branch || parsed.false_branch)) {
      entry.operation = 'condition';
      entry.expression = clause.replace(/[.;]+$/, '').trim();
      const output = assignmentTargetFromBranch(parsed.true_branch)
        ?? assignmentTargetFromBranch(parsed.false_branch);
      if (output) entry.output = output;
      const descriptive = output ? descriptiveConditionOutput(full, clause, output) : '';
      if (descriptive) entry.output = descriptive;
      const branchText = `${parsed.true_branch ?? ''} ${parsed.false_branch ?? ''}`;
      const condVars = parsed.condition ? conditionInputVars(parsed.condition, stripNestedConditionClauses(branchText), output) : [];
      const rhsVars = [...rhsVarsFromBranch(parsed.true_branch), ...rhsVarsFromBranch(parsed.false_branch)];
      const combined = [];
      const seen = new Set();
      const outKey = output ? normalizeVariableKey(output) : '';
      for (const v of [...condVars, ...rhsVars]) {
        const key = normalizeVariableKey(v);
        if (!key || key === outKey || seen.has(key)) continue;
        seen.add(key);
        combined.push(v);
      }
      if (combined.length > 0) entry.inputs = combined;
      derived = true;
    } else if (!/^(if|else|when|otherwise)\b/i.test(body)) {
      // Explicit imperative arithmetic (`Multiply A by B`) before the
      // symbolic readers: the verb form never collides with them, and the
      // label names the result when one is evidenced.
      const imperative = tryParseImperativeArithmetic(verbText);
      if (imperative) {
        entry.operation = 'expression';
        entry.expression = imperative.expression;
        entry.inputs = imperative.inputs;
        if (labelOutput) entry.output = labelOutput;
        if (imperative.depends_on.length > 0) entry.depends_on = imperative.depends_on;
        derived = true;
      }
      if (!derived) {
      } // imperative results stand as-is; each symbolic reader below guards itself
      // Explicit assignments anywhere in the step: leading (`out = a*b`),
      // trailing after prose (`Compute base: out=a*b`), or several
      // separated by semicolons (`a=x*y; b=a-z`). Comparisons, prose, and
      // incomplete fragments yield null and stay unparsed.
      const trailing = parseTrailingAssignments(body);
      if (trailing) {
        entry.operation = 'expression';
        entry.expression = trailing.expression;
        entry.output = trailing.output;
        entry.inputs = trailing.inputs;
        derived = true;
      }
      if (!derived) {
        const chained = parseChainedAssignments(body);
        if (chained) {
          entry.operation = 'expression';
          entry.expression = chained.expression;
          entry.output = chained.output;
          entry.inputs = chained.inputs;
          if (chained.stated_results) entry.stated_results = chained.stated_results;
          derived = true;
        }
      }
      if (!derived) {
        const rounded = tryParseRoundingAnywhere(body);
        if (rounded) {
          entry.operation = rounded.operation;
          if (rounded.operand) entry.operand = rounded.operand;
          if (rounded.output) entry.output = rounded.output;
          if (rounded.inputs) entry.inputs = rounded.inputs;
          derived = true;
        }
      }
      if (!derived && !isLookupVerbStart(body)) {
        const bare = tryParseBareArithmetic(body);
        if (bare) {
          entry.operation = 'expression';
          entry.expression = bare.expression;
          if (bare.inputs.length > 0) entry.inputs = bare.inputs;
          if (bare.output) {
            entry.output = bare.output;
          } else {
            const inferred = inferCalculationOutput(body, bare.expression);
            if (inferred) entry.output = inferred;
          }
          derived = true;
        }
        // Code-led phrase calculations the bare parser cannot isolate
        // (multi-word operands with worked-amount groups inside a labelled
        // breakdown row). Runs only when bare arithmetic found no core.
        if (!derived) {
          const phrase = tryParseCodeLedPhraseArithmetic(body);
          if (phrase) {
            entry.operation = phrase.operation;
            entry.expression = phrase.expression;
            entry.output = phrase.output;
            if (phrase.inputs.length > 0) entry.inputs = phrase.inputs;
            derived = true;
          }
        }
        // A bare evaluated equality the readers above cannot place (no
        // output variable anywhere): the value stays in the expression
        // and validation flags the unstated target. Runs last so
        // result-form lines keep their existing core-only shape.
        if (!derived) {
          const bare = tryParseBareEquality(body);
          if (bare) {
            entry.operation = 'expression';
            entry.expression = bare.expression;
            if (bare.inputs.length > 0) entry.inputs = bare.inputs;
            derived = true;
          }
        }
        // A bare symbolic comparison with no branches reads as a check
        // condition, never as a numeric output.
        if (!derived) {
          const check = tryParseBareComparison(body);
          if (check) {
            entry.operation = 'condition';
            entry.expression = check.expression;
            if (check.inputs.length > 0) entry.inputs = check.inputs;
            derived = true;
          }
        }
      }
    }
  }
  if (!derived) {
    const codeAssign = tryParseLeadingCodeAssignment(body);
    if (codeAssign) {
      entry.operation = codeAssign.operation;
      entry.output = codeAssign.output;
      entry.expression = codeAssign.expression;
      derived = true;
    }
  }
  if (derived) entry.interpretation_status = 'inferred';
  return entry;
}

function parseReferralCode(text) {
  const t = String(text ?? '');
  const paren = /\(\s*code\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*\)/i.exec(t);
  if (paren) return paren[1];
  const bare = /\bcode\s+([A-Za-z0-9][A-Za-z0-9_.-]*)/i.exec(t);
  if (bare && bare[1].length >= 2 && /[A-Z0-9-]/.test(bare[1])) return bare[1];
  return null;
}

// Generic disposition/imperative verbs starting a trailing rule action
// ('... days. Decline', '... P2. Apply ...'). Plain English, not domain
// vocabulary; matched only as the final sentence of a multi-sentence row.
const TRAILING_ACTION_START = /^(refer|decline|approve|accept|reject|apply|use|assign)\b/i;

// Split a non-conditional rule row into leading condition sentences plus a
// trailing action: either a single disposition word or a sentence starting
// with an imperative verb. Returns {condition, action} or null. No false
// branch is inferred; unstated fallbacks stay unstated.
function splitTrailingAction(text) {
  const m = /^(.+?[.?!])\s+([A-Za-z][^.\?!]*?[.?!]*)\s*$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const condition = m[1].trim();
  const action = m[2].trim();
  if (!condition || !action) return null;
  const bare = action.replace(/[.?!]+$/, '');
  if (!/^[A-Za-z]+$/.test(bare) && !TRAILING_ACTION_START.test(bare)) return null;
  return { condition, action };
}

// Parse explicit IF/WHEN/THEN/ELSE/OTHERWISE branch wording and referral
// codes. Rule rows without conditional keywords ('... units. Refer') split
// the trailing action into the true branch instead. Row order and original
// text are always preserved; unparseable rows stay minimal.
function deriveConditionDetail(text) {
  const entry = { original_text: String(text ?? '') };
  const full = String(text ?? '').trim();
  if (!full) return entry;
  const parsed = parseConditionalBranches(full);
  if (parsed) {
    if (parsed.condition) entry.condition = parsed.condition;
    if (parsed.true_branch) entry.true_branch = parsed.true_branch;
    if (parsed.false_branch) entry.false_branch = parsed.false_branch;
  } else {
    const split = splitTrailingAction(full);
    if (split) {
      entry.condition = split.condition;
      entry.true_branch = split.action;
    }
  }
  const branchOutput = assignmentTargetFromBranch(entry.true_branch)
    ?? assignmentTargetFromBranch(entry.false_branch);
  if (branchOutput) entry.output = branchOutput;
  const referral = parseReferralCode(full);
  if (referral) entry.referral_code = referral;
  if (entry.condition || entry.true_branch || entry.false_branch || entry.referral_code) {
    entry.interpretation_status = 'inferred';
  }
  return entry;
}

// Normalize a model-provided routine kind to its canonical form:
// case/separator variants collapse ('Calculation Steps' to
// 'calculation_steps'); phrases naming eligibility rules are conditions;
// generic multi-step wordings (pipeline, sequence, workflow, rule, ...)
// follow the evidenced structure (steps, else expression, else
// conditions). Unrecognized kinds pass through verbatim so validation
// keeps warning about them. Generic: driven by common words and shape,
// never by names.
const STRUCTURAL_KIND_WORDS = new Set([
  'calculation', 'procedure', 'process', 'pipeline', 'sequence', 'sequential',
  'workflow', 'chain', 'chained', 'stage', 'stages', 'rule', 'rules', 'business',
  'rating', 'rated', 'rates', 'premium', 'premiums', 'surcharge', 'surcharges',
  'adjustment', 'adjustments', 'modifier', 'modifiers', 'modification',
  'modifications', 'loading', 'loadings', 'discount', 'discounts', 'credit',
  'credits', 'debit', 'debits', 'relativity', 'relativities', 'accumulator',
  'accumulators', 'algorithm', 'algorithms', 'routine', 'routines', 'schedule',
  'schedules', 'experience', 'allocation', 'computation', 'assessment',
  'conflict', 'conflicts', 'conflicting', 'conflicted', 'contradiction',
  'contradictions', 'contradictory', 'matrix', 'scale', 'scales',
]);

function normalizeRoutineKind(kind, evidence = {}) {
  const raw = String(kind ?? 'formula');
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ROUTINE_KINDS.includes(key)) return key;
  if (!key) return raw;
  const words = new Set(key.split(/[^a-z0-9]+/).filter(Boolean));
  if (words.has('eligibility') || words.has('ineligible') || words.has('ineligibility')
    || words.has('underwriting') || words.has('guideline') || words.has('guidelines')) {
    const structural = structuralRoutineKind(evidence);
    if (structural === 'calculation_steps') return 'calculation_steps';
    return 'condition';
  }
  if (words.has('worked') || words.has('example') || words.has('examples')
    || words.has('illustration') || words.has('illustrations')) return 'worked_example';
  if ([...words].some((w) => STRUCTURAL_KIND_WORDS.has(w))) return structuralRoutineKind(evidence);
  if (words.has('condition') || words.has('conditional')) return 'condition';
  if (words.has('formula')) return 'formula';
  return raw;
}

function structuralRoutineKind({ steps, stepsDetailed, expressionText, conditions, conditionsDetailed } = {}) {
  const hasSteps = (Array.isArray(steps) && steps.some((s) => String(s ?? '').trim()))
    || (Array.isArray(stepsDetailed) && stepsDetailed.length > 0);
  if (hasSteps) return 'calculation_steps';
  if (String(expressionText ?? '').trim()) return 'formula';
  const hasConditions = (Array.isArray(conditions) && conditions.some((c) => String(c ?? '').trim()))
    || (Array.isArray(conditionsDetailed) && conditionsDetailed.length > 0);
  if (hasConditions) return 'condition';
  return 'formula';
}

function normalizeDependencyLists({ depends_on, dependencies }) {
  const rawDeps = Array.isArray(depends_on) ? depends_on : (depends_on === undefined || depends_on === null ? [] : [depends_on]);
  const rawDetailed = Array.isArray(dependencies) ? dependencies : [];
  const display = rawDeps.map((d) => displayTextOfDependency(d));
  const fromEmbedded = [];
  rawDeps.forEach((d) => {
    const norm = normalizeOneDependency(d);
    if (norm) fromEmbedded.push(norm);
  });
  const detailed = rawDetailed.map((d) => normalizeOneDependency(d)).filter(Boolean);
  let finalDisplay = display;
  if (finalDisplay.length === 0 && detailed.length > 0) {
    finalDisplay = detailed.map((d) => String(d.target ?? '')).filter((s) => s !== '');
  }
  if (fromEmbedded.length > 0 && detailed.length === 0) {
    return { depends_on: finalDisplay, dependencies: fromEmbedded };
  }
  if (detailed.length > 0) return { depends_on: finalDisplay, dependencies: detailed };
  if (fromEmbedded.length > 0) return { depends_on: finalDisplay, dependencies: fromEmbedded };
  return { depends_on: finalDisplay, dependencies: [] };
}
