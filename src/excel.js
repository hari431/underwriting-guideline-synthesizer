// Deterministic .xlsx workbook builder (zero dependencies).
// Sheets: Cover, Tables, Routines, Issues. Every data row carries source pages.
// Fixed ZIP timestamps keep builds byte-deterministic for the same input.
import { deflateRawSync } from 'node:zlib';

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

function sheetXml(rows, shared, widths = []) {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const lastRef = `${colName(colCount - 1)}${Math.max(rows.length, 1)}`;
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
      const style = r === 0 ? ' s="1"' : '';
      parts.push(`<c r="${ref}" t="s"${style}><v>${shared.idOf(value)}</v></c>`);
    });
    parts.push('</row>');
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

// ---------- workbook assembly ----------

const SHEET_NAMES = ['Cover', 'Tables', 'Routines', 'Issues'];

function jobRows(job, source) {
  const doc = job.document ?? {};
  const errors = job.issues.filter((i) => i.severity === 'error').length;
  const warnings = job.issues.filter((i) => i.severity === 'warning').length;
  const cover = [
    ['Field', 'Value'],
    ['UnderwriteIQ export (hackathon demo)', ''],
    ['Document', doc.filename ?? ''],
    ['Pages', String(doc.page_count ?? '')],
    ['Extraction source', source],
    ['Tables', String(job.tables.length)],
    ['Routines', String(job.routines.length)],
    ['Errors', String(errors)],
    ['Warnings', String(warnings)],
  ];

  const tables = [['Table ID', 'Table name', 'Source pages', 'Evidence text', 'Headers', 'Row values']];
  for (const t of job.tables) {
    const pages = t.source_pages.join(', ');
    const headers = t.headers.join(' | ');
    if (t.rows.length === 0) {
      tables.push([t.id, t.name, pages, t.evidence_text, headers, '']);
    } else {
      for (const row of t.rows) {
        tables.push([t.id, t.name, pages, t.evidence_text, headers, row.join(' | ')]);
      }
    }
  }

  const routines = [['Routine ID', 'Name', 'Kind', 'Source pages', 'Evidence text', 'Expression', 'Conditions', 'Steps', 'Depends on', 'Notes']];
  for (const r of job.routines) {
    routines.push([
      r.id, r.name, r.kind, r.source_pages.join(', '), r.evidence_text,
      r.expression_text, r.conditions.join(' | '), r.steps.join(' | '),
      r.depends_on.join(' | '), r.notes,
    ]);
  }

  const issues = [['Issue ID', 'Severity', 'Target type', 'Target ID', 'Message', 'Source pages']];
  for (const issue of job.issues) {
    issues.push([issue.id, issue.severity, issue.target_type, issue.target_id, issue.message, issue.source_pages.join(', ')]);
  }

  return { cover, tables, routines, issues };
}

/**
 * Build a deterministic .xlsx buffer from a validated job.
 * @param {object} job normalized job with issues
 * @param {{ source?: string, compress?: boolean }} options
 */
export function buildWorkbookXlsx(job, { source = 'recorded', compress = true } = {}) {
  const shared = new SharedStrings();
  const { cover, tables, routines, issues } = jobRows(job, source);
  // Register shared strings in sheet order for deterministic indexes.
  const sheets = [
    sheetXml(cover, shared, [32, 60]),
    sheetXml(tables, shared, [10, 34, 12, 60, 30, 50]),
    sheetXml(routines, shared, [11, 34, 18, 12, 60, 40, 40, 50, 30, 30]),
    sheetXml(issues, shared, [10, 10, 12, 11, 80, 12]),
  ];

  const workbook = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets>',
    ...SHEET_NAMES.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`),
    '</sheets></workbook>',
  ].join('');

  const workbookRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...SHEET_NAMES.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    `<Relationship Id="rId${SHEET_NAMES.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId${SHEET_NAMES.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    '</Relationships>',
  ].join('');

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...SHEET_NAMES.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
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
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><b/><name val="Calibri"/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border/></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>',
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
