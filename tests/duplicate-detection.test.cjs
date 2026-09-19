const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function samePage(previous, current) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'offscreen.js'), 'utf8');
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
    Uint8Array, Uint32Array, DataView, Blob, TextEncoder, Date, URL, setTimeout
  };
  vm.runInNewContext(source, context);
  return context.samePageFingerprint(previous, current);
}

test('small animated or rendering changes do not create a new manga page', () => {
  const previous = new Uint8Array(64 * 64).fill(150);
  const current = previous.slice();
  current.fill(190, 0, 60);
  assert.equal(samePage(previous, current), true);
});

test('a substantially different manga page is not treated as a duplicate', () => {
  const previous = new Uint8Array(64 * 64).fill(150);
  const current = previous.slice();
  current.fill(40, 0, 300);
  assert.equal(samePage(previous, current), false);
});

test('a broad brightness change is not silently treated as the same page', () => {
  const previous = new Uint8Array(64 * 64).fill(150);
  const current = new Uint8Array(64 * 64).fill(160);
  assert.equal(samePage(previous, current), false);
});

test('a near-duplicate capture is not stored as another ZIP page', async () => {
  let listener;
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'offscreen.js'), 'utf8');
  const context = {
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
    Uint8Array, Uint32Array, DataView, Blob, TextEncoder, Date, URL, setTimeout
  };
  vm.runInNewContext(source, context);
  const first = new Uint8Array(64 * 64).fill(150);
  const second = first.slice();
  second.fill(190, 0, 60);
  const frames = [
    { bytes: new Uint8Array([1, 2]), fingerprint: first },
    { bytes: new Uint8Array([3, 4]), fingerprint: second }
  ];
  context.cropToBytes = async () => frames.shift();
  const send = (message) => new Promise((resolve) => {
    assert.equal(listener({ target: 'offscreen', ...message }, {}, resolve), true);
  });
  await send({ action: 'begin', sessionId: 'same-page' });
  const captured = await send({ action: 'crop-store', sessionId: 'same-page', filename: 'page_001.png' });
  const duplicate = await send({ action: 'crop-store', sessionId: 'same-page', filename: 'page_002.png' });
  assert.equal(captured.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.count, 1);
});
