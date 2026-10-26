// Model adapter for extraction. Meta API calls are DISABLED by default:
// live extraction requires UNDERWRITEIQ_ENABLE_MODEL=1 plus an API key.
// Local tests and the offline demo use recorded responses instead.
import { promises as fs } from 'node:fs';

export const ENABLE_FLAG = 'UNDERWRITEIQ_ENABLE_MODEL';
export const KEY_VAR = 'UNDERWRITEIQ_API_KEY';
export const URL_VAR = 'UNDERWRITEIQ_MODEL_URL';
export const MODEL_VAR = 'UNDERWRITEIQ_MODEL_NAME';

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
    'Return ONLY a JSON object with this exact shape (no markdown, no commentary):',
    '{"tables": [{"name": string, "source_pages": [int], "evidence_text": string,',
    ' "headers": [string], "rows": [[string]], "notes": string}],',
    ' "routines": [{"name": string, "kind": "formula"|"condition"|"calculation_steps",',
    ' "source_pages": [int], "evidence_text": string, "expression_text": string,',
    ' "conditions": [string], "steps": [string], "depends_on": [string], "notes": string}]}',
    'Rules: every object MUST include 1-based source_pages and a verbatim evidence_text',
    'snippet from the page(s). Preserve table values exactly. Keep formulas/conditions/steps',
    'verbatim; do not invent dependencies.',
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
  const url = env[URL_VAR];
  const model = env[MODEL_VAR];
  if (!url || !model) {
    throw new ModelDisabledError(`Set ${URL_VAR} and ${MODEL_VAR} to enable Meta API calls.`);
  }
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
