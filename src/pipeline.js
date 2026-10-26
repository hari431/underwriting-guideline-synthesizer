// End-to-end pipeline: ingest PDF -> extract -> normalize -> validate.
import { extractPdfText } from './pdf-extract.js';
import { runExtraction } from './extract.js';
import { createDocument, createJob, normalizeJob } from './models.js';
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
  const { tables, routines } = await runExtraction(pages, { recordingPath, modelOptions });
  let job = normalizeJob(
    createJob({
      document: createDocument({ filename, pageCount }),
      tables,
      routines,
      status: 'review',
    })
  );
  job.issues = validateJob(job);
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
