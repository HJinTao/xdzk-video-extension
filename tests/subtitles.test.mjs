import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mediaKey } from "../extension/lib/media.js";
import { readCourseSubtitles } from "../extension/lib/course-subtitles.js";
import { bindSubtitles, toWebVtt } from "../extension/lib/subtitles.js";
import { mediaUrl, pageUrl } from "./fixtures.mjs";

const endpoint = new URL("getVideoSubtitles2Vtt?workDetailId=200", pageUrl).href;
const vtt = "WEBVTT\n\n00:00.500 --> 00:02.000\n第一句\n\n00:04.000 --> 00:06.000\n第二句";
const srt = "\uFEFF1\r\n00:00:01,500 --> 00:00:02,100\r\n第一行\r\n第二行\r\n";

function frame(html, resources, responses = {}) {
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
  dom.window.performance.getEntriesByType = () => resources.map((name) => ({ name }));
  const requests = [];
  dom.window.fetch = async (url, options) => {
    requests.push({ url, credentials: options.credentials });
    return new Response(responses[url] ?? null, { status: url in responses ? 200 : 404 });
  };
  const injected = dom.window.eval(`(${readCourseSubtitles.toString()})`);
  return { dom, requests, read: () => injected(mediaKey(mediaUrl()), pageUrl) };
}

test("recovers the current lesson's subtitle response from its own authenticated frame", async (t) => {
  const wrongLesson = endpoint.replace("=200", "=199");
  const f = frame(`<video src="${mediaUrl()}"></video>`, [wrongLesson, endpoint, "https://other.test/getVideoSubtitles2Vtt?workDetailId=200"], {
    [endpoint]: JSON.stringify({ data: { vtt } })
  });
  t.after(() => f.dom.window.close());
  assert.equal((await f.read()).text, vtt);
  assert.deepEqual(f.requests, [{ url: endpoint, credentials: "same-origin" }]);
});

test("reads an in-memory caption track and restores its original mode", async (t) => {
  const f = frame(`<video src="${mediaUrl()}"></video>`, []);
  t.after(() => f.dom.window.close());
  const cue = { startTime: 1.01, endTime: 3, text: "字幕内容" };
  const track = { kind: "subtitles", mode: "disabled", get cues() { return this.mode === "disabled" ? null : [cue]; } };
  Object.defineProperty(f.dom.window.document.querySelector("video"), "textTracks", { value: [track] });
  const result = await f.read();
  assert.equal(toWebVtt(result), "WEBVTT\n\n00:00:01.010 --> 00:00:03.000\n字幕内容\n");
  assert.equal(track.mode, "disabled");
  assert.equal(f.requests.length, 0);
});

test("only the selected video's subtitle tracks are read, stale media and login pages show no cues", async (t) => {
  const file = new URL("teacher.vtt", pageUrl).href;
  const html = `<video src="${mediaUrl("other")}"><track src="other.vtt"></video><video src="${mediaUrl()}">
    <track kind="chapters" src="chapters.vtt"><track src="https://unrelated.test/file.vtt"><track src="teacher.vtt"></video>`;
  const f = frame(html, [endpoint], { [file]: vtt });
  t.after(() => f.dom.window.close());
  assert.equal((await f.read()).text, vtt);
  assert.deepEqual(f.requests.map((request) => request.url), [file]);
  f.dom.window.document.querySelectorAll("video")[1].remove();
  assert.equal((await f.read()).stale, true);
  const missing = frame(`<video src="${mediaUrl()}"></video>`, [endpoint], { [endpoint]: "WEBVTT\n\n" });
  const login = frame(`<video src="${mediaUrl()}"></video>`, [endpoint], { [endpoint]: "<html>请先登录</html>" });
  t.after(() => { missing.dom.window.close(); login.dom.window.close(); });
  assert.equal((await missing.read()).failed, false);
  assert.equal((await login.read()).failed, true);
});

test("normalizes SRT cue timings without changing multiline text or native WebVTT settings", () => {
  assert.match(toWebVtt({ text: srt }), /00:00:01\.500 --> 00:00:02\.100\n第一行\n第二行/);
  const positioned = vtt.replace("00:02.000", "00:02.000 align:start");
  assert.equal(toWebVtt({ text: positioned }), positioned);
  assert.throws(() => toWebVtt({ text: "请先登录" }), /时间码/);
});

test("subtitle controls discard late results, preserve valid imports on failure and reset with the lesson", async (t) => {
  const dom = new JSDOM("<video></video><div></div>");
  t.after(() => dom.window.close());
  const { document, Event, HTMLTrackElement, URL } = dom.window;
  const video = document.querySelector("video");
  const panel = document.querySelector("div");
  const tracks = new WeakMap();
  Object.defineProperty(HTMLTrackElement.prototype, "track", { get() {
    if (!tracks.has(this)) tracks.set(this, { mode: "disabled", cues: [{ text: "字幕" }] });
    return tracks.get(this);
  } });
  const revoked = [];
  let fileCount = 0;
  URL.createObjectURL = () => "blob:demo/" + ++fileCount;
  URL.revokeObjectURL = (url) => revoked.push(url);
  let respond;
  const controls = bindSubtitles(panel, video, () => new Promise((done) => { respond = done; }));
  controls.setSource("lesson-a");
  const select = panel.querySelector("select");
  const input = panel.querySelector("input");
  const change = (mode) => { select.value = mode; select.dispatchEvent(new Event("change")); };
  const file = async (name, text) => {
    Object.defineProperty(input, "files", { configurable: true, value: [{ name, text: async () => text }] });
    input.dispatchEvent(new Event("change")); await Promise.resolve();
  };
  change("course"); change("off"); respond({ text: vtt }); await Promise.resolve();
  assert.equal(video.querySelector("track"), null);
  await file("讲义.srt", srt);
  video.querySelector("track").dispatchEvent(new Event("load"));
  assert.equal(select.selectedOptions[0].textContent, "讲义.srt");
  assert.equal(video.querySelector("track").track.mode, "showing");
  await file("空.srt", "no captions");
  assert.equal(select.value, "file");
  assert.match(panel.querySelector("small").textContent, /时间码/);
  change("off"); assert.deepEqual(revoked, ["blob:demo/1"]);
  change("file"); video.querySelector("track").dispatchEvent(new Event("load"));
  controls.setSource("lesson-a"); assert.equal(select.value, "file");
  change("course"); respond({ text: vtt }); await Promise.resolve();
  const pending = video.querySelectorAll("track")[1];
  controls.setSource("lesson-b"); pending.dispatchEvent(new Event("load"));
  assert.equal(video.querySelector("track"), null);
  assert.equal(select.querySelector('[value="file"]'), null);
  assert.equal(select.value, "off");
  assert.equal(new Set(revoked).size, 3);
});
