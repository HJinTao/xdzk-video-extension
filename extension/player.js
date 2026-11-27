import { SyncPlayer, recordingOffset } from "./lib/sync-player.js";
import { bindSubtitles } from "./lib/subtitles.js";
import { bindPairedSubtitles } from "./lib/paired-subtitles.js";
import { createLecturePlayer } from "./lib/lecture-player.js";
import { bindPlaybackSpeed } from "./lib/playback-speed.js";
import { bindTranscript } from "./lib/transcript.js";
import { formatClock } from "./lib/media.js";

const $ = (id) => document.getElementById(id);
const videos = [$("video-0"), $("video-1")];
const id = new URL(location.href).searchParams.get("id");
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
const players = [];
const speedControl = bindPlaybackSpeed($("speed-control"), (value) => { savedRate = value; engine?.setRate(value); });
const transcript = bindTranscript($("review"), (seconds) => {
  if (engine?.range()) engine.seek(seconds - (reviewClock === 1 ? engine.offset : 0));
});
const subtitles = videos.map((video, index) => bindSubtitles($("subtitles-" + index), video, async (key) => {
  const result = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", id, key });
  if (!result?.ok) throw new Error(result?.error || "读取课程字幕失败，请重试。");
  return result;
}, refreshCaptions));
const updateCaptionPair = bindPairedSubtitles(videos, subtitles);
document.querySelectorAll('.subtitle-mode option[value="off"]').forEach(option => { option.textContent = "跟随另一路"; });

function message(text = "") { $("message").textContent = text; $("message").hidden = !text; }

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

function showReview(open) {
  $("review").hidden = !open;
  document.querySelector(".study-layout").classList.toggle("review-open", open);
  $("toggle-review").setAttribute("aria-expanded", String(open));
  if (open) {
    selectReview(openedReview ? reviewIndex : primary);
    openedReview = true;
    $("review-source").focus();
    transcript.followCurrent();
  } else {
    $("toggle-review").focus();
  }
}

function stateChanged(state) {
  const ready = !!state.range;
  for (const name of ["play", "back", "forward", "timeline"]) $(name).disabled = !ready;
  $("play").textContent = state.playing ? "暂停" : "播放";
  const status = state.buffering ? "缓冲中，等待两路画面" : !ready ? "等待两路视频就绪或时间重叠" : state.playing ? "两路同步播放中" : "两路已同步";
  if ($("sync-status").textContent !== status) $("sync-status").textContent = status;
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
  } else { $("duration").textContent = "--:--"; }
  $("current").textContent = formatClock(editingTimeline ? Number($("timeline").value) : state.time);
  speedControl.set(state.rate);
  savedRate = state.rate;
}

function loadPair({ preserve = false } = {}) {
  const time = preserve ? engine?.time() || 0 : 0;
  const previousOffset = preserve ? engine?.offset : undefined;
  const rate = engine?.rate || savedRate;
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
  engine = new SyncPlayer(videos, { onState: stateChanged, onError: message });
  const offset = previousOffset ?? recordingOffset(pair[0].url, pair[1].url);
  $("offset").value = offset;
  engine.setOffset(offset);
  engine.setAudio(savedAudio);
  engine.setRate(rate);
  subtitles.forEach(control => control.ensureCourse());
  selectReview(openedReview ? reviewIndex : primary);
  if (preserve) {
    const generation = engine;
    videos[0].addEventListener("loadedmetadata", () => { if (engine === generation) engine.seek(time); }, { once: true });
  }
}

async function load({ refresh = false } = {}) {
  $("refresh").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_PLAYER", id, refresh });
    if (!result?.ok) throw new Error(result?.error || "无法读取课程，请从扩展面板重新打开同步播放。");
    if (result.media.length < 2) throw new Error("至少需要两路视频。请回到原回放页面，播放两路画面并重新识别。");
    const previous = [$("source-0").value, $("source-1").value];
    media = result.media;
    $("course-title").textContent = result.courseTitle;
    document.title = `${result.courseTitle} · 专注看课`;
    for (let index = 0; index < 2; index++) {
      const select = $("source-" + index);
      select.replaceChildren(...media.map((item) => {
        const option = document.createElement("option"); option.value = item.key; option.textContent = item.label; return option;
      }));
      select.value = media.some((item) => item.key === previous[index]) ? previous[index] : media[index].key;
    }
    const samePair = previous.every((key, index) => key === $("source-" + index).value);
    loadPair({ preserve: refresh && samePair });
    if (refresh) message(result.notice || "已更新视频源，请点击“播放”继续。若仍无法播放，请先刷新原回放页面并重新识别。");
  } catch (error) { if (!media.length) $("course-title").textContent = "课程回放"; message(error.message); }
  finally { $("refresh").disabled = false; }
}

$("play").addEventListener("click", togglePlayback);
$("back").addEventListener("click", () => engine?.seek(engine.time() - 10));
$("forward").addEventListener("click", () => engine?.seek(engine.time() + 10));
$("timeline").addEventListener("input", () => { editingTimeline = true; $("current").textContent = formatClock(Number($("timeline").value)); });
$("timeline").addEventListener("change", () => { editingTimeline = false; engine?.seek(Number($("timeline").value)); });
$("timeline").addEventListener("blur", () => { if (editingTimeline) { editingTimeline = false; engine?.seek(Number($("timeline").value)); } });
$("offset").addEventListener("change", () => { if ($("offset").checkValidity()) engine?.setOffset(Number($("offset").value)); });
document.querySelectorAll('input[name="audio"]').forEach((radio) => radio.addEventListener("change", () => { savedAudio = Number(radio.value); engine?.setAudio(savedAudio); }));
for (let index = 0; index < 2; index++) $("source-" + index).addEventListener("change", () => loadPair());
$("refresh").addEventListener("click", () => { void load({ refresh: true }); });
$("swap-views").addEventListener("click", () => setPrimary(1 - primary));
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
  engine?.destroy();
  changingSources = true;
  subtitles.forEach((control) => control.setSource(""));
  updateCaptionPair(0, false);
  transcript.setTrack(null);
  players.forEach((player) => player.destroy());
});
void load();
