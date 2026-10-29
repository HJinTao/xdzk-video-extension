import { downloadFilename, isMediaUrl, isPlatformUrl, responseSize, sanitizeName } from "./media.js";
import { applySnapshot, emptyState, sortedMedia, upsertMedia } from "./state.js";

const storageKey = (tabId) => `tab:${tabId}`;
const supportedUrl = (url) => isPlatformUrl(url) || isMediaUrl(url);

export function createController(api) {
  const queues = new Map();
  const closedTabs = new Set();

  function enqueue(tabId, task) {
    if (!Number.isInteger(tabId) || tabId < 0) return Promise.reject(new Error("找不到当前标签页。"));
    const previous = queues.get(tabId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const pending = operation.finally(() => { if (queues.get(tabId) === pending) queues.delete(tabId); });
    queues.set(tabId, pending);
    return pending;
  }

  async function read(tabId) {
    return (await api.storage.session.get(storageKey(tabId)))[storageKey(tabId)] || emptyState(tabId);
  }

  async function save(state) {
    if (closedTabs.has(state.tabId)) return;
    await api.storage.session.set({ [storageKey(state.tabId)]: state });
    try {
      await api.action.setBadgeText({ tabId: state.tabId, text: state.media.length ? String(state.media.length) : "" });
      await api.action.setBadgeBackgroundColor({ tabId: state.tabId, color: "#177c78" });
    } catch { /* A tab may close between the state update and the badge update. */ }
  }

  async function tabFor(tabId) {
    const tab = await api.tabs.get(tabId);
    if (!supportedUrl(tab.url)) throw new Error("请先打开西电智课的课程回放页面。" );
    return tab;
  }

  async function options() {
    return { saveAs: !!(await api.storage.local.get({ saveAs: false })).saveAs };
  }

  async function downloadItem(media) {
    if (!Number.isInteger(media.downloadId)) return null;
    try {
      const [item] = await api.downloads.search({ id: media.downloadId });
      if (!item) return null;
      return {
        id: item.id, state: item.state, paused: item.paused, canResume: item.canResume,
        bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, error: item.error,
        exists: item.exists
      };
    } catch { return null; }
  }

  async function view(tabId) {
    let tab;
    try { tab = await tabFor(tabId); } catch {
      return { ok: true, supported: false, media: [], courseTitle: "", options: await options() };
    }
    const state = await enqueue(tabId, () => read(tabId));
    const media = await Promise.all(sortedMedia(state).map(async (item, index) => ({
      ...item,
      label: item.label || `画面 ${index + 1}`,
      filename: downloadFilename(state.titleOverride || state.courseTitle, item, index),
      download: await downloadItem(item)
    })));
    return {
      ok: true, supported: true, tabId, pageTitle: tab.title || "", updatedAt: state.updatedAt,
      courseTitle: state.titleOverride || state.courseTitle || "课程录播", media, options: await options()
    };
  }

  async function scan(tabId) {
    const tab = await tabFor(tabId);
    if (isMediaUrl(tab.url)) {
      await enqueue(tabId, async () => {
        const state = await read(tabId);
        upsertMedia(state, { url: tab.url, frameId: 0, source: "dom" });
        await save(state);
      });
    }
    try {
      await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    } catch {
      const result = await view(tabId);
      if (result.media.length) return { ...result, notice: "已显示捕获到的视频；页面加载完成后可以重新识别。" };
      return { ...result, notice: "页面尚未就绪，请刷新回放页面后重新识别。" };
    }
    return view(tabId);
  }

  async function snapshot(message, sender) {
    if (!sender.tab || !supportedUrl(sender.url) || closedTabs.has(sender.tab.id)) throw new Error("页面来源无效。" );
    const payload = message.snapshot;
    if (!payload || !supportedUrl(payload.url)) throw new Error("页面数据无效。" );
    return enqueue(sender.tab.id, async () => {
      const state = await read(sender.tab.id);
      applySnapshot(state, payload, { frameId: sender.frameId ?? 0, documentId: sender.documentId, url: sender.url });
      await save(state);
      return { ok: true };
    });
  }

  async function startDownload(state, media, index, settings) {
    if (!isMediaUrl(media.url)) throw new Error("视频地址无效，请重新识别。" );
    const current = await downloadItem(media);
    if (current?.state === "in_progress") return { id: current.id, existing: true };
    const id = await api.downloads.download({
      url: media.url,
      filename: downloadFilename(state.titleOverride || state.courseTitle, media, index),
      conflictAction: "uniquify",
      saveAs: settings.saveAs
    });
    if (!Number.isInteger(id)) throw new Error("下载未开始，请重试。" );
    media.downloadId = id;
    media.downloadError = "";
    return { id, existing: false };
  }

  async function download(tabId, keys) {
    await tabFor(tabId);
    const settings = await options();
    let started = 0;
    let failed = 0;
    await enqueue(tabId, async () => {
      const state = await read(tabId);
      const items = sortedMedia(state);
      const selected = items.filter((item) => keys === null || keys.includes(item.key));
      if (!selected.length) throw new Error("还没有识别到视频，请先播放回放再重新识别。" );
      for (const item of selected) {
        try {
          const result = await startDownload(state, item, items.indexOf(item), settings);
          if (!result.existing) started += 1;
        } catch {
          item.downloadError = "下载未开始。若取消了保存窗口，可直接重试；否则请刷新回放后重新识别。";
          failed += 1;
        }
      }
      await save(state);
    });
    return { ...(await view(tabId)), started, failed };
  }

  async function edit(tabId, operation) {
    await tabFor(tabId);
    await enqueue(tabId, async () => {
      const state = await read(tabId);
      await operation(state);
      await save(state);
    });
    return view(tabId);
  }

  async function dispatch(message, sender = {}) {
    if (sender.id !== api.runtime.id) throw new Error("请求来源无效。" );
    if (message?.type === "PAGE_SNAPSHOT") return snapshot(message, sender);
    if (!sender.url?.startsWith(api.runtime.getURL(""))) throw new Error("请通过扩展面板操作。" );
    const tabId = message?.tabId;
    switch (message?.type) {
      case "GET_STATE": return view(tabId);
      case "SCAN_TAB": return scan(tabId);
      case "SET_TITLE": return edit(tabId, (state) => { state.titleOverride = sanitizeName(message.value, "课程录播", 60); });
      case "RENAME_MEDIA": return edit(tabId, (state) => {
        const media = state.media.find((item) => item.key === message.key);
        if (!media) throw new Error("画面已更新，请重新识别。" );
        media.label = sanitizeName(message.value, "画面", 32);
      });
      case "SET_OPTIONS":
        await api.storage.local.set({ saveAs: !!message.saveAs });
        return { ok: true };
      case "DOWNLOAD_MEDIA": return download(tabId, [message.key]);
      case "DOWNLOAD_ALL": return download(tabId, null);
      case "CONTROL_DOWNLOAD": return edit(tabId, async (state) => {
        const media = state.media.find((item) => item.key === message.key);
        if (!Number.isInteger(media?.downloadId)) throw new Error("找不到下载任务。" );
        if (!["pause", "resume", "cancel"].includes(message.action)) throw new Error("下载操作无效。" );
        await api.downloads[message.action](media.downloadId);
      });
      default: throw new Error("不支持的操作。" );
    }
  }

  async function recordResponse(details) {
    if (details.tabId < 0 || closedTabs.has(details.tabId) || !isMediaUrl(details.url) || ![200, 206].includes(details.statusCode)) return;
    const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    if (contentType && !/^(video\/mp4|application\/octet-stream)(?:;|$)/i.test(contentType.trim())) return;
    // Do not collect a matching video embedded on an unrelated website.
    try { await tabFor(details.tabId); } catch { return; }
    await enqueue(details.tabId, async () => {
      const state = await read(details.tabId);
      const frame = state.frames[details.frameId];
      if (frame?.documentId && details.documentId && frame.documentId !== details.documentId) return;
      upsertMedia(state, {
        url: details.url, frameId: details.frameId ?? 0, documentId: details.documentId,
        frameUrl: frame?.url, size: responseSize(details.responseHeaders), source: "network"
      }, details.timeStamp || Date.now());
      await save(state);
    });
  }

  async function tabUpdated(tabId, changeInfo) {
    if (changeInfo.status === "loading" || changeInfo.url) {
      await enqueue(tabId, async () => {
        const existing = (await api.storage.session.get(storageKey(tabId)))[storageKey(tabId)];
        if (existing) await save(emptyState(tabId));
      });
    }
  }

  async function tabRemoved(tabId) {
    closedTabs.add(tabId);
    await enqueue(tabId, () => api.storage.session.remove(storageKey(tabId)));
  }

  return { dispatch, recordResponse, tabUpdated, tabRemoved };
}
