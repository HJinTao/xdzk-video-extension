import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { SyncPlayer, recordingOffset } from "../extension/lib/sync-player.js";
import { mediaKey } from "../extension/lib/media.js";
import { snapshot, mediaUrl } from "./fixtures.mjs";

const html = await readFile(new URL("../extension/player.html", import.meta.url), "utf8");
const code = (await readFile(new URL("../extension/player.js", import.meta.url), "utf8")).replace(/^import .+;\r?\n/, "");
const flush = () => new Promise((done) => setTimeout(done, 15));
async function page() {
  const dom = new JSDOM(html, { url: "https://extension.test/player.html?id=demo", runScripts: "outside-only" });
  Object.assign(dom.window, { SyncPlayer, recordingOffset });
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
