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
  removeAttribute(k) { delete this.attributes[k]; }
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

function makeStorage(seed = {}) {
  const store = { ...seed };
  return {
    _store: store,
    getItem(k) { return Object.hasOwn(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
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
  for (const id of ['upload', 'jobSection', 'browseSection', 'reviewSection', 'exportSection', 'workspace']) {
    getOrCreate(id);
  }
  return {
    _els: els,
    _steps: steps,
    documentElement: new MockEl('html'),
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

async function makeUI({ storageSeed = {} } = {}) {
  const html = await fs.readFile('public/index.html', 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'inline script found');
  const inline = m[1];
  const doc = makeDocument();
  const storage = makeStorage(storageSeed);
  const win = {
    confirmCalls: [],
    confirmResult: true,
    confirm(msg) { this.confirmCalls.push(String(msg)); return this.confirmResult; },
    location: { href: '' },
    scrollTo() {},
  };
  const consoleErrors = [];
  const consoleSpy = {
    log() {}, info() {}, warn() {},
    error(...args) { consoleErrors.push(args.map(String).join(' ')); },
  };
  const fetchMock = async (url) => {
    if (String(url) === '/api/health') return { json: async () => ({ ok: true, modelEnabled: false }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctx = { document: doc, window: win, fetch: fetchMock, structuredClone, console: consoleSpy, localStorage: storage };
  vm.createContext(ctx);
  const hook = ';globalThis.__T={get state(){return state},set state(v){state=v},'
    + 'get draft(){return draft},set draft(v){draft=v},'
    + 'get ui(){return ui},set ui(v){ui=v},'
    + 'get activeStep(){return (typeof activeStep!=="undefined")?activeStep:undefined},'
    + 'fn:{adoptJob,updateSteps,switchTab,openDetail,backToList,renderReview,renderExport,'
    + 'rcApplyTheme:(typeof rcApplyTheme!=="undefined")?rcApplyTheme:undefined,'
    + 'rcCurrentTheme:(typeof rcCurrentTheme!=="undefined")?rcCurrentTheme:undefined,'
    + 'rcToggleTheme:(typeof rcToggleTheme!=="undefined")?rcToggleTheme:undefined}};';
  vm.runInContext(inline + hook, ctx, { filename: 'ui-inline.js' });
  await new Promise((r) => setTimeout(r, 20));
  const T = ctx.__T;
  const el = (id) => doc.getElementById(id);
  const themeAttr = () => doc.documentElement.getAttribute('data-theme');
  const click = (id) => {
    const fns = el(id).listeners.click || [];
    assert.ok(fns.length > 0, `${id} has click listener`);
    for (const fn of fns) fn();
  };
  return { html, doc, win, storage, consoleErrors, T, el, themeAttr, click };
}

test('ui theme: toggle present in sidebar, light default for first-time visitors', async () => {
  const { html, T, el, themeAttr } = await makeUI();
  assert.match(html, /<aside class="sidebar">[\s\S]*id="themeToggle"[\s\S]*<\/aside>/, 'toggle lives in sidebar');
  assert.match(html, /id="themeToggle"[^>]*aria-label="[^"]*(dark|light)[^"]*"/i, 'toggle labelled');
  assert.ok(html.includes('id="i-moon"'), 'moon icon exists');
  assert.ok(html.includes('id="i-sun"'), 'sun icon exists');
  assert.ok(T.fn.rcApplyTheme && T.fn.rcCurrentTheme && T.fn.rcToggleTheme, 'theme helpers exist');
  assert.equal(T.fn.rcCurrentTheme(), 'light', 'first visit defaults to light');
  assert.equal(themeAttr(), null, 'no dark attribute by default');
  assert.equal(el('themeToggle').getAttribute('aria-pressed'), 'false');
  assert.match(el('themeLabel').textContent, /dark/i, 'toggle offers dark mode');
});

test('ui theme: toggle switches instantly, persists, and keeps PDF edits and review state', async () => {
  const { T, el, storage, themeAttr, click } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  T.draft.tables[0].name = 'Edited Table Name';
  T.fn.switchTab('routines');
  T.fn.openDetail('R1');
  const before = JSON.stringify({ state: T.state, draft: T.draft, ui: T.ui, activeStep: T.activeStep });

  click('themeToggle');
  assert.equal(T.fn.rcCurrentTheme(), 'dark');
  assert.equal(themeAttr(), 'dark', 'dark attribute applied instantly');
  assert.equal(storage.getItem('ratecraft.theme'), 'dark', 'preference persisted');
  assert.equal(el('themeToggle').getAttribute('aria-pressed'), 'true');
  assert.match(el('themeLabel').textContent, /light/i, 'toggle offers to switch back');
  assert.equal(JSON.stringify({ state: T.state, draft: T.draft, ui: T.ui, activeStep: T.activeStep }), before, 'no state lost');

  click('themeToggle');
  assert.equal(T.fn.rcCurrentTheme(), 'light');
  assert.equal(themeAttr(), null, 'dark attribute removed');
  assert.equal(storage.getItem('ratecraft.theme'), 'light');
  assert.equal(JSON.stringify({ state: T.state, draft: T.draft, ui: T.ui, activeStep: T.activeStep }), before, 'still no state lost');
});

test('ui theme: stored preference restored on reload, invalid values fall back to light', async () => {
  const dark = await makeUI({ storageSeed: { 'ratecraft.theme': 'dark' } });
  assert.equal(dark.T.fn.rcCurrentTheme(), 'dark', 'reload restores dark');
  assert.equal(dark.themeAttr(), 'dark');
  assert.match(dark.el('themeLabel').textContent, /light/i);

  const light = await makeUI({ storageSeed: { 'ratecraft.theme': 'light' } });
  assert.equal(light.T.fn.rcCurrentTheme(), 'light');
  assert.equal(light.themeAttr(), null);

  const bogus = await makeUI({ storageSeed: { 'ratecraft.theme': 'midnight' } });
  assert.equal(bogus.T.fn.rcCurrentTheme(), 'light', 'invalid value falls back to light');
  assert.equal(bogus.themeAttr(), null);
});

test('ui theme: dark styles cover surfaces, inputs, badges, review items, and tables', async () => {
  const { html } = await makeUI();
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(style.includes('[data-theme="dark"]'), 'dark theme block exists');
  assert.ok(style.includes('color-scheme'), 'native controls follow theme');
  for (const sel of ['button', 'input', '.pill', '.review-item', 'table.grid', '.bottombar', '.issue', '.evidence', '.tabs', '.toolbar', '.item-card', '.sidebar']) {
    assert.ok(style.includes(`[data-theme="dark"]`) && new RegExp(`\\[data-theme="dark"\\][^{]*${sel.replace(/\./g, '\\.')}`).test(style), `dark override for ${sel}`);
  }
  for (const v of ['--bg', '--panel', '--panel-soft', '--ink', '--muted', '--line']) {
    assert.ok(new RegExp(`\\[data-theme="dark"\\]\\s*\\{[^}]*${v}\\s*:`).test(style), `dark redefines ${v}`);
  }
  assert.match(style, /details\.review-item\[open\]|\.review-item\[open\]/, 'expanded review items styled');
});

test('ui polish: compact upload flow, resilient long text, responsive behavior preserved', async () => {
  const { html } = await makeUI();
  assert.ok(html.includes('flow-strip'), 'compact Upload → Review → Export visual exists');
  const artStart = html.indexOf('class="upload-art"');
  const artEnd = html.indexOf('id="status"');
  const art = html.slice(artStart, artEnd);
  assert.match(art, /Upload[\s\S]*Review[\s\S]*Export/, 'flow shows the three stages in order');
  assert.ok(html.includes('#upload:has(+ #jobSection:not([hidden])) .upload-art'), 'art still hides after load');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(style.includes('text-overflow: ellipsis'), 'long card names truncate');
  assert.ok(style.includes('overflow-wrap: anywhere'), 'long names and details wrap without breaking layout');
  assert.ok(style.includes('@media (max-width: 900px)'), 'responsive breakpoint preserved');
  assert.ok(style.includes('prefers-reduced-motion'), 'reduced-motion support preserved');
  for (let n = 1; n <= 6; n += 1) assert.ok(html.includes(`data-step="${n}"`), `sidebar step ${n} intact`);
  assert.ok(html.includes('id="clearBtn"'), 'Clear PDF control intact');
  assert.ok(html.includes('<section id="reviewSection"'), 'review section intact');
  assert.ok(html.includes('<section id="exportSection"'), 'export section intact');
});

test('ui theme: themed flows run without console errors', async () => {
  const { T, consoleErrors, click } = await makeUI();
  T.fn.adoptJob(fixturePayload());
  T.fn.switchTab('routines');
  T.fn.openDetail('R1');
  T.fn.backToList();
  click('themeToggle');
  T.fn.renderReview();
  T.fn.renderExport();
  T.fn.updateSteps();
  click('themeToggle');
  assert.deepEqual(consoleErrors, [], 'no console errors across upload, tables, routines, review, export');
});
