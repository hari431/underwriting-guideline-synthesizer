// Generic deterministic separation of side-by-side grids merged into one table.
// Pure functions, no model calls, no domain vocabulary: decisions use only
// structural evidence (header patterns, column relationships, row structure).
// A column whose every value embeds its own key ("label: value") is a
// self-contained record: the signature of an independent grid flattened into
// one column. Splits happen only on strong evidence; ambiguous layouts are
// preserved untouched so the validator can flag them for review instead.

export const MIN_SPLIT_COLUMNS = 3;
export const MIN_SPLIT_ROWS = 3;

/**
 * Split a cell into an embedded key/value pair ("label: value").
 * Returns null for plain values. The key must carry a letter so times
 * ("10:30") and ratios ("3:1") never count, and values starting with a slash
 * are excluded so schemes ("https://...") never count.
 */
export function splitKeyValue(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  if (s[idx + 1] === '/' || s[idx + 1] === '\\') return null;
  const key = s.slice(0, idx).trim();
  const value = s.slice(idx + 1).trim();
  if (!key || !value) return null;
  if (!/[A-Za-z]/.test(key)) return null;
  return { key, value };
}

function keyStem(key) {
  const m = /[A-Za-z0-9]+/.exec(String(key ?? ''));
  return m ? m[0].toLowerCase() : '';
}

function cellAt(table, rowIndex, colIndex) {
  const row = table?.rows?.[rowIndex];
  if (!Array.isArray(row) || colIndex >= row.length) return '';
  return String(row[colIndex] ?? '');
}

function headerAt(table, colIndex) {
  return String(table?.headers?.[colIndex] ?? '');
}

function tableWidth(table) {
  const rows = table?.rows ?? [];
  return Math.max(table?.headers?.length ?? 0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
}

function nonBlankRowCount(table) {
  return (table?.rows ?? []).filter((row) =>
    (row ?? []).some((c) => String(c ?? '').trim() !== '')
  ).length;
}

function isBlankColumn(table, colIndex) {
  if (headerAt(table, colIndex).trim() !== '') return false;
  return (table?.rows ?? []).every((_, r) => cellAt(table, r, colIndex).trim() === '');
}

// A record column: every non-blank value embeds its own key. Grid-like when
// it is a complete flattened lookup: all keys share one leading stem (the
// residue of a flattened key column), keys vary across rows, and every value
// is numeric (a rate, factor, or amount — the lookup result). A column of
// "label: description" pairs is a key or annotation column, not a grid.
function recordProfile(table, colIndex) {
  const keys = [];
  const values = [];
  let filled = 0;
  for (let r = 0; r < (table?.rows ?? []).length; r += 1) {
    const cell = cellAt(table, r, colIndex);
    if (!cell.trim()) continue;
    filled += 1;
    const kv = splitKeyValue(cell);
    if (!kv) return { isRecord: false, gridLike: false, stem: '' };
    keys.push(kv.key);
    values.push(kv.value);
  }
  if (filled < MIN_SPLIT_ROWS) return { isRecord: false, gridLike: false, stem: '' };
  const stems = new Set(keys.map(keyStem));
  const distinctKeys = new Set(keys.map((k) => k.trim().toLowerCase()));
  const gridLike =
    stems.size === 1 && distinctKeys.size >= 2 && values.every(isNumericValue);
  return { isRecord: true, gridLike, stem: stems.size === 1 ? [...stems][0] : '' };
}

// A numeric lookup result: a number with optional percent/currency/marker
// adornments, or a numeric range/alternative ("a-b", "a/b", "a to b").
// Parenthetical annotations are ignored; any other letter rejects.
function isNumericValue(value) {
  const withoutNotes = String(value ?? '').replace(/\([^()]*\)/g, ' ');
  const cleaned = withoutNotes.replace(/[%$€£¥₹,*†‡\s]/g, '');
  if (!cleaned) return false;
  return /^[+-]?\d+(?:\.\d+)?\+?(?:(?:to|-|–|—|\/)[+-]?\d+(?:\.\d+)?\+?)?$/i.test(cleaned);
}

/** True when any column is a fully self-contained record column. */
export function tableHasRecordColumn(table) {
  const width = tableWidth(table);
  for (let c = 0; c < width; c += 1) {
    if (!isBlankColumn(table, c) && recordProfile(table, c).isRecord) return true;
  }
  return false;
}

/**
 * Plan a column-group split. Returns { groups: number[][] } (column indexes
 * per logical table, left to right) or null when the table must stay intact.
 * Boundaries form at fully blank separator columns, at grid/other transitions,
 * and between adjacent grid columns with different key stems. A grid group
 * bordered by ordinary columns on both sides is ambiguous (it may be an
 * annotation column inside one grid) and vetoes the split for review.
 */
export function planColumnSplit(table) {
  const width = tableWidth(table);
  if (width < MIN_SPLIT_COLUMNS) return null;
  if (nonBlankRowCount(table) < MIN_SPLIT_ROWS) return null;

  const profiles = [];
  let hasSignal = false;
  for (let c = 0; c < width; c += 1) {
    if (isBlankColumn(table, c)) {
      profiles.push({ kind: 'blank' });
      continue;
    }
    const rec = recordProfile(table, c);
    if (rec.isRecord && rec.gridLike) {
      profiles.push({ kind: 'grid', stem: rec.stem });
      hasSignal = true;
    } else {
      profiles.push({ kind: 'other' });
    }
  }
  const hasInteriorBlank = profiles.some(
    (p, c) => p.kind === 'blank' && profiles.slice(0, c).some((q) => q.kind !== 'blank') && profiles.slice(c + 1).some((q) => q.kind !== 'blank')
  );
  if (!hasSignal && !hasInteriorBlank) return null;

  const groups = [];
  let current = [];
  let prev = null;
  const close = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    prev = null;
  };
  for (let c = 0; c < width; c += 1) {
    const p = profiles[c];
    if (p.kind === 'blank') {
      close();
      continue;
    }
    if (prev && p.kind !== prev.kind) close();
    else if (prev && p.kind === 'grid' && p.stem !== prev.stem) close();
    current.push(c);
    prev = p;
  }
  close();
  if (groups.length < 2) return null;

  const groupKind = (g) => profiles[g[0]].kind;
  for (let i = 0; i < groups.length; i += 1) {
    if (groupKind(groups[i]) !== 'grid') continue;
    const leftOther = groups.slice(0, i).some((g) => groupKind(g) === 'other');
    const rightOther = groups.slice(i + 1).some((g) => groupKind(g) === 'other');
    if (leftOther && rightOther) return null;
  }
  return { groups };
}

function cloneContinuation(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function buildPart(table, cols, index, total) {
  const base = String(table?.name ?? '').trim() || `Table ${table?.id ?? 'untitled'}`;
  const headers = cols.map((c) => headerAt(table, c));
  const columns = cols.map((c, i) => {
    const orig = table?.columns?.[c];
    if (orig && typeof orig === 'object') return { ...orig, order: i + 1 };
    const label = headers[i] ?? '';
    return { label, original_label: label, order: i + 1 };
  });
  const rows = (table?.rows ?? []).map((row) =>
    cols.map((c) => (Array.isArray(row) && c < row.length ? String(row[c] ?? '') : ''))
  );
  return {
    id: index === 0 ? (table?.id ?? null) : null,
    name: `${base} (grid ${index + 1} of ${total})`,
    source_pages: [...(table?.source_pages ?? [])],
    source_type: String(table?.source_type ?? ''),
    source_location: String(table?.source_location ?? ''),
    evidence_text: String(table?.evidence_text ?? ''),
    headers,
    columns,
    rows,
    purpose: String(table?.purpose ?? ''),
    applicability: String(table?.applicability ?? ''),
    effective_period: String(table?.effective_period ?? ''),
    footnotes: [...(table?.footnotes ?? [])],
    notes: String(table?.notes ?? ''),
    continuation: cloneContinuation(table?.continuation ?? null),
    review_status: String(table?.review_status ?? ''),
    confidence: table?.confidence ?? null,
  };
}

// ---------- record-column expansion ----------

// Split a flattened lookup cell on the FIRST colon+space ("Age 25–55:
// 1.00"). A colon without a following space is a time/ratio/code separator
// ("10:30"), never a label/value split. Returns { key, value } or null.
function splitLabelValue(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const idx = s.indexOf(': ');
  if (idx <= 0) return null;
  const key = s.slice(0, idx).trim();
  const value = s.slice(idx + 1).trim();
  if (!key || !value) return null;
  if (!/[A-Za-z]/.test(key)) return null;
  return { key, value };
}

// Detached footnote markers: leading/trailing runs of reference symbols.
// Only what isNumericValue already tolerates as adornment is detached;
// anything else stays verbatim in the cell.
function stripFootnoteMarkers(text) {
  let s = String(text ?? '').trim();
  const markers = [];
  const collect = (run) => {
    for (const ch of run) {
      if (!markers.includes(ch)) markers.push(ch);
    }
  };
  let m = /^([*†‡]+)\s*/.exec(s);
  if (m) {
    collect(m[1]);
    s = s.slice(m[0].length).trim();
  }
  m = /\s*([*†‡]+)$/.exec(s);
  if (m) {
    collect(m[1]);
    s = s.slice(0, s.length - m[0].length).trim();
  }
  return { text: s, markers };
}

const RANGE_NUMBER = '[+-]?[\\d,]+(?:\\.\\d+)?';

// Parse a key remainder as a numeric range. Closed forms use a dash or the
// word "to" ("25–55", "18-24", "56 to 70"); open-ended forms use a trailing
// plus ("71+"). Endpoints stay verbatim (no reformatting); anything else —
// units, comparators, words — is not a range and stays a plain key.
// Returns { min, max } (max '' when open) or null.
function parseKeyRange(remainder) {
  const s = String(remainder ?? '').trim();
  if (!s) return null;
  let m = new RegExp(`^(${RANGE_NUMBER})\\s*\\+\\s*$`).exec(s);
  if (m) return { min: m[1], max: '' };
  m = new RegExp(`^(${RANGE_NUMBER})(?:\\s*(?:-|–|—)\\s*|\\s+to\\s+)(${RANGE_NUMBER})$`, 'i').exec(s);
  if (m) return { min: m[1], max: m[2] };
  return null;
}

// Longest common leading word run across keys, matched case-insensitively
// and rendered from the first key ("Age" for "Age 25–55" / "Age 71+").
function commonStemWords(keys) {
  const wordLists = keys.map((k) => String(k ?? '').trim().split(/\s+/).filter(Boolean));
  if (wordLists.some((w) => w.length === 0)) return [];
  const first = wordLists[0];
  const stem = [];
  for (let i = 0; i < first.length; i += 1) {
    const word = first[i];
    if (!wordLists.every((w) => w.length > i && w[i].toLowerCase() === word.toLowerCase())) break;
    stem.push(word);
  }
  return stem;
}

// Strip the leading stem words off one key, preserving the remainder text
// verbatim (internal spacing included).
function stripStemWords(key, count) {
  let rest = String(key ?? '');
  for (let k = 0; k < count; k += 1) {
    const m = /^\s*\S+\s*/.exec(rest);
    if (!m) return '';
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

// A value offering alternatives ("45% / 50%"): digits on both sides of a
// slash. Alternatives stay verbatim in the value cell and are flagged for
// review instead of being split or resolved.
function hasAlternatives(value) {
  return /\d[^:]*\/[^:]*\d/.test(String(value ?? ''));
}

// Expand one single-column "label: value" lookup grid into key/value (or
// minimum/maximum/value) columns. Strong evidence only: exactly one column,
// enough rows, every cell splitting on colon+space, numeric values, one
// shared key stem with non-empty remainders. Anything weaker returns null
// so the table passes through untouched for review.
function tryExpandRecordTable(table) {
  if (!table || tableWidth(table) !== 1) return null;
  const rows = table?.rows ?? [];
  if (rows.length < MIN_SPLIT_ROWS) return null;
  if (rows.some((_, i) => cellAt(table, i, 0).trim() === '')) return null;
  if (!recordProfile(table, 0).gridLike) return null;
  const cells = [];
  for (let r = 0; r < rows.length; r += 1) {
    const kv = splitLabelValue(cellAt(table, r, 0));
    if (!kv) return null;
    const key = stripFootnoteMarkers(kv.key);
    const value = stripFootnoteMarkers(kv.value);
    if (!key.text || !value.text) return null;
    cells.push({ key: key.text, value: value.text, markers: [...key.markers, ...value.markers] });
  }
  const stem = commonStemWords(cells.map((c) => c.key));
  if (stem.length === 0) return null;
  const remainders = cells.map((c) => stripStemWords(c.key, stem.length));
  if (remainders.some((rem) => !rem)) return null;
  const ranges = remainders.map(parseKeyRange);
  const isRange = ranges.every(Boolean);
  const stemLabel = stem.join(' ');
  const valueHeader = String(table?.headers?.[0] ?? '');
  const keyHeaders = isRange ? [`Minimum ${stemLabel}`, `Maximum ${stemLabel}`] : [stemLabel];
  const outRows = cells.map((c, i) => (
    isRange ? [ranges[i].min, ranges[i].max, c.value] : [remainders[i], c.value]
  ));
  const markers = [];
  const markerRows = new Set();
  cells.forEach((c, i) => {
    for (const mk of c.markers) {
      if (!markers.includes(mk)) markers.push(mk);
      markerRows.add(i);
    }
  });
  const alternatives = [];
  for (const c of cells) {
    if (hasAlternatives(c.value) && !alternatives.includes(c.value)) alternatives.push(c.value);
  }
  const footnotes = [...(table?.footnotes ?? [])];
  for (const mk of markers) {
    const entry = `Footnote marker "${mk}" detached from ${markerRows.size} cell(s); see source evidence.`;
    if (!footnotes.includes(entry)) footnotes.push(entry);
  }
  const kind = isRange ? 'range' : 'key-value';
  const colList = [...keyHeaders, valueHeader].map((n) => `"${n}"`).join(', ');
  let message = `Table "${String(table?.name ?? '') || table?.id}" had ${rows.length} single-column lookup rows ("label: value") normalized into ${kind} columns (${colList}); verify the split against the source.`;
  if (markers.length > 0) {
    message += ` Footnote marker(s) ${markers.map((mk) => `"${mk}"`).join(', ')} detached from ${markerRows.size} cell(s); original text preserved in source evidence.`;
  }
  if (alternatives.length > 0) {
    message += ` Value(s) with alternatives (${alternatives.map((a) => `"${a}"`).join(', ')}) kept verbatim; verify which applies.`;
  }
  return {
    table: {
      id: table?.id ?? null,
      name: String(table?.name ?? ''),
      source_pages: [...(table?.source_pages ?? [])],
      source_type: String(table?.source_type ?? ''),
      source_location: String(table?.source_location ?? ''),
      evidence_text: String(table?.evidence_text ?? ''),
      headers: [...keyHeaders, valueHeader],
      columns: [...keyHeaders, valueHeader].map((h, i) => ({ label: h, original_label: h, order: i + 1 })),
      rows: outRows,
      purpose: String(table?.purpose ?? ''),
      applicability: String(table?.applicability ?? ''),
      effective_period: String(table?.effective_period ?? ''),
      footnotes,
      notes: String(table?.notes ?? ''),
      continuation: cloneContinuation(table?.continuation ?? null),
      review_status: String(table?.review_status ?? ''),
      confidence: table?.confidence ?? null,
    },
    report: {
      tableId: table?.id ?? null,
      tableName: String(table?.name ?? ''),
      kind,
      rowCount: rows.length,
      keyHeaders,
      valueHeader,
      markers,
      alternatives,
      sourcePages: [...(table?.source_pages ?? [])],
      message,
    },
  };
}

/**
 * Expand single-column "label: value" lookup grids into key/value (or
 * minimum/maximum/value) columns. Returns { tables, expansions } where
 * expansions describes each normalization for review traceability. Input
 * tables without strong expansion evidence pass through by reference,
 * untouched.
 */
export function expandRecordTables(tables) {
  const out = [];
  const expansions = [];
  for (const table of tables ?? []) {
    const expanded = tryExpandRecordTable(table);
    if (!expanded) {
      out.push(table);
      continue;
    }
    out.push(expanded.table);
    expansions.push(expanded.report);
  }
  return { tables: out, expansions };
}

/**
 * Separate merged side-by-side grids. Returns { tables, splits } where splits
 * describes each separation for review traceability. Input tables without
 * strong split evidence pass through by reference, untouched.
 */
export function splitMergedTables(tables) {
  const out = [];
  const splits = [];
  for (const table of tables ?? []) {
    const plan = planColumnSplit(table);
    if (!plan) {
      out.push(table);
      continue;
    }
    const parts = plan.groups.map((cols, i) => buildPart(table, cols, i, plan.groups.length));
    out.push(...parts);
    splits.push({
      originalId: table?.id ?? null,
      originalName: String(table?.name ?? ''),
      partNames: parts.map((p) => p.name),
      sourcePages: [...(table?.source_pages ?? [])],
    });
  }
  return { tables: out, splits };
}
