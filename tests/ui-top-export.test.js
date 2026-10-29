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
  scrollIntoView() {}
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
      { id: 'T2', name: 'Warn Table', source_pages: [2], evidence_text: 'warn table excerpt from page two', headers: ['Territory', 'Factor'], rows: [['T01', '1.35']], purpose: '', applicability: '', effective_period: '', footnotes: [], notes: '', review_status: '' },
    ],
    routines: [
      { id: 'R1', name: 'Clean Routine', kind: 'formula', source_pages: [1], evidence_text: 'clean routine excerpt', expression_text: 'a = b * 2', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
      { id: 'R4', name: 'Needs Review', kind: 'formula', source_pages: [3], evidence_text: 'legacy surcharge excerpt from page three', expression_text: 'APPLY legacy_matrix_v2 surcharge curve', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
    ],
    issues: [
      { id: 'V1', severity: 'warning', target_type: 'table', target_id: 'T2', message: 'unclear units', source_pages: [2] },
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
    + 'get ui(){return ui},set ui(v){ui=v},fn:{adoptJob,'
    + 'renderExport,updateUploadLocks,countReviewSteps,'
    + 'setBusy:(typeof setBusy!=="undefined")?setBusy:undefined,'
    + 'exportWorkbook:(typeof exportWorkbook!=="undefined")?exportWorkbook:undefined}};';
  vm.runInContext(inline + hook, ctx, { filename: 'ui-inline.js' });
  await new Promise((r) => setTimeout(r, 20));
  const T = ctx.__T;
  const el = (id) => doc.getElementById(id);
  const click = (id) => {
    const fns = el(id).listeners.click || [];
    assert.ok(fns.length > 0, `${id} has click listener`);
    for (const fn of fns) fn();
  };
  return { html, inline, doc, win, T, el, click };
}

test('ui top export: sticky bar is the single persistent export action', async () => {
  const { html, T, el } = await makeUI();
  assert.ok(!html.includes('topExportBtn'), 'no duplicate heading export button');
  assert.ok(!html.includes('topExportState'), 'no duplicate heading status badge');
  const topStart = html.indexOf('<header class="topbar">');
  const top = html.slice(topStart, html.indexOf('</header>', topStart));
  assert.ok(!top.includes('<button'), 'nothing clickable beside the heading');
  assert.ok(html.includes('id="stickyExportBtn"'), 'sticky export exists');
  assert.ok(html.includes('<section id="exportSection"'), 'bottom export section kept');
  assert.equal(el('stickyBar').hidden, true, 'no active export before extraction');

  T.fn.adoptJob(fixturePayload());
  assert.equal(el('stickyBar').hidden, false, 'sticky action appears with results');
  assert.equal(el('stickyDoc').textContent, 'g.pdf');
});

test('ui top export: calls the same handler without duplicated export logic', async () => {
  const { T, el, win, inline, click } = await makeUI();
  assert.ok(T.fn.exportWorkbook, 'shared export handler exists');
  const bottom = el('exportBtn').listeners.click || [];
  const sticky = el('stickyExportBtn').listeners.click || [];
  assert.equal(bottom.length, 1, 'bottom button keeps one handler');
  assert.equal(sticky.length, 1, 'sticky button has one handler');
  assert.equal(sticky[0], bottom[0], 'both buttons share the same handler');
  assert.equal((inline.match(/\.xlsx/g) || []).length, 1, 'single download target, no duplicated logic');

  T.fn.adoptJob(fixturePayload());
  click('stickyExportBtn');
  assert.equal(win.location.href, '/api/jobs/test-job-12345678.xlsx');
  win.location.href = '';
  click('exportBtn');
  assert.equal(win.location.href, '/api/jobs/test-job-12345678.xlsx', 'same destination as bottom button');
});

test('ui top export: warnings allow export, errors block both buttons', async () => {
  const { T, el } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.equal(el('exportBtn').disabled, false);
  assert.equal(el('stickyExportBtn').disabled, false, 'warnings allow sticky export');
  assert.match(el('stickyState').innerHTML, /Warnings/, 'warning status shown clearly');

  T.state.job.issues.push({ id: 'V9', severity: 'error', target_type: 'table', target_id: 'T2', message: 'broken ref', source_pages: [2] });
  T.fn.renderExport();
  assert.equal(el('exportBtn').disabled, true);
  assert.equal(el('stickyExportBtn').disabled, true, 'errors block sticky export too');
  assert.match(el('stickyState').innerHTML, /Blocked/, 'blocked status shown clearly');

  T.state.job.issues = T.state.job.issues.filter((i) => i.severity !== 'error');
  T.fn.renderExport();
  assert.equal(el('exportBtn').disabled, false);
  assert.equal(el('stickyExportBtn').disabled, false);
});

test('ui top export: ready state only when nothing is flagged', async () => {
  const { T, el } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.ok(T.fn.countReviewSteps(T.draft.routines[1]) > 0, 'fixture has REVIEW steps');
  assert.match(el('stickyState').innerHTML, /Warnings/, 'REVIEW steps keep warning status');

  T.state.job.issues = [];
  T.draft.routines[1].expression_text = 'out = base * 2';
  assert.equal(T.fn.countReviewSteps(T.draft.routines[1]), 0);
  T.fn.renderExport();
  assert.match(el('stickyState').innerHTML, /Ready/, 'clear results show ready');
  assert.equal(el('stickyExportBtn').disabled, false);
});

test('ui top export: busy and clear prevent exporting incomplete results', async () => {
  const { T, el, win, click } = await makeUI();
  T.fn.setBusy(true);
  assert.equal(el('stickyBar').hidden, true, 'still hidden while extracting');
  T.fn.setBusy(false);

  T.fn.adoptJob(fixturePayload());
  T.fn.setBusy(true);
  assert.equal(el('stickyExportBtn').disabled, true, 'busy disables the sticky action');
  T.fn.setBusy(false);
  assert.equal(el('stickyExportBtn').disabled, el('exportBtn').disabled, 'sticky mirrors bottom after busy');

  win.confirmResult = true;
  click('clearBtn');
  assert.equal(el('stickyBar').hidden, true, 'clear hides the sticky action');
  assert.equal(el('stickyState').innerHTML, '');
  win.location.href = '';
  click('stickyExportBtn');
  assert.equal(win.location.href, '', 'no export without results');
});

test('ui top export: compact themed sticky bar above the workspace', async () => {
  const { html } = await makeUI();
  const barStart = html.indexOf('<div class="stickybar" id="stickyBar" hidden>');
  assert.ok(barStart >= 0, 'sticky bar markup present');
  assert.ok(barStart < html.indexOf('<main class="workspace"'), 'sticky bar sits above the workspace');
  const bar = html.slice(barStart, html.indexOf('</main>', barStart));
  assert.match(bar, /stickyExportBtn"[^>]*primary/, 'sticky action uses the primary button style');
  assert.ok(bar.includes('#i-export'), 'sticky action reuses the export icon');
  assert.ok(bar.includes('Export Excel'), 'sticky action keeps the Export Excel label');
  assert.ok(bar.includes('id="stickyDoc"'), 'document name shown');
  assert.ok(bar.includes('id="stickyState"'), 'status badge shown');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(style.includes('.stickybar'), 'sticky bar styled');
  assert.ok(style.includes('.sticky-export-btn'), 'compact sticky button styled');
  assert.ok(style.includes('.stickybar[hidden]'), 'sticky bar hides via hidden attribute');
  assert.ok(style.includes('[data-theme="dark"]'), 'dark theme block preserved');
  assert.ok(style.includes('@media (max-width: 560px)'), 'small-screen rules preserved');
});
