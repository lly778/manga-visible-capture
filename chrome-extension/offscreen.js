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

function samePageFingerprint(previous, current) {
  if (!previous || !current || previous.length !== current.length || !current.length) return false;
  let changed = 0;
  let totalDifference = 0;
  for (let i = 0; i < current.length; i++) {
    const difference = Math.abs(previous[i] - current[i]);
    totalDifference += difference;
    if (difference >= 24) changed++;
  }
  return changed <= Math.max(8, Math.floor(current.length * 0.02)) &&
    totalDifference / current.length <= 5;
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
  const sampleSize = 64;
  const sample = new OffscreenCanvas(sampleSize, sampleSize);
  const context = sample.getContext("2d", { willReadFrequently: true });
  const insetX = Math.floor(sw * 0.03);
  const insetY = Math.floor(sh * 0.03);
  context.drawImage(canvas, insetX, insetY, sw - insetX * 2, sh - insetY * 2,
    0, 0, sampleSize, sampleSize);
  const pixels = context.getImageData(0, 0, sampleSize, sampleSize).data;
  const fingerprint = new Uint8Array(sampleSize * sampleSize);
  for (let i = 0; i < fingerprint.length; i++) {
    const offset = i * 4;
    fingerprint[i] = Math.round(pixels[offset] * 0.299 +
      pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), fingerprint };
}

async function trimBlackBorders(message) {
  const response = await fetch(message.dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const scaleX = bitmap.width / message.viewport.width;
    const scaleY = bitmap.height / message.viewport.height;
    const sourceX = Math.max(0, Math.round(message.region.left * scaleX));
    const sourceY = Math.max(0, Math.round(message.region.top * scaleY));
    const sourceWidth = Math.min(bitmap.width - sourceX, Math.round(message.region.width * scaleX));
    const sourceHeight = Math.min(bitmap.height - sourceY, Math.round(message.region.height * scaleY));
    if (sourceWidth < 200 || sourceHeight < 200) return message.region;

    const analyze = (width, allowObscuredUpperArea = false) => {
      const sampleWidth = Math.min(512, width);
      const canvas = new OffscreenCanvas(sampleWidth, 96);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, sourceX, sourceY, width, sourceHeight,
        0, 0, sampleWidth, 96);
      const pixels = context.getImageData(0, 0, sampleWidth, 96).data;
      const isDarkBorderColumn = (x) => {
        let dark = 0;
        let lowerDark = 0;
        for (let y = 10; y < 70; y += 2) {
          const offset = (y * sampleWidth + x) * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          if (Math.max(red, green, blue) <= 95 &&
              Math.max(red, green, blue) - Math.min(red, green, blue) <= 20) dark++;
        }
        if (dark / 30 >= 0.8) return true;
        if (!allowObscuredUpperArea) return false;
        for (let y = 72; y < 96; y += 2) {
          const offset = (y * sampleWidth + x) * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          if (Math.max(red, green, blue) <= 95 &&
              Math.max(red, green, blue) - Math.min(red, green, blue) <= 20) lowerDark++;
        }
        return lowerDark / 12 >= 0.85;
      };
      const maxSide = Math.floor(sampleWidth * 0.65);
      const maxOuterStrip = Math.ceil(sampleWidth * 0.02);
      const borderWidth = (fromLeft) => {
        let distance = 0;
        const column = () => fromLeft ? distance : sampleWidth - 1 - distance;
        while (distance < maxOuterStrip && !isDarkBorderColumn(column())) distance++;
        const darkStart = distance;
        while (distance < maxSide && isDarkBorderColumn(column())) distance++;
        return distance - darkStart >= Math.max(8, Math.round(sampleWidth * 0.03))
          ? distance : 0;
      };
      return { left: borderWidth(true), right: borderWidth(false), sampleWidth };
    };
    const recoverPageEdges = (region) => {
      if (region.width / region.height < 1) return region;
      const recoverEdge = (current, fromLeft) => {
        const available = fromLeft ? current.left
          : message.viewport.width - current.left - current.width;
        if (available <= 0) return current;
        const edgeX = Math.round((fromLeft ? current.left : current.left + current.width) * scaleX);
        const probeWidth = Math.min(Math.round(available * scaleX),
          Math.round(region.width * scaleX * 0.06));
        if (probeWidth < 12) return current;
        const sampleWidth = Math.min(96, probeWidth);
        const canvas = new OffscreenCanvas(sampleWidth, 96);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, fromLeft ? edgeX - probeWidth : edgeX,
          sourceY, probeWidth, sourceHeight, 0, 0, sampleWidth, 96);
        const pixels = context.getImageData(0, 0, sampleWidth, 96).data;
        const darkColumn = (x) => {
          let dark = 0;
          for (let y = 10; y < 70; y += 2) {
            const offset = (y * sampleWidth + x) * 4;
            const red = pixels[offset];
            const green = pixels[offset + 1];
            const blue = pixels[offset + 2];
            if (Math.max(red, green, blue) <= 95 &&
                Math.max(red, green, blue) - Math.min(red, green, blue) <= 20) dark++;
          }
          return dark / 30 >= 0.8;
        };
        for (let distance = 3; distance <= sampleWidth - 6; distance++) {
          const x = fromLeft ? sampleWidth - 1 - distance : distance;
          if (darkColumn(x)) {
            let run = 1;
            while (run < 6 && darkColumn(fromLeft ? x - run : x + run)) run++;
            if (run === 6) {
              const extra = Math.round(distance * probeWidth / sampleWidth / scaleX);
              if (extra > 3) {
                const amount = Math.min(extra, available);
                return { ...current,
                  left: fromLeft ? current.left - amount : current.left,
                  width: current.width + amount };
              }
              return current;
            }
            distance += run - 1;
          }
        }
        return current;
      };
      return recoverEdge(recoverEdge(region, true), false);
    };
    const { left, right, sampleWidth } = analyze(sourceWidth, true);
    if (sampleWidth - left - right < sampleWidth * 0.25) {
      return message.region;
    }
    const trimmedLeft = Math.round(left * message.region.width / sampleWidth);
    const trimmedRight = Math.round(right * message.region.width / sampleWidth);
    const pageWidth = message.region.width - trimmedRight;
    const portraitPage = !left && pageWidth >= 180 &&
      pageWidth / message.region.height >= 0.45 &&
      pageWidth / message.region.height <= 0.95 &&
      message.region.left <= message.viewport.width * 0.3 &&
      pageWidth <= message.viewport.width * 0.5;
    if (portraitPage) {
      const targetWidth = Math.round(pageWidth * 2);
      if (targetWidth > message.viewport.width - message.region.left) return message.region;
      if (targetWidth <= message.region.width) {
        // The initial region already contains the blank second-page slot.
        return { ...message.region, width: targetWidth };
      }
      // A left-positioned portrait page is one half of the spread. The blank
      // right-hand slot is needed even if pixel sampling is obstructed.
      return { ...message.region, width: targetWidth };
    }
    if (!trimmedLeft && !trimmedRight) return recoverPageEdges(message.region);
    return recoverPageEdges({
      ...message.region,
      left: message.region.left + trimmedLeft,
      width: message.region.width - trimmedLeft - trimmedRight
    });
  } finally {
    bitmap.close();
  }
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
    if (message.action === "trim-black-borders") {
      return { ok: true, region: await trimBlackBorders(message) };
    }
    if (message.action === "crop-store") {
      const files = sessions.get(message.sessionId);
      if (!files) throw new Error("临时截图任务已失效，请重新开始。");
      const { bytes, fingerprint } = await cropToBytes(message);
      const crc = crc32(bytes);
      const previous = files[files.length - 1];
      if (previous && (
        (previous.bytes.length === bytes.length && previous.crc === crc) ||
        samePageFingerprint(previous.fingerprint, fingerprint)
      )) {
        return { ok: true, count: files.length, bytes: bytes.length, duplicate: true };
      }
      files.push({ name: message.filename, bytes, crc, fingerprint });
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
