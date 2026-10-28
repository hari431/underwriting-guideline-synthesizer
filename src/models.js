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
  let normInputs = normalizeStringList(inputs)
    .map(cleanStepInputValue)
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
  enrichSparseStep(out);
  sanitizeExplicitStep(out);
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
  for (const m of String(text ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/g)) {
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
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
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

// An unspaced hyphen between identifier parts (`Premstep6-Discncb`) reads
// as subtraction only when either side names a value defined by the same
// step; otherwise it stays a hyphenated code (`OD-01`). Inserts spaces
// around such hyphens so tokenizers split the subtraction while codes
// stay whole. Generic: driven by same-step outputs, never by names.
// Exported for the Excel renderer, which applies the same split.
export function splitHyphenSubtraction(rhs, definedLower) {
  const defined = definedLower instanceof Set ? definedLower
    : new Set((Array.isArray(definedLower) ? definedLower : []).map((s) => String(s ?? '').toLowerCase()));
  if (defined.size === 0) return String(rhs ?? '');
  return String(rhs ?? '').replace(/([A-Za-z0-9_]+)-([A-Za-z_][A-Za-z0-9_]*)/g, (m, left, right) => {
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
// after a colon (`Compute base: out=a*b`), with lookup context, or several
// assignments separated by top-level semicolons (`a=x*y; b=a-z`). Each
// `;`-separated segment must carry exactly one standalone `=` with a valid
// output identifier and a non-empty right-hand side; anything else yields
// null so prose, comparisons, and incomplete fragments stay unparsed.
// Returns { segments: [{ output, rhs }], expression, output, inputs } or
// null. Inputs exclude same-step intermediate outputs and function names
// so within-step definitions never warn as unresolved references.
function parseTrailingAssignments(body) {
  const main = splitMainClause(String(body ?? ''));
  if (!main || !main.includes('=')) return null;
  const rawSegments = splitTopLevel(main, ';');
  const segments = [];
  for (const raw of rawSegments) {
    const seg = String(raw ?? '').trim().replace(/\.\s*$/, '').trim();
    if (!seg) continue;
    const equals = [];
    for (let i = 0; i < seg.length; i += 1) {
      if (isStandaloneEquals(seg, i)) equals.push(i);
    }
    if (equals.length !== 1) return null;
    const eqAt = equals[0];
    const left = seg.slice(0, eqAt);
    const rhs = seg.slice(eqAt + 1).trim();
    if (!rhs || !/[A-Za-z0-9_₹$€£¥]/.test(rhs)) return null;
    // The output is a whole token immediately before `=`: hyphenated or
    // dotted codes (`LX-NET = ...`) do not partially match (`NET`), they
    // stay unparsed instead of misparsing.
    const outMatch = /(?:^|[^A-Za-z0-9_.-])([A-Za-z_]\w*)\s*$/.exec(left);
    if (!outMatch || !acceptableCapture(outMatch[1])) return null;
    segments.push({ output: outMatch[1], rhs });
  }
  if (segments.length === 0) return null;
  const defined = new Set(segments.map((s) => s.output.toLowerCase()));
  // Normalize subtraction hyphens before building the expression so the
  // stored text, inputs, and workbook rows all split the same way.
  for (const s of segments) s.rhs = splitHyphenSubtraction(s.rhs, defined);
  const expression = segments.map((s) => `${s.output} = ${s.rhs}`).join('; ');
  const output = segments[segments.length - 1].output;
  const seen = new Set();
  const inputs = [];
  for (const s of segments) {
    for (const v of identifiersExcludingFunctions(s.rhs)) {
      const key = v.toLowerCase();
      if (defined.has(key) || seen.has(key)) continue;
      seen.add(key);
      inputs.push(v);
    }
  }
  return { segments, expression, output, inputs };
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

// Every source label a table answers to: its display name plus aliases
// (asset codes, alternate titles). Matching runs over all of them.
function tableMatchNames(table) {
  const names = [table?.name, ...(table?.aliases ?? [])];
  return [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))];
}

// Resolve a table mention to an extracted table: exact id/name/alias match
// first (dash-insensitive), else a unique word-boundary prefix in either
// direction (short "Table 1" to long "Table 1 - ..." and long mentions to
// short extracted names), else a unique keyword-subset match for valid
// aliases ("Base property table" to "Table A - Base property rate").
// Returns the table or null when there is no single confident match.
export function resolveTableReference(tables, mention) {
  const raw = String(mention ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const keyNorm = normalizeTableText(raw);
  const list = Array.isArray(tables) ? tables : [];
  const exact = list.find((t) =>
    String(t?.id ?? '').trim().toLowerCase() === key
    || tableMatchNames(t).some((n) => n.toLowerCase() === key || normalizeTableText(n) === keyNorm));
  if (exact) return exact;
  const prefixCandidates = list.filter((t) => tableMatchNames(t).some((n) => {
    const nameNorm = normalizeTableText(n);
    if (!nameNorm || !keyNorm || nameNorm === keyNorm) return false;
    return isWordBoundaryPrefix(nameNorm, keyNorm) || isWordBoundaryPrefix(keyNorm, nameNorm);
  }));
  if (prefixCandidates.length === 1) return prefixCandidates[0];
  if (prefixCandidates.length > 1) return null;
  const keywords = tableMentionKeywords(raw);
  if (keywords.length === 0) return null;
  const keywordMatches = list.filter((t) => {
    const words = new Set(tableMatchNames(t).flatMap((n) => normalizeTableText(n).split(/[^a-z0-9]+/).filter(Boolean)));
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

// Lowercased id/name/alias/header/label terms identifying extracted
// tables, for matching references against defined table structure.
export function tableReferenceTerms(tables) {
  return new Set(
    (Array.isArray(tables) ? tables : [])
      .flatMap((t) => [
        t?.id,
        t?.name,
        ...(t?.aliases ?? []),
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
    if (ch === '+' || ch === '*' || ch === '/' || ch === '×' || ch === '÷') {
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
// Ambiguous descriptive text is otherwise retained verbatim for review.
// Exported for the Excel renderer (see cleanStepOutputValue).
export function cleanStepInputValue(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/\(\s*[₹$€£¥\d,.\s%+-]+\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || isNumericFragment(s)) return '';
  const kept = [];
  for (const tok of s.split(/\s+/)) {
    const stripped = tok.replace(/^[:;|@,()[\]{}"'`]+|[:;|@,()[\]{}"'`]+$/g, '');
    if (!stripped) continue;
    if (/^[₹$€£¥%‰]+$/.test(stripped)) continue;
    if (isWorkedAmountToken(stripped)) continue;
    kept.push(stripped);
  }
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (!out || isNumericFragment(out)) return '';
  return out;
}

// Explicit arithmetic evidence: an operator joining two sides, or an
// assignment form ("Basis = 1") with a target and a right-hand side.
// Descriptive prose without either is not arithmetic.
function hasArithmeticEvidence(expr) {
  const s = String(expr ?? '').trim();
  if (!s) return false;
  if (splitArithmeticOperands(s)) return true;
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
// "..., rounded to nearest ..."). The target is captured only in the strict
// "round <variable> to ..." shape so rounding modes ("Half-Up") never become
// variables; anything else yields the operation without an invented target.
function tryParseRoundingAnywhere(body) {
  const s = String(body ?? '');
  const m = /\bround(?:ed|ing|s)?\b/i.exec(s);
  if (!m) return null;
  const after = s.slice(m.index + m[0].length);
  const out = { operation: 'rounding' };
  const target = /^\s*(?:the\s+)?([A-Za-z_]\w*)\s+to\b/i.exec(after);
  let operand = '';
  if (target && acceptableCapture(target[1])) operand = target[1];
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
  if (hasArithmeticEvidence(remainder)) return null;
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
      if (ch === '+' || ch === '*' || ch === '/' || ch === '×' || ch === '÷') {
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
    // A rounding directive carrying an explicit assignment (`Round ...:
    // out=round_fn(x;2)`) evidences its target and source through the
    // assignment; prose targets never become variables.
    if (!entry.output) {
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
