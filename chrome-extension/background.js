const pendingDownloadNames = new Map();
const pendingCaptures = new Map();
const finalizingSessions = new Map();
const sessionKey = (tabId) => `vmc-capture-${tabId}`;
let creatingOffscreen = null;

async function activeSession(tabId) {
  const key = sessionKey(tabId);
  return (await chrome.storage.session.get(key))[key];
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = pendingDownloadNames.get(item.url);
  if (!filename) return;
  pendingDownloadNames.delete(item.url);
  suggest({ filename, conflictAction: "uniquify" });
});

async function ensureOffscreen() {
  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      const url = chrome.runtime.getURL("offscreen.html");
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url]
      });
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification: "裁剪用户框选的当前可见屏幕截图"
        });
      }
    })();
  }
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function exportSession(tabId, sessionId, requestedName) {
  if (finalizingSessions.has(sessionId)) return finalizingSessions.get(sessionId);
  const task = (async () => {
    await pendingCaptures.get(tabId)?.catch(() => {});
    await ensureOffscreen();
    const zipName = `${safeName(requestedName, "漫画截图")}.zip`;
    const prepared = await chrome.runtime.sendMessage({
      target: "offscreen", action: "prepare-export", sessionId
    });
    if (!prepared?.ok) throw new Error(prepared?.error || "ZIP 生成失败");
    try {
      pendingDownloadNames.set(prepared.url, zipName);
      const downloadId = await chrome.downloads.download({
        url: prepared.url, filename: zipName, saveAs: false, conflictAction: "uniquify"
      });
      setTimeout(() => pendingDownloadNames.delete(prepared.url), 60000);
      await chrome.runtime.sendMessage({
        target: "offscreen", action: "finish-export", sessionId, url: prepared.url
      });
      if ((await activeSession(tabId))?.sessionId === sessionId) {
        await chrome.storage.session.remove(sessionKey(tabId));
      }
      return { ok: true, downloadId, count: prepared.count, size: prepared.size };
    } catch (error) {
      pendingDownloadNames.delete(prepared.url);
      await chrome.runtime.sendMessage({
        target: "offscreen", action: "finish-export", sessionId, url: prepared.url
      }).catch(() => {});
      throw error;
    }
  })();
  finalizingSessions.set(sessionId, task);
  task.then(() => setTimeout(() => finalizingSessions.delete(sessionId), 60000),
    () => finalizingSessions.delete(sessionId));
  return task;
}

async function finishNavigatingTab(tabId) {
  const session = await activeSession(tabId);
  if (!session) return;
  await pendingCaptures.get(tabId)?.catch(() => {});
  const latest = await activeSession(tabId);
  if (!latest || latest.sessionId !== session.sessionId) return;
  if (latest.completed > 0) {
    await exportSession(tabId, latest.sessionId, latest.zipName);
  } else {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: "offscreen", action: "discard", sessionId: latest.sessionId
    });
    if ((await activeSession(tabId))?.sessionId === latest.sessionId) {
      await chrome.storage.session.remove(sessionKey(tabId));
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) {
    finishNavigatingTab(tabId).catch((error) => console.error("无法在页面跳转后导出 ZIP", error));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  finishNavigatingTab(tabId).catch((error) => console.error("无法在标签页关闭后导出 ZIP", error));
});

function safeName(value, fallback) {
  let cleaned = String(value || "").replace(/\.zip$/i, "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return (cleaned || fallback).slice(0, 60).replace(/[. ]+$/g, "") || fallback;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") return;
  const actions = new Set([
    "begin-capture-session", "capture-and-store", "export-capture-session",
    "discard-capture-session", "trim-black-borders"
  ]);
  if (!actions.has(message.action)) return;
  (async () => {
    await ensureOffscreen();
    if (message.action === "begin-capture-session") {
      const begun = await chrome.runtime.sendMessage({
        target: "offscreen", action: "begin", sessionId: message.sessionId
      });
      if (begun?.ok && sender.tab?.id != null) {
        await chrome.storage.session.set({
          [sessionKey(sender.tab.id)]: {
            sessionId: message.sessionId,
            zipName: message.zipName,
            completed: 0
          }
        });
      }
      return begun;
    }
    if (message.action === "discard-capture-session") {
      const discarded = await chrome.runtime.sendMessage({
        target: "offscreen", action: "discard", sessionId: message.sessionId
      });
      if (sender.tab?.id != null &&
          (await activeSession(sender.tab.id))?.sessionId === message.sessionId) {
        await chrome.storage.session.remove(sessionKey(sender.tab.id));
      }
      return discarded;
    }
    if (message.action === "export-capture-session") {
      if (sender.tab?.id == null) throw new Error("无法确定截图标签页。");
      return exportSession(sender.tab.id, message.sessionId, message.zipName);
    }
    if (!sender.tab?.id || !sender.tab.active) throw new Error("网页标签页不在前台。");
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
    if (message.action === "trim-black-borders") {
      return chrome.runtime.sendMessage({
        target: "offscreen",
        action: "trim-black-borders",
        dataUrl,
        region: message.region,
        viewport: message.viewport
      });
    }
    const captureTask = (async () => {
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
      const session = await activeSession(sender.tab.id);
      if (session?.sessionId === message.sessionId) {
        await chrome.storage.session.set({
          [sessionKey(sender.tab.id)]: { ...session, completed: stored.count }
        });
      }
      return stored;
    })();
    pendingCaptures.set(sender.tab.id, captureTask);
    try {
      return await captureTask;
    } finally {
      if (pendingCaptures.get(sender.tab.id) === captureTask) pendingCaptures.delete(sender.tab.id);
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
