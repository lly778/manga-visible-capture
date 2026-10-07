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
    waitStatus: "",
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUnlessStopped(ms) {
    let remaining = Math.max(0, ms);
    let previous = performance.now();
    let elapsed = 0;
    while (!state.stopped && remaining > 0) {
      await sleep(Math.min(50, remaining));
      const current = performance.now();
      if (state.popupConnections === 0) {
        remaining -= current - previous;
        elapsed += current - previous;
      }
      previous = current;
    }
    return elapsed;
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

  async function autoDetectRegion() {
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
      let parent = element.parentElement;
      for (let depth = 0; depth < 4 && parent && parent !== document.body; depth++) {
        candidates.add(parent);
        parent = parent.parentElement;
      }
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
      const tallVisibleImage = raw.height > innerHeight * 1.2 &&
        rect.height >= innerHeight * 0.7 && rect.width / Math.max(1, raw.width) >= 0.8;
      if (visibleRatio < 0.55 && !tallVisibleImage) continue;

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
      if (rect.height >= innerHeight * 0.85) score += 35;
      if (rect.height < innerHeight * 0.5) score -= 45;
      if (areaRatio > 0.97) score -= 75;
      if (/header|footer|nav|toolbar|menu|banner|advert|recommend/.test(identity)) score -= 90;
      if (style.position === "fixed" && areaRatio < 0.35) score -= 45;
      if (!best || score > best.score) best = { element, region: rect, score };
    }
    if (!best || best.score < 70) return null;

    const outer = best.region;
    const outerBottom = outer.top + outer.height;
    let imageTop = null;
    let imageBottom = null;
    for (const element of candidates) {
      if (!/^(IMG|CANVAS|PICTURE|SVG)$/.test(element.tagName)) continue;
      let parent = element.parentElement;
      let inside = false;
      while (parent && parent !== document.body) {
        if (parent === best.element) { inside = true; break; }
        parent = parent.parentElement;
      }
      if (!inside) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.08) continue;
      const image = clampRect(element.getBoundingClientRect());
      const imageBottomCandidate = image.top + image.height;
      const aspect = image.width / image.height;
      if (image.top < outer.top - 8 || imageBottomCandidate > outerBottom + 8 ||
          image.height < outer.height * 0.75 || image.width < outer.width * 0.3 ||
          aspect < 0.4 || aspect > 2.2 ||
          image.left < outer.left - 8 || image.left + image.width > outer.left + outer.width + 8) continue;
      imageTop = Math.min(imageTop ?? Infinity, image.top);
      imageBottom = Math.max(imageBottom ?? 0, imageBottomCandidate);
    }
    if (imageTop !== null && imageBottom !== null) {
      best.region = { ...outer, top: imageTop, height: imageBottom - imageTop };
    }

    // A page may be several horizontal image strips. Merge their DOM bounds
    // before measuring the spread; white viewer gutters cannot be inferred
    // safely from pixels because the artwork itself can have white margins.
    const columns = [];
    for (const element of candidates) {
      if (!/^(IMG|CANVAS)$/.test(element.tagName)) continue;
      let inside = element === best.element;
      let visible = true;
      for (let parent = element; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent === best.element) inside = true;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.08) {
          visible = false;
          break;
        }
      }
      if (!inside || !visible) continue;
      const raw = element.getBoundingClientRect();
      const image = clampRect(raw);
      const right = image.left + image.width;
      const bottom = image.top + image.height;
      if (image.width < 180 || image.width < outer.width * 0.15 ||
          image.height < outer.height * 0.08 || image.width < raw.width * 0.98 ||
          image.left < outer.left - 8 || right > outer.left + outer.width + 8 ||
          image.top < outer.top - 8 || bottom > outerBottom + 8) continue;
      let column = columns.find(item => Math.abs(item.left - image.left) <= 4 &&
        Math.abs(item.right - right) <= 4);
      if (!column) {
        column = { left: image.left, right, strips: [] };
        columns.push(column);
      }
      column.strips.push([image.top, bottom]);
    }
    const pages = columns.filter(column => {
      column.strips.sort((a, b) => a[0] - b[0]);
      column.top = column.strips[0][0];
      column.bottom = column.top;
      let covered = 0;
      for (const [top, bottom] of column.strips) {
        covered += Math.max(0, bottom - Math.max(top, column.bottom));
        column.bottom = Math.max(column.bottom, bottom);
      }
      const height = column.bottom - column.top;
      const aspect = (column.right - column.left) / height;
      return height >= outer.height * 0.75 && covered >= height * 0.95 &&
        aspect >= 0.4 && aspect <= 2.2;
    }).sort((a, b) => a.left - b.left);
    const singleSpread = pages.length === 1 &&
      (pages[0].right - pages[0].left) / (pages[0].bottom - pages[0].top) >= 1.05;
    const doubleSpread = pages.length === 2 &&
      Math.abs(pages[0].top - pages[1].top) <= 8 &&
      Math.abs(pages[0].bottom - pages[1].bottom) <= 8 &&
      Math.abs(pages[1].left - pages[0].right) <= Math.max(12, outer.height * 0.03);
    if (singleSpread || doubleSpread) {
      const left = pages[0].left;
      const right = pages[pages.length - 1].right;
      const top = Math.min(...pages.map(page => page.top));
      const bottom = Math.max(...pages.map(page => page.bottom));
      best.region = { left, top, width: right - left, height: bottom - top };
    }

    const margin = 2;
    const region = {
      left: Math.max(0, Math.round(best.region.left - margin)),
      top: Math.max(0, Math.round(best.region.top - margin)),
      width: Math.min(innerWidth, Math.round(best.region.width + margin * 2)),
      height: Math.min(innerHeight, Math.round(best.region.height + margin * 2))
    };
    region.width = Math.min(region.width, innerWidth - region.left);
    region.height = Math.min(region.height, innerHeight - region.top);
    let refined = region;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "trim-black-borders",
        region,
        viewport: { width: innerWidth, height: innerHeight }
      });
      if (result?.ok && result.region) refined = result.region;
    } catch {
      // Pixel analysis is optional; keep the DOM-detected region if capture fails.
    }
    const rawPage = best.element.getBoundingClientRect();
    const portraitPage = rawPage.height <= innerHeight * 1.2 &&
      refined.height >= innerHeight * 0.7 &&
      refined.width / refined.height >= 0.45 &&
      refined.width / refined.height <= 0.95 &&
      refined.left <= innerWidth * 0.3 &&
      refined.width <= innerWidth * 0.5;
    if (portraitPage) {
      const pageWidth = best.region.width / best.region.height <= 0.95
        ? Math.max(best.region.width, refined.width) : refined.width;
      const spreadWidth = Math.round(pageWidth * 2);
      if (spreadWidth <= innerWidth - refined.left) refined.width = spreadWidth;
    }
    saveRegion(refined);
    previewDetectedRegion(refined);
    return refined;
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

  async function capture(sessionId, index, sampleId = null) {
    state.panel.style.visibility = "hidden";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const response = await chrome.runtime.sendMessage({
        action: "capture-and-store",
        region: state.region,
        viewport: { width: innerWidth, height: innerHeight },
        sessionId,
        index,
        ...(sampleId ? { sampleId } : {})
      });
      if (!response?.ok) throw new Error(response?.error || "截图失败");
      return response;
    } finally {
      state.panel.style.visibility = "visible";
    }
  }

  function assertCapturePage(startUrl) {
    if (document.visibilityState !== "visible") throw new Error("标签页已不在前台，任务已停止。");
    if (location.href !== startUrl) throw new Error("网页页码或地址发生变化，任务已停止。");
  }

  function intersectsRegion(element) {
    if (!element?.getBoundingClientRect || element.closest?.("#vmc-progress-panel,#vmc-detect-preview")) return false;
    const rect = element.getBoundingClientRect();
    const region = state.region;
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= region.left ||
        rect.left >= region.left + region.width || rect.bottom <= region.top ||
        rect.top >= region.top + region.height) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.display === "none" || parentStyle.visibility === "hidden" || Number(parentStyle.opacity) === 0) return false;
    }
    return true;
  }

  function regionIsBusy() {
    // A loading placeholder can itself be a fully loaded image. Look for
    // visible, substantial loading layers as well as unfinished page images.
    // This also covers a loader drawn over an already complete canvas.
    const selector = "[aria-busy='true'],[role='progressbar'],[class*='loading' i],[id*='loading' i],[class*='loader' i],[id*='loader' i]";
    const pendingMounts = new Set();
    // Some readers reserve the page's entire canvas container before inserting
    // the canvas. One ready portrait must not hide this unfinished other half.
    // Explicit empty page slots are intentional, including first-page padding.
    for (const mount of document.querySelectorAll("[class*='page-canvas' i],[class*='page-image' i]")) {
      if (/^(CANVAS|IMG|PICTURE|SVG)$/.test(mount.tagName) || !mount.querySelector ||
          mount.querySelector("canvas,img,picture,svg") ||
          mount.closest?.(".mode-empty,[data-empty='true']")) continue;
      pendingMounts.add(mount);
    }
    for (const element of new Set([...document.querySelectorAll(selector), ...pendingMounts])) {
      const identity = `${element.id || ""} ${element.getAttribute?.("class") || element.className || ""}`;
      if (!pendingMounts.has(element) && !/loading|loader/i.test(identity) && element.getAttribute?.("aria-busy") !== "true" &&
          element.getAttribute?.("role") !== "progressbar") continue;
      if (!intersectsRegion(element)) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, state.region.left);
      const top = Math.max(rect.top, state.region.top);
      const right = Math.min(rect.right, state.region.left + state.region.width);
      const bottom = Math.min(rect.bottom, state.region.top + state.region.height);
      if ((right - left) * (bottom - top) < state.region.width * state.region.height * 0.15) continue;
      for (const fx of [0.25, 0.5, 0.75]) {
        for (const fy of [0.25, 0.5, 0.75]) {
          const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
          if (hit === element || element.contains?.(hit)) return true;
        }
      }
    }
    for (const image of document.querySelectorAll("img")) {
      // Preload layers may have the same bounds as the canvas displaying the
      // page. Only a substantial image actually on top can block capture.
      if (image.complete || !intersectsRegion(image)) continue;
      const rect = image.getBoundingClientRect();
      const left = Math.max(rect.left, state.region.left);
      const top = Math.max(rect.top, state.region.top);
      const right = Math.min(rect.right, state.region.left + state.region.width);
      const bottom = Math.min(rect.bottom, state.region.top + state.region.height);
      if ((right - left) * (bottom - top) < state.region.width * state.region.height * 0.15) continue;
      for (const fx of [0.25, 0.5, 0.75]) {
        for (const fy of [0.25, 0.5, 0.75]) {
          if (document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy) === image) return true;
        }
      }
    }
    return false;
  }

  function clickAt(target, x, y) {
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  }

  // Compare against the first frame in the stable interval to catch slow drift.
  // Tolerate a small cursor/spinner or rendering noise without accepting a
  // moving page or a broad fade.
  function stableFingerprint(previous, current) {
    if (!previous || !current || previous.length !== current.length || !current.length) return false;
    let changed = 0;
    let total = 0;
    for (let i = 0; i < current.length; i++) {
      const difference = Math.abs(previous[i] - current[i]);
      total += Math.min(difference, 16);
      if (difference >= 12) changed++;
    }
    return changed <= Math.floor(current.length * 0.015) && total / current.length <= 0.8;
  }

  async function sampleRegion(startUrl) {
    assertCapturePage(startUrl);
    const panel = state.panel;
    if (panel) panel.style.visibility = "hidden";
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      assertCapturePage(startUrl);
      const result = await chrome.runtime.sendMessage({
        action: "sample-region", region: state.region,
        viewport: { width: innerWidth, height: innerHeight }
      });
      assertCapturePage(startUrl);
      if (!result?.ok || !Array.isArray(result.fingerprint) || !result.fingerprint.length) {
        throw new Error(result?.error || "无法检测翻页画面，请重试。");
      }
      return { fingerprint: result.fingerprint, layout: "screen", sampleId: result.sampleId };
    } finally {
      if (panel) panel.style.visibility = "visible";
    }
  }

  function portraitHasOtherContent(columns) {
    const region = state.region;
    // The spare half may be blank, or it may contain HTML controls and SVGs
    // whose pixels the raster sampler cannot observe. Check the interior so
    // page-edge navigation and toolbars do not invalidate a blank first page.
    const selector = "a,button,input,select,textarea,svg,h1,h2,h3,h4,h5,h6,p,label,[role='button'],[role='link']";
    for (const element of document.querySelectorAll(selector)) {
      if (!intersectsRegion(element)) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, region.left + region.width * 0.04);
      const right = Math.min(rect.right, region.left + region.width * 0.96);
      const top = Math.max(rect.top, region.top + region.height * 0.12);
      const bottom = Math.min(rect.bottom, region.top + region.height * 0.88);
      if (right <= left || bottom <= top) continue;
      const area = (right - left) * (bottom - top);
      if (area < region.width * region.height * 0.0005) continue;
      const rasterOverlap = columns.reduce((sum, column) => sum +
        Math.max(0, Math.min(right, column.right) - Math.max(left, column.left)) *
        Math.max(0, Math.min(bottom, column.bottom) - Math.max(top, column.top)), 0);
      if (rasterOverlap > area * 0.25) continue;
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      if (columns.some(column => x >= column.left && x <= column.right && y >= column.top && y <= column.bottom)) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit === element || element.contains?.(hit)) return true;
    }
    return false;
  }

  function createRenderedSampler() {
    // Read only canvases and images already rendered in the visible region. No
    // image URLs or viewer internals are consulted. Tainted canvases fall back
    // Chrome screenshots, which have a lower sampling rate.
    try {
      const scratch = new OffscreenCanvas(64, 64);
      const context = scratch.getContext("2d", { willReadFrequently: true });
      const identities = new WeakMap();
      let nextIdentity = 1;
      const read = () => {
        const pixels = [];
        const layout = [];
        const columns = [];
        let coveredArea = 0;
        let loading = false;
        for (const surface of document.querySelectorAll("canvas,img")) {
          if (!intersectsRegion(surface)) continue;
          const isImage = surface.tagName === "IMG";
          const nativeWidth = isImage ? surface.naturalWidth : surface.width;
          const nativeHeight = isImage ? surface.naturalHeight : surface.height;
          if (!isImage && (!nativeWidth || !nativeHeight)) continue;
          const rect = surface.getBoundingClientRect();
          const left = Math.max(rect.left, state.region.left);
          const top = Math.max(rect.top, state.region.top);
          const right = Math.min(rect.right, state.region.left + state.region.width);
          const bottom = Math.min(rect.bottom, state.region.top + state.region.height);
          const area = (right - left) * (bottom - top);
          if (area < state.region.width * state.region.height * 0.01) continue;
          // A complete portrait page may occupy only half of a region that
          // reserves room for a spread. Group its aligned image tiles, but do
          // not treat a page clipped halfway through a slide as complete.
          if (area >= rect.width * rect.height * 0.95) {
            let column = columns.find((candidate) =>
              Math.abs(candidate.left - left) <= 2 && Math.abs(candidate.right - right) <= 2);
            if (!column) {
              column = { left, right, top, bottom, area: 0 };
              columns.push(column);
            }
            column.top = Math.min(column.top, top);
            column.bottom = Math.max(column.bottom, bottom);
            column.area += area;
          }
          if (!identities.has(surface)) identities.set(surface, nextIdentity++);
          layout.push(identities.get(surface), ...[left, top, right, bottom].map((n) => Math.round(n * 10)));
          if (isImage) {
            layout.push(surface.complete, nativeWidth, nativeHeight);
            if (!surface.complete) loading = true;
          }
          for (let element = surface; element; element = element.parentElement) {
            const style = getComputedStyle(element);
            layout.push(style.transform, style.opacity);
          }
          context.clearRect(0, 0, 64, 64);
          if (nativeWidth && nativeHeight && (!isImage || surface.complete)) {
            context.drawImage(surface,
              (left - rect.left) * nativeWidth / rect.width,
              (top - rect.top) * nativeHeight / rect.height,
              (right - left) * nativeWidth / rect.width,
              (bottom - top) * nativeHeight / rect.height,
              0, 0, 64, 64);
          }
          const data = context.getImageData(0, 0, 64, 64).data;
          for (let i = 0; i < data.length; i += 4) {
            pixels.push(Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114));
          }
          coveredArea += area;
        }
        const completePortrait = columns.some((column) => {
          const width = column.right - column.left;
          const height = column.bottom - column.top;
          return width >= state.region.width * 0.35 && height >= state.region.height * 0.8 &&
            height >= width * 1.05 && column.area >= width * height * 0.95;
        });
        const coversSpread = coveredArea >= state.region.width * state.region.height * 0.8;
        const covered = coversSpread || completePortrait;
        const screenRequired = !coversSpread && completePortrait && portraitHasOtherContent(columns);
        // Sliding tiles can briefly leave a gap, or their replacements may
        // still be loading. Stay in fast detection and wait for those tiles;
        // do not switch samplers in the middle of a turn.
        return { fingerprint: pixels, layout: JSON.stringify(layout), loading: loading || !covered, covered, screenRequired };
      };
      const initial = read();
      if (!initial.covered || initial.screenRequired) return null;
      return { intervalMs: 40, quietMs: 120, read };
    } catch {
      return null;
    }
  }

  function createPageSampler(startUrl) {
    return createRenderedSampler() || createScreenSampler(startUrl);
  }

  function createScreenSampler(startUrl) {
    return {
      kind: "screen",
      intervalMs: 550, quietMs: 550,
      read: () => sampleRegion(startUrl)
    };
  }

  function sameFrame(previous, current) {
    return previous?.layout === current?.layout && stableFingerprint(previous?.fingerprint, current?.fingerprint);
  }

  async function waitForStablePage({ startUrl, baseline = null, screenBaseline = null, requireChange = false,
    noChangeTimeoutMs = 8000,
    sampler = createPageSampler(startUrl), startedAt = performance.now() }) {
    let pausedMs = 0;
    let elapsed = performance.now() - startedAt;
    // Accept fingerprints from saved screenshots only for the screen sampler.
    let baselineFrame = baseline && (Array.isArray(baseline)
      ? { fingerprint: baseline, layout: "screen" } : baseline);
    let anchor = baselineFrame;
    let stableSince = null;
    let changed = !requireChange;
    let nextScreenProbeMs = 550;
    let recoverySampler = null;
    let recoveryAnchor = null;
    let recoverySince = null;
    let verifiedRecovery = null;
    const timeoutMs = 30000;
    const progress = (text) => {
      state.waitStatus = text;
      showPanel(text);
    };
    while (!state.stopped && elapsed < timeoutMs) {
      if (state.popupConnections > 0) {
        progress("已暂停检测，请关闭扩展弹窗后继续。");
        const pauseStart = performance.now();
        await waitWhilePopupOpen();
        pausedMs += performance.now() - pauseStart;
        stableSince = null;
        anchor = null;
        recoveryAnchor = null;
        recoverySince = null;
      }
      if (state.stopped) return null;
      assertCapturePage(startUrl);
      const waitStart = performance.now();
      // Keep screenshot probes rate-limited, but retry readable page pixels
      // between them. An advertisement on the old page must not lock the new
      // ordinary page into screenshot-based stability confirmation.
      const interval = sampler.kind === "screen"
        ? Math.min(40, Math.max(1, nextScreenProbeMs - elapsed)) : sampler.intervalMs;
      const waited = await waitUnlessStopped(interval);
      pausedMs += Math.max(0, performance.now() - waitStart - waited);
      if (state.stopped) return null;
      assertCapturePage(startUrl);
      elapsed = performance.now() - startedAt - pausedMs;
      let recoveryFrame = null;
      let recoveryStable = false;
      if (sampler.kind === "screen") {
        try {
          recoverySampler ||= createRenderedSampler();
          recoveryFrame = recoverySampler?.read();
          if (recoveryFrame?.screenRequired) {
            recoverySampler = null;
            recoveryFrame = null;
          }
        } catch {
          recoverySampler = null;
        }
        if (!recoveryFrame || recoveryFrame.loading || regionIsBusy()) {
          recoveryAnchor = null;
          recoverySince = null;
        } else if (!sameFrame(recoveryAnchor, recoveryFrame)) {
          recoveryAnchor = recoveryFrame;
          recoverySince = elapsed;
        } else {
          recoveryStable = elapsed - recoverySince >= recoverySampler.quietMs;
        }
        const needsVerification = recoveryStable && !sameFrame(verifiedRecovery, recoveryFrame);
        if (elapsed < nextScreenProbeMs && !needsVerification) continue;
      }
      let frame;
      try {
        frame = await sampler.read();
      } catch (error) {
        if (sampler.intervalMs !== 40) throw error;
      }
      if (!frame || frame.screenRequired) {
        // An unreadable image or HTML content can appear beside the last
        // page. Fall back to Chrome screenshots and compare with the saved
        // pre-turn screen crop, never with the renderer's different pixels.
        sampler = createScreenSampler(startUrl);
        anchor = null;
        baselineFrame = screenBaseline?.length
          ? { fingerprint: screenBaseline, layout: "screen" }
          : baselineFrame?.layout === "screen" ? baselineFrame : null;
        stableSince = null;
        frame = await sampler.read();
        if (!frame) throw new Error("无法读取当前可见画面，请重试。");
      }
      assertCapturePage(startUrl);
      elapsed = performance.now() - startedAt - pausedMs;
      if (state.stopped) return null;
      if (state.popupConnections > 0) {
        stableSince = null;
        anchor = null;
        continue;
      }
      if (sampler.kind === "screen") {
        nextScreenProbeMs = elapsed + sampler.intervalMs;
        // The raw fingerprint cannot be compared to a screenshot baseline.
        // Verify the actual change with one screenshot, and retain that exact
        // sample for saving only if the readable page stayed stable around it.
        if (recoveryStable) {
          let after;
          try { after = recoverySampler.read(); } catch { recoverySampler = null; }
          if (after?.screenRequired) recoverySampler = null;
          if (after && !after.loading && !after.screenRequired && !regionIsBusy() && sameFrame(recoveryAnchor, after)) {
            verifiedRecovery = after;
            if (!requireChange || baselineFrame && !sameFrame(baselineFrame, frame)) {
              state.waitStatus = "";
              return { elapsedMs: Math.ceil(elapsed), settledMs: Math.ceil(recoverySince),
                frame, fingerprint: frame.fingerprint, detectionMode: "rendered", changed: true };
            }
          } else {
            recoveryAnchor = null;
            recoverySince = null;
            recoveryStable = false;
          }
        }
      }
      changed = !requireChange || Boolean(baselineFrame && !sameFrame(baselineFrame, frame));
      if (requireChange && !baselineFrame) {
        throw new Error("翻页中途检测方式发生变化，请停止任务后重新开始截图。");
      }
      const loading = frame.loading || regionIsBusy();
      if (loading || !sameFrame(anchor, frame)) {
        anchor = frame;
        stableSince = loading ? null : elapsed;
      } else if (stableSince === null) {
        stableSince = elapsed;
      }
      const stable = stableSince !== null && elapsed - stableSince >= sampler.quietMs &&
        (!recoverySampler || recoveryStable);
      if (changed && stable) {
        state.waitStatus = "";
        return { elapsedMs: Math.ceil(elapsed), settledMs: Math.ceil(stableSince),
          frame, fingerprint: frame.fingerprint,
          detectionMode: sampler.kind === "screen" ? "screen" : "rendered", changed: true };
      }
      if (!changed && !loading && stable && elapsed >= noChangeTimeoutMs) {
        state.waitStatus = "";
        return { elapsedMs: Math.ceil(elapsed), changed: false };
      }
      if (loading) progress("等待当前可见漫画图片加载…");
      else if (!changed) progress(`画面已静止，尚未检测到翻页变化（${(elapsed / 1000).toFixed(1)} 秒）…`);
      else progress(`正在确认画面稳定（已检测 ${(elapsed / 1000).toFixed(1)} 秒）…`);
    }
    if (state.stopped) return null;
    if (!changed && stableSince !== null && elapsed - stableSince >= sampler.quietMs) {
      return { elapsedMs: Math.ceil(elapsed), changed: false };
    }
    throw new Error("画面长时间未稳定，已停止以避免截到翻页动画或未加载的图片。");
  }

  function turnPage(method) {
    if (method === "none") return;
    if (method.startsWith("key-")) {
      const key = method === "key-left" ? "ArrowLeft" : "ArrowRight";
      const code = key;
      const keyCode = method === "key-left" ? 37 : 39;
      const target = document.activeElement || document.body;
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, {
          key, code, keyCode, which: keyCode, bubbles: true, cancelable: true
        }));
      }
      return;
    }
    const x = method === "click-left"
      ? state.region.left + 1
      : state.region.left + state.region.width - 1;
    const y = state.region.top + state.region.height * 0.5;
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    clickAt(target, x, y);
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
    const recentTurnMs = [];
    let consecutiveSlowPages = 0;
    let terminalMessage = "";
    showPanel("准备截图…");
    remove("vmc-detect-preview");
    try {
      const begin = await chrome.runtime.sendMessage({
        action: "begin-capture-session", sessionId, zipName: options.folder
      });
      if (!begin?.ok) throw new Error(begin?.error || "无法创建临时截图任务。");
      await waitWhilePopupOpen();
      const initial = await waitForStablePage({ startUrl });
      let settledFrame = initial?.frame;
      let settledDetectionMode = initial?.detectionMode;
      for (let i = 1; !state.stopped; i++) {
        await waitWhilePopupOpen();
        if (state.stopped) break;
        if (document.visibilityState !== "visible") throw new Error("标签页已不在前台，任务已停止。");
        if (location.href !== startUrl) {
          throw new Error("网页页码或地址发生变化，任务已停止。");
        }
        if (state.stopped) break;
        // Count completed page checks, not screenshot probes. A page that
        // recovered fast confirmation uses a screen sample only to verify the
        // turn and must break the consecutive-slow sequence.
        consecutiveSlowPages = settledDetectionMode === "screen" ? consecutiveSlowPages + 1 : 0;
        if (consecutiveSlowPages >= 2 && state.activeOptions.ignoreConsecutiveSlowStop !== true) {
          state.stopped = true;
          terminalMessage = `连续两页使用慢检测，已自动停止，第二页未保存，共截取 ${state.completed} 张。`;
          break;
        }
        showPanel(`正在保存第 ${i} 张…`);
        const captured = await capture(sessionId, i, settledFrame?.sampleId);
        settledFrame = null;
        if (captured.duplicate) {
          state.stopped = true;
          terminalMessage = `检测到翻页后画面未变化，已自动停止，共截取 ${state.completed} 张。`;
          break;
        }
        state.completed = i;
        if (!state.stopped) {
          await waitWhilePopupOpen();
          if (state.stopped) break;
          const turnOptions = { ...state.activeOptions };
          let sampler = createPageSampler(startUrl);
          // The saved screen crop already provides the exact pre-turn pixels;
          // another Chrome screenshot would add a rate-limited wait here.
          let baseline = sampler.kind === "screen" && captured.fingerprint?.length
            ? { fingerprint: captured.fingerprint, layout: "screen" } : await sampler.read();
          await waitWhilePopupOpen();
          if (state.stopped) break;
          assertCapturePage(startUrl);
          if (state.stopped) break;
          const startedAt = performance.now();
          turnPage(turnOptions.turnMethod);
          showPanel(`已保存 ${i} 张，等待翻页…`);
          const settled = await waitForStablePage({
            startUrl, sampler, baseline,
            screenBaseline: sampler.kind === "screen" ? baseline.fingerprint : captured.fingerprint, startedAt,
            // End-of-chapter checks should follow this reader's observed turn
            // time. Keep headroom for delayed turns and the screen confirmation.
            noChangeTimeoutMs: recentTurnMs.length
              ? Math.min(8000, Math.max(1200, Math.max(...recentTurnMs) * 2)) : 8000,
            requireChange: turnOptions.turnMethod !== "none"
          });
          if (settled && !settled.changed) {
            state.stopped = true;
            terminalMessage = `未检测到翻页变化，已自动停止，共截取 ${state.completed} 张。`;
          } else if (settled?.changed) {
            settledFrame = settled.frame;
            settledDetectionMode = settled.detectionMode;
            recentTurnMs.push(settled.settledMs);
            if (recentTurnMs.length > 4) recentTurnMs.shift();
          }
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
          showPanel(`${terminalMessage} 请在保存页点击“保存 ZIP”。`, false);
        } catch (error) {
          showPanel(`${terminalMessage} 但 ZIP 生成失败：${error.message}`, false);
        }
      } else {
        await chrome.runtime.sendMessage({ action: "discard-capture-session", sessionId }).catch(() => {});
        showPanel(terminalMessage || "未产生截图。", false);
      }
      state.running = false;
      state.waitStatus = "";
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
        waitStatus: state.waitStatus,
        completed: state.completed,
        turnMethod: state.activeOptions?.turnMethod,
        ignoreConsecutiveSlowStop: state.activeOptions?.ignoreConsecutiveSlowStop === true
      });
      return;
    }
    if (["start", "select-region", "auto-detect-region"].includes(message.action) && state.running) {
      sendResponse({ ok: false, error: "已有任务正在运行，请先停止。" });
      return;
    }
    if (message.action === "select-region") { selectRegion(); sendResponse({ ok: true }); return; }
    if (message.action === "auto-detect-region") {
      autoDetectRegion()
        .then((region) => sendResponse(region
          ? { ok: true, region }
          : { ok: false, error: "没有识别到合适的漫画区域，请改用手动框选。" }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.action === "update-settings") {
      const methods = new Set(["click-left", "click-right", "key-left", "key-right", "none"]);
      if (state.running && state.activeOptions) {
        if (methods.has(message.turnMethod)) state.activeOptions.turnMethod = message.turnMethod;
        if (typeof message.ignoreConsecutiveSlowStop === "boolean") {
          state.activeOptions.ignoreConsecutiveSlowStop = message.ignoreConsecutiveSlowStop;
        }
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
