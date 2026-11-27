import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createController } from "../extension/lib/controller.js";
import { formatBytes, formatDuration, recordingInfo } from "../extension/lib/media.js";
import { bindSubtitles } from "../extension/lib/subtitles.js";
import { bindPlaybackSpeed } from "../extension/lib/playback-speed.js";
import { computeWatchStatus } from "../extension/lib/watch-progress.js";
import { createApi, createPlayerStub, snapshot, popupSender, pageSender, mediaUrl } from "./fixtures.mjs";

const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
const code = (await readFile(new URL("../extension/popup.js", import.meta.url), "utf8")).replace(/^import .+;\r?$/gm, "");

async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for popup state");
    await new Promise((done) => setTimeout(done, 15));
  }
}

async function mount(options = {}) {
  const fixture = createApi(options);
  const controller = createController(fixture.api);
  const dom = new JSDOM(html, { url: popupSender.url, runScripts: "outside-only", pretendToBeVisual: true });
  fixture.api.runtime.sendMessage = (message) => controller.dispatch(message, popupSender);
  fixture.api.scripting.executeScript = async () => { await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot: options.snapshot ?? snapshot }, pageSender); return []; };
  Object.assign(dom.window, { chrome: fixture.api, formatBytes, formatDuration, recordingInfo, bindSubtitles, bindPlaybackSpeed, computeWatchStatus, createLecturePlayer: createPlayerStub });
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  let clipboard = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { async writeText(value) { clipboard = value; } } });
  dom.window.eval(code);
  return { ...fixture, dom, controller, clipboard: () => clipboard, document: dom.window.document };
}

test("popup scans the existing page, previews on demand and copies complete signed links", async () => {
  const fixture = await mount();
  const { document, dom } = fixture;
  try {
    await until(() => document.querySelectorAll(".media-card").length === 2);
    assert.equal(document.querySelector("#course-name").value, "数据库系统");
    const card = document.querySelector(".media-card");
    card.querySelector(".file-tools").click();
    assert.equal(card.querySelector("video").getAttribute("src"), null, "no network request is made for an unopened preview");
    card.querySelector(".preview-button").click();
    assert.equal(card.querySelector(".preview").hidden, false);
    assert.match(card.querySelector("video").src, /auth_key=/);
    card.querySelector(".preview-button").click();
    assert.equal(card.querySelector("video").getAttribute("src"), null);
    card.querySelector(".copy-button").click();
    await until(() => document.querySelector("#notice").textContent.includes("已复制完整视频链接"));
    assert.match(fixture.clipboard(), /auth_key=/);
  } finally { dom.window.close(); }
});

test("editing names immediately before downloading uses the edited filenames and save setting", async () => {
  const { document, dom, downloadCalls } = await mount();
  try {
    await until(() => document.querySelectorAll(".media-card").length === 2 && !document.querySelector("#scan").disabled);
    const course = document.querySelector("#course-name");
    course.value = "数据库：第1讲";
    course.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const channel = document.querySelector(".channel-name");
    channel.value = "课件";
    channel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const saveAs = document.querySelector("#save-as");
    saveAs.checked = true;
    saveAs.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    document.querySelector("#download-selected").click();
    await until(() => downloadCalls.length === 2);
    assert.match(downloadCalls[0].filename, /数据库 第1讲/);
    assert.match(downloadCalls[0].filename, /课件\.mp4$/);
    assert.equal(downloadCalls[0].saveAs, true);
    await until(() => document.querySelectorAll(".download-status:not([hidden])").length === 2);
    assert.equal(document.querySelector(".download-button").disabled, true);
  } finally { dom.window.close(); }
});

test("rescans show progress in the button and display a banner only when there is a notice", async (t) => {
  const { dom, document, api } = await mount();
  t.after(() => dom.window.close());
  const scan = document.querySelector("#scan");
  const label = document.querySelector("#scan-label");
  const notice = document.querySelector("#notice");
  await until(() => document.querySelectorAll(".media-card").length === 2 && !scan.disabled);

  let finish;
  api.scripting.executeScript = () => new Promise(resolve => { finish = resolve; });
  scan.click();
  await until(() => !!finish);
  assert.equal(label.textContent, "识别中…");
  assert.equal(notice.hidden, true);
  finish([]);
  await until(() => !scan.disabled);
  assert.equal(label.textContent, "重新识别");
  assert.equal(notice.hidden, true);
  assert.equal(document.querySelector("#summary").textContent, "已识别 2 路画面");

  api.scripting.executeScript = async () => { throw new Error("frame unavailable"); };
  scan.click();
  await until(() => !notice.hidden && !scan.disabled);
  assert.match(notice.textContent, /重新识别/);
  assert.equal(label.textContent, "重新识别");
});

test("native pause/resume and interrupted download hints are visible in the popup", async () => {
  const { document, dom, jobs } = await mount();
  try {
    await until(() => document.querySelectorAll(".media-card").length === 2 && !document.querySelector("#scan").disabled);
    document.querySelector(".download-button").click();
    await until(() => document.querySelector(".control-button").textContent === "暂停");
    await until(() => !document.querySelector("#scan").disabled);
    document.querySelector(".control-button").click();
    await until(() => document.querySelector(".control-button").textContent === "继续下载");
    assert.equal(jobs.get(1).paused, true);
    await until(() => !document.querySelector("#scan").disabled);
    document.querySelector(".control-button").click();
    await until(() => jobs.get(1).paused === false);
    Object.assign(jobs.get(1), { state: "interrupted", error: "SERVER_FORBIDDEN", canResume: false });
    await until(() => !document.querySelector(".card-error").hidden);
    assert.match(document.querySelector(".card-error").textContent, /刷新回放/);
    assert.equal(document.querySelector(".download-button").disabled, false);
  } finally { dom.window.close(); }
});

test("unsupported pages explain where to open the extension", async () => {
  const { document, dom } = await mount({ url: "https://example.com/" });
  try {
    await until(() => document.querySelector("#unsupported").hidden === false);
    assert.equal(document.querySelector("#workspace").hidden, true);
    assert.match(document.querySelector("#unsupported").textContent, /课程回放/);
  } finally { dom.window.close(); }
});

test("the popup opens synchronized playback in a new tab without starting a download", async () => {
  const { document, dom, createdTabs, downloadCalls } = await mount();
  try {
    await until(() => document.querySelectorAll(".media-card").length === 2 && !document.querySelector("#open-player").disabled);
    document.querySelector("#open-player").click();
    await until(() => document.querySelector("#notice").textContent.includes("同步播放"));
    assert.match(createdTabs[0].url, /player\.html\?id=/);
    assert.equal(downloadCalls.length, 0);
  } finally { dom.window.close(); }
});

test("a single-camera preview can load a local subtitle into the popup document", async () => {
  const { document, dom } = await mount({ snapshot: { ...snapshot, media: snapshot.media.slice(0, 1) } });
  const { URL, HTMLTrackElement, Event } = dom.window;
  URL.createObjectURL = () => "blob:preview-subtitle";
  URL.revokeObjectURL = () => {};
  const track = { mode: "disabled", cues: [{ text: "示例" }] };
  Object.defineProperty(HTMLTrackElement.prototype, "track", { get: () => track });
  try {
    await until(() => document.querySelector(".media-card"));
    const card = document.querySelector(".media-card");
    card.querySelector(".preview-button").click();
    const input = card.querySelector('.subtitles input[type="file"]');
    Object.defineProperty(input, "files", { value: [{ name: "课程.srt", text: async () => "1\n00:00:01,000 --> 00:00:02,000\n示例" }] });
    input.dispatchEvent(new Event("change"));
    await until(() => card.querySelector("track"));
    card.querySelector("track").dispatchEvent(new Event("load"));
    assert.equal(track.mode, "showing");
    assert.equal(card.querySelector(".subtitle-mode").selectedOptions[0].textContent, "课程.srt");
  } finally { dom.window.close(); }
});

test("a single recording enables single-stream playback and can still be downloaded while empty pages disable playback", async () => {
  const { document, dom, createdTabs } = await mount({ snapshot: { ...snapshot, media: snapshot.media.slice(0, 1) } });
  try {
    await until(() => document.querySelector(".media-card") && !document.querySelector("#scan").disabled);
    const watch = document.querySelector("#open-player");
    assert.equal(watch.closest(".course-section") !== null, true);
    assert.equal(watch.disabled, false);
    assert.equal(document.querySelector("#open-player-label").textContent, "单画面看课");
    assert.match(document.querySelector("#summary").textContent, /单画面看课/);
    assert.equal(document.querySelector("#download-selected").disabled, false);
    assert.equal(document.querySelector(".download-button").disabled, false);
    assert.doesNotMatch(document.body.textContent, /云盘/);
    watch.click();
    await until(() => document.querySelector("#notice").textContent.includes("单画面看课") && !document.querySelector("#scan").disabled);
    assert.equal(createdTabs.length, 1);
  } finally { dom.window.close(); }

  const empty = await mount({ snapshot: { ...snapshot, media: [] } });
  try {
    await until(() => !empty.document.querySelector("#empty").hidden && !empty.document.querySelector("#scan").disabled);
    assert.equal(empty.document.querySelector("#open-player").disabled, true);
  } finally { empty.dom.window.close(); }
});

test("the checklist totals known and unknown sizes, keeps the user's subset and downloads only checked files", async (t) => {
  const { dom, document, controller, downloadCalls } = await mount();
  t.after(() => dom.window.close());
  const checks = () => [...document.querySelectorAll(".file-check")];
  const total = document.getElementById("selection-total");
  const all = document.getElementById("select-all");
  const download = document.getElementById("download-selected");
  const record = (camera, bytes) => controller.recordResponse({
    tabId: 1, frameId: 0, documentId: "doc-a", url: mediaUrl(camera), statusCode: 206,
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }, { name: "Content-Range", value: "bytes 0-31/" + bytes }]
  });
  await until(() => checks().length === 2 && !download.disabled);
  assert.equal(all.checked, true);
  assert.match(total.textContent, /2 个文件.*大小待获取/);
  await record("CloudIPC-demo-b", 1024 * 1024);
  await until(() => total.textContent.includes("至少 1.0 MB"));
  all.click();
  assert.equal(download.disabled, true);
  assert.match(total.textContent, /0 个文件.*0 B/);
  checks()[1].click();
  assert.equal(all.indeterminate, true);
  assert.equal(total.textContent, "已选 1 个文件 · 1.0 MB");
  await record("CloudIPC-demo-c", 4096);
  await until(() => checks().length === 3);
  assert.deepEqual(checks().map(input => input.checked), [false, true, false]);
  download.click();
  await until(() => downloadCalls.length > 0 && !document.getElementById("scan").disabled);
  assert.deepEqual(downloadCalls.map(job => job.url), [mediaUrl("CloudIPC-demo-b")]);
});

test("popup shows course playlist progress summary when the course list is available", async (t) => {
  const { dom, document, api } = await mount();
  t.after(() => dom.window.close());
  const originalExecute = api.scripting.executeScript;
  api.scripting.executeScript = async (details) => {
    if (details.func?.name === "fetchCoursePlaylistInPage") {
      return [{
        result: {
          ok: true,
          items: [
            { id: 100, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "1-2", startTime: { time: 1700000000000 }, endTime: { time: 1700003600000 } },
            { id: 101, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "3-4", startTime: { time: 1700007200000 }, endTime: { time: 1700010800000 } }
          ]
        }
      }];
    }
    return originalExecute(details);
  };
  await api.storage.local.set({ "watchProgress:v1": { "100": { liveId: "100", status: "watched", ratio: 1 } } });
  document.querySelector("#scan").click();
  await until(() => !document.querySelector("#playlist-progress").hidden);
  assert.equal(document.querySelector("#playlist-progress").textContent, "同课程 2 节 · 已看 1 节");
});

test("popup respects manual unwatched status via computeWatchStatus and reacts to session storage events", async (t) => {
  const listeners = new Set();
  const fixture = await mount();
  const { dom, document, api, controller } = fixture;
  t.after(() => dom.window.close());

  const originalExecute = api.scripting.executeScript;
  api.scripting.executeScript = async (details) => {
    if (details.func?.name === "fetchCoursePlaylistInPage") {
      return [{
        result: {
          ok: true,
          items: [
            { id: 100, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "1-2", startTime: { time: 1700000000000 }, endTime: { time: 1700003600000 } },
            { id: 101, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "3-4", startTime: { time: 1700007200000 }, endTime: { time: 1700010800000 } }
          ]
        }
      }];
    }
    return originalExecute(details);
  };
  await api.storage.local.set({
    "watchProgress:v1": {
      "100": { liveId: "100", status: "unwatched", manual: true, ratio: 0.95 },
      "101": { liveId: "101", status: "watched", ratio: 1 }
    }
  });
  document.querySelector("#scan").click();
  await until(() => !document.querySelector("#playlist-progress").hidden);
  assert.equal(document.querySelector("#playlist-progress").textContent, "同课程 2 节 · 已看 1 节");

  // Also verify storage.onChanged event path updates UI immediately without waiting for the 1.2s timer.
  const dom2 = new JSDOM(html, { url: popupSender.url, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom2.window.close());
  const eventFixture = createApi();
  const eventController = createController(eventFixture.api);
  eventFixture.api.storage.onChanged = {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); }
  };
  const origSet = eventFixture.api.storage.session.set.bind(eventFixture.api.storage.session);
  eventFixture.api.storage.session.set = async (values) => {
    await origSet(values);
    const changes = Object.fromEntries(Object.keys(values).map((k) => [k, { newValue: values[k] }]));
    for (const fn of listeners) fn(changes, "session");
  };
  eventFixture.api.runtime.sendMessage = (message) => eventController.dispatch(message, popupSender);
  eventFixture.api.scripting.executeScript = async () => { await eventController.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender); return []; };
  Object.assign(dom2.window, { chrome: eventFixture.api, formatBytes, formatDuration, recordingInfo, bindSubtitles, bindPlaybackSpeed, computeWatchStatus, createLecturePlayer: createPlayerStub });
  dom2.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  dom2.window.HTMLMediaElement.prototype.pause = () => {};
  dom2.window.HTMLMediaElement.prototype.load = () => {};
  dom2.window.eval(code);

  await until(() => dom2.window.document.querySelectorAll(".media-card").length === 2);
  const before = Date.now();
  await eventController.recordResponse({
    tabId: 1, frameId: 0, documentId: "doc-a", url: mediaUrl("CloudIPC-demo-c"), statusCode: 206,
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }, { name: "Content-Range", value: "bytes 0-31/4096" }]
  });
  await until(() => dom2.window.document.querySelectorAll(".media-card").length === 3);
  assert.ok(Date.now() - before < 800, "storage.onChanged refreshes popup without waiting for 1200ms poll");
  assert.equal(listeners.size, 1);
  dom2.window.dispatchEvent(new dom2.window.Event("pagehide"));
  assert.equal(listeners.size, 0);
});
