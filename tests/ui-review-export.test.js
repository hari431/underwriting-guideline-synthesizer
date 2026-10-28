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
  const fetchCalls = [];
  const fetchMock = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === '/api/health') return { json: async () => ({ ok: true, modelEnabled: false }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctx = { document: doc, window: win, fetch: fetchMock, structuredClone, console };
  vm.createContext(ctx);
  const hook = ';globalThis.__T={get state(){return state},set state(v){state=v},'
    + 'get draft(){return draft},set draft(v){draft=v},'
    + 'get detailCtx(){return detailCtx},set detailCtx(v){detailCtx=v},'
    + 'get ui(){return ui},set ui(v){ui=v},fn:{computeStepDone,'
    + 'itemNeedsReview,isAcknowledged,countReviewSteps,adoptJob,'
    + 'renderReview,renderExport,openReviewItem,updateSteps}};';
  vm.runInContext(inline + hook, ctx, { filename: 'ui-inline.js' });
  await new Promise((r) => setTimeout(r, 20));
  const T = ctx.__T;
  const el = (id) => doc.getElementById(id);
  const stepDone = (n) => doc._steps[n - 1].classList.contains('done');
  const click = (id) => {
    const fns = el(id).listeners.click || [];
    assert.ok(fns.length > 0, `${id} has click listener`);
    for (const fn of fns) fn();
  };
  return { html, doc, win, fetchCalls, T, el, stepDone, click };
}

function sectionBounds(html, id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `${id} section exists`);
  const end = html.indexOf('</section>', start);
  assert.ok(end > start, `${id} section closes`);
  return html.slice(start, end);
}

test('ui review/export: sidebar splits into Review and Export steps', async () => {
  const { html } = await makeUI();
  for (let n = 1; n <= 6; n += 1) {
    assert.ok(html.includes(`data-step="${n}"`), `sidebar step ${n} exists`);
  }
  assert.ok(!html.includes('Validate &amp; export'), 'combined label removed');
  assert.match(html, /data-step="5"[^>]*href="#reviewSection"/);
  assert.match(html, />Review<\//);
  assert.match(html, /data-step="6"[^>]*href="#exportSection"/);
  assert.match(html, />Export<\//);
});

test('ui review/export: sections own their responsibilities, export action near top', async () => {
  const { html } = await makeUI();
  const review = sectionBounds(html, 'reviewSection');
  assert.ok(review.includes('id="issues"'), 'review keeps validation issues');
  assert.ok(review.includes('id="unresolved"'), 'review lists unresolved items');
  assert.ok(review.includes('id="saveBtn"'), 'review keeps save & re-validate');
  assert.ok(!review.includes('id="exportBtn"'), 'export action leaves review');

  const exp = sectionBounds(html, 'exportSection');
  assert.ok(exp.includes('id="exportStatus"'), 'export shows validation status');
  assert.ok(exp.includes('id="exportBtn"'), 'export keeps Excel download');
  assert.ok(exp.includes('id="exportReview"'), 'export shows unresolved REVIEW items');
  assert.ok(
    exp.indexOf('id="exportBtn"') < exp.indexOf('id="exportReview"'),
    'Excel download sits near the top, above the REVIEW list',
  );
});

test('ui review/export: step completion splits review done from export ready', async () => {
  const { T, stepDone } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.deepEqual({ ...T.fn.computeStepDone() }, { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false });

  T.draft.tables[1].review_status = 'reviewed';
  T.draft.routines[1].review_status = 'reviewed';
  T.fn.updateSteps();
  assert.equal(stepDone(5), true);
  assert.equal(stepDone(6), false);

  T.state.job.tables = structuredClone(T.draft.tables);
  T.state.job.routines = structuredClone(T.draft.routines);
  assert.deepEqual({ ...T.fn.computeStepDone() }, { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });
  T.fn.updateSteps();
  assert.equal(stepDone(5), true);
  assert.equal(stepDone(6), true);
});

test('ui review/export: review lists unresolved items with source evidence', async () => {
  const { T, el } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  const body = el('unresolved').innerHTML;
  assert.match(body, /T2/);
  assert.match(body, /R4/);
  assert.match(body, /warn table excerpt from page two/);
  assert.match(body, /legacy surcharge excerpt from page three/);
  assert.match(body, /p\. 2/);
  assert.doesNotMatch(body, /Clean Table/);

  T.fn.openReviewItem('routines', 'R4');
  assert.equal(T.ui.tab, 'routines');
  assert.equal(T.ui.mode, 'detail');
  assert.equal(T.ui.selectedId, 'R4');
});

test('ui review/export: export allowed with warnings, blocked on errors', async () => {
  const { T, el } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.equal(el('exportBtn').disabled, false);
  assert.match(el('exportStatus').innerHTML, /warning/);

  T.state.job.issues.push({ id: 'V9', severity: 'error', target_type: 'table', target_id: 'T2', message: 'broken ref', source_pages: [2] });
  T.fn.renderExport();
  assert.equal(el('exportBtn').disabled, true);
  assert.match(el('exportStatus').innerHTML, /[Bb]lock/);

  T.state.job.issues = T.state.job.issues.filter((i) => i.severity !== 'error');
  T.fn.renderExport();
  assert.equal(el('exportBtn').disabled, false);
});

test('ui review/export: export clearly shows unresolved REVIEW steps', async () => {
  const { T, el } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.ok(T.fn.countReviewSteps(T.draft.routines[1]) > 0, 'fixture has REVIEW steps');
  assert.match(el('exportReview').innerHTML, /R4/);
  assert.match(el('exportReview').innerHTML, /REVIEW/);

  T.draft.routines[1].review_status = 'reviewed';
  T.fn.renderExport();
  assert.doesNotMatch(el('exportReview').innerHTML, /R4/);
});

test('ui review/export: clear resets both new views without server calls', async () => {
  const { T, el, win, fetchCalls, stepDone, click } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  win.confirmResult = true;
  const fetchBefore = fetchCalls.length;
  click('clearBtn');
  assert.equal(el('reviewSection').hidden, true);
  assert.equal(el('exportSection').hidden, true);
  assert.equal(el('issues').innerHTML, '');
  assert.equal(el('unresolved').innerHTML, '');
  assert.equal(el('exportStatus').innerHTML, '');
  assert.equal(el('exportReview').innerHTML, '');
  assert.equal(el('exportBtn').disabled, false);
  for (let n = 1; n <= 6; n += 1) assert.equal(stepDone(n), false);
  assert.equal(fetchCalls.length, fetchBefore);
  assert.deepEqual(fetchCalls, ['/api/health']);
});
