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
        onConnect: { addListener() {} }, onMessage: { addListener() {} },
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
  return { context, api: context.api, messages, saved, label, canvas, image, now: () => clock, turns: () => turns };
}

const waitOptions = { startUrl: 'https://test/manga', baseline: fingerprint(10), requireChange: true };

function installEndDialog(h, { shown = () => h.turns() >= 2, comicVisible = () => !shown(), hidden = false,
  active = true, hostname = 'yanmaga.jp' } = {}) {
  const rect = (visible) => ({ left: visible ? 0 : 600, top: 0,
    right: visible ? 500 : 1100, bottom: 500, width: 500, height: 500 });
  const popup = { classList: { contains: value => value === 'rental' || value === 'active' && active },
    getBoundingClientRect: () => rect(shown()) };
  const frame = { tagName: 'IFRAME', closest: () => popup };
  const comic = { id: 'content-p8', getBoundingClientRect: () => rect(comicVisible()) };
  const content = { classList: { contains: value => value === 'pages' }, children: [comic] };
  h.context.location.hostname = hostname;
  h.context.document.getElementById = id => ({ 'wrap-popup': popup, rentalEpisodeFrame: frame, content })[id];
  h.context.getComputedStyle = element => ({ display: hidden && element === popup ? 'none' : 'block',
    visibility: 'visible', opacity: '1' });
  return { popup, frame, content };
}

test('an end dialog with alternating toolbar backgrounds stops before storing it or clicking again', async () => {
  const h = harness({ reusableSamples: true,
    frame: (_time, _probe, turns) => fingerprint(turns === 0 ? 10 : turns === 1 ? 100 : turns % 2 ? 150 : 230) });
  installEndDialog(h);
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  const lastProbe = h.messages.filter(message => message.action === 'sample-region').at(-1);
  assert.equal(captures.length, 2, 'save both comic frames including the final one');
  assert.equal(h.api.state.completed, 2);
  assert.equal(h.turns(), 2, 'never click the terminal screen again');
  assert.equal(h.now(), captures[1].at, 'the already visible end dialog adds no detection wait');
  assert.ok(lastProbe.at <= captures[1].at, 'do not take probes of the end dialog');
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
  assert.match(h.label.textContent, /阅读结束页面/);
});

test('a visible end dialog at the start creates no screenshots and discards the empty task', async () => {
  const h = harness();
  installEndDialog(h, { shown: () => true, comicVisible: () => false });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  assert.equal(h.turns(), 0);
  assert.equal(h.messages.some(message => ['sample-region', 'capture-and-store'].includes(message.action)), false);
  assert.equal(h.messages.filter(message => message.action === 'discard-capture-session').length, 1);
});

test('a hidden or inactive dialog and a dialog beside visible comic cannot trigger the end stop', async () => {
  for (const options of [{ hidden: true }, { active: false }, { comicVisible: () => true }, { hostname: 'other.test' }]) {
    const h = harness();
    installEndDialog(h, { shown: () => true, comicVisible: () => false, ...options });
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.changed, true);
    assert.equal(result.finished, undefined);
    assert.ok(h.messages.some(message => message.action === 'sample-region'));
  }
});

test('an end dialog appearing during a probe wait is detected without taking its screenshot', async () => {
  const h = harness();
  installEndDialog(h, { shown: () => h.now() >= 100, comicVisible: () => h.now() < 100 });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.finished, true);
  assert.equal(h.messages.length, 0);
});

function installComiciEnd(h, { shown = () => h.turns() >= 2, comicVisible = () => !shown(),
  emptyVisible = true, hiddenFirst = true, missingButtons = false, inactive = false } = {}) {
  const rect = (visible) => ({ left: visible ? 0 : -1000, top: 0,
    right: visible ? 500 : -500, bottom: 500, width: 500, height: 500 });
  const classes = (...names) => ({ contains: name => names.includes(name) });
  const end = { classList: classes('mode-last'), getBoundingClientRect: () => rect(shown()) };
  const comic = { classList: classes(), getBoundingClientRect: () => rect(comicVisible()) };
  const empty = { classList: classes('mode-empty'), getBoundingClientRect: () => rect(emptyVisible) };
  const viewer = { classList: { contains: name => name === 'mode-last-page' && shown() && !inactive },
    querySelectorAll: () => [end, comic, empty] };
  end.closest = selector => selector === '#comici-viewer' ? viewer : null;
  end.querySelector = () => missingButtons ? null : { parentElement: end, getBoundingClientRect: end.getBoundingClientRect };
  const hidden = { ...end, getBoundingClientRect: () => rect(false) };
  const originalQuery = h.context.document.querySelectorAll;
  h.context.document.querySelectorAll = selector => selector === '[id="xCVLastPage"]'
    ? [...(hiddenFirst ? [hidden] : []), end] : originalQuery(selector);
  h.context.location.hostname = 'kimicomi.com';
  return { end, comic, viewer };
}

test('KimiComi HTML end card stops before a retained fast sampler can wait forever for comic coverage', async () => {
  const h = harness({ localCanvas: true,
    frame: (_time, _probe, turns) => fingerprint(turns === 0 ? 10 : 150) });
  installComiciEnd(h);
  // The reader has no raster surface on its HTML end card. The existing fast
  // sampler would otherwise mark that missing coverage as loading forever.
  h.canvas.getBoundingClientRect = () => ({ left: h.turns() >= 2 ? -1000 : 0, top: 0,
    right: h.turns() >= 2 ? -500 : 500, bottom: 500, width: 500, height: 500 });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter(message => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.equal(h.api.state.completed, 2);
  assert.equal(h.turns(), 2, 'do not click into the next episode');
  assert.equal(h.now(), captures[1].at, 'do not wait for end-card image coverage');
  assert.equal(h.messages.filter(message => message.action === 'export-capture-session').length, 1);
  assert.match(h.label.textContent, /阅读结束页面/);
});

test('KimiComi hidden viewers and an empty half do not conceal the visible end card', async () => {
  const h = harness({ busy: () => true });
  installComiciEnd(h, { shown: () => true, comicVisible: () => false });
  const result = await h.api.waitForStablePage(waitOptions);
  assert.equal(result.finished, true);
  assert.equal(h.messages.length, 0, 'do not probe or wait for non-comic images');
});

test('KimiComi never stops at an unloaded comic beside the end card or a hidden/incomplete end card', async () => {
  for (const options of [{ comicVisible: () => true }, { shown: () => false }, { inactive: true }, { missingButtons: true }]) {
    const h = harness();
    installComiciEnd(h, { shown: () => true, comicVisible: () => false, ...options });
    const result = await h.api.waitForStablePage({ startUrl: waitOptions.startUrl });
    assert.equal(result.finished, undefined);
    assert.equal(result.changed, true);
  }
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

test('batch captures a settled second page and stops at an unchanged final page', async () => {
  const h = harness({ frame: (time, _probe, turns, turnedAt) => {
    if (!turns) return fingerprint(10);
    if (turns === 1 && time - turnedAt < 3300) return fingerprint(Math.floor((time - turnedAt) / 100));
    return fingerprint(150);
  } });
  await h.api.run({ autoWait: true, delayMs: 100, turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  assert.ok(captures[1].at - captures[0].at >= 3850);
  assert.equal(h.api.state.completed, 2);
  assert.match(h.label.textContent, /未检测到翻页变化/);
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

test('screen detection reuses the saved page as the baseline without taking a pre-turn probe', async () => {
  const h = harness({ frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
  const firstCapture = h.messages.indexOf(captures[0]);
  assert.equal(h.messages[firstCapture + 1].action, 'sample-region');
  assert.equal(h.messages[firstCapture + 1].at - captures[0].at, 550);
  assert.equal(captures[1].at - captures[0].at, 1100);
});

test('screen detection saves the last confirmed probe on every page instead of requesting a new screenshot', async () => {
  const h = harness({ reusableSamples: true, frame: (_time, _probe, turns) => fingerprint(turns ? 150 : 10) });
  await h.api.run({ turnMethod: 'click-left', folder: 'comic' });
  const captures = h.messages.filter((message) => message.action === 'capture-and-store');
  assert.equal(captures.length, 2);
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
