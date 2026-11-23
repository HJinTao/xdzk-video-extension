import { phoneLesson, readPhoneLink } from "./lib/phone-lesson.js";
import { replayBookmark } from "./lib/replay-bookmark.js";
import { webPlayback } from "./lib/web-playback.js";
import { cameraPath, renderWatchList, replayAddress, trackWatching } from "./lib/watch-history.js";
import { createLecturePlayer } from "./lib/lecture-player.js";
import { bindPlaybackSpeed } from "./lib/playback-speed.js";
import { bindSubtitles } from "./lib/subtitles.js";

const $ = id => document.getElementById(id);
const service = webPlayback(window);
const home = new URL("mobile.html", location.href);
const native = location.hostname === "appassets.androidplatform.net" || location.protocol === "xdzk-app:";
let active;
function status(text) { $("status").textContent = text; $("status").hidden = !text; }

async function historyList() {
  try {
    const entries = await service.history.list();
    renderWatchList($("watch-list"), entries, async id => { await service.history.remove(id); await historyList(); }, entry => {
      const here = active?.media.some(item => entry.positions.some(p => p.path === cameraPath(item.url)));
      const replay = replayAddress(entry.replay);
      if (!here && !replay) return null;
      const link = document.createElement("a");
      link.href = here && !(native && replay) ? (active.media.length === 2 ? "player.html?mobile=1" : "mobile.html?single=0") : replay;
      link.textContent = here || native ? "继续观看" : "校方回放";
      return link;
    });
  } catch { $("watch-list").textContent = "当前浏览器无法保存观看记录。"; }
}

async function start(lesson) {
  service.setLesson(lesson);
  location.replace(lesson.media.length === 2 ? "player.html?mobile=1" : "mobile.html?single=0");
}

function currentLesson(lesson, inPlayer) {
  $("current-lesson").hidden = false;
  $("current-title").textContent = inPlayer ? "画面选择" : lesson.courseTitle;
  const links = $("camera-links");
  if (!inPlayer || lesson.media.length === 2) {
    const play = document.createElement("a");
    play.href = lesson.media.length === 2 ? "player.html?mobile=1" : "mobile.html?single=0";
    play.textContent = lesson.media.length === 2 ? "双路同步观看" : "继续观看";
    links.append(play);
  }
  const replay = lesson.media.map(item => replayAddress(item.frameUrl)).find(Boolean) || replayAddress(lesson.replay);
  if (replay) {
    const refresh = document.createElement("a");
    refresh.href = replay; refresh.textContent = "重新打开学校回放";
    links.append(refresh);
  }
  for (const item of lesson.media) {
    const original = document.createElement("a");
    original.href = item.url; original.rel = "noopener noreferrer"; original.target = "_blank";
    original.textContent = item.label + "原片";
    links.append(original);
  }
}

function single(lesson, index) {
  const item = lesson.media[index] || lesson.media[0], video = $("single-video");
  $("single").hidden = false;
  $("single-title").textContent = lesson.courseTitle;
  document.title = lesson.courseTitle + " · 手机看课";
  video.addEventListener("loadedmetadata", () => { if (item.resumeAt > 0) video.currentTime = Math.min(video.duration, item.resumeAt); }, { once: true });
  video.addEventListener("error", () => status("视频暂时无法加载。请确认手机能访问学校视频网络，或重新获取本节的播放链接。"));
  const player = createLecturePlayer(video, item.url);
  const speed = bindPlaybackSpeed($("single-speed"), rate => { video.playbackRate = rate; });
  video.addEventListener("ratechange", () => speed.set(video.playbackRate));
  const captions = bindSubtitles($("single-captions"), video, async () => { throw new Error("请从手机导入 SRT 或 VTT 字幕文件。"); });
  captions.setSource(item.key);
  const watch = trackWatching(video, at => {
    void service.progress([{ key: item.key, time: video.currentTime, duration: video.duration }], at).then(historyList).catch(() => status("浏览器未能保存这次观看进度。"));
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) watch.flush(); });
  window.addEventListener("pagehide", event => { watch.flush(); if (!event.persisted) { captions.setSource(""); player.destroy(); } });
}

$("import-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const urls = $("links").value.trim().split(/\s+/).filter(Boolean);
    let lesson;
    if (urls.length === 1) {
      try { lesson = readPhoneLink(new URL(urls[0]).hash); }
      catch (error) { throw new Error(error instanceof TypeError ? "请粘贴完整的播放链接或学校 MP4 地址。" : error.message); }
    }
    await start(lesson || phoneLesson({ courseTitle: $("title").value, media: urls.map(url => ({ url })) }));
  } catch (error) { status(error.message); }
});
$("bookmark").value = replayBookmark(home.href);
$("copy-bookmark").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("bookmark").value); status("已复制，可粘贴到书签的网址中。"); }
  catch { $("bookmark").focus(); $("bookmark").select(); status("已选中书签代码，请长按复制。"); }
});

async function init() {
  const hash = location.hash;
  if (hash) history.replaceState(null, "", location.pathname + location.search);
  try {
    const lesson = readPhoneLink(hash);
    if (lesson) { await start(lesson); return; }
    try { active = await service.lesson(); } catch { /* A new tab can import a lesson. */ }
    const index = new URL(location.href).searchParams.get("single");
    if (active) currentLesson(active, index !== null);
    if (index !== null && active) single(active, Number(index));
  } catch (error) { status(error.message); }
  await historyList();
}
if (native) {
  $("browser-import").hidden = true;
  $("app-course").hidden = false;
  $("course-form").addEventListener("submit", event => {
    event.preventDefault();
    const course = $("course-link").value.trim();
    if (replayAddress(course)) location.assign(course);
    else status("请粘贴包含课次的西电智课回放页面网址。");
  });
}
void init();
