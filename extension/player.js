import { SyncPlayer, recordingOffset } from "./lib/sync-player.js";
import { bindSubtitles } from "./lib/subtitles.js";
import { createLecturePlayer } from "./lib/lecture-player.js";
import { bindPlaybackSpeed } from "./lib/playback-speed.js";

const $ = (id) => document.getElementById(id);
const videos = [$("video-0"), $("video-1")];
const id = new URL(location.href).searchParams.get("id");
const subtitles = videos.map((video, index) => bindSubtitles($("subtitles-" + index), video, async (key) => {
  const result = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", id, key });
  if (!result?.ok) throw new Error(result?.error || "读取课程字幕失败，请重试。");
  return result;
}));
let engine;
let media = [];
let editingTimeline = false;
let savedAudio = 0;
let savedRate = 1;
const players = [];
const speedControl = bindPlaybackSpeed($("speed-control"), (value) => { savedRate = value; engine?.setRate(value); });

function message(text = "") { $("message").textContent = text; $("message").hidden = !text; }
function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return total >= 3600 ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}` : `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function stateChanged(state) {
  const ready = !!state.range;
  for (const name of ["play", "back", "forward", "timeline"]) $(name).disabled = !ready;
  $("play").textContent = state.playing ? "暂停" : "播放";
  $("sync-status").textContent = state.buffering ? "缓冲中，等待两路画面" : !ready ? "等待两路视频就绪 / 检查时间重叠" : state.playing ? "两路同步播放中" : "两路已同步";
  if (ready) {
    $("timeline").min = state.range.start;
    $("timeline").max = state.range.end;
    if (!editingTimeline) $("timeline").value = state.time;
    $("duration").textContent = clock(state.range.end);
  }
  $("current").textContent = clock(editingTimeline ? Number($("timeline").value) : state.time);
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
  subtitles.forEach((control, index) => control.setSource(valid ? pair[index].key : ""));
  if (!valid) { engine = null; players.forEach((player) => player.reset()); stateChanged({ time: 0, range: null, playing: false, rate: savedRate }); message("请选择两路不同的画面。"); return; }
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
    document.title = `${result.courseTitle} · 双路同步播放`;
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
  } catch (error) { message(error.message); }
  finally { $("refresh").disabled = false; }
}

$("play").addEventListener("click", () => { if (!engine) return; message(); if (engine.wantPlaying) engine.pause(); else void engine.play(); });
$("back").addEventListener("click", () => engine?.seek(engine.time() - 10));
$("forward").addEventListener("click", () => engine?.seek(engine.time() + 10));
$("timeline").addEventListener("input", () => { editingTimeline = true; $("current").textContent = clock(Number($("timeline").value)); });
$("timeline").addEventListener("change", () => { editingTimeline = false; engine?.seek(Number($("timeline").value)); });
$("timeline").addEventListener("blur", () => { if (editingTimeline) { editingTimeline = false; engine?.seek(Number($("timeline").value)); } });
$("offset").addEventListener("change", () => { if ($("offset").checkValidity()) engine?.setOffset(Number($("offset").value)); });
document.querySelectorAll('input[name="audio"]').forEach((radio) => radio.addEventListener("change", () => { savedAudio = Number(radio.value); engine?.setAudio(savedAudio); }));
for (let index = 0; index < 2; index++) $("source-" + index).addEventListener("change", () => loadPair());
$("refresh").addEventListener("click", () => { void load({ refresh: true }); });
window.addEventListener("pagehide", () => { engine?.destroy(); players.forEach((player) => player.destroy()); });
void load();
