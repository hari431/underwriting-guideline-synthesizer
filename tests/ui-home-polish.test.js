import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

async function readHome() {
  return fs.readFile('public/index.html', 'utf8');
}

test('ui home polish: PDF drop zone keeps picker and all upload actions', async () => {
  const html = await readHome();
  assert.ok(html.includes('id="dropzone"'), 'drop zone exists');
  const dzStart = html.indexOf('id="dropzone"');
  const dzEnd = html.indexOf('id="status"');
  const dz = html.slice(dzStart, dzEnd);
  assert.ok(dz.includes('id="file"'), 'file picker lives in the drop zone');
  assert.ok(dz.includes('accept="application/pdf"'), 'picker still PDF-only');
  assert.match(dz, /PDF only/i, 'concise helper text mentions PDF-only');
  assert.match(html, /<button id="uploadBtn" class="primary">Extract from PDF<\/button>/);
  assert.match(html, /<button id="sampleBtn">Load sample guideline \(offline\)<\/button>/);
  assert.match(html, /<button id="clearBtn" disabled>Clear PDF<\/button>/);
});

test('ui home polish: compact What-you-get section with three supported cards', async () => {
  const html = await readHome();
  assert.match(html, /What you(&rsquo;|’|')ll get/, 'section title present');
  for (const title of ['Rating Tables', 'Rating Routines', 'Validation &amp; Source Evidence']) {
    assert.ok(html.includes(title), `${title} card present`);
  }
  // Cards appear before the upload step so the empty home page reads top-down.
  const introAt = html.indexOf('What you');
  const uploadAt = html.indexOf('<section id="upload"');
  assert.ok(introAt >= 0 && introAt < uploadAt, 'intro sits above the upload step');
});

test('ui home polish: trust note requires analyst review, keeps gaps visible', async () => {
  const html = await readHome();
  assert.match(html, /analyst review/i, 'analyst review mentioned');
  assert.match(html, /gaps|conflicts/i, 'source gaps or conflicts mentioned');
  assert.match(html, /visible|flagged/i, 'gaps stay visible');
});

test('ui home polish: branding, sidebar steps, and upload adjacency preserved', async () => {
  const html = await readHome();
  for (let n = 1; n <= 6; n += 1) assert.ok(html.includes(`data-step="${n}"`), `sidebar step ${n} intact`);
  assert.ok(html.includes('--forest-800'), 'dark-green brand tokens intact');
  assert.ok(html.includes('id="themeToggle"'), 'theme toggle intact');
  const uploadClose = html.indexOf('</section>', html.indexOf('<section id="upload"'));
  const jobOpen = html.indexOf('<section id="jobSection"');
  assert.ok(uploadClose >= 0 && uploadClose < jobOpen, 'upload still directly precedes extraction');
  assert.ok(!html.slice(uploadClose, jobOpen).includes('<section'), 'nothing inserted between upload and extraction');
});

test('ui home polish: only supported claims, responsive without heavy layout', async () => {
  const html = await readHome();
  const lower = html.toLowerCase();
  for (const banned of ['confidence score', 'accuracy', 'job history', 'certif', 'production-ready', 'production ready']) {
    assert.ok(!lower.includes(banned), `no unsupported claim: ${banned}`);
  }
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(style.includes('.intro-grid'), 'intro grid styled');
  assert.ok(style.includes('@media (max-width: 900px)'), 'responsive breakpoint preserved');
  assert.ok(style.includes('[data-theme="dark"]'), 'dark theme block preserved');
});

test('ui home polish: engine positioning, tagline, and honest extraction copy', async () => {
  const html = await readHome();
  assert.match(html, /<title>RateCraft [^<]*AI-Powered Underwriting Extraction Engine<\/title>/, 'title carries engine positioning');
  assert.match(html, /<h1>RateCraft<\/h1>/, 'product name unchanged');
  assert.ok(html.includes('Transform complex underwriting guideline PDFs into structured, traceable rating requirements for analyst review.'), 'tagline present');
  assert.ok(html.includes('Meta Muse Spark 1.3'), 'extraction layer named');
  assert.ok(html.includes('RateCraft Extraction Engine'), 'engine named');
  assert.match(html, /offline sample replays a recorded extraction/, 'offline playback distinguished');
  assert.match(html, /no model call/, 'offline honesty kept');
  assert.match(html, /Excel export/, 'export layer named');
});
