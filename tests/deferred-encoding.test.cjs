const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function harness() {
  let listener;
  const context = {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    Uint8Array, Uint32Array, DataView, Blob, TextEncoder, Date, URL, setTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/offscreen.js'), 'utf8'), context);
  const send = (action, extra = {}) => new Promise((resolve) => listener({
    target: 'offscreen', action, sessionId: 'pages', filename: 'page.png', ...extra
  }, {}, resolve));
  return { context, send };
}

test('a stored crop releases the next page turn before PNG encoding and export waits for all pages', async () => {
  const h = harness();
  const encoding = [];
  const bytes = [new Uint8Array([11, 22, 33]), new Uint8Array([44, 55, 66, 77])];
  let frame = 0;
  h.context.cropToBytes = async () => {
    const index = frame++;
    return { fingerprint: new Uint8Array(4096).fill(index ? 150 : 10),
      encode: () => new Promise((resolve) => encoding.push(() => resolve(bytes[index]))) };
  };
  await h.send('begin');
  assert.equal((await h.send('crop-store', { filename: 'page_001.png' })).count, 1);
  assert.equal((await h.send('crop-store', { filename: 'page_002.png' })).count, 2);
  let exportFinished = false;
  const exporting = h.send('prepare-export').then((result) => { exportFinished = true; return result; });
  await new Promise(setImmediate);
  assert.equal(exportFinished, false);
  encoding[1]();
  await new Promise(setImmediate);
  assert.equal(exportFinished, false, 'export must also retain the first page');
  encoding[0]();
  const exported = await exporting;
  assert.equal(exported.count, 2);
  const zip = new Uint8Array(await (await fetch(exported.url)).arrayBuffer());
  const centralOffsets = [];
  for (let i = 0; i + 4 < zip.length; i++) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) centralOffsets.push(i);
  }
  assert.equal(centralOffsets.length, 2);
  assert.ok(Buffer.from(zip).includes(Buffer.from(bytes[0])));
  assert.ok(Buffer.from(zip).includes(Buffer.from(bytes[1])));
  URL.revokeObjectURL(exported.url);
});

test('pending encoding does not permit a duplicate crop to become an extra page', async () => {
  const h = harness();
  let finish;
  let encodes = 0;
  h.context.cropToBytes = async () => ({ fingerprint: new Uint8Array(4096).fill(10),
    encode: () => { encodes++; return new Promise((resolve) => { finish = () => resolve(new Uint8Array([1])); }); } });
  await h.send('begin');
  await h.send('crop-store');
  const duplicate = await h.send('crop-store');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.count, 1);
  assert.equal(encodes, 1);
  finish();
});

test('an encoding failure is reported instead of exporting a ZIP that silently omits a page', async () => {
  const h = harness();
  h.context.cropToBytes = async () => ({ fingerprint: new Uint8Array(4096).fill(10),
    encode: async () => { throw new Error('PNG encoding failed'); } });
  await h.send('begin');
  assert.equal((await h.send('crop-store')).ok, true);
  const exported = await h.send('prepare-export');
  assert.equal(exported.ok, false);
  assert.match(exported.error, /PNG encoding failed/);
});

test('a crop stored while export awaits an earlier encoding is also awaited', async () => {
  const h = harness();
  const encoding = [];
  let frame = 0;
  h.context.cropToBytes = async () => {
    const index = ++frame;
    return { fingerprint: new Uint8Array(4096).fill(index * 100),
      encode: () => new Promise(resolve => encoding.push(() => resolve(new Uint8Array([index])))) };
  };
  await h.send('begin');
  await h.send('crop-store', { filename: 'page_001.png' });
  let finished = false;
  const exporting = h.send('prepare-export').then(result => { finished = true; return result; });
  await new Promise(setImmediate);
  await h.send('crop-store', { filename: 'page_002.png' });
  encoding[0]();
  await new Promise(setImmediate);
  assert.equal(finished, false, 'the later crop must finish encoding before ZIP generation');
  encoding[1]();
  const exported = await exporting;
  assert.equal(exported.ok, true);
  assert.equal(exported.count, 2);
  const zip = Buffer.from(await (await fetch(exported.url)).arrayBuffer());
  assert.ok(zip.includes(Buffer.from('page_001.png')));
  assert.ok(zip.includes(Buffer.from('page_002.png')));
  URL.revokeObjectURL(exported.url);
});
