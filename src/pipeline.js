// End-to-end pipeline: ingest PDF -> extract -> normalize -> separate -> validate.
import { extractPdfText } from './pdf-extract.js';
import { ModelDisabledError, runExtraction } from './extract.js';
import { createDocument, createJob, createValidationIssue, normalizeJob } from './models.js';
import { expandRecordTables, splitMergedTables } from './table-split.js';
import { validateJob } from './validate.js';

/**
 * Process one PDF buffer into a validated job.
 * @param {Buffer} pdfBuffer
 * @param {{ filename?: string, recordingPath?: string|null, modelOptions?: object }} options
 * @returns {Promise<{ job: object, source: string }>}
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
  job = normalizeJob(job);
  return { job, source: recordingPath ? 'recorded' : 'live' };
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
