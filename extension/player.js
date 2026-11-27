import { SyncPlayer, recordingOffset } from "./lib/sync-player.js";
import { bindSubtitles } from "./lib/subtitles.js";
import { bindPairedSubtitles } from "./lib/paired-subtitles.js";
import { createLecturePlayer } from "./lib/lecture-player.js";
import { bindPlaybackSpeed } from "./lib/playback-speed.js";
import { bindTranscript } from "./lib/transcript.js";
import { formatClock } from "./lib/media.js";
import { computeWatchStatus, resumeTimeFor } from "./lib/watch-progress.js";

const $ = (id) => document.getElementById(id);
const videos = [$("video-0"), $("video-1")];
const id = new URL(location.href).searchParams.get("id");
const AUTO_NEXT_SECONDS = 5;
const AUTO_REFRESH_COOLDOWN_MS = 30_000;
const LOGIN_PORTAL_URL = "https://xdspoc.xidian.edu.cn/";
let engine;
let media = [];
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
let currentLiveId = "";
let courseKey = "";
let lessons = [];
let progressMap = {};
let autoPlayNext = true;
let playlistFilter = "all";
let switchingLesson = false;
let autoRefreshing = false;
let autoRefreshFailedFor = "";
let lastAutoRefreshSuccessAt = 0;
let wasPlaying = false;
let lastProgressSavedAt = 0;
let lastSavedTime = -1;
let countdownTimer = null;
let countdownTarget = null;
let countdownLeft = 0;
let initialResumeApplied = false;
let pendingStart = null;
const players = [];
const speedControl = bindPlaybackSpeed($("speed-control"), (value) => { savedRate = value; engine?.setRate(value); });
const transcript = bindTranscript($("review"), (seconds) => {
  cancelCountdown();
  if (engine?.range()) engine.seek(seconds - (reviewClock === 1 ? engine.offset : 0));
});
const subtitles = videos.map((video, index) => bindSubtitles($("subtitles-" + index), video, async (key) => {
  const result = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", id, key });
  if (!result?.ok) throw new Error(result?.error || "读取课程字幕失败，请重试。");
  return result;
}, refreshCaptions));
const updateCaptionPair = bindPairedSubtitles(videos, subtitles);
document.querySelectorAll('.subtitle-mode option[value="off"]').forEach(option => { option.textContent = "跟随另一路"; });

function message(text = "", { actions = [] } = {}) {
  $("message-text").textContent = text;
  const actionsBox = $("message-actions");
  actionsBox.replaceChildren();
  for (const action of actions) {
    if (action.type === "link") {
      const link = document.createElement("a");
      link.className = "message-link";
      link.href = action.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = action.label;
      actionsBox.append(link);
    } else if (action.type === "button") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-retry";
      button.textContent = action.label;
      button.addEventListener("click", action.onClick);
      actionsBox.append(button);
    }
  }
  actionsBox.hidden = actions.length === 0;
  $("message").hidden = !text;
}

function updateSideLayout() {
  const reviewOpen = !$("review").hidden;
  const playlistOpen = !$("playlist-panel").hidden;
  const layout = document.querySelector(".study-layout");
  layout.classList.toggle("review-open", reviewOpen);
  layout.classList.toggle("panel-open", reviewOpen || playlistOpen);
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
  const available = origins.some(index => index !== null);
  const loading = subtitles.some(control => control.loading);
  $("caption-state").textContent = !captionsEnabled ? "关" : available ? "开" : loading ? "读取中" : "待导入";
  $("toggle-captions").setAttribute("aria-pressed", String(captionsEnabled));
  $("caption-hint").hidden = !engine || !captionsEnabled || available || loading;
}

function setPrimary(index) {
  primary = index;
  document.querySelector(".screens").dataset.primary = String(index);
  $("screen-role-0").textContent = index === 0 ? "主画面" : "副画面";
  $("screen-role-1").textContent = index === 1 ? "主画面" : "副画面";
}

function selectReview(index) {
  reviewIndex = index;
  $("review-source").value = String(index);
  document.querySelectorAll("[data-track-panel]").forEach((panel) => { panel.hidden = Number(panel.dataset.trackPanel) !== index; });
  refreshCaptions();
}

function showPlaylist(open, { focus = true } = {}) {
  if (open && !$("review").hidden) {
    $("review").hidden = true;
    $("toggle-review").setAttribute("aria-expanded", "false");
  }
  $("playlist-panel").hidden = !open;
  $("toggle-playlist").setAttribute("aria-expanded", String(open));
  updateSideLayout();
  if (open) {
    scrollCurrentLessonIntoView();
    if (focus) $("playlist-filter").focus();
  } else if (focus) {
    $("toggle-playlist").focus();
  }
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
    $("review-source").focus();
    transcript.followCurrent();
  } else {
    $("toggle-review").focus();
  }
}

function adjacentLesson(direction) {
  if (!lessons.length || !currentLiveId) return null;
  const currentIndex = lessons.findIndex((item) => item.liveId === currentLiveId);
  if (currentIndex < 0) return null;
  for (let i = currentIndex + direction; i >= 0 && i < lessons.length; i += direction) {
    if (lessons[i].available) return lessons[i];
  }
  return null;
}

function updateLessonHeading(explicitTitle = "") {
  const current = lessons.find((item) => item.liveId === currentLiveId);
  const parts = [];
  if (current) {
    parts.push(`第 ${current.index} 讲 · ${current.title}`);
    if (current.shortDate) parts.push(current.shortDate);
    if (current.timeRange) parts.push(current.timeRange);
  } else if (explicitTitle) {
    parts.push(explicitTitle);
  }
  const text = parts.join(" · ");
  $("lesson-subtitle").textContent = text;
  $("lesson-subtitle").hidden = !text;
}

function updateLessonNav() {
  const hasPlaylist = lessons.length > 0;
  $("toggle-playlist").hidden = !hasPlaylist;
  $("prev-lesson").hidden = !hasPlaylist;
  $("next-lesson").hidden = !hasPlaylist;
  $("auto-next-wrap").hidden = !hasPlaylist;
  document.querySelectorAll(".side-tab-playlist").forEach((button) => { button.hidden = !hasPlaylist; });
  if (!hasPlaylist) return;
  const available = lessons.filter((item) => item.available);
  const watchedCount = available.filter((item) => computeWatchStatus(progressMap[item.liveId]) === "watched").length;
  $("playlist-badge").textContent = `${watchedCount}/${available.length}`;
  $("playlist-summary").textContent = `已看 ${watchedCount} / ${available.length} 节`;
  const overallFill = $("playlist-overall-fill");
  if (overallFill) overallFill.style.width = `${available.length ? Math.round((watchedCount / available.length) * 100) : 0}%`;
  $("prev-lesson").disabled = switchingLesson || !adjacentLesson(-1);
  $("next-lesson").disabled = switchingLesson || !adjacentLesson(1);
}

function statusMeta(lesson, record) {
  if (!lesson.available) return { status: "upcoming", badge: "尚未开始", percent: 0 };
  const status = computeWatchStatus(record);
  if (status === "watched") return { status: "watched", badge: "已看完", percent: 100 };
  if (status === "watching") {
    const percent = Math.min(99, Math.max(1, Math.round((Number(record?.ratio) || 0) * 100)));
    return { status: "watching", badge: `看到 ${formatClock(record.time)} · ${percent}%`, percent };
  }
  return { status: "unwatched", badge: "未看", percent: 0 };
}

function renderPlaylist() {
  updateLessonNav();
  updateLessonHeading();
  const list = $("playlist-list");
  list.replaceChildren();
  const visible = lessons.filter((lesson) => {
    const status = computeWatchStatus(progressMap[lesson.liveId]);
    if (playlistFilter === "watched") return status === "watched";
    if (playlistFilter === "unwatched") return lesson.available && status !== "watched";
    return true;
  });
  if (!visible.length) {
    $("playlist-status").textContent = lessons.length ? "当前筛选条件下没有课次。" : "未获取到同课程目录。";
    $("playlist-status").hidden = false;
    return;
  }
  $("playlist-status").hidden = true;
  for (const lesson of visible) {
    const record = progressMap[lesson.liveId];
    const meta = statusMeta(lesson, record);
    const isCurrent = lesson.liveId === currentLiveId;
    const li = document.createElement("li");
    li.className = "playlist-item";
    li.dataset.liveId = lesson.liveId;
    li.dataset.status = meta.status;
    li.dataset.current = String(isCurrent);

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "lesson-select";
    selectBtn.disabled = switchingLesson || !lesson.available;
    if (isCurrent) selectBtn.setAttribute("aria-current", "true");

    const top = document.createElement("div");
    top.className = "lesson-top";
    const ord = document.createElement("span");
    ord.className = "lesson-index";
    ord.textContent = String(lesson.index).padStart(2, "0");
    const title = document.createElement("strong");
    title.className = "lesson-title";
    title.textContent = lesson.title;
    top.append(ord, title);
    if (isCurrent) {
      const nowTag = document.createElement("span");
      nowTag.className = "lesson-now";
      nowTag.textContent = "当前";
      top.append(nowTag);
    }

    const sub = document.createElement("div");
    sub.className = "lesson-meta";
    const schedule = [lesson.shortDate || lesson.date, lesson.timeRange].filter(Boolean).join(" ");
    const scheduleSpan = document.createElement("span");
    scheduleSpan.textContent = schedule || "录播回放";
    const stateSpan = document.createElement("span");
    stateSpan.className = `lesson-state state-${meta.status}`;
    stateSpan.textContent = meta.badge;
    sub.append(scheduleSpan, stateSpan);

    selectBtn.append(top, sub);
    if (meta.percent > 0 && lesson.available) {
      const bar = document.createElement("div");
      bar.className = "lesson-progress";
      const fill = document.createElement("span");
      fill.style.width = `${meta.percent}%`;
      bar.append(fill);
      selectBtn.append(bar);
    }
    selectBtn.addEventListener("click", () => {
      if (lesson.liveId === currentLiveId) {
        if (!engine?.wantPlaying) void engine?.play();
        return;
      }
      void switchLesson(lesson.liveId, { autoplay: true });
    });

    li.append(selectBtn);
    if (lesson.available) {
      const markBtn = document.createElement("button");
      markBtn.type = "button";
      markBtn.className = "lesson-mark";
      const isWatched = meta.status === "watched";
      markBtn.setAttribute("aria-pressed", String(isWatched));
      markBtn.title = isWatched ? "标记为未看" : "标记为已看";
      markBtn.innerHTML = isWatched
        ? '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.3 2.3 4.8-5"/></svg>'
        : '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>';
      markBtn.setAttribute("aria-label", `${lesson.title}${isWatched ? "，标记为未看" : "，标记为已看"}`);
      markBtn.addEventListener("click", () => { void toggleLessonWatched(lesson.liveId); });
      li.append(markBtn);
    }
    list.append(li);
  }
}

function scrollCurrentLessonIntoView() {
  const active = $("playlist-list").querySelector('[data-current="true"]');
  if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
}

function cancelCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  countdownTarget = null;
  countdownLeft = 0;
  $("next-countdown").hidden = true;
}

function startNextCountdown(nextLesson) {
  cancelCountdown();
  countdownTarget = nextLesson;
  countdownLeft = AUTO_NEXT_SECONDS;
  const renderCountdown = () => {
    $("next-countdown-text").textContent = `${countdownLeft} 秒后自动播放下一节：第 ${nextLesson.index} 讲 · ${nextLesson.title}`;
  };
  renderCountdown();
  $("next-countdown").hidden = false;
  countdownTimer = setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft <= 0) {
      const target = countdownTarget;
      cancelCountdown();
      if (target) void switchLesson(target.liveId, { autoplay: true });
    } else {
      renderCountdown();
    }
  }, 1000);
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
    if (result?.ok && result.record) {
      progressMap[currentLiveId] = result.record;
      if (lessons.length) renderPlaylist();
    }
  } catch { /* Ignore background disconnects on pagehide. */ }
}

async function toggleLessonWatched(liveId) {
  try {
    const result = await chrome.runtime.sendMessage({ type: "TOGGLE_WATCHED", liveId, courseKey });
    if (result?.ok && result.record) {
      progressMap[liveId] = result.record;
      renderPlaylist();
    }
  } catch { /* Ignore transient errors. */ }
}

function handlePlaybackEnded() {
  void persistProgress({ ended: true, force: true });
  const next = adjacentLesson(1);
  if (autoPlayNext && next) startNextCountdown(next);
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

function stateChanged(state) {
  const ready = !!state.range;
  for (const name of ["play", "back", "forward", "timeline"]) $(name).disabled = !ready;
  $("play").textContent = state.playing ? "暂停" : "播放";
  const status = state.buffering ? "缓冲中，等待两路画面" : !ready ? "等待两路视频就绪或时间重叠" : state.playing ? "两路同步播放中" : "两路已同步";
  const statusEl = $("sync-status");
  if (statusEl.textContent !== status) statusEl.textContent = status;
  statusEl.dataset.state = state.buffering ? "buffering" : !ready ? "idle" : state.playing ? "playing" : "ready";
  if (Number.isFinite(state.offset) && captionOffset !== state.offset) {
    captionOffset = state.offset;
    refreshCaptions();
  }
  transcript.setWindow(state.range, reviewClock === 1 ? captionOffset : 0);
  if (ready) {
    $("timeline").min = state.range.start;
    $("timeline").max = state.range.end;
    if (!editingTimeline) $("timeline").value = state.time;
    $("duration").textContent = formatClock(state.range.end);
    if (state.playing) {
      cancelCountdown();
      void persistProgress({ force: false });
    } else if (wasPlaying) {
      void persistProgress({ force: true });
    }
  } else { $("duration").textContent = "--:--"; }
  wasPlaying = !!state.playing;
  $("current").textContent = formatClock(editingTimeline ? Number($("timeline").value) : state.time);
  speedControl.set(state.rate);
  savedRate = state.rate;
  if (ready && pendingStart) {
    const start = pendingStart;
    pendingStart = null;
    applyPendingStart(start);
  }
}

function refreshFailureActions(reason) {
  const retry = { type: "button", label: reason === "login" ? "更新视频源" : "重试更新视频源", onClick: () => { void load({ refresh: true }); } };
  if (reason === "login") {
    return [
      { type: "link", label: "前往西电智课登录 ↗", href: LOGIN_PORTAL_URL },
      retry
    ];
  }
  if (reason === "network") return [retry];
  return [];
}

async function autoRefreshSources({ resumeTime = 0, shouldPlay = false, fallbackMessage = "" } = {}) {
  if (autoRefreshing || switchingLesson) return;
  autoRefreshing = true;
  $("refresh").disabled = true;
  message("视频链接可能已过期，正在自动续签视频源…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYER", id, refresh: true, auto: true });
    if (!result?.ok || !Array.isArray(result.media) || result.media.length < 2) {
      const err = new Error(result?.error || fallbackMessage);
      if (result?.reason) err.reason = result.reason;
      throw err;
    }
    if (result.currentLiveId) currentLiveId = result.currentLiveId;
    autoRefreshFailedFor = "";
    lastAutoRefreshSuccessAt = Date.now();
    populateSources(result.media, { keepSelection: true });
    loadPair({ preserve: true, resumeAt: resumeTime, autoplay: shouldPlay });
    message(shouldPlay ? "已自动续签视频源并恢复播放。" : "已自动续签视频源，点击“播放”继续。");
  } catch (error) {
    // Stop automatic retries for this lesson after one failed attempt; route guidance by actual cause.
    autoRefreshFailedFor = currentLiveId;
    const reason = error?.reason || "";
    const actions = refreshFailureActions(reason);
    message(error?.message || fallbackMessage || "自动续签视频源失败，请刷新原回放页面后重试。", { actions });
  } finally {
    autoRefreshing = false;
    $("refresh").disabled = false;
  }
}

function handleEngineError(errorText, detail) {
  const canAutoRefresh = detail?.kind === "media"
    && !!currentLiveId
    && !autoRefreshing
    && !switchingLesson
    && autoRefreshFailedFor !== currentLiveId
    && (Date.now() - lastAutoRefreshSuccessAt) >= AUTO_REFRESH_COOLDOWN_MS;
  if (canAutoRefresh) {
    void autoRefreshSources({
      resumeTime: engine?.time() || 0,
      shouldPlay: !!detail.wasPlaying,
      fallbackMessage: errorText
    });
    return;
  }
  message(errorText);
}

function loadPair({ preserve = false, resumeAt = 0, relativeToRange = false, autoplay = false } = {}) {
  const time = preserve ? (resumeAt || engine?.time() || 0) : resumeAt;
  const previousOffset = preserve ? engine?.offset : undefined;
  const rate = engine?.rate || savedRate;
  cancelCountdown();
  pendingStart = null;
  wasPlaying = false;
  lastSavedTime = -1;
  engine?.destroy();
  engine = null;
  const pair = [$("source-0").value, $("source-1").value].map((key) => media.find((item) => item.key === key));
  const valid = pair.every(Boolean) && pair[0].key !== pair[1].key;
  for (const name of ["swap-views", "toggle-review", "toggle-captions"]) $(name).disabled = !valid;
  pair.forEach((item, index) => {
    const name = item?.label || `画面 ${index + 1}`;
    $("screen-name-" + index).textContent = name;
    $("audio-name-" + index).textContent = name;
    $("review-source").options[index].textContent = name;
  });
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
  }
  message();
  videos.forEach((video, index) => {
    if (players[index]) players[index].url = pair[index].url;
    else players[index] = createLecturePlayer(video, pair[index].url, { hotkey: false });
    video.load();
  });
  engine = new SyncPlayer(videos, { onState: stateChanged, onError: handleEngineError, onEnded: handlePlaybackEnded });
  const offset = previousOffset ?? recordingOffset(pair[0].url, pair[1].url);
  $("offset").value = offset;
  engine.setOffset(offset);
  engine.setAudio(savedAudio);
  engine.setRate(rate);
  subtitles.forEach(control => control.ensureCourse());
  selectReview(openedReview ? reviewIndex : primary);
  if (time > 0 || autoplay) {
    const start = { generation: engine, time, relativeToRange, autoplay };
    if (engine.range()) applyPendingStart(start);
    else pendingStart = start;
  }
}

function populateSources(nextMedia, { keepSelection = false } = {}) {
  const previous = [$("source-0").value, $("source-1").value];
  media = nextMedia;
  for (let index = 0; index < 2; index++) {
    const select = $("source-" + index);
    select.replaceChildren(...media.map((item) => {
      const option = document.createElement("option"); option.value = item.key; option.textContent = item.label; return option;
    }));
    select.value = keepSelection && media.some((item) => item.key === previous[index]) ? previous[index] : media[index].key;
  }
  return previous.every((key, index) => key === $("source-" + index).value);
}

async function switchLesson(targetLiveId, { autoplay = true } = {}) {
  if (switchingLesson || !targetLiveId) return;
  cancelCountdown();
  await persistProgress({ force: true });
  switchingLesson = true;
  updateLessonNav();
  renderPlaylist();
  const target = lessons.find((item) => item.liveId === targetLiveId);
  message(`正在加载${target ? `第 ${target.index} 讲 · ${target.title}` : "新课次"}…`);
  try {
    const result = await chrome.runtime.sendMessage({ type: "LOAD_LESSON", id, liveId: targetLiveId });
    if (!result?.ok) throw new Error(result?.error || "切换课次失败，请重试。");
    if (!Array.isArray(result.media) || result.media.length < 2) throw new Error("该课次缺少双路视频源，无法同步播放。");
    currentLiveId = result.currentLiveId || targetLiveId;
    autoRefreshFailedFor = "";
    lastAutoRefreshSuccessAt = 0;
    initialResumeApplied = true;
    populateSources(result.media, { keepSelection: false });
    const resumeAt = resumeTimeFor(progressMap[currentLiveId]);
    loadPair({ preserve: false, resumeAt, relativeToRange: true, autoplay });
    updateLessonHeading(result.lessonTitle || "");
    if (resumeAt > 0) message(`已恢复到上次观看位置 ${formatClock(resumeAt)}`);
  } catch (error) {
    message(error.message || "切换课次失败，请重试。");
  } finally {
    switchingLesson = false;
    renderPlaylist();
    scrollCurrentLessonIntoView();
  }
}

async function loadPlaylist({ showErrors = false } = {}) {
  $("refresh-playlist").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYLIST", id });
    if (!result?.ok) {
      if (showErrors) {
        $("playlist-status").textContent = result?.error || "获取课程目录失败。";
        $("playlist-status").hidden = false;
      }
      return;
    }
    progressMap = result.progress || {};
    if (typeof result.prefs?.autoPlayNext === "boolean") {
      autoPlayNext = result.prefs.autoPlayNext;
      $("auto-next").checked = autoPlayNext;
    }
    if (!result.supported || !Array.isArray(result.lessons) || !result.lessons.length) {
      lessons = [];
      updateLessonNav();
      return;
    }
    courseKey = result.courseKey || "";
    lessons = result.lessons;
    if (result.currentLiveId && !currentLiveId) currentLiveId = result.currentLiveId;
    if (result.courseTitle) {
      $("course-title").textContent = result.courseTitle;
      document.title = `${result.courseTitle} · 专注看课`;
    }
    renderPlaylist();
    if (!initialResumeApplied && currentLiveId && engine && !engine.wantPlaying && engine.time() < 2) {
      const record = progressMap[currentLiveId];
      const range = engine.range();
      if (resumeTimeFor(record, range ? range.end - range.start : 0) > 0) {
        const start = { generation: engine, fromResume: true, record };
        if (range) applyPendingStart(start);
        else if (!pendingStart) pendingStart = start;
      }
    }
  } catch (error) {
    if (showErrors) {
      $("playlist-status").textContent = error.message || "获取课程目录失败。";
      $("playlist-status").hidden = false;
    }
  } finally {
    $("refresh-playlist").disabled = false;
  }
}

async function load({ refresh = false } = {}) {
  $("refresh").disabled = true;
  if (refresh) autoRefreshFailedFor = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYER", id, refresh });
    if (!result?.ok) throw new Error(result?.error || "无法读取课程，请从扩展面板重新打开同步播放。");
    if (result.media.length < 2) throw new Error("至少需要两路视频。请回到原回放页面，播放两路画面并重新识别。");
    if (result.currentLiveId) currentLiveId = result.currentLiveId;
    const samePair = populateSources(result.media, { keepSelection: true });
    $("course-title").textContent = result.courseTitle;
    document.title = `${result.courseTitle} · 专注看课`;
    updateLessonHeading(result.lessonTitle || "");
    loadPair({ preserve: refresh && samePair });
    if (refresh) message(result.notice || "已更新视频源，请点击“播放”继续。若仍无法播放，请先刷新原回放页面并重新识别。");
    if (!refresh) void loadPlaylist();
  } catch (error) { if (!media.length) $("course-title").textContent = "课程回放"; message(error.message); }
  finally { $("refresh").disabled = false; }
}

$("play").addEventListener("click", togglePlayback);
$("prev-lesson").addEventListener("click", () => { const prev = adjacentLesson(-1); if (prev) void switchLesson(prev.liveId, { autoplay: true }); });
$("next-lesson").addEventListener("click", () => { const next = adjacentLesson(1); if (next) void switchLesson(next.liveId, { autoplay: true }); });
$("play-next-now").addEventListener("click", () => {
  const target = countdownTarget || adjacentLesson(1);
  cancelCountdown();
  if (target) void switchLesson(target.liveId, { autoplay: true });
});
$("cancel-next").addEventListener("click", cancelCountdown);
$("auto-next").addEventListener("change", () => {
  autoPlayNext = $("auto-next").checked;
  if (!autoPlayNext) cancelCountdown();
  void chrome.runtime.sendMessage({ type: "SET_PLAYER_PREFS", autoPlayNext }).catch(() => {});
});
$("back").addEventListener("click", () => { cancelCountdown(); engine?.seek(engine.time() - 10); });
$("forward").addEventListener("click", () => { cancelCountdown(); engine?.seek(engine.time() + 10); });
$("timeline").addEventListener("input", () => { editingTimeline = true; $("current").textContent = formatClock(Number($("timeline").value)); });
$("timeline").addEventListener("change", () => { editingTimeline = false; cancelCountdown(); engine?.seek(Number($("timeline").value)); });
$("timeline").addEventListener("blur", () => { if (editingTimeline) { editingTimeline = false; engine?.seek(Number($("timeline").value)); } });
$("offset").addEventListener("change", () => { if ($("offset").checkValidity()) engine?.setOffset(Number($("offset").value)); });
document.querySelectorAll('input[name="audio"]').forEach((radio) => radio.addEventListener("change", () => { savedAudio = Number(radio.value); engine?.setAudio(savedAudio); }));
for (let index = 0; index < 2; index++) $("source-" + index).addEventListener("change", () => loadPair());
$("refresh").addEventListener("click", () => { void load({ refresh: true }); });
$("swap-views").addEventListener("click", () => setPrimary(1 - primary));
$("toggle-playlist").addEventListener("click", () => showPlaylist($("playlist-panel").hidden));
$("close-playlist").addEventListener("click", () => showPlaylist(false));
document.querySelectorAll(".side-tab-review").forEach((button) => button.addEventListener("click", () => showReview(true)));
document.querySelectorAll(".side-tab-playlist").forEach((button) => button.addEventListener("click", () => showPlaylist(true)));
$("refresh-playlist").addEventListener("click", () => { void loadPlaylist({ showErrors: true }); });
$("playlist-filter").addEventListener("change", () => { playlistFilter = $("playlist-filter").value; renderPlaylist(); });
$("playlist-locate").addEventListener("click", () => {
  if (playlistFilter !== "all") { playlistFilter = "all"; $("playlist-filter").value = "all"; renderPlaylist(); }
  scrollCurrentLessonIntoView();
});
$("toggle-review").addEventListener("click", () => showReview($("review").hidden));
$("toggle-captions").addEventListener("click", () => {
  captionsEnabled = !captionsEnabled;
  refreshCaptions();
});
$("close-review").addEventListener("click", () => showReview(false));
$("review-source").addEventListener("change", () => selectReview(Number($("review-source").value)));

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  if (target.matches("textarea, select")) return true;
  return target.matches("input") && target.id !== "timeline";
}

function togglePlayback() {
  if (!engine?.range()) return;
  cancelCountdown();
  message();
  if (engine.wantPlaying) engine.pause();
  else void engine.play();
}

document.addEventListener("keydown", (event) => {
  if (!engine?.range() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (isEditableTarget(target)) return;
  if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
    event.preventDefault();
    cancelCountdown();
    const step = event.shiftKey ? 10 : 5;
    engine.seek(engine.time() + (event.code === "ArrowRight" ? step : -step));
    return;
  }
  if (event.code === "Space") {
    if (target instanceof Element && target.matches("a, summary, button:not(#play):not(#back):not(#forward)")) return;
    event.preventDefault();
    togglePlayback();
    return;
  }
  if ((event.code === "ArrowUp" || event.code === "ArrowDown") && engine.audio >= 0) {
    if (target instanceof Element && target.matches("button, a, summary")) return;
    event.preventDefault();
    const active = videos[engine.audio];
    active.volume = Math.max(0, Math.min(1, Math.round((active.volume + (event.code === "ArrowUp" ? .1 : -.1)) * 10) / 10));
  }
});

document.addEventListener("fullscreenchange", () => {
  if (!engine) return;
  engine.resumeIfReady();
  if (!document.fullscreenElement && engine.wantPlaying) engine.tick();
});

window.addEventListener("pagehide", () => {
  cancelCountdown();
  void persistProgress({ force: true });
  engine?.destroy();
  changingSources = true;
  subtitles.forEach((control) => control.setSource(""));
  updateCaptionPair(0, false);
  transcript.setTrack(null);
  players.forEach((player) => player.destroy());
});
void load();
