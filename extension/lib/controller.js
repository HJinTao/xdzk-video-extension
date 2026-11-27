import { downloadFilename, isCourseSubtitleUrl, isMediaUrl, isPlatformUrl, responseSize, sanitizeName, signatureTime } from "./media.js";
import { applySnapshot, emptyState, sortedMedia, upsertMedia } from "./state.js";
import { readCourseSubtitles } from "./course-subtitles.js";
import {
  XIDIAN_FID,
  extractLiveId,
  extractSourceOrigin,
  extractWorkDetailId,
  fetchCoursePlaylistInPage,
  fetchLessonPageInPage,
  fetchLessonSubtitlesInPage,
  parseCourseLessons,
  parsePlayVideoHtml
} from "./course-playlist.js";
import { createProgressStore } from "./watch-progress.js";

const storageKey = (tabId) => `tab:${tabId}`;
const supportedUrl = (url) => isPlatformUrl(url) || isMediaUrl(url);
function createTaggedError(message, reason = "") {
  const error = new Error(message);
  if (reason) error.reason = reason;
  return error;
}

export function createController(api, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const queues = new Map();
  const closedTabs = new Set();
  const progressStore = createProgressStore(api.storage.local);

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
      await api.action.setBadgeBackgroundColor({ tabId: state.tabId, color: "#3669ae" });
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
    const liveId = state.liveId || extractLiveId(tab.url) || media.map((item) => extractLiveId(item.frameUrl)).find(Boolean) || "";
    const sourceOrigin = state.sourceOrigin || extractSourceOrigin(tab.url) || media.map((item) => extractSourceOrigin(item.frameUrl)).find(Boolean) || "";
    return {
      ok: true, supported: true, tabId, pageTitle: tab.title || "", updatedAt: state.updatedAt,
      liveId, sourceOrigin,
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
      if (keys && selected.length !== new Set(keys).size) throw new Error("所选画面已更新，请重新确认下载清单。");
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

  async function openPlayer(tabId) {
    const current = await view(tabId);
    if (!current.supported || current.media.length < 1) throw new Error("还没有识别到视频，请先播放回放并重新识别。");
    const id = crypto.randomUUID();
    const key = `player:${id}`;
    const payload = {
      sourceTabId: tabId,
      liveId: current.liveId || "",
      currentLiveId: current.liveId || "",
      sourceOrigin: current.sourceOrigin || "",
      courseTitle: current.courseTitle,
      lessonTitle: "",
      media: current.media,
      createdAt: Date.now()
    };
    await api.storage.session.set({ [key]: payload });
    try {
      const tab = await api.tabs.create({ url: `${api.runtime.getURL("player.html")}?id=${id}` });
      await api.storage.session.set({ [key]: { ...payload, playerTabId: tab?.id } });
    } catch {
      await api.storage.session.remove(key);
      throw new Error("无法打开同步播放器，请重试。");
    }
    return { ok: true };
  }

  async function readPlayer(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("播放器地址无效，请从扩展面板重新打开。");
    const key = `player:${id}`;
    const payload = (await api.storage.session.get(key))[key];
    if (!payload) throw new Error("本次播放记录已清除，请回到回放页面重新打开同步播放。");
    return payload;
  }

  async function runPlatformTask(tabId, sourceOrigin, injectedFunc, args, fallbackTask) {
    if (Number.isInteger(tabId) && tabId >= 0) {
      try {
        const tab = await tabFor(tabId);
        if (isPlatformUrl(tab.url)) {
          const [injection] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: injectedFunc, args });
          if (injection?.result) return injection.result;
        }
      } catch { /* Fall through to direct fetch when the source tab is unavailable. */ }
    }
    if (sourceOrigin && isPlatformUrl(sourceOrigin) && typeof fetchImpl === "function") {
      try {
        return await fallbackTask(sourceOrigin, fetchImpl);
      } catch {
        return { ok: false, reason: "network", error: "网络连接失败或学校服务暂时不可用，请检查网络后重试。" };
      }
    }
    return { ok: false, reason: "missing", error: "原回放页面已关闭，请重新打开西电智课回放页。" };
  }

  async function fetchPlaylist(tabId, sourceOrigin, liveId) {
    return runPlatformTask(tabId, sourceOrigin, fetchCoursePlaylistInPage, [liveId, XIDIAN_FID], async (origin, doFetch) => {
      const body = new URLSearchParams({ liveId: String(liveId), fid: XIDIAN_FID });
      const response = await doFetch(`${origin}/xidianpj/live/listSignleCourse`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: body.toString()
      });
      if (!response.ok) return { ok: false, error: `课程目录请求失败（HTTP ${response.status}）。` };
      const text = (await response.text()).trim();
      if (!text || text.includes("请先登录") || text.startsWith("<")) {
        return { ok: false, loginRequired: true, error: "西电智课登录已过期，请先刷新原回放页并重新登录。" };
      }
      const items = JSON.parse(text);
      return Array.isArray(items) ? { ok: true, items } : { ok: false, error: "课程目录响应格式异常。" };
    });
  }

  async function fetchLessonHtml(tabId, sourceOrigin, liveId) {
    return runPlatformTask(tabId, sourceOrigin, fetchLessonPageInPage, [liveId], async (origin, doFetch) => {
      const response = await doFetch(`${origin}/xidianpj/frontLive/playVideo2Keda?liveId=${encodeURIComponent(liveId)}`, {
        credentials: "include"
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: "login", error: "西电智课登录已过期，请重新登录后更新视频源。" };
      }
      if (!response.ok) return { ok: false, reason: "network", error: `学校服务暂时不可用（HTTP ${response.status}），请检查网络后重试。` };
      return { ok: true, html: await response.text() };
    });
  }

  async function fetchLessonSubtitles(tabId, sourceOrigin, liveId) {
    return runPlatformTask(tabId, sourceOrigin, fetchLessonSubtitlesInPage, [liveId], async (origin, doFetch) => {
      const pageResponse = await doFetch(`${origin}/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=${encodeURIComponent(liveId)}`, {
        credentials: "include"
      });
      if (!pageResponse.ok) return { failed: true };
      const html = await pageResponse.text();
      if (html.includes("请先登录")) return { failed: true };
      const workDetailId = extractWorkDetailId(html);
      if (!workDetailId) return { failed: false };
      const subResponse = await doFetch(`${origin}/xidianpj/smartSupervisor/getVideoSubtitles2Vtt?workDetailId=${encodeURIComponent(workDetailId)}`, {
        credentials: "include"
      });
      if (!subResponse.ok) return { failed: true };
      let text = (await subResponse.text()).replace(/^\ufeff/, "").trim();
      const hasTiming = /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->/m;
      if (text.startsWith("{") || text.startsWith('"') || text.startsWith("[")) {
        let inline = "";
        try {
          JSON.parse(text, (_, value) => {
            if (typeof value === "string" && !inline && hasTiming.test(value)) inline = value;
            return value;
          });
        } catch { /* ignore */ }
        if (inline) text = inline;
      }
      if (hasTiming.test(text)) return { text };
      if (/^\s*</.test(text) || text.includes("请先登录")) return { failed: true };
      return { failed: false };
    });
  }

  async function getPlaylist(message) {
    const fromPlayer = message.id !== undefined;
    const payload = fromPlayer ? await readPlayer(message.id) : await view(message.tabId);
    const liveId = String(payload.currentLiveId || payload.liveId || "");
    const sourceOrigin = payload.sourceOrigin || "";
    const sourceTabId = fromPlayer ? payload.sourceTabId : payload.tabId;
    const [progress, prefs] = await Promise.all([progressStore.getAll(), progressStore.getPrefs()]);
    if (!liveId) {
      return { ok: true, supported: false, courseKey: "", courseTitle: payload.courseTitle || "", currentLiveId: "", lessons: [], progress, prefs };
    }
    const raw = await fetchPlaylist(sourceTabId, sourceOrigin, liveId);
    if (!raw?.ok) throw new Error(raw?.error || "获取课程目录失败，请确认原回放页已登录后重试。");
    const parsed = parseCourseLessons(raw.items);
    const currentLesson = parsed.lessons.find((lesson) => lesson.liveId === liveId);
    const courseTitle = parsed.courseTitle || payload.courseTitle || "课程录播";
    if (fromPlayer) {
      const updated = {
        ...payload,
        courseKey: parsed.courseKey,
        courseTitle,
        lessonTitle: currentLesson?.title || payload.lessonTitle || "",
        lessons: parsed.lessons
      };
      await api.storage.session.set({ [`player:${message.id}`]: updated });
    }
    return {
      ok: true,
      supported: true,
      courseKey: parsed.courseKey,
      courseTitle,
      lessonTitle: currentLesson?.title || "",
      currentLiveId: liveId,
      lessons: parsed.lessons,
      progress,
      prefs
    };
  }

  async function loadLesson(id, liveId) {
    const targetId = String(liveId || "");
    if (!/^\d{1,20}$/.test(targetId)) throw createTaggedError("课次编号无效。", "invalid");
    const payload = await readPlayer(id);
    const raw = await fetchLessonHtml(payload.sourceTabId, payload.sourceOrigin, targetId);
    if (!raw?.ok) throw createTaggedError(raw?.error || "加载课次视频失败，请重试。", raw?.reason || "network");
    const parsed = parsePlayVideoHtml(raw.html, targetId);
    if (!parsed.ok) throw createTaggedError(parsed.error, parsed.reason);
    const lesson = payload.lessons?.find((item) => item.liveId === targetId);
    const lessonTitle = lesson?.title || "";
    const updated = {
      ...payload,
      currentLiveId: targetId,
      lessonTitle,
      media: parsed.media
    };
    await api.storage.session.set({ [`player:${id}`]: updated });
    return {
      ok: true,
      courseTitle: updated.courseTitle,
      lessonTitle,
      currentLiveId: targetId,
      media: parsed.media
    };
  }

  function maxSignature(items = []) {
    return items.reduce((max, item) => Math.max(max, signatureTime(item?.url)), 0);
  }

  async function playerData(id, refresh, auto = false) {
    let payload = await readPlayer(id);
    let notice = "";
    if (refresh) {
      const currentLiveId = payload.currentLiveId || payload.liveId || "";
      const previousSig = maxSignature(payload.media);
      const latest = currentLiveId && currentLiveId !== payload.liveId ? null : await view(payload.sourceTabId);
      const latestHasFresher = !!(latest?.supported && latest.media.length >= 1 && (maxSignature(latest.media) > previousSig || latest.media.length > payload.media.length));

      if (latestHasFresher) {
        payload = {
          ...payload,
          courseTitle: latest.courseTitle,
          media: latest.media,
          liveId: latest.liveId || payload.liveId,
          currentLiveId: latest.liveId || payload.currentLiveId,
          sourceOrigin: latest.sourceOrigin || payload.sourceOrigin
        };
        await api.storage.session.set({ [`player:${id}`]: payload });
      } else if (currentLiveId) {
        try {
          const refreshed = await loadLesson(id, currentLiveId);
          // Preserve custom channel labels if the camera keys match.
          const mergedMedia = refreshed.media.map((item) => {
            const existing = payload.media.find((old) => old.key === item.key);
            return existing?.label ? { ...item, label: existing.label } : item;
          });
          payload = { ...payload, currentLiveId, lessonTitle: refreshed.lessonTitle || payload.lessonTitle || "", media: mergedMedia };
          await api.storage.session.set({ [`player:${id}`]: payload });
          return {
            ok: true,
            courseKey: payload.courseKey || "",
            courseTitle: payload.courseTitle,
            lessonTitle: payload.lessonTitle || "",
            currentLiveId,
            media: mergedMedia,
            prefs: await progressStore.getPrefs(),
            notice: ""
          };
        } catch (error) {
          if (auto) throw error;
          if (latest?.supported && latest.media.length >= 1) {
            payload = { ...payload, courseTitle: latest.courseTitle, media: latest.media };
            await api.storage.session.set({ [`player:${id}`]: payload });
          } else {
            notice = error?.message || "原回放页已关闭或尚未识别到可用视频，当前保留上次的视频源。";
          }
        }
      } else if (latest?.supported && latest.media.length >= 1) {
        payload = { ...payload, courseTitle: latest.courseTitle, media: latest.media };
        await api.storage.session.set({ [`player:${id}`]: payload });
      } else {
        if (auto) throw createTaggedError("原回放页已关闭，无法自动续签视频源。请重新打开原回放页面并重新识别。", "missing");
        notice = "原回放页已关闭或尚未识别到可用视频，当前保留上次的视频源。";
      }
    }
    return {
      ok: true,
      courseKey: payload.courseKey || "",
      courseTitle: payload.courseTitle,
      lessonTitle: payload.lessonTitle || "",
      currentLiveId: payload.currentLiveId || payload.liveId || "",
      media: payload.media,
      prefs: await progressStore.getPrefs(),
      notice
    };
  }

  async function subtitles(message) {
    const source = message.id !== undefined ? await readPlayer(message.id) : await enqueue(message.tabId, () => read(message.tabId));
    const tabId = source.sourceTabId ?? source.tabId;
    const item = source.media.find((media) => media.key === message.key);
    if (!item) throw new Error("找不到这个画面的字幕，请重新识别回放。");
    if (item.liveId) {
      const fetched = await fetchLessonSubtitles(tabId, source.sourceOrigin || "", item.liveId);
      if (fetched?.text) return { ok: true, text: fetched.text };
      if (fetched?.failed) throw new Error("读取课程字幕失败，请确认原回放页已登录后重试，或导入本地字幕。");
      throw new Error("这个画面没有可用的课程字幕，可以导入 SRT 或 VTT 文件。");
    }
    const target = item.documentId ? { tabId, documentIds: [item.documentId] } : { tabId, frameIds: [item.frameId ?? 0] };
    let result;
    try {
      await tabFor(tabId);
      const state = source.sourceTabId !== undefined ? await enqueue(tabId, () => read(tabId)) : source;
      const frame = state.frames[item.frameId ?? 0];
      const observedUrl = frame?.documentId === item.documentId ? frame?.subtitleUrl : "";
      const [injection] = await api.scripting.executeScript({ target, func: readCourseSubtitles, args: [item.key, item.frameUrl || "", observedUrl || ""] });
      result = injection?.result;
    } catch { /* The source tab or iframe may have closed. */ }
    if (!result || result.stale) {
      const fallbackLiveId = source.currentLiveId || source.liveId || "";
      if (message.id !== undefined && fallbackLiveId && source.sourceOrigin) {
        const fetched = await fetchLessonSubtitles(tabId, source.sourceOrigin, fallbackLiveId);
        if (fetched?.text) return { ok: true, text: fetched.text };
        if (fetched?.failed) throw new Error("读取课程字幕失败，请确认原回放页已登录后重试，或导入本地字幕。");
        throw new Error("这个画面没有可用的课程字幕，可以导入 SRT 或 VTT 文件。");
      }
      throw new Error("请打开对应课次的原回放页，重新识别后读取课程字幕，或导入本地字幕。");
    }
    if (result.text || result.cues?.length) return { ok: true, ...result };
    if (result.failed) throw new Error("读取课程字幕失败，请确认原回放页已登录后重试，或导入本地字幕。");
    throw new Error("这个画面没有可用的课程字幕，可以导入 SRT 或 VTT 文件。");
  }

  async function dispatch(message, sender = {}) {
    if (sender.id !== api.runtime.id) throw new Error("请求来源无效。" );
    if (message?.type === "PAGE_SNAPSHOT") return snapshot(message, sender);
    if (!sender.url?.startsWith(api.runtime.getURL(""))) throw new Error("请通过扩展面板操作。" );
    const tabId = message?.tabId;
    switch (message?.type) {
      case "OPEN_PLAYER": return openPlayer(tabId);
      case "GET_PLAYER": return playerData(message.id, !!message.refresh, !!message.auto);
      case "GET_PLAYLIST": return getPlaylist(message);
      case "LOAD_LESSON": return loadLesson(message.id, message.liveId);
      case "SAVE_PROGRESS": {
        const record = await progressStore.save({
          liveId: message.liveId,
          courseKey: message.courseKey || "",
          time: Number(message.time) || 0,
          duration: Number(message.duration) || 0,
          ended: !!message.ended
        });
        return { ok: true, record };
      }
      case "TOGGLE_WATCHED": {
        const record = await progressStore.toggleWatched(message.liveId, message.courseKey || "");
        return { ok: true, record };
      }
      case "GET_PROGRESS":
        return { ok: true, progress: await progressStore.getAll(), prefs: await progressStore.getPrefs() };
      case "SET_PLAYER_PREFS": {
        const patch = {};
        for (const field of ["autoPlayNext", "rate", "volume", "captionsEnabled", "audio", "offset", "courseKey"]) {
          if (Object.prototype.hasOwnProperty.call(message, field)) patch[field] = message[field];
        }
        return { ok: true, prefs: await progressStore.setPrefs(patch) };
      }
      case "GET_SUBTITLES": return subtitles(message);
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
      case "DOWNLOAD_SELECTED":
        if (!Array.isArray(message.keys) || !message.keys.length || !message.keys.every(key => typeof key === "string")) throw new Error("请先勾选要下载的画面。");
        return download(tabId, message.keys);
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
    if (details.tabId < 0 || closedTabs.has(details.tabId) || ![200, 206].includes(details.statusCode)) return;
    const subtitle = details.method === "GET" && isCourseSubtitleUrl(details.url);
    if (!subtitle && !isMediaUrl(details.url)) return;
    const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    if (!subtitle && contentType && !/^(video\/mp4|application\/octet-stream)(?:;|$)/i.test(contentType.trim())) return;
    // Do not collect a matching video embedded on an unrelated website.
    try { await tabFor(details.tabId); } catch { return; }
    await enqueue(details.tabId, async () => {
      const state = await read(details.tabId);
      const frame = state.frames[details.frameId];
      if (frame?.documentId && details.documentId && frame.documentId !== details.documentId) return;
      if (subtitle) {
        const lesson = frame?.url && new URL(frame.url).searchParams.get("workDetailId");
        if (lesson && new URL(details.url).searchParams.get("workDetailId") !== lesson) return;
        const nextDocumentId = details.documentId || frame?.documentId;
        if (frame?.subtitleUrl === details.url && frame?.documentId === nextDocumentId) return;
        state.frames[details.frameId] = { ...frame, documentId: nextDocumentId, subtitleUrl: details.url };
        await save(state);
        return;
      }
      const changed = upsertMedia(state, {
        url: details.url, frameId: details.frameId ?? 0, documentId: details.documentId,
        frameUrl: frame?.url, size: responseSize(details.responseHeaders), source: "network"
      }, details.timeStamp || Date.now());
      if (changed) await save(state);
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
    const entries = await api.storage.session.get(null);
    for (const [key, entry] of Object.entries(entries)) {
      if (key.startsWith("player:") && entry?.playerTabId === tabId) await api.storage.session.remove(key);
    }
  }

  return { dispatch, recordResponse, tabUpdated, tabRemoved };
}
