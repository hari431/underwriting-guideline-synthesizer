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
  const steps = [1, 2, 3, 4, 5].map((n) => {
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
    ],
    routines: [
      { id: 'R1', name: 'Clean Routine', kind: 'formula', source_pages: [1], evidence_text: 'ev', expression_text: 'a = b * 2', conditions: [], conditions_detailed: [], steps: [], steps_detailed: [], depends_on: [], dependencies: [], inputs: [], outputs: [], purpose: '', applicability: '', execution_context: '', notes: '', review_status: '' },
    ],
    issues: [],
    status: 'review',
    updated_at: new Date().toISOString(),
  };
  return { id: 'test-job-12345678', job, source: 'recorded' };
}

async function makeSpinnerUI() {
  const html = await fs.readFile('public/index.html', 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'inline script found');
  const inline = m[1];
  const doc = makeDocument();
  const win = { confirmCalls: [], confirmResult: true, confirm(msg) { this.confirmCalls.push(String(msg)); return this.confirmResult; }, location: { href: '' }, scrollTo() {} };
  const fetchCalls = [];
  const pending = { jobs: [], sample: [] };
  const fetchMock = async (url, opts = {}) => {
    fetchCalls.push(String(url));
    if (String(url) === '/api/health') return { json: async () => ({ ok: true, modelEnabled: false }) };
    if (String(url) === '/api/demo/sample') {
      return new Promise((resolve, reject) => pending.sample.push({ resolve, reject }));
    }
    if (String(url) === '/api/jobs') {
      return new Promise((resolve, reject) => pending.jobs.push({ resolve, reject }));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctx = { document: doc, window: win, fetch: fetchMock, structuredClone, console };
  vm.createContext(ctx);
  const hook = ';globalThis.__T={get state(){return state},set state(v){state=v},'
    + 'get draft(){return draft},set draft(v){draft=v},'
    + 'get isBusy(){return (typeof isBusy!=="undefined")?isBusy:undefined},'
    + 'set isBusy(v){if(typeof isBusy!=="undefined")isBusy=v},'
    + 'get ui(){return ui},set ui(v){ui=v},fn:{'
    + 'adoptJob,clearSessionState,updateUploadLocks,'
    + 'setBusy:(typeof setBusy!=="undefined")?setBusy:undefined}};';
  vm.runInContext(inline + hook, ctx, { filename: 'ui-inline.js' });
  await new Promise((r) => setTimeout(r, 20));
  const T = ctx.__T;
  const el = (id) => doc.getElementById(id);
  const clickAsync = (id) => {
    const fns = el(id).listeners.click || [];
    assert.ok(fns.length > 0, `${id} has click listener`);
    return Promise.all(fns.map((fn) => fn()));
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 10)); };
  const okRes = (payload, status = 201) => ({ ok: true, status, json: async () => payload });
  const errRes = (payload, status = 500) => ({ ok: false, status, json: async () => payload });
  return { html, inline, doc, win, fetchCalls, pending, T, el, clickAsync, settle, okRes, errRes };
}

test('ui spinner: upload shows spinner and disables controls, restores on success', async () => {
  const u = await makeSpinnerUI();
  u.el('file').files = [{ name: 'test.pdf' }];
  assert.equal(u.el('file').disabled, false);
  assert.equal(u.el('uploadBtn').disabled, false);
  assert.equal(u.el('sampleBtn').disabled, false);
  assert.equal(u.el('clearBtn').disabled, true);

  const done = u.clickAsync('uploadBtn');
  await u.settle();

  assert.equal(u.fetchCalls.filter((c) => c === '/api/jobs').length, 1);
  assert.equal(u.pending.jobs.length, 1);
  assert.equal(u.T.isBusy, true);
  assert.equal(u.el('file').disabled, true);
  assert.equal(u.el('uploadBtn').disabled, true);
  assert.equal(u.el('sampleBtn').disabled, true);
  assert.equal(u.el('clearBtn').disabled, true);
  assert.match(u.el('status').textContent, /Uploading and extracting/);
  assert.match(u.el('status').className, /loading/);

  u.pending.jobs[0].resolve(u.okRes(fixturePayload()));
  await done;

  assert.equal(u.T.isBusy, false);
  assert.match(u.el('status').textContent, /Extraction complete/);
  assert.doesNotMatch(u.el('status').className, /loading/);
  assert.doesNotMatch(u.el('status').className, /error/);
  assert.equal(u.el('file').disabled, true);
  assert.equal(u.el('uploadBtn').disabled, true);
  assert.equal(u.el('sampleBtn').disabled, true);
  assert.equal(u.el('clearBtn').disabled, false);
  assert.ok(u.T.state !== null);
});

test('ui spinner: upload failure stops spinner, restores controls, keeps error', async () => {
  const u = await makeSpinnerUI();
  u.el('file').files = [{ name: 'test.pdf' }];
  const done = u.clickAsync('uploadBtn');
  await u.settle();
  assert.equal(u.T.isBusy, true);

  u.pending.jobs[0].resolve(u.errRes({ error: 'Extraction failed', code: 'MODEL_DOWN', hint: 'try again' }));
  await done;

  assert.equal(u.T.isBusy, false);
  assert.match(u.el('status').textContent, /Extraction failed/);
  assert.match(u.el('status').className, /error/);
  assert.doesNotMatch(u.el('status').className, /loading/);
  assert.equal(u.el('file').disabled, false);
  assert.equal(u.el('uploadBtn').disabled, false);
  assert.equal(u.el('sampleBtn').disabled, false);
  assert.equal(u.el('clearBtn').disabled, true);
  assert.equal(u.T.state, null);
});

test('ui spinner: sample reuses the same loading state and blocks duplicates', async () => {
  const u = await makeSpinnerUI();
  const done = u.clickAsync('sampleBtn');
  await u.settle();

  assert.equal(u.fetchCalls.filter((c) => c === '/api/demo/sample').length, 1);
  assert.equal(u.T.isBusy, true);
  assert.equal(u.el('file').disabled, true);
  assert.equal(u.el('uploadBtn').disabled, true);
  assert.equal(u.el('sampleBtn').disabled, true);
  assert.equal(u.el('clearBtn').disabled, true);
  assert.match(u.el('status').textContent, /Loading sample/);
  assert.match(u.el('status').className, /loading/);

  const dup = u.clickAsync('sampleBtn');
  await u.settle();
  assert.equal(u.fetchCalls.filter((c) => c === '/api/demo/sample').length, 1);
  assert.equal(u.pending.sample.length, 1);
  await dup;

  u.pending.sample[0].resolve(u.okRes(fixturePayload()));
  await done;

  assert.equal(u.T.isBusy, false);
  assert.match(u.el('status').textContent, /Sample loaded/);
  assert.doesNotMatch(u.el('status').className, /loading/);
  assert.equal(u.el('file').disabled, true);
  assert.equal(u.el('clearBtn').disabled, false);
});

test('ui spinner: single shared busy flag, no duplicate loading state', async () => {
  const u = await makeSpinnerUI();
  assert.ok(u.T.fn.setBusy, 'shared setBusy helper exists');
  const decls = (u.inline.match(/let\s+isBusy\b/g) || []).length;
  assert.equal(decls, 1);
  assert.doesNotMatch(u.inline, /isUploading|isSampleLoading|isLoading\b/);
  assert.match(u.inline, /updateUploadLocks[\s\S]*isBusy|isBusy[\s\S]*updateUploadLocks/);
});

test('ui spinner: animated rotating spinner styles with reduced-motion fallback', async () => {
  const u = await makeSpinnerUI();
  assert.match(u.html, /@keyframes\s+\w*[Ss]pin/);
  assert.match(u.html, /#status\.loading/);
  assert.match(u.html, /animation:/);
  assert.match(u.html, /prefers-reduced-motion/);
});
