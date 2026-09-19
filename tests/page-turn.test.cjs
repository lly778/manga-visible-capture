const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('left and right clicks land one pixel inside the selected region edges', () => {
  const points = [];
  const events = [];
  const target = { dispatchEvent(event) { events.push(event); } };
  const document = {
    elementFromPoint(x, y) { points.push({ x, y }); return target; }
  };
  const chrome = {
    runtime: {
      onConnect: { addListener() {} },
      onMessage: { addListener() {} }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'content.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.turnPageForTest = turnPage; })();');
  const context = {
    window: {}, document, chrome,
    sessionStorage: { getItem() { return JSON.stringify({ left: 250, top: 100, width: 1000, height: 800 }); } },
    PointerEvent: class { constructor(type, init) { this.type = type; this.clientX = init.clientX; this.clientY = init.clientY; } },
    MouseEvent: class { constructor(type, init) { this.type = type; this.clientX = init.clientX; this.clientY = init.clientY; } },
    setTimeout() {}
  };
  vm.runInNewContext(source, context);

  context.turnPageForTest('click-left');
  context.turnPageForTest('click-right');

  assert.deepEqual(points, [{ x: 251, y: 500 }, { x: 1249, y: 500 }]);
  assert.equal(events.length, 10);
  assert.deepEqual(events.map((event) => event.clientX), [251, 251, 251, 251, 251, 1249, 1249, 1249, 1249, 1249]);
});
