const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('auto-detection prefers the visible portion of a tall page over an inner panel', async () => {
  let listener;
  let savedRegion;
  const page = {
    tagName: 'DIV', id: '', className: 'reader-page', parentElement: null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 266, top: -800, right: 970, bottom: 1800, width: 704, height: 2600 })
  };
  const panel = {
    tagName: 'CANVAS', id: '', className: '', parentElement: page,
    closest: () => null,
    matches: () => true,
    getBoundingClientRect: () => ({ left: 266, top: 360, right: 1026, bottom: 720, width: 760, height: 360 })
  };
  const document = {
    body: {},
    documentElement: { appendChild() {} },
    querySelectorAll: () => [panel],
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} })
  };
  const chrome = {
    runtime: {
      onConnect: { addListener() {} },
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) { return { ok: true, region: message.region }; }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'content.js'), 'utf8');
  vm.runInNewContext(source, {
    window: {}, document, chrome,
    sessionStorage: { getItem: () => null, setItem(_key, value) { savedRegion = JSON.parse(value); } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
    innerWidth: 2048, innerHeight: 1080,
    setTimeout: () => 0
  });

  const result = await new Promise((resolve) => {
    assert.equal(listener({ action: 'auto-detect-region' }, {}, resolve), true);
  });
  assert.equal(result.ok, true);
  assert.equal(result.region.top, 0);
  assert.equal(result.region.height, 1080);
  assert.ok(result.region.width >= 700);
  assert.equal(savedRegion.height, 1080);
  assert.ok(savedRegion.width >= 700);
});

test('reserves the right-hand page slot even when pixel analysis fails', async () => {
  let listener;
  let savedRegion;
  const page = {
    tagName: 'CANVAS', id: '', className: 'reader-page', parentElement: null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 225, top: 0, right: 855, bottom: 900, width: 630, height: 900 })
  };
  const document = {
    body: {},
    documentElement: { appendChild() {} },
    querySelectorAll: () => [page],
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} })
  };
  const chrome = {
    runtime: {
      onConnect: { addListener() {} },
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage() { throw new Error('pixel analysis unavailable'); }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'content.js'), 'utf8');
  vm.runInNewContext(source, {
    window: {}, document, chrome,
    sessionStorage: { getItem: () => null, setItem(_key, value) { savedRegion = JSON.parse(value); } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
    innerWidth: 2048, innerHeight: 900,
    setTimeout: () => 0
  });
  const result = await new Promise((resolve) => {
    assert.equal(listener({ action: 'auto-detect-region' }, {}, resolve), true);
  });
  assert.equal(result.ok, true);
  assert.equal(result.region.left, 223);
  assert.equal(result.region.width, 1268);
  assert.equal(savedRegion.width, 1268);
});

test('uses both edges of a full-page image inside a taller viewer container', async () => {
  let listener;
  let savedRegion;
  const viewer = {
    tagName: 'DIV', id: '', className: 'reader-viewer', parentElement: null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 225, top: 30, right: 1285, bottom: 900,
      width: 1060, height: 870 })
  };
  const page = {
    tagName: 'CANVAS', id: '', className: '', parentElement: viewer,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 225, top: 80, right: 1285, bottom: 790,
      width: 1060, height: 710 })
  };
  const document = {
    body: {},
    documentElement: { appendChild() {} },
    querySelectorAll: () => [page],
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} })
  };
  const chrome = {
    runtime: {
      onConnect: { addListener() {} },
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) { return { ok: true, region: message.region }; }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'content.js'), 'utf8');
  vm.runInNewContext(source, {
    window: {}, document, chrome,
    sessionStorage: { getItem: () => null, setItem(_key, value) { savedRegion = JSON.parse(value); } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
    innerWidth: 2048, innerHeight: 900,
    setTimeout: () => 0
  });
  const result = await new Promise((resolve) => {
    assert.equal(listener({ action: 'auto-detect-region' }, {}, resolve), true);
  });
  assert.equal(result.ok, true);
  assert.equal(result.region.top, 78);
  assert.equal(result.region.height, 714);
  assert.equal(savedRegion.top + savedRegion.height, 792);
});
