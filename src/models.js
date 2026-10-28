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
export const ROUTINE_KINDS = ['formula', 'condition', 'calculation_steps'];

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
  return {
    id: id ?? table_id ?? null,
    name: String(title ?? name ?? ''),
    source_pages: normalizePages(sourcePages ?? source_pages ?? []),
    source_type: String(source_type ?? sourceType ?? ''),
    source_location: String(source_location ?? sourceLocation ?? ''),
    evidence_text: String(evidenceText ?? evidence_text ?? evidence ?? ''),
    headers: normHeaders,
    columns: normColumns,
    rows: normalizeRows(rows),
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
  let normInputs = normalizeStringList(inputs);
  let normOutputs = normalizeStringList(outputs);
  if ((isEffectivelyEmpty(normInputs) || isEffectivelyEmpty(normOutputs)) && expressionTextStr.trim()) {
    const parsed = parseAssignmentOperands(expressionTextStr);
    if (parsed) {
      if (isEffectivelyEmpty(normInputs) && parsed.inputs.length > 0) normInputs = parsed.inputs;
      if (isEffectivelyEmpty(normOutputs) && parsed.outputs.length > 0) normOutputs = parsed.outputs;
    }
  }
  const normKind = normalizeRoutineKind(kind, {
    steps: normSteps.steps,
    stepsDetailed: normSteps.steps_detailed,
    expressionText: expressionTextStr,
    conditions: normConds.conditions,
    conditionsDetailed: normConds.conditions_detailed,
  });
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
    steps: normSteps.steps,
    steps_detailed: normSteps.steps_detailed,
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
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const arr = Array.isArray(r) ? r : [r];
    return arr.map((c) => normalizeCellValue(c));
  });
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
  enrichSparseStep(out);
  return out;
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
  if (parsed.depends_on !== undefined && out.depends_on === undefined) out.depends_on = parsed.depends_on;
  if (!out.interpretation_status) out.interpretation_status = 'inferred';
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
// rather than explicitly extracted (must be preserved).
function looksDerivedStep(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const substantive = ['sequence', 'operation', 'expression', 'operand', 'inputs', 'output', 'depends_on', 'source_pages', 'source_location', 'evidence'];
  if (!substantive.some((k) => hasSubstantiveValue(entry[k]))) return true;
  return entry.interpretation_status === 'inferred'
    && entry.sequence === undefined
    && (entry.source_pages === undefined || entry.source_pages.length === 0)
    && !entry.source_location
    && !entry.evidence;
}

function looksDerivedCondition(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const substantive = ['condition', 'true_branch', 'false_branch', 'referral_code', 'source_pages', 'source_location', 'evidence'];
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
  for (const m of String(text ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const key = m[0].toLowerCase();
    if (seen.has(key) || NON_IDENTIFIER_WORDS.has(key)) continue;
    seen.add(key);
    out.push(m[0]);
  }
  return out;
}

function splitMainClause(text) {
  const t = String(text ?? '');
  const idx = t.search(/,\s*(where|with)\b/i);
  return idx < 0 ? t : t.slice(0, idx);
}

// Parse an explicit top-level assignment `output = rhs`. Returns null unless
// the text starts with a single identifier, '=', and a non-empty RHS.
// Exported for the Excel routine-step renderer (display only); the normalized
// model behavior is unchanged.
export function parseAssignmentOperands(text) {
  const t = String(text ?? '').trim();
  if (!t || /^(if|else|when|otherwise)\b/i.test(t)) return null;
  const main = splitMainClause(t);
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(main);
  if (!m || !m[2].trim()) return null;
  return { inputs: identifiersOf(m[2]), outputs: [m[1]] };
}

function stripStepLabel(text) {
  const withoutStep = String(text ?? '').replace(/^\s*(?:step\s*\d+\s*[:.)-]?\s*)+/i, '');
  // Bare numbering ('1 Find ...', '1. Find ...', '(1) Find ...') strips only
  // when a letter follows, so quantities, decimals, and hyphenated terms
  // ('350 units', '1.20 ...', '2-factor ...') are never touched.
  return withoutStep.replace(/^\s*(?:\(\d{1,3}\)\s*|\d{1,3}\s*[:.)]\s*|\d{1,2}\s+)(?=[A-Za-z])/, '').trim();
}

function splitKeys(text) {
  return String(text ?? '')
    .split(/\s+and\s+|,/i)
    .map((k) => k.trim().replace(/[.]+$/, '').trim())
    .filter(Boolean);
}

// Drop a lowercase prose article from a table mention ("in the Base rating
// table" refers to "Base rating table"). Capitalized names stay verbatim so a
// table actually named "The Ledger" keeps its exact reference.
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

// Resolve a table mention to an extracted table: exact id/name match first
// (dash-insensitive), else a unique word-boundary prefix in either direction
// (short "Table 1" to long "Table 1 - ..." and long mentions to short
// extracted names), else a unique keyword-subset match for valid aliases
// ("Base property table" to "Table A - Base property rate"). Returns the table or
// null when there is no single confident match.
export function resolveTableReference(tables, mention) {
  const raw = String(mention ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const keyNorm = normalizeTableText(raw);
  const list = Array.isArray(tables) ? tables : [];
  const exact = list.find((t) =>
    String(t?.id ?? '').trim().toLowerCase() === key
    || String(t?.name ?? '').trim().toLowerCase() === key
    || normalizeTableText(t?.name ?? '') === keyNorm);
  if (exact) return exact;
  const prefixCandidates = list.filter((t) => {
    const nameNorm = normalizeTableText(t?.name ?? '');
    if (!nameNorm || !keyNorm || nameNorm === keyNorm) return false;
    return isWordBoundaryPrefix(nameNorm, keyNorm) || isWordBoundaryPrefix(keyNorm, nameNorm);
  });
  if (prefixCandidates.length === 1) return prefixCandidates[0];
  if (prefixCandidates.length > 1) return null;
  const keywords = tableMentionKeywords(raw);
  if (keywords.length === 0) return null;
  const keywordMatches = list.filter((t) => {
    const words = new Set(normalizeTableText(t?.name ?? '').split(/[^a-z0-9]+/).filter(Boolean));
    return keywords.every((k) => words.has(k));
  });
  return keywordMatches.length === 1 ? keywordMatches[0] : null;
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
// is collected; values stay in the source text for display.
const CONSTANT_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[-+]?\d+(?:\.\d+)?/g;

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
}

// Lowercased names assigned numeric literals anywhere in any routine's own
// text (notes, evidence, expression, steps, conditions). Global like routine
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

// Lowercased id/name/header/label terms identifying extracted tables,
// for matching references against defined table structure.
export function tableReferenceTerms(tables) {
  return new Set(
    (Array.isArray(tables) ? tables : [])
      .flatMap((t) => [
        t?.id,
        t?.name,
        ...(t?.headers ?? []),
        ...(t?.columns ?? []).map((c) => c?.label ?? c?.original_label),
      ])
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

// Parse explicit conditional branch wording: IF/WHEN with THEN or a comma,
// ELSE/OTHERWISE as the false branch in either order. Returns
// {condition?, true_branch?, false_branch?} or null when no confident
// structure matches. Original text is preserved by callers.
function parseConditionalBranches(text) {
  const full = String(text ?? '').trim();
  if (!full) return null;
  const elseSplit = (rest) => /^(.+?)\s*(?:[;.,]\s*)?(?:else|otherwise)\s*,?\s+(.+?)\s*$/i.exec(String(rest ?? '').trim());
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
// "X = ...", "X equals ..."). Generic syntax, not domain vocabulary.
function assignmentTargetFromBranch(branch) {
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
  return null;
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

// Derive step operation/expression/operand/inputs/output from explicit
// wording. Only confident syntactic patterns produce fields; anything else
// yields a minimal entry so the source text is never embellished.
function deriveStepDetail(text) {
  const entry = { instruction: String(text ?? '') };
  const full = String(text ?? '').trim();
  if (!full) return entry;
  const body = stripStepLabel(full);
  let derived = false;
  const lookupParsed = isLookupVerbStart(body) ? tryParseLookup(body) : null;
  if (isClassicLookupStart(body)) {
    entry.operation = 'lookup';
    derived = true;
    if (lookupParsed) {
      if (lookupParsed.output) entry.output = lookupParsed.output;
      if (lookupParsed.inputs.length > 0) entry.inputs = lookupParsed.inputs;
      if (lookupParsed.depends_on.length > 0) entry.depends_on = lookupParsed.depends_on;
    }
  } else if (lookupParsed) {
    entry.operation = 'lookup';
    derived = true;
    if (lookupParsed.output) entry.output = lookupParsed.output;
    if (lookupParsed.inputs.length > 0) entry.inputs = lookupParsed.inputs;
    if (lookupParsed.depends_on.length > 0) entry.depends_on = lookupParsed.depends_on;
  } else if (/^round\b/i.test(body)) {
    entry.operation = 'rounding';
    derived = true;
    const target = /^round\s+([A-Za-z_]\w*)/i.exec(body);
    let operand = '';
    if (target && acceptableCapture(target[1])) operand = target[1];
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
      const branchText = `${parsed.true_branch ?? ''} ${parsed.false_branch ?? ''}`;
      const condVars = parsed.condition ? conditionInputVars(parsed.condition, branchText, output) : [];
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
      const main = splitMainClause(body);
      const assign = /^\s*(?:calculate\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*\.?\s*$/i.exec(main);
      if (assign && assign[2].trim()) {
        entry.operation = 'expression';
        entry.expression = main.replace(/^\s*calculate\s+/i, '').replace(/\.\s*$/, '');
        entry.output = assign[1];
        entry.inputs = identifiersOf(assign[2]);
        derived = true;
      }
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
// a generic calculation/procedure follows its evidenced structure (steps,
// else expression, else conditions). Unrecognized kinds pass through
// verbatim so validation keeps warning about them. Generic: driven by
// common words and shape, never by names.
function normalizeRoutineKind(kind, evidence = {}) {
  const raw = String(kind ?? 'formula');
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ROUTINE_KINDS.includes(key)) return key;
  if (!key) return raw;
  const words = new Set(key.split(/[^a-z0-9]+/).filter(Boolean));
  if (words.has('eligibility')) return 'condition';
  if (words.has('calculation') || words.has('procedure')) return structuralRoutineKind(evidence);
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
