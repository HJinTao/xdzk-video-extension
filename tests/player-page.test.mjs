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
import { trackWatching } from "../extension/lib/watch-history.js";
import { webPlayback } from "../extension/lib/web-playback.js";
import { snapshot, mediaUrl, createPlayerStub } from "./fixtures.mjs";

const html = await readFile(new URL("../extension/player.html", import.meta.url), "utf8");
const code = (await readFile(new URL("../extension/player.js", import.meta.url), "utf8")).replace(/^import .+;\r?$/gm, "");
const flush = () => new Promise((done) => setTimeout(done, 15));
async function page({ labels = ["画面 1", "画面 2"], restored = [], captionResult = () => ({ ok: false, error: "本次回放没有可用的课程字幕" }), prepareMedia } = {}) {
  const dom = new JSDOM(html, { url: "https://extension.test/player.html?id=demo", runScripts: "outside-only" });
  Object.assign(dom.window, { SyncPlayer, recordingOffset, bindSubtitles, bindPairedSubtitles, bindPlaybackSpeed, bindTranscript, formatClock, trackWatching, webPlayback, createLecturePlayer: createPlayerStub });
  let stamp = 1700000000;
  const captionRequests = [];
  dom.window.chrome = { runtime: { async sendMessage(message) {
    if (message.type === "GET_SUBTITLES") { captionRequests.push(message.key); return captionResult(message.key); }
    return { ok: true, courseTitle: "数据库系统", media: snapshot.media.map((item, index) => ({ ...item, ...restored[index], key: mediaKey(item.url), label: labels[index], url: mediaUrl(index ? "CloudIPC-demo-b" : "CloudIPC-demo-a", stamp) })) };
  } } };
  dom.window.HTMLMediaElement.prototype.load = function() { this.currentTime = 0; queueMicrotask(() => this.dispatchEvent(new dom.window.Event("loadedmetadata"))); };
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  const videos = [...dom.window.document.querySelectorAll("video")];
  videos.forEach((video) => {
    Object.defineProperty(video, "duration", { get: () => 120 });
    Object.defineProperty(video, "readyState", { get: () => 4 });
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

test("dual playback resumes the last camera watched after both metadata events", async t => {
  let ready = false;
  const { dom, videos } = await page({
    restored: [{ resumeAt: 5, resumeStamp: 100 }, { resumeAt: 70, resumeStamp: 200 }],
    prepareMedia(win) {
      // readyState and duration on the unready camera must agree, just like a browser.
      const media = win.document.querySelectorAll("video")[1];
      const replacement = media.cloneNode();
      media.replaceWith(replacement);
      Object.defineProperty(replacement, "duration", { get: () => ready ? 120 : NaN });
      Object.defineProperty(replacement, "readyState", { get: () => ready ? 1 : 0 });
    }
  });
  t.after(() => close(dom));
  assert.equal(videos[0].currentTime, 0);
  ready = true;
  const second = dom.window.document.querySelectorAll("video")[1];
  second.dispatchEvent(new dom.window.Event("loadedmetadata"));
  assert.equal(videos[0].currentTime, 70);
  assert.equal(second.currentTime, 70);
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
