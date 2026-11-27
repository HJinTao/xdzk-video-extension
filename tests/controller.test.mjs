import test from "node:test";
import assert from "node:assert/strict";
import { createController } from "../extension/lib/controller.js";
import { mediaKey } from "../extension/lib/media.js";
import { createApi, mediaUrl, snapshot, pageSender, popupSender } from "./fixtures.mjs";

const response = (camera = "CloudIPC-demo-a") => ({
  tabId: 1, frameId: 0, documentId: "doc-a", url: mediaUrl(camera), statusCode: 206,
  responseHeaders: [{ name: "Content-Type", value: "video/mp4" }, { name: "Content-Range", value: "bytes 0-31/791215769" }]
});

test("serializes concurrent captures and survives a service-worker restart", async () => {
  const { api } = createApi();
  const controller = createController(api);
  await Promise.all([...Array(12)].map((_, index) => controller.recordResponse(response(index % 2 ? "CloudIPC-demo-a" : "CloudIPC-demo-b"))));
  const nextWorker = createController(api);
  const state = await nextWorker.dispatch({ type: "GET_STATE", tabId: 1 }, popupSender);
  assert.equal(state.media.length, 2);
  assert.ok(state.media.every((media) => media.size === 791215769));
});

test("downloads both cameras with signed URLs, unique filenames, settings and native progress", async () => {
  const { api, downloadCalls, jobs } = createApi();
  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.dispatch({ type: "SET_OPTIONS", saveAs: true }, popupSender);
  let view = await controller.dispatch({ type: "DOWNLOAD_ALL", tabId: 1 }, popupSender);
  assert.equal(view.started, 2);
  assert.equal(downloadCalls.length, 2);
  assert.equal(downloadCalls[0].url, mediaUrl());
  assert.equal(downloadCalls[0].saveAs, true);
  assert.match(downloadCalls[0].filename, /^西电智课\/数据库系统\//);
  assert.notEqual(downloadCalls[0].filename, downloadCalls[1].filename);
  assert.equal((await controller.dispatch({ type: "DOWNLOAD_ALL", tabId: 1 }, popupSender)).started, 0);
  assert.equal(downloadCalls.length, 2);
  jobs.get(1).bytesReceived = 400000000;
  view = await controller.dispatch({ type: "GET_STATE", tabId: 1 }, popupSender);
  assert.equal(view.media[0].download.bytesReceived, 400000000);
  await controller.dispatch({ type: "CONTROL_DOWNLOAD", tabId: 1, key: view.media[0].key, action: "pause" }, popupSender);
  assert.equal(jobs.get(1).paused, true);
  await controller.dispatch({ type: "CONTROL_DOWNLOAD", tabId: 1, key: view.media[0].key, action: "resume" }, popupSender);
  assert.equal(jobs.get(1).paused, false);
});

test("only trusted extension UI can initiate downloads and control its own tasks", async () => {
  const { api, downloadCalls } = createApi();
  const controller = createController(api);
  await assert.rejects(controller.dispatch({ type: "DOWNLOAD_ALL", tabId: 1 }, pageSender), /扩展面板/);
  await assert.rejects(controller.dispatch({ type: "GET_STATE", tabId: 1 }, { ...popupSender, id: "other-extension" }), /来源无效/);
  await assert.rejects(controller.dispatch({ type: "CONTROL_DOWNLOAD", tabId: 1, key: "unowned", action: "cancel" }, popupSender), /找不到下载任务/);
  assert.equal(downloadCalls.length, 0);
});

test("a stale or empty batch cannot silently start a different set of downloads", async () => {
  const { api, downloadCalls } = createApi();
  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  const select = (keys) => controller.dispatch({ type: "DOWNLOAD_SELECTED", tabId: 1, keys }, popupSender);
  const key = mediaKey(mediaUrl());
  await assert.rejects(select([]), /勾选/);
  await assert.rejects(select([key, "old"]), /清单/);
  assert.equal(downloadCalls.length, 0);
  assert.equal((await select([key, key])).started, 1);
  assert.equal(downloadCalls.length, 1);
});

test("ignores failures and unrelated tabs, clears navigation state and removes closed tabs", async () => {
  const { api, session } = createApi();
  const controller = createController(api);
  await controller.recordResponse({ ...response(), statusCode: 403 });
  await controller.recordResponse({ ...response(), statusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
  assert.equal(Object.keys(session).length, 0);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.tabUpdated(1, { status: "loading" });
  assert.equal((await controller.dispatch({ type: "GET_STATE", tabId: 1 }, popupSender)).media.length, 0);
  await controller.recordResponse(response());
  await controller.tabRemoved(1);
  await controller.recordResponse(response());
  assert.equal(session["tab:1"], undefined);
  const unrelated = createApi({ url: "https://example.com/" });
  await createController(unrelated.api).recordResponse(response());
  assert.equal(Object.keys(unrelated.session).length, 0);
});

test("preserves a newer signature, user labels and name edits when old range requests finish", async () => {
  const { api, downloadCalls } = createApi();
  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.dispatch({ type: "RENAME_MEDIA", tabId: 1, key: mediaKey(mediaUrl()), value: "课件" }, popupSender);
  await controller.dispatch({ type: "SET_TITLE", tabId: 1, value: "数据库／第1讲" }, popupSender);
  await controller.recordResponse({ ...response(), url: mediaUrl("CloudIPC-demo-a", 1700000300) });
  await controller.recordResponse(response());
  await controller.dispatch({ type: "DOWNLOAD_MEDIA", tabId: 1, key: mediaKey(mediaUrl()) }, popupSender);
  assert.equal(downloadCalls[0].url, mediaUrl("CloudIPC-demo-a", 1700000300));
  assert.match(downloadCalls[0].filename, /数据库 第1讲/);
  assert.match(downloadCalls[0].filename, /课件\.mp4$/);
});

test("reports start failures per channel instead of losing the successful download", async () => {
  const { api, downloadCalls } = createApi();
  const nativeDownload = api.downloads.download;
  api.downloads.download = async (options) => {
    if (options.url.includes("demo-b")) throw new Error("cancelled");
    return nativeDownload(options);
  };
  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  const view = await controller.dispatch({ type: "DOWNLOAD_ALL", tabId: 1 }, popupSender);
  assert.equal(view.started, 1);
  assert.equal(view.failed, 1);
  assert.equal(downloadCalls.length, 1);
  assert.ok(view.media[1].downloadError);
});

test("opens an independent player without putting signed URLs into browsing history", async () => {
  const { api, createdTabs, session } = createApi();
  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  const url = new URL(createdTabs[0].url);
  assert.equal(url.pathname, "/player.html");
  assert.equal(url.href.includes("auth_key"), false);
  const id = url.searchParams.get("id");
  let data = await controller.dispatch({ type: "GET_PLAYER", id }, popupSender);
  assert.equal(data.media.length, 2);
  assert.equal(data.media[0].url, mediaUrl());
  await controller.recordResponse({ ...response(), url: mediaUrl("CloudIPC-demo-a", 1700000500) });
  data = await controller.dispatch({ type: "GET_PLAYER", id, refresh: true }, popupSender);
  assert.equal(data.media[0].url, mediaUrl("CloudIPC-demo-a", 1700000500));
  await controller.tabRemoved(1);
  assert.equal((await controller.dispatch({ type: "GET_PLAYER", id }, popupSender)).media.length, 2);
  await controller.tabRemoved(createdTabs[0].id);
  assert.equal(session[`player:${id}`], undefined);
  await assert.rejects(controller.dispatch({ type: "GET_PLAYER", id }, popupSender), /记录已清除/);
});

test("an empty tab cannot open the player, a single video can open single-stream playback, and player IDs are validated", async () => {
  const { api, createdTabs } = createApi();
  const controller = createController(api);
  await assert.rejects(controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender), /还没有识别到视频/);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot: { ...snapshot, media: snapshot.media.slice(0, 1) } }, pageSender);
  const opened = await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  assert.equal(opened.ok, true);
  const id = new URL(createdTabs[0].url).searchParams.get("id");
  const data = await controller.dispatch({ type: "GET_PLAYER", id }, popupSender);
  assert.equal(data.media.length, 1);
  await assert.rejects(controller.dispatch({ type: "GET_PLAYER", id: "tab:1" }, popupSender), /地址无效/);
});

test("preview and independent player read subtitles only from the recorded source document", async () => {
  const { api, createdTabs } = createApi();
  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  const request = { type: "GET_SUBTITLES", key: mediaKey(mediaUrl()), tabId: 1 };
  const calls = [];
  let result = { text: "WEBVTT\n\n00:00.000 --> 00:01.000\n字幕" };
  api.scripting.executeScript = async (options) => { calls.push(options); return [{ result }]; };
  assert.equal((await controller.dispatch(request, popupSender)).text, result.text);
  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  const id = new URL(createdTabs[0].url).searchParams.get("id");
  assert.equal((await controller.dispatch({ ...request, tabId: 999, id }, popupSender)).text, result.text);
  assert.ok(calls.every((call) => call.target.tabId === 1 && call.target.documentIds[0] === pageSender.documentId && call.args[1] === pageSender.url));
  await assert.rejects(controller.dispatch({ ...request, key: mediaKey(mediaUrl("other")) }, popupSender), /找不到这个画面/);
  await assert.rejects(controller.dispatch(request, pageSender), /扩展面板/);
  assert.equal(calls.length, 2);
  result = { stale: true };
  await assert.rejects(controller.dispatch(request, popupSender), /对应课次/);
  result = { failed: false };
  await assert.rejects(controller.dispatch(request, popupSender), /没有可用/);
  result = { failed: true };
  await assert.rejects(controller.dispatch(request, popupSender), /已登录/);
});

test("remembers the current frame's subtitle GET before its first scan and drops it on lesson change", async () => {
  const { api, session } = createApi();
  const controller = createController(api);
  const url = new URL("getVideoSubtitles2Vtt?workDetailId=200", pageSender.url).href;
  const request = { ...response(), url, method: "GET", statusCode: 200 };
  await controller.recordResponse(request);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.recordResponse({ ...request, url: url.replace("=200", "=201") });
  await controller.recordResponse({ ...request, documentId: "previous-document", url: url + "&old=1" });
  await controller.recordResponse({ ...request, method: "POST", url: url + "&post=1" });
  await controller.recordResponse({ ...request, url: url.replace("newes.chaoxing.com", "other.test") });
  let observed;
  api.scripting.executeScript = async ({ args }) => { observed = args[2]; return [{ result: { text: "fixture" } }]; };
  await controller.dispatch({ type: "GET_SUBTITLES", tabId: 1, key: mediaKey(mediaUrl()) }, popupSender);
  assert.equal(observed, url);
  const next = pageSender.url.replace("=200", "=201");
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot: { ...snapshot, url: next } }, { ...pageSender, url: next });
  assert.equal(session["tab:1"].frames[0].subtitleUrl, undefined);
});

test("skips redundant session writes and badge updates for unchanged 206 range responses", async () => {
  const { api } = createApi();
  let sessionWrites = 0;
  let badgeUpdates = 0;
  const originalSet = api.storage.session.set.bind(api.storage.session);
  api.storage.session.set = async (values) => { sessionWrites++; return originalSet(values); };
  api.action.setBadgeText = async () => { badgeUpdates++; };

  const controller = createController(api);
  await controller.recordResponse(response("CloudIPC-demo-a"));
  assert.equal(sessionWrites, 1);
  assert.equal(badgeUpdates, 1);

  for (let i = 0; i < 8; i++) await controller.recordResponse(response("CloudIPC-demo-a"));
  assert.equal(sessionWrites, 1);
  assert.equal(badgeUpdates, 1);

  // A newer signature still triggers a write.
  await controller.recordResponse({ ...response("CloudIPC-demo-a"), url: mediaUrl("CloudIPC-demo-a", 1700000900) });
  assert.equal(sessionWrites, 2);
  assert.equal(badgeUpdates, 2);
});

test("independent player falls back to authenticated subtitle fetch for its initial lesson when the source tab is closed", async () => {
  const { api, createdTabs } = createApi();
  const fakeFetch = async (url) => {
    if (url.includes("/viewNewCourseLive1")) return { ok: true, text: async () => "var workDetailId = '555666';" };
    if (url.includes("/getVideoSubtitles2Vtt?workDetailId=555666")) {
      return { ok: true, text: async () => "WEBVTT\n\n00:01.000 --> 00:03.000\n兜底字幕内容" };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
  const controller = createController(api, { fetch: fakeFetch });
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  const id = new URL(createdTabs[0].url).searchParams.get("id");
  const playerSender = { id: "test-extension", url: createdTabs[0].url };

  // Close the source tab so scripting.executeScript cannot reach the original frame.
  api.tabs.get = async () => { throw new Error("No tab with id"); };
  const sub = await controller.dispatch({ type: "GET_SUBTITLES", id, key: mediaKey(mediaUrl()) }, playerSender);
  assert.equal(sub.ok, true);
  assert.match(sub.text, /兜底字幕内容/);
});

test("prunes expired player session records when opening a new player", async () => {
  const { api, session } = createApi();
  const staleId = "00000000-0000-4000-8000-000000000001";
  const freshId = "00000000-0000-4000-8000-000000000002";
  session[`player:${staleId}`] = { createdAt: Date.now() - 25 * 60 * 60 * 1000, media: [] };
  session[`player:${freshId}`] = { createdAt: Date.now() - 1000, media: [] };

  const controller = createController(api);
  await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender);
  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);

  assert.equal(session[`player:${staleId}`], undefined);
  assert.ok(session[`player:${freshId}`]);
});
