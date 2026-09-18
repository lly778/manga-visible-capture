const pendingDownloadNames = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = pendingDownloadNames.get(item.url);
  if (!filename) return;
  pendingDownloadNames.delete(item.url);
  suggest({ filename, conflictAction: "uniquify" });
});

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "裁剪用户框选的当前可见屏幕截图"
    });
  }
}

function safeName(value, fallback) {
  let cleaned = String(value || "").replace(/\.zip$/i, "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return (cleaned || fallback).slice(0, 60).replace(/[. ]+$/g, "") || fallback;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const actions = new Set([
    "begin-capture-session", "capture-and-store", "export-capture-session", "discard-capture-session"
  ]);
  if (!actions.has(message.action)) return;
  (async () => {
    await ensureOffscreen();
    if (message.action === "begin-capture-session") {
      return chrome.runtime.sendMessage({ target: "offscreen", action: "begin", sessionId: message.sessionId });
    }
    if (message.action === "discard-capture-session") {
      return chrome.runtime.sendMessage({ target: "offscreen", action: "discard", sessionId: message.sessionId });
    }
    if (message.action === "export-capture-session") {
      const zipName = `${safeName(message.zipName, "漫画截图")}.zip`;
      const prepared = await chrome.runtime.sendMessage({
        target: "offscreen",
        action: "prepare-export",
        sessionId: message.sessionId
      });
      if (!prepared?.ok) throw new Error(prepared?.error || "ZIP 生成失败");
      try {
        pendingDownloadNames.set(prepared.url, zipName);
        const downloadId = await chrome.downloads.download({
          url: prepared.url,
          filename: zipName,
          saveAs: false,
          conflictAction: "uniquify"
        });
        setTimeout(() => pendingDownloadNames.delete(prepared.url), 60000);
        await chrome.runtime.sendMessage({
          target: "offscreen",
          action: "finish-export",
          sessionId: message.sessionId,
          url: prepared.url
        });
        return { ok: true, downloadId, count: prepared.count, size: prepared.size };
      } catch (error) {
        pendingDownloadNames.delete(prepared.url);
        await chrome.runtime.sendMessage({
          target: "offscreen",
          action: "finish-export",
          sessionId: message.sessionId,
          url: prepared.url
        }).catch(() => {});
        throw error;
      }
    }
    if (!sender.tab?.id || !sender.tab.active) throw new Error("网页标签页不在前台。");
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
    const stored = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "crop-store",
      dataUrl,
      region: message.region,
      viewport: message.viewport,
      sessionId: message.sessionId,
      filename: `page_${String(message.index).padStart(3, "0")}.png`
    });
    if (!stored?.ok) throw new Error(stored?.error || "截图暂存失败");
    return stored;
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
