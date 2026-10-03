const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function createPopupHarness(storedSettings = {}) {
  const root = path.join(__dirname, '..', 'chrome-extension');
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', style: {}, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }
  }]));
  const messages = [];
  const writes = [];
  let closed = false;
  const chrome = {
    storage: { local: {
      async get(defaults) { return { ...defaults, ...storedSettings }; },
      async set(settings) { writes.push(settings); }
    } },
    tabs: {
      async query() { return [{ id: 7, url: 'https://test/manga', title: 'Comic' }]; },
      connect() { return {}; },
      async sendMessage(_id, message) {
        messages.push(message);
        if (message.action === 'get-state') return { region: { width: 500, height: 500 }, running: false };
        return { ok: true };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), {
    chrome, document: { getElementById(id) { assert.ok(elements.has(id), `missing control: ${id}`); return elements.get(id); } },
    window: { close() { closed = true; } }
  });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return { elements, messages, writes, closed: () => closed };
}

test('popup initializes and starts capture using only the remaining controls despite legacy settings', async () => {
  const h = await createPopupHarness({
    turnMethod: 'click-right', arrowKeyDefaultApplied: true, delaySeconds: 30, autoWait: false
  });
  const { elements, messages, writes } = h;
  assert.equal(elements.get('start').disabled, false);
  assert.equal(elements.get('turnMethod').value, 'click-right');
  await elements.get('start').listeners.click();
  const start = messages.find((message) => message.action === 'start');
  assert.deepEqual(Object.keys(start).sort(), ['action', 'folder', 'turnMethod']);
  assert.equal(start.turnMethod, 'click-right');
  assert.deepEqual(Object.keys(writes[0]), ['turnMethod']);
  assert.equal(h.closed(), true);
});

test('a new installation defaults to the left arrow key', async () => {
  const h = await createPopupHarness();
  assert.equal(h.elements.get('turnMethod').value, 'key-left');
  await h.elements.get('start').listeners.click();
  assert.equal(h.messages.find(message => message.action === 'start').turnMethod, 'key-left');
});

for (const [oldMethod, arrowMethod] of [['click-left', 'key-left'], ['click-right', 'key-right']]) {
  test(`an upgrade switches ${oldMethod} to ${arrowMethod} once`, async () => {
    const h = await createPopupHarness({ turnMethod: oldMethod });
    assert.equal(h.elements.get('turnMethod').value, arrowMethod);
    assert.equal(h.writes[0].turnMethod, arrowMethod);
    assert.equal(h.writes[0].arrowKeyDefaultApplied, true);
    h.elements.get('turnMethod').value = oldMethod;
    await h.elements.get('turnMethod').listeners.change();
    await new Promise(setImmediate);
    const saved = Object.assign({}, ...h.writes);
    const reopened = await createPopupHarness(saved);
    assert.equal(reopened.elements.get('turnMethod').value, oldMethod);
    assert.equal(reopened.writes.length, 0, 'the migration never overwrites later manual choices');
  });
}

test('the arrow-key default does not enable automatic turns in manual mode', async () => {
  const h = await createPopupHarness({ turnMethod: 'none' });
  assert.equal(h.elements.get('turnMethod').value, 'none');
});
