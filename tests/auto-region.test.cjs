const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function detectViewportCanvas({ bookWalker = true, zoomed = false } = {}) {
  let listener;
  const messages = [];
  const viewportWidth = 1707, viewportHeight = 898;
  const viewer = { tagName: 'DIV', id: 'viewer', className: 'viewer', parentElement: null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: viewportWidth, bottom: viewportHeight,
      width: viewportWidth, height: viewportHeight }) };
  const canvas = { ...viewer, tagName: 'CANVAS', id: '', className: '', parentElement: viewer,
    width: 2561, height: 1347,
    closest: selector => bookWalker && selector === '#renderer .currentScreen' ? viewer : null,
    getContext() { throw new Error('Viewport canvas pixels are unreadable'); } };
  const document = { body: {}, documentElement: { appendChild() {} }, querySelectorAll: selector =>
    selector === '#renderer canvas.dummy' ? [{ width: 1409, height: 2000 }, { width: 705, height: 1000 }] : [canvas],
    getElementById: id => id === 'zoomDefaultBtn' && zoomed ? { disabled: false } : null,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} }) };
  const chrome = { runtime: { onConnect: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) { messages.push(message); return { ok: true, region: message.region }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/content.js'), 'utf8'), {
    window: {}, document, chrome,
    location: { hostname: bookWalker ? 'viewer.bookwalker.jp' : 'example.test' },
    sessionStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
    innerWidth: viewportWidth, innerHeight: viewportHeight, setTimeout() {}
  });
  const result = await new Promise(resolve => listener({ action: 'auto-detect-region' }, {}, resolve));
  return { result, messages };
}

test('BookWalker viewport detection requests screenshot fitting using only DOM page dimensions', async () => {
  const { result, messages } = await detectViewportCanvas();
  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].pageHint.aspect, 1409 / 2000);
  assert.equal(messages[0].pageHint.count, 2);
});

test('other readers retain DOM and screenshot detection without BookWalker geometry', async () => {
  const { result, messages } = await detectViewportCanvas({ bookWalker: false });
  assert.equal(result.ok, true);
  assert.equal(result.region.width, 1707);
  assert.equal(result.region.height, 898);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].pageHint, undefined);
});

test('BookWalker zoomed views do not request fitting to an unzoomed page', async () => {
  const { messages } = await detectViewportCanvas({ zoomed: true });
  assert.equal(messages[0].pageHint, undefined);
});

async function detectTiledSpread({ singlePage = false, hiddenExtra = false, incomplete = false,
  viewportWidth = 1280, viewportHeight = 720 } = {}) {
  let listener;
  const width = viewportHeight * 0.703125;
  const start = (viewportWidth - width * 2) / 2;
  const node = (tagName, className, left, top, width, height, parentElement = null, hidden = false) => ({
    tagName, id: '', className, parentElement, hidden,
    closest: () => null,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height })
  });
  const viewer = node('DIV', 'pages viewer', 0, 0, viewportWidth, viewportHeight);
  const surfaces = [];
  for (const side of singlePage ? [0] : [0, 1]) {
    const page = node('DIV', '', start + width * side, 0, width, viewportHeight, viewer);
    const imageContainer = node('DIV', 'pt-img', start + width * side, 0, width, viewportHeight, page);
    for (let tile = 0; tile < (incomplete ? 2 : 3); tile++) {
      const top = viewportHeight * tile / 3;
      const tileContainer = node('DIV', '', start + width * side, top, width + 0.74,
        viewportHeight / 3 + 1.5, imageContainer);
      surfaces.push(node('IMG', '', start + width * side, top, width + 0.74,
        viewportHeight / 3 + 1.5, tileContainer));
    }
  }
  if (hiddenExtra) {
    const preload = node('DIV', '', 0, 0, width, viewportHeight, viewer, true);
    surfaces.push(node('IMG', '', 0, 0, width, viewportHeight, preload));
  }
  const document = { body: {}, documentElement: { appendChild() {} },
    querySelectorAll: () => surfaces, getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} }) };
  const chrome = { runtime: { onConnect: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) { return { ok: true, region: message.region }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/content.js'), 'utf8'), {
    window: {}, document, chrome, sessionStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: element => ({ display: element.hidden ? 'none' : 'block',
      visibility: 'visible', opacity: '1', position: 'static' }),
    innerWidth: viewportWidth, innerHeight: viewportHeight, setTimeout: () => 0
  });
  return { result: await new Promise(resolve => listener({ action: 'auto-detect-region' }, {}, resolve)),
    start, width };
}

for (const [viewportWidth, viewportHeight] of [[1280, 720], [1707, 898]]) {
  test(`tiled double pages exclude white viewer margins at ${viewportWidth}x${viewportHeight}`, async () => {
    const { result, start, width } = await detectTiledSpread({ viewportWidth, viewportHeight });
    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.region.left - start) <= 3);
    assert.ok(Math.abs(result.region.width - width * 2) <= 6, JSON.stringify(result.region));
    assert.equal(result.region.top, 0);
    assert.equal(result.region.height, viewportHeight);
  });
}

test('hidden preload pages do not enlarge tiled double-page bounds', async () => {
  const { result, start, width } = await detectTiledSpread({ hiddenExtra: true });
  assert.ok(Math.abs(result.region.left - start) <= 3);
  assert.ok(Math.abs(result.region.width - width * 2) <= 5);
});

test('a tiled first page retains its blank second-page slot', async () => {
  const { result, width } = await detectTiledSpread({ singlePage: true });
  assert.equal(result.ok, true);
  assert.ok(result.region.width >= width * 2);
});

test('incomplete tiled pages do not narrow the viewer to partial artwork', async () => {
  const { result } = await detectTiledSpread({ incomplete: true });
  assert.equal(result.ok, true);
  assert.equal(result.region.left, 0);
  assert.equal(result.region.width, 1280);
});

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
