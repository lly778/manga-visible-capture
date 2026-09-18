const sessions = new Map();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function view(size) {
  const bytes = new Uint8Array(size);
  return { bytes, data: new DataView(bytes.buffer) };
}

function makeZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();

  for (const file of files) {
    const name = encoder.encode(file.name);
    const size = file.bytes.length;
    const crc = crc32(file.bytes);
    const local = view(30 + name.length);
    local.data.setUint32(0, 0x04034b50, true);
    local.data.setUint16(4, 20, true);
    local.data.setUint16(6, 0x0800, true);
    local.data.setUint16(8, 0, true);
    local.data.setUint16(10, stamp.time, true);
    local.data.setUint16(12, stamp.date, true);
    local.data.setUint32(14, crc, true);
    local.data.setUint32(18, size, true);
    local.data.setUint32(22, size, true);
    local.data.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    localParts.push(local.bytes, file.bytes);

    const central = view(46 + name.length);
    central.data.setUint32(0, 0x02014b50, true);
    central.data.setUint16(4, 20, true);
    central.data.setUint16(6, 20, true);
    central.data.setUint16(8, 0x0800, true);
    central.data.setUint16(10, 0, true);
    central.data.setUint16(12, stamp.time, true);
    central.data.setUint16(14, stamp.date, true);
    central.data.setUint32(16, crc, true);
    central.data.setUint32(20, size, true);
    central.data.setUint32(24, size, true);
    central.data.setUint16(28, name.length, true);
    central.data.setUint32(42, offset, true);
    central.bytes.set(name, 46);
    centralParts.push(central.bytes);
    offset += local.bytes.length + size;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = view(22);
  end.data.setUint32(0, 0x06054b50, true);
  end.data.setUint16(8, files.length, true);
  end.data.setUint16(10, files.length, true);
  end.data.setUint32(12, centralSize, true);
  end.data.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end.bytes], { type: "application/zip" });
}

async function cropToBytes(message) {
  const response = await fetch(message.dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  const scaleX = bitmap.width / message.viewport.width;
  const scaleY = bitmap.height / message.viewport.height;
  const sx = Math.max(0, Math.round(message.region.left * scaleX));
  const sy = Math.max(0, Math.round(message.region.top * scaleY));
  const sw = Math.min(bitmap.width - sx, Math.round(message.region.width * scaleX));
  const sh = Math.min(bitmap.height - sy, Math.round(message.region.height * scaleY));
  if (sw < 1 || sh < 1) throw new Error("截图区域超出当前窗口，请重新框选。");
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d", { alpha: false }).drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  (async () => {
    if (message.action === "begin") {
      sessions.set(message.sessionId, []);
      return { ok: true };
    }
    if (message.action === "discard") {
      sessions.delete(message.sessionId);
      return { ok: true };
    }
    if (message.action === "crop-store") {
      const files = sessions.get(message.sessionId);
      if (!files) throw new Error("临时截图任务已失效，请重新开始。");
      const bytes = await cropToBytes(message);
      const crc = crc32(bytes);
      const previous = files[files.length - 1];
      if (previous && previous.bytes.length === bytes.length && previous.crc === crc) {
        return { ok: true, count: files.length, bytes: bytes.length, duplicate: true };
      }
      files.push({ name: message.filename, bytes, crc });
      return { ok: true, count: files.length, bytes: bytes.length, duplicate: false };
    }
    if (message.action === "prepare-export") {
      const files = sessions.get(message.sessionId);
      if (!files?.length) throw new Error("没有可以打包的截图。");
      const blob = makeZip(files);
      const url = URL.createObjectURL(blob);
      return { ok: true, url, count: files.length, size: blob.size };
    }
    if (message.action === "finish-export") {
      sessions.delete(message.sessionId);
      setTimeout(() => URL.revokeObjectURL(message.url), 60000);
      return { ok: true };
    }
    return { ok: false, error: "未知操作" };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
