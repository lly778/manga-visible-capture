const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness({ failTab = false, capture, realOffscreen = false } = {}) {
  const listeners = {};
  const storage = {};
  const files = new Map();
  const tabs = [];
  let offscreenListener;
  const offscreenContext = {
    chrome: { runtime: { onMessage: { addListener(fn) { offscreenListener = fn; } } } },
    Uint8Array, Uint32Array, DataView, Blob, TextEncoder, Date, URL, setTimeout
  };
  if (realOffscreen) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/offscreen.js'), 'utf8'), offscreenContext);
  }
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
        if (offscreenListener) return new Promise(resolve => offscreenListener(message, {}, resolve));
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
      query: async () => [{ id: 7 }],
      captureVisibleTab: capture || (async () => 'data:image/png;base64,test')
    },

  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'background.js'), 'utf8');
  let clock = 1000;
  vm.runInNewContext(source, {
    chrome, console, Date: { now: () => clock },
    setTimeout(callback, ms) {
      if (ms < 60000) { clock += ms; callback(); }
      return 0;
    }
  });

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
  return { listeners, storage, files, tabs, message, waitFor, offscreenContext };
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

for (const completed of [0, 1]) {
  test(`navigation waits for a screenshot still being captured (${completed} earlier pages)`, async () => {
    let releaseCapture;
    let captureStarted = false;
    let pause = false;
    const h = createHarness({ capture: async () => {
      if (!pause) return 'data:image/png;base64,test';
      captureStarted = true;
      return new Promise(resolve => { releaseCapture = () => resolve('data:image/png;base64,test'); });
    } });
    await h.message('begin-capture-session', { sessionId: 'in-flight' });
    if (completed) await h.message('capture-and-store', { sessionId: 'in-flight', index: 1 });
    pause = true;
    const capturing = h.message('capture-and-store', { sessionId: 'in-flight', index: completed + 1 });
    await h.waitFor(() => captureStarted);
    h.listeners.updated(7, { status: 'loading' });
    await new Promise(setImmediate);
    assert.equal(h.tabs.length, 0, 'export must wait for the requested screenshot');
    assert.ok(h.files.has('in-flight'), 'navigation must not discard a pending first screenshot');
    releaseCapture();
    assert.equal((await capturing).ok, true);
    await h.waitFor(() => h.tabs.length === 1);
    assert.equal(h.storage['vmc-export-in-flight'].count, completed + 1);
  });
}

test('explicit stop waits for capture even before the screenshot API returns', async () => {
  let releaseCapture;
  const h = createHarness({ capture: () => new Promise(resolve => {
    releaseCapture = () => resolve('data:image/png;base64,test');
  }) });
  await h.message('begin-capture-session', { sessionId: 'stopping' });
  const capturing = h.message('capture-and-store', { sessionId: 'stopping', index: 1 });
  await h.waitFor(() => releaseCapture);
  const exporting = h.message('export-capture-session', { sessionId: 'stopping' });
  await new Promise(setImmediate);
  assert.equal(h.tabs.length, 0);
  releaseCapture();
  assert.equal((await capturing).ok, true);
  const result = await exporting;
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});

test('navigation exports both pages through the real ZIP encoder after capture and encoding finish', async () => {
  let releaseCapture;
  let frame = 0;
  const encoding = [];
  const h = createHarness({ realOffscreen: true, capture: async () => {
    if (frame === 0) return 'data:image/png;base64,test';
    return new Promise(resolve => { releaseCapture = () => resolve('data:image/png;base64,test'); });
  } });
  h.offscreenContext.cropToBytes = async () => {
    const index = ++frame;
    return { fingerprint: new Uint8Array(4096).fill(index * 100),
      encode: () => new Promise(resolve => encoding.push(() => resolve(new Uint8Array([index, 77, 88])))) };
  };
  await h.message('begin-capture-session', { sessionId: 'zip-race' });
  await h.message('capture-and-store', { sessionId: 'zip-race', index: 1 });
  const capturing = h.message('capture-and-store', { sessionId: 'zip-race', index: 2 });
  await h.waitFor(() => releaseCapture);
  h.listeners.updated(7, { status: 'loading' });
  await new Promise(setImmediate);
  releaseCapture();
  assert.equal((await capturing).ok, true);
  encoding[0]();
  await new Promise(setImmediate);
  assert.equal(h.tabs.length, 0, 'second PNG must be ready before opening the save page');
  encoding[1]();
  await h.waitFor(() => h.tabs.length === 1);
  const exported = h.storage['vmc-export-zip-race'];
  assert.equal(exported.count, 2);
  const zip = Buffer.from(await (await fetch(exported.url)).arrayBuffer());
  for (const index of [1, 2]) {
    assert.ok(zip.includes(Buffer.from(`page_00${index}.png`)));
    assert.ok(zip.includes(Buffer.from([index, 77, 88])));
  }
  URL.revokeObjectURL(exported.url);
});
