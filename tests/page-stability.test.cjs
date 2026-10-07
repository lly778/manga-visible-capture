const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fingerprint = (value) => Array(4096).fill(value);

function harness({ frame = () => fingerprint(150), busy = () => false, onSample = () => {}, onScreenSample = () => {}, onTimer = () => {},
  localCanvas = false, localImages = false, tainted = false, clickWorkMs = 0, reusableSamples = false } = {}) {
  let clock = 0;
  let probes = 0;
  let turns = 0;
  let turnedAt = 0;
  const messages = [];
  const saved = {};
  const label = {};
  let messageListener;
  const panel = { style: {}, querySelector: (selector) => selector === '.vmc-label' ? label : { style: {} }, remove() {} };
  const image = {
    tagName: 'IMG', get complete() { return !busy(clock); }, naturalWidth: 100, naturalHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 })
  };
  const canvas = { tagName: 'CANVAS', width: 500, height: 500, getBoundingClientRect: image.getBoundingClientRect };
  const document = {
    visibilityState: 'visible', getElementById: () => null,
    querySelectorAll: (selector) => selector === 'canvas,img'
      ? [...(localCanvas ? [canvas] : []), ...(localImages ? [image] : [])]
      : [image], getAnimations: () => [],
    elementFromPoint: (x) => x > 1 && x < 499 ? image : ({ dispatchEvent(event) {
      if (event.type === 'click') { turns++; turnedAt = clock; clock += clickWorkMs; }
    } })
  };
  const context = {
    window: {}, document, location: { href: 'https://test/manga' },
    innerWidth: 500, innerHeight: 500,
    performance: { now: () => clock },
    sessionStorage: { getItem: () => JSON.stringify({ left: 0, top: 0, width: 500, height: 500 }) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout(callback, ms) {
      if (ms === 7000) return;
      clock += ms;
      onTimer(clock, context);
      queueMicrotask(callback);
    },
    crypto: { randomUUID: () => 'test-session' },
    PointerEvent: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    chrome: {
      storage: { local: { async set(value) { Object.assign(saved, value); } } },
      runtime: {
        onConnect: { addListener() {} }, onMessage: { addListener(fn) { messageListener = fn; } },
        async sendMessage(message) {
          messages.push({ ...message, at: clock });
          if (message.action === 'sample-region') {
            probes++;
            onSample(clock, context);
            onScreenSample(clock, context);
            return { ok: true, fingerprint: frame(clock, probes, turns, turnedAt),
              ...(reusableSamples ? { sampleId: `sample-${probes}` } : {}) };
          }
          if (message.action === 'capture-and-store') {
            return { ok: true, fingerprint: frame(clock, probes, turns, turnedAt) };
          }
          return { ok: true };
        }
      }
    }
  };
  if (localCanvas || localImages) context.OffscreenCanvas = class {
    getContext() {
      let unreadable = false;
      return { clearRect() {}, drawImage(surface) {
        unreadable ||= typeof tainted === 'function' ? tainted(clock, turns, surface) : tainted;
      }, getImageData() {
        if (unreadable) throw new Error('SecurityError');
        probes++;
        onSample(clock, context);
        const gray = frame(clock, probes, turns, turnedAt);
        const rgba = new Uint8ClampedArray(4096 * 4);
        for (let i = 0; i < gray.length; i++) rgba.set([gray[i], gray[i], gray[i], 255], i * 4);
        return { data: rgba };
      } };
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension/content.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.api = { state, waitForStablePage, run, stableFingerprint, regionIsBusy, createPageSampler }; })();');
  vm.runInNewContext(source, context);
  context.api.state.panel = panel;
  return { context, api: context.api, messages, saved, label, canvas, image, now: () => clock, turns: () => turns,
    send: message => new Promise(resolve => messageListener(message, {}, resolve)) };
}

const waitOptions = { startUrl: 'https://test/manga', baseline: fingerprint(10), requireChange: true };

function installPendingHalf(h, { readyAt = 600, intentionalBlank = false, hidden = false,
  covered = false, outside = false } = {}) {
  h.canvas.getBoundingClientRect = () => ({ left: 250, top: 0, right: 500, bottom: 500, width: 250, height: 500 });
  const page = { className: intentionalBlank ? 'mode-empty -cv-page' : '-cv-page mode-loaded' };
  const mount = { tagName: 'DIV', className: '-cv-page-canvas', parentElement: page,
    closest: selector => selector.includes('.mode-empty') && intentionalBlank ? page : null,
    querySelector: () => h.now() >= readyAt ? h.canvas : null,
    contains: element => element === mount,
    getBoundingClientRect: () => ({ left: outside ? 600 : 0, top: 0, right: outside ? 850 : 250,
      bottom: 500, width: 250, height: 500 }) };
  const originalQuery = h.context.document.querySelectorAll;
  h.context.document.querySelectorAll = selector => selector.includes("page-canvas") ? [mount] : originalQuery(selector);
  const originalHit = h.context.document.elementFromPoint;
  h.context.document.elementFromPoint = (x, y) => x < 250 && !covered ? mount : originalHit(x, y);
  h.context.getComputedStyle = element => ({ display: element === page && hidden ? 'none' : 'block',
    visibility: 'visible', opacity: '1', transform: 'none' });
  return mount;
}

for (const fast of [true, false]) {
  test(`${fast ? 'fast' : 'screen'} capture waits for the empty page canvas mount in the other half`, async () => {
    const h = harness({ localCanvas: fast });
    const readyAt = fast ? 600 : 1800;
    installPendingHalf(h, { readyAt });
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.ok(result.settledMs >= readyAt, `accepted an unfinished half at ${result.elapsedMs} ms`);
    assert.ok(result.elapsedMs <= (fast ? 760 : 2750));
  });
}

test('an intentional empty first-page slot does not block fast capture', async () => {
  const h = harness({ localCanvas: true });
  installPendingHalf(h, { intentionalBlank: true, readyAt: Infinity });
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.elapsedMs, 160);
  assert.equal(h.messages.length, 0);
});

test('hidden, covered and outside page mounts do not wait for preloaded pages', async () => {
  for (const option of ['hidden', 'covered', 'outside']) {
    const h = harness({ localCanvas: true });
    installPendingHalf(h, { [option]: true, readyAt: Infinity });
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.elapsedMs, 160, option);
  }
});

test('a permanently missing half page is never stored', async () => {
  const h = harness({ localCanvas: true });
  installPendingHalf(h, { readyAt: Infinity });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.messages.filter(message => message.action === 'capture-and-store').length, 0);
  assert.match(h.label.textContent, /画面长时间未稳定/);
});

test('a Yanmaga end dialog uses ordinary stability detection without a site-specific stop', async () => {
  const h = harness();
  const popup = { classList: { contains: value => ['rental', 'active'].includes(value) },
    getBoundingClientRect: h.image.getBoundingClientRect };
  const frame = { tagName: 'IFRAME', closest: () => popup };
  const content = { classList: { contains: value => value === 'pages' }, children: [] };
  h.context.location.hostname = 'yanmaga.jp';
  h.context.document.getElementById = id => ({ 'wrap-popup': popup, rentalEpisodeFrame: frame, content })[id];
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.finished, undefined);
  assert.equal(result.changed, true);
  assert.ok(h.messages.some(message => message.action === 'sample-region'));
});

test('a KimiComi final card uses ordinary stability detection without a site-specific stop', async () => {
  const h = harness();
  const end = { classList: { contains: name => name === 'mode-last' },
    getBoundingClientRect: h.image.getBoundingClientRect };
  const viewer = { classList: { contains: name => name === 'mode-last-page' },
    querySelectorAll: () => [end] };
  end.closest = selector => selector === '#comici-viewer' ? viewer : null;
  end.querySelector = () => ({ parentElement: end, getBoundingClientRect: end.getBoundingClientRect });
  const originalQuery = h.context.document.querySelectorAll;
  h.context.document.querySelectorAll = selector => selector === '[id="xCVLastPage"]'
    ? [end] : originalQuery(selector);
  h.context.location.hostname = 'kimicomi.com';
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.finished, undefined);
  assert.equal(result.changed, true);
  assert.ok(h.messages.some(message => message.action === 'sample-region'));
});

test('automatic mode returns when the page settles without honoring an old fixed delay', async () => {
  const h = harness({ frame: (time) => fingerprint(time < 3300 ? Math.floor(time / 100) : 150) });
  const result = await h.api.waitForStablePage({ ...waitOptions, minimumMs: 6000 });
  assert.equal(result.changed, true);
  assert.equal(result.settledMs, 3300);
  assert.equal(result.elapsedMs, 3850);
});

test('waits for a delayed page change instead of accepting the still-visible old page', async () => {
  const h = harness({ frame: (time) => fingerprint(time < 5500 ? 10 : 150) });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.ok(result.elapsedMs >= 6050);
  assert.equal(result.changed, true);
});

test('small continuous drift resets stability even when adjacent samples differ only slightly', async () => {
  const h = harness({ frame: (_time, probe) => fingerprint(probe % 200) });
  await assert.rejects(h.api.waitForStablePage(waitOptions), /长时间未稳定/);
  assert.ok(h.now() >= 30000);
});

test('unchanged page stops after 8 seconds without storing a duplicate', async () => {
  const h = harness({ frame: () => fingerprint(10) });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.changed, false);
  assert.ok(result.elapsedMs >= 8000 && result.elapsedMs < 9000);
  assert.equal(h.messages.some((message) => message.action === 'capture-and-store'), false);
});

test('a transient overlay that disappears back to the old page is not a successful turn', async () => {
  const h = harness({ frame: (time) => fingerprint(time === 550 ? 150 : 10) });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.changed, false);
  assert.ok(result.elapsedMs >= 8000 && result.elapsedMs < 9000);
});

test('visible unloaded images delay capture even while pixels are unchanged', async () => {
  const h = harness({ busy: (time) => time < 5000 });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.ok(result.elapsedMs >= 6050);
});

function addLoadingPlaceholder(h, { visible = () => true, covered = false,
  rect = { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 } } = {}) {
  // The reader uses a complete loadingImage inside a visible loading layer,
  // and hides that layer when the actual canvas is ready.
  const layer = { tagName: 'DIV', className: 'loading', getBoundingClientRect: () => rect };
  const placeholder = { tagName: 'IMG', className: 'loadingImage', parentElement: layer,
    complete: true, naturalWidth: 500, naturalHeight: 500, getBoundingClientRect: () => rect };
  layer.contains = element => element === placeholder;
  const query = h.context.document.querySelectorAll;
  h.context.document.querySelectorAll = selector => selector.includes('[aria-busy')
    ? [layer, placeholder] : query(selector);
  const style = h.context.getComputedStyle;
  h.context.getComputedStyle = element => ({ ...style(element),
    ...(element === layer ? { visibility: visible(h.now()) ? 'visible' : 'hidden' } : {}) });
  const hit = h.context.document.elementFromPoint;
  h.context.document.elementFromPoint = (x, y) => !covered && visible(h.now()) &&
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
    ? placeholder : hit(x, y);
  return { layer, placeholder };
}

for (const fast of [false, true]) {
  test(`${fast ? 'fast' : 'screen'} detection waits for a stationary complete loading placeholder`, async () => {
    const h = harness({ localCanvas: fast });
    addLoadingPlaceholder(h, { visible: time => time < 2400 });
    assert.equal(h.api.regionIsBusy(), true);
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.changed, true);
    assert.ok(result.settledMs >= 2400, 'quiet time must begin after the loader disappears');
    assert.ok(result.elapsedMs < 3500, 'there is no extra fixed wait after loading');
  });
}

test('a loading placeholder on only one half still blocks the whole spread', async () => {
  const h = harness({ localCanvas: true });
  addLoadingPlaceholder(h, { visible: time => time < 600,
    rect: { left: 250, top: 0, right: 500, bottom: 500, width: 250, height: 500 } });
  assert.equal(h.api.regionIsBusy(), true);
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.ok(result.settledMs >= 600);
});

test('hidden, covered, out-of-crop and tiny loading layers do not block a ready page', async () => {
  for (const options of [
    { visible: () => false }, { covered: true },
    { rect: { left: 700, top: 0, right: 1200, bottom: 500, width: 500, height: 500 } },
    { rect: { left: 100, top: 100, right: 120, bottom: 120, width: 20, height: 20 } }
  ]) {
    const h = harness({ localCanvas: true });
    addLoadingPlaceholder(h, options);
    assert.equal(h.api.regionIsBusy(), false);
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.elapsedMs, 160, 'a ready page retains its normal fast timing');
  }
});

test('a persistent loading placeholder times out without storing it as a page', async () => {
  const h = harness({ localCanvas: true });
  addLoadingPlaceholder(h);
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.messages.some(message => message.action === 'capture-and-store'), false);
  assert.equal(h.turns(), 0);
  assert.match(h.label.textContent, /未加载的图片/);
});

test('a running animation that does not change the visible page cannot block capture', async () => {
  const h = harness();
  const target = h.context.document.querySelectorAll()[0];
  h.context.document.getAnimations = () => [{
    playState: h.now() < 5000 ? 'running' : 'finished',
    effect: { target, getComputedTiming: () => ({ iterations: 1 }) }
  }];
  const result = await h.api.waitForStablePage(waitOptions);
  assert.ok(result.elapsedMs <= 1650);
});

test('stop cancels a probe wait promptly', async () => {
  const h = harness({ onTimer: (time, context) => { if (time >= 150) context.api.state.stopped = true; } });
  assert.equal(await h.api.waitForStablePage(waitOptions), null);
  assert.ok(h.now() <= 200);
  assert.equal(h.messages.length, 0);
});

test('changing URL or hiding the tab aborts stability checks', async () => {
  for (const change of [
    (context) => { context.location.href += '/next'; },
    (context) => { context.document.visibilityState = 'hidden'; }
  ]) {
    const h = harness({ onSample: (_time, context) => change(context) });
    await assert.rejects(h.api.waitForStablePage(waitOptions), /任务已停止/);
  }
});

test('popup pause is excluded from timing and resets the confirmation interval', async () => {
  let opened = false;
  const h = harness({
    onSample(time, context) {
      if (time >= 550 && !opened) { context.api.state.popupConnections = 1; opened = true; }
    },
    onTimer(time, context) { if (time >= 10550) context.api.state.popupConnections = 0; }
  });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.ok(result.elapsedMs < 6000);
  assert.ok(h.now() >= 11000);
});

test('unstable second page stops the batch and exports only the already captured first page', async () => {
  const h = harness({ frame: (time, _probe, turns) => fingerprint(turns ? Math.floor(time / 100) % 200 : 10) });
  await h.api.run({ autoWait: true, delayMs: 100, turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.turns(), 1);
  assert.equal(h.messages.filter((message) => message.action === 'capture-and-store').length, 1);
  assert.equal(h.messages.filter((message) => message.action === 'export-capture-session').length, 1);
  assert.equal(h.api.state.completed, 1);
  assert.match(h.label.textContent, /画面长时间未稳定/);
});

test('a second consecutive slow page is fully checked but not saved', async () => {
  const h = harness({ frame: (time, _probe, turns, turnedAt) => {
    if (!turns) return fingerprint(10);
    if (turns === 1 && time - turnedAt < 3300) return fingerprint(Math.floor((time - turnedAt) / 100));
    return fingerprint(150);
  } });
  await h.api.run({ autoWait: true, delayMs: 100, turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 1);
  assert.ok(h.now() - captures[0].at >= 3850, 'identify the second settled page before applying the stop rule');
  assert.equal(h.api.state.completed, 1);
  assert.equal(h.turns(), 1, 'do not click past the second slow page');
  assert.match(h.label.textContent, /连续两页使用慢检测.*第二页未保存/);
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
});

test('the override saves consecutive slow pages until ordinary unchanged-page detection stops', async () => {
  const h = harness({ frame: (_time, _probe, turns) => fingerprint(10 + Math.min(turns, 3) * 40) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic', ignoreConsecutiveSlowStop: true });
  assert.equal(h.messages.filter(message => message.action === 'capture-and-store').length, 4);
  assert.match(h.label.textContent, /未检测到翻页变化/);
  assert.doesNotMatch(h.label.textContent, /连续两页使用慢检测/);
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
});

test('the override still stops an unstable page after the normal timeout', async () => {
  const h = harness({ frame: (time, _probe, turns) => fingerprint(turns ? Math.floor(time / 100) % 200 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic', ignoreConsecutiveSlowStop: true });
  assert.equal(h.messages.filter(message => message.action === 'capture-and-store').length, 1);
  assert.match(h.label.textContent, /画面长时间未稳定/);
});

test('running tasks accept boolean slow-stop settings and report their active value', async () => {
  const h = harness();
  h.api.state.running = true;
  h.api.state.activeOptions = { turnMethod: 'click-left' };
  assert.equal((await h.send({ action: 'get-state' })).ignoreConsecutiveSlowStop, false);
  assert.equal((await h.send({ action: 'update-settings', ignoreConsecutiveSlowStop: true })).applied, true);
  assert.equal((await h.send({ action: 'get-state' })).ignoreConsecutiveSlowStop, true);
  await h.send({ action: 'update-settings', ignoreConsecutiveSlowStop: 'false' });
  assert.equal((await h.send({ action: 'get-state' })).ignoreConsecutiveSlowStop, true);
  await h.send({ action: 'update-settings', ignoreConsecutiveSlowStop: false });
  assert.equal((await h.send({ action: 'get-state' })).ignoreConsecutiveSlowStop, false);
});

test('covered preload images cannot block a stable visible canvas', async () => {
  const h = harness({ busy: () => true });
  h.context.document.elementFromPoint = () => ({ tagName: 'CANVAS' });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.changed, true);
  assert.ok(result.elapsedMs <= 1650);
});

test('a broken image is complete and does not force 30 seconds of waiting', async () => {
  const h = harness();
  h.context.document.querySelectorAll()[0].naturalWidth = 0;
  const result = await h.api.waitForStablePage(waitOptions);
  assert.ok(result.elapsedMs <= 1650);
});

test('hidden parent and tiny unrelated loading images do not block a stable page', async () => {
  for (const hiddenParent of [true, false]) {
    const h = harness({ busy: () => true });
    const image = h.context.document.querySelectorAll()[0];
    if (hiddenParent) {
      image.parentElement = { hidden: true };
      h.context.getComputedStyle = (el) => ({ display: 'block', visibility: 'visible', opacity: el.hidden ? '0' : '1' });
    } else {
      image.getBoundingClientRect = () => ({ left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 });
    }
    const result = await h.api.waitForStablePage(waitOptions);
    assert.ok(result.elapsedMs <= 1650);
  }
});

test('small spinner and cursor changes do not continually reset visible-page stability', async () => {
  const h = harness({ frame: (_time, probe) => {
    const pixels = fingerprint(150);
    if (probe % 2) pixels.fill(20, 0, 60);
    return pixels;
  } });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.ok(result.elapsedMs <= 1650);
});

test('a stable page ignores the old 4.3 second fixed wait in automatic mode', async () => {
  const h = harness();
  const result = await h.api.waitForStablePage({ ...waitOptions, minimumMs: 4300 });
  assert.equal(result.elapsedMs, 1100);
  assert.equal(result.settledMs, 550);
});

test('CSS movement of a canvas delays stability even when its bitmap does not change', async () => {
  const h = harness({ localCanvas: true });
  h.context.getComputedStyle = (el) => ({ display: 'block', visibility: 'visible', opacity: '1',
    transform: el === h.canvas && h.now() < 400 ? `translateX(${400 - h.now()}px)` : 'none' });
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.settledMs, 400);
  assert.equal(result.elapsedMs, 520);
});

test('batch canvas detection captures promptly despite an old 30 second delay setting', async () => {
  const h = harness({ localCanvas: true, frame(time, _probe, turns, turnedAt) {
    return fingerprint(!turns ? 10 : turns === 1 && time - turnedAt < 400 ? 30 + Math.floor((time - turnedAt) / 10) : 150);
  } });
  await h.api.run({ autoWait: true, delayMs: 30000, turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.equal(captures[1].at - captures[0].at, 520);
  assert.equal(h.messages.filter((message) => message.action === 'sample-region').length, 0);
});

test('page-change wait explains that the page is static but no turn was detected', async () => {
  let explanation;
  const h = harness({ frame: () => fingerprint(10), onSample(time, context) {
    if (time > 3000) explanation = context.api.state.waitStatus;
  } });
  await h.api.waitForStablePage(waitOptions);
  assert.match(explanation, /画面已静止，尚未检测到翻页变化/);
});

test('legacy settings cannot disable stability checking or add a fixed delay', async () => {
  const h = harness();
  const originalSend = h.context.chrome.runtime.sendMessage;
  h.context.chrome.runtime.sendMessage = async (message) => {
    const response = await originalSend(message);
    if (message.action === 'capture-and-store' && message.index === 2) response.duplicate = true;
    return response;
  };
  await h.api.run({ autoWait: false, delayMs: 100, turnMethod: 'click-left', folder: 'comic' });
  assert.ok(h.messages.some((message) => message.action === 'sample-region'));
  assert.equal(h.api.state.completed, 1);
});

test('every page is checked independently when page-turn durations vary', async () => {
  const h = harness({ localCanvas: true, frame(time, _probe, turns, turnedAt) {
    if (!turns) return fingerprint(10);
    if (turns >= 3) return fingerprint(200);
    const duration = turns === 1 ? 300 : 900;
    return fingerprint(time - turnedAt < duration ? 30 + Math.floor((time - turnedAt) / 10) : turns === 1 ? 150 : 200);
  } });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 3);
  assert.equal(captures[1].at - captures[0].at, 440);
  assert.equal(captures[2].at - captures[1].at, 1040);
  assert.deepEqual(h.saved, {}, 'per-page detection must not overwrite user settings');
});

test('tiled image readers use fast pixel sampling without captureVisibleTab probes', async () => {
  const h = harness({ localImages: true, frame(time, _probe, turns, turnedAt) {
    return fingerprint(!turns ? 10 : turns === 1 && time - turnedAt < 300 ? 30 + Math.floor((time - turnedAt) / 10) : 150);
  } });
  const tiles = [0, 1, 2].map((row) => ({ ...h.image,
    getBoundingClientRect: () => ({ left: 0, top: row * 500 / 3, right: 500,
      bottom: (row + 1) * 500 / 3, width: 500, height: 500 / 3 })
  }));
  h.context.document.querySelectorAll = () => tiles;
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.equal(captures[1].at - captures[0].at, 440);
  assert.equal(h.messages.filter((message) => message.action === 'sample-region').length, 0);
});

test('image loading still blocks fast capture even when the raster and layout look unchanged', async () => {
  const h = harness({ localImages: true, busy: (time) => time < 600 });
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.ok(result.elapsedMs >= 720 && result.elapsedMs <= 760);
  assert.equal(h.messages.length, 0);
});

test('the first two portrait pages are as fast as later spreads in a reserved double-page region', async () => {
  const h = harness({ localImages: true, frame(time, _probe, turns, turnedAt) {
    const page = Math.min(turns, 3);
    return fingerprint(turns && turns < 4 && time - turnedAt < 300
      ? 30 + Math.floor((time - turnedAt) / 10) : 10 + page * 70);
  } });
  const columns = [0, 1].map((column) => [0, 1, 2].map((row) => ({ ...h.image,
    getBoundingClientRect: () => ({ left: column * 250, top: row * 500 / 3, right: (column + 1) * 250,
      bottom: (row + 1) * 500 / 3, width: 250, height: 500 / 3 })
  })));
  h.context.document.querySelectorAll = () => h.turns() < 2 ? columns[0] : columns.flat();
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 4);
  assert.equal(captures[0].at, 160);
  for (let i = 1; i < captures.length; i++) assert.equal(captures[i].at - captures[i - 1].at, 440);
  assert.equal(h.messages.filter((message) => message.action === 'sample-region').length, 0);
});

function installMixedPortrait(h, { htmlVisible = () => true, htmlOnLeft = true,
  obscured = false, edgeControl = false, hidden = false } = {}) {
  const canvasLeft = htmlOnLeft ? 250 : 0;
  h.canvas.getBoundingClientRect = () => ({ left: canvasLeft, top: 0,
    right: canvasLeft + 250, bottom: 500, width: 250, height: 500 });
  const controlLeft = (htmlOnLeft ? 0 : 250) + 50;
  const controlTop = edgeControl ? 470 : 200;
  const control = { tagName: 'SVG', getBoundingClientRect: () => ({ left: controlLeft,
    top: controlTop, right: controlLeft + 150, bottom: controlTop + 30, width: 150, height: 30 }) };
  h.context.document.querySelectorAll = selector => selector === 'canvas,img' ? [h.canvas]
    : selector === 'img' ? [] : htmlVisible() ? [control] : [];
  const elementAt = h.context.document.elementFromPoint;
  h.context.document.elementFromPoint = (x, y) => x >= controlLeft && x <= controlLeft + 150 &&
    y >= controlTop && y <= controlTop + 30 && !obscured ? control : elementAt(x, y);
  h.context.getComputedStyle = element => ({ display: 'block', visibility: 'visible',
    opacity: element === control && hidden ? '0' : '1' });
  return control;
}

test('a complete manga half beside visible HTML or SVG content uses slow detection on either side', async () => {
  for (const htmlOnLeft of [true, false]) {
    const h = harness({ localCanvas: true });
    installMixedPortrait(h, { htmlOnLeft });
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.detectionMode, 'screen');
    assert.ok(h.messages.some(message => message.action === 'sample-region'));
  }
});

test('blank first-page padding, hidden content and page-edge controls retain fast detection', async () => {
  for (const options of [{ htmlVisible: () => false }, { obscured: true }, { edgeControl: true }, { hidden: true }]) {
    const h = harness({ localCanvas: true });
    installMixedPortrait(h, options);
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.detectionMode, 'rendered');
    assert.equal(result.elapsedMs, 160);
    assert.equal(h.messages.length, 0);
  }
});

test('turning from a fast blank-padded page to two HTML mixed pages saves only the first slow page', async () => {
  const h = harness({ localCanvas: true, frame: (_time, _probe, turns) => fingerprint(10 + turns * 70) });
  installMixedPortrait(h, { htmlVisible: () => h.turns() > 0 });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.api.state.completed, 2);
  assert.equal(h.turns(), 2);
  assert.equal(h.messages.filter(message => message.action === 'capture-and-store').length, 2);
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
  assert.match(h.label.textContent, /连续两页使用慢检测.*第二页未保存/);
});

test('a normal manga page following an HTML mixed page recovers fast detection and resets the slow count', async () => {
  const h = harness({ localCanvas: true, frame: (_time, _probe, turns) => fingerprint(10 + turns * 50) });
  installMixedPortrait(h, { htmlVisible: () => h.turns() !== 1 });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.api.state.completed, 3);
  assert.equal(h.turns(), 3);
  assert.equal(h.messages.filter(message => message.action === 'capture-and-store').length, 3);
  assert.match(h.label.textContent, /连续两页使用慢检测.*第二页未保存/);
});

test('HTML appearing during recovery verification prevents a fast classification', async () => {
  let showHtml = true;
  const h = harness({ localCanvas: true,
    onTimer: time => { if (time >= 40 && time < 160) showHtml = false; },
    onScreenSample: () => { showHtml = true; } });
  installMixedPortrait(h, { htmlVisible: () => showHtml });
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.detectionMode, 'screen');
  assert.ok(result.elapsedMs >= 550);
});

test('a portrait page clipped during a slide cannot settle as a complete single page', async () => {
  const h = harness({ localImages: true });
  h.image.getBoundingClientRect = () => {
    const left = h.now() >= 80 && h.now() < 400 ? 375 : 0;
    return { left, top: 0, right: left + 250, bottom: 500, width: 250, height: 500 };
  };
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.elapsedMs, 520);
  assert.equal(h.messages.length, 0);
});

test('readable end-screen movement is still checked rather than ignored solely because it is small', async () => {
  const h = harness({ localImages: true, frame(time, _probe, turns, turnedAt) {
    return fingerprint(!turns ? 10 : turns === 1 && time - turnedAt < 300
      ? 30 + Math.floor((time - turnedAt) / 10) : 150);
  } });
  const pages = [0, 1].map((column) => [0, 1, 2].map((row) => ({ ...h.image,
    getBoundingClientRect: () => ({ left: column * 250, top: row * 500 / 3, right: (column + 1) * 250,
      bottom: (row + 1) * 500 / 3, width: 250, height: 500 / 3 })
  })));
  const banner = { ...h.image, getBoundingClientRect: () =>
    ({ left: 25, top: 165, right: 225, bottom: 495, width: 200, height: 330 }) };
  const animatedParent = {};
  const badge = { ...h.image, parentElement: animatedParent, getBoundingClientRect: () =>
    ({ left: 25, top: 0, right: 135, bottom: 50, width: 110, height: 50 }) };
  h.context.document.querySelectorAll = () => h.turns() ? [...pages[1], banner, badge] : pages.flat();
  h.context.getComputedStyle = (element) => ({ display: 'block', visibility: 'visible', opacity: '1',
    transform: element === animatedParent ? `translateY(${h.now() % 60}px)` : 'none' });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 1, 'do not silently ignore a readable moving surface');
  assert.equal(h.api.state.completed, 1);
  assert.match(h.label.textContent, /画面长时间未稳定/);
  assert.equal(h.messages.filter((message) => message.action === 'export-capture-session').length, 1);
  assert.equal(h.messages.filter((message) => message.action === 'sample-region').length, 0);
});

test('small tiles forming a manga page still detect movement next to a larger recommendation image', async () => {
  const h = harness({ localImages: true });
  const tiles = Array.from({ length: 25 }, (_, row) => ({ ...h.image,
    getBoundingClientRect: () => ({ left: 250, top: row * 20, right: 500, bottom: (row + 1) * 20,
      width: 250, height: 20 })
  }));
  const banner = { ...h.image, getBoundingClientRect: () =>
    ({ left: 25, top: 165, right: 225, bottom: 495, width: 200, height: 330 }) };
  h.context.document.querySelectorAll = () => [...tiles, banner];
  h.context.getComputedStyle = (element) => ({ display: 'block', visibility: 'visible', opacity: '1',
    transform: element === tiles[0] && h.now() < 400 ? `translateX(${400 - h.now()}px)` : 'none' });
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.elapsedMs, 520);
  assert.equal(h.messages.length, 0);
});

test('the last manga page is saved when a cross-origin end-screen banner taints fast detection', async () => {
  let banner;
  const h = harness({ localImages: true, tainted: (_time, _turns, surface) => surface === banner,
    frame(time, _probe, turns, turnedAt) {
      return fingerprint(!turns ? 10 : turns === 1 && time - turnedAt < 1000
        ? 30 + Math.floor((time - turnedAt) / 100) : 150);
    }
  });
  const pages = [0, 1].map((column) => [0, 1, 2].map((row) => ({ ...h.image,
    getBoundingClientRect: () => ({ left: column * 250, top: row * 500 / 3, right: (column + 1) * 250,
      bottom: (row + 1) * 500 / 3, width: 250, height: 500 / 3 })
  })));
  banner = { ...h.image, getBoundingClientRect: () =>
    ({ left: 25, top: 165, right: 225, bottom: 495, width: 200, height: 330 }) };
  h.context.document.querySelectorAll = () => h.turns() ? [banner, ...pages[1]] : pages.flat();
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2, 'keep and save the last page after switching detection sources');
  assert.ok(captures[1].at - captures[0].at >= 1550, 'wait for animation and screenshot confirmation');
  assert.equal(h.api.state.completed, 2);
  assert.match(h.label.textContent, /未检测到翻页变化/);
  assert.equal(h.messages.filter((message) => message.action === 'export-capture-session').length, 1);
  assert.ok(h.messages.some((message) => message.action === 'sample-region'));
});

test('switching to screen detection at an unchanged last page cannot store a duplicate', async () => {
  const h = harness({ localCanvas: true, tainted: (_time, turns) => turns > 0,
    frame: () => fingerprint(10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.messages.filter((message) => message.action === 'capture-and-store').length, 1);
  assert.equal(h.api.state.completed, 1);
  assert.match(h.label.textContent, /未检测到翻页变化/);
});

test('an unreadable advertisement stays slow but the immediately following ordinary pages recover fast confirmation', async () => {
  const h = harness({ localCanvas: true, reusableSamples: true, tainted: (_time, turns) => !turns,
    frame(time, _probe, turns, turnedAt) {
      return fingerprint(turns > 0 && turns < 3 && time - turnedAt < 300
        ? 30 + Math.floor((time - turnedAt) / 10) : 10 + Math.min(turns, 2) * 70);
    } });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 3);
  assert.equal(captures[0].at, 1100, 'the unreadable advertising page still needs slow confirmation');
  assert.equal(captures[1].at - captures[0].at, 440, 'the next page uses ordinary fast confirmation');
  assert.equal(captures[2].at - captures[1].at, 440);
  const verification = h.messages.filter(message => message.action === 'sample-region' &&
    message.at > captures[0].at && message.at <= captures[1].at);
  assert.equal(verification.length, 1, 'one screen sample verifies the change after fast stability');
  assert.match(captures[1].sampleId, /^sample-\d+$/, 'reuse the verified sample');
  assert.equal(captures[1].at, verification[0].at, 'no further screenshot wait after verification');
});

test('a recovered fast page resets the slow-page count even though it is saved from a screen verification sample', async () => {
  const h = harness({ localCanvas: true, reusableSamples: true,
    tainted: (_time, turns) => turns !== 1,
    frame: (_time, _probe, turns) => fingerprint(10 + Math.min(turns, 3) * 70) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 3, 'save slow, recovered fast, then first slow again');
  assert.match(captures[1].sampleId, /^sample-\d+$/, 'the recovered page uses its verified screenshot');
  assert.equal(h.turns(), 3, 'stop upon confirming the next consecutive slow page');
  assert.equal(h.api.state.completed, 3);
  assert.equal(h.now(), captures[2].at + 1100, 'do not spend an additional end-of-reader wait');
  assert.match(h.label.textContent, /连续两页使用慢检测.*第二页未保存/);
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
});

test('fast pages followed by two slow pages save only the first slow page', async () => {
  const h = harness({ localCanvas: true, tainted: (_time, turns) => turns > 0,
    frame: (_time, _probe, turns) => fingerprint(10 + Math.min(turns, 2) * 70) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.equal(h.turns(), 2);
  assert.equal(h.api.state.completed, 2);
  assert.match(h.label.textContent, /连续两页使用慢检测.*第二页未保存/);
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
});

test('a new batch resets the consecutive-slow count and can save its first slow page again', async () => {
  const h = harness({ frame: (_time, _probe, turns) => fingerprint(10 + Math.min(turns, 2) * 70) });
  await h.api.run({ turnMethod: 'click-left', folder: 'first' });
  await h.api.run({ turnMethod: 'click-left', folder: 'second' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.ok(captures.every(message => message.index === 1));
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 2);
  assert.equal(h.api.state.completed, 1);
});

test('readability recovery without a page change cannot save a duplicate or stop before the no-change deadline', async () => {
  const h = harness({ localCanvas: true, tainted: (_time, turns) => !turns, frame: () => fingerprint(10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 1);
  assert.ok(h.now() - captures[0].at >= 8000, 'a new readable surface alone does not prove a page turn');
  assert.match(h.label.textContent, /未检测到翻页变化/);
});

test('screen recovery cannot accept a moving readable page just because two screenshots look unchanged', async () => {
  const h = harness({ localCanvas: true, tainted: (_time, turns) => !turns,
    frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  h.context.getComputedStyle = element => ({ display: 'block', visibility: 'visible', opacity: '1',
    transform: element === h.canvas && h.turns() === 1 && h.now() < 2400 ? `translateX(${2400 - h.now()}px)` : 'none' });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.ok(captures[1].at >= 2520, 'wait for 1300 ms of movement and fast stability confirmation');
});

test('a recovered page changing while its verification screenshot is taken must be confirmed again', async () => {
  let moved = false;
  const h = harness({ localCanvas: true, reusableSamples: true, tainted: (_time, turns) => !turns,
    frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10),
    onScreenSample(_time, context) {
      if (h.turns() && !moved) {
        moved = true;
        context.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', transform: 'translateX(1px)' });
      }
    } });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.equal(captures[1].at - captures[0].at, 320);
  const verification = h.messages.filter(message => message.action === 'sample-region' &&
    message.at > captures[0].at && message.at <= captures[1].at);
  assert.equal(verification.length, 2, 'discard the first sample and take a new one after confirming stability again');
  assert.equal(captures[1].at, verification[1].at);
  assert.match(captures[1].sampleId, /^sample-\d+$/);
});

test('fast recovery after an advertisement still waits for the ordinary image to finish loading', async () => {
  const h = harness({ localImages: true, tainted: (_time, turns) => !turns,
    busy: time => h.turns() === 1 && time < 1700,
    frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.ok(captures[1].at >= 1820, 'load the second page and confirm its final pixels before capturing');
});

test('a fast reader stops promptly at the final unchanged page using earlier turn timing', async () => {
  const h = harness({ localCanvas: true, frame(time, _probe, turns, turnedAt) {
    return fingerprint(!turns ? 10 : turns === 1 && time - turnedAt < 300
      ? 30 + Math.floor((time - turnedAt) / 10) : 150);
  } });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.equal(h.now() - captures[1].at, 1200);
  assert.match(h.label.textContent, /未检测到翻页变化/);
});

test('a final unchanged page remains quick after cross-origin fallback without taking a duplicate screenshot', async () => {
  const h = harness({ localCanvas: true, tainted: (_time, turns) => turns > 0,
    frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.ok(h.now() - captures[1].at <= 1650);
  assert.match(h.label.textContent, /未检测到翻页变化/);
});

test('slow readers keep enough no-change headroom for another delayed page turn', async () => {
  const h = harness({ localCanvas: true, frame(time, _probe, turns, turnedAt) {
    if (!turns) return fingerprint(10);
    const duration = turns === 1 ? 2200 : 3200;
    if (turns < 3 && time - turnedAt < duration) return fingerprint(turns === 1 ? 10 : 100);
    return fingerprint(turns === 1 ? 100 : 200);
  } });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 3, 'a delayed second turn must not be mistaken for the end');
  assert.equal(captures[1].at - captures[0].at, 2320);
  assert.equal(captures[2].at - captures[1].at, 3320);
  assert.equal(h.now() - captures[2].at, 6400);
});

test('an unstable last page still stops safely after falling back from fast detection', async () => {
  const h = harness({ localCanvas: true, tainted: (_time, turns) => turns > 0,
    frame: (time, _probe, turns) => fingerprint(turns ? Math.floor(time / 100) % 200 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.messages.filter((message) => message.action === 'capture-and-store').length, 1);
  assert.equal(h.api.state.completed, 1);
  assert.match(h.label.textContent, /画面长时间未稳定/);
  assert.equal(h.messages.filter((message) => message.action === 'export-capture-session').length, 1);
});

test('a missing middle tile in a portrait page blocks capture until the page is complete', async () => {
  const h = harness({ localImages: true });
  const tiles = [0, 1, 2].map((row) => ({ ...h.image,
    getBoundingClientRect: () => ({ left: 0, top: row * 500 / 3, right: 250,
      bottom: (row + 1) * 500 / 3, width: 250, height: 500 / 3 })
  }));
  h.context.document.querySelectorAll = () => h.now() >= 80 && h.now() < 400 ? [tiles[0], tiles[2]] : tiles;
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.equal(result.elapsedMs, 520);
  assert.equal(h.messages.length, 0);
});

test('a small unrelated portrait image cannot select fast page detection', async () => {
  const h = harness({ localImages: true });
  h.image.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 150, width: 100, height: 150 });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.elapsedMs, 1100);
  assert.ok(h.messages.some((message) => message.action === 'sample-region'));
});

test('screen detection reuses the saved page as the baseline when checking the next slow page', async () => {
  const h = harness({ frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 1, 'the second consecutive slow page is not stored');
  const firstCapture = h.messages.indexOf(captures[0]);
  assert.equal(h.messages[firstCapture + 1].action, 'sample-region');
  assert.equal(h.messages[firstCapture + 1].at - captures[0].at, 550);
  assert.equal(h.now() - captures[0].at, 1100, 'only the post-turn probes are needed');
});

test('the saved slow page reuses its last confirmed probe without requesting a new screenshot', async () => {
  const h = harness({ reusableSamples: true, frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 1);
  for (const capture of captures) {
    const probes = h.messages.slice(0, h.messages.indexOf(capture)).filter((m) => m.action === 'sample-region');
    assert.equal(capture.sampleId, `sample-${probes.length}`);
    assert.equal(capture.at, probes.at(-1).at);
  }
});

test('a brief gap between sliding image tiles does not change the sampler or capture the gap', async () => {
  const h = harness({ localImages: true });
  h.image.getBoundingClientRect = () => {
    const left = h.now() >= 80 && h.now() < 400 ? 300 : 0;
    return { left, top: 0, right: left + 500, bottom: 500, width: 500, height: 500 };
  };
  const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
  assert.ok(result.elapsedMs >= 520);
  assert.equal(h.messages.length, 0);
});

test('tainted image pixels fall back to screenshots rather than bypassing browser restrictions', async () => {
  const h = harness({ localImages: true, tainted: true });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.elapsedMs, 1100);
  assert.ok(h.messages.some((message) => message.action === 'sample-region'));
});
