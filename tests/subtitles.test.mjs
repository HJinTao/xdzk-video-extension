import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mediaKey } from "../extension/lib/media.js";
import { readCourseSubtitles } from "../extension/lib/course-subtitles.js";
import { bindSubtitles, toWebVtt } from "../extension/lib/subtitles.js";
import { bindPairedSubtitles } from "../extension/lib/paired-subtitles.js";
import { mediaUrl, pageUrl } from "./fixtures.mjs";

const endpoint = new URL("getVideoSubtitles2Vtt?workDetailId=200", pageUrl).href;
const vtt = "WEBVTT\n\n00:00.500 --> 00:02.000\n第一句\n\n00:04.000 --> 00:06.000\n第二句";
const srt = "\uFEFF1\r\n00:00:01,500 --> 00:00:02,100\r\n第一行\r\n第二行\r\n";

test("paired captions keep independent sources, share a single file and retime a reusable native copy", () => {
  class Cue { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } }
  const source = (vtt, mode = "course") => ({ mode, vtt, track: { cues: [new Cue(1, 4, vtt), new Cue(5, 9, vtt)] } });
  const videos = [0, 1].map(() => ({
    copies: [], ownerDocument: { defaultView: { VTTCue: Cue } },
    addTextTrack() {
      const track = { cues: [], addCue(c) { this.cues.push(c); }, removeCue(c) { this.cues.splice(this.cues.indexOf(c), 1); } };
      this.copies.push(track); return track;
    }
  }));
  const controls = ["教室独立字幕", "课件独立字幕"].map(text => ({ source: source(text), setDisplay(visible) { this.visible = visible; } }));
  const update = bindPairedSubtitles(videos, controls);
  assert.deepEqual(update(2, true), [0, 1]);
  assert.ok(controls.every(c => c.visible));
  assert.ok(videos.every(v => !v.copies.length));

  controls[1].source = source("教室独立字幕");
  assert.deepEqual(update(2, true), [0, 0]);
  const [copy] = videos[1].copies;
  assert.equal(copy.mode, "showing");
  assert.deepEqual(copy.cues.map(c => c.startTime), [3, 7]);
  const unchanged = copy.cues[0];
  update(2, false);
  assert.equal(copy.mode, "hidden");
  assert.equal(copy.cues[0], unchanged);
  update(-6, true);
  assert.deepEqual(copy.cues.map(c => [c.startTime, c.endTime]), [[0, 3]]);

  controls[1].source = source("本地字幕", "file");
  assert.deepEqual(update(2, true), [1, 1]);
  assert.equal(copy.mode, "disabled");
  assert.deepEqual(videos[0].copies[0].cues.map(c => [c.startTime, c.text]), [[0, "本地字幕"], [3, "本地字幕"]]);
  controls[0].source = source("另一个文件", "file");
  assert.deepEqual(update(2, true), [0, 1]);
  assert.ok(videos.every(v => v.copies.length === 1 && !v.copies[0].cues.length));

  controls[0].source = source("课程共享字幕");
  controls[1].source = source("课程共享字幕");
  assert.deepEqual(update(3, true), [0, 0]);
  const beforeForce = videos[1].copies[0].cues[0];
  assert.deepEqual(update(3, true), [0, 0]);
  assert.equal(videos[1].copies[0].cues[0], beforeForce);
  assert.deepEqual(update(3, true, { force: true }), [0, 0]);
  assert.notEqual(videos[1].copies[0].cues[0], beforeForce);
  assert.deepEqual(videos[1].copies[0].cues.map(c => c.startTime), [4, 8]);
});

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

test("subtitle resync rebuilds active tracks from memory, ignores unrelated textTracks changes and retries only failed course fetches", async (t) => {
  const dom = new JSDOM("<video></video><div></div>");
  t.after(() => dom.window.close());
  const { document, Event, EventTarget, HTMLTrackElement, URL } = dom.window;
  const video = document.querySelector("video");
  const panel = document.querySelector("div");
  const textTracks = new EventTarget();
  Object.defineProperty(video, "textTracks", { value: textTracks });
  const tracks = new WeakMap();
  Object.defineProperty(HTMLTrackElement.prototype, "track", { get() {
    if (!tracks.has(this)) tracks.set(this, { mode: "disabled", cues: [{ text: "字幕" }] });
    return tracks.get(this);
  } });
  const revoked = [];
  let fileCount = 0;
  URL.createObjectURL = () => "blob:resync/" + ++fileCount;
  URL.revokeObjectURL = (url) => revoked.push(url);
  let fetches = 0;
  let shouldFail = true;
  let trackChanges = 0;
  const controls = bindSubtitles(panel, video, async () => {
    fetches++;
    if (shouldFail) throw new Error("暂时无法读取课程字幕");
    return { text: vtt };
  }, () => { trackChanges++; });

  controls.setSource("lesson-resync");
  controls.ensureCourse();
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(fetches, 1);
  assert.equal(controls.track, null);

  // Without retryCourse, resync does not refetch; with retryCourse, a failed course fetch retries.
  assert.equal(controls.resync(), false);
  shouldFail = false;
  assert.equal(controls.resync({ retryCourse: true }), true);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(fetches, 2);
  const firstTrackEl = video.querySelector("track");
  firstTrackEl.dispatchEvent(new Event("load"));
  const firstTrack = controls.track;
  assert.ok(firstTrack);

  // Unrelated textTracks change (e.g. from paired copy track) does not fire onTrackChange.
  const changesBefore = trackChanges;
  textTracks.dispatchEvent(new Event("change"));
  assert.equal(trackChanges, changesBefore);

  // resync() replaces the <track> element using cached VTT without another network fetch.
  assert.equal(controls.resync(), true);
  assert.equal(fetches, 2);
  const allTracks = video.querySelectorAll("track");
  assert.equal(allTracks.length, 2);
  allTracks[1].dispatchEvent(new Event("load"));
  assert.equal(video.querySelectorAll("track").length, 1);
  assert.notEqual(controls.track, firstTrack);
  assert.equal(revoked.includes("blob:resync/1"), true);

  // Manually turning captions off prevents retryCourse from re-enabling them.
  const select = panel.querySelector("select");
  select.value = "off";
  select.dispatchEvent(new Event("change"));
  assert.equal(controls.resync({ retryCourse: true }), false);
  assert.equal(fetches, 2);
});
