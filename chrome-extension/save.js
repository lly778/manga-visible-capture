async function saveExport(entry, button, status) {
  button.disabled = true;
  let writable;
  let saved = false;
  try {
    if (typeof window.showSaveFilePicker !== "function") {
      throw new Error("此浏览器不支持直接保存，请使用桌面版 Chrome 或 Edge。");
    }
    // Invoke the picker before any asynchronous work to preserve the click gesture.
    const handle = await window.showSaveFilePicker({
      suggestedName: entry.filename,
      types: [{ description: "ZIP 压缩文件", accept: { "application/zip": [".zip"] } }]
    });
    status.textContent = "正在保存，请保持本页打开…";
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error("暂存文件已失效，请重新截图。");
    const blob = await response.blob();
    if (blob.size !== entry.size) throw new Error("暂存文件大小不符，请重新截图。");
    writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    writable = null;
    saved = true;
    button.textContent = "已保存";
    status.textContent = `已保存：${handle.name}`;
    const result = await chrome.runtime.sendMessage({ action: "complete-saved-export", sessionId: entry.sessionId });
    if (!result?.ok) throw new Error(result?.error || "暂存清理失败");
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (saved) {
      status.textContent += "。文件已写入，暂存清理未完成，可关闭本页。";
    } else {
      status.textContent = error.name === "AbortError"
        ? "已取消保存，文件仍在暂存中，可以再次保存。"
        : `保存失败：${error.message} 可以重试；请勿关闭浏览器或重新加载扩展。`;
    }
  } finally {
    button.disabled = saved;
  }
}

async function loadExports() {
  const container = document.getElementById("exports");
  const values = await chrome.storage.session.get(null);
  const selected = decodeURIComponent(location.hash.slice(1));
  const entries = Object.entries(values).filter(([key]) => key.startsWith("vmc-export-"))
    .map(([, entry]) => entry).sort((a, b) => Number(b.sessionId === selected) - Number(a.sessionId === selected));
  container.textContent = entries.length ? "" : "没有待保存的 ZIP。";
  for (const entry of entries) {
    const card = document.createElement("article");
    const title = document.createElement("h2");
    title.textContent = entry.filename;
    const detail = document.createElement("p");
    detail.textContent = `${entry.count} 张截图 · ${(entry.size / 1024 / 1024).toFixed(1)} MB`;
    const button = document.createElement("button");
    button.textContent = "保存 ZIP";
    const status = document.createElement("p");
    status.className = "status";
    button.addEventListener("click", () => saveExport(entry, button, status));
    card.append(title, detail, button, status);
    container.append(card);
  }
}

loadExports().catch((error) => { document.getElementById("exports").textContent = `无法读取待保存文件：${error.message}`; });
