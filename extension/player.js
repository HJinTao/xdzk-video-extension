import { SyncPlayer, recordingOffset } from "./lib/sync-player.js";
import { bindSubtitles } from "./lib/subtitles.js";
import { bindPairedSubtitles } from "./lib/paired-subtitles.js";
import { createLecturePlayer } from "./lib/lecture-player.js";
import { bindPlaybackSpeed } from "./lib/playback-speed.js";
import { bindTranscript } from "./lib/transcript.js";
import { formatClock } from "./lib/media.js";
import { resumeTimeFor } from "./lib/watch-progress.js";
import { buildAudioPref, mergePlayerPrefs, normalizePlayerPrefs, resolveAudioPref, resolveOffsetPref } from "./lib/player-prefs.js";
import { bindPlaylistPanel } from "./lib/playlist-panel.js";
import { bindPlayerShortcuts } from "./lib/player-shortcuts.js";
import { canTriggerAutoRefresh, refreshFailureActions, renderMessageBar } from "./lib/source-recovery.js";
import { enhanceSelect, enhanceSegmentedSelect } from "./lib/custom-select.js";

const $ = (id) => document.getElementById(id);
const videos = [/** @type {HTMLVideoElement} */ ($("video-0")), /** @type {HTMLVideoElement} */ ($("video-1"))];
const id = new URL(location.href).searchParams.get("id");

let engine;
let media = [];
let singleMode = false;
let primary = 0;
let reviewIndex = 0;
let reviewClock = 0;
let captionOffset = 0;
let captionsEnabled = true;
let changingSources = false;
let openedReview = false;
let editingTimeline = false;
let savedAudio = 0;
let savedRate = 1;
let savedVolume = 1;
let playerPrefs = normalizePlayerPrefs();
let userTouchedAudio = false;
let userTouchedOffset = false;
let syncingVolume = false;
let volumeSaveTimer = null;
let pendingVolumeSave = null;
let currentLiveId = "";
let courseKey = "";
let switchingLesson = false;
let autoRefreshing = false;
let autoRefreshFailedFor = "";
let lastAutoRefreshSuccessAt = 0;
let wasPlaying = false;
let lastProgressSavedAt = 0;
let lastSavedTime = -1;
let initialResumeApplied = false;
let pendingStart = null;
const players = [];

function selectedPair() {
  if (media.length === 1) {
    const first = media.find((item) => item.key === /** @type {HTMLSelectElement} */ ($("source-0")).value) || media[0];
    return first ? [first] : [];
  }
  return [
    /** @type {HTMLSelectElement} */ ($("source-0")).value,
    /** @type {HTMLSelectElement} */ ($("source-1")).value
  ].map((key) => media.find((item) => item.key === key));
}

function savePlayerPrefs(patch) {
  playerPrefs = mergePlayerPrefs(playerPrefs, patch);
  void chrome.runtime.sendMessage({ type: "SET_PLAYER_PREFS", ...patch }).catch(() => {});
}

function syncAudioRadios(value) {
  document.querySelectorAll('input[name="audio"]').forEach((radio) => {
    /** @type {HTMLInputElement} */ (radio).checked = Number(/** @type {HTMLInputElement} */ (radio).value) === value;
  });
}

function applyVolume(value) {
  const safe = Math.max(0, Math.min(1, Math.round(Number(value) * 100) / 100));
  if (!Number.isFinite(safe)) return;
  syncingVolume = true;
  try {
    videos.forEach((video) => {
      if (Math.abs(video.volume - safe) >= 0.005) video.volume = safe;
    });
  } finally {
    syncingVolume = false;
  }
}

function flushVolumeSave() {
  if (volumeSaveTimer) {
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = null;
  }
  if (pendingVolumeSave !== null) {
    const value = pendingVolumeSave;
    pendingVolumeSave = null;
    savePlayerPrefs({ volume: value });
  }
}

function scheduleVolumeSave(value) {
  pendingVolumeSave = value;
  if (volumeSaveTimer) clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(flushVolumeSave, 200);
}

function message(text = "", options = {}) {
  renderMessageBar($("message"), $("message-text"), $("message-actions"), text, options);
}

function updateSideLayout() {
  const reviewOpen = !$("review").hidden;
  const playlistOpen = !$("playlist-panel").hidden;
  const layout = document.querySelector(".study-layout");
  layout.classList.toggle("review-open", reviewOpen);
  layout.classList.toggle("panel-open", reviewOpen || playlistOpen);
}

const playlist = bindPlaylistPanel(document, {
  onSelectLesson(liveId) {
    if (liveId === currentLiveId) {
      if (!engine?.wantPlaying) void engine?.play();
      return;
    }
    void switchLesson(liveId, { autoplay: true });
  },
  onToggleWatched(liveId) { void toggleLessonWatched(liveId); },
  onRefresh() { void loadPlaylist({ showErrors: true }); },
  onAutoNextChange(enabled) { savePlayerPrefs({ autoPlayNext: enabled }); },
  onOpenReview() { showReview(true); },
  onLayoutChange: updateSideLayout
});

const speedControl = bindPlaybackSpeed($("speed-control"), (value) => {
  savedRate = value;
  engine?.setRate(value);
  savePlayerPrefs({ rate: value });
});

const transcript = bindTranscript($("review"), (seconds) => {
  playlist.cancelCountdown();
  if (engine?.range()) engine.seek(seconds - (reviewClock === 1 ? engine.offset : 0));
});

const subtitles = videos.map((video, index) => bindSubtitles($("subtitles-" + index), video, async (key) => {
  const result = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", id, key });
  if (!result?.ok) throw new Error(result?.error || "读取课程字幕失败，请重试。");
  return result;
}, refreshCaptions));
const updateCaptionPair = bindPairedSubtitles(videos, subtitles);
document.querySelectorAll('.subtitle-mode option[value="off"]').forEach((option) => { option.textContent = "跟随另一路"; });
const sourceSelectUis = [
  enhanceSelect(/** @type {HTMLSelectElement} */ ($("source-0")), { placement: "top" }),
  enhanceSelect(/** @type {HTMLSelectElement} */ ($("source-1")), { placement: "top" })
];
const reviewSourceUi = enhanceSegmentedSelect(/** @type {HTMLSelectElement} */ ($("review-source")));

function applyGlobalPrefs(rawPrefs) {
  playerPrefs = normalizePlayerPrefs(rawPrefs);
  savedRate = playerPrefs.rate;
  savedVolume = playerPrefs.volume;
  captionsEnabled = playerPrefs.captionsEnabled;
  playlist.setAutoPlayNext(playerPrefs.autoPlayNext);
  speedControl.set(savedRate);
  applyVolume(savedVolume);
}

function refreshCaptions() {
  if (changingSources) return;
  const origins = updateCaptionPair(captionOffset, captionsEnabled);
  const origin = origins[reviewIndex];
  reviewClock = origin ?? reviewIndex;
  transcript.setWindow(engine?.range(), reviewClock === 1 ? captionOffset : 0);
  transcript.setTrack(origin === null ? null : subtitles[origin].track);
  const sharing = origin !== null && origin !== reviewIndex;
  $("shared-caption-note").hidden = !sharing;
  if (sharing) {
    const label = subtitles[origin].track.label || "课程字幕";
    const clockName = $("screen-name-" + origin).textContent;
    $("shared-caption-note").textContent = `两路共用「${label}」，点击字幕会按「${clockName}」的时间码跳转。`;
  }
  const available = origins.some((index) => index !== null);
  const loading = subtitles.some((control) => control.loading);
  $("caption-state").textContent = !captionsEnabled ? "关" : available ? "开" : loading ? "读取中" : "待导入";
  $("toggle-captions").setAttribute("aria-pressed", String(captionsEnabled));
  $("caption-hint").hidden = !engine || !captionsEnabled || available || loading;
}

function setPrimary(index) {
  primary = index;
  /** @type {HTMLElement} */ (document.querySelector(".screens")).dataset.primary = String(index);
  $("screen-role-0").textContent = index === 0 ? "主画面" : "副画面";
  $("screen-role-1").textContent = index === 1 ? "主画面" : "副画面";
}

function selectReview(index) {
  reviewIndex = singleMode ? 0 : index;
  /** @type {HTMLSelectElement} */ ($("review-source")).value = String(reviewIndex);
  reviewSourceUi.sync();
  document.querySelectorAll("[data-track-panel]").forEach((panel) => {
    /** @type {HTMLElement} */ (panel).hidden = Number(/** @type {HTMLElement} */ (panel).dataset.trackPanel) !== reviewIndex;
  });
  refreshCaptions();
}

function showReview(open) {
  if (open && !$("playlist-panel").hidden) {
    $("playlist-panel").hidden = true;
    $("toggle-playlist").setAttribute("aria-expanded", "false");
  }
  $("review").hidden = !open;
  $("toggle-review").setAttribute("aria-expanded", String(open));
  updateSideLayout();
  if (open) {
    selectReview(openedReview ? reviewIndex : primary);
    openedReview = true;
    reviewSourceUi.focus();
    transcript.followCurrent();
  } else {
    $("toggle-review").focus();
  }
}

async function persistProgress({ ended = false, force = false } = {}) {
  if (!currentLiveId || !engine?.range()) return;
  const range = engine.range();
  const duration = Math.max(0, range.end - range.start);
  if (duration <= 0) return;
  const time = Math.max(0, engine.time() - range.start);
  const now = Date.now();
  if (!force && !ended) {
    if (now - lastProgressSavedAt < 5000 || Math.abs(time - lastSavedTime) < 1) return;
  }
  lastProgressSavedAt = now;
  lastSavedTime = time;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "SAVE_PROGRESS",
      liveId: currentLiveId,
      courseKey,
      time,
      duration,
      ended
    });
    if (result?.ok && result.record) playlist.setProgressRecord(currentLiveId, result.record);
  } catch { /* Ignore background disconnects on pagehide. */ }
}

async function toggleLessonWatched(liveId) {
  try {
    const result = await chrome.runtime.sendMessage({ type: "TOGGLE_WATCHED", liveId, courseKey });
    if (result?.ok && result.record) playlist.setProgressRecord(liveId, result.record);
  } catch { /* Ignore transient errors. */ }
}

function handlePlaybackEnded() {
  void persistProgress({ ended: true, force: true });
  const next = playlist.adjacentLesson(1);
  if (playlist.autoPlayNext && next) playlist.startCountdown(next);
}

function applyPendingStart(start) {
  if (!start || engine !== start.generation) return;
  const range = engine.range();
  if (!range) return;
  if (start.fromResume) {
    if (initialResumeApplied || engine.wantPlaying || engine.time() >= 2) return;
    const resumeAt = resumeTimeFor(start.record, range.end - range.start);
    if (resumeAt <= 0) return;
    initialResumeApplied = true;
    engine.seek(range.start + resumeAt);
    message(`已定位到上次观看位置 ${formatClock(resumeAt)}，点击“播放”继续。`);
    return;
  }
  if (start.time > 0) engine.seek(start.relativeToRange ? range.start + start.time : start.time);
  if (start.autoplay) void engine.play();
}

function syncTimelineTrack(value, min, max) {
  const span = max - min;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((value - min) / span) * 100)) : 0;
  /** @type {HTMLInputElement} */ ($("timeline")).style.setProperty("--progress", `${pct}%`);
}

function stateChanged(state) {
  const ready = !!state.range;
  for (const name of ["play", "back", "forward", "timeline"]) {
    /** @type {HTMLButtonElement | HTMLInputElement} */ ($(name)).disabled = !ready;
  }
  $("play").textContent = state.playing ? "暂停" : "播放";
  const status = singleMode
    ? (state.buffering ? "缓冲中" : !ready ? "等待视频就绪" : state.playing ? "单画面播放中" : "单画面已就绪")
    : (state.buffering ? "缓冲中，等待两路画面" : !ready ? "等待两路视频就绪或时间重叠" : state.playing ? "两路同步播放中" : "两路已同步");
  const statusEl = $("sync-status");
  if (statusEl.textContent !== status) statusEl.textContent = status;
  statusEl.dataset.state = state.buffering ? "buffering" : !ready ? "idle" : state.playing ? "playing" : "ready";
  if (Number.isFinite(state.offset) && captionOffset !== state.offset) {
    captionOffset = state.offset;
    refreshCaptions();
  }
  transcript.setWindow(state.range, reviewClock === 1 ? captionOffset : 0);
  const timeline = /** @type {HTMLInputElement} */ ($("timeline"));
  if (ready) {
    timeline.min = String(state.range.start);
    timeline.max = String(state.range.end);
    if (!editingTimeline) {
      timeline.value = String(state.time);
      syncTimelineTrack(state.time, state.range.start, state.range.end);
    }
    $("duration").textContent = formatClock(state.range.end);
    if (state.playing) {
      playlist.cancelCountdown();
      void persistProgress({ force: false });
    } else if (wasPlaying) {
      void persistProgress({ force: true });
    }
  } else {
    $("duration").textContent = "--:--";
    syncTimelineTrack(0, 0, 1);
  }
  wasPlaying = !!state.playing;
  $("current").textContent = formatClock(editingTimeline ? Number(timeline.value) : state.time);
  speedControl.set(state.rate);
  if (Number.isFinite(state.rate) && state.rate !== savedRate) {
    savedRate = state.rate;
    savePlayerPrefs({ rate: state.rate });
  }
  if (ready && pendingStart) {
    const start = pendingStart;
    pendingStart = null;
    applyPendingStart(start);
  }
}

async function autoRefreshSources({ resumeTime = 0, shouldPlay = false, fallbackMessage = "" } = {}) {
  if (autoRefreshing || switchingLesson) return;
  autoRefreshing = true;
  /** @type {HTMLButtonElement} */ ($("refresh")).disabled = true;
  message("视频链接可能已过期，正在自动续签视频源…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYER", id, refresh: true, auto: true });
    if (!result?.ok || !Array.isArray(result.media) || result.media.length < 1) {
      const err = /** @type {Error & { reason?: string }} */ (new Error(result?.error || fallbackMessage));
      if (result?.reason) err.reason = result.reason;
      throw err;
    }
    if (result.currentLiveId) {
      currentLiveId = result.currentLiveId;
      playlist.setCurrentLiveId(currentLiveId);
    }
    autoRefreshFailedFor = "";
    lastAutoRefreshSuccessAt = Date.now();
    populateSources(result.media, { keepSelection: true });
    loadPair({ preserve: true, resumeAt: resumeTime, autoplay: shouldPlay });
    message(shouldPlay ? "已自动续签视频源并恢复播放。" : "已自动续签视频源，点击“播放”继续。");
  } catch (error) {
    autoRefreshFailedFor = currentLiveId;
    const reason = error?.reason || "";
    const actions = refreshFailureActions(reason, () => { void load({ refresh: true }); });
    message(error?.message || fallbackMessage || "自动续签视频源失败，请刷新原回放页面后重试。", { actions });
  } finally {
    autoRefreshing = false;
    /** @type {HTMLButtonElement} */ ($("refresh")).disabled = false;
  }
}

function handleEngineError(errorText, detail) {
  if (canTriggerAutoRefresh({ detail, currentLiveId, autoRefreshing, switchingLesson, autoRefreshFailedFor, lastAutoRefreshSuccessAt })) {
    void autoRefreshSources({
      resumeTime: engine?.time() || 0,
      shouldPlay: !!detail.wasPlaying,
      fallbackMessage: errorText
    });
    return;
  }
  message(errorText);
}

function setScreenMode(single) {
  singleMode = single;
  /** @type {HTMLElement} */ (document.querySelector(".screens")).dataset.mode = single ? "single" : "dual";
  $("screen-1").hidden = single;
  $("swap-views").hidden = single;
  $("audio-option-1").hidden = single;
  $("source-1-wrap").hidden = single;
  $("offset-wrap").hidden = single;
  $("reset-offset").hidden = single;
  const reviewSelect = /** @type {HTMLSelectElement} */ ($("review-source"));
  if (reviewSelect.options[1]) reviewSelect.options[1].hidden = single;
  reviewSelect.disabled = single;
  reviewSourceUi.sync();
}

function loadPair({ preserve = false, resumeAt = 0, relativeToRange = false, autoplay = false } = {}) {
  const time = preserve ? (resumeAt || engine?.time() || 0) : resumeAt;
  const previousOffset = preserve ? engine?.offset : undefined;
  const rate = engine?.rate || savedRate;
  playlist.cancelCountdown();
  pendingStart = null;
  wasPlaying = false;
  lastSavedTime = -1;
  engine?.destroy();
  engine = null;
  setScreenMode(media.length === 1);
  if (singleMode) {
    const item = selectedPair()[0];
    const valid = !!item;
    /** @type {HTMLButtonElement} */ ($("swap-views")).disabled = true;
    for (const name of ["toggle-review", "toggle-captions"]) {
      /** @type {HTMLButtonElement} */ ($(name)).disabled = !valid;
    }
    const name = item?.label || "画面 1";
    $("screen-name-0").textContent = name;
    $("screen-role-0").textContent = "单画面";
    $("audio-name-0").textContent = name;
    /** @type {HTMLSelectElement} */ ($("review-source")).options[0].textContent = name;
    reviewSourceUi.sync();
    changingSources = true;
    subtitles[0].setSource(valid ? item.key : "");
    subtitles[1].setSource("");
    changingSources = false;
    players[1]?.reset();
    if (!valid) {
      refreshCaptions();
      if (!$("review").hidden) showReview(false);
      players[0]?.reset();
      stateChanged({ time: 0, range: null, playing: false, rate: savedRate });
      message("没有可用的视频源。");
      return;
    }
    primary = 0;
    /** @type {HTMLElement} */ (document.querySelector(".screens")).dataset.primary = "0";
    if (!preserve && !userTouchedAudio) {
      const preferred = resolveAudioPref(playerPrefs, courseKey, [item]);
      savedAudio = preferred === -1 ? -1 : 0;
    }
    const effectiveAudio = savedAudio === -1 ? -1 : 0;
    message();
    if (players[0]) players[0].url = item.url;
    else players[0] = createLecturePlayer(videos[0], item.url, { hotkey: false, volume: savedVolume });
    videos[0].load();
    applyVolume(savedVolume);
    engine = new SyncPlayer([videos[0]], { onState: stateChanged, onError: handleEngineError, onEnded: handlePlaybackEnded });
    engine.setAudio(effectiveAudio);
    syncAudioRadios(effectiveAudio);
    engine.setRate(rate);
    subtitles[0].ensureCourse();
    selectReview(0);
    if (time > 0 || autoplay) {
      const start = { generation: engine, time, relativeToRange, autoplay };
      if (engine.range()) applyPendingStart(start);
      else pendingStart = start;
    }
    return;
  }
  const pair = selectedPair();
  const valid = pair.length === 2 && pair.every(Boolean) && pair[0].key !== pair[1].key;
  for (const name of ["swap-views", "toggle-review", "toggle-captions"]) {
    /** @type {HTMLButtonElement} */ ($(name)).disabled = !valid;
  }
  pair.forEach((item, index) => {
    const name = item?.label || `画面 ${index + 1}`;
    $("screen-name-" + index).textContent = name;
    $("audio-name-" + index).textContent = name;
    /** @type {HTMLSelectElement} */ ($("review-source")).options[index].textContent = name;
  });
  reviewSourceUi.sync();
  changingSources = true;
  subtitles.forEach((control, index) => control.setSource(valid ? pair[index].key : ""));
  changingSources = false;
  if (!valid) {
    refreshCaptions();
    if (!$("review").hidden) showReview(false);
    players.forEach((player) => player.reset());
    stateChanged({ time: 0, range: null, playing: false, rate: savedRate });
    message("请选择两路不同的画面。");
    return;
  }
  if (!preserve) {
    const slide = pair.findIndex((item) => /课件|幻灯|投屏|屏幕|桌面|PPT|slides?/i.test(item.label));
    setPrimary(slide < 0 ? 0 : slide);
    if (!userTouchedAudio) {
      savedAudio = resolveAudioPref(playerPrefs, courseKey, pair);
      syncAudioRadios(savedAudio);
    }
  } else {
    setPrimary(primary);
  }
  message();
  videos.forEach((video, index) => {
    if (players[index]) players[index].url = pair[index].url;
    else players[index] = createLecturePlayer(video, pair[index].url, { hotkey: false, volume: savedVolume });
    video.load();
  });
  applyVolume(savedVolume);
  engine = new SyncPlayer(videos, { onState: stateChanged, onError: handleEngineError, onEnded: handlePlaybackEnded });
  const savedCourseOffset = resolveOffsetPref(playerPrefs, courseKey);
  const offset = previousOffset ?? (savedCourseOffset !== undefined ? savedCourseOffset : recordingOffset(pair[0].url, pair[1].url));
  /** @type {HTMLInputElement} */ ($("offset")).value = String(offset);
  engine.setOffset(offset);
  engine.setAudio(savedAudio);
  syncAudioRadios(savedAudio);
  engine.setRate(rate);
  subtitles.forEach((control) => control.ensureCourse());
  selectReview(openedReview ? reviewIndex : primary);
  if (time > 0 || autoplay) {
    const start = { generation: engine, time, relativeToRange, autoplay };
    if (engine.range()) applyPendingStart(start);
    else pendingStart = start;
  }
}

function populateSources(nextMedia, { keepSelection = false } = {}) {
  const previous = [
    /** @type {HTMLSelectElement} */ ($("source-0")).value,
    /** @type {HTMLSelectElement} */ ($("source-1")).value
  ];
  const wasSingle = media.length === 1;
  media = nextMedia;
  const isSingle = media.length === 1;
  for (let index = 0; index < 2; index++) {
    const select = /** @type {HTMLSelectElement} */ ($("source-" + index));
    if (isSingle && index === 1) {
      select.replaceChildren();
      continue;
    }
    select.replaceChildren(...media.map((item) => {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.label;
      return option;
    }));
    const fallback = media[index]?.key || media[0]?.key || "";
    select.value = keepSelection && media.some((item) => item.key === previous[index]) ? previous[index] : fallback;
    sourceSelectUis[index].sync();
  }
  if (isSingle) sourceSelectUis[1].sync();
  if (wasSingle !== isSingle) return false;
  return isSingle ? previous[0] === /** @type {HTMLSelectElement} */ ($("source-0")).value : previous.every((key, index) => key === /** @type {HTMLSelectElement} */ ($("source-" + index)).value);
}

async function switchLesson(targetLiveId, { autoplay = true } = {}) {
  if (switchingLesson || !targetLiveId) return;
  playlist.cancelCountdown();
  await persistProgress({ force: true });
  switchingLesson = true;
  playlist.setSwitching(true);
  playlist.render();
  const target = playlist.lessons.find((item) => item.liveId === targetLiveId);
  message(`正在加载${target ? `第 ${target.index} 讲 · ${target.title}` : "新课次"}…`);
  try {
    const result = await chrome.runtime.sendMessage({ type: "LOAD_LESSON", id, liveId: targetLiveId });
    if (!result?.ok) throw new Error(result?.error || "切换课次失败，请重试。");
    if (!Array.isArray(result.media) || result.media.length < 1) throw new Error("该课次没有可用的视频源，暂时无法播放。");
    currentLiveId = result.currentLiveId || targetLiveId;
    playlist.setCurrentLiveId(currentLiveId);
    autoRefreshFailedFor = "";
    lastAutoRefreshSuccessAt = 0;
    initialResumeApplied = true;
    populateSources(result.media, { keepSelection: false });
    const resumeAt = resumeTimeFor(playlist.progressMap[currentLiveId]);
    loadPair({ preserve: false, resumeAt, relativeToRange: true, autoplay });
    playlist.updateHeading(result.lessonTitle || "");
    if (resumeAt > 0) message(`已恢复到上次观看位置 ${formatClock(resumeAt)}`);
  } catch (error) {
    message(error.message || "切换课次失败，请重试。");
  } finally {
    switchingLesson = false;
    playlist.setSwitching(false);
    playlist.render();
    playlist.scrollCurrentIntoView();
  }
}

async function loadPlaylist({ showErrors = false } = {}) {
  playlist.setRefreshDisabled(true);
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYLIST", id });
    if (!result?.ok) {
      if (showErrors) playlist.setStatus(result?.error || "获取课程目录失败。");
      return;
    }
    playlist.setProgressMap(result.progress || {});
    if (result.prefs) {
      playerPrefs = normalizePlayerPrefs(result.prefs);
      playlist.setAutoPlayNext(playerPrefs.autoPlayNext);
    }
    if (!result.supported || !Array.isArray(result.lessons) || !result.lessons.length) {
      playlist.setLessons([]);
      playlist.updateNav();
      return;
    }
    courseKey = result.courseKey || "";
    if (engine) {
      const pair = selectedPair();
      if (!userTouchedAudio && pair.length && pair.every(Boolean)) {
        const rawPreferred = resolveAudioPref(playerPrefs, courseKey, pair);
        const preferredAudio = singleMode ? (rawPreferred === -1 ? -1 : 0) : rawPreferred;
        if (preferredAudio !== savedAudio) {
          savedAudio = preferredAudio;
          syncAudioRadios(savedAudio);
          engine.setAudio(savedAudio);
        }
      }
      if (!singleMode && !userTouchedOffset) {
        const preferredOffset = resolveOffsetPref(playerPrefs, courseKey);
        if (preferredOffset !== undefined && preferredOffset !== engine.offset) {
          /** @type {HTMLInputElement} */ ($("offset")).value = String(preferredOffset);
          engine.setOffset(preferredOffset);
        }
      }
    }
    playlist.setLessons(result.lessons);
    if (result.currentLiveId && !currentLiveId) {
      currentLiveId = result.currentLiveId;
      playlist.setCurrentLiveId(currentLiveId);
    }
    if (result.courseTitle) {
      $("course-title").textContent = result.courseTitle;
      document.title = `${result.courseTitle} · 专注看课`;
    }
    playlist.render();
    if (!initialResumeApplied && currentLiveId && engine && !engine.wantPlaying && engine.time() < 2) {
      const record = playlist.progressMap[currentLiveId];
      const range = engine.range();
      if (resumeTimeFor(record, range ? range.end - range.start : 0) > 0) {
        const start = { generation: engine, fromResume: true, record };
        if (range) applyPendingStart(start);
        else if (!pendingStart) pendingStart = start;
      }
    }
  } catch (error) {
    if (showErrors) playlist.setStatus(error.message || "获取课程目录失败。");
  } finally {
    playlist.setRefreshDisabled(false);
  }
}

async function load({ refresh = false } = {}) {
  /** @type {HTMLButtonElement} */ ($("refresh")).disabled = true;
  if (refresh) autoRefreshFailedFor = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYER", id, refresh });
    if (!result?.ok) throw new Error(result?.error || "无法读取课程，请从扩展面板重新打开播放器。");
    if (!Array.isArray(result.media) || result.media.length < 1) throw new Error("还没有识别到视频。请回到原回放页面，播放画面并重新识别。");
    if (result.currentLiveId) {
      currentLiveId = result.currentLiveId;
      playlist.setCurrentLiveId(currentLiveId);
    }
    if (result.courseKey && !courseKey) courseKey = result.courseKey;
    if (!refresh && result.prefs) applyGlobalPrefs(result.prefs);
    const samePair = populateSources(result.media, { keepSelection: true });
    $("course-title").textContent = result.courseTitle;
    document.title = `${result.courseTitle} · 专注看课`;
    playlist.updateHeading(result.lessonTitle || "");
    loadPair({ preserve: refresh && samePair });
    if (refresh) message(result.notice || "已更新视频源，请点击“播放”继续。若仍无法播放，请先刷新原回放页面并重新识别。");
    if (!refresh) void loadPlaylist();
  } catch (error) {
    if (!media.length) $("course-title").textContent = "课程回放";
    message(error.message);
  } finally {
    /** @type {HTMLButtonElement} */ ($("refresh")).disabled = false;
  }
}

function togglePlayback() {
  if (!engine?.range()) return;
  playlist.cancelCountdown();
  message();
  if (engine.wantPlaying) engine.pause();
  else void engine.play();
}

$("play").addEventListener("click", togglePlayback);
$("back").addEventListener("click", () => { playlist.cancelCountdown(); engine?.seek(engine.time() - 10); });
$("forward").addEventListener("click", () => { playlist.cancelCountdown(); engine?.seek(engine.time() + 10); });
const timelineInput = /** @type {HTMLInputElement} */ ($("timeline"));
timelineInput.addEventListener("input", () => {
  editingTimeline = true;
  const val = Number(timelineInput.value);
  $("current").textContent = formatClock(val);
  syncTimelineTrack(val, Number(timelineInput.min), Number(timelineInput.max));
});
timelineInput.addEventListener("change", () => { editingTimeline = false; playlist.cancelCountdown(); engine?.seek(Number(timelineInput.value)); });
timelineInput.addEventListener("blur", () => { if (editingTimeline) { editingTimeline = false; engine?.seek(Number(timelineInput.value)); } });
const offsetInput = /** @type {HTMLInputElement} */ ($("offset"));
offsetInput.addEventListener("change", () => {
  if (!offsetInput.checkValidity()) return;
  const value = Number(offsetInput.value);
  userTouchedOffset = true;
  engine?.setOffset(value);
  if (courseKey) savePlayerPrefs({ courseKey, offset: value });
});
$("reset-offset")?.addEventListener("click", () => {
  const pair = selectedPair();
  const autoOffset = pair.length === 2 && pair.every(Boolean) ? recordingOffset(pair[0].url, pair[1].url) : 0;
  userTouchedOffset = false;
  offsetInput.value = String(autoOffset);
  engine?.setOffset(autoOffset);
  if (courseKey) savePlayerPrefs({ courseKey, offset: null });
});
document.querySelectorAll('input[name="audio"]').forEach((radio) => radio.addEventListener("change", () => {
  userTouchedAudio = true;
  savedAudio = Number(/** @type {HTMLInputElement} */ (radio).value);
  engine?.setAudio(savedAudio);
  const audioPref = buildAudioPref(savedAudio, selectedPair());
  if (audioPref) savePlayerPrefs({ audio: audioPref, ...(courseKey ? { courseKey } : {}) });
}));
videos.forEach((video, index) => {
  video.addEventListener("volumechange", () => {
    if (syncingVolume) return;
    const next = Math.max(0, Math.min(1, Math.round(video.volume * 100) / 100));
    if (Math.abs(next - savedVolume) < 0.005) return;
    if (engine && engine.audio >= 0 && index !== engine.audio) return;
    savedVolume = next;
    applyVolume(savedVolume);
    scheduleVolumeSave(savedVolume);
  });
});
for (let index = 0; index < 2; index++) $("source-" + index).addEventListener("change", () => loadPair());
$("refresh").addEventListener("click", () => { void load({ refresh: true }); });
$("swap-views").addEventListener("click", () => setPrimary(1 - primary));
$("toggle-review").addEventListener("click", () => showReview($("review").hidden));
$("toggle-captions").addEventListener("click", () => {
  captionsEnabled = !captionsEnabled;
  refreshCaptions();
  savePlayerPrefs({ captionsEnabled });
});
$("close-review").addEventListener("click", () => showReview(false));
$("review-source").addEventListener("change", () => selectReview(Number(/** @type {HTMLSelectElement} */ ($("review-source")).value)));

const unbindShortcuts = bindPlayerShortcuts(document, {
  getEngine: () => engine,
  onTogglePlayback: togglePlayback,
  onSeekDelta(delta) {
    playlist.cancelCountdown();
    engine?.seek(engine.time() + delta);
  },
  onVolumeDelta(delta) {
    if (!engine || engine.audio < 0) return;
    const active = videos[engine.audio];
    const nextVolume = Math.max(0, Math.min(1, Math.round((active.volume + delta) * 10) / 10));
    savedVolume = nextVolume;
    applyVolume(savedVolume);
    scheduleVolumeSave(savedVolume);
  }
});

document.addEventListener("fullscreenchange", () => {
  if (!engine) return;
  engine.resumeIfReady();
  if (!document.fullscreenElement && engine.wantPlaying) engine.tick();
});

window.addEventListener("pagehide", () => {
  unbindShortcuts();
  playlist.destroy();
  speedControl.destroy();
  sourceSelectUis.forEach((ui) => ui.destroy());
  reviewSourceUi.destroy();
  flushVolumeSave();
  void persistProgress({ force: true });
  engine?.destroy();
  changingSources = true;
  subtitles.forEach((control) => control.setSource(""));
  updateCaptionPair(0, false);
  transcript.setTrack(null);
  players.forEach((player) => player.destroy());
});
void load();
