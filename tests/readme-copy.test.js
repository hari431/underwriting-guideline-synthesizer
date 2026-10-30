import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

async function readReadme() {
  return fs.readFile('README.md', 'utf8');
}

test('readme copy: engine positioning and tagline', async () => {
  const md = await readReadme();
  assert.match(md, /^# RateCraft .*AI-Powered Underwriting Extraction Engine/m, 'title carries engine positioning');
  assert.ok(md.includes('Transform complex underwriting guideline PDFs into structured, traceable rating requirements for analyst review.'), 'tagline present');
  assert.ok(md.includes('RateCraft Extraction Engine'), 'engine named');
});

test('readme copy: architecture layers with honest live/offline split', async () => {
  const md = await readReadme();
  assert.ok(md.includes('Meta Muse Spark 1.3'), 'extraction layer named');
  assert.match(md, /no model call/, 'offline playback distinguished');
  assert.match(md, /[Hh]uman review is required/, 'review requirement stated');
});

test('readme copy: no certification or readiness claims', async () => {
  const md = await readReadme();
  const lower = md.toLowerCase();
  for (const banned of ['certif', 'production-ready', 'production ready']) {
    assert.ok(!lower.includes(banned), `no unsupported claim: ${banned}`);
  }
});
