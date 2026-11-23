import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { SyncPlayer, recordingOffset } from "../extension/lib/sync-player.js";
import { mediaKey } from "../extension/lib/media.js";
import { bindSubtitles } from "../extension/lib/subtitles.js";
import { bindPlaybackSpeed } from "../extension/lib/playback-speed.js";
import { snapshot, mediaUrl, createPlayerStub } from "./fixtures.mjs";

const html = await readFile(new URL("../extension/player.html", import.meta.url), "utf8");
const code = (await readFile(new URL("../extension/player.js", import.meta.url), "utf8")).replace(/^import .+;\r?$/gm, "");
const flush = () => new Promise((done) => setTimeout(done, 15));
async function page() {
  const dom = new JSDOM(html, { url: "https://extension.test/player.html?id=demo", runScripts: "outside-only" });
  Object.assign(dom.window, { SyncPlayer, recordingOffset, bindSubtitles, bindPlaybackSpeed, createLecturePlayer: createPlayerStub });
  let stamp = 1700000000;
  dom.window.chrome = { runtime: { async sendMessage() {
    return { ok: true, courseTitle: "数据库系统", media: snapshot.media.map((item, index) => ({ ...item, key: mediaKey(item.url), label: `画面 ${index + 1}`, url: mediaUrl(index ? "CloudIPC-demo-b" : "CloudIPC-demo-a", stamp) })) };
  } } };
  dom.window.HTMLMediaElement.prototype.load = function() { this.currentTime = 0; queueMicrotask(() => this.dispatchEvent(new dom.window.Event("loadedmetadata"))); };
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  const videos = [...dom.window.document.querySelectorAll("video")];
  videos.forEach((video) => {
    Object.defineProperty(video, "duration", { get: () => 120 });
    Object.defineProperty(video, "readyState", { get: () => 4 });
  });
  dom.window.eval(code);
  await flush();
  return { dom, document: dom.window.document, videos, refreshSignature() { stamp += 300; } };
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
