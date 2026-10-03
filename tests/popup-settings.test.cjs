const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('popup initializes and starts capture using only the remaining controls despite legacy settings', async () => {
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
      async get(defaults) { return { ...defaults, turnMethod: 'click-right', delaySeconds: 30, autoWait: false }; },
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
  assert.equal(elements.get('start').disabled, false);
  assert.equal(elements.get('turnMethod').value, 'click-right');
  await elements.get('start').listeners.click();
  const start = messages.find((message) => message.action === 'start');
  assert.deepEqual(Object.keys(start).sort(), ['action', 'folder', 'turnMethod']);
  assert.equal(start.turnMethod, 'click-right');
  assert.deepEqual(Object.keys(writes[0]), ['turnMethod']);
  assert.equal(closed, true);
});
