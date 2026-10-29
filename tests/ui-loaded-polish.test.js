import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';

class MockClassList {
  constructor() { this._s = new Set(); }
  toggle(name, force) {
    if (force === undefined) {
      if (this._s.has(name)) this._s.delete(name);
      else this._s.add(name);
    } else if (force) this._s.add(name);
    else this._s.delete(name);
    return this._s.has(name);
  }
  contains(name) { return this._s.has(name); }
}

class MockEl {
  constructor(id = '') {
    this.id = id;
    this._text = '';
    this._html = '';
    this.hidden = false;
    this.disabled = false;
    this._value = '';
    this.files = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.className = '';
    this.classList = new MockClassList();
    this.replacedBy = null;
    this._firstChild = null;
    this.scrollIntoViewCalls = 0;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get firstElementChild() { return this._firstChild; }
  set firstElementChild(v) { this._firstChild = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  scrollIntoView() { this.scrollIntoViewCalls += 1; }
  replaceWith(other) { this.replacedBy = other; }
}

function makeDocument() {
  const els = new Map();
  const steps = [1, 2, 3, 4, 5, 6].map((n) => {
    const el = new MockEl(`step${n}`);
    el.dataset.step = String(n);
    return el;
  });
  return {
    _els: els,
    _steps: steps,
    getElementById(id) {
      if (!els.has(id)) els.set(id, new MockEl(id));
      return els.get(id);
    },
    querySelectorAll(sel) {
      if (sel === '.step') return steps;
      return [];
    },
    createElement() {
      const el = new MockEl('');
      let html = '';
      Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set: (v) => {
          html = String(v);
          const child = new MockEl('tmp-child');
          child.innerHTML = html;
          el.firstElementChild = child;
        },
      });
      return el;
    },
  };
}

function fixturePayload() {
  const job = {
    document: { filename: 'g.pdf', page_count: 3 },
    tables: [
      { id: 'T1', name: 'Clean Table', source_pages: [1], evidence_text: 'clean table excerpt', headers: ['A'], rows: [['1']], purpose: '', applicability: '', effective_period: '', footnotes: [], notes: '', review_status: '' },
      { id: 'T2', name: 'Flagged Table', source_pages: [2], evidence_text: 'flagged table excerpt', headers: ['Territory', 'Factor'], rows: [['T01', '1.35']], purpose: '', applicability: '', effective_period: '', footnotes: [], notes: '', review_status: '' },
    ],
    routines: [
      { id: 'R1', name: 'Clean Routine', kind: 'formula', source_pages: [1], evidence_text: 'clean routine excerpt', expression_text: 'a = b * 2', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
      { id: 'R4', name: 'Needs Review', kind: 'formula', source_pages: [3], evidence_text: 'legacy surcharge excerpt', expression_text: 'APPLY legacy_matrix_v2 surcharge curve', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
    ],
    issues: [
      { id: 'V1', severity: 'error', target_type: 'table', target_id: 'T2', message: 'broken ref', source_pages: [2] },
      { id: 'V2', severity: 'warning', target_type: 'routine', target_id: 'R4', message: 'cannot reliably interpret', source_pages: [3] },
    ],
    status: 'review',
    updated_at: new Date().toISOString(),
  };
  return { id: 'test-job-12345678', job, source: 'recorded' };
}

async function makeUI() {
  const html = await fs.readFile('public/index.html', 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'inline script found');
  const inline = m[1];
  const doc = makeDocument();
  const win = {
    confirmCalls: [],
    confirmResult: true,
    confirm(msg) { this.confirmCalls.push(String(msg)); return this.confirmResult; },
    location: { href: '' },
    scrollTo() {},
  };
  const fetchMock = async (url) => {
    if (String(url) === '/api/health') return { json: async () => ({ ok: true, modelEnabled: false }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctx = { document: doc, window: win, fetch: fetchMock, structuredClone, console };
  vm.createContext(ctx);
  const hook = ';globalThis.__T={get state(){return state},set state(v){state=v},'
    + 'get draft(){return draft},set draft(v){draft=v},'
    + 'get ui(){return ui},set ui(v){ui=v},fn:{adoptJob,renderExport,'
    + 'renderJobSummary,handleStepNav,statusPills,'
    + 'setBusy:(typeof setBusy!=="undefined")?setBusy:undefined,'
    + 'exportWorkbook:(typeof exportWorkbook!=="undefined")?exportWorkbook:undefined,'
    + 'requestClearSession:(typeof requestClearSession!=="undefined")?requestClearSession:undefined}};';
  vm.runInContext(inline + hook, ctx, { filename: 'ui-inline.js' });
  await new Promise((r) => setTimeout(r, 20));
  const T = ctx.__T;
  const el = (id) => doc.getElementById(id);
  const click = (id) => {
    const fns = el(id).listeners.click || [];
    assert.ok(fns.length > 0, `${id} has click listener`);
    for (const fn of fns) fn();
  };
  const isActive = (n) => doc._steps[n - 1].classList.contains('active');
  return { html, inline, doc, win, T, el, click, isActive };
}

test('ui loaded polish: full upload area initially, compact doc bar after load', async () => {
  const { html, T, el } = await makeUI();
  assert.ok(html.includes('id="dropzone"'), 'drop zone present for empty state');
  assert.match(html, /<div class="docbar" id="docBar" hidden>/, 'doc bar hidden initially');
  assert.equal(el('docBar').hidden, true);
  assert.equal(el('upload').classList.contains('loaded'), false);

  T.fn.adoptJob(fixturePayload());
  assert.equal(el('docBar').hidden, false, 'doc bar appears after load');
  assert.equal(el('upload').classList.contains('loaded'), true, 'upload marked loaded');
  assert.equal(el('docBarTitle').textContent, 'g.pdf');
  assert.match(el('docBarMeta').textContent, /3 pages/);
  assert.match(el('docBarMeta').textContent, /2 tables/);
  assert.match(el('docBarMeta').textContent, /2 routines/);
  assert.match(el('docBarSource').innerHTML, /recorded/);
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(style.includes('#upload.loaded .dropzone'), 'loaded state collapses the drop zone');
  assert.ok(style.includes('.docbar[hidden]'), 'doc bar hides via hidden attribute');
});

test('ui loaded polish: Change PDF shares the clear flow and restores upload', async () => {
  const { T, el, win, click } = await makeUI();
  assert.ok(T.fn.requestClearSession, 'shared clear handler exists');
  const clearFns = el('clearBtn').listeners.click || [];
  const changeFns = el('changeDocBtn').listeners.click || [];
  assert.equal(clearFns.length, 1, 'Clear PDF keeps one handler');
  assert.equal(changeFns.length, 1, 'Change PDF has one handler');
  assert.equal(changeFns[0], clearFns[0], 'Change PDF reuses the clear flow');

  T.fn.adoptJob(fixturePayload());
  T.draft.tables[0].name = 'edited';
  win.confirmResult = false;
  click('changeDocBtn');
  assert.equal(win.confirmCalls.length, 1);
  assert.match(win.confirmCalls[0], /unsaved edits/);
  assert.match(win.confirmCalls[0], /Saved jobs and exported files will be kept/);
  assert.ok(T.state !== null, 'cancel preserves the session');
  assert.equal(el('docBar').hidden, false);

  win.confirmResult = true;
  click('changeDocBtn');
  assert.equal(T.state, null);
  assert.equal(el('docBar').hidden, true, 'doc bar hides after change');
  assert.equal(el('upload').classList.contains('loaded'), false, 'full upload area returns');
  assert.equal(el('file').disabled, false);
  assert.equal(el('uploadBtn').disabled, false);
  assert.equal(el('clearBtn').disabled, true);
});

test('ui loaded polish: doc bar Clear PDF reuses the clear flow', async () => {
  const { html, T, el, win, click } = await makeUI();
  const barStart = html.indexOf('<div class="docbar" id="docBar" hidden>');
  assert.ok(barStart >= 0, 'doc bar markup present');
  const bar = html.slice(barStart, html.indexOf('</section>', barStart));
  assert.match(bar, /<button[^>]*id="docClearBtn"[^>]*>Clear PDF<\/button>/, 'Clear PDF sits in the doc bar');
  assert.ok(bar.includes('id="changeDocBtn"'), 'Change PDF kept alongside');
  const clearFns = el('clearBtn').listeners.click || [];
  const docClearFns = el('docClearBtn').listeners.click || [];
  assert.equal(docClearFns.length, 1, 'doc bar Clear PDF has one handler');
  assert.equal(docClearFns[0], clearFns[0], 'doc bar Clear PDF reuses the clear flow');

  T.fn.adoptJob(fixturePayload());
  T.draft.tables[0].name = 'edited';
  win.confirmResult = true;
  click('docClearBtn');
  assert.equal(win.confirmCalls.length, 1);
  assert.match(win.confirmCalls[0], /unsaved edits/);
  assert.equal(T.state, null, 'session reset');
  assert.equal(el('docBar').hidden, true, 'doc bar hides');
  assert.equal(el('upload').classList.contains('loaded'), false, 'initial upload screen returns');
  assert.equal(el('stickyBar').hidden, true, 'sticky export disappears with no results');
  assert.equal(el('stickyState').innerHTML, '');
  assert.equal(el('file').disabled, false);
  assert.equal(el('uploadBtn').disabled, false);
});

test('ui loaded polish: Errors and Warnings cards navigate to Review', async () => {
  const { T, el, isActive } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  const summary = el('jobSummary').innerHTML;
  assert.match(summary, /data-goto-review="errors"/, 'errors card is clickable');
  assert.match(summary, /data-goto-review="warnings"/, 'warnings card is clickable');
  assert.equal((summary.match(/<div class="v">1<\/div>/g) || []).length, 2, 'existing counts shown, none invented');

  const fns = el('jobSummary').listeners.click || [];
  assert.equal(fns.length, 1, 'one delegated navigation listener');
  const fire = (kind) => {
    const ev = {
      prevented: false,
      preventDefault() { this.prevented = true; },
      target: { closest: (sel) => (sel === '[data-goto-review]' ? { dataset: { gotoReview: kind } } : null) },
    };
    for (const fn of fns) fn(ev);
  };
  fire('errors');
  assert.equal(el('reviewSection').scrollIntoViewCalls, 1, 'errors navigate to Review');
  assert.equal(isActive(5), true, 'Review step highlighted');
  fire('warnings');
  assert.equal(el('reviewSection').scrollIntoViewCalls, 2, 'warnings navigate to Review');

  const before = el('reviewSection').scrollIntoViewCalls;
  for (const fn of fns) fn({ preventDefault() {}, target: { closest: () => null } });
  assert.equal(el('reviewSection').scrollIntoViewCalls, before, 'other summary clicks do not navigate');
});

test('ui loaded polish: browse keeps counts and shows each item review state', async () => {
  const { html, T } = await makeUI();
  assert.ok(html.includes('id="tablesCount"'), 'tables count retained');
  assert.ok(html.includes('id="routinesCount"'), 'routines count retained');
  T.fn.adoptJob(fixturePayload());
  assert.match(T.fn.statusPills('tables', T.draft.tables[0]), /Clear/, 'clean item reads Clear');
  assert.match(T.fn.statusPills('tables', T.draft.tables[1]), /Needs review/, 'flagged item needs review');
  assert.match(T.fn.statusPills('tables', T.draft.tables[1]), /1 error/, 'existing issue count kept');
  assert.match(T.fn.statusPills('routines', T.draft.routines[1]), /Needs review/, 'REVIEW routine needs review');
  T.draft.tables[0].review_status = 'reviewed';
  assert.match(T.fn.statusPills('tables', T.draft.tables[0]), /Reviewed/, 'acknowledged item reads Reviewed');
  T.draft.tables[0].review_status = 'pending';
  assert.match(T.fn.statusPills('tables', T.draft.tables[0]), /pending/, 'custom review status still shown');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(style, /\.item-grid\s*\{[^}]*gap:\s*0\.5rem/, 'browse grid tightened');
});

test('ui loaded polish: sticky bar shows doc, status, and shared export', async () => {
  const { html, T, el, win, click } = await makeUI();
  assert.match(html, /<div class="stickybar" id="stickyBar" hidden>/, 'sticky bar hidden initially');
  assert.equal(el('stickyBar').hidden, true);

  T.fn.adoptJob(fixturePayload());
  assert.equal(el('stickyBar').hidden, false, 'sticky bar appears after load');
  assert.equal(el('stickyDoc').textContent, 'g.pdf');
  assert.match(el('stickyState').innerHTML, /Blocked/, 'error status shown');
  const bottom = el('exportBtn').listeners.click || [];
  const sticky = el('stickyExportBtn').listeners.click || [];
  assert.equal(sticky.length, 1, 'sticky export has one handler');
  assert.equal(sticky[0], bottom[0], 'sticky export shares the export handler');
  assert.equal(el('stickyExportBtn').disabled, true, 'errors block sticky export');

  T.state.job.issues = T.state.job.issues.filter((i) => i.severity !== 'error');
  T.fn.renderExport();
  assert.equal(el('stickyExportBtn').disabled, false, 'warnings allow sticky export');
  assert.match(el('stickyState').innerHTML, /Warnings/);
  click('stickyExportBtn');
  assert.equal(win.location.href, '/api/jobs/test-job-12345678.xlsx');
});

test('ui loaded polish: theme, sidebar, workflow, and export rules preserved', async () => {
  const { html, inline, T, el, click } = await makeUI();
  for (let n = 1; n <= 6; n += 1) assert.ok(html.includes(`data-step="${n}"`), `sidebar step ${n} intact`);
  assert.ok(html.includes('--forest-800'), 'green brand intact');
  assert.ok(html.includes('id="themeToggle"'), 'theme toggle intact');
  assert.ok(html.includes('flow-strip'), 'upload flow visual intact');
  assert.ok(!html.includes('topExportBtn'), 'no duplicate heading export button');
  assert.ok(!html.includes('topExportState'), 'no duplicate heading status badge');
  assert.ok(html.includes('id="stickyExportBtn"'), 'sticky export intact');
  assert.ok(html.includes('<section id="exportSection"'), 'bottom export section intact');
  assert.ok(html.includes('id="exportStatus"'), 'export status intact');
  assert.equal((inline.match(/\.xlsx/g) || []).length, 1, 'single export download, no duplicated logic');
  const uploadClose = html.indexOf('</section>', html.indexOf('<section id="upload"'));
  const jobOpen = html.indexOf('<section id="jobSection"');
  assert.ok(uploadClose < jobOpen, 'upload still directly precedes extraction');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(style.includes('[data-theme="dark"]'), 'dark theme block preserved');
  assert.ok(style.includes('@media (max-width: 900px)'), 'responsive breakpoints preserved');

  T.fn.adoptJob(fixturePayload());
  assert.equal(el('file').disabled, true, 'one-PDF-per-run lock preserved');
  assert.equal(el('uploadBtn').disabled, true);
  click('clearBtn');
  assert.equal(el('stickyBar').hidden, true, 'clear hides the sticky bar');
  assert.equal(el('stickyState').innerHTML, '');
});
