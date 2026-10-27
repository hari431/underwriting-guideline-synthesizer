// Data model for UnderwriteIQ demo jobs.
// Every extracted object carries source_pages (1-based) and evidence_text
// (verbatim supporting snippet from the PDF) wherever available.
// Optional descriptive fields are preserved only when the source provides
// them; nothing is fabricated to fill the schema.

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
  return {
    id: id ?? routine_id ?? null,
    name: String(title ?? name ?? ''),
    kind: String(kind ?? 'formula'),
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
  return out;
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
function parseAssignmentOperands(text) {
  const t = String(text ?? '').trim();
  if (!t || /^(if|else|when|otherwise)\b/i.test(t)) return null;
  const main = splitMainClause(t);
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(main);
  if (!m || !m[2].trim()) return null;
  return { inputs: identifiersOf(m[2]), outputs: [m[1]] };
}

function stripStepLabel(text) {
  return String(text ?? '').replace(/^\s*(?:step\s*\d+\s*[:.)-]?\s*)+/i, '').trim();
}

function splitKeys(text) {
  return String(text ?? '')
    .split(/\s+and\s+|,/i)
    .map((k) => k.trim().replace(/[.]+$/, '').trim())
    .filter(Boolean);
}

// Resolve an abbreviated table mention (e.g. "Table 1") to an extracted
// table: exact id/name match first, else a unique word-boundary prefix match
// on the table name (so "Table 1" never resolves to "Table 10"). Returns the
// table or null when there is no single confident match.
export function resolveTableReference(tables, mention) {
  const key = String(mention ?? '').trim().toLowerCase();
  if (!key) return null;
  const list = Array.isArray(tables) ? tables : [];
  const exact = list.find((t) =>
    String(t?.id ?? '').trim().toLowerCase() === key
    || String(t?.name ?? '').trim().toLowerCase() === key);
  if (exact) return exact;
  const candidates = list.filter((t) => {
    const name = String(t?.name ?? '').trim().toLowerCase();
    if (!name.startsWith(key) || name.length === key.length) return false;
    return !/[a-z0-9]/.test(name[key.length] ?? '');
  });
  return candidates.length === 1 ? candidates[0] : null;
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

// Derive step operation/expression/operand/inputs/output from explicit
// wording. Only confident syntactic patterns produce fields; anything else
// yields a minimal entry so the source text is never embellished.
function deriveStepDetail(text) {
  const entry = { instruction: String(text ?? '') };
  const full = String(text ?? '').trim();
  if (!full) return entry;
  const body = stripStepLabel(full);
  let derived = false;
  const lookupFull = /^look\s*-?\s*up\s+([A-Za-z_]\w*)\s+from\s+(.+?)\s+using\s+(.+?)\s*\.?\s*$/i.exec(body);
  const lookupShort = !lookupFull && /^look\s*-?\s*up\s+([A-Za-z_]\w*)\s+using\s+(.+?)\s*\.?\s*$/i.exec(body);
  if (/^look\s*-?\s*up\b/i.test(body)) {
    entry.operation = 'lookup';
    derived = true;
    const parsed = lookupFull || lookupShort;
    if (parsed) {
      if (acceptableCapture(parsed[1])) entry.output = parsed[1];
      entry.inputs = splitKeys(parsed[parsed.length - 1]);
    }
    if (lookupFull && lookupFull[2].trim()) entry.depends_on = [lookupFull[2].trim()];
  } else if (/^round\b/i.test(body)) {
    entry.operation = 'rounding';
    derived = true;
    const target = /^round\s+([A-Za-z_]\w*)/i.exec(body);
    if (target && acceptableCapture(target[1])) {
      entry.operand = target[1];
      entry.output = target[1];
    }
  } else if (!/^(if|else|when|otherwise)\b/i.test(body)) {
    const main = splitMainClause(body);
    const assign = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*\.?\s*$/.exec(main);
    if (assign && assign[2].trim()) {
      entry.operation = 'expression';
      entry.expression = main.replace(/\.\s*$/, '');
      entry.output = assign[1];
      entry.inputs = identifiersOf(assign[2]);
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

// Parse explicit IF/THEN/ELSE branch wording and referral codes. Row order
// and original text are always preserved; unparseable rows stay minimal.
function deriveConditionDetail(text) {
  const entry = { original_text: String(text ?? '') };
  const full = String(text ?? '').trim();
  if (!full) return entry;
  const ifMatch = /^\s*IF\s+(.+?)\s+THEN\s+(.+?)\s*$/i.exec(full);
  if (ifMatch) {
    entry.condition = ifMatch[1].trim();
    const rest = ifMatch[2].trim();
    const elseSplit = /^(.+?)\s+ELSE\s+(.+?)\s*$/i.exec(rest);
    if (elseSplit) {
      entry.true_branch = elseSplit[1].trim();
      entry.false_branch = elseSplit[2].trim();
    } else {
      entry.true_branch = rest;
    }
  } else {
    const elseMatch = /^\s*ELSE\s+(.+?)\s*$/i.exec(full);
    if (elseMatch) entry.false_branch = elseMatch[1].trim();
  }
  const referral = parseReferralCode(full);
  if (referral) entry.referral_code = referral;
  if (entry.condition || entry.true_branch || entry.false_branch || entry.referral_code) {
    entry.interpretation_status = 'inferred';
  }
  return entry;
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
