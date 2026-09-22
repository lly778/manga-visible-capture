const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness({ failTab = false } = {}) {
  const listeners = {};
  const storage = {};
  const files = new Map();
  const tabs = [];
  const chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: storage[key] }; },
        async set(values) { Object.assign(storage, values); },
        async remove(key) { delete storage[key]; }
      }
    },
    runtime: {
      id: 'test',
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => [{}],
      onMessage: { addListener(listener) { listeners.message = listener; } },
      async sendMessage(message) {
        if (message.action === 'begin') {
          files.set(message.sessionId, []);
          return { ok: true };
        }
        if (message.action === 'crop-store') {
          const pages = files.get(message.sessionId);
          if (!pages) return { ok: false, error: 'missing session' };
          pages.push(message.filename);
          return { ok: true, count: pages.length };
        }
        if (message.action === 'prepare-export') {
          const pages = files.get(message.sessionId);
          return pages?.length
            ? { ok: true, url: `blob:chrome-extension://test/${message.sessionId}`, count: pages.length, size: 100 }
            : { ok: false, error: 'no pages' };
        }
        if (message.action === 'finish-export' || message.action === 'discard') {
          files.delete(message.sessionId);
          return { ok: true };
        }
        return { ok: false, error: 'unknown action' };
      }
    },
    offscreen: { async createDocument() {} },
    tabs: {
      async create(options) {
        if (failTab) throw new Error('tab failed');
        tabs.push(options);
        return { id: 99 };
      },
      onUpdated: { addListener(listener) { listeners.updated = listener; } },
      onRemoved: { addListener(listener) { listeners.removed = listener; } },
      captureVisibleTab: async () => 'data:image/png;base64,test'
    },

  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'background.js'), 'utf8');
  vm.runInNewContext(source, { chrome, console, setTimeout: () => 0 });

  const sender = { tab: { id: 7, active: true, windowId: 1 } };
  const message = (action, payload = {}, source = sender) => new Promise((resolve) => {
    listeners.message({ action, ...payload }, source, resolve);
  });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 30 && !predicate(); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), 'expected background action did not complete');
  };
  return { listeners, storage, files, tabs, message, waitFor };
}

test('full-page navigation exports the captured pages', async () => {
  const h = createHarness();
  assert.equal((await h.message('begin-capture-session', {
    sessionId: 'session-1', zipName: '漫画标题'
  })).ok, true);
  assert.equal((await h.message('capture-and-store', {
    sessionId: 'session-1', index: 1, region: {}, viewport: {}
  })).ok, true);
  h.listeners.updated(7, { status: 'loading' });
  await h.waitFor(() => h.tabs.length === 1);
  assert.equal(h.storage['vmc-export-session-1'].filename, '漫画标题.zip');
  assert.equal(h.files.has('session-1'), true);
  assert.equal(h.storage['vmc-capture-7'], undefined);
});

test('no download permission or filename listener remains', () => {
  const h = createHarness();
  assert.equal(h.listeners.filename, undefined);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'manifest.json')));
  assert.equal(manifest.permissions.includes('downloads'), false);
});

test('failed save-tab opening retains the ZIP for recovery', async () => {
  const h = createHarness({ failTab: true });
  await h.message('begin-capture-session', { sessionId: 'failed' });
  await h.message('capture-and-store', { sessionId: 'failed', index: 1 });
  const result = await h.message('export-capture-session', { sessionId: 'failed', zipName: '漫画标题' });
  assert.equal(result.ok, false);
  assert.equal(h.storage['vmc-export-failed'].filename, '漫画标题.zip');
  assert.equal(h.files.has('failed'), true);
});

test('only a save page can release a saved export', async () => {
  const h = createHarness();
  await h.message('begin-capture-session', { sessionId: 'saved' });
  await h.message('capture-and-store', { sessionId: 'saved', index: 1 });
  await h.message('export-capture-session', { sessionId: 'saved', zipName: '漫画标题' });
  assert.equal((await h.message('complete-saved-export', { sessionId: 'saved' })).ok, false);
  assert.ok(h.storage['vmc-export-saved']);
  const result = await h.message('complete-saved-export', { sessionId: 'saved' }, { url: 'chrome-extension://test/save.html#saved' });
  assert.equal(result.ok, true);
  assert.equal(h.storage['vmc-export-saved'], undefined);
  assert.equal(h.files.has('saved'), false);
});

test('navigation and content-script stop share a single export', async () => {
  const h = createHarness();
  await h.message('begin-capture-session', { sessionId: 'session-2', zipName: '漫画标题' });
  await h.message('capture-and-store', {
    sessionId: 'session-2', index: 1, region: {}, viewport: {}
  });
  h.listeners.updated(7, { status: 'loading' });
  const result = await h.message('export-capture-session', {
    sessionId: 'session-2', zipName: '漫画标题'
  });
  assert.equal(result.ok, true);
  assert.equal(h.tabs.length, 1);
});

test('navigation before the first screenshot discards the empty session', async () => {
  const h = createHarness();
  await h.message('begin-capture-session', { sessionId: 'session-3', zipName: '漫画标题' });
  h.listeners.updated(7, { status: 'loading' });
  await h.waitFor(() => h.storage['vmc-capture-7'] === undefined);
  assert.equal(h.tabs.length, 0);
  assert.equal(h.files.has('session-3'), false);
});

test('closing the tab exports captured pages', async () => {
  const h = createHarness();
  await h.message('begin-capture-session', { sessionId: 'session-4', zipName: '漫画标题' });
  await h.message('capture-and-store', {
    sessionId: 'session-4', index: 1, region: {}, viewport: {}
  });
  h.listeners.removed(7);
  await h.waitFor(() => h.tabs.length === 1);
  assert.equal(h.storage['vmc-export-session-4'].filename, '漫画标题.zip');
  assert.equal(h.files.has('session-4'), true);
});

test('background does not answer messages addressed to the offscreen document', () => {
  const h = createHarness();
  let responded = false;
  const handled = h.listeners.message({
    target: 'offscreen', action: 'trim-black-borders', region: {}, viewport: {}
  }, {}, () => { responded = true; });
  assert.equal(handled, undefined);
  assert.equal(responded, false);
});
