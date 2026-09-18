(() => {
  if (window.__visibleMangaCaptureLoaded) return;
  window.__visibleMangaCaptureLoaded = true;

  const state = {
    region: null,
    running: false,
    stopped: false,
    completed: 0,
    activeOptions: null,
    popupConnections: 0,
    panel: null,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUnlessStopped(ms) {
    let remaining = Math.max(0, ms);
    let previous = performance.now();
    while (!state.stopped && remaining > 0) {
      await sleep(Math.min(50, remaining));
      const current = performance.now();
      if (state.popupConnections === 0) remaining -= current - previous;
      previous = current;
    }
  }

  async function waitWhilePopupOpen() {
    while (!state.stopped && state.popupConnections > 0) await sleep(50);
  }

  function remove(id) {
    document.getElementById(id)?.remove();
  }

  function saveRegion(region) {
    state.region = region;
    sessionStorage.setItem("vmc-region", JSON.stringify(region));
  }

  function clampRect(rect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    return { left, top, width: right - left, height: bottom - top };
  }

  function autoDetectRegion() {
    const viewportArea = innerWidth * innerHeight;
    const centerX = innerWidth / 2;
    const centerY = innerHeight / 2;
    const selectors = [
      "canvas", "img", "picture", "svg",
      "[style*='background-image']",
      "[class*='viewer' i]", "[id*='viewer' i]",
      "[class*='comic' i]", "[id*='comic' i]",
      "[class*='manga' i]", "[id*='manga' i]",
      "[class*='episode' i]", "[class*='page-image' i]",
      "[class*='spread' i]", "[class*='swiper' i]"
    ];
    const candidates = new Set(document.querySelectorAll(selectors.join(",")));
    for (const element of [...candidates]) {
      if (element.matches("canvas,img,picture,svg") && element.parentElement) candidates.add(element.parentElement);
    }

    let best = null;
    for (const element of candidates) {
      if (element.closest("#vmc-progress-panel,#vmc-select-overlay,#vmc-detect-preview")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.08) continue;
      const raw = element.getBoundingClientRect();
      const rect = clampRect(raw);
      if (rect.width < 180 || rect.height < 180) continue;
      const area = rect.width * rect.height;
      const areaRatio = area / viewportArea;
      if (areaRatio < 0.08) continue;
      const visibleRatio = area / Math.max(1, raw.width * raw.height);
      if (visibleRatio < 0.55) continue;

      const tag = element.tagName.toLowerCase();
      const identity = `${element.id} ${element.className || ""}`.toLowerCase();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const distance = Math.hypot((cx - centerX) / innerWidth, (cy - centerY) / innerHeight);
      const aspect = rect.width / rect.height;
      let score = Math.min(areaRatio, 0.9) * 120 + Math.max(0, 1 - distance * 2) * 45;
      if (tag === "canvas") score += 65;
      if (tag === "img" || tag === "picture") score += 48;
      if (/viewer|comic|manga|episode|page|spread/.test(identity)) score += 36;
      if (aspect >= 0.42 && aspect <= 2.35) score += 18;
      if (rect.height >= innerHeight * 0.55) score += 20;
      if (areaRatio > 0.97) score -= 75;
      if (/header|footer|nav|toolbar|menu|banner|advert|recommend/.test(identity)) score -= 90;
      if (style.position === "fixed" && areaRatio < 0.35) score -= 45;
      if (!best || score > best.score) best = { element, region: rect, score };
    }
    if (!best || best.score < 70) return null;

    const margin = 2;
    const region = {
      left: Math.max(0, Math.round(best.region.left - margin)),
      top: Math.max(0, Math.round(best.region.top - margin)),
      width: Math.min(innerWidth, Math.round(best.region.width + margin * 2)),
      height: Math.min(innerHeight, Math.round(best.region.height + margin * 2))
    };
    region.width = Math.min(region.width, innerWidth - region.left);
    region.height = Math.min(region.height, innerHeight - region.top);
    saveRegion(region);
    previewDetectedRegion(region);
    return region;
  }

  function previewDetectedRegion(region) {
    remove("vmc-detect-preview");
    const preview = document.createElement("div");
    preview.id = "vmc-detect-preview";
    Object.assign(preview.style, {
      position: "fixed", left: `${region.left}px`, top: `${region.top}px`,
      width: `${region.width}px`, height: `${region.height}px`, zIndex: "2147483645",
      border: "4px solid #22c55e", boxSizing: "border-box", pointerEvents: "none",
      boxShadow: "inset 0 0 0 2px rgba(255,255,255,.85),0 0 0 9999px rgba(2,6,23,.16)"
    });
    const label = document.createElement("div");
    label.textContent = "已自动识别漫画区域";
    Object.assign(label.style, {
      position: "absolute", left: "8px", top: "8px", padding: "6px 9px", borderRadius: "7px",
      color: "white", background: "#16a34a", font: "600 13px/1.4 system-ui,sans-serif"
    });
    preview.appendChild(label);
    document.documentElement.appendChild(preview);
    setTimeout(() => preview.remove(), 2600);
  }

  function selectRegion() {
    remove("vmc-select-overlay");
    const overlay = document.createElement("div");
    overlay.id = "vmc-select-overlay";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair",
      background: "rgba(2,6,23,.32)", userSelect: "none"
    });
    const tip = document.createElement("div");
    tip.textContent = "拖动框选漫画显示区域 · Esc 取消";
    Object.assign(tip.style, {
      position: "fixed", top: "18px", left: "50%", transform: "translateX(-50%)",
      padding: "10px 16px", borderRadius: "10px", color: "white", background: "rgba(15,23,42,.92)",
      font: "600 15px/1.4 system-ui,sans-serif"
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", display: "none", border: "3px solid #38bdf8",
      background: "rgba(14,165,233,.16)", pointerEvents: "none"
    });
    overlay.append(tip, box);
    document.documentElement.appendChild(overlay);

    let start = null;
    const cancel = () => overlay.remove();
    const keyHandler = (event) => {
      if (event.key === "Escape") {
        cancel();
        document.removeEventListener("keydown", keyHandler, true);
      }
    };
    document.addEventListener("keydown", keyHandler, true);

    overlay.addEventListener("pointerdown", (event) => {
      start = { x: event.clientX, y: event.clientY };
      box.style.display = "block";
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!start) return;
      const left = Math.min(start.x, event.clientX);
      const top = Math.min(start.y, event.clientY);
      const width = Math.abs(event.clientX - start.x);
      const height = Math.abs(event.clientY - start.y);
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!start) return;
      const left = Math.max(0, Math.min(start.x, event.clientX));
      const top = Math.max(0, Math.min(start.y, event.clientY));
      const right = Math.min(innerWidth, Math.max(start.x, event.clientX));
      const bottom = Math.min(innerHeight, Math.max(start.y, event.clientY));
      if (right - left < 80 || bottom - top < 80) {
        tip.textContent = "范围太小，请重新框选 · Esc 取消";
        start = null;
        box.style.display = "none";
        return;
      }
      saveRegion({ left, top, width: right - left, height: bottom - top });
      overlay.remove();
      document.removeEventListener("keydown", keyHandler, true);
      showPanel("区域已保存。再次点击扩展图标即可开始。", false);
    });
  }

  function showPanel(text, stoppable = true) {
    if (!state.panel) {
      const panel = document.createElement("div");
      panel.id = "vmc-progress-panel";
      Object.assign(panel.style, {
        position: "fixed", right: "18px", bottom: "18px", zIndex: "2147483646",
        padding: "12px 14px", borderRadius: "11px", color: "white", background: "rgba(15,23,42,.94)",
        boxShadow: "0 10px 30px rgba(0,0,0,.3)", font: "600 13px/1.4 system-ui,sans-serif"
      });
      const label = document.createElement("span");
      label.className = "vmc-label";
      const stop = document.createElement("button");
      stop.textContent = "停止";
      stop.className = "vmc-stop";
      Object.assign(stop.style, {
        marginLeft: "12px", padding: "5px 9px", border: "0", borderRadius: "7px",
        background: "#ef4444", color: "white", cursor: "pointer", font: "inherit"
      });
      stop.addEventListener("click", () => { state.stopped = true; });
      panel.append(label, stop);
      document.documentElement.appendChild(panel);
      state.panel = panel;
    }
    state.panel.querySelector(".vmc-label").textContent = text;
    state.panel.querySelector(".vmc-stop").style.display = stoppable ? "inline-block" : "none";
  }

  async function capture(sessionId, index) {
    state.panel.style.visibility = "hidden";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const response = await chrome.runtime.sendMessage({
        action: "capture-and-store",
        region: state.region,
        viewport: { width: innerWidth, height: innerHeight },
        sessionId,
        index
      });
      if (!response?.ok) throw new Error(response?.error || "截图失败");
      return response;
    } finally {
      state.panel.style.visibility = "visible";
    }
  }

  function turnPage(method) {
    if (method === "none") return;
    if (method.startsWith("key-")) {
      const key = method === "key-left" ? "ArrowLeft" : "ArrowRight";
      const code = key;
      const target = document.activeElement || document.body;
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
      }
      return;
    }
    const x = method === "click-left"
      ? state.region.left + state.region.width * 0.08
      : state.region.left + state.region.width * 0.92;
    const y = state.region.top + state.region.height * 0.5;
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  }

  async function run(options) {
    if (state.running) throw new Error("已有任务正在运行。");
    if (!state.region) throw new Error("请先框选漫画区域。");
    state.running = true;
    state.stopped = false;
    state.completed = 0;
    state.activeOptions = options;
    const startUrl = location.href;
    const sessionId = crypto.randomUUID();
    let terminalMessage = "";
    showPanel("准备截图…");
    try {
      const begin = await chrome.runtime.sendMessage({ action: "begin-capture-session", sessionId });
      if (!begin?.ok) throw new Error(begin?.error || "无法创建临时截图任务。");
      await waitUnlessStopped(700);
      for (let i = 1; !state.stopped; i++) {
        await waitWhilePopupOpen();
        if (state.stopped) break;
        if (document.visibilityState !== "visible") throw new Error("标签页已不在前台，任务已停止。");
        if (location.href !== startUrl) {
          throw new Error("网页页码或地址发生变化，任务已停止。");
        }
        showPanel(`正在保存第 ${i} 张…`);
        const captured = await capture(sessionId, i);
        if (captured.duplicate) {
          state.stopped = true;
          terminalMessage = `检测到翻页后画面未变化，已自动停止，共截取 ${state.completed} 张。`;
          break;
        }
        state.completed = i;
        if (!state.stopped) {
          await waitWhilePopupOpen();
          if (state.stopped) break;
          turnPage(state.activeOptions.turnMethod);
          showPanel(`已保存 ${i} 张，等待翻页…`);
          await waitUnlessStopped(state.activeOptions.delayMs);
        }
      }
      if (!terminalMessage) terminalMessage = `已停止，共截取 ${state.completed} 张。`;
    } catch (error) {
      state.stopped = true;
      terminalMessage = error.message || "任务异常停止。";
    } finally {
      if (state.completed > 0) {
        showPanel(`正在把 ${state.completed} 张图片生成 ZIP…`, false);
        try {
          const exported = await chrome.runtime.sendMessage({
            action: "export-capture-session",
            sessionId,
            zipName: options.folder
          });
          if (!exported?.ok) throw new Error(exported?.error || "ZIP 生成失败。");
          showPanel(`${terminalMessage} ZIP 已开始下载。`, false);
        } catch (error) {
          showPanel(`${terminalMessage} 但 ZIP 生成失败：${error.message}`, false);
        }
      } else {
        await chrome.runtime.sendMessage({ action: "discard-capture-session", sessionId }).catch(() => {});
        showPanel(terminalMessage || "未产生截图。", false);
      }
      state.running = false;
      state.activeOptions = null;
      setTimeout(() => {
        if (state.panel && !state.running) { state.panel.remove(); state.panel = null; }
      }, 7000);
    }
  }

  try {
    const stored = JSON.parse(sessionStorage.getItem("vmc-region") || "null");
    if (stored?.width > 0 && stored?.height > 0) state.region = stored;
  } catch {}

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "vmc-popup") return;
    state.popupConnections += 1;
    port.onDisconnect.addListener(() => {
      state.popupConnections = Math.max(0, state.popupConnections - 1);
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "ping") { sendResponse({ ok: true }); return; }
    if (message.action === "get-state") {
      sendResponse({
        region: state.region,
        running: state.running,
        completed: state.completed,
        delayMs: state.activeOptions?.delayMs,
        turnMethod: state.activeOptions?.turnMethod
      });
      return;
    }
    if (message.action === "select-region") { selectRegion(); sendResponse({ ok: true }); return; }
    if (message.action === "auto-detect-region") {
      const region = autoDetectRegion();
      sendResponse(region ? { ok: true, region } : { ok: false, error: "没有识别到合适的漫画区域，请改用手动框选。" });
      return;
    }
    if (message.action === "update-settings") {
      const methods = new Set(["click-left", "click-right", "key-left", "key-right", "none"]);
      if (state.running && state.activeOptions) {
        state.activeOptions.delayMs = Math.max(100, Math.min(30000, Number(message.delayMs) || 500));
        if (methods.has(message.turnMethod)) state.activeOptions.turnMethod = message.turnMethod;
      }
      sendResponse({ ok: true, applied: state.running });
      return;
    }
    if (message.action === "stop") { state.stopped = true; sendResponse({ ok: true }); return; }
    if (message.action === "start") {
      run(message).catch((error) => showPanel(error.message, false));
      sendResponse({ ok: true });
    }
  });
})();
