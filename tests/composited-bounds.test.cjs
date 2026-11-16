const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function fit({ viewport = { width: 1707, height: 898 }, count = 2, hintCount = count,
  blank = false, shifted = false, edgeControls = false, aspect = 1409 / 2000 } = {}) {
  const pageWidth = Math.min(viewport.width, viewport.height * aspect * count);
  const pageHeight = pageWidth / (aspect * count);
  const pageLeft = (viewport.width - pageWidth) / 2 + (shifted ? 100 : 0);
  const pageTop = (viewport.height - pageHeight) / 2;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return { drawImage() {}, getImageData: () => {
        const data = new Uint8ClampedArray(this.width * this.height * 4).fill(255);
        for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
          const cssX = (x + 0.5) * viewport.width / this.width;
          const cssY = (y + 0.5) * viewport.height / this.height;
          // White viewer and generous white book margins are indistinguishable
          // by color. The page geometry must preserve both page borders.
          if (!blank && cssX > pageLeft + pageWidth * 0.1 &&
              cssX < pageLeft + pageWidth * 0.9 && cssY > pageTop + pageHeight * 0.04 &&
              cssY < pageTop + pageHeight * 0.96) {
            const offset = (y * this.width + x) * 4;
            data[offset] = data[offset + 1] = data[offset + 2] = 80;
          }
          if (edgeControls && (cssX < 4 || cssX > viewport.width - 4 || cssY < 4)) {
            const offset = (y * this.width + x) * 4;
            data[offset] = 34; data[offset + 1] = 197; data[offset + 2] = 94;
          }
        }
        return { data };
      } };
    }
  }
  const context = { chrome: { runtime: { onMessage: { addListener() {} } } }, OffscreenCanvas: Canvas };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/offscreen.js'), 'utf8'), context);
  const result = context.fitCompositedPageBounds({ pageHint: { aspect, count: hintCount }, viewport,
    region: { left: 0, top: 0, ...viewport } }, viewport);
  return { result, expected: { left: pageLeft, top: pageTop, width: pageWidth, height: pageHeight } };
}

for (const [name, options] of [
  ['wide double page with opaque white gutters', {}],
  ['single page', { viewport: { width: 920, height: 840 }, count: 1 }],
  ['double page with top and bottom gutters', { viewport: { width: 1103, height: 840 } }],
  ['single page explicitly displayed in a wide viewport', { count: 1 }],
  ['page-edge controls do not change fitted geometry', { edgeControls: true }],
  ['visible spread outweighs a single-page buffer hint', { hintCount: 1 }],
  ['visible portrait outweighs a stale spread hint', { viewport: { width: 920, height: 840 }, count: 1, hintCount: 2 }]
]) {
  test(name, () => {
    const { result, expected } = fit(options);
    assert.ok(result);
    for (const key of Object.keys(expected)) assert.ok(Math.abs(result[key] - expected[key]) < 2,
      JSON.stringify({ result, expected }));
  });
}

test('blank screens and shifted or zoomed artwork do not justify fitting a centered page', () => {
  assert.equal(fit({ blank: true }).result, null);
  assert.equal(fit({ shifted: true, count: 1, viewport: { width: 920, height: 840 } }).result, null);
});
