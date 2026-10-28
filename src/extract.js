// Model adapter for extraction. Meta API calls are DISABLED by default:
// live extraction requires UNDERWRITEIQ_ENABLE_MODEL=1 plus an API key.
// Local tests and the offline demo use recorded responses instead.
import { promises as fs } from 'node:fs';

export const ENABLE_FLAG = 'UNDERWRITEIQ_ENABLE_MODEL';
export const KEY_VAR = 'UNDERWRITEIQ_API_KEY';
export const URL_VAR = 'UNDERWRITEIQ_MODEL_URL';
export const MODEL_VAR = 'UNDERWRITEIQ_MODEL_NAME';

// Meta hackathon Model API defaults (per official Model API docs).
// URL_VAR expects the FULL chat-completions endpoint URL, not the base URL:
// fetch() posts to it directly with no path joining.
export const DEFAULT_MODEL_URL = 'https://api.meta.ai/v1/chat/completions';
export const DEFAULT_MODEL_NAME = 'muse-spark-1.3';

export class ModelDisabledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelDisabledError';
    this.code = 'MODEL_DISABLED';
  }
}

export function isModelEnabled(env = process.env) {
  return env[ENABLE_FLAG] === '1' && Boolean(env[KEY_VAR]);
}

export function buildExtractionPrompt(pages) {
  const body = pages
    .map((p) => `--- PAGE ${p.page} ---\n${p.text}`)
    .join('\n\n');
  return [
    'You extract structured rating requirements from an underwriting guideline.',
    'Return ONLY a JSON object with tables[] and routines[] (no markdown, no commentary).',
    'For each table: name/title (source title when present), source_pages [1-based ints],',
    ' evidence_text (verbatim snippet), headers [source column labels in order],',
    ' rows [[cell strings in source order; preserve every value exactly]], plus optional',
    ' columns [{label, data_type?, role?, units?, evidence?}], purpose?, applicability?,',
    ' effective_period?, footnotes?/notes?, source_location?, continuation?',
    'For each routine: name, kind, source_pages, evidence_text, plus optional',
    ' expression_text, conditions [verbatim branch texts in source order],',
    ' steps [ordered operations in source order: verbatim step texts preserving',
    ' original numbering, or {sequence, instruction, operation, expression, operand,',
    ' inputs, output} when the source explicitly states the operation and operand],',
    ' with lookup keys using the source column labels verbatim (for example',
    ' "Coverage Name"), never as object paths (never "Coverage.Name"),',
    ' depends_on [referenced table/routine/variable names], inputs?, outputs?,',
    ' purpose?, applicability?, execution_context?, notes?',
    'Rules: every table and routine MUST include 1-based source_pages and verbatim evidence_text.',
    'Preserve every row, column, value, and order exactly, including leading zeros and numeric precision.',
    'Preserve blanks, explicit zeroes, negatives, and ranges distinctly. Keep metadata and',
    'instructions separate from data rows. Keep formulas/conditions/steps verbatim in source',
    'order; preserve assignments, lookups, arithmetic, rounding, conditions, and execution',
    'order where present, with step numbering gaps when present. Do not invent steps,',
    'dependencies, metadata, or meanings for unfamiliar syntax; keep the source text',
    'verbatim for analyst review.',
    'Do not assume fixed table names, column counts, key fields, or routine shapes.',
    'Record a grid as a rating table only when it is reusable lookup data keyed',
    'by its columns. A worked illustration computed for one instance (line items',
    'with a computed total) is not a reusable rating table: keep its text',
    'verbatim in the related routine evidence or notes instead of emitting a table.',
    'Keep adjacent independent grids separate: each grid with its own title or',
    'column labels is its own table, even when grids sit side by side or stack',
    'without a gap; never merge two grids into one table and never split one',
    'grid into two.',
    'Record a routine step only for an explicit operation the source states',
    '(assignment, arithmetic, lookup, rounding, condition, or referral with its',
    'operands); keep narrative or descriptive sentences verbatim without',
    'inventing an operation, operand, or dependency for them.',
    '',
    body,
  ].join('\n');
}

/**
 * Live extraction via the configured Meta-compatible chat endpoint.
 * Throws ModelDisabledError unless explicitly enabled with a key.
 */
export async function extractWithModel(pages, { env = process.env, fetchImpl = fetch } = {}) {
  if (env[ENABLE_FLAG] !== '1') {
    throw new ModelDisabledError(
      `Meta API calls are disabled (${ENABLE_FLAG}!=1). Set ${ENABLE_FLAG}=1 and ${KEY_VAR} to enable, or use a recorded response.`
    );
  }
  const apiKey = env[KEY_VAR];
  if (!apiKey) {
    throw new ModelDisabledError(`Missing API key: set ${KEY_VAR} to enable Meta API calls.`);
  }
  const url = env[URL_VAR] || DEFAULT_MODEL_URL;
  const model = env[MODEL_VAR] || DEFAULT_MODEL_NAME;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildExtractionPrompt(pages) }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`Model request failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return parseModelJson(content);
}

export function parseModelJson(content) {
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Model response was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tables) || !Array.isArray(parsed.routines)) {
    throw new Error('Model response missing tables[] / routines[] arrays');
  }
  return { tables: parsed.tables, routines: parsed.routines };
}

/** Offline path: load a recorded extraction response (used by tests/demo). */
export async function loadRecording(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.tables) || !Array.isArray(parsed.routines)) {
    throw new Error(`Recorded response ${filePath} missing tables[] / routines[] arrays`);
  }
  return { tables: parsed.tables, routines: parsed.routines };
}

/**
 * Route extraction: explicit recording path wins; otherwise live model
 * (which throws ModelDisabledError until the user configures it).
 */
export async function runExtraction(pages, { recordingPath = null, modelOptions = {} } = {}) {
  if (recordingPath) return loadRecording(recordingPath);
  return extractWithModel(pages, modelOptions);
}
