// Minimal safe .env loader (zero dependencies).
// Parses KEY=VALUE lines; ignores blank lines and '#' comments.
// Values may be wrapped in matching single or double quotes (stripped).
// No variable expansion, no multiline values, no command execution.
// Never overrides variables already set in the environment.
// Missing file is a no-op (returns false); other read errors throw.
import { readFileSync } from 'node:fs';

export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['\"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(filePath, env = process.env) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (!(key in env)) env[key] = value;
  }
  return true;
}
