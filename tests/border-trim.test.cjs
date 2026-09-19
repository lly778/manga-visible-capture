const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function trimWithBorders(leftBorder, rightBorder, outsideDark = true,
  obscuredAbove = false, regionWidth = 512, extraArtwork = 0, extraArtworkLeft = 0) {
  let listener;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      let sourceX;
      let sourceWidth;
      return {
        drawImage(_bitmap, x, _y, width) { sourceX = x; sourceWidth = width; },
        getImageData: () => {
          const pixels = new Uint8ClampedArray(this.width * this.height * 4);
          for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
              const sourceColumn = sourceX + (x + 0.5) * sourceWidth / this.width;
              const pageEnd = 100 + regionWidth - rightBorder + extraArtwork;
              const isBorder = sourceColumn < 100 + leftBorder - extraArtworkLeft ||
                (sourceColumn >= pageEnd && (outsideDark || sourceColumn < 100 + regionWidth));
              const hiddenByOverlay = obscuredAbove && sourceColumn >= 100 + regionWidth && y < 68;
              const shade = isBorder && !hiddenByOverlay ? 0 : 255;
              const offset = (y * this.width + x) * 4;
              pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = shade;
              pixels[offset + 3] = 255;
            }
          }
          return { data: pixels };
        }
      };
    }
  }
  const chrome = { runtime: { onMessage: { addListener(callback) { listener = callback; } } } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'offscreen.js'), 'utf8');
  vm.runInNewContext(source, {
    chrome, OffscreenCanvas: Canvas,
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => ({ width: 1600, height: 640, close() {} }),
    Uint8Array, Uint32Array, Uint8ClampedArray, DataView, Blob, TextEncoder, Date, URL, setTimeout
  });
  const region = { left: 100, top: 0, width: regionWidth, height: 640 };
  return new Promise((resolve) => {
    assert.equal(listener({
      target: 'offscreen', action: 'trim-black-borders', dataUrl: 'data:image/png;base64,',
      viewport: { width: 1600, height: 640 }, region
    }, {}, resolve), true);
  });
}

test('reserves a second-page slot as wide as the detected first page', async () => {
  const result = await trimWithBorders(0, 160);
  assert.equal(result.ok, true);
  assert.equal(result.region.left, 100);
  assert.equal(result.region.width, 704);
});

test('expands a partial second-page slot to one full page width', async () => {
  const result = await trimWithBorders(0, 80);
  assert.equal(result.region.left, 100);
  assert.equal(result.region.width, 864);
});

test('adds a right gutter when the detected region ends at the page edge', async () => {
  const result = await trimWithBorders(0, 0);
  assert.equal(result.region.left, 100);
  assert.equal(result.region.width, 1024);
});

test('adds the right gutter even when its upper part is obscured', async () => {
  const result = await trimWithBorders(0, 0, true, true);
  assert.equal(result.region.left, 100);
  assert.equal(result.region.width, 1024);
});

test('reserves the right-hand page slot without relying on a dark-pixel check', async () => {
  const result = await trimWithBorders(0, 0, false);
  assert.equal(result.region.width, 1024);
});

test('keeps an already two-page-wide region without adding side margins', async () => {
  const result = await trimWithBorders(0, 0, true, false, 1000);
  assert.equal(result.region.left, 100);
  assert.equal(result.region.width, 1000);
});

test('recovers a narrow strip of normal artwork cut from the right-hand page', async () => {
  const result = await trimWithBorders(0, 0, true, false, 1000, 20);
  assert.ok(Math.abs(result.region.width - 1020) <= 2);
});

test('recovers a narrow strip of normal artwork cut from the left-hand page', async () => {
  const result = await trimWithBorders(0, 0, true, false, 1000, 0, 20);
  assert.ok(Math.abs(result.region.left - 80) <= 2);
  assert.ok(Math.abs(result.region.width - 1020) <= 2);
});

test('trims dark gutters when both sides border the page', async () => {
  const result = await trimWithBorders(64, 64);
  assert.equal(result.ok, true);
  assert.equal(result.region.left, 164);
  assert.equal(result.region.width, 384);
});
