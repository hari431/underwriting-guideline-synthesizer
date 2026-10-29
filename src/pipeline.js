// End-to-end pipeline: ingest PDF -> extract -> normalize -> separate -> validate.
import { extractPdfText } from './pdf-extract.js';
import { ModelDisabledError, runExtraction } from './extract.js';
import { createDocument, createJob, createValidationIssue, normalizeJob } from './models.js';
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
  // Deterministic grouping of sequential single-expression routines the
  // extractor emitted one-per-step for a single source pipeline. Same
  // policy: strong structural evidence only; anything ambiguous passes
  // through untouched and the grouping is flagged for review.
  const { routines: grouped, groupings } = groupStepRoutines(job.routines);
  job.routines = grouped;
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
        message: `Routines ${grouping.memberNames.map((n) => `"${n}"`).join(', ')} were grouped into one ${grouping.stepNumbers.length}-step routine ("${grouping.routineName}"); verify the steps form a single pipeline against the source.`,
        sourcePages: grouping.sourcePages,
      })
    );
  }
  job = normalizeJob(job);
  return job;
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
  next.issues = validateJob(next);
  next = normalizeJob(next);
  return next;
}
