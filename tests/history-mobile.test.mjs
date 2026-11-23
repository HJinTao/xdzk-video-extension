import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { createController } from "../extension/lib/controller.js";
import { mediaKey } from "../extension/lib/media.js";
import { createWatchStore, HISTORY_LIMIT, replayAddress, resumeInfo, watchEntry } from "../extension/lib/watch-history.js";
import { phoneLink, phoneLesson, readPhoneLink } from "../extension/lib/phone-lesson.js";
import { collectReplay, replayBookmark } from "../extension/lib/replay-bookmark.js";
import { webPlayback } from "../extension/lib/web-playback.js";
import { mobileAssets, mobileServer } from "../scripts/mobile-server.mjs";
import { createApi, mediaUrl, snapshot, pageSender, pageUrl, popupSender } from "./fixtures.mjs";

const cameras = snapshot.media.map(m => ({ ...m, key: mediaKey(m.url), frameUrl: pageUrl }));
const sample = (n, time) => ({ key: cameras[n].key, time, duration: 120 });
const lesson = { courseTitle: "数据库系统", replay: pageUrl, media: cameras };

test("only actual playback creates history; restart, rotated signatures, stale frames and deletion", async () => {
  const { api, local } = createApi();
  let controller = createController(api);
  const entries = async () => (await controller.dispatch({ type: "GET_HISTORY" }, popupSender)).entries;
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  assert.equal((await entries()).length, 0);
  const update = { type: "PAGE_WATCH", url: cameras[0].url, time: 37, duration: 120 };
  await controller.dispatch(update, { ...pageSender, documentId: "previous-document" });
  assert.equal((await entries()).length, 0);
  await controller.dispatch(update, pageSender);
  controller = createController(api);
  const [record] = await entries();
  assert.equal(record.positions[0].time, 37);
  assert.equal(record.replay, pageUrl);
  assert.doesNotMatch(JSON.stringify(local), /auth_key|https:\/\/kdlbptvideo/);
  const renewed = mediaUrl("CloudIPC-demo-a", 1800000000);
  const replay = { ...snapshot, media: [{ ...cameras[0], url: renewed }] };
  const opened = await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot: replay }, { ...pageSender, url: pageUrl + "#xdzk-resume" });
  assert.deepEqual(opened.resume, [{ url: renewed, time: 37 }]);
  assert.equal((await controller.dispatch({ type: "REMOVE_HISTORY", key: record.id }, popupSender)).entries.length, 0);
});

test("a lesson keeps both camera positions and the newest camera's timestamp, with bounded history", async () => {
  const { api } = createApi(), store = createWatchStore(api.storage.local);
  const record = (positions, time) => watchEntry("课", cameras, pageUrl, positions, time);
  await store.save(record([sample(0, 50), sample(1, 51)], 100));
  await store.save(record([sample(1, 90)], 110));
  await store.save(record([sample(0, 9)], 101));
  let saved = await store.list();
  assert.equal(saved.length, 1);
  assert.deepEqual(resumeInfo(saved, cameras[0].url), { resumeAt: 50, resumeStamp: 100 });
  assert.deepEqual(resumeInfo(saved, cameras[1].url), { resumeAt: 90, resumeStamp: 110 });
  await store.save(record([sample(1, 120)], 120));
  assert.equal(resumeInfo(await store.list(), cameras[1].url).resumeAt, 0);
  for (let i = 1; i <= HISTORY_LIMIT; i++) {
    const url = pageUrl.replace("200", String(200 + i));
    await store.save(watchEntry("课", [{ ...cameras[0], frameUrl: url }], url, [sample(0, 10)], 200 + i));
  }
  saved = await store.list();
  assert.equal(saved.length, HISTORY_LIMIT);
  assert.ok(saved.every(i => i.replay !== pageUrl));
});

test("one or two signed cameras survive a phone link intact; only stable metadata persists across tabs", async t => {
  const base = "https://player.example/sub/mobile.html";
  const url = cameras[0].url + "&extra=temporary%2Bvalue";
  const original = { ...lesson, replay: pageUrl + "&token=private", media: [{ ...cameras[0], url, resumeAt: 14 }, cameras[1]] };
  const link = new URL(phoneLink(base, original)), opened = readPhoneLink(link.hash);
  assert.equal(link.search, "");
  assert.equal(opened.media[0].url, url);
  assert.equal(opened.replay, pageUrl);
  assert.equal(opened.media[0].resumeAt, 14);
  assert.equal(readPhoneLink(new URL(phoneLink(base, { ...lesson, media: [cameras[1]] })).hash).media.length, 1);
  assert.throws(() => phoneLesson({ media: [cameras[0], cameras[0]] }), /相同/);
  assert.throws(() => phoneLesson({ media: [{ url: "https://example.org/sample.mp4" }] }), /西电/);
  const dom = new JSDOM("", { url: base }); t.after(() => dom.window.close());
  const service = webPlayback(dom.window);
  service.setLesson(opened);
  await service.progress([{ ...sample(0, 42), key: opened.media[0].key }], 120);
  assert.doesNotMatch(JSON.stringify(dom.window.localStorage), /auth_key|temporary|private/);
  dom.window.sessionStorage.clear();
  const later = webPlayback(dom.window);
  assert.equal((await later.history.list()).length, 1);
  await assert.rejects(later.lesson());
  later.setLesson({ ...lesson, media: [{ ...cameras[0], url: mediaUrl("CloudIPC-demo-a", 1800000000) }] });
  assert.equal((await later.lesson()).media[0].resumeAt, 42);
});

test("the mobile app and bookmark read two signed streams from the current school replay", t => {
  const page = new JSDOM("<video></video><video><source></video><iframe></iframe>", { url: pageUrl + "&token=private" });
  t.after(() => page.window.close());
  const doc = page.window.document;
  doc.title = "数据库系统";
  doc.querySelector("video").src = cameras[0].url;
  doc.querySelector("source").src = cameras[1].url;
  const output = collectReplay(doc);
  assert.equal(output.courseTitle, doc.title);
  assert.equal(output.videoCount, 2);
  assert.deepEqual(output.media.map(i => i.url), cameras.map(i => i.url));
  assert.equal(output.replay, pageUrl);
  const standalone = page.window.Function("document", "return (" + collectReplay.toString() + ")(document);");
  assert.deepEqual(standalone(doc), output);
  assert.doesNotThrow(() => new Function(decodeURIComponent(replayBookmark("https://example.org/mobile.html").slice(11))));
  assert.equal(replayAddress("https://example.org/course?liveId=1"), "");
});

test("all mobile files are available from the LAN launcher; signed links never need a server request", async t => {
  const root = resolve(import.meta.dirname, "../extension");
  const server = mobileServer(root);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  for (const asset of mobileAssets) {
    const response = await fetch(base + "/" + asset);
    assert.equal(response.status, 200, asset);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(resolve(root, asset)));
  }
  const page = await fetch(phoneLink(base, lesson));
  assert.match(await page.text(), /手机看课/);
  assert.equal((await fetch(base + "/popup.html")).status, 404);
});
