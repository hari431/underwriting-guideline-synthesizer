// End-to-end pipeline: ingest PDF -> extract -> normalize -> separate -> validate.
import { extractPdfText } from './pdf-extract.js';
import { ModelDisabledError, runExtraction } from './extract.js';
import { createDocument, createJob, createValidationIssue, generateParameterizedLookups, generateWorkedExampleLookups, inferTableColumns, normalizeJob, tableContinuationBase, tableHasContinuationCue, tableHeaderKey, tableLogicalGroupKey, tablePagesAdjacent } from './models.js';
import { expandRecordTables, splitMergedTables } from './table-split.js';
import { groupStepRoutines } from './routine-group.js';
import { validateJob } from './validate.js';

/**
 * Process one PDF buffer into a validated job.
 * @param {Buffer} pdfBuffer
 * @param {{ filename?: string, recordingPath?: string|null, modelOptions?: object }} options
 * @returns {Promise<{ job: object, source: string, extraction: { tables: array, routines: array } }>}
 * The returned extraction is the raw pre-normalization extractor output,
 * passed through untouched so callers can persist it for auditability.
 */
export async function processPdf(
  pdfBuffer,
  { filename = 'upload.pdf', recordingPath = null, modelOptions = {} } = {}
) {
  const { pageCount, pages } = extractPdfText(pdfBuffer);
  let tables;
  let routines;
  try {
    ({ tables, routines } = await runExtraction(pages, { recordingPath, modelOptions }));
  } catch (err) {
    if (err instanceof ModelDisabledError) err.details = { filename, pageCount };
    throw err;
  }
  const job = buildJobFromExtraction(
    { tables, routines },
    { filename, pageCount }
  );
  return { job, source: recordingPath ? 'recorded' : 'live', extraction: { tables, routines } };
}

/**
 * Deterministic post-extraction stages shared by the live pipeline and the
 * offline fixture loader: normalize -> separate -> expand -> group ->
 * validate. Pure local computation; never calls the model/API.
 */
export function buildJobFromExtraction(
  { tables = [], routines = [] } = {},
  { filename = 'upload.pdf', pageCount = 0 } = {}
) {
  let job = normalizeJob(
    createJob({
      document: createDocument({ filename, pageCount }),
      tables,
      routines,
      status: 'review',
    })
  );
  // Deterministic separation of side-by-side grids the extractor merged into
  // one table. Strong structural evidence only; ambiguous layouts pass through
  // untouched and the validator flags them for review instead.
  const { tables: separated, splits } = splitMergedTables(job.tables);
  // Deterministic expansion of single-column "label: value" lookup grids
  // into key/value (or minimum/maximum/value) columns. Same policy: strong
  // structural evidence only; ambiguous text passes through untouched and
  // the validator flags it for review instead.
  const { tables: expanded, expansions } = expandRecordTables(separated);
  job.tables = expanded;
  for (const table of job.tables) {
    table.columns = inferTableColumns(table);
  }
  linkLogicalTableGroups(job.tables);
  // Deterministic grouping of sequential single-expression routines the
  // extractor emitted one-per-step for a single source pipeline. Same
  // policy: strong structural evidence only; anything ambiguous passes
  // through untouched and the grouping is flagged for review.
  const { routines: grouped, groupings } = groupStepRoutines(job.routines);
  job.routines = grouped;
  // Parameterized lookups for table-driven factors, inserted before
  // validation so supported lookups resolve and only genuine gaps warn.
  for (const routine of job.routines) generateParameterizedLookups(routine, job.tables, job.routines);
  // Worked-example instance lookups, resolved the same way before validation.
  for (const routine of job.routines) generateWorkedExampleLookups(routine, job.tables);
  job.issues = validateJob(job);
  for (const split of splits) {
    job.issues.push(
      createValidationIssue({
        severity: 'warning',
        targetType: 'table',
        targetId: split.originalId,
        message: `Table "${split.originalName || split.originalId}" was separated into ${split.partNames.length} independent grids (${split.partNames.map((n) => `"${n}"`).join(', ')}); verify the boundaries against the source.`,
        sourcePages: split.sourcePages,
      })
    );
  }
  for (const expansion of expansions) {
    job.issues.push(
      createValidationIssue({
        severity: 'warning',
        targetType: 'table',
        targetId: expansion.tableId,
        message: expansion.message,
        sourcePages: expansion.sourcePages,
      })
    );
  }
  for (const grouping of groupings) {
    job.issues.push(
      createValidationIssue({
        severity: 'warning',
        targetType: 'routine',
        targetId: grouping.routineId,
        message: groupingMessage(grouping),
        sourcePages: grouping.sourcePages,
      })
    );
  }
  job = normalizeJob(job);
  return job;
}

// Verification warning for one deterministic routine grouping. Prerequisite
// merges cite the forward-reference evidence (consumed variables or a
// dependency naming); numbered chains keep the pipeline wording.
function groupingMessage(grouping) {
  const head = `Routines ${grouping.memberNames.map((n) => `"${n}"`).join(', ')} were grouped into one ${grouping.stepNumbers.length}-step routine ("${grouping.routineName}")`;
  if (grouping?.reason === 'prerequisite') {
    const links = (grouping.links ?? []).map((link) => {
      const vars = (link?.variables ?? []).filter((v) => String(v ?? '').trim());
      if (vars.length > 0) {
        return `"${link.consumer}" consumes ${vars.map((v) => `"${v}"`).join(', ')} produced by "${link.producer}"`;
      }
      return `"${link.consumer}" names "${link.producer}" as a dependency`;
    }).join('; ');
    return `${head}; ${links}; verify the steps form a single routine against the source.`;
  }
  return `${head}; verify the steps form a single pipeline against the source.`;
}

// Link split parts of one logical table (same base asset code, different
// Part/Section qualifiers) via continuation, so the relationship survives
// extraction. Fills only absent continuations; existing values are preserved.
// Generic code shapes, never table names.
function linkLogicalTableGroups(tables) {
  const groups = new Map();
  for (const table of tables ?? []) {
    const key = tableLogicalGroupKey(table);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(table);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const names = members.map((t) => String(t?.name ?? t?.id ?? ''));
    for (const table of members) {
      if (table.continuation !== null && table.continuation !== undefined) continue;
      const others = names.filter((n) => n && n !== String(table?.name ?? table?.id ?? ''));
      if (others.length === 0) continue;
      table.continuation = {
        logical_group: key,
        group_size: members.length,
        related_tables: others,
      };
    }
  }
  linkHeaderContinuationChains(tables);
  linkCueContinuationGroups(tables);
}

// Fill continuation metadata for members lacking it. IDs and rows are never
// touched: linking records the relationship, it never merges tables.
function fillContinuation(members, key, reason) {
  const names = members.map((t) => String(t?.name ?? t?.id ?? ''));
  for (const table of members) {
    if (table.continuation !== null && table.continuation !== undefined) continue;
    const others = names.filter((n) => n && n !== String(table?.name ?? table?.id ?? ''));
    if (others.length === 0) continue;
    table.continuation = {
      logical_group: key,
      group_size: members.length,
      related_tables: others,
      link_reason: reason,
    };
  }
}

function headerGroupSlug(headerKey) {
  return headerKey.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

// Link tables with identical headers on adjacent pages as continuation
// chains. Same-page and page-less tables never link; chains break on page
// gaps so repeated header sets on far pages form separate groups.
function linkHeaderContinuationChains(tables) {
  const byHeaders = new Map();
  for (const table of tables ?? []) {
    const key = tableHeaderKey(table);
    if (!key) continue;
    if (!byHeaders.has(key)) byHeaders.set(key, []);
    byHeaders.get(key).push(table);
  }
  for (const [key, members] of byHeaders) {
    const paged = members.filter((t) => (t?.source_pages ?? []).length > 0);
    if (paged.length < 2) continue;
    const sorted = [...paged].sort((a, b) =>
      Math.min(...a.source_pages) - Math.min(...b.source_pages)
      || Math.max(...a.source_pages) - Math.max(...b.source_pages));
    let chain = [sorted[0]];
    const flush = () => {
      if (chain.length >= 2) {
        fillContinuation(chain, `continued:${headerGroupSlug(key)}@p${Math.min(...chain[0].source_pages)}`, 'matching headers on adjacent pages');
      }
    };
    for (let i = 1; i < sorted.length; i += 1) {
      if (tablePagesAdjacent(chain[chain.length - 1], sorted[i])) chain.push(sorted[i]);
      else {
        flush();
        chain = [sorted[i]];
      }
    }
    flush();
  }
}

// Link tables sharing a cue-stripped base name when at least one carries an
// explicit continuation cue ('(continued)', 'Part N'). The cue overrides
// page distance; same-name tables without any cue stay unlinked.
function linkCueContinuationGroups(tables) {
  const byBase = new Map();
  for (const table of tables ?? []) {
    const base = tableContinuationBase(table);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(table);
  }
  for (const [base, members] of byBase) {
    if (members.length < 2) continue;
    if (!members.some(tableHasContinuationCue)) continue;
    fillContinuation(members, `continued-part:${base}`, 'explicit continuation cue');
  }
}

/**
 * Apply reviewer edits (tables/routines arrays) and re-run deterministic
 * validation only — never re-calls the model.
 */
export function applyReviewEdits(job, { tables, routines }) {
  let next = normalizeJob(
    createJob({
      document: job.document,
      tables: tables ?? job.tables,
      routines: routines ?? job.routines,
      status: 'review',
    })
  );
  for (const table of next.tables) {
    table.columns = inferTableColumns(table);
  }
  linkLogicalTableGroups(next.tables);
  for (const routine of next.routines) generateParameterizedLookups(routine, next.tables, next.routines);
  for (const routine of next.routines) generateWorkedExampleLookups(routine, next.tables);
  next.issues = validateJob(next);
  next = normalizeJob(next);
  return next;
}
