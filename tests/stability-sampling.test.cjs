const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function backgroundHarness() {
  let listener;
  let clock = 1000;
  let activeId = 7;
  const captures = [];
  const forwarded = [];
  const chrome = {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => [{}],
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) { forwarded.push(message); return { ok: true, fingerprint: [150] }; }
    },
    tabs: {
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
      query: async () => [{ id: activeId }],
      async captureVisibleTab() { captures.push(clock); return 'data:png'; }
    },
    storage: { session: { get: async () => ({}) } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'chrome-extension/background.js'), 'utf8'), {
    chrome, console, crypto: require('node:crypto').webcrypto, Date: { now: () => clock },
    setTimeout(callback, ms) { clock += ms; callback(); }
  });
  const send = (action, payload = {}) => new Promise((resolve) => listener({ action, region: {}, viewport: {}, ...payload }, {
    tab: { id: 7, active: true, windowId: 1 }
  }, resolve));
  return { send, captures, forwarded, switchTab: () => { activeId = 8; }, advance: (ms) => { clock += ms; } };
}

test('concurrent probes and region detection share Chrome capture rate limiting', async () => {
  const h = backgroundHarness();
  const results = await Promise.all([h.send('sample-region'), h.send('trim-black-borders'), h.send('sample-region')]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(h.captures, [1000, 1550, 2100]);
  assert.deepEqual(h.forwarded.map(({ action }) => action), ['sample-region', 'trim-black-borders', 'sample-region']);
});

test('a stale sender marked active cannot capture another tab', async () => {
  const h = backgroundHarness();
  h.switchTab();
  const result = await h.send('sample-region');
  assert.equal(result.ok, false);
  assert.match(result.error, /不在前台/);
  assert.equal(h.captures.length, 0);
  assert.equal(h.forwarded.length, 0);
});

test('saving the confirmed screen probe does not queue another Chrome screenshot', async () => {
  const h = backgroundHarness();
  const sample = await h.send('sample-region');
  const stored = await h.send('capture-and-store', { sampleId: sample.sampleId, sessionId: 'saved', index: 1 });
  assert.equal(stored.ok, true);
  assert.deepEqual(h.captures, [1000]);
  const crop = h.forwarded.find((message) => message.action === 'crop-store');
  assert.equal(crop.dataUrl, h.forwarded[0].dataUrl);
  assert.equal(crop.deferEncoding, true);
});

test('expired or mismatched screen probes require a fresh Chrome screenshot', async () => {
  for (const change of ['expired', 'wrong-token', 'new-region', 'new-viewport']) {
    const h = backgroundHarness();
    const sample = await h.send('sample-region');
    const payload = { sampleId: sample.sampleId, sessionId: 'saved', index: 1 };
    if (change === 'expired') h.advance(2100);
    if (change === 'wrong-token') payload.sampleId = 'unrelated';
    if (change === 'new-region') payload.region = { width: 100 };
    if (change === 'new-viewport') payload.viewport = { width: 600 };
    assert.equal((await h.send('capture-and-store', payload)).ok, true);
    assert.equal(h.captures.length, 2);
  }
});

test('a cached screen probe cannot bypass foreground checks or be consumed twice', async () => {
  const h = backgroundHarness();
  const sample = await h.send('sample-region');
  const payload = { sampleId: sample.sampleId, sessionId: 'saved', index: 1 };
  await h.send('capture-and-store', payload);
  await h.send('capture-and-store', payload);
  assert.equal(h.captures.length, 2);
  const other = backgroundHarness();
  const otherSample = await other.send('sample-region');
  other.switchTab();
  assert.equal((await other.send('capture-and-store', { ...payload, sampleId: otherSample.sampleId })).ok, false);
  assert.equal(other.captures.length, 1);
});

test('offscreen samples neither encode PNGs nor add pages or modify duplicate tracking', async () => {
  let listener;
  let pixel = 150;
  let encodes = 0;
  let closes = 0;
  class Canvas {
    getContext() {
      return { drawImage() {}, getImageData() {
        const pixels = new Uint8ClampedArray(64 * 64 * 4);
        for (let i = 0; i < pixels.length; i += 4) pixels.set([pixel, pixel, pixel, 255], i);
        return { data: pixels };
      } };
    }
    async convertToBlob() { encodes++; return new Blob([new Uint8Array([pixel])]); }
  }
  const context = {
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
    fetch: async () => ({ blob: async () => new Blob() }),
    createImageBitmap: async () => ({ width: 500, height: 500, close() { closes++; } }),
    OffscreenCanvas: Canvas,
    Uint8Array, Uint32Array, Uint8ClampedArray, DataView, Blob, TextEncoder, Date, URL, setTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'chrome-extension/offscreen.js'), 'utf8'), context);
  const send = (action) => new Promise((resolve) => listener({
    target: 'offscreen', action, sessionId: 'pages', filename: 'page_001.png', dataUrl: 'data:png',
    viewport: { width: 500, height: 500 }, region: { left: 0, top: 0, width: 500, height: 500 }
  }, {}, resolve));
  await send('begin');
  const first = await send('crop-store');
  assert.equal(first.count, 1);
  assert.equal(first.fingerprint.length, 4096);
  pixel = 20;
  const sample = await send('sample-region');
  assert.equal(sample.fingerprint[0], 20);
  assert.equal(encodes, 1);
  pixel = 150;
  const duplicate = await send('crop-store');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.count, 1);
  assert.equal(closes, 3);
});
