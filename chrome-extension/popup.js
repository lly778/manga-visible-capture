const $ = (id) => document.getElementById(id);
let contentPort = null;

function safeName(value, fallback = "漫画截图") {
  let cleaned = String(value || "").replace(/\.zip$/i, "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return (cleaned || fallback).slice(0, 60).replace(/[. ]+$/g, "") || fallback;
}

function captureSettings() {
  const delaySeconds = Math.max(0.1, Math.min(30, Number($("delay").value) || 0.5));
  return { delaySeconds, turnMethod: $("turnMethod").value };
}

async function saveCaptureSettings(applyToRunningTask = false) {
  const settings = captureSettings();
  $("delay").value = String(settings.delaySeconds);
  await chrome.storage.local.set(settings);
  if (applyToRunningTask) {
    const result = await send("update-settings", {
      delayMs: settings.delaySeconds * 1000,
      turnMethod: settings.turnMethod
    });
    if (result?.applied) show("设置已保存，将从下一次翻页开始生效。");
  }
  return settings;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    throw new Error("请先打开一个普通网页标签页。Chrome 内部页面不能截图。");
  }
  return tab;
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

async function send(action, payload = {}) {
  const tab = await activeTab();
  await ensureContent(tab.id);
  return chrome.tabs.sendMessage(tab.id, { action, ...payload });
}

function show(text, error = false) {
  $("message").textContent = text;
  $("message").style.color = error ? "#b91c1c" : "#1d4ed8";
}

async function refresh() {
  try {
    const state = await send("get-state");
    $("region").textContent = state.region
      ? `已框选 ${Math.round(state.region.width)} × ${Math.round(state.region.height)} 像素`
      : "尚未框选";
    $("start").disabled = !state.region || state.running;
    $("stop").disabled = !state.running;
    $("apply").disabled = !state.running;
    if (state.running) {
      if (Number.isFinite(state.delayMs)) $("delay").value = String(state.delayMs / 1000);
      if (state.turnMethod) $("turnMethod").value = state.turnMethod;
      show(`任务进行中：已截取 ${state.completed} 张`);
    }
  } catch (error) {
    show(error.message, true);
    $("start").disabled = true;
  }
}

$("select").addEventListener("click", async () => {
  try {
    await saveCaptureSettings();
    await send("select-region");
    window.close();
  } catch (error) {
    show(error.message, true);
  }
});

$("detect").addEventListener("click", async () => {
  try {
    const result = await send("auto-detect-region");
    if (!result?.ok) throw new Error(result?.error || "没有识别到合适的漫画区域，请改用手动框选。");
    $("region").textContent = `已自动识别 ${Math.round(result.region.width)} × ${Math.round(result.region.height)} 像素`;
    $("start").disabled = false;
    show("识别结果已在网页中高亮显示；如不准确，请改用手动框选。");
  } catch (error) {
    show(error.message, true);
  }
});

$("start").addEventListener("click", async () => {
  try {
    const settings = await saveCaptureSettings();
    const delayMs = settings.delaySeconds * 1000;
    const folder = safeName($("folder").value);
    $("folder").value = folder;
    await send("start", { delayMs, turnMethod: settings.turnMethod, folder });
    show("已开始。请保持此网页标签页在最前面。");
    window.close();
  } catch (error) {
    show(error.message, true);
  }
});

$("stop").addEventListener("click", async () => {
  try {
    await send("stop");
    show("停止指令已发送。")
    await refresh();
  } catch (error) {
    show(error.message, true);
  }
});

$("apply").addEventListener("click", async () => {
  try {
    const result = await saveCaptureSettings(true);
    if (!result) return;
  } catch (error) {
    show(error.message, true);
  }
});

async function initialize() {
  const stored = await chrome.storage.local.get({ delaySeconds: 0.5, turnMethod: "click-left" });
  const delaySeconds = Math.max(0.1, Math.min(30, Number(stored.delaySeconds) || 0.5));
  const allowedMethods = new Set(["click-left", "click-right", "key-left", "key-right", "none"]);
  $("delay").value = String(delaySeconds);
  $("turnMethod").value = allowedMethods.has(stored.turnMethod) ? stored.turnMethod : "click-left";
  try {
    const tab = await activeTab();
    await ensureContent(tab.id);
    contentPort = chrome.tabs.connect(tab.id, { name: "vmc-popup" });
    $("folder").value = safeName(tab.title);
  } catch {
    $("folder").value = "漫画截图";
  }
  await refresh();
}

$("folder").addEventListener("blur", () => {
  $("folder").value = safeName($("folder").value);
});

$("delay").addEventListener("change", () => {
  saveCaptureSettings(false).catch((error) => show(error.message, true));
});

$("turnMethod").addEventListener("change", () => {
  saveCaptureSettings(false).catch((error) => show(error.message, true));
});

$("exports").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("save.html") });
});

initialize();
