// One-shot Meta API verification: makes exactly ONE minimal chat request.
// Run after putting your Meta API key in .env:  npm run verify:model
// Exits 2 without any network call when the key/flag is not configured.
// Never prints the API key.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../src/dotenv.js';
import {
  ENABLE_FLAG,
  KEY_VAR,
  URL_VAR,
  MODEL_VAR,
  DEFAULT_MODEL_URL,
  DEFAULT_MODEL_NAME,
} from '../src/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(here, '..', '.env'));

const env = process.env;
if (env[ENABLE_FLAG] !== '1' || !env[KEY_VAR]) {
  console.log(
    `Not configured: set ${ENABLE_FLAG}=1 and ${KEY_VAR} in .env first (no request sent).`
  );
  process.exit(2);
}

const url = env[URL_VAR] || DEFAULT_MODEL_URL;
const model = env[MODEL_VAR] || DEFAULT_MODEL_NAME;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env[KEY_VAR]}` },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly the two letters OK and nothing else. Plain text, no JSON, no markdown.' }],
    temperature: 0,
    max_tokens: 128,
  }),
});
if (!res.ok) {
  console.log(`Verification FAILED: HTTP ${res.status} from ${url} (model "${model}").`);
  process.exit(1);
}
const data = await res.json();
const raw = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
const content = (Array.isArray(raw)
  ? raw.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  : String(raw ?? '')
).trim().slice(0, 120);
// Safe preview: response body only (never headers/auth), truncated, key redacted if echoed.
const key = env[KEY_VAR] || '';
const safe = (s) => (key ? String(s).split(key).join('[REDACTED]') : String(s));
const preview = safe(JSON.stringify(data)).slice(0, 500);
console.log(`Verified: HTTP ${res.status} from ${url} (model "${model}"). Model replied: ${safe(JSON.stringify(content))} Raw: ${preview}`);
