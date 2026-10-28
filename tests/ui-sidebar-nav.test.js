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
    this._rect = null;
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
  getBoundingClientRect() {
    if (this._rect) return this._rect;
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
}

function makeDocument() {
  const els = new Map();
  const steps = [1, 2, 3, 4, 5, 6].map((n) => {
    const el = new MockEl(`step${n}`);
    el.dataset.step = String(n);
    return el;
  });
  const getOrCreate = (id) => {
    if (!els.has(id)) els.set(id, new MockEl(id));
    return els.get(id);
  };
  // Pre-create workflow sections + workspace so scroll targets exist.
  for (const id of ['upload', 'jobSection', 'browseSection', 'reviewSection', 'exportSection', 'workspace']) {
    getOrCreate(id);
  }
  return {
    _els: els,
    _steps: steps,
    getElementById(id) {
      return getOrCreate(id);
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
  const fetchMock = async (url) => {
    if (String(url) === '/api/health') return { json: async () => ({ ok: true, modelEnabled: false }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctx = { document: doc, window: win, fetch: fetchMock, structuredClone, console };
  vm.createContext(ctx);
  const hook = ';globalThis.__T={get state(){return state},set state(v){state=v},'
    + 'get draft(){return draft},set draft(v){draft=v},'
    + 'get ui(){return ui},set ui(v){ui=v},'
    + 'get activeStep(){return (typeof activeStep!=="undefined")?activeStep:undefined},'
    + 'fn:{computeStepDone,adoptJob,updateSteps,switchTab,'
    + 'setActiveStep:(typeof setActiveStep!=="undefined")?setActiveStep:undefined,'
    + 'updateActiveFromSection:(typeof updateActiveFromSection!=="undefined")?updateActiveFromSection:undefined,'
    + 'updateActiveOnScroll:(typeof updateActiveOnScroll!=="undefined")?updateActiveOnScroll:undefined,'
    + 'sectionIdForStep:(typeof sectionIdForStep!=="undefined")?sectionIdForStep:undefined,'
    + 'stepForSectionId:(typeof stepForSectionId!=="undefined")?stepForSectionId:undefined}};';
  vm.runInContext(inline + hook, ctx, { filename: 'ui-inline.js' });
  await new Promise((r) => setTimeout(r, 20));
  const T = ctx.__T;
  const el = (id) => doc.getElementById(id);
  const stepEl = (n) => doc._steps[n - 1];
  const isActive = (n) => stepEl(n).classList.contains('active');
  const isDone = (n) => stepEl(n).classList.contains('done');
  const activeStep = () => {
    for (let n = 1; n <= 6; n += 1) if (isActive(n)) return n;
    return null;
  };
  const clickStep = (n) => {
    const fns = stepEl(n).listeners.click || [];
    assert.ok(fns.length > 0, `step ${n} has click listener`);
    let prevented = false;
    const ev = { preventDefault() { prevented = true; } };
    for (const fn of fns) fn(ev);
    return { prevented };
  };
  return { html, doc, win, T, el, stepEl, isActive, isDone, activeStep, clickStep };
}

test('ui sidebar nav: Review and Export are separate targets with correct section IDs', async () => {
  const { html, T } = await makeUI();
  assert.match(html, /data-step="5"[^>]*href="#reviewSection"/);
  assert.match(html, /data-step="6"[^>]*href="#exportSection"/);
  assert.ok(html.includes('<section id="reviewSection"'), 'review section exists');
  assert.ok(html.includes('<section id="exportSection"'), 'export section exists');
  assert.ok(T.fn.sectionIdForStep, 'sectionIdForStep helper exists');
  assert.equal(T.fn.sectionIdForStep(5), 'reviewSection');
  assert.equal(T.fn.sectionIdForStep(6), 'exportSection');
  assert.notEqual(T.fn.sectionIdForStep(5), T.fn.sectionIdForStep(6));
});

test('ui sidebar nav: clicking a sidebar item scrolls to its section and updates active', async () => {
  const { T, el, activeStep, clickStep } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  const targets = { 1: 'upload', 2: 'jobSection', 3: 'browseSection', 4: 'browseSection', 5: 'reviewSection', 6: 'exportSection' };
  for (const [nStr, sectionId] of Object.entries(targets)) {
    const n = Number(nStr);
    el(sectionId).scrollIntoViewCalls = 0;
    clickStep(n);
    assert.equal(el(sectionId).scrollIntoViewCalls, 1, `step ${n} scrolls to ${sectionId}`);
    assert.equal(activeStep(), n, `step ${n} becomes active after click`);
  }
  // Tables/Routines share one section but switch tabs.
  clickStep(3);
  assert.equal(T.ui.tab, 'tables');
  clickStep(4);
  assert.equal(T.ui.tab, 'routines');
});

test('ui sidebar nav: manual scrolling updates the active item', async () => {
  const { T, el, activeStep } = await makeUI();
  assert.ok(T.fn.updateActiveFromSection, 'scroll-spy updater exists');
  T.fn.adoptJob(fixturePayload());
  // Workspace exposes a scroll listener for manual scrolling.
  assert.ok((el('workspace').listeners.scroll || []).length > 0, 'workspace has scroll listener');

  T.fn.updateActiveFromSection('reviewSection');
  assert.equal(activeStep(), 5);
  T.fn.updateActiveFromSection('exportSection');
  assert.equal(activeStep(), 6);
  T.fn.updateActiveFromSection('jobSection');
  assert.equal(activeStep(), 2);

  // Browse maps to the current tab.
  T.ui.tab = 'tables';
  T.fn.updateActiveFromSection('browseSection');
  assert.equal(activeStep(), 3);
  T.ui.tab = 'routines';
  T.fn.updateActiveFromSection('browseSection');
  assert.equal(activeStep(), 4);

  // Scroll-position resolver picks the section at the top of the viewport.
  if (T.fn.updateActiveOnScroll) {
    const rect = (top) => ({ top, bottom: top + 400, left: 0, right: 0, width: 0, height: 400 });
    el('upload')._rect = rect(-1000);
    el('jobSection')._rect = rect(-800);
    el('browseSection')._rect = rect(-600);
    el('reviewSection')._rect = rect(10);
    el('exportSection')._rect = rect(900);
    for (const id of ['upload', 'jobSection', 'browseSection', 'reviewSection', 'exportSection']) el(id).hidden = false;
    T.fn.updateActiveOnScroll();
    assert.equal(activeStep(), 5, 'visible review section becomes active on scroll');
  }
});

test('ui sidebar nav: ticks only for completed stages; current highlighted, future numbered', async () => {
  const { T, isActive, isDone, activeStep, clickStep } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  // Initially only Upload + Extract are genuinely complete.
  assert.deepEqual({ ...T.fn.computeStepDone() }, { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false });
  assert.equal(isDone(1), true);
  assert.equal(isDone(2), true);
  assert.equal(isDone(3), false);
  assert.equal(isDone(4), false);
  assert.equal(isDone(5), false);
  assert.equal(isDone(6), false);

  // Navigating never marks stages complete: only active changes.
  const before = { ...T.fn.computeStepDone() };
  clickStep(5);
  assert.equal(activeStep(), 5, 'review highlighted after click');
  assert.deepEqual({ ...T.fn.computeStepDone() }, before, 'clicking does not complete stages');
  assert.equal(isDone(5), false, 'current incomplete stage shows no tick');
  T.fn.updateActiveFromSection('exportSection');
  assert.equal(activeStep(), 6);
  assert.deepEqual({ ...T.fn.computeStepDone() }, before, 'scrolling does not complete stages');
  assert.equal(isDone(6), false);

  // Completing tables ticks only that stage; other states follow the review model.
  T.draft.tables[1].review_status = 'reviewed';
  T.fn.updateSteps();
  assert.equal(isDone(3), true);
  assert.equal(isDone(4), false);
  assert.equal(isDone(5), false);
  assert.equal(isDone(6), false);

  // Completing everything ticks Review; Export also needs saved edits.
  T.draft.routines[1].review_status = 'reviewed';
  T.fn.updateSteps();
  assert.equal(isDone(4), true);
  assert.equal(isDone(5), true);
  assert.equal(isDone(6), false, 'export waits for save');
  T.state.job.tables = structuredClone(T.draft.tables);
  T.state.job.routines = structuredClone(T.draft.routines);
  T.fn.updateSteps();
  assert.equal(isDone(6), true);

  // Exactly one stage highlighted at a time.
  let actives = 0;
  for (let n = 1; n <= 6; n += 1) if (isActive(n)) actives += 1;
  assert.equal(actives, 1, 'exactly one active highlight');
});
