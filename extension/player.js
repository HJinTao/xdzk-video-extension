import { SyncPlayer, recordingOffset } from "./lib/sync-player.js";
import { bindSubtitles } from "./lib/subtitles.js";
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
let openedReview = false;
let editingTimeline = false;
let savedAudio = 0;
let savedRate = 1;
const players = [];
const speedControl = bindPlaybackSpeed($("speed-control"), (value) => { savedRate = value; engine?.setRate(value); });
const transcript = bindTranscript($("review"), (seconds) => {
  if (engine?.range()) engine.seek(seconds - (reviewIndex === 1 ? engine.offset : 0));
});
const subtitles = videos.map((video, index) => bindSubtitles($("subtitles-" + index), video, async (key) => {
  const result = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", id, key });
  if (!result?.ok) throw new Error(result?.error || "读取课程字幕失败，请重试。");
  return result;
}, (track) => {
  if (index === reviewIndex) transcript.setTrack(track);
  const showing = subtitles.some((control) => control.track?.mode === "showing");
  $("toggle-captions").setAttribute("aria-pressed", String(showing));
  $("caption-state").textContent = showing ? "开" : "关";
}));

function message(text = "") { $("message").textContent = text; $("message").hidden = !text; }

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
  transcript.setWindow(engine?.range(), index === 1 ? engine?.offset : 0);
  transcript.setTrack(subtitles[index].track);
  if (!$("review").hidden) subtitles[index].ensureCourse();
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
  transcript.setWindow(state.range, reviewIndex === 1 ? state.offset : 0);
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
  const pair = [$("source-0").value, $("source-1").value].map((key) => media.find((item) => item.key === key));
  const valid = pair.every(Boolean) && pair[0].key !== pair[1].key;
  for (const name of ["swap-views", "toggle-review", "toggle-captions"]) $(name).disabled = !valid;
  pair.forEach((item, index) => {
    const name = item?.label || `画面 ${index + 1}`;
    $("screen-name-" + index).textContent = name;
    $("audio-name-" + index).textContent = name;
    $("review-source").options[index].textContent = name;
  });
  subtitles.forEach((control, index) => control.setSource(valid ? pair[index].key : ""));
  if (!valid) {
    engine = null;
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
    else players[index] = createLecturePlayer(video, pair[index].url);
    video.load();
  });
  engine = new SyncPlayer(videos, { onState: stateChanged, onError: message });
  const offset = previousOffset ?? recordingOffset(pair[0].url, pair[1].url);
  $("offset").value = offset;
  engine.setOffset(offset);
  engine.setAudio(savedAudio);
  engine.setRate(rate);
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

$("play").addEventListener("click", () => { if (!engine) return; message(); if (engine.wantPlaying) engine.pause(); else void engine.play(); });
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
  const visible = $("toggle-captions").getAttribute("aria-pressed") !== "true";
  subtitles.forEach((control) => control.setDisplay(visible));
  if (visible && !subtitles.some((control) => control.track)) showReview(true);
});
$("close-review").addEventListener("click", () => showReview(false));
$("review-source").addEventListener("change", () => selectReview(Number($("review-source").value)));
window.addEventListener("pagehide", () => {
  engine?.destroy();
  subtitles.forEach((control) => control.setSource(""));
  players.forEach((player) => player.destroy());
});
void load();
