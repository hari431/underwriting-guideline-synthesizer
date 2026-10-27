import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotEnv, loadDotEnv } from '../src/dotenv.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('dotenv: parses values, strips quotes, skips comments and junk', () => {
  const parsed = parseDotEnv(
    '# comment\n' +
      'UNDERWRITEIQ_ENABLE_MODEL=1\n' +
      'UNDERWRITEIQ_API_KEY="quoted key"\n' +
      "UNDERWRITEIQ_MODEL_NAME='muse-spark-1.3'\n" +
      'EMPTY=\n' +
      'no-equals-here\n' +
      '9BAD=oops\n'
  );
  assert.deepEqual(parsed, {
    UNDERWRITEIQ_ENABLE_MODEL: '1',
    UNDERWRITEIQ_API_KEY: 'quoted key',
    UNDERWRITEIQ_MODEL_NAME: 'muse-spark-1.3',
    EMPTY: '',
  });
});

test('dotenv: loads file into env without overriding, missing file is a no-op', async () => {
  const dir = path.join(here, '..', `test-env-tmp-${process.pid}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const file = path.join(dir, '.env');
    await fs.writeFile(file, 'UNDERWRITEIQ_API_KEY=file-key\nUNDERWRITEIQ_MODEL_NAME=file-model\n');
    const env = { UNDERWRITEIQ_API_KEY: 'shell-key' };
    assert.equal(loadDotEnv(file, env), true);
    assert.equal(env.UNDERWRITEIQ_API_KEY, 'shell-key');
    assert.equal(env.UNDERWRITEIQ_MODEL_NAME, 'file-model');
    assert.equal(loadDotEnv(path.join(dir, 'does-not-exist'), env), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
