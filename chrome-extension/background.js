const pendingCaptures = new Map();
const finalizingSessions = new Map();
const sessionKey = (tabId) => `vmc-capture-${tabId}`;
let creatingOffscreen = null;
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
const sampledScreens = new Map();

async function assertForegroundTab(tab) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) throw new Error("网页标签页不在前台。");
}

// Chrome limits captureVisibleTab to two calls per second. All consumers share
// this queue, including region detection, stability probes and saved captures.
function captureVisibleRegion(tab) {
  const task = captureQueue.catch(() => {}).then(async () => {
    const remaining = 550 - (Date.now() - lastCaptureAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    await assertForegroundTab(tab);
    lastCaptureAt = Date.now();
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  });
  captureQueue = task;
  return task;
}

async function activeSession(tabId) {
  const key = sessionKey(tabId);
  return (await chrome.storage.session.get(key))[key];
}

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
  sampledScreens.delete(tabId);
  if (finalizingSessions.has(sessionId)) return finalizingSessions.get(sessionId);
  const task = (async () => {
    await pendingCaptures.get(tabId)?.catch(() => {});
    await ensureOffscreen();
    const zipName = `${safeName(requestedName, "漫画截图")}.zip`;
    const exportKey = `vmc-export-${sessionId}`;
    const existing = (await chrome.storage.session.get(exportKey))[exportKey];
    const prepared = existing || await chrome.runtime.sendMessage({
      target: "offscreen", action: "prepare-export", sessionId
    });
    if (!prepared?.ok) throw new Error(prepared?.error || "ZIP 生成失败");
    await chrome.storage.session.set({
      [exportKey]: { ...prepared, sessionId, filename: existing?.filename || zipName }
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`save.html#${encodeURIComponent(sessionId)}`) });
    if ((await activeSession(tabId))?.sessionId === sessionId) {
      await chrome.storage.session.remove(sessionKey(tabId));
    }
    return { ok: true, pendingSave: true, count: prepared.count, size: prepared.size };
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
    sampledScreens.delete(tabId);
    finishNavigatingTab(tabId).catch((error) => console.error("无法在页面跳转后导出 ZIP", error));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sampledScreens.delete(tabId);
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
    "complete-saved-export",
    "begin-capture-session", "capture-and-store", "export-capture-session",
    "discard-capture-session", "trim-black-borders", "sample-region"
  ]);
  if (!actions.has(message.action)) return;
  const captureTabId = message.action === "capture-and-store" ? sender.tab?.id : null;
  const previousCapture = pendingCaptures.get(captureTabId);
  const alreadyFinalizing = captureTabId != null && finalizingSessions.has(message.sessionId);
  // Register the entire capture before the first await, including screenshot
  // acquisition. Navigation and stop must not export or discard it midway.
  const task = Promise.resolve().then(async () => {
    if (alreadyFinalizing) throw new Error("截图任务正在导出，请重新开始。");
    await previousCapture?.catch(() => {});
    if (message.action === "complete-saved-export") {
      if (sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("save.html")) {
        throw new Error("请从 ZIP 保存页完成保存。");
      }
      const key = `vmc-export-${message.sessionId}`;
      const entry = (await chrome.storage.session.get(key))[key];
      if (entry) {
        const result = await chrome.runtime.sendMessage({
          target: "offscreen", action: "finish-export", sessionId: entry.sessionId, url: entry.url
        });
        if (!result?.ok) throw new Error(result?.error || "暂存清理失败");
        await chrome.storage.session.remove(key);
      }
      return { ok: true };
    }
    await ensureOffscreen();
    if (message.action === "begin-capture-session") {
      sampledScreens.delete(sender.tab?.id);
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
      sampledScreens.delete(sender.tab?.id);
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
    const cropKey = JSON.stringify([message.region, message.viewport]);
    const sampled = sampledScreens.get(sender.tab.id);
    const reuse = message.action === "capture-and-store" && message.sampleId &&
      sampled?.sampleId === message.sampleId && sampled.cropKey === cropKey &&
      Date.now() - sampled.at <= 2000;
    let dataUrl;
    if (reuse) {
      // The last unchanged probe is already a full-resolution Chrome PNG.
      // Save that confirmed frame without another rate-limited screenshot.
      await assertForegroundTab(sender.tab);
      dataUrl = sampled.dataUrl;
      sampledScreens.delete(sender.tab.id);
    } else {
      dataUrl = await captureVisibleRegion(sender.tab);
    }
    if (message.action === "sample-region") {
      const result = await chrome.runtime.sendMessage({
        target: "offscreen", action: "sample-region", dataUrl,
        region: message.region, viewport: message.viewport
      });
      if (!result?.ok) return result;
      const sampleId = crypto.randomUUID();
      sampledScreens.set(sender.tab.id, { sampleId, cropKey, dataUrl, at: Date.now() });
      return { ...result, sampleId };
    }
    if (message.action === "trim-black-borders") {
      return chrome.runtime.sendMessage({
        target: "offscreen",
        action: "trim-black-borders",
        dataUrl,
        region: message.region,
        viewport: message.viewport
      });
    }
    const stored = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "crop-store",
      dataUrl,
      region: message.region,
      viewport: message.viewport,
      sessionId: message.sessionId,
      deferEncoding: true,
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
  });
  if (captureTabId != null && !alreadyFinalizing) {
    pendingCaptures.set(captureTabId, task);
    const clearCapture = () => {
      if (pendingCaptures.get(captureTabId) === task) pendingCaptures.delete(captureTabId);
    };
    task.then(clearCapture, clearCapture);
  }
  task.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
