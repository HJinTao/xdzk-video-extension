import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { SyncPlayer, recordingOffset } from "../extension/lib/sync-player.js";
import { mediaKey, formatClock } from "../extension/lib/media.js";
import { bindSubtitles } from "../extension/lib/subtitles.js";
import { bindPairedSubtitles } from "../extension/lib/paired-subtitles.js";
import { bindPlaybackSpeed } from "../extension/lib/playback-speed.js";
import { bindTranscript } from "../extension/lib/transcript.js";
import { computeWatchStatus, resumeTimeFor } from "../extension/lib/watch-progress.js";
import { buildAudioPref, mergePlayerPrefs, normalizePlayerPrefs, resolveAudioPref, resolveOffsetPref } from "../extension/lib/player-prefs.js";
import { bindPlaylistPanel } from "../extension/lib/playlist-panel.js";
import { bindPlayerShortcuts } from "../extension/lib/player-shortcuts.js";
import { canTriggerAutoRefresh, refreshFailureActions, renderMessageBar } from "../extension/lib/source-recovery.js";
import { enhanceSelect, enhanceSegmentedSelect } from "../extension/lib/custom-select.js";
import { snapshot, mediaUrl, createPlayerStub } from "./fixtures.mjs";

const html = await readFile(new URL("../extension/player.html", import.meta.url), "utf8");
const code = (await readFile(new URL("../extension/player.js", import.meta.url), "utf8")).replace(/^import .+;\r?$/gm, "");
const flush = () => new Promise((done) => setTimeout(done, 15));
async function page({ labels = ["画面 1", "画面 2"], captionResult = () => ({ ok: false, error: "本次回放没有可用的课程字幕" }), playlistResult, onMessage, prepareMedia } = {}) {
  const dom = new JSDOM(html, { url: "https://extension.test/player.html?id=demo", runScripts: "outside-only" });
  Object.assign(dom.window, { SyncPlayer, recordingOffset, bindSubtitles, bindPairedSubtitles, bindPlaybackSpeed, bindTranscript, formatClock, computeWatchStatus, resumeTimeFor, buildAudioPref, mergePlayerPrefs, normalizePlayerPrefs, resolveAudioPref, resolveOffsetPref, bindPlaylistPanel, bindPlayerShortcuts, canTriggerAutoRefresh, refreshFailureActions, renderMessageBar, enhanceSelect, enhanceSegmentedSelect, createLecturePlayer: createPlayerStub });
  let stamp = 1700000000;
  const captionRequests = [];
  dom.window.chrome = { runtime: { async sendMessage(message) {
    if (onMessage) {
      const custom = await onMessage(message);
      if (custom !== undefined) return custom;
    }
    if (message.type === "GET_SUBTITLES") { captionRequests.push(message.key); return captionResult(message.key); }
    if (message.type === "GET_PLAYLIST") {
      return playlistResult ? structuredClone(playlistResult) : { ok: true, supported: false, lessons: [], progress: {}, prefs: { autoPlayNext: true } };
    }
    if (message.type === "SAVE_PROGRESS") return { ok: true, record: { liveId: message.liveId, time: message.time, duration: message.duration, ratio: message.ended ? 1 : (message.duration ? message.time / message.duration : 0), status: message.ended ? "watched" : "watching" } };
    if (message.type === "SET_PLAYER_PREFS") return { ok: true, prefs: { autoPlayNext: message.autoPlayNext } };
    return { ok: true, courseTitle: "数据库系统", media: snapshot.media.map((item, index) => ({ ...item, key: mediaKey(item.url), label: labels[index], url: mediaUrl(index ? "CloudIPC-demo-b" : "CloudIPC-demo-a", stamp) })) };
  } } };
  dom.window.HTMLMediaElement.prototype.load = function() { this.currentTime = 0; queueMicrotask(() => this.dispatchEvent(new dom.window.Event("loadedmetadata"))); };
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  const videos = [...dom.window.document.querySelectorAll("video")];
  videos.forEach((video) => {
    Object.defineProperty(video, "duration", { configurable: true, get: () => 120 });
    Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
  });
  prepareMedia?.(dom.window);
  dom.window.eval(code);
  await flush();
  return { dom, document: dom.window.document, videos, captionRequests, refreshSignature() { stamp += 300; } };
}
function close(dom) { dom.window.dispatchEvent(new dom.window.Event("pagehide")); dom.window.close(); }

test("player page supports timeline, either-video seek and audio selection", async () => {
  const { dom, document, videos } = await page();
  const change = (node) => node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  try {
    assert.equal(document.querySelector("#play").disabled, false);
    document.querySelector("#timeline").value = 35; change(document.querySelector("#timeline"));
    assert.deepEqual(videos.map((video) => video.currentTime), [35, 35]);
    videos[1].currentTime = 70; videos[1].dispatchEvent(new dom.window.Event("seeking"));
    assert.equal(videos[0].currentTime, 70);
    const audio = document.querySelector('input[name="audio"][value="1"]'); audio.checked = true; change(audio);
    assert.deepEqual(videos.map((video) => video.muted), [true, false]);
    const offset = document.querySelector("#offset"); offset.value = -3; change(offset);
    assert.deepEqual(videos.map((video) => video.currentTime), [70, 67]);
  } finally { close(dom); }
});

test("refreshing signed sources preserves manual offset, playback speed and position", async () => {
  const fixture = await page();
  const { dom, document, videos } = fixture;
  const change = (node) => node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  try {
    const timeline = document.querySelector("#timeline"); timeline.value = 35; change(timeline);
    const offset = document.querySelector("#offset"); offset.value = -3; change(offset);
    const rate = document.querySelector("#rate"); rate.value = "1.5"; change(rate);
    fixture.refreshSignature();
    document.querySelector("#refresh").click(); await flush();
    assert.match(videos[0].src, /1700000300/);
    assert.equal(offset.value, "-3");
    assert.deepEqual(videos.map((video) => video.currentTime), [35, 32]);
    assert.deepEqual(videos.map((video) => video.playbackRate), [1.5, 1.5]);
  } finally { close(dom); }
});

test("selecting the same source twice disables playback with a useful message", async () => {
  const { dom, document } = await page();
  try {
    const second = document.querySelector("#source-1");
    second.value = document.querySelector("#source-0").value;
    second.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(document.querySelector("#play").disabled, true);
    assert.match(document.querySelector("#message").textContent, /两路不同/);
  } finally { close(dom); }
});

test("both cameras follow extended presets, custom rates and 0.1 steps without overwriting the user's input", async () => {
  const { dom, videos, document } = await page();
  const select = document.querySelector("#rate");
  const input = document.querySelector("#speed-control input");
  const [slower, faster] = document.querySelectorAll("#speed-control button");
  const change = (element) => element.dispatchEvent(new dom.window.Event("change"));
  try {
    for (const rate of [2.5, 3, 1]) {
      select.value = rate; change(select);
      assert.deepEqual(videos.map((v) => v.playbackRate), [rate, rate]);
    }
    faster.click(); assert.deepEqual(videos.map((v) => v.playbackRate), [1.1, 1.1]);
    input.value = "1.37"; change(input);
    slower.click(); assert.equal(select.value, "1.27");
    assert.deepEqual(videos.map((v) => v.playbackRate), [1.27, 1.27]);
    input.value = "8"; change(input); assert.equal(videos[0].playbackRate, 1.27);
    input.value = "4"; change(input); assert.equal(faster.disabled, true);
  } finally { close(dom); }
});

test("the labelled slide opens large and swapping views preserves both streams, sound, speed and time", async (t) => {
  const { dom, document, videos, captionRequests } = await page({ labels: ["教室", "课件"] });
  t.after(() => close(dom));
  const get = (id) => document.getElementById(id);
  const change = (element) => element.dispatchEvent(new dom.window.Event("change"));
  const sources = videos.map(v => v.src);
  assert.equal(document.querySelector(".screens").dataset.primary, "1");
  assert.equal(get("review").hidden, true);
  get("rate").value = "2.5"; change(get("rate"));
  get("timeline").value = "31"; change(get("timeline"));
  get("swap-views").click();
  assert.equal(get("screen-role-0").textContent, "主画面");
  assert.deepEqual(videos.map(v => v.src), sources);
  assert.deepEqual(videos.map(v => v.currentTime), [31, 31]);
  assert.deepEqual(videos.map(v => v.playbackRate), [2.5, 2.5]);
  assert.deepEqual(videos.map(v => v.muted), [false, true]);
  assert.deepEqual(captionRequests, sources.map(mediaKey));
  get("toggle-review").click();
  await flush();
  assert.equal(get("review-source").value, "0");
  assert.match(get("subtitles-0").textContent, /没有可用/);
  get("close-review").click();
  assert.equal(document.activeElement, get("toggle-review"));
  get("toggle-review").click();
  assert.equal(captionRequests.length, 2);
});

test("opening, searching and seeking secondary-camera captions respects offset, overlap and track selection", async (t) => {
  const cues = [
    { startTime: 1, endTime: 2, text: "开场" },
    { startTime: 18, endTime: 26, text: "主键与外键" },
    { startTime: 31, endTime: 40, text: "学生表" }
  ];
  let track, copy;
  const { dom, document, videos, captionRequests } = await page({
    labels: ["教室", "课件"],
    captionResult: key => key.includes("demo-b") ? { ok: true, cues } : { ok: false, error: "此画面没有独立字幕" },
    prepareMedia(win) {
      track = Object.assign(new win.EventTarget(), { cues, activeCues: [], mode: "disabled" });
      Object.defineProperty(win.HTMLTrackElement.prototype, "track", { get: () => track });
      win.URL.createObjectURL = () => "blob:course-captions";
      win.URL.revokeObjectURL = () => {};
      win.VTTCue = class { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } };
      win.HTMLMediaElement.prototype.addTextTrack = () => {
        copy = { cues: [], addCue(c) { this.cues.push(c); }, removeCue(c) { this.cues.splice(this.cues.indexOf(c), 1); } };
        return copy;
      };
    }
  });
  t.after(() => close(dom));
  const { Event } = dom.window;
  const get = (id) => document.getElementById(id);
  const offset = get("offset");
  offset.value = "5"; offset.dispatchEvent(new Event("change"));
  get("toggle-review").click(); await flush();
  assert.equal(get("review-source").value, "1");
  assert.deepEqual(captionRequests, videos.map(video => mediaKey(video.src)));
  videos[1].querySelector("track").dispatchEvent(new Event("load"));
  assert.equal(copy.mode, "showing");
  assert.deepEqual(copy.cues.map(c => c.startTime), [13, 26]);
  const entries = [...get("cue-list").querySelectorAll("button")];
  assert.equal(entries.length, 3);
  assert.equal(entries[0].disabled, true);
  const query = get("cue-search");
  query.value = "外键"; query.dispatchEvent(new Event("input"));
  assert.match(get("cue-count").textContent, /1 \/ 3/);
  assert.deepEqual(entries.map(b => b.parentElement.hidden), [true, false, true]);
  entries[1].querySelector("span").click();
  assert.deepEqual(videos.map(v => v.currentTime), [13, 18]);
  track.activeCues = [cues[1]];
  track.dispatchEvent(new Event("cuechange"));
  assert.equal(entries[1].getAttribute("aria-current"), "true");
  get("toggle-captions").click();
  assert.equal(track.mode, "hidden");
  assert.equal(copy.mode, "hidden");
  assert.equal(get("cue-list").querySelectorAll("button").length, 3);
  assert.equal(query.value, "外键");
  assert.equal(get("toggle-captions").getAttribute("aria-pressed"), "false");
  get("toggle-captions").click();
  assert.equal(track.mode, "showing");
  assert.equal(copy.mode, "showing");
  query.value = "无匹配"; query.dispatchEvent(new Event("input"));
  assert.match(get("cue-empty").textContent, /没有匹配/);
  get("close-review").click(); get("toggle-review").click();
  assert.equal(query.value, "无匹配");
  get("review-source").value = "0"; get("review-source").dispatchEvent(new Event("change"));
  assert.match(get("shared-caption-note").textContent, /课件/);
  query.value = ""; query.dispatchEvent(new Event("input"));
  entries[2].click();
  assert.deepEqual(videos.map(v => v.currentTime), [26, 31]);
  const mode = get("subtitles-1").querySelector("select");
  mode.value = "off"; mode.dispatchEvent(new Event("change"));
  assert.equal(get("cue-list").children.length, 0);
  assert.equal(get("cue-list").hidden, true);
  assert.equal(copy.mode, "disabled");
  get("review-source").value = "0"; get("review-source").dispatchEvent(new Event("change"));
  assert.equal(captionRequests.length, 2);
});

test("keyboard shortcuts seek and toggle playback without pausing active playback or hijacking inputs", async (t) => {
  const { dom, document, videos } = await page({
    prepareMedia(win) {
      const states = new WeakMap();
      Object.defineProperty(win.HTMLMediaElement.prototype, "paused", { get() { return states.get(this) ?? true; } });
      win.HTMLMediaElement.prototype.play = function() { states.set(this, false); return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function() { states.set(this, true); };
    }
  });
  t.after(() => close(dom));
  const key = (code, init = {}, target = document.body) => {
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init }));
  };

  key("Space");
  await flush();
  assert.equal(document.querySelector("#play").textContent, "暂停");
  assert.ok(videos.every((v) => !v.paused));

  key("ArrowRight");
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [5, 5]);
  assert.ok(videos.every((v) => !v.paused));

  key("ArrowRight", { shiftKey: true });
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [15, 15]);
  assert.ok(videos.every((v) => !v.paused));

  key("ArrowLeft");
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [10, 10]);
  assert.ok(videos.every((v) => !v.paused));

  // Pressing Space while focus is on +10s still toggles playback cleanly.
  key("Space", {}, document.querySelector("#forward"));
  await flush();
  assert.equal(document.querySelector("#play").textContent, "播放");
  assert.ok(videos.every((v) => v.paused));

  // Seeking while paused stays paused.
  key("ArrowRight");
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [15, 15]);
  assert.ok(videos.every((v) => v.paused));

  // Editable fields are never hijacked.
  const search = document.querySelector("#cue-search");
  key("Space", {}, search);
  key("ArrowRight", {}, search);
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [15, 15]);
  assert.ok(videos.every((v) => v.paused));
});

test("course playlist switches lessons in place, tracks watched status and counts down auto-next", async (t) => {
  const lessons = [
    { liveId: "101", index: 1, title: "第 1 周 周一 第 1-2 节", shortDate: "09-07", timeRange: "08:30–10:05", available: true },
    { liveId: "102", index: 2, title: "第 1 周 周三 第 1-2 节", shortDate: "09-09", timeRange: "08:30–10:05", available: true },
    { liveId: "103", index: 3, title: "第 2 周 周一 第 1-2 节", shortDate: "09-14", timeRange: "08:30–10:05", available: false }
  ];
  const progress = {
    "101": { liveId: "101", courseKey: "code:CS101", time: 45, duration: 120, ratio: 0.375, status: "watching", manual: false }
  };
  const loadedLessons = [];
  const savedProgress = [];
  const { dom, document, videos } = await page({
    playlistResult: { ok: true, supported: true, courseKey: "code:CS101", courseTitle: "数据库系统", currentLiveId: "101", lessons, progress, prefs: { autoPlayNext: true } },
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        return {
          ok: true, courseTitle: "数据库系统", currentLiveId: "101",
          media: [
            { key: mediaKey(mediaUrl("CloudIPC-101-a")), label: "课件", url: mediaUrl("CloudIPC-101-a") },
            { key: mediaKey(mediaUrl("CloudIPC-101-b")), label: "教室", url: mediaUrl("CloudIPC-101-b") }
          ]
        };
      }
      if (message.type === "LOAD_LESSON") {
        loadedLessons.push(message.liveId);
        return {
          ok: true, courseTitle: "数据库系统", lessonTitle: "第 1 周 周三 第 1-2 节", currentLiveId: message.liveId,
          media: [
            { key: mediaKey(mediaUrl(`CloudIPC-${message.liveId}-a`)), label: "课件", url: mediaUrl(`CloudIPC-${message.liveId}-a`) },
            { key: mediaKey(mediaUrl(`CloudIPC-${message.liveId}-b`)), label: "教室", url: mediaUrl(`CloudIPC-${message.liveId}-b`) }
          ]
        };
      }
      if (message.type === "SAVE_PROGRESS") {
        savedProgress.push(message);
        const status = message.ended || message.time / message.duration >= 0.9 ? "watched" : "watching";
        progress[message.liveId] = { liveId: message.liveId, time: message.time, duration: message.duration, ratio: message.ended ? 1 : message.time / message.duration, status };
        return { ok: true, record: progress[message.liveId] };
      }
      if (message.type === "TOGGLE_WATCHED") {
        const nextStatus = progress[message.liveId]?.status === "watched" ? "unwatched" : "watched";
        progress[message.liveId] = { liveId: message.liveId, time: nextStatus === "watched" ? 120 : 0, duration: 120, ratio: nextStatus === "watched" ? 1 : 0, status: nextStatus, manual: true };
        return { ok: true, record: progress[message.liveId] };
      }
    },
    prepareMedia(win) {
      const states = new WeakMap();
      Object.defineProperty(win.HTMLMediaElement.prototype, "paused", { get() { return states.get(this) ?? true; } });
      win.HTMLMediaElement.prototype.play = function() { states.set(this, false); return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function() { states.set(this, true); };
    }
  });
  t.after(() => close(dom));

  // Initial lesson auto-resumes to saved watching position (45s) and shows playlist controls.
  assert.equal(document.querySelector("#toggle-playlist").hidden, false);
  assert.equal(document.querySelector("#playlist-badge").textContent, "0/2");
  assert.deepEqual(videos.map((v) => v.currentTime), [45, 45]);

  // Opening playlist renders 3 items (1 upcoming disabled) and toggles manual watched state.
  document.querySelector("#toggle-playlist").click();
  assert.equal(document.querySelector("#playlist-panel").hidden, false);
  const items = [...document.querySelectorAll("#playlist-list .playlist-item")];
  assert.equal(items.length, 3);
  assert.equal(items[2].querySelector(".lesson-select").disabled, true);

  items[0].querySelector(".lesson-mark").click();
  await flush();
  assert.equal(document.querySelector("#playlist-badge").textContent, "1/2");
  assert.equal(document.querySelector("#playlist-overall-fill").style.width, "50%");

  // Sidebar tabs switch smoothly between 课程目录 and 字幕复习.
  document.querySelector(".side-tab-review").click();
  assert.equal(document.querySelector("#playlist-panel").hidden, true);
  assert.equal(document.querySelector("#review").hidden, false);
  document.querySelector(".side-tab-playlist").click();
  assert.equal(document.querySelector("#playlist-panel").hidden, false);
  assert.equal(document.querySelector("#review").hidden, true);

  // Filtering to unwatched hides the watched lesson and the upcoming lesson.
  const filter = document.querySelector("#playlist-filter");
  filter.value = "unwatched";
  filter.dispatchEvent(new dom.window.Event("change"));
  assert.equal(document.querySelectorAll("#playlist-list .playlist-item").length, 1);
  assert.equal(document.querySelector("#playlist-list .playlist-item").dataset.liveId, "102");

  // Clicking Play then ending the lesson triggers auto-next countdown and marks ended.
  document.querySelector("#play").click();
  await flush();
  videos[0].dispatchEvent(new dom.window.Event("ended"));
  await flush();
  assert.equal(document.querySelector("#next-countdown").hidden, false);
  assert.match(document.querySelector("#next-countdown-text").textContent, /自动播放下一节/);
  assert.ok(savedProgress.some((entry) => entry.liveId === "101" && entry.ended));

  // Clicking "立即播放" loads lesson 102 seamlessly in place and begins playback.
  document.querySelector("#play-next-now").click();
  await flush();
  assert.deepEqual(loadedLessons, ["102"]);
  assert.match(videos[0].src, /CloudIPC-102-a/);
  assert.match(videos[1].src, /CloudIPC-102-b/);
  assert.equal(document.querySelector("#next-countdown").hidden, true);
  assert.ok(videos.every((v) => !v.paused));
});

test("expired video source auto-refreshes once, restores playback, and routes failure actions by cause without retrying", async (t) => {
  let refreshMode = "ok";
  let autoRefreshCalls = 0;
  const makeMedia = (stamp) => [
    { key: mediaKey(mediaUrl("CloudIPC-demo-a", stamp)), label: "课件", url: mediaUrl("CloudIPC-demo-a", stamp) },
    { key: mediaKey(mediaUrl("CloudIPC-demo-b", stamp)), label: "教室", url: mediaUrl("CloudIPC-demo-b", stamp) }
  ];
  const { dom, document, videos } = await page({
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        if (!message.refresh) return { ok: true, courseTitle: "数据库系统", currentLiveId: "101", media: makeMedia(1700000000) };
        if (message.auto) autoRefreshCalls++;
        if (refreshMode === "ok") return { ok: true, courseTitle: "数据库系统", currentLiveId: "101", media: makeMedia(1700009999) };
        if (refreshMode === "login") return { ok: false, reason: "login", error: "西电智课登录已过期，请重新登录。" };
        if (refreshMode === "network") return { ok: false, reason: "network", error: "网络连接失败，请检查网络后重试。" };
        if (refreshMode === "generating") return { ok: false, reason: "generating", error: "该课次的视频回看仍在生成中。" };
      }
    },
    prepareMedia(win) {
      const states = new WeakMap();
      Object.defineProperty(win.HTMLMediaElement.prototype, "paused", { get() { return states.get(this) ?? true; } });
      win.HTMLMediaElement.prototype.play = function() { states.set(this, false); return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function() { states.set(this, true); };
    }
  });
  t.after(() => close(dom));
  const change = (el) => el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  document.querySelector("#offset").value = "-4"; change(document.querySelector("#offset"));
  document.querySelector("#rate").value = "1.5"; change(document.querySelector("#rate"));
  document.querySelector("#timeline").value = "40"; change(document.querySelector("#timeline"));
  document.querySelector("#play").click();
  await flush();

  // Trigger a media load error while playing -> auto-refreshes once, preserves offset/rate/position and resumes playback.
  videos[0].dispatchEvent(new dom.window.Event("error"));
  await flush();
  assert.equal(autoRefreshCalls, 1);
  assert.match(videos[0].src, /1700009999/);
  assert.deepEqual(videos.map((v) => v.currentTime), [40, 36]);
  assert.deepEqual(videos.map((v) => v.playbackRate), [1.5, 1.5]);
  assert.ok(videos.every((v) => !v.paused));
  assert.match(document.querySelector("#message").textContent, /已自动续签/);

  // Test login-expired failure on a fresh page: 1 attempt only, shows login link + refresh button, no auto-retry on 2nd error.
  refreshMode = "login";
  autoRefreshCalls = 0;
  const loginFixture = await page({
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        if (!message.refresh) return { ok: true, courseTitle: "数据库系统", currentLiveId: "101", media: makeMedia(1700000000) };
        if (message.auto) autoRefreshCalls++;
        if (refreshMode === "login") return { ok: false, reason: "login", error: "西电智课登录已过期，请重新登录。" };
        if (refreshMode === "network") return { ok: false, reason: "network", error: "网络连接失败，请检查网络后重试。" };
        return { ok: false, reason: "generating", error: "该课次的视频回看仍在生成中。" };
      }
    }
  });
  t.after(() => close(loginFixture.dom));

  loginFixture.videos[0].dispatchEvent(new loginFixture.dom.window.Event("error"));
  await flush();
  assert.equal(autoRefreshCalls, 1);
  const loginLink = loginFixture.document.querySelector("#message .message-link");
  assert.ok(loginLink && loginLink.href.startsWith("https://xdspoc.xidian.edu.cn/"));
  assert.ok(loginFixture.document.querySelector("#message .message-retry"));

  // A second error does NOT auto-retry.
  loginFixture.videos[0].dispatchEvent(new loginFixture.dom.window.Event("error"));
  await flush();
  assert.equal(autoRefreshCalls, 1);

  // Network error shows retry button without misleading login link.
  refreshMode = "network";
  const netFixture = await page({
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        if (!message.refresh) return { ok: true, courseTitle: "数据库系统", currentLiveId: "101", media: makeMedia(1700000000) };
        return { ok: false, reason: "network", error: "网络连接失败，请检查网络后重试。" };
      }
    }
  });
  t.after(() => close(netFixture.dom));
  netFixture.videos[0].dispatchEvent(new netFixture.dom.window.Event("error"));
  await flush();
  assert.equal(netFixture.document.querySelector("#message .message-link"), null);
  assert.ok(netFixture.document.querySelector("#message .message-retry"));
});

test("initial resume and lesson switch autoplay wait until both videos finish loading metadata", async (t) => {
  const lessons = [
    { liveId: "101", index: 1, title: "第 1 讲", shortDate: "09-07", timeRange: "08:30–10:05", available: true },
    { liveId: "102", index: 2, title: "第 2 讲", shortDate: "09-09", timeRange: "08:30–10:05", available: true }
  ];
  const progress = {
    "101": { liveId: "101", courseKey: "code:CS101", time: 45, duration: 120, ratio: 0.375, status: "watching", manual: false },
    "102": { liveId: "102", courseKey: "code:CS101", time: 30, duration: 120, ratio: 0.25, status: "watching", manual: false }
  };
  let videoStates;
  const { dom, document, videos } = await page({
    playlistResult: { ok: true, supported: true, courseKey: "code:CS101", courseTitle: "数据库系统", currentLiveId: "101", lessons, progress, prefs: { autoPlayNext: true } },
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        return {
          ok: true, courseTitle: "数据库系统", currentLiveId: "101",
          media: [
            { key: mediaKey(mediaUrl("CloudIPC-101-a")), label: "课件", url: mediaUrl("CloudIPC-101-a") },
            { key: mediaKey(mediaUrl("CloudIPC-101-b")), label: "教室", url: mediaUrl("CloudIPC-101-b") }
          ]
        };
      }
      if (message.type === "LOAD_LESSON") {
        return {
          ok: true, courseTitle: "数据库系统", lessonTitle: "第 2 讲", currentLiveId: message.liveId,
          media: [
            { key: mediaKey(mediaUrl(`CloudIPC-${message.liveId}-a`)), label: "课件", url: mediaUrl(`CloudIPC-${message.liveId}-a`) },
            { key: mediaKey(mediaUrl(`CloudIPC-${message.liveId}-b`)), label: "教室", url: mediaUrl(`CloudIPC-${message.liveId}-b`) }
          ]
        };
      }
    },
    prepareMedia(win) {
      videoStates = new WeakMap();
      const stateOf = (el) => {
        if (!videoStates.has(el)) videoStates.set(el, { duration: NaN, readyState: 0, paused: true });
        return videoStates.get(el);
      };
      win.HTMLMediaElement.prototype.load = function() {
        const st = stateOf(this);
        st.duration = NaN;
        st.readyState = 0;
        st.paused = true;
        this.currentTime = 0;
      };
      win.HTMLMediaElement.prototype.play = function() { stateOf(this).paused = false; return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function() { stateOf(this).paused = true; };
      for (const video of win.document.querySelectorAll("video")) {
        Object.defineProperty(video, "duration", { configurable: true, get() { return stateOf(this).duration; } });
        Object.defineProperty(video, "readyState", { configurable: true, get() { return stateOf(this).readyState; } });
        Object.defineProperty(video, "paused", { configurable: true, get() { return stateOf(this).paused; } });
      }
    }
  });
  t.after(() => close(dom));

  const readyVideo = (video, duration = 120) => {
    const st = videoStates.get(video);
    st.duration = duration;
    st.readyState = 4;
    video.dispatchEvent(new dom.window.Event("loadedmetadata"));
  };

  // Playlist arrived before either video loaded metadata; only video 0 ready should still wait.
  readyVideo(videos[0]);
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [0, 0]);

  // Once video 1 metadata arrives, initial resume seeks both videos cleanly.
  readyVideo(videos[1]);
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [45, 45]);
  assert.match(document.querySelector("#message").textContent, /已定位到上次观看位置/);

  // Switching to lesson 102 with staggered metadata waits for both videos, then seeks to 30s and plays without error.
  document.querySelector("#next-lesson").click();
  await flush();
  readyVideo(videos[0]);
  await flush();
  assert.equal(videos[0].paused, true);
  assert.doesNotMatch(document.querySelector("#message").textContent, /等待两路视频就绪/);

  readyVideo(videos[1]);
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [30, 30]);
  assert.ok(videos.every((v) => !v.paused));
});

test("restores and persists layered global and per-course player preferences", async (t) => {
  const savedPatches = [];
  const storedPrefs = {
    autoPlayNext: false,
    rate: 1.5,
    volume: 0.6,
    captionsEnabled: false,
    audio: { mode: "channel", role: "classroom", index: 1 },
    courses: {
      "code:CS101": {
        audio: { mode: "channel", role: "classroom", index: 0 },
        offset: -2.5,
        updatedAt: 1000
      }
    }
  };
  const lessons = [
    { liveId: "101", index: 1, title: "第 1 讲", shortDate: "09-07", timeRange: "08:30–10:05", available: true }
  ];
  const { dom, document, videos } = await page({
    // Put 教室 at index 0 and 课件 at index 1 to verify role-based audio resolution.
    labels: ["教室", "课件"],
    playlistResult: { ok: true, supported: true, courseKey: "code:CS101", courseTitle: "数据库系统", currentLiveId: "101", lessons, progress: {}, prefs: storedPrefs },
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        return {
          ok: true,
          courseTitle: "数据库系统",
          currentLiveId: "101",
          prefs: storedPrefs,
          media: [
            { key: mediaKey(mediaUrl("CloudIPC-101-cam")), label: "教室", url: mediaUrl("CloudIPC-101-cam") },
            { key: mediaKey(mediaUrl("CloudIPC-101-ppt")), label: "课件", url: mediaUrl("CloudIPC-101-ppt") }
          ]
        };
      }
      if (message.type === "SET_PLAYER_PREFS") {
        savedPatches.push(message);
        return { ok: true, prefs: mergePlayerPrefs(storedPrefs, message) };
      }
    }
  });
  t.after(() => close(dom));

  // Global prefs restored on boot: rate 1.5x, volume 0.6, captions off, autoPlayNext off.
  assert.deepEqual(videos.map((v) => v.playbackRate), [1.5, 1.5]);
  assert.deepEqual(videos.map((v) => v.volume), [0.6, 0.6]);
  assert.equal(document.querySelector("#toggle-captions").getAttribute("aria-pressed"), "false");
  assert.equal(document.querySelector("#auto-next").checked, false);

  // Role-based audio matched "教室" at index 0, and course offset -2.5 applied once playlist returned courseKey.
  assert.deepEqual(videos.map((v) => v.muted), [false, true]);
  assert.equal(document.querySelector('input[name="audio"][value="0"]').checked, true);
  assert.equal(document.querySelector("#offset").value, "-2.5");

  // User interactions persist rate, captions, audio (with role + courseKey), offset, reset-offset, and volume.
  const rateSelect = document.querySelector("#rate");
  rateSelect.value = "2";
  rateSelect.dispatchEvent(new dom.window.Event("change"));

  document.querySelector("#toggle-captions").click();

  const audio1 = document.querySelector('input[name="audio"][value="1"]');
  audio1.checked = true;
  audio1.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  const offsetInput = document.querySelector("#offset");
  offsetInput.value = "3.5";
  offsetInput.dispatchEvent(new dom.window.Event("change"));

  document.querySelector("#reset-offset").click();
  assert.equal(offsetInput.value, "0");

  document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "ArrowDown", bubbles: true, cancelable: true }));
  assert.deepEqual(videos.map((v) => v.volume), [0.5, 0.5]);

  // Flushing via pagehide immediately sends pending debounced volume.
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await flush();

  assert.ok(savedPatches.some((p) => p.rate === 2));
  assert.ok(savedPatches.some((p) => p.captionsEnabled === true));
  assert.ok(savedPatches.some((p) => p.courseKey === "code:CS101" && p.audio?.mode === "channel" && p.audio?.role === "slide" && p.audio?.index === 1));
  assert.ok(savedPatches.some((p) => p.courseKey === "code:CS101" && p.offset === 3.5));
  assert.ok(savedPatches.some((p) => p.courseKey === "code:CS101" && p.offset === null));
  assert.ok(savedPatches.some((p) => p.volume === 0.5));
});

test("player degrades cleanly to single-stream mode and transitions seamlessly between single and dual lessons", async (t) => {
  const lessons = [
    { liveId: "201", index: 1, title: "第 1 讲（单画面）", shortDate: "09-07", timeRange: "08:30–10:05", available: true },
    { liveId: "202", index: 2, title: "第 2 讲（双画面）", shortDate: "09-09", timeRange: "08:30–10:05", available: true },
    { liveId: "203", index: 3, title: "第 3 讲（单画面）", shortDate: "09-11", timeRange: "08:30–10:05", available: true }
  ];
  const { dom, document, videos } = await page({
    playlistResult: { ok: true, supported: true, courseKey: "code:CS201", courseTitle: "编译原理", currentLiveId: "201", lessons, progress: {}, prefs: { autoPlayNext: true } },
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        return {
          ok: true,
          courseTitle: "编译原理",
          currentLiveId: "201",
          media: [{ key: mediaKey(mediaUrl("CloudIPC-201-ppt")), label: "课件", url: mediaUrl("CloudIPC-201-ppt") }]
        };
      }
      if (message.type === "LOAD_LESSON") {
        if (message.liveId === "202") {
          return {
            ok: true,
            courseTitle: "编译原理",
            lessonTitle: "第 2 讲（双画面）",
            currentLiveId: "202",
            media: [
              { key: mediaKey(mediaUrl("CloudIPC-202-ppt")), label: "课件", url: mediaUrl("CloudIPC-202-ppt") },
              { key: mediaKey(mediaUrl("CloudIPC-202-cam")), label: "教室", url: mediaUrl("CloudIPC-202-cam") }
            ]
          };
        }
        return {
          ok: true,
          courseTitle: "编译原理",
          lessonTitle: "第 3 讲（单画面）",
          currentLiveId: "203",
          media: [{ key: mediaKey(mediaUrl("CloudIPC-203-ppt")), label: "课件", url: mediaUrl("CloudIPC-203-ppt") }]
        };
      }
    },
    prepareMedia(win) {
      const states = new WeakMap();
      Object.defineProperty(win.HTMLMediaElement.prototype, "paused", { configurable: true, get() { return states.get(this) ?? true; } });
      win.HTMLMediaElement.prototype.play = function() { states.set(this, false); return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function() { states.set(this, true); };
    }
  });
  t.after(() => close(dom));

  // Starts in single-stream mode: secondary view and dual-only controls hidden, playback enabled.
  assert.equal(document.querySelector(".screens").dataset.mode, "single");
  assert.equal(document.querySelector("#screen-1").hidden, true);
  assert.equal(document.querySelector("#swap-views").hidden, true);
  assert.equal(document.querySelector("#audio-option-1").hidden, true);
  assert.equal(document.querySelector("#offset-wrap").hidden, true);
  assert.equal(document.querySelector("#play").disabled, false);
  assert.equal(document.querySelector("#screen-role-0").textContent, "单画面");
  assert.match(document.querySelector("#sync-status").textContent, /单画面/);

  // Switch to dual-stream lesson 202: restores dual layout and plays both videos.
  document.querySelector("#next-lesson").click();
  await flush();
  assert.equal(document.querySelector(".screens").dataset.mode, "dual");
  assert.equal(document.querySelector("#screen-1").hidden, false);
  assert.equal(document.querySelector("#swap-views").hidden, false);
  assert.equal(document.querySelector("#audio-option-1").hidden, false);
  assert.equal(document.querySelector("#offset-wrap").hidden, false);
  assert.match(videos[0].src, /CloudIPC-202-ppt/);
  assert.match(videos[1].src, /CloudIPC-202-cam/);
  assert.ok(videos.every((v) => !v.paused));

  // Switch to single-stream lesson 203: degrades back to single layout and resets video 1.
  document.querySelector("#next-lesson").click();
  await flush();
  assert.equal(document.querySelector(".screens").dataset.mode, "single");
  assert.equal(document.querySelector("#screen-1").hidden, true);
  assert.equal(videos[1].getAttribute("src"), null);
  assert.equal(videos[0].paused, false);
  assert.match(videos[0].src, /CloudIPC-203-ppt/);
});

test("custom dropdowns, segmented controls, speed popover and timeline progress stay synchronized", async (t) => {
  const lessons = [
    { liveId: "301", index: 1, title: "第 1 讲", shortDate: "09-07", timeRange: "08:30–10:05", available: true },
    { liveId: "302", index: 2, title: "第 2 讲", shortDate: "09-09", timeRange: "08:30–10:05", available: true }
  ];
  const progress = {
    "301": { liveId: "301", courseKey: "code:CS301", time: 120, duration: 120, ratio: 1, status: "watched" }
  };
  const { dom, document, videos } = await page({
    labels: ["教室", "课件"],
    playlistResult: { ok: true, supported: true, courseKey: "code:CS301", courseTitle: "操作系统", currentLiveId: "301", lessons, progress, prefs: { autoPlayNext: true } }
  });
  t.after(() => close(dom));

  // Timeline progress CSS custom property updates when seeking.
  const timeline = document.querySelector("#timeline");
  timeline.value = "60";
  timeline.dispatchEvent(new dom.window.Event("input"));
  assert.equal(timeline.style.getPropertyValue("--progress"), "50%");

  // Speed popover opens on trigger click, selects preset pill, updates videos and closes.
  const speedTrigger = document.querySelector("#speed-control .speed-trigger");
  const speedPopover = document.querySelector("#speed-control .speed-popover");
  assert.equal(speedPopover.hidden, true);
  speedTrigger.click();
  assert.equal(speedPopover.hidden, false);
  const preset2x = document.querySelector('#speed-control .speed-preset[data-rate="2"]');
  preset2x.click();
  assert.equal(speedPopover.hidden, true);
  assert.deepEqual(videos.map((v) => v.playbackRate), [2, 2]);
  assert.equal(document.querySelector("#speed-control .speed-trigger-value").textContent, "2×");

  // Playlist filter is enhanced into segmented pill buttons synced with #playlist-filter.
  document.querySelector("#toggle-playlist").click();
  const unwatchedBtn = document.querySelector('#playlist-panel .ui-segmented-btn[data-value="unwatched"]');
  assert.ok(unwatchedBtn);
  unwatchedBtn.click();
  assert.equal(document.querySelector("#playlist-filter").value, "unwatched");
  assert.equal(document.querySelectorAll("#playlist-list .playlist-item").length, 1);

  // Review source is enhanced into segmented buttons synced with #review-source.
  document.querySelector("#toggle-review").click();
  const reviewBtn0 = document.querySelector('#review .ui-segmented-btn[data-value="0"]');
  assert.equal(reviewBtn0.textContent, "教室");
  reviewBtn0.click();
  assert.equal(document.querySelector("#review-source").value, "0");

  // Source dropdown uses custom floating menu synced with #source-0 and closes on Escape.
  const source0Ui = document.querySelector("#source-0").closest(".ui-select");
  const sourceTrigger = source0Ui.querySelector(".ui-select-trigger");
  const sourceMenu = source0Ui.querySelector(".ui-select-menu");
  sourceTrigger.click();
  assert.equal(sourceMenu.hidden, false);
  sourceTrigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(sourceMenu.hidden, true);
});

test("long background idle and expired-source refresh automatically rebuild subtitle tracks without losing transcript search", async (t) => {
  const cues = [
    { startTime: 5, endTime: 12, text: "关系代数简介" },
    { startTime: 20, endTime: 28, text: "自然连接与投影" }
  ];
  const createdCopies = [];
  let blobCount = 0;
  let refreshCount = 0;
  const makeMedia = (stamp) => [
    { key: mediaKey(mediaUrl("CloudIPC-demo-a", stamp)), label: "课件", url: mediaUrl("CloudIPC-demo-a", stamp) },
    { key: mediaKey(mediaUrl("CloudIPC-demo-b", stamp)), label: "教室", url: mediaUrl("CloudIPC-demo-b", stamp) }
  ];
  const { dom, document, videos } = await page({
    captionResult: () => ({ ok: true, cues }),
    onMessage(message) {
      if (message.type === "GET_PLAYER") {
        if (message.refresh) refreshCount++;
        const stamp = message.refresh ? 1700005000 : 1700000000;
        return { ok: true, courseTitle: "数据库系统", currentLiveId: "101", media: makeMedia(stamp) };
      }
    },
    prepareMedia(win) {
      const trackMap = new WeakMap();
      Object.defineProperty(win.HTMLTrackElement.prototype, "track", {
        get() {
          if (!trackMap.has(this)) {
            trackMap.set(this, Object.assign(new win.EventTarget(), { cues, activeCues: [cues[1]], mode: "disabled" }));
          }
          return trackMap.get(this);
        }
      });
      win.URL.createObjectURL = () => "blob:idle-captions/" + ++blobCount;
      win.URL.revokeObjectURL = () => {};
      win.VTTCue = class { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } };
      win.HTMLMediaElement.prototype.addTextTrack = () => {
        const copy = { cues: [], addCue(c) { this.cues.push(c); }, removeCue(c) { this.cues.splice(this.cues.indexOf(c), 1); } };
        createdCopies.push(copy);
        return copy;
      };
    }
  });
  t.after(() => close(dom));

  const { Event } = dom.window;
  const loadPendingTracks = () => {
    videos.forEach((video) => {
      const tracks = video.querySelectorAll("track");
      if (tracks.length) tracks[tracks.length - 1].dispatchEvent(new Event("load"));
    });
  };

  loadPendingTracks();
  const offset = document.querySelector("#offset");
  offset.value = "4";
  offset.dispatchEvent(new Event("change"));
  assert.deepEqual(createdCopies[0].cues.map((c) => c.startTime), [9, 24]);

  // Open review panel and enter a search query.
  document.querySelector("#toggle-review").click();
  const search = document.querySelector("#cue-search");
  search.value = "投影";
  search.dispatchEvent(new Event("input"));
  assert.match(document.querySelector("#cue-count").textContent, /1 \/ 2/);

  // Simulate tab hidden for 60s then returning visible.
  let hidden = true;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const realNow = dom.window.Date.now;
  let fakeNow = realNow();
  dom.window.Date.now = () => fakeNow;
  t.after(() => { dom.window.Date.now = realNow; });

  document.dispatchEvent(new Event("visibilitychange"));
  fakeNow += 60_000;
  hidden = false;
  const blobsBeforeWake = blobCount;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.ok(blobCount > blobsBeforeWake, "returning from long idle rebuilds caption tracks");
  loadPendingTracks();
  assert.equal(search.value, "投影", "automatic caption resync preserves user search query");
  assert.deepEqual(createdCopies[0].cues.map((c) => c.startTime), [9, 24]);

  // Triggering expired-source auto-refresh also rebuilds caption tracks and keeps offset intact.
  const blobsBeforeRefresh = blobCount;
  videos[0].dispatchEvent(new Event("error"));
  await flush();
  assert.equal(refreshCount, 1);
  assert.ok(blobCount > blobsBeforeRefresh, "auto-refresh rebuilds caption tracks after video reload");
  loadPendingTracks();
  assert.equal(offset.value, "4");
  assert.deepEqual(createdCopies[0].cues.map((c) => c.startTime), [9, 24]);
  assert.equal(search.value, "投影");
});
