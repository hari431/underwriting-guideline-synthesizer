// Deterministic .xlsx workbook builder (zero dependencies).
// Sheets: Cover, Table Summary, Routine Summary, Table Columns, one sheet
// per rating table, one sheet per routine, Issues.
// Rating-table sheets hold only the title, headers, and factor rows.
// Rating-routine sheets hold the name, identity details, and ordered rating
// steps (Step #, Instruction, Op, (, Operand, ), Line Comment), followed by
// conditions, unresolved items, and source evidence. Multi-operator
// expressions expand into one ordered row per operation with explicit
// bracket columns; operators, operands, source order, and parentheses are
// preserved so reassembling the rows reproduces the source expression.
// Expanded source steps use hierarchical numbers (5.1, 5.2) so generated
// rows never collide with source step numbers; single-row steps keep their
// source number. Condition
// routines and routines without steps or an expression keep the legacy
// layout (inputs, final calculation, dependencies) so underwriting rules
// stay out of scope.
// Cover and the summaries link each asset name to its detail worksheet.
// Fixed ZIP timestamps keep builds byte-deterministic.
import { deflateRawSync } from 'node:zlib';
import { cleanStepInputValue, cleanStepOutputValue, normalizeVariableKey, parseAssignmentOperands, resolveTableReference, sanitizeExplicitStep, splitHyphenSubtraction, splitTopLevel, tableReferenceTerms } from './models.js';

// ---------- CRC32 + minimal ZIP writer ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (2026-01-01 00:00:00) for deterministic builds.
const DOS_TIME = (0 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function buildZip(entries, { compress = true } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.from(data);
    const payload = compress ? deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(payload.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralDir, end]);
}

// ---------- worksheet XML ----------

function escapeXml(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '?')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(index) {
  let name = '';
  let i = index;
  do {
    name = String.fromCharCode(65 + (i % 26)) + name;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return name;
}

class SharedStrings {
  constructor() {
    this.index = new Map();
    this.items = [];
  }

  idOf(value) {
    const key = String(value ?? '');
    if (!this.index.has(key)) {
      this.index.set(key, this.items.length);
      this.items.push(key);
    }
    return this.index.get(key);
  }

  xml() {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.items.length}" uniqueCount="${this.items.length}">`,
    ];
    for (const item of this.items) {
      parts.push(`<si><t xml:space="preserve">${escapeXml(item)}</t></si>`);
    }
    parts.push('</sst>');
    return parts.join('');
  }
}

function sheetXml(rows, shared, widths = [], links = [], styleSpec = []) {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const lastRef = `${colName(colCount - 1)}${Math.max(rows.length, 1)}`;
  const linkByCell = new Map(links.map((l) => [`${l.r},${l.c}`, l.location]));
  let boldRows = [];
  let sectionRows = [];
  let titleStyleId = null;
  if (Array.isArray(styleSpec)) {
    boldRows = styleSpec;
  } else if (styleSpec && typeof styleSpec === 'object') {
    boldRows = styleSpec.boldRows ?? [];
    sectionRows = styleSpec.sectionRows ?? styleSpec.sectionHeadingRows ?? [];
    titleStyleId = styleSpec.titleStyle ?? styleSpec.titleStyleId ?? null;
  }
  const boldRowSet = new Set(boldRows);
  const sectionRowSet = new Set(sectionRows);
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastRef}"/>`,
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>',
    '<sheetFormat defaultRowHeight="15"/>',
  ];
  if (widths.length > 0) {
    parts.push('<cols>');
    widths.forEach((w, i) => {
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
    });
    parts.push('</cols>');
  }
  parts.push('<sheetData>');
  rows.forEach((row, r) => {
    parts.push(`<row r="${r + 1}">`);
    row.forEach((value, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const link = linkByCell.get(`${r},${c}`);
      let style = '';
      if (link) {
        style = ' s="2"';
      } else if (r === 0) {
        style = titleStyleId !== null && titleStyleId !== undefined ? ` s="${titleStyleId}"` : ' s="1"';
      } else if (sectionRowSet.has(r)) {
        style = ' s="4"';
      } else if (boldRowSet.has(r)) {
        style = ' s="1"';
      }
      parts.push(`<c r="${ref}" t="s"${style}><v>${shared.idOf(value)}</v></c>`);
    });
    parts.push('</row>');
  });
  parts.push('</sheetData>');
  if (links.length > 0) {
    parts.push('<hyperlinks>');
    for (const l of links) {
      parts.push(`<hyperlink ref="${colName(l.c)}${l.r + 1}" location="${escapeXml(l.location)}"/>`);
    }
    parts.push('</hyperlinks>');
  }
  parts.push('</worksheet>');
  return parts.join('');
}

// Internal link target for a detail worksheet's top cell.
function sheetLocation(sheetName) {
  return `'${String(sheetName ?? '').replace(/'/g, "''")}'!A1`;
}

// ---------- workbook assembly ----------

// Fixed sheet names reserved so detail sheets can never collide with them.
// Assembly order is defined explicitly in buildWorkbookXlsx.
const FIXED_PREFIX_SHEETS = ['Cover', 'Table Summary', 'Table Columns'];
// Retained for reserved-name stability (keeps table sheet naming unchanged);
// the workbook now uses per-routine sheets instead of these shared sheets.
const FIXED_SUFFIX_SHEETS = ['Routine Summary', 'Routine Steps', 'Dependencies', 'Conditions', 'Issues'];
const RESERVED_SHEET_NAMES = new Set(
  [...FIXED_PREFIX_SHEETS, ...FIXED_SUFFIX_SHEETS, 'History'].map((s) => s.toLowerCase())
);

/**
 * Safe, unique worksheet names for rating tables, derived from table titles.
 * Generic: sanitizes forbidden characters, truncates to 31 chars, and
 * de-duplicates case-insensitively. Never hardcodes table names.
 * @param {Array} tables normalized tables in order
 * @returns {string[]} one sheet name per table
 */
export function tableSheetNames(tables) {
  const used = new Set(RESERVED_SHEET_NAMES);
  const out = [];
  (tables ?? []).forEach((t, idx) => {
    const fallback = `Table ${t?.id ?? idx + 1}`;
    const raw = String(t?.name ?? '').trim() || fallback;
    let base = raw.replace(/[:\\/?*[\]]/g, '-').replace(/[\u0000-\u001f]/g, '?').trim();
    if (!base) base = fallback;
    base = base.slice(0, 31).trim() || fallback.slice(0, 31);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` (${n})`;
      candidate = `${base.slice(0, 31 - suffix.length).trimEnd()}${suffix}`;
      if (!candidate.trim()) candidate = `${fallback} (${n})`.slice(0, 31);
      n += 1;
    }
    used.add(candidate.toLowerCase());
    out.push(candidate);
  });
  return out;
}

/**
 * Safe, unique worksheet names for routines, derived from routine names.
 * Generic: same sanitizing rules as tables. `existingNames` avoids collisions
 * with already-assigned sheets (e.g. per-table sheets).
 * @param {Array} routines normalized routines in order
 * @param {string[]} existingNames sheet names already taken
 * @returns {string[]} one sheet name per routine
 */
export function routineSheetNames(routines, existingNames = []) {
  const used = new Set([
    ...RESERVED_SHEET_NAMES,
    ...existingNames.map((n) => String(n ?? '').toLowerCase()),
  ]);
  const out = [];
  (routines ?? []).forEach((r, idx) => {
    const fallback = `Routine ${r?.id ?? idx + 1}`;
    const raw = String(r?.name ?? '').trim() || fallback;
    let base = raw.replace(/[:\\/?*[\]]/g, '-').replace(/[\u0000-\u001f]/g, '?').trim();
    if (!base) base = fallback;
    base = base.slice(0, 31).trim() || fallback.slice(0, 31);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` (${n})`;
      candidate = `${base.slice(0, 31 - suffix.length).trimEnd()}${suffix}`;
      if (!candidate.trim()) candidate = `${fallback} (${n})`.slice(0, 31);
      n += 1;
    }
    used.add(candidate.toLowerCase());
    out.push(candidate);
  });
  return out;
}

function pagesLabel(pages) {
  return (pages ?? []).join(', ');
}

function padRow(cells, colCount) {
  const out = cells.map((c) => String(c ?? ''));
  while (out.length < colCount) out.push('');
  return out;
}

function listJoin(values) {
  return (values ?? []).map((v) => String(v ?? '')).filter((s) => s !== '').join('; ');
}

function continuationText(cont) {
  if (cont === null || cont === undefined || cont === '') return '';
  if (typeof cont === 'string') return cont;
  if (typeof cont === 'object' && !Array.isArray(cont)) {
    return Object.entries(cont)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '')}`)
      .join('; ');
  }
  return String(cont);
}

function parseStepSequence(text, fallbackIndex) {
  const t = String(text ?? '');
  const m = /^\s*(?:step\s*)?(\d+)\s*[:.\)\-]/i.exec(t);
  if (m) return m[1];
  // Bare numbering ('1 Find ...', '(1) Find ...') counts only before a
  // letter, so quantities and decimals never become step numbers.
  const bare = /^\s*(?:step\s*)?(?:\((\d{1,3})\)\s*|(\d{1,2})\s+)(?=[A-Za-z])/i.exec(t);
  if (bare) return bare[1] ?? bare[2];
  return String(fallbackIndex + 1);
}

function isLookupOperation(op) {
  const o = String(op ?? '').toLowerCase();
  return o.includes('lookup') || o.includes('look-up');
}

// Routines (other than the current one) listing a variable among outputs.
// Comparison is spacing/punctuation-insensitive so "base rate" matches
// "base_rate".
function producingRoutines(routines, routineId, variable) {
  const key = normalizeVariableKey(variable);
  if (!key) return [];
  return (Array.isArray(routines) ? routines : []).filter((s) =>
    String(s?.id ?? '') !== String(routineId ?? '')
    && (s?.outputs ?? []).some((o) => normalizeVariableKey(o) === key));
}

function normalizeMatch(s) {
  return normalizeVariableKey(s);
}

// Normalized lookup-key terms across all routines: inputs of lookup steps.
// Used to recognize primary parameters so keys are never mapped as table outputs.
function collectLookupKeyTerms(routines) {
  const out = new Set();
  for (const r of Array.isArray(routines) ? routines : []) {
    for (const d of r?.steps_detailed ?? []) {
      if (!d || !isLookupOperation(d.operation)) continue;
      for (const k of d.inputs ?? []) {
        const n = normalizeMatch(k);
        if (n) out.add(n);
      }
    }
  }
  return out;
}

function candidateTablesForRoutine(routine, tables) {
  const out = [];
  const seen = new Set();
  const targets = [
    ...((routine?.dependencies ?? []).map((d) => d?.target)),
    ...(routine?.depends_on ?? []),
  ];
  for (const t of targets) {
    const mention = String(t ?? '').trim();
    if (!mention) continue;
    const table = resolveTableReference(tables, mention);
    if (table && !seen.has(table)) {
      seen.add(table);
      out.push(table);
    }
  }
  return out;
}

// Table subject for input mapping: the title minus its leading asset label
// ('Table A - ...', 'Schedule Q - ...') and parenthetical qualifiers, so a
// variable named only in a qualifier ('... per 1,000 of insured value')
// never sources that input. Generic document labels, never table names.
function tableSubjectKey(name) {
  const s = String(name ?? '')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\[[^\[\]]*\]/g, ' ');
  const withoutLabel = s.replace(/^\s*(?:table|schedule|appendix|exhibit)\s+\S+\s*[-—–:.]\s*/i, '');
  return normalizeMatch(withoutLabel);
}

function findRoutinesByTarget(routines, target) {
  const key = String(target ?? '').trim().toLowerCase();
  if (!key) return [];
  return (Array.isArray(routines) ? routines : []).filter((s) =>
    String(s?.id ?? '').trim().toLowerCase() === key
    || String(s?.name ?? '').trim().toLowerCase() === key);
}

// Map each routine input to its source table or producing routine using only
// explicit evidence: own lookup steps, unique routine outputs, then a unique
// name/header match within the routine's explicit table dependencies.
// Anything else is an input parameter (when no sources are evidenced or the
// value is a known lookup key) or marked unresolved rather than guessed.
function resolveInputSources(routine, routines, tables) {
  const inputs = routine?.inputs ?? [];
  if (inputs.length === 0) return [];
  const allKeys = collectLookupKeyTerms(routines);
  const candidates = candidateTablesForRoutine(routine, tables);
  const hasSourcesEvidence = (routine?.depends_on ?? []).some((v) => String(v ?? '').trim())
    || (routine?.dependencies ?? []).length > 0
    || (routine?.steps_detailed ?? []).length > 0;
  const out = [];
  for (const rawInput of inputs) {
    const trimmed = String(rawInput ?? '').trim();
    if (!trimmed) continue;
    const inputKey = normalizeVariableKey(trimmed);
    const own = (routine?.steps_detailed ?? []).find((d) =>
      d && isLookupOperation(d.operation) && normalizeVariableKey(d.output) === inputKey);
    if (own) {
      const mentions = (own.depends_on ?? []).map((d) => String(d ?? '').trim()).filter(Boolean);
      const resolved = [];
      const seen = new Set();
      for (const m of mentions) {
        const t = resolveTableReference(tables, m);
        if (t && !seen.has(t)) {
          seen.add(t);
          resolved.push(t);
        }
      }
      const keys = listJoin(own.inputs);
      if (resolved.length === 1) {
        out.push({ input: trimmed, source: String(resolved[0].name ?? resolved[0].id ?? ''), keys });
      } else if (resolved.length > 1) {
        out.push({ input: trimmed, source: `${resolved.map((t) => String(t.name ?? t.id ?? '')).join('; ')} (multiple — verify)`, keys });
      } else if (mentions.length > 0) {
        out.push({ input: trimmed, source: `"${mentions[0]}" (unresolved — verify)`, keys });
      } else {
        out.push({ input: trimmed, source: 'unresolved — verify', keys });
      }
      continue;
    }
    const producers = producingRoutines(routines, routine?.id, trimmed);
    if (producers.length === 1) {
      out.push({ input: trimmed, source: String(producers[0].name ?? producers[0].id ?? ''), keys: '' });
      continue;
    }
    if (producers.length > 1) {
      out.push({ input: trimmed, source: `multiple routines (${producers.map((s) => String(s?.name ?? s?.id ?? '')).join('; ')}) — verify`, keys: '' });
      continue;
    }
    const norm = normalizeMatch(trimmed);
    if (norm && allKeys.has(norm)) {
      out.push({ input: trimmed, source: 'input parameter', keys: '' });
      continue;
    }
    if (norm.length >= 3 && candidates.length > 0) {
      // A table sources an input only when the input equals a column label
      // or the table's subject (the title minus its asset label and
      // qualifiers). Substring matches inside long descriptive titles are
      // not evidence: they misattribute external inputs to the wrong table.
      const matches = candidates.filter((t) => {
        const headers = [
          ...(t?.headers ?? []),
          ...(t?.columns ?? []).map((c) => c?.label ?? c?.original_label),
        ];
        if (headers.some((h) => normalizeMatch(h) === norm)) return true;
        const subject = tableSubjectKey(t?.name ?? '');
        return Boolean(subject) && subject === norm;
      });
      if (matches.length === 1) {
        out.push({ input: trimmed, source: String(matches[0].name ?? matches[0].id ?? ''), keys: '' });
        continue;
      }
      if (matches.length > 1) {
        out.push({ input: trimmed, source: 'unresolved — verify', keys: '' });
        continue;
      }
    }
    if (!hasSourcesEvidence) {
      out.push({ input: trimmed, source: 'input parameter', keys: '' });
    } else {
      out.push({ input: trimmed, source: 'unresolved — verify', keys: '' });
    }
  }
  return out;
}

// Step comment for one entry: the lookup's table and result plus how each
// input was produced — an earlier step in this routine or another routine's
// output. Returns '' when nothing is traceable; unknown references stay
// silent here because the validator flags them. priorOutputs maps normalized
// output -> { seq, table } for earlier steps in order.
// Rating-routine sheets pass { lookupPrefix: false }: the table reference
// already lives in the Operand column, so only the unresolved-table flag
// and the uses-from traceability survive here.
function stepComment(step, routine, routines, tables, tableTerms, priorOutputs, { lookupPrefix = true } = {}) {
  const det = step.det ?? null;
  const output = step.output || '';
  const parts = [];
  const flags = [];
  if (det && isLookupOperation(det.operation)) {
    const mentions = (det.depends_on ?? []).map((d) => String(d ?? '').trim()).filter(Boolean);
    const resolved = [];
    const seen = new Set();
    for (const mention of mentions) {
      const table = resolveTableReference(tables, mention);
      if (table && !seen.has(table)) {
        seen.add(table);
        resolved.push(table);
      }
    }
    const outputBit = output ? ` → ${output}` : '';
    if (resolved.length > 0) {
      if (lookupPrefix) parts.push(`lookup ${resolved.map((t) => String(t.name ?? t.id ?? '')).join('; ')}${outputBit}`);
    } else if (mentions.length > 0) {
      if (lookupPrefix) parts.push(`lookup "${mentions[0]}"${outputBit}`);
      flags.push('table unresolved — verify');
    } else if (output) {
      if (lookupPrefix) parts.push(`lookup${outputBit}`);
    }
  }
  const routineTerms = new Set(
    [...(routine.inputs ?? []), ...(routine.outputs ?? [])]
      .map((s) => normalizeVariableKey(s))
      .filter(Boolean)
  );
  const normalizedTableTerms = new Set(
    [...(tableTerms ?? [])].map((s) => normalizeVariableKey(s)).filter(Boolean)
  );
  for (const raw of det?.inputs ?? []) {
    const variable = String(raw ?? '').trim();
    if (!variable) continue;
    const varKey = normalizeVariableKey(variable);
    const prior = priorOutputs instanceof Map ? priorOutputs.get(varKey) : null;
    if (prior) {
      const tableBit = prior.table ? ` (${prior.table})` : '';
      if (prior.seq !== '' && prior.seq !== null && prior.seq !== undefined) {
        parts.push(`uses ${variable} from step ${prior.seq}${tableBit}`);
      } else {
        parts.push(`uses ${variable} from prior step${tableBit}`);
      }
      continue;
    }
    const producers = producingRoutines(routines, routine?.id, variable);
    if (producers.length === 1) {
      parts.push(`uses ${variable} from ${producers[0].name ?? producers[0].id ?? ''}`);
    } else if (producers.length > 1) {
      parts.push(`uses ${variable} from multiple routines (${producers.map((s) => String(s?.name ?? s?.id ?? '')).join('; ')}) — verify`);
    } else if (routineTerms.has(varKey) || normalizedTableTerms.has(varKey)) {
      continue;
    }
  }
  return [...parts, ...flags].join('; ');
}

function priorTableForStep(det, tables) {
  if (!det || !isLookupOperation(det.operation)) return null;
  for (const raw of det.depends_on ?? []) {
    const mention = String(raw ?? '').trim();
    if (!mention) continue;
    const table = resolveTableReference(tables, mention);
    if (table) return String(table.name ?? table.id ?? '');
  }
  return null;
}

// Table and routine links evidenced by the routine's own steps, in step
// order: lookup targets with retrieved variables and keys, plus cross-routine
// inputs (skipping values produced by earlier steps in this routine).
// Returns a Map keyed by lowercased display target.
function collectStepDerived(stepEntries, routine, routines, tables) {
  const map = new Map();
  const prior = new Map();
  const ensure = (target, type) => {
    const key = String(target ?? '').toLowerCase();
    if (!map.has(key)) map.set(key, { target: String(target ?? ''), type, vars: new Map() });
    return map.get(key);
  };
  for (const e of stepEntries ?? []) {
    const det = e?.det ?? null;
    if (det && isLookupOperation(det.operation)) {
      const mentions = (det.depends_on ?? []).map((d) => String(d ?? '').trim()).filter(Boolean);
      const resolved = [];
      const seen = new Set();
      for (const m of mentions) {
        const t = resolveTableReference(tables, m);
        if (t && !seen.has(t)) {
          seen.add(t);
          resolved.push(t);
        }
      }
      const keys = e.keys || listJoin(det.inputs);
      const output = e.output || String(det.output ?? '');
      const varFmt = output ? (keys ? `${output} (keys: ${keys})` : output) : (keys ? `(keys: ${keys})` : '');
      if (resolved.length > 0) {
        for (const t of resolved) {
          const entry = ensure(String(t.name ?? t.id ?? ''), 'table');
          if (varFmt && output && !entry.vars.has(normalizeVariableKey(output))) entry.vars.set(normalizeVariableKey(output), varFmt);
          else if (varFmt && !output && !entry.vars.has(varFmt.toLowerCase())) entry.vars.set(varFmt.toLowerCase(), varFmt);
        }
      } else if (mentions.length > 0) {
        const entry = ensure(mentions[0], '');
        if (varFmt) {
          const vk = normalizeVariableKey(output || varFmt) || String(output || varFmt).toLowerCase();
          if (!entry.vars.has(vk)) entry.vars.set(vk, varFmt);
        }
      }
    }
    for (const raw of det?.inputs ?? []) {
      const variable = String(raw ?? '').trim();
      if (!variable || prior.has(normalizeVariableKey(variable))) continue;
      for (const p of producingRoutines(routines, routine?.id, variable)) {
        const entry = ensure(String(p.name ?? p.id ?? ''), 'routine');
        const vk = normalizeVariableKey(variable);
        if (!entry.vars.has(vk)) entry.vars.set(vk, variable);
      }
    }
    if (e?.output) {
      prior.set(normalizeVariableKey(e.output), { seq: e.seq ?? '', table: priorTableForStep(det, tables) });
    }
  }
  return map;
}

function stepOperandCell(step) {
  if (isLookupOperation(step.det?.operation)) return step.keys || '';
  return step.expression || step.operand || step.keys || '';
}

function parseFinalExpressionOutput(expressionText) {
  const t = String(expressionText ?? '').trim();
  if (!t || /^(if|else|when|otherwise)\b/i.test(t)) return '';
  const commaIdx = t.search(/,\s*(where|with)\b/i);
  const main = commaIdx < 0 ? t : t.slice(0, commaIdx);
  const m = /^\s*(?:calculate\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(main);
  if (!m || !m[2].trim()) return '';
  return m[1];
}

function isSameVariableRounding(entry) {
  if (String(entry?.operation ?? '').toLowerCase() !== 'rounding') return false;
  const output = String(entry?.output ?? '');
  if (!output.trim()) return true;
  const outKey = normalizeVariableKey(output);
  if (!outKey) return true;
  const operandKey = normalizeVariableKey(entry?.operand ?? '');
  if (operandKey && operandKey === outKey) return true;
  const inputs = entry?.det?.inputs ?? [];
  if (Array.isArray(inputs) && inputs.length > 0) {
    const inputKeys = inputs.map((v) => normalizeVariableKey(v)).filter(Boolean);
    if (inputKeys.length > 0 && inputKeys.every((k) => k === outKey)) return true;
  }
  return false;
}

function stepCalculationText(entry) {
  return entry?.expression || entry?.instruction || entry?.operand || entry?.keys || '';
}

// Terminal step producing a routine output, skipping same-variable rounding
// post-processing. Returns null when no step output matches routine outputs.
function terminalOutputStep(stepEntries, routineOutputs) {
  const outputKeys = new Set(
    (routineOutputs ?? []).map((o) => normalizeVariableKey(o)).filter(Boolean)
  );
  if (outputKeys.size === 0) return null;
  for (let i = (stepEntries ?? []).length - 1; i >= 0; i -= 1) {
    const entry = stepEntries[i];
    const key = normalizeVariableKey(entry?.output ?? '');
    if (!key || !outputKeys.has(key)) continue;
    if (isSameVariableRounding(entry)) continue;
    return entry;
  }
  return null;
}

function lastNonRoundingStep(stepEntries) {
  return [...(stepEntries ?? [])].reverse()
    .find((e) => String(e?.operation ?? '').toLowerCase() !== 'rounding')
    ?? (stepEntries ?? [])[(stepEntries ?? []).length - 1]
    ?? null;
}

// Choose the Final calculation entry {calculation, output} or null when
// nothing is available. Prefers the routine expression when it matches the
// terminal stage; uses the terminal output step when the expression is an
// intermediate stage so raw/adjusted/final outputs stay separate.
function selectFinalCalculation(routine, stepEntries, finalExpression) {
  const expr = String(finalExpression ?? '');
  const hasExpr = Boolean(expr.trim());
  const outputs = routine?.outputs ?? [];
  const terminal = terminalOutputStep(stepEntries, outputs);
  if (hasExpr && (stepEntries ?? []).length > 0 && terminal) {
    const exprOutput = parseFinalExpressionOutput(expr);
    if (!exprOutput) {
      return { calculation: expr, output: listJoin(outputs) };
    }
    const exprKey = normalizeVariableKey(exprOutput);
    const terminalKey = normalizeVariableKey(terminal.output ?? '');
    const terminalCalc = stepCalculationText(terminal);
    if (exprKey && exprKey === terminalKey && expr.trim() === String(terminalCalc ?? '').trim()) {
      return { calculation: expr, output: listJoin(outputs) };
    }
    const outputKeys = new Set(outputs.map((o) => normalizeVariableKey(o)).filter(Boolean));
    if (terminalKey && outputKeys.has(terminalKey) && exprKey !== terminalKey) {
      return { calculation: terminalCalc, output: String(terminal.output ?? '') };
    }
    if (exprKey && outputKeys.has(exprKey) && terminalKey && outputKeys.has(terminalKey) && exprKey === terminalKey) {
      return { calculation: expr, output: listJoin(outputs) };
    }
    if (exprKey && !outputKeys.has(exprKey) && terminalKey && outputKeys.has(terminalKey)) {
      return { calculation: terminalCalc, output: String(terminal.output ?? '') };
    }
    return { calculation: expr, output: listJoin(outputs) };
  }
  if (hasExpr) {
    // No terminal stage evidenced: pair the formula with its own assignment
    // target rather than mapping an intermediate formula to the final output.
    return { calculation: expr, output: parseFinalExpressionOutput(expr) || listJoin(outputs) };
  }
  if ((stepEntries ?? []).length === 0) return null;
  if (terminal) {
    const calculation = stepCalculationText(terminal);
    const output = String(terminal.output ?? '');
    if (calculation || output) return { calculation, output };
  }
  const last = lastNonRoundingStep(stepEntries);
  if (!last) return null;
  const calculation = stepCalculationText(last);
  const output = String(last?.output ?? '');
  if (!calculation && !output) return null;
  return { calculation, output };
}

// Rating-routine Steps use explicit bracket columns; the legacy layout keeps
// the five-column form for condition routines. Both are accepted when
// locating the header row for formatting.
const RATING_STEPS_HEADER = ['Step #', 'Instruction', 'Op', '(', 'Operand', ')', 'Line Comment'];
const LEGACY_STEPS_HEADER = ['Step #', 'Instruction', 'Operation', 'Operand', 'Comment'];

// Section headings on routine sheets and their column headers (null when the
// section carries detail rows instead of a table). Used only to locate rows
// for formatting; routineSheetRows remains the single source of sheet content.
const ROUTINE_SECTION_HEADERS = new Map([
  ['Inputs', ['Input', 'Source', 'Lookup keys']],
  ['Steps', RATING_STEPS_HEADER],
  ['Final calculation', ['Calculation', 'Output']],
  ['Conditions', ['#', 'Condition', 'True branch', 'False branch', 'Referral code']],
  ['Dependencies', ['Target', 'Type', 'Explicit/Inferred', 'Variable / Keys']],
  ['Unresolved items', ['Issue ID', 'Severity', 'Message']],
  ['Source evidence', null],
]);

// Shared routine-sheet sections used by both the rating-routine layout and the
// legacy layout below. Extracted verbatim so the legacy output is unchanged.
function pushRoutineHeader(rows, r) {
  rows.push([String(r.name ?? '')]);
  const detail = (label, value) => {
    if (value !== '' && value !== null && value !== undefined) rows.push([label, String(value)]);
  };
  detail('Kind', String(r.kind ?? ''));
  detail('Purpose', String(r.purpose ?? ''));
  detail('Applicability', String(r.applicability ?? ''));
  detail('Execution context', String(r.execution_context ?? ''));
  detail('Notes', String(r.notes ?? ''));
}

function buildCondEntries(r) {
  const conds = r.conditions ?? [];
  const condDetailed = r.conditions_detailed ?? [];
  const condAligned = condDetailed.length > 0 && condDetailed.length === conds.length;
  const condCount = Math.max(conds.length, condDetailed.length);
  const condEntries = [];
  for (let idx = 0; idx < condCount; idx += 1) {
    const text = idx < conds.length ? String(conds[idx] ?? '') : '';
    const det = condAligned ? condDetailed[idx] : (idx < condDetailed.length ? condDetailed[idx] : null);
    if (!text.trim() && !det) continue;
    condEntries.push({
      num: String(idx + 1),
      condition: text || String(det?.condition ?? det?.original_text ?? ''),
      trueBranch: String(det?.true_branch ?? ''),
      falseBranch: String(det?.false_branch ?? ''),
      referral: String(det?.referral_code ?? ''),
      det,
    });
  }
  return condEntries;
}

function pushConditionsSection(rows, condEntries) {
  if (condEntries.length === 0) return;
  rows.push(['Conditions']);
  rows.push(['#', 'Condition', 'True branch', 'False branch', 'Referral code']);
  for (const e of condEntries) {
    rows.push([e.num, e.condition, e.trueBranch, e.falseBranch, e.referral]);
  }
}

function pushUnresolvedItems(rows, routineIssues) {
  if ((routineIssues ?? []).length === 0) return;
  rows.push(['Unresolved items']);
  rows.push(['Issue ID', 'Severity', 'Message']);
  for (const issue of routineIssues) {
    rows.push([String(issue.id ?? ''), String(issue.severity ?? ''), String(issue.message ?? '')]);
  }
}

function pushRoutineEvidence(rows, r, stepEntries, condEntries, depEntries) {
  const evidenceRows = [];
  const pages = pagesLabel(r.source_pages);
  if (pages) evidenceRows.push(['Source pages', pages]);
  if (String(r.source_location ?? '')) evidenceRows.push(['Source location', String(r.source_location)]);
  if (String(r.evidence_text ?? '')) evidenceRows.push(['Evidence', String(r.evidence_text)]);
  (stepEntries ?? []).forEach((e) => {
    const det = e.det;
    if (!det) return;
    const tag = e.seq !== '' ? `Step ${e.seq}` : 'Step';
    const sp = det.source_pages?.length ? pagesLabel(det.source_pages) : '';
    const ev = String(det.evidence ?? '');
    const status = String(det.interpretation_status ?? '');
    if (sp) evidenceRows.push([`${tag} pages`, sp]);
    if (ev) evidenceRows.push([`${tag} evidence`, ev]);
    if (status) evidenceRows.push([`${tag} status`, status]);
  });
  (condEntries ?? []).forEach((e) => {
    const det = e.det;
    if (!det) return;
    const sp = det.source_pages?.length ? pagesLabel(det.source_pages) : '';
    const ev = String(det.evidence ?? '');
    const status = String(det.interpretation_status ?? '');
    if (sp) evidenceRows.push([`Condition ${e.num} pages`, sp]);
    if (ev) evidenceRows.push([`Condition ${e.num} evidence`, ev]);
    if (status) evidenceRows.push([`Condition ${e.num} status`, status]);
  });
  (depEntries ?? []).forEach((e) => {
    const det = e.det;
    if (!det) return;
    const sp = det.source_pages?.length ? pagesLabel(det.source_pages) : '';
    const ev = String(det.evidence ?? '');
    if (sp) evidenceRows.push([`Dependency ${e.target} pages`, sp]);
    if (ev) evidenceRows.push([`Dependency ${e.target} evidence`, ev]);
  });
  if (evidenceRows.length === 0) return;
  rows.push(['Source evidence']);
  for (const row of evidenceRows) rows.push(row);
}

// ---------- Stepwise rating-routine steps ----------

// Lookup keys render with dots as spaces ('Coverage.Name' to 'Coverage
// Name'): the spaced label communicates the same key without implying an
// object path. Display-only; model data is untouched.
function humanizeLookupKey(key) {
  return String(key ?? '').trim().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

// Operand for a lookup step: `table:Name (key1, key2)` with the resolved
// extracted table name when it resolves uniquely, else the verbatim source
// mention. Keys-only and table-only lookups degrade gracefully; a lookup
// with neither yields '' so nothing is invented.
function lookupOperand(det, tables) {
  const mention = (det?.depends_on ?? []).map((d) => String(d ?? '').trim()).find(Boolean) ?? '';
  const resolved = mention ? resolveTableReference(tables, mention) : null;
  const table = resolved ? String(resolved.name ?? resolved.id ?? '') : mention;
  const keys = (det?.inputs ?? []).map((k) => humanizeLookupKey(k)).filter(Boolean);
  if (table && keys.length > 0) return `table:${table} (${keys.join(', ')})`;
  if (table) return `table:${table}`;
  return keys.join(', ');
}

// Right-hand side of an assignment step: strip an optional 'Calculate' verb
// and sentence-final period, then split 'output = rhs'. An explicit output
// paired with a right-hand-side-only expression (no '=') also yields
// { output, rhs } so model-provided calculations render as clean
// `output <-- rhs` rows. Multi-assignment expressions (top-level `;`)
// return null here: the expansion below renders each segment as its own
// row group instead. Returns null when no plain assignment is evidenced
// (prose, comparisons, and conditionals fall back to the verbatim text).
function splitAssignment(det) {
  const raw = String(det?.expression ?? '');
  const outputRaw = String(det?.output ?? '');
  if (!raw.trim()) {
    const operand = String(det?.operand ?? '');
    if (outputRaw && operand.trim()) return { output: outputRaw, rhs: operand.trim() };
    return null;
  }
  if (splitTopLevel(raw, ';').length > 1) return null;
  const clean = raw.replace(/^\s*calculate\s+/i, '').replace(/\.\s*$/, '').trim();
  if (/^(if|else|when|otherwise)\b/i.test(clean)) return null;
  const m = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/.exec(clean);
  if (m && m[2].trim() && !/^[=<>!]/.test(m[2].trim())) {
    return { output: outputRaw || m[1], rhs: m[2].trim() };
  }
  if (outputRaw && !clean.includes('=')) return { output: outputRaw, rhs: clean };
  return null;
}

// Operand for a partially parsed step: keep whatever the parser evidenced
// (expression, operand, or keys) without inventing an operation for it.
function fallbackOperand(det) {
  for (const v of [det?.expression, det?.operand]) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return (det?.inputs ?? []).map((k) => String(k ?? '').trim()).filter(Boolean).join(', ');
}

// Single variable-like token (dotted or hyphenated codes included): the
// only operand shapes treated as a rounding source. Anything else is source
// wording or precision detail and is preserved verbatim in the operand.
function isVariableLike(value) {
  return /^[A-Za-z_][\w.-]*$/.test(String(value ?? '').trim());
}

// Rounding detail after the target ('to the nearest whole unit ...'): the
// step label, 'Round <target>' lead, trailing store-as clause, and
// sentence-final punctuation are stripped. Generic wording, never variable
// or routine names. Returns '' when no detail is evidenced.
function extractRoundingDetail(text) {
  let body = String(text ?? '').trim();
  if (!body) return '';
  body = body.replace(/^\s*step\s+\d+\s*[:.)\-]?\s*/i, '').replace(/^\s*\(?\d{1,3}\)?[\s:.)\-]+\s*/, '');
  const m = /^\s*round\s+[A-Za-z_][\w.-]*\s+([\s\S]+?)\s*$/i.exec(body);
  if (!m || !m[1].trim()) return '';
  let rest = m[1].trim();
  rest = rest.split(/\s*\.\s*store\b/i)[0].split(/\s*;\s*store\b/i)[0].split(/\s*,\s*store\s+the\s+result\s+as\b/i)[0].trim();
  // A trailing assignment restating the rounded result (`: out=fn(x;2)`)
  // is the step's structured output, not rounding wording, so it is cut.
  rest = rest.split(/\s*:\s*[A-Za-z_]\w*\s*=[\s\S]*$/)[0].trim();
  rest = rest.replace(/[.;]+\s*$/, '').trim();
  if (!rest || /^store\b/i.test(rest)) return '';
  return rest;
}

// Rounding wording after the keyword for targetless rounding statements
// ("Rounded Half-Up to Nearest Coin | Valid via Core API"): the step label,
// the round/rounded/rounding keyword, trailing store-as and pipe clauses,
// and sentence-final punctuation are stripped. Generic wording, never
// variable or routine names. Returns '' when no wording is evidenced.
function extractRoundingWording(text) {
  let body = String(text ?? '').trim();
  if (!body) return '';
  body = body.replace(/^\s*step\s+\d+\s*[:.)\-]?\s*/i, '').replace(/^\s*\(?\d{1,3}\)?[\s:.)\-]+\s*/, '');
  const m = /\bround(?:ed|ing|s)?\b\s*([\s\S]+?)\s*$/i.exec(body);
  if (!m || !m[1].trim()) return '';
  let rest = m[1].trim().split('|')[0].trim();
  rest = rest.split(/\s*\.\s*store\b/i)[0].split(/\s*;\s*store\b/i)[0].split(/\s*,\s*store\s+the\s+result\s+as\b/i)[0].trim();
  rest = rest.replace(/[.;]+\s*$/, '').trim();
  if (!rest || /^store\b/i.test(rest)) return '';
  return rest;
}

// Distinct operator lexemes in source order from a bare calculation, for the
// Op column of a targetless expression row. Hyphens count only when spaced
// (hyphenated codes are operands); en/em dashes are prose, never operators.
function bareExpressionLexemes(expression) {
  const out = [];
  const seen = new Set();
  const s = String(expression ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    let op = null;
    if (ch === '+' || ch === '*' || ch === '/' || ch === '×' || ch === '÷') op = ch;
    else if (ch === '-' && (s[i - 1] === ' ' || s[i - 1] === '\t') && (s[i + 1] === ' ' || s[i + 1] === '\t')) op = ch;
    if (op && !seen.has(op)) {
      seen.add(op);
      out.push(op);
    }
  }
  return out;
}

// Conditional step operations handled generically in rating-routine Steps:
// the model 'condition' operation plus explicit conditional keywords, so a
// structured 'IF'/'ELSEIF'/'ELSE' step renders the same as parsed wording.
const CONDITION_OPERATION_WORDS = new Set(['condition', 'conditional', 'if', 'elseif', 'else']);

function isConditionOperation(op) {
  return CONDITION_OPERATION_WORDS.has(String(op ?? '').trim().toLowerCase());
}

// Display view of a stored step detail: the same canonicalization and
// worked-value stripping as normalization, applied to a copy so stored
// jobs predating the fix still render cleaned reusable columns. The
// source instruction text is never altered.
function displayDet(det) {
  if (!det || typeof det !== 'object') return det ?? null;
  const copy = {
    ...det,
    inputs: Array.isArray(det.inputs) ? [...det.inputs] : det.inputs,
    depends_on: Array.isArray(det.depends_on) ? [...det.depends_on] : det.depends_on,
  };
  sanitizeExplicitStep(copy);
  return copy;
}

// One stepwise rating-routine entry { instruction, operation, operand, output, det }.
// Pure assignments (lookups, `output = rhs`, explicit output with rhs-only
// expression) read as `output <-- operand`; rounding reads as
// `output R source wording`; conditions expand with their keywords under
// Instruction. Anything without a mappable output (targetless
// calculations, unparsed lines) keeps the verbatim source text flagged for
// review so no detail is lost and no expression poses as an Instruction.
function renderRatingStep(text, origDet, tables) {
  const det = displayDet(origDet);
  const instruction = String(text ?? '');
  if (det && isLookupOperation(det.operation)) {
    const operand = lookupOperand(det, tables);
    const output = String(det.output ?? '');
    if (output) return { instruction: output, operation: '<--', operand, output, det };
    if (operand) return { instruction, operation: '<--', operand, output: '', det };
    return { instruction, operation: '', operand: '', output: '', det: null };
  }
  const word = String(det?.operation ?? '').toLowerCase();
  if (det && (word === 'expression' || word === 'assignment')) {
    const split = splitAssignment(det);
    if (split) return { instruction: split.output, operation: '<--', operand: split.rhs, output: split.output, det };
    // Multi-assignment steps keep their detail so the expansion below can
    // render each segment; anything else stays verbatim for review.
    if (splitTopLevel(String(det.expression ?? ''), ';').length > 1) {
      return { instruction, operation: '', operand: '', output: String(det.output ?? ''), det };
    }
    return { instruction, operation: '', operand: '', output: '', det: null };
  }
  if (det && word === 'rounding') {
    // Final assignment form: the evidenced output variable leads under
    // Instruction with the rounding operation preserved, and the operand
    // carries the rounded source plus its source wording. Same-variable
    // rounding keeps only the wording so the variable is not repeated. An
    // input-only source never becomes the target: without an explicit
    // output or operand, the step stays targetless so validation and the
    // workbook agree that no target was stated.
    const target = String(det.output ?? '').trim();
    const operandRaw = String(det.operand ?? '').trim();
    const operandSource = isVariableLike(operandRaw) ? operandRaw : '';
    const inputSource = (det.inputs ?? []).map((v) => String(v ?? '').trim()).find((v) => isVariableLike(v)) ?? '';
    const source = operandSource || inputSource;
    const detail = extractRoundingDetail(instruction);
    const resolvedTarget = target || operandSource;
    if (!resolvedTarget) {
      const wording = extractRoundingWording(instruction);
      return { instruction, operation: 'R', operand: wording || operandRaw || fallbackOperand(det), output: target, det };
    }
    const sameVariable = Boolean(target && source)
      && normalizeVariableKey(target) === normalizeVariableKey(source);
    let operand;
    if (target && source && !sameVariable) {
      operand = detail && !detail.toLowerCase().startsWith(source.toLowerCase())
        ? `${source} ${detail}`
        : (detail || source);
      if (operandRaw && !isVariableLike(operandRaw) && operandRaw !== detail && !operand.includes(operandRaw)) {
        operand = `${operand} (${operandRaw})`;
      }
    } else {
      operand = detail || operandRaw || source;
    }
    return { instruction: resolvedTarget, operation: 'R', operand, output: resolvedTarget, det };
  }
  if (det && isConditionOperation(det.operation)) {
    return { instruction, operation: '', operand: String(det.output ?? ''), output: String(det.output ?? ''), det };
  }
  if (det && det.operation !== undefined && det.operation !== null && String(det.operation) !== '') {
    return { instruction, operation: String(det.operation), operand: fallbackOperand(det), output: String(det.output ?? ''), det };
  }
  return { instruction, operation: '', operand: '', output: '', det: det ?? null };
}

// A formula-only routine (no steps) still renders one stepwise row
// from its stated expression: `output = rhs` becomes `output <-- rhs`.
// Anything else stays verbatim with no invented operation.
function synthesizedExpressionEntry(r) {
  const raw = String(r.expression_text ?? '');
  if (!raw.trim()) return null;
  const clean = raw.replace(/^\s*calculate\s+(?=[A-Za-z_]\w*\s*=)/i, '').replace(/\.\s*$/, '').trim();
  const parsed = parseAssignmentOperands(clean);
  const rhs = parsed ? clean.replace(/^\s*[A-Za-z_]\w*\s*=\s*/, '') : '';
  if (parsed && parsed.outputs[0] && rhs.trim() && !/^[=<>!]/.test(rhs.trim())) {
    return {
      seq: '1',
      instruction: parsed.outputs[0],
      operation: '<--',
      operand: rhs.trim(),
      output: parsed.outputs[0],
      det: { inputs: parsed.inputs, output: parsed.outputs[0] },
    };
  }
  return { seq: '1', instruction: raw, operation: '', operand: '', output: '', det: null };
}

// ---------- Rating-step expansion (generic) ----------

// Tokenize an arithmetic right-hand side into operands, operators, and
// parentheses. Identifiers may carry dots (source keys) or hyphens (coded
// step outputs such as LX-01); numbers keep their exact text. A hyphen
// inside a code is part of the operand because the identifier match runs
// first; a spaced hyphen still tokenizes as minus. Returns null on any
// unfamiliar character so the caller keeps the verbatim single row instead
// of inventing an interpretation. A function invocation (`name(...)` with
// no space before the paren) tokenizes as one operand so calls split
// around their arguments without parsing inside them; currency-prefixed
// amounts (`$37.50`) tokenize as one value operand.
function tokenizeArithmetic(rhs) {
  const tokens = [];
  const text = String(rhs ?? '');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i += 1;
      continue;
    }
    const idMatch = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/.exec(text.slice(i));
    if (idMatch && idMatch.index === 0) {
      let value = idMatch[0];
      let next = i + value.length;
      // A directly attached paren group is a call's argument list, kept
      // whole as one invocation operand; unbalanced parens fail safe.
      if (text[next] === '(') {
        let depth = 0;
        let j = next;
        for (; j < text.length; j += 1) {
          if (text[j] === '(') depth += 1;
          else if (text[j] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) return null;
        value += text.slice(next, j + 1);
        next = j + 1;
      }
      tokens.push({ type: 'operand', value });
      i = next;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '×' || ch === '÷') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    const numMatch = /(?:[₹$€£¥]\s*)?\d+(?:\.\d+)?%?/.exec(text.slice(i));
    if (numMatch && numMatch.index === 0) {
      tokens.push({ type: 'operand', value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function isIdentifierOperand(value) {
  return /^[+-]?[A-Za-z_][A-Za-z0-9_.-]*$/.test(String(value ?? '').trim());
}

// Amount-like parenthetical group: numbers, currency, percents, and
// punctuation only — no letters — so "(2,000)" and "(3.28%)" strip as
// worked illustration values while grouping parens (with variables or
// operators inside) are left for the strict tokenizer or REVIEW.
function isAmountParen(inner) {
  return /^[\s₹$€£¥\d,.\%+-]+$/.test(String(inner ?? ''));
}

// Reusable term inside one phrase operand: strip amount parentheticals,
// collapse whitespace, and keep a bare amount only when nothing else
// remains. Returns null when the operand carries grouping parens,
// multi-part markers, nested operators, or descriptive length instead of
// a single term.
function cleanPhraseOperand(fragment) {
  const text = String(fragment ?? '').trim();
  if (!text || /[;:|?!]/.test(text)) return null;
  let cleaned = text;
  const groups = [...text.matchAll(/\(([^()]*)\)/g)];
  for (const g of groups) {
    if (!isAmountParen(g[1])) return null;
  }
  cleaned = cleaned.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    const fallback = groups.length > 0 ? String(groups[0][1] ?? '').trim() : '';
    if (!fallback) return null;
    cleaned = fallback;
  }
  if (cleaned.includes('=')) return null;
  if (/[+*/×÷%=-]/.test(cleaned.replace(/^[+-]/, ''))) {
    if (/[+*/×÷%]/.test(cleaned)) return null;
    if (/\s+-\s+/.test(` ${cleaned} `)) return null;
  }
  if (cleaned.split(/\s+/).filter(Boolean).length > 4) return null;
  return cleaned;
}

// Split a flat multi-operand expression with phrase operands ("Vehicle
// Units (2,000) × Zone Rate (4.50%)") into single cleaned operands with
// source-order operators. Parens are never split across, so grouping and
// amounts stay attached to their operand for the cleaner to accept or
// reject. Returns { operands, ops } or null when any side is not a
// single term.
function splitPhraseOperands(rhs) {
  const text = String(rhs ?? '').trim();
  if (!text) return null;
  const operands = [];
  const ops = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    operands.push(current);
    current = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
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
    if (depth === 0 && (ch === '+' || ch === '*' || ch === '/' || ch === '%' || ch === '×' || ch === '÷')) {
      flush();
      ops.push(ch);
      continue;
    }
    if (depth === 0 && ch === '-' && /\s/.test(text[i - 1] ?? ' ') && /\s/.test(text[i + 1] ?? ' ')) {
      flush();
      ops.push(ch);
      continue;
    }
    current += ch;
  }
  flush();
  if (operands.length < 2 || ops.length !== operands.length - 1) return null;
  const cleaned = [];
  for (const part of operands) {
    const term = cleanPhraseOperand(part);
    if (!term) return null;
    cleaned.push(term);
  }
  return { operands: cleaned, ops };
}

// Expand `output = rhs` into one ordered row per operation, preserving the
// source order, operator lexemes, and parentheses. The first row assigns the
// opening operand; each following row carries its operator with the next
// operand. Bracket markers attach to the operand rows they surround, so
// reassembling the rows reproduces the original expression and its meaning.
// Returns null when the right-hand side is not plain arithmetic.
function expandArithmetic(output, rhs) {
  const tokens = tokenizeArithmetic(rhs);
  if (!tokens || tokens.length === 0) return null;
  const rows = [];
  let pendingOpen = '';
  let pendingOp = null;
  let pendingUnary = '';
  let expectOperand = true;
  for (const token of tokens) {
    if (token.type === 'lparen') {
      if (!expectOperand) return null;
      pendingOpen += '(';
    } else if (token.type === 'rparen') {
      if (expectOperand || rows.length === 0) return null;
      rows[rows.length - 1].close += ')';
      expectOperand = false;
    } else if (token.type === 'op') {
      if (expectOperand) {
        if ((token.value === '+' || token.value === '-') && !pendingUnary) {
          pendingUnary = token.value;
        } else {
          return null;
        }
      } else {
        pendingOp = token.value;
        expectOperand = true;
        pendingUnary = '';
      }
    } else {
      if (!expectOperand) return null;
      const operand = `${pendingUnary}${token.value}`;
      let op;
      if (rows.length === 0) {
        if (pendingOp) return null;
        op = '<--';
      } else {
        if (!pendingOp) return null;
        op = pendingOp;
        pendingOp = null;
      }
      rows.push({
        instruction: rows.length === 0 ? String(output ?? '') : '',
        op,
        open: pendingOpen,
        operand,
        close: '',
      });
      pendingOpen = '';
      pendingUnary = '';
      expectOperand = false;
    }
  }
  if (expectOperand || pendingOp || pendingOpen) return null;
  const opens = rows.reduce((n, row) => n + row.open.length, 0);
  const closes = rows.reduce((n, row) => n + row.close.length, 0);
  if (opens !== closes) return null;
  return rows;
}

// Identifiers in free text, excluding only generic conditional connectives.
// Hyphenated codes and dotted keys stay whole; extra prose words resolve to
// no traceability and fall back to a purpose comment, so no meaning is
// invented.
function simpleIdentifiers(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/g)) {
    const low = m[0].toLowerCase();
    if (['and', 'or', 'not', 'if', 'then', 'else', 'when', 'where', 'otherwise'].includes(low)) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(m[0]);
  }
  return out;
}

// Split conditional tail text (everything after the opening condition) into
// its first branch, zero or more ELSEIF stages, and an optional final ELSE
// branch. The first ELSE/OTHERWISE marker takes the remainder verbatim.
// Returns null when an ELSEIF segment carries no confident condition/branch
// split, so the caller keeps the single verbatim row instead of inventing
// structure.
function splitConditionTail(rest) {
  const text = String(rest ?? '').trim();
  if (!text) return null;
  const delim = /(?:[;.,]\s*)?\b(else\s+if|elseif|elif|otherwise\s+if|otherwise\s+when|else|otherwise)\b\s*,?\s*/gi;
  const segs = [];
  const kinds = [];
  let last = 0;
  let m;
  while ((m = delim.exec(text)) !== null) {
    segs.push(text.slice(last, m.index).trim());
    const word = m[1].toLowerCase().replace(/\s+/g, ' ');
    const kind = word === 'else' || word === 'otherwise' ? 'else' : 'elseif';
    kinds.push(kind);
    last = m.index + m[0].length;
    if (kind === 'else') break;
  }
  segs.push(text.slice(last).trim());
  const [first, ...tailSegs] = segs;
  const stages = [];
  let elseBranch = '';
  for (let i = 0; i < tailSegs.length; i += 1) {
    if (kinds[i] === 'else') {
      elseBranch = tailSegs[i];
    } else {
      const inner = /^\s*(.+?)(?:\s+then\s+|\s*,\s*)([\s\S]+?)\s*$/i.exec(tailSegs[i]);
      if (!inner || !inner[1].trim() || !inner[2].trim()) return null;
      stages.push({ keyword: 'ELSEIF', condition: inner[1].trim(), branch: inner[2].trim() });
    }
  }
  return { first, stages, elseBranch };
}

// Generic conditional-chain parsing for display only (mirrors the model
// shapes without changing extraction). Splits an IF/WHEN clause into ordered
// stages plus an optional final ELSE branch:
//   { stages: [{ keyword: 'IF'|'ELSEIF', condition, branch }], elseBranch }
// Handles 'then' or comma separators, any number of ELSEIF/ELSE IF stages,
// and ELSE/OTHERWISE closers. A leading ELSE IF (a structured continuation
// step) and a lone ELSE/OTHERWISE are also accepted. Returns null when no
// confident branch structure is evidenced.
function parseRatingConditionChain(text) {
  const full = String(text ?? '').trim();
  if (!full) return null;
  const leadingElseIf = /^\s*(?:else\s+if|elseif|elif|otherwise\s+if)\s+(.+?)(?:\s+then\s+|\s*,\s*)([\s\S]+?)\s*$/i.exec(full);
  if (leadingElseIf && leadingElseIf[1].trim() && leadingElseIf[2].trim()) {
    const tail = splitConditionTail(leadingElseIf[2].trim());
    if (!tail) return null;
    return {
      stages: [{ keyword: 'ELSEIF', condition: leadingElseIf[1].trim(), branch: tail.first }, ...tail.stages],
      elseBranch: tail.elseBranch,
    };
  }
  const ifThen = /^\s*(?:if|when)\s+(.+?)\s+then\s+([\s\S]+?)\s*$/i.exec(full);
  const ifComma = ifThen ? null : /^\s*(?:if|when)\s+(.+?)\s*,\s*([\s\S]+?)\s*$/i.exec(full);
  const head = ifThen ?? ifComma;
  if (head && head[1].trim() && head[2].trim()) {
    const tail = splitConditionTail(head[2].trim());
    if (!tail) return null;
    return {
      stages: [{ keyword: 'IF', condition: head[1].trim(), branch: tail.first }, ...tail.stages],
      elseBranch: tail.elseBranch,
    };
  }
  const elseOnly = /^\s*(?:else|otherwise)\s*,?\s*(.+?)\s*$/i.exec(full);
  if (elseOnly && elseOnly[1].trim()) return { stages: [], elseBranch: elseOnly[1].trim() };
  return null;
}

function extractRatingConditionClause(text) {
  const body = String(text ?? '');
  if (/^\s*(?:if|when|else|otherwise)\b/i.test(body)) return body.trim();
  const m = /\b(?:if|when)\b/i.exec(body);
  return m ? body.slice(m.index).trim() : null;
}

// Assigned value of one conditional branch (`set X to Y`, `X is set to Y`,
// `X = Y`, `X equals Y`); anything else stays verbatim.
function extractBranchValue(branch) {
  const text = String(branch ?? '').trim().replace(/\.\s*$/, '').trim();
  if (!text) return '';
  let m = /\bset\s+[A-Za-z_]\w*\s+to\s+([A-Za-z_]\w*|\d+(?:\.\d+)?)/i.exec(text);
  if (m) return m[1];
  m = /\b[A-Za-z_]\w*\s+is\s+set\s+to\s+([A-Za-z_]\w*|\d+(?:\.\d+)?)/i.exec(text);
  if (m) return m[1];
  m = /\b[A-Za-z_]\w*\s*=\s*([^;]+)/.exec(text);
  if (m && m[1].trim()) return m[1].trim().replace(/\.\s*$/, '').trim();
  m = /\b[A-Za-z_]\w*\s+equals?\s+([A-Za-z_]\w*|\d+(?:\.\d+)?)/i.exec(text);
  if (m) return m[1];
  return text;
}

// Expand one conditional step into IF/ELSEIF/ELSE/ENDIF rows with a separate
// assignment row per stated branch. Conditional keywords render under the
// Instruction column; conditions stay in Operand and branch assignments keep
// the `output <-- value` form. Returns null when no confident branch
// structure is evidenced, leaving the single verbatim row in place.
function expandConditionEntry(entry) {
  const det = entry?.det ?? null;
  const output = String(entry?.output ?? det?.output ?? '');
  const clause = String(det?.expression ?? '').trim()
    || extractRatingConditionClause(entry?.instruction ?? '')
    || '';
  const parsed = clause ? parseRatingConditionChain(clause.replace(/[.;]+$/, '').trim() || clause) : null;
  if (!parsed) return null;
  const stages = (parsed.stages ?? []).filter((s) => String(s?.branch ?? '').trim());
  const elseBranch = String(parsed.elseBranch ?? '').trim();
  if (stages.length === 0 && !elseBranch) return null;
  const rows = [];
  const pushBranchRow = (branch, kind) => {
    const value = extractBranchValue(branch);
    // A branch calculation with several operands splits into continuation
    // rows like any assignment; single values keep the branch assignment
    // row so true/false wording stays explicit.
    if (output && value) {
      const expanded = expandAssignmentSegment(output, value);
      if (expanded && expanded.length > 1) {
        for (const row of expanded) rows.push(row);
        return;
      }
    }
    rows.push({
      instruction: output,
      op: output ? '<--' : '',
      open: '',
      operand: value,
      close: '',
      output,
      kind,
      commentInputs: simpleIdentifiers(value),
    });
  };
  for (const stage of stages) {
    rows.push({
      instruction: stage.keyword,
      op: '',
      open: '',
      operand: String(stage.condition ?? '').trim(),
      close: '',
      output: '',
      kind: stage.keyword === 'ELSEIF' ? 'elseif' : 'if',
      commentInputs: simpleIdentifiers(stage.condition),
    });
    pushBranchRow(stage.branch, stage.keyword === 'ELSEIF' ? 'branch-elseif' : 'branch-true');
  }
  if (elseBranch) {
    rows.push({
      instruction: 'ELSE',
      op: '',
      open: '',
      operand: '',
      close: '',
      output: '',
      kind: 'else',
      commentInputs: [],
    });
    pushBranchRow(elseBranch, 'branch-false');
  }
  rows.push({
    instruction: 'ENDIF',
    op: '',
    open: '',
    operand: '',
    close: '',
    output: '',
    kind: 'endif',
    commentInputs: [],
  });
  return rows;
}

// Expand one `output = rhs` segment into row specs: arithmetic splits into
// continuation rows, phrase operands split around worked amounts, and a
// single value stays one assignment row. Returns null when the right-hand
// side carries operators that cannot be split, so the caller keeps the
// verbatim row instead of inventing boundaries.
function expandAssignmentSegment(output, rhs) {
  const cleanRhs = String(rhs ?? '').trim();
  if (!output || !cleanRhs) return null;
  const expanded = expandArithmetic(output, cleanRhs);
  if (expanded && expanded.length > 1) {
    return expanded.map((row, idx) => ({
      ...row,
      output,
      kind: idx === 0 ? 'arithmetic-first' : 'arithmetic-cont',
      commentInputs: isIdentifierOperand(row.operand) ? [row.operand.replace(/^[+-]/, '')] : [],
      rhs: cleanRhs,
    }));
  }
  if (expanded && expanded.length === 1) {
    return [{
      ...expanded[0],
      output,
      kind: expanded[0].open || expanded[0].close ? 'arithmetic-first' : 'assignment',
      commentInputs: isIdentifierOperand(expanded[0].operand) ? [expanded[0].operand.replace(/^[+-]/, '')] : [],
      rhs: cleanRhs,
    }];
  }
  const phrases = splitPhraseOperands(cleanRhs);
  if (phrases) {
    return phrases.operands.map((operand, idx) => ({
      instruction: idx === 0 ? output : '',
      op: idx === 0 ? '<--' : phrases.ops[idx - 1],
      open: '',
      operand,
      close: '',
      output,
      kind: idx === 0 ? 'arithmetic-first' : 'arithmetic-cont',
      commentInputs: isIdentifierOperand(operand) ? [operand.replace(/^[+-]/, '')] : [],
      rhs: cleanRhs,
    }));
  }
  if (bareExpressionLexemes(cleanRhs).length > 0) return null;
  return [{
    instruction: output,
    op: '<--',
    open: '',
    operand: cleanRhs,
    close: '',
    output,
    kind: 'assignment',
    commentInputs: [],
    rhs: cleanRhs,
  }];
}

// Expand a multi-assignment expression (`a=x*y; b=a-z`) into ordered row
// groups, one group per segment. Returns null when any segment carries
// an `=`-less fragment or unsplittable operators, so the step keeps its
// verbatim row instead of partially inventing structure.
function expandMultiAssignment(det) {
  const raw = String(det?.expression ?? '');
  const parts = splitTopLevel(raw, ';').map((p) => String(p ?? '').trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const parsed = [];
  for (const part of parts) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/.exec(part);
    if (!m || !m[2].trim()) return null;
    parsed.push({ output: m[1], rhs: m[2].trim() });
  }
  const defined = new Set(parsed.map((p) => p.output.toLowerCase()));
  const specs = [];
  for (const p of parsed) {
    const rhs = splitHyphenSubtraction(p.rhs, defined);
    const rows = expandAssignmentSegment(p.output, rhs);
    if (!rows) return null;
    for (const row of rows) specs.push({ ...row, det });
  }
  return specs.length > 0 ? specs : null;
}

// Expand one base rating entry into one or more seven-column row specs.
// Lookups, rounding, single-operand assignments, explicit symbolic rows, and
// anything unparsed stay single; arithmetic with operators and confident
// conditionals expand. Never invents values: unparseable text keeps its
// verbatim single row.
function expandOneRatingEntry(entry) {
  const det = entry?.det ?? null;
  const word = String(det?.operation ?? '').toLowerCase();
  if (det && isLookupOperation(det.operation)) {
    return [{
      instruction: entry.instruction,
      op: entry.operation,
      open: '',
      operand: entry.operand,
      close: '',
      output: entry.output,
      kind: 'lookup',
      commentInputs: det.inputs ?? [],
      det,
    }];
  }
  // Several assignments in one source step (`a=x*y; b=a-z`): each segment
  // expands to its own row group in source order, so every output keeps
  // its Instruction row and every continuation row stays blank.
  if (det && (word === 'expression' || word === 'assignment')) {
    const rawExpression = String(det.expression ?? '');
    if (splitTopLevel(rawExpression, ';').length > 1) {
      const multi = expandMultiAssignment(det);
      if (multi) return multi;
    }
  }
  if (det && (word === 'expression' || word === 'assignment') && entry.operation === '<--') {
    const split = splitAssignment(det);
    const output = split?.output || String(entry.output ?? entry.instruction ?? '');
    const rawRhs = split?.rhs ?? String(entry.operand ?? '');
    const rhs = splitHyphenSubtraction(rawRhs, [output]);
    if (output && rhs.trim()) {
      const expanded = expandArithmetic(output, rhs);
      if (expanded && expanded.length > 1) {
        return expanded.map((row, idx) => ({
          ...row,
          output,
          kind: idx === 0 ? 'arithmetic-first' : 'arithmetic-cont',
          commentInputs: isIdentifierOperand(row.operand) ? [row.operand.replace(/^[+-]/, '')] : [],
          rhs,
        }));
      }
      if (expanded && expanded.length === 1) {
        return [{
          ...expanded[0],
          output,
          kind: expanded[0].open || expanded[0].close ? 'arithmetic-first' : 'assignment',
          commentInputs: isIdentifierOperand(expanded[0].operand) ? [expanded[0].operand.replace(/^[+-]/, '')] : [],
          rhs,
        }];
      }
      const phrases = splitPhraseOperands(rhs);
      if (phrases) {
        return phrases.operands.map((operand, idx) => ({
          instruction: idx === 0 ? output : '',
          op: idx === 0 ? '<--' : phrases.ops[idx - 1],
          open: '',
          operand,
          close: '',
          output,
          kind: idx === 0 ? 'arithmetic-first' : 'arithmetic-cont',
          commentInputs: isIdentifierOperand(operand) ? [operand.replace(/^[+-]/, '')] : [],
          rhs,
        }));
      }
      if (bareExpressionLexemes(rhs).length > 0) {
        return [{
          instruction: String(det.instruction ?? entry.instruction ?? ''),
          op: '',
          open: '',
          operand: '',
          close: '',
          output: '',
          kind: 'unparsed',
          commentInputs: [],
          det: null,
        }];
      }
    }
    return [{
      instruction: entry.instruction,
      op: entry.operation,
      open: '',
      operand: entry.operand,
      close: '',
      output: entry.output,
      kind: 'assignment',
      commentInputs: det.inputs ?? [],
      det,
    }];
  }
  if (det && (word === 'expression' || word === 'assignment') && entry.operation && entry.operation !== '<--') {
    return [{
      instruction: entry.instruction,
      op: entry.operation,
      open: '',
      operand: entry.operand,
      close: '',
      output: entry.output,
      kind: 'arithmetic-bare',
      commentInputs: det.inputs ?? [],
      det,
    }];
  }
  if (entry.operation === '<--' && entry.output && String(entry.operand ?? '').trim()
    && (!det || !String(det.operation ?? '').trim())) {
    const expanded = expandArithmetic(entry.output, entry.operand);
    if (expanded && expanded.length > 1) {
      return expanded.map((row, idx) => ({
        ...row,
        output: entry.output,
        kind: idx === 0 ? 'arithmetic-first' : 'arithmetic-cont',
        commentInputs: isIdentifierOperand(row.operand) ? [row.operand.replace(/^[+-]/, '')] : [],
        rhs: entry.operand,
      }));
    }
    if (expanded && expanded.length === 1) {
      return [{
        ...expanded[0],
        output: entry.output,
        kind: expanded[0].open || expanded[0].close ? 'arithmetic-first' : 'assignment',
        commentInputs: isIdentifierOperand(expanded[0].operand) ? [expanded[0].operand.replace(/^[+-]/, '')] : [],
        rhs: entry.operand,
      }];
    }
  }
  if (det && isConditionOperation(det.operation)) {
    const expanded = expandConditionEntry(entry);
    if (expanded) return expanded.map((row) => ({ ...row, det }));
  }
  if (det && word === 'rounding') {
    return [{
      instruction: entry.instruction,
      op: entry.operation,
      open: '',
      operand: entry.operand,
      close: '',
      output: entry.output,
      kind: 'rounding',
      commentInputs: det.inputs ?? [],
      det,
    }];
  }
  if (entry.operation) {
    return [{
      instruction: entry.instruction,
      op: entry.operation,
      open: '',
      operand: entry.operand,
      close: '',
      output: entry.output,
      kind: 'explicit-op',
      commentInputs: det?.inputs ?? [],
      det,
    }];
  }
  return [{
    instruction: entry.instruction,
    op: '',
    open: '',
    operand: entry.operand,
    close: '',
    output: entry.output,
    kind: 'unparsed',
    commentInputs: [],
    det,
  }];
}

// Op-column marker for steps with no evidenced operation. Shared by the
// rating-routine and legacy layouts so unparsed steps read the same
// everywhere; the source text itself is never altered.
const UNPARSED_OP_MARK = 'REVIEW';

// Unparsed steps are never presented as executable logic: the comment names
// the gap while the source text stays verbatim under Instruction.
function unparsedReviewComment(spec) {
  const orig = spec.origSeq !== '' && spec.origSeq !== null && spec.origSeq !== undefined ? `source step ${spec.origSeq}` : 'source step';
  return `Needs review — no evidenced operation (${orig})`;
}

// Fallback line comment when no dependency is traceable. Every generated
// row keeps a purpose comment; arithmetic rows always name their variable
// or prior step.
function fallbackRatingComment(spec, tables) {
  const orig = spec.origSeq !== '' && spec.origSeq !== null && spec.origSeq !== undefined ? `source step ${spec.origSeq}` : 'source step';
  const output = String(spec.output ?? '').trim();
  const operand = String(spec.operand ?? '').trim();
  switch (spec.kind) {
    case 'lookup': {
      if (!output) return `Table lookup (${orig})`;
      const det = spec.det ?? null;
      const mention = (det?.depends_on ?? []).map((d) => String(d ?? '').trim()).find(Boolean) ?? '';
      const resolved = mention ? resolveTableReference(tables, mention) : null;
      const table = resolved ? String(resolved.name ?? resolved.id ?? '') : mention;
      return table ? `Lookup ${output} from ${table}` : `Lookup ${output} (${orig})`;
    }
    case 'arithmetic-first':
      if (isIdentifierOperand(operand)) return `Start ${output} from ${operand.replace(/^[+-]/, '')} (${orig})`;
      return `Start ${output} from ${operand || 'source expression'} (${orig})`;
    case 'arithmetic-cont':
      if (isIdentifierOperand(operand)) return `Apply ${spec.op} ${operand.replace(/^[+-]/, '')} to continue ${output} from prior step (${orig})`;
      return `Apply ${spec.op} ${operand} to continue ${output} from prior step (${orig})`;
    case 'assignment':
      if (output && operand) return `Assign ${operand} to ${output} (${orig})`;
      if (output) return `Assign ${output} (${orig})`;
      return `Assignment (${orig})`;
    case 'arithmetic-bare': {
      const core = operand || 'source expression';
      if (output) return `Calculate ${core} for ${output} (${orig})`;
      return `Calculate ${core} (${orig}; output not stated — verify)`;
    }
    case 'if':
      return operand ? `IF ${operand} (${orig})` : `Conditional check (${orig})`;
    case 'elseif':
      return operand ? `ELSEIF ${operand} (${orig})` : `Else-if branch (${orig})`;
    case 'else':
      return `Else branch (${orig})`;
    case 'endif':
      return `End of conditional (${orig})`;
    case 'branch-true':
      return output && operand ? `Set ${output} to ${operand} (true branch, ${orig})` : `True branch (${orig})`;
    case 'branch-elseif':
      return output && operand ? `Set ${output} to ${operand} (else-if branch, ${orig})` : `Else-if branch (${orig})`;
    case 'branch-false':
      return output && operand ? `Set ${output} to ${operand} (false branch, ${orig})` : `False branch (${orig})`;
    case 'rounding': {
      const target = output || operand;
      return target ? `Round ${target} (${orig})` : `Rounding (${orig})`;
    }
    case 'explicit-op':
      if (operand) return `Apply ${spec.op} ${operand} (${orig})`;
      return `Operation ${spec.op} (${orig})`;
    default:
      return `Source instruction (${orig})`;
  }
}

function buildRatingStepEntries(r, tables) {
  const steps = r.steps ?? [];
  const detailed = r.steps_detailed ?? [];
  const aligned = detailed.length > 0 && detailed.length === steps.length;
  const entries = [];
  const push = (text, det, index) => {
    const rendered = renderRatingStep(text, det, tables);
    const seq = det?.sequence !== undefined && det?.sequence !== null && String(det.sequence) !== ''
      ? String(det.sequence)
      : parseStepSequence(String(text ?? ''), index);
    entries.push({ seq, ...rendered });
  };
  if (steps.length > 0) {
    steps.forEach((stepText, idx) => push(stepText, aligned ? detailed[idx] : null, idx));
  } else if (detailed.length > 0) {
    detailed.forEach((det, idx) => push(det?.instruction ?? det?.original_text ?? '', det, idx));
  } else {
    const synth = synthesizedExpressionEntry(r);
    if (synth) entries.push(synth);
  }
  return entries;
}

// One worksheet body per rating routine: name in A1 and identity details, then
// the ordered rating steps that communicate the complete routine,
// followed by conditions, unresolved items, and source evidence. No separate
// Inputs, Final calculation, or Dependencies sections: the steps carry the
// assignments, lookups, arithmetic, rounding, and IF/ELSE logic in source
// order, and the validator flags genuine ambiguity in Unresolved items.
// Arithmetic expands to one row per operation with explicit brackets;
// conditionals expand to IF/ELSEIF/ELSE/ENDIF rows (keywords under
// Instruction) with a row per branch assignment.
// A source step expanding to several rows uses hierarchical numbers
// (5.1, 5.2) embedding its source number; single-row steps keep the source
// number, gaps included. Dependency comments therefore reference one
// numbering scheme, and only the definition-start row of an expanded group
// registers as the producer of its output, so "uses X from step N" points
// at the assignment rather than a continuation row. Evidence still reflects
// the source steps.
function ratingRoutineSheetRows(r, routineIssues, ctx = {}) {
  const rows = [];
  pushRoutineHeader(rows, r);
  const routines = ctx.routines ?? [];
  const tables = ctx.tables ?? [];
  const stepEntries = buildRatingStepEntries(r, tables);
  if (stepEntries.length > 0) {
    rows.push(['Steps']);
    rows.push([...RATING_STEPS_HEADER]);
    const expanded = [];
    for (const e of stepEntries) {
      const specs = expandOneRatingEntry(e);
      specs.forEach((spec, groupIndex) => {
        expanded.push({ ...spec, origSeq: e.seq ?? '', groupSize: specs.length, groupIndex });
      });
    }
    expanded.forEach((spec, idx) => {
      const base = spec.origSeq !== '' && spec.origSeq !== null && spec.origSeq !== undefined
        ? String(spec.origSeq)
        : String(idx + 1);
      spec.newSeq = spec.groupSize > 1 ? `${base}.${spec.groupIndex + 1}` : base;
    });
    const tableTerms = tableReferenceTerms(tables);
    const priorOutputs = new Map();
    for (const spec of expanded) {
      const needsReview = spec.kind === 'unparsed';
      const traceDet = (spec.kind === 'lookup' || spec.kind === 'rounding')
        ? (spec.det ?? { inputs: spec.commentInputs ?? [] })
        : { inputs: spec.commentInputs ?? [], output: spec.output };
      const traced = stepComment(
        { det: traceDet, output: spec.output },
        r, routines, tables, tableTerms, priorOutputs, { lookupPrefix: false }
      );
      const comment = needsReview ? unparsedReviewComment(spec) : (traced || fallbackRatingComment(spec, tables));
      const op = needsReview ? UNPARSED_OP_MARK : spec.op;
      rows.push([spec.newSeq, spec.instruction, op, spec.open, spec.operand, spec.close, comment]);
      if (spec.output && spec.kind !== 'arithmetic-cont') {
        priorOutputs.set(
          normalizeVariableKey(spec.output),
          { seq: spec.newSeq ?? '', table: priorTableForStep(spec.det ?? null, tables) }
        );
      }
    }
  }
  const condEntries = buildCondEntries(r);
  pushConditionsSection(rows, condEntries);
  pushUnresolvedItems(rows, routineIssues);
  pushRoutineEvidence(rows, r, stepEntries, condEntries, []);
  return rows;
}

// Rating routines (anything with steps or a stated expression, other than
// condition routines) render the simplified stepwise sheet. Condition
// routines and routines without steps or an expression keep the legacy
// layout, so underwriting rules stay out of scope and no content is hidden.
function isRatingRoutineSheet(r) {
  if (String(r?.kind ?? '') === 'condition') return false;
  const hasSteps = (r?.steps ?? []).length > 0 || (r?.steps_detailed ?? []).length > 0;
  if (hasSteps) return true;
  return String(r?.expression_text ?? '').trim() !== '';
}

function routineSheetRows(r, routineIssues, ctx = {}) {
  if (isRatingRoutineSheet(r)) return ratingRoutineSheetRows(r, routineIssues, ctx);
  return legacyRoutineSheetRows(r, routineIssues, ctx);
}

// One worksheet body per routine (legacy layout): name in A1 and identity
// details, then the rating execution flow in order — Inputs (required
// variables with sources), ordered Steps (lookups with keys and returned
// variables, then intermediate calculations), and the Final calculation with
// its output — followed by the clearly labelled Conditions, Dependencies,
// Unresolved items, and Source evidence sections. Only available content is
// included; missing fields stay blank and empty sections are omitted.
function legacyRoutineSheetRows(r, routineIssues, ctx = {}) {
  const rows = [];
  pushRoutineHeader(rows, r);

  const routines = ctx.routines ?? [];
  const tables = ctx.tables ?? [];
  const inputSources = resolveInputSources(r, routines, tables);
  if (inputSources.length > 0) {
    rows.push(['Inputs']);
    rows.push(['Input', 'Source', 'Lookup keys']);
    for (const e of inputSources) {
      rows.push([e.input, e.source, e.keys]);
    }
  }

  const steps = r.steps ?? [];
  const detailed = r.steps_detailed ?? [];
  const aligned = detailed.length > 0 && detailed.length === steps.length;
  const stepEntries = [];
  if (steps.length > 0) {
    steps.forEach((stepText, idx) => {
      const text = String(stepText ?? '');
      const det = aligned ? detailed[idx] : null;
      const seq = det?.sequence !== undefined && det?.sequence !== null && String(det.sequence) !== ''
        ? String(det.sequence)
        : parseStepSequence(text, idx);
      stepEntries.push({
        seq,
        instruction: text,
        operation: String(det?.operation ?? ''),
        expression: String(det?.expression ?? ''),
        operand: String(det?.operand ?? ''),
        keys: listJoin(det?.inputs),
        output: String(det?.output ?? ''),
        dependsOn: listJoin(det?.depends_on),
        det,
      });
    });
  } else if (detailed.length > 0) {
    detailed.forEach((det) => {
      stepEntries.push({
        seq: String(det?.sequence ?? ''),
        instruction: String(det?.instruction ?? det?.original_text ?? ''),
        operation: String(det?.operation ?? ''),
        expression: String(det?.expression ?? ''),
        operand: String(det?.operand ?? ''),
        keys: listJoin(det?.inputs),
        output: String(det?.output ?? ''),
        dependsOn: listJoin(det?.depends_on),
        det,
      });
    });
  }
  if (stepEntries.length > 0) {
    rows.push(['Steps']);
    rows.push(['Step #', 'Instruction', 'Operation', 'Operand', 'Comment']);
    const tableTerms = tableReferenceTerms(tables);
    const priorOutputs = new Map();
    for (const e of stepEntries) {
      const needsReview = !String(e.operation ?? '').trim() && String(e.instruction ?? '').trim() !== '';
      const traced = stepComment(e, r, routines, tables, tableTerms, priorOutputs);
      const comment = traced || (needsReview ? 'Needs review — no evidenced operation' : '');
      rows.push([e.seq, e.instruction, needsReview ? UNPARSED_OP_MARK : e.operation, stepOperandCell(e), comment]);
      if (e.output) priorOutputs.set(normalizeVariableKey(e.output), { seq: e.seq ?? '', table: priorTableForStep(e.det, tables) });
    }
  }

  // Final calculation closes the execution flow without mapping an
  // intermediate formula to the final output: the routine's stated formula
  // when it matches the terminal stage, else the terminal step producing a
  // routine output. Same-variable rounding is post-processing and stays
  // separate in Steps; rounding that produces a new variable is a genuine
  // stage and may close the flow. Nothing is composed or reinterpreted.
  const finalExpression = String(r.expression_text ?? '');
  const finalEntry = selectFinalCalculation(r, stepEntries, finalExpression);
  if (finalEntry) {
    rows.push(['Final calculation']);
    rows.push(['Calculation', 'Output']);
    rows.push([finalEntry.calculation, finalEntry.output]);
  }

  const condEntries = buildCondEntries(r);
  pushConditionsSection(rows, condEntries);

  const dependsOn = r.depends_on ?? [];
  const depDetailed = r.dependencies ?? [];
  const detailedTargets = new Set(depDetailed.map((d) => String(d?.target ?? '').trim().toLowerCase()).filter(Boolean));
  const depEntries = [];
  for (const dep of depDetailed) {
    const target = String(dep?.target ?? '');
    if (!target.trim() && !String(dep?.source ?? '').trim()) continue;
    depEntries.push({
      target,
      type: String(dep?.relationship_type ?? ''),
      explicit: String(dep?.explicit ?? 'explicit'),
      det: dep,
    });
  }
  for (const target of dependsOn) {
    const text = String(target ?? '');
    if (!text.trim()) continue;
    if (detailedTargets.has(text.trim().toLowerCase())) continue;
    depEntries.push({ target: text, type: '', explicit: 'explicit', det: null });
  }
  const stepDerived = collectStepDerived(stepEntries, r, routines, tables);
  const explicitTableObjects = new Set();
  const explicitRoutineObjects = new Set();
  const explicitUnresolved = new Set();
  for (const e of depEntries) {
    const table = resolveTableReference(tables, e.target);
    if (table) {
      explicitTableObjects.add(table);
      continue;
    }
    const matched = findRoutinesByTarget(routines, e.target);
    if (matched.length > 0) {
      for (const m of matched) explicitRoutineObjects.add(m);
      continue;
    }
    explicitUnresolved.add(String(e.target ?? '').toLowerCase());
  }
  const variableForExplicit = (target) => {
    const vars = new Map();
    const table = resolveTableReference(tables, target);
    if (table) {
      const tableName = String(table.name ?? table.id ?? '').toLowerCase();
      for (const s of inputSources) {
        if (String(s.source ?? '').toLowerCase() === tableName) {
          const fmt = s.keys ? `${s.input} (keys: ${s.keys})` : s.input;
          const vk = normalizeVariableKey(s.input);
          if (!vars.has(vk)) vars.set(vk, fmt);
        }
      }
      for (const derived of stepDerived.values()) {
        if (derived.type !== 'table') continue;
        const dt = resolveTableReference(tables, derived.target);
        if (dt !== table) continue;
        for (const [k, v] of derived.vars) {
          if (!vars.has(k)) vars.set(k, v);
        }
      }
      return [...vars.values()].join('; ');
    }
    const matched = findRoutinesByTarget(routines, target);
    if (matched.length > 0) {
      const outputTerms = new Set();
      for (const m of matched) {
        for (const o of m?.outputs ?? []) {
          const t = normalizeVariableKey(o);
          if (t) outputTerms.add(t);
        }
      }
      for (const raw of r.inputs ?? []) {
        const v = String(raw ?? '').trim();
        const vk = normalizeVariableKey(v);
        if (v && vk && outputTerms.has(vk) && !vars.has(vk)) vars.set(vk, v);
      }
      for (const derived of stepDerived.values()) {
        if (derived.type !== 'routine') continue;
        const dm = findRoutinesByTarget(routines, derived.target);
        if (!dm.some((m) => matched.includes(m))) continue;
        for (const [k, v] of derived.vars) {
          if (!vars.has(k)) vars.set(k, v);
        }
      }
      return [...vars.values()].join('; ');
    }
    const derived = stepDerived.get(String(target ?? '').toLowerCase());
    if (derived) return [...derived.vars.values()].join('; ');
    return '';
  };
  for (const e of depEntries) {
    if (!e.type) {
      if (resolveTableReference(tables, e.target)) e.type = 'table';
      else if (findRoutinesByTarget(routines, e.target).length > 0) e.type = 'routine';
    }
    e.variable = variableForExplicit(e.target);
  }
  for (const derived of stepDerived.values()) {
    if (derived.type === 'table') {
      const table = resolveTableReference(tables, derived.target);
      if (table && explicitTableObjects.has(table)) continue;
    } else if (derived.type === 'routine') {
      const matched = findRoutinesByTarget(routines, derived.target);
      if (matched.some((m) => explicitRoutineObjects.has(m))) continue;
    } else if (explicitUnresolved.has(String(derived.target ?? '').toLowerCase())) {
      continue;
    }
    const key = String(derived.target ?? '').toLowerCase();
    if (depEntries.some((e) => String(e.target ?? '').toLowerCase() === key)) continue;
    depEntries.push({
      target: derived.target,
      type: derived.type,
      explicit: 'inferred',
      variable: [...derived.vars.values()].join('; '),
      det: null,
    });
  }
  if (depEntries.length > 0) {
    rows.push(['Dependencies']);
    rows.push(['Target', 'Type', 'Explicit/Inferred', 'Variable / Keys']);
    for (const e of depEntries) {
      rows.push([e.target, e.type, e.explicit, e.variable ?? '']);
    }
  }

  pushUnresolvedItems(rows, routineIssues);
  pushRoutineEvidence(rows, r, stepEntries, condEntries, depEntries);

  return rows;
}

function jobRows(job, source) {
  const doc = job.document ?? {};
  const tables = job.tables ?? [];
  const routines = job.routines ?? [];
  const issues = job.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const tableSheetNameList = tableSheetNames(tables);
  const routineSheetNameList = routineSheetNames(routines, tableSheetNameList);
  const cover = [
    ['Field', 'Value'],
    ['RateCraft export (hackathon demo)', ''],
    ['Document', doc.filename ?? ''],
    ['Pages', String(doc.page_count ?? '')],
    ['Extraction source', source],
    ['Tables', String(tables.length)],
    ['Routines', String(routines.length)],
    ['Errors', String(errors)],
    ['Warnings', String(warnings)],
  ];
  const coverLinks = [];
  cover.push(['Included Rating Tables']);
  tables.forEach((t, idx) => {
    cover.push([t.id ?? '', t.name ?? '']);
    coverLinks.push({ r: cover.length - 1, c: 1, location: sheetLocation(tableSheetNameList[idx]) });
  });
  cover.push(['Included Rating Routines']);
  routines.forEach((r, idx) => {
    cover.push([r.id ?? '', r.name ?? '']);
    coverLinks.push({ r: cover.length - 1, c: 1, location: sheetLocation(routineSheetNameList[idx]) });
  });

  const tableSummary = [['Table ID', 'Title', 'Purpose', 'Applicability', 'Effective period', 'Source pages', 'Source location', 'Evidence text', 'Footnotes', 'Notes', 'Continuation', 'Row count', 'Column count', 'Review status']];
  const tableSummaryLinks = [];
  tables.forEach((t, idx) => {
    tableSummary.push([
      t.id ?? '',
      t.name ?? '',
      t.purpose ?? '',
      t.applicability ?? '',
      t.effective_period ?? '',
      pagesLabel(t.source_pages),
      t.source_location ?? '',
      t.evidence_text ?? '',
      listJoin(t.footnotes),
      t.notes ?? '',
      continuationText(t.continuation),
      String((t.rows ?? []).length),
      String((t.headers ?? []).length),
      t.review_status ?? '',
    ]);
    tableSummaryLinks.push({ r: tableSummary.length - 1, c: 1, location: sheetLocation(tableSheetNameList[idx]) });
  });

  const tableColumns = [['Table ID', 'Table title', 'Column #', 'Original label', 'Display label', 'Inferred type', 'Role', 'Units', 'Evidence']];
  for (const t of tables) {
    const cols = (t.columns && t.columns.length > 0)
      ? t.columns
      : (t.headers ?? []).map((h, i) => ({ label: String(h ?? ''), original_label: String(h ?? ''), order: i + 1 }));
    cols.forEach((col, idx) => {
      tableColumns.push([
        t.id ?? '',
        t.name ?? '',
        String(col?.order ?? idx + 1),
        String(col?.original_label ?? col?.label ?? ''),
        String(col?.display_label ?? col?.label ?? ''),
        String(col?.data_type ?? ''),
        String(col?.role ?? ''),
        String(col?.units ?? ''),
        String(col?.evidence ?? ''),
      ]);
    });
  }

  const tableSheets = tables.map((t, idx) => {
    const headers = (t.headers ?? []).map((h) => String(h ?? ''));
    const rows = (t.rows ?? []).map((r) => (r ?? []).map((c) => String(c ?? '')));
    const colCount = Math.max(headers.length, 0, ...rows.map((r) => r.length));
    const sheetRows = [[String(t.name ?? '')]];
    if (headers.length > 0) {
      sheetRows.push(padRow(headers, colCount));
    }
    for (const row of rows) {
      sheetRows.push(padRow(row, colCount));
    }
    return { name: tableSheetNameList[idx], rows: sheetRows, colCount: Math.max(colCount, 1) };
  });

  const routineSummary = [['Routine ID', 'Name', 'Kind', 'Purpose', 'Applicability', 'Execution context', 'Inputs', 'Outputs', 'Expression', 'Source pages', 'Source location', 'Evidence text', 'Notes', 'Review status']];
  const routineSummaryLinks = [];
  routines.forEach((r, idx) => {
    const displayInputs = (r.inputs ?? []).map(cleanStepInputValue).filter((v) => v && String(v).trim());
    const displayOutputs = (r.outputs ?? []).map(cleanStepOutputValue).filter((v) => v && String(v).trim());
    routineSummary.push([
      r.id ?? '',
      r.name ?? '',
      r.kind ?? '',
      r.purpose ?? '',
      r.applicability ?? '',
      r.execution_context ?? '',
      listJoin(displayInputs),
      listJoin(displayOutputs),
      r.expression_text ?? '',
      pagesLabel(r.source_pages),
      r.source_location ?? '',
      r.evidence_text ?? '',
      r.notes ?? '',
      r.review_status ?? '',
    ]);
    routineSummaryLinks.push({ r: routineSummary.length - 1, c: 1, location: sheetLocation(routineSheetNameList[idx]) });
  });

  const routineSheets = routines.map((r, idx) => {
    const routineIssues = issues.filter(
      (i) => i.target_type === 'routine' && String(i.target_id ?? '') === String(r.id ?? '')
    );
    const sheetRows = routineSheetRows(r, routineIssues, { routines, tables });
    const colCount = Math.max(1, ...sheetRows.map((row) => row.length));
    // Title uses a larger bold style; every present section heading uses the
    // shared heading style (bold + subtle fill); each table header row stays
    // bold. Data rows keep normal weight. Only existing sections are styled.
    const sectionHeadingRows = [];
    const headerRows = [];
    sheetRows.forEach((row, rowIdx) => {
      if (rowIdx === 0 || row.length !== 1) return;
      const label = row[0];
      if (!ROUTINE_SECTION_HEADERS.has(label)) return;
      sectionHeadingRows.push(rowIdx);
      const expected = ROUTINE_SECTION_HEADERS.get(label);
      if (expected && rowIdx + 1 < sheetRows.length) {
        const next = sheetRows[rowIdx + 1];
        const matches = (exp) => next.length === exp.length && next.every((v, i) => v === exp[i]);
        if (matches(expected) || (label === 'Steps' && matches(LEGACY_STEPS_HEADER))) {
          headerRows.push(rowIdx + 1);
        }
      }
    });
    return {
      name: routineSheetNameList[idx],
      rows: sheetRows,
      colCount,
      styleSpec: { boldRows: headerRows, sectionRows: sectionHeadingRows, titleStyle: '3' },
    };
  });

  const issuesRows = [['Issue ID', 'Severity', 'Target type', 'Target ID', 'Message', 'Source pages']];
  for (const issue of issues) {
    issuesRows.push([issue.id ?? '', issue.severity ?? '', issue.target_type ?? '', issue.target_id ?? '', issue.message ?? '', pagesLabel(issue.source_pages)]);
  }

  return { cover, coverLinks, tableSummary, tableSummaryLinks, tableColumns, tableSheets, routineSummary, routineSummaryLinks, routineSheets, issues: issuesRows };
}

/**
 * Build a deterministic .xlsx buffer from a validated job.
 * @param {object} job normalized job with issues
 * @param {{ source?: string, compress?: boolean }} options
 */
export function buildWorkbookXlsx(job, { source = 'recorded', compress = true } = {}) {
  const shared = new SharedStrings();
  const { cover, coverLinks, tableSummary, tableSummaryLinks, tableColumns, tableSheets, routineSummary, routineSummaryLinks, routineSheets, issues } = jobRows(job, source);
  const sheetNames = [
    'Cover',
    'Table Summary',
    'Routine Summary',
    'Table Columns',
    ...tableSheets.map((s) => s.name),
    ...routineSheets.map((s) => s.name),
    'Issues',
  ];
  // Register shared strings in sheet order for deterministic indexes.
  const sheets = [
    sheetXml(cover, shared, [32, 60], coverLinks),
    sheetXml(tableSummary, shared, [10, 34, 24, 24, 18, 12, 18, 60, 30, 30, 24, 10, 12, 14], tableSummaryLinks),
    sheetXml(routineSummary, shared, [11, 34, 18, 24, 24, 20, 30, 30, 40, 12, 18, 60, 30, 14], routineSummaryLinks),
    sheetXml(tableColumns, shared, [10, 34, 10, 28, 28, 16, 16, 16, 40]),
    ...tableSheets.map((s) => sheetXml(s.rows, shared, Array(Math.max(s.colCount, 1)).fill(28))),
    ...routineSheets.map((s) => sheetXml(s.rows, shared, Array(Math.max(s.colCount, 1)).fill(28), [], s.styleSpec ?? s.boldRows ?? [])),
    sheetXml(issues, shared, [10, 10, 12, 11, 80, 12]),
  ];

  const workbook = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets>',
    ...sheetNames.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`),
    '</sheets></workbook>',
  ].join('');

  const workbookRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...sheetNames.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    `<Relationship Id="rId${sheetNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId${sheetNames.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    '</Relationships>',
  ].join('');

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheetNames.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
    '</Types>',
  ].join('');

  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>',
  ].join('');

  const styles = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><b/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><u/></font><font><sz val="14"/><b/><name val="Calibri"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills>',
    '<borders count="1"><border/></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0"/></cellXfs>',
    '</styleSheet>',
  ].join('');

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(shared.xml(), 'utf8') },
    ...sheets.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml, 'utf8') })),
  ];
  return buildZip(entries, { compress });
}
