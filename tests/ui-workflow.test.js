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
      { id: 'T1', name: 'Clean Table', source_pages: [1], evidence_text: 'ev', headers: ['A'], rows: [['1']], purpose: '', applicability: '', effective_period: '', footnotes: [], notes: '', review_status: '' },
      { id: 'T2', name: 'Warn Table', source_pages: [2], evidence_text: 'ev', headers: ['Territory', 'Factor'], rows: [['T01', '1.35']], purpose: '', applicability: '', effective_period: '', footnotes: [], notes: '', review_status: '' },
    ],
    routines: [
      { id: 'R1', name: 'Clean Routine', kind: 'formula', source_pages: [1], evidence_text: 'ev', expression_text: 'a = b * 2', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
      { id: 'R4', name: 'Needs Review', kind: 'formula', source_pages: [3], evidence_text: 'ev', expression_text: 'APPLY legacy_matrix_v2 surcharge curve', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
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
    + 'get ui(){return ui},set ui(v){ui=v},fn:{computeStepDone,isKindComplete,'
    + 'itemNeedsReview,isAcknowledged,hasUnsavedEdits,countReviewSteps,adoptJob,'
    + 'clearSessionState,updateUploadLocks,updateSteps,acknowledgeCurrent,'
    + 'handleDetailInput,handleAction,openDetail,reviewBarHtml,rcRoutineStepRows,switchTab}};';
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

test('ui: table detail editor syncs (DetailCard id consistent)', async () => {
  const { html } = await makeUI();
  assert.ok(!html.includes('id="detailCard"'), 'no lowercase detailCard id remains');
  assert.equal((html.match(/id="DetailCard"/g) || []).length, 2);
});

test('ui: completion reflects reviews, not visits; ack counts as reviewed', async () => {
  const { T, stepDone } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.deepEqual({ ...T.fn.computeStepDone() }, { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false });
  assert.equal(T.fn.isKindComplete('tables'), false);
  assert.equal(T.fn.isKindComplete('routines'), false);
  assert.equal(T.fn.countReviewSteps(T.draft.routines[1]) > 0, true);

  T.fn.switchTab('tables');
  T.fn.switchTab('routines');
  assert.equal(stepDone(3), false);
  assert.equal(stepDone(4), false);

  T.draft.tables[1].review_status = 'pending';
  assert.equal(T.fn.itemNeedsReview('tables', T.draft.tables[1]), true);
  T.draft.tables[1].review_status = 'reviewed';
  assert.equal(T.fn.itemNeedsReview('tables', T.draft.tables[1]), false);
  assert.equal(T.fn.isKindComplete('tables'), true);
  T.fn.updateSteps();
  assert.equal(stepDone(3), true);
  assert.equal(stepDone(5), false);
  assert.equal(stepDone(6), false);

  for (const v of ['acknowledged', 'accepted', 'verified', ' Reviewed ']) {
    T.draft.routines[1].review_status = v;
    assert.equal(T.fn.itemNeedsReview('routines', T.draft.routines[1]), false, v);
  }
  T.draft.routines[1].review_status = 'reviewed';
  assert.equal(T.fn.isKindComplete('routines'), true);
  T.fn.updateSteps();
  assert.equal(stepDone(4), true);
  assert.equal(stepDone(5), true);
  assert.equal(stepDone(6), false);

  T.state.job.tables = structuredClone(T.draft.tables);
  T.state.job.routines = structuredClone(T.draft.routines);
  assert.equal(T.fn.hasUnsavedEdits(), false);
  assert.deepEqual({ ...T.fn.computeStepDone() }, { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });
  T.fn.updateSteps();
  assert.equal(stepDone(5), true);
  assert.equal(stepDone(6), true);

  T.draft.tables[1].review_status = '';
  assert.equal(T.fn.isKindComplete('tables'), false);
  T.fn.updateSteps();
  assert.equal(stepDone(3), false);
  assert.equal(stepDone(5), false);
  assert.equal(stepDone(6), false);
});

test('ui: editing clears acknowledgement and updates completion', async () => {
  const { T, stepDone } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  T.ui.mode = 'detail';
  T.detailCtx = { kind: 'routines', index: 1 };
  T.ui.tab = 'routines';
  T.ui.selectedId = 'R4';
  T.fn.acknowledgeCurrent(true);
  assert.equal(T.draft.routines[1].review_status, 'reviewed');
  assert.equal(T.fn.isKindComplete('routines'), true);

  T.detailCtx = { kind: 'routines', index: 1 };
  T.ui.mode = 'detail';
  T.fn.handleDetailInput();
  assert.equal(T.draft.routines[1].review_status, '');
  assert.equal(T.fn.itemNeedsReview('routines', T.draft.routines[1]), true);
  assert.equal(T.fn.isKindComplete('routines'), false);
  assert.equal(stepDone(4), false);

  T.draft.routines[1].expression_text = 'out = base * 2';
  T.state.job.issues = T.state.job.issues.filter((i) => !(i.target_type === 'routine' && i.target_id === 'R4'));
  assert.equal(T.fn.countReviewSteps(T.draft.routines[1]), 0);
  assert.equal(T.fn.itemNeedsReview('routines', T.draft.routines[1]), false);
});

test('ui: loading a PDF locks upload controls', async () => {
  const { T, el } = await makeUI();
  assert.equal(el('file').disabled, false);
  assert.equal(el('uploadBtn').disabled, false);
  assert.equal(el('sampleBtn').disabled, false);
  assert.equal(el('clearBtn').disabled, true);

  T.fn.adoptJob(fixturePayload());
  assert.equal(el('file').disabled, true);
  assert.equal(el('uploadBtn').disabled, true);
  assert.equal(el('sampleBtn').disabled, true);
  assert.equal(el('clearBtn').disabled, false);
});

test('ui: clearing resets session state without server deletes', async () => {
  const { T, el, win, fetchCalls, stepDone, click } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  T.draft.tables[0].name = 'edited';
  T.ui.tab = 'routines';
  T.ui.mode = 'detail';
  T.ui.selectedId = 'R1';
  T.detailCtx = { kind: 'routines', index: 0 };
  T.ui.search.routines = 'foo';
  T.ui.filter.routines = 'warnings';
  T.ui.page.routines = 2;
  el('file').value = 'something.pdf';
  win.confirmResult = true;
  win.confirmCalls.length = 0;
  const fetchBefore = fetchCalls.length;

  click('clearBtn');

  assert.equal(win.confirmCalls.length, 1);
  assert.match(win.confirmCalls[0], /unsaved edits/);
  assert.match(win.confirmCalls[0], /Saved jobs and exported files will be kept/);
  assert.equal(T.state, null);
  assert.equal(T.draft, null);
  assert.equal(T.detailCtx, null);
  assert.deepEqual({ ...T.ui.page }, { tables: 1, routines: 1 });
  assert.deepEqual({ ...T.ui.search }, { tables: '', routines: '' });
  assert.deepEqual({ ...T.ui.filter }, { tables: 'all', routines: 'all' });
  assert.equal(T.ui.tab, 'tables');
  assert.equal(T.ui.mode, 'list');
  assert.equal(T.ui.selectedId, null);
  assert.equal(el('jobSection').hidden, true);
  assert.equal(el('browseSection').hidden, true);
  assert.equal(el('reviewSection').hidden, true);
  assert.equal(el('exportSection').hidden, true);
  assert.equal(el('jobSummary').innerHTML, '');
  assert.equal(el('browser').innerHTML, '');
  assert.equal(el('issues').innerHTML, '');
  assert.equal(el('unresolved').innerHTML, '');
  assert.equal(el('exportStatus').innerHTML, '');
  assert.equal(el('exportReview').innerHTML, '');
  assert.equal(el('sideJob').textContent, '');
  assert.equal(el('resultMeta').textContent, '');
  assert.equal(el('file').value, '');
  assert.equal(el('searchInput').value, '');
  assert.equal(el('filterSelect').value, 'all');
  assert.equal(el('bottomBar').hidden, true);
  assert.equal(el('tablesCount').textContent, '0');
  assert.equal(el('routinesCount').textContent, '0');
  for (let n = 1; n <= 6; n += 1) assert.equal(stepDone(n), false);
  assert.equal(el('file').disabled, false);
  assert.equal(el('uploadBtn').disabled, false);
  assert.equal(el('sampleBtn').disabled, false);
  assert.equal(el('clearBtn').disabled, true);
  assert.match(el('status').textContent, /Session cleared/);
  assert.equal(fetchCalls.length, fetchBefore);
});

test('ui: clear cancellation preserves the session', async () => {
  const { T, el, win, click } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  T.draft.tables[0].name = 'edited-keep';
  T.ui.tab = 'routines';
  win.confirmResult = false;
  win.confirmCalls.length = 0;

  click('clearBtn');

  assert.equal(win.confirmCalls.length, 1);
  assert.ok(T.state !== null);
  assert.equal(T.draft.tables[0].name, 'edited-keep');
  assert.equal(T.ui.tab, 'routines');
  assert.equal(el('jobSection').hidden, false);
  assert.equal(el('browseSection').hidden, false);
  assert.equal(el('reviewSection').hidden, false);
  assert.equal(el('exportSection').hidden, false);
  assert.equal(el('file').disabled, true);
  assert.equal(el('clearBtn').disabled, false);
});

test('ui: clear confirmation omits unsaved warning when nothing edited', async () => {
  const { win, click, T } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  assert.equal(T.fn.hasUnsavedEdits(), false);
  win.confirmResult = false;
  win.confirmCalls.length = 0;
  click('clearBtn');
  assert.equal(win.confirmCalls.length, 1);
  assert.doesNotMatch(win.confirmCalls[0], /unsaved edits/);
  assert.match(win.confirmCalls[0], /Saved jobs and exported files will be kept/);
  assert.ok(T.state !== null);
});
