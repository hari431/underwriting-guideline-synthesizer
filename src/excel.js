// Deterministic .xlsx workbook builder (zero dependencies).
// Sheets: Cover, Table Summary, Routine Summary, Table Columns, one sheet
// per rating table, one sheet per routine, Issues.
// Rating-table sheets hold only the title, headers, and factor rows.
// Routine sheets hold the name, details, ordered steps, conditions,
// dependencies, unresolved items, and source evidence.
// Cover and the summaries link each asset name to its detail worksheet.
// Fixed ZIP timestamps keep builds byte-deterministic.
import { deflateRawSync } from 'node:zlib';
import { resolveTableReference, tableReferenceTerms } from './models.js';

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

function sheetXml(rows, shared, widths = [], links = [], boldRows = []) {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const lastRef = `${colName(colCount - 1)}${Math.max(rows.length, 1)}`;
  const linkByCell = new Map(links.map((l) => [`${l.r},${l.c}`, l.location]));
  const boldRowSet = new Set(boldRows);
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
      const style = link ? ' s="2"' : (r === 0 || boldRowSet.has(r) ? ' s="1"' : '');
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
  const m = /^\s*(?:step\s*)?(\d+)\s*[:.\)\-]/i.exec(String(text ?? ''));
  if (m) return m[1];
  return String(fallbackIndex + 1);
}

function isLookupOperation(op) {
  const o = String(op ?? '').toLowerCase();
  return o.includes('lookup') || o.includes('look-up');
}

// Routines (other than the current one) listing a variable among outputs.
function producingRoutines(routines, routineId, variable) {
  const key = String(variable ?? '').trim().toLowerCase();
  if (!key) return [];
  return (Array.isArray(routines) ? routines : []).filter((s) =>
    String(s?.id ?? '') !== String(routineId ?? '')
    && (s?.outputs ?? []).some((o) => String(o ?? '').trim().toLowerCase() === key));
}

// Line Comment for one step: the lookup's table and result plus any
// routine-to-routine input sources. Returns '' when nothing is traceable;
// unknown references stay silent here because the validator flags them.
function stepLineComment(step, routine, routines, tables, tableTerms, priorOutputs) {
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
      parts.push(`lookup ${resolved.map((t) => String(t.name ?? t.id ?? '')).join('; ')}${outputBit}`);
    } else if (mentions.length > 0) {
      parts.push(`lookup "${mentions[0]}"${outputBit}`);
      flags.push('table unresolved — verify');
    } else if (output) {
      parts.push(`lookup${outputBit}`);
    }
  }
  const routineTerms = new Set(
    [...(routine.inputs ?? []), ...(routine.outputs ?? [])]
      .map((s) => String(s ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const definedLocally = new Set(priorOutputs);
  if (output) definedLocally.add(output.toLowerCase());
  for (const raw of det?.inputs ?? []) {
    const variable = String(raw ?? '').trim();
    if (!variable || definedLocally.has(variable.toLowerCase())) continue;
    const producers = producingRoutines(routines, routine?.id, variable);
    if (producers.length === 1) {
      parts.push(`uses ${variable} from ${producers[0].name ?? producers[0].id ?? ''}`);
    } else if (producers.length > 1) {
      parts.push(`uses ${variable} from multiple routines (${producers.map((s) => String(s?.name ?? s?.id ?? '')).join('; ')}) — verify`);
    } else if (routineTerms.has(variable.toLowerCase()) || tableTerms.has(variable.toLowerCase())) {
      continue;
    }
  }
  return [...parts, ...flags].join('; ');
}

function stepOperandCell(step) {
  if (isLookupOperation(step.det?.operation)) return step.keys || '';
  return step.expression || step.operand || step.keys || '';
}

// One worksheet body per routine: name in A1, available details, ordered
// step table, then clearly labelled Conditions, Dependencies, Unresolved
// items, and Source evidence sections. Only available content is included;
// missing fields stay blank and empty sections are omitted.
function routineSheetRows(r, routineIssues, ctx = {}) {
  const rows = [[String(r.name ?? '')]];
  const detail = (label, value) => {
    if (value !== '' && value !== null && value !== undefined) rows.push([label, String(value)]);
  };
  detail('Kind', String(r.kind ?? ''));
  detail('Purpose', String(r.purpose ?? ''));
  detail('Applicability', String(r.applicability ?? ''));
  detail('Execution context', String(r.execution_context ?? ''));
  detail('Expression', String(r.expression_text ?? ''));
  const inputs = listJoin(r.inputs);
  if (inputs) rows.push(['Inputs', inputs]);
  const outputs = listJoin(r.outputs);
  if (outputs) rows.push(['Outputs', outputs]);
  detail('Notes', String(r.notes ?? ''));

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
    rows.push(['Step #', 'Instruction', 'Op', 'Operand', 'Line Comment']);
    const routines = ctx.routines ?? [];
    const tables = ctx.tables ?? [];
    const tableTerms = tableReferenceTerms(tables);
    const priorOutputs = new Set();
    for (const e of stepEntries) {
      rows.push([e.seq, e.instruction, e.operation, stepOperandCell(e), stepLineComment(e, r, routines, tables, tableTerms, priorOutputs)]);
      if (e.output) priorOutputs.add(e.output.toLowerCase());
    }
  }

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
  if (condEntries.length > 0) {
    rows.push(['Conditions']);
    rows.push(['#', 'Condition', 'True branch', 'False branch', 'Referral code']);
    for (const e of condEntries) {
      rows.push([e.num, e.condition, e.trueBranch, e.falseBranch, e.referral]);
    }
  }

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
  if (depEntries.length > 0) {
    rows.push(['Dependencies']);
    rows.push(['Target', 'Type', 'Explicit/Inferred']);
    for (const e of depEntries) {
      rows.push([e.target, e.type, e.explicit]);
    }
  }

  if ((routineIssues ?? []).length > 0) {
    rows.push(['Unresolved items']);
    rows.push(['Issue ID', 'Severity', 'Message']);
    for (const issue of routineIssues) {
      rows.push([String(issue.id ?? ''), String(issue.severity ?? ''), String(issue.message ?? '')]);
    }
  }

  const evidenceRows = [];
  const pages = pagesLabel(r.source_pages);
  if (pages) evidenceRows.push(['Source pages', pages]);
  if (String(r.source_location ?? '')) evidenceRows.push(['Source location', String(r.source_location)]);
  if (String(r.evidence_text ?? '')) evidenceRows.push(['Evidence', String(r.evidence_text)]);
  stepEntries.forEach((e) => {
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
  condEntries.forEach((e) => {
    const det = e.det;
    if (!det) return;
    const sp = det.source_pages?.length ? pagesLabel(det.source_pages) : '';
    const ev = String(det.evidence ?? '');
    const status = String(det.interpretation_status ?? '');
    if (sp) evidenceRows.push([`Condition ${e.num} pages`, sp]);
    if (ev) evidenceRows.push([`Condition ${e.num} evidence`, ev]);
    if (status) evidenceRows.push([`Condition ${e.num} status`, status]);
  });
  depEntries.forEach((e) => {
    const det = e.det;
    if (!det) return;
    const sp = det.source_pages?.length ? pagesLabel(det.source_pages) : '';
    const ev = String(det.evidence ?? '');
    if (sp) evidenceRows.push([`Dependency ${e.target} pages`, sp]);
    if (ev) evidenceRows.push([`Dependency ${e.target} evidence`, ev]);
  });
  if (evidenceRows.length > 0) {
    rows.push(['Source evidence']);
    for (const row of evidenceRows) rows.push(row);
  }

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
    ['UnderwriteIQ export (hackathon demo)', ''],
    ['Document', doc.filename ?? ''],
    ['Pages', String(doc.page_count ?? '')],
    ['Extraction source', source],
    ['Tables', String(tables.length)],
    ['Routines', String(routines.length)],
    ['Errors', String(errors)],
    ['Warnings', String(warnings)],
  ];
  const coverLinks = [];
  cover.push(['Included Rate Tables']);
  tables.forEach((t, idx) => {
    cover.push([t.id ?? '', t.name ?? '']);
    coverLinks.push({ r: cover.length - 1, c: 1, location: sheetLocation(tableSheetNameList[idx]) });
  });
  cover.push(['Included Rate Routines']);
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
    routineSummary.push([
      r.id ?? '',
      r.name ?? '',
      r.kind ?? '',
      r.purpose ?? '',
      r.applicability ?? '',
      r.execution_context ?? '',
      listJoin(r.inputs),
      listJoin(r.outputs),
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
    // Bold only the Steps heading and its column headers; step contents,
    // overview, and evidence keep their existing styling.
    const boldRows = [];
    const stepsLabel = sheetRows.findIndex((row) => row.length === 1 && row[0] === 'Steps');
    if (stepsLabel >= 0) boldRows.push(stepsLabel, stepsLabel + 1);
    return { name: routineSheetNameList[idx], rows: sheetRows, colCount, boldRows };
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
    ...routineSheets.map((s) => sheetXml(s.rows, shared, Array(Math.max(s.colCount, 1)).fill(28), [], s.boldRows ?? [])),
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
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><b/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><u/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border/></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/></cellXfs>',
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
