const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function harness({ cancel = false, failWrite = false, failClose = false, failCleanup = false, unsupported = false } = {}) {
  const calls = [];
  const button = { disabled: false, textContent: '保存 ZIP' };
  const status = { textContent: '' };
  const data = new Blob(['ZIP contents']);
  const entry = { sessionId: 'session', filename: '漫画标题.zip', url: 'blob:export', size: data.size };
  const context = {
    window: {},
    location: { hash: '' },
    document: { getElementById: () => ({ textContent: '' }) },
    chrome: {
      storage: { session: { get: async () => ({}) } },
      runtime: { async sendMessage(message) {
        calls.push(['cleanup', message]);
        return { ok: !failCleanup };
      } }
    },
    async fetch(url) { calls.push(['fetch', url]); return { ok: true, blob: async () => data }; }
  };
  if (!unsupported) context.window.showSaveFilePicker = async (options) => {
    calls.push(['picker', options]);
    if (cancel) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    return { name: entry.filename, async createWritable() {
      calls.push(['create']);
      return {
        async write(blob) { calls.push(['write', blob]); if (failWrite) throw new Error('disk full'); },
        async close() { calls.push(['close']); if (failClose) throw new Error('close failed'); },
        async abort() { calls.push(['abort']); }
      };
    } };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/save.js'), 'utf8'), context);
  return { calls, button, status, data, run: () => context.saveExport(entry, button, status) };
}

test('direct saving uses the title, writes exact bytes, then releases the export', async () => {
  const h = harness();
  const task = h.run();
  assert.equal(h.calls[0][0], 'picker', 'picker must run synchronously during the click');
  assert.equal(h.calls[0][1].suggestedName, '漫画标题.zip');
  await task;
  assert.deepEqual(h.calls.map(([name]) => name), ['picker', 'fetch', 'create', 'write', 'close', 'cleanup']);
  assert.equal(h.calls.find(([name]) => name === 'write')[1], h.data);
  assert.equal(h.button.disabled, true);
  assert.match(h.status.textContent, /已保存/);
});

test('cancel keeps the export available without fetching or deleting it', async () => {
  const h = harness({ cancel: true });
  await h.run();
  assert.deepEqual(h.calls.map(([name]) => name), ['picker']);
  assert.equal(h.button.disabled, false);
  assert.match(h.status.textContent, /已取消/);
});

for (const failure of ['failWrite', 'failClose']) {
  test(`${failure} aborts the write and retains the export for retry`, async () => {
    const h = harness({ [failure]: true });
    await h.run();
    assert.equal(h.calls.some(([name]) => name === 'cleanup'), false);
    assert.equal(h.calls.at(-1)[0], 'abort');
    assert.equal(h.button.disabled, false);
    assert.match(h.status.textContent, /保存失败/);
  });
}

test('cleanup failure reports the file as already saved', async () => {
  const h = harness({ failCleanup: true });
  await h.run();
  assert.equal(h.button.disabled, true);
  assert.match(h.status.textContent, /文件已写入/);
});

test('unsupported browser does not fall back to an IDM-interceptable download', async () => {
  const h = harness({ unsupported: true });
  await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.button.disabled, false);
  assert.match(h.status.textContent, /不支持直接保存/);
});
