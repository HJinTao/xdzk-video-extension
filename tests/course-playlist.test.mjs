import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLiveId,
  extractWorkDetailId,
  parseCourseLessons,
  parsePlayVideoHtml
} from "../extension/lib/course-playlist.js";
import {
  computeWatchStatus,
  createProgressStore,
  mergeWatchProgress,
  resumeTimeFor,
  toggleManualWatched
} from "../extension/lib/watch-progress.js";
import { createController } from "../extension/lib/controller.js";
import { createApi, mediaUrl, pageSender, popupSender, snapshot } from "./fixtures.mjs";

test("extracts liveIds and parses sorted course lessons with availability", () => {
  assert.equal(extractLiveId("http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=12771543"), "12771543");
  assert.equal(extractLiveId("https://example.com/?liveId=123"), "");

  const now = Date.parse("2026-09-15T12:00:00+08:00");
  const parsed = parseCourseLessons([
    {
      id: 202, courseCode: "CS101", courseName: "数据库系统", days: 2, jie: "1-2",
      startTime: { time: Date.parse("2026-09-16T08:30:00+08:00") },
      endTime: { time: Date.parse("2026-09-16T10:05:00+08:00") }
    },
    {
      id: 201, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "3-4",
      startTime: { time: Date.parse("2026-09-09T10:25:00+08:00") },
      endTime: { time: Date.parse("2026-09-09T12:00:00+08:00") }
    },
    { id: 201, courseCode: "CS101", courseName: "数据库系统" }
  ], now);

  assert.equal(parsed.courseKey, "code:CS101");
  assert.equal(parsed.courseTitle, "数据库系统");
  assert.equal(parsed.lessons.length, 2);
  assert.deepEqual(parsed.lessons.map((l) => [l.index, l.liveId, l.available]), [
    [1, "201", true],
    [2, "202", false]
  ]);
  assert.match(parsed.lessons[0].title, /第 1 周.*第 3-4 节/);
  assert.equal(parsed.lessons[0].shortDate, "09-09");
  assert.equal(parsed.lessons[0].timeRange, "10:25–12:00");
});

test("parses playVideo2Keda infostr into dual camera media and handles error pages", () => {
  const ppt = mediaUrl("CloudIPC-ppt", 1700000100);
  const teacher = mediaUrl("CloudIPC-teacher", 1700000100);
  const encoded = encodeURIComponent(JSON.stringify({ videoPath: { pptVideo: ppt, teacherTrack: teacher } }));
  const html = `<script>var infostr = "${encoded}";</script>`;
  const parsed = parsePlayVideoHtml(html, "12771543");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.media.length, 2);
  assert.deepEqual(parsed.media.map((m) => m.label), ["课件", "教室"]);
  assert.equal(parsed.media[0].liveId, "12771543");

  assert.equal(parsePlayVideoHtml("请先登录").reason, "login");
  assert.equal(parsePlayVideoHtml("视频回看生成中，需要1-3天处理完成").reason, "generating");
  assert.equal(extractWorkDetailId(`var workDetailId = '998877';`), "998877");
});

test("watch progress transitions unwatched -> watching -> watched, supports resume and manual toggles", async () => {
  assert.equal(computeWatchStatus(null), "unwatched");
  const watching = mergeWatchProgress(null, { liveId: "101", courseKey: "code:CS101", time: 120, duration: 600, now: 1000 });
  assert.equal(watching.status, "watching");
  assert.equal(resumeTimeFor(watching, 600), 120);

  const autoWatched = mergeWatchProgress(watching, { liveId: "101", courseKey: "code:CS101", time: 545, duration: 600, now: 2000 });
  assert.equal(autoWatched.status, "watched");
  assert.equal(resumeTimeFor(autoWatched, 600), 0);

  // Re-watching from the start preserves watched status.
  const rewatching = mergeWatchProgress(autoWatched, { liveId: "101", courseKey: "code:CS101", time: 30, duration: 600, now: 3000 });
  assert.equal(rewatching.status, "watched");

  const manualUnwatched = toggleManualWatched(rewatching, { liveId: "101", courseKey: "code:CS101", now: 4000 });
  assert.equal(manualUnwatched.status, "unwatched");
  const manualWatched = toggleManualWatched(manualUnwatched, { liveId: "101", courseKey: "code:CS101", now: 5000 });
  assert.equal(manualWatched.status, "watched");

  const { api } = createApi();
  const store = createProgressStore(api.storage.local);
  await store.save({ liveId: "101", courseKey: "code:CS101", time: 60, duration: 600 });
  const toggled = await store.toggleWatched("101", "code:CS101");
  assert.equal(toggled.status, "watched");
  assert.equal((await store.getPrefs()).autoPlayNext, true);
  assert.equal((await store.setPrefs({ autoPlayNext: false })).autoPlayNext, false);
});

test("controller fetches course playlist, switches lessons seamlessly and loads subtitles for switched lessons", async () => {
  const { api, createdTabs } = createApi({
    url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100"
  });
  const pptNext = mediaUrl("CloudIPC-102-ppt", 1700000500);
  const camNext = mediaUrl("CloudIPC-102-cam", 1700000500);
  const encodedNext = encodeURIComponent(JSON.stringify({ videoPath: { pptVideo: pptNext, teacherTrack: camNext } }));

  // Simulate source tab executeScript for playlist, lesson switch, and subtitles.
  api.scripting.executeScript = async ({ func, args }) => {
    const name = func.name;
    if (name === "fetchCoursePlaylistInPage") {
      return [{
        result: {
          ok: true,
          items: [
            { id: 100, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "1-2", startTime: { time: 1700000000000 }, endTime: { time: 1700003600000 } },
            { id: 102, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "3-4", startTime: { time: 1700007200000 }, endTime: { time: 1700010800000 } }
          ]
        }
      }];
    }
    if (name === "fetchLessonPageInPage") {
      assert.equal(args[0], "102");
      return [{ result: { ok: true, html: `<script>var infostr = "${encodedNext}";</script>` } }];
    }
    if (name === "fetchLessonSubtitlesInPage") {
      assert.equal(args[0], "102");
      return [{ result: { text: "WEBVTT\n\n00:01.000 --> 00:03.000\n下一节课字幕" } }];
    }
    return [];
  };

  const controller = createController(api);
  await controller.dispatch({
    type: "PAGE_SNAPSHOT",
    snapshot: { ...snapshot, url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100" }
  }, { ...pageSender, url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100" });

  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  const playerId = new URL(createdTabs[0].url).searchParams.get("id");
  const playerSender = { id: "test-extension", url: createdTabs[0].url };

  const playlist = await controller.dispatch({ type: "GET_PLAYLIST", id: playerId }, playerSender);
  assert.equal(playlist.supported, true);
  assert.equal(playlist.lessons.length, 2);
  assert.equal(playlist.currentLiveId, "100");

  const switched = await controller.dispatch({ type: "LOAD_LESSON", id: playerId, liveId: "102" }, playerSender);
  assert.equal(switched.ok, true);
  assert.equal(switched.currentLiveId, "102");
  assert.deepEqual(switched.media.map((m) => m.label), ["课件", "教室"]);

  const sub = await controller.dispatch({ type: "GET_SUBTITLES", id: playerId, key: switched.media[0].key }, playerSender);
  assert.equal(sub.ok, true);
  assert.match(sub.text, /下一节课字幕/);

  const saved = await controller.dispatch({
    type: "SAVE_PROGRESS", liveId: "102", courseKey: playlist.courseKey, time: 950, duration: 1000, ended: false
  }, playerSender);
  assert.equal(saved.record.status, "watched");

  const toggled = await controller.dispatch({
    type: "TOGGLE_WATCHED", liveId: "102", courseKey: playlist.courseKey
  }, playerSender);
  assert.equal(toggled.record.status, "unwatched");
});

test("controller falls back to authenticated fetch when the source replay tab is closed", async () => {
  const { api, createdTabs } = createApi({
    url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100"
  });
  const pptNext = mediaUrl("CloudIPC-105-ppt", 1700000900);
  const camNext = mediaUrl("CloudIPC-105-cam", 1700000900);
  const encodedNext = encodeURIComponent(JSON.stringify({ videoPath: { pptVideo: pptNext, teacherTrack: camNext } }));

  const fakeFetch = async (url) => {
    if (url.includes("/listSignleCourse")) {
      return {
        ok: true,
        text: async () => JSON.stringify([
          { id: 100, courseCode: "CS101", courseName: "数据库系统", days: 1, jie: "1-2", startTime: { time: 1700000000000 }, endTime: { time: 1700003600000 } },
          { id: 105, courseCode: "CS101", courseName: "数据库系统", days: 2, jie: "1-2", startTime: { time: 1700007200000 }, endTime: { time: 1700010800000 } }
        ])
      };
    }
    if (url.includes("/playVideo2Keda")) {
      return { ok: true, text: async () => `<script>var infostr = "${encodedNext}";</script>` };
    }
    return { ok: false, status: 404, text: async () => "" };
  };

  const controller = createController(api, { fetch: fakeFetch });
  await controller.dispatch({
    type: "PAGE_SNAPSHOT",
    snapshot: { ...snapshot, url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100" }
  }, { ...pageSender, url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100" });

  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  const playerId = new URL(createdTabs[0].url).searchParams.get("id");
  const playerSender = { id: "test-extension", url: createdTabs[0].url };

  // Close the source tab so executeScript fails and fallback fetch handles playlist + lesson switch.
  api.tabs.get = async () => { throw new Error("No tab with id"); };
  const playlist = await controller.dispatch({ type: "GET_PLAYLIST", id: playerId }, playerSender);
  assert.equal(playlist.lessons.length, 2);

  const switched = await controller.dispatch({ type: "LOAD_LESSON", id: playerId, liveId: "105" }, playerSender);
  assert.equal(switched.currentLiveId, "105");
  assert.equal(switched.media.length, 2);
});

test("auto-refresh re-signs expired URLs via playVideo2Keda, keeps labels and tags failure reasons", async () => {
  const { api, createdTabs } = createApi({
    url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100"
  });
  const freshA = mediaUrl("CloudIPC-demo-a", 1700009999);
  const freshB = mediaUrl("CloudIPC-demo-b", 1700009999);
  let htmlMode = "ok";
  api.scripting.executeScript = async ({ func }) => {
    if (func.name === "fetchLessonPageInPage") {
      if (htmlMode === "ok") {
        const encoded = encodeURIComponent(JSON.stringify({ videoPath: { pptVideo: freshA, teacherTrack: freshB } }));
        return [{ result: { ok: true, html: `<script>var infostr = "${encoded}";</script>` } }];
      }
      if (htmlMode === "login") return [{ result: { ok: true, html: "请先登录" } }];
      if (htmlMode === "network") return [{ result: { ok: false, reason: "network", error: "网络连接失败" } }];
    }
    return [];
  };

  const controller = createController(api);
  await controller.dispatch({
    type: "PAGE_SNAPSHOT",
    snapshot: { ...snapshot, url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100" }
  }, { ...pageSender, url: "http://newes.chaoxing.com/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=100" });
  await controller.dispatch({ type: "RENAME_MEDIA", tabId: 1, key: mediaUrl("CloudIPC-demo-a").split("?")[0], value: "自定义课件" }, popupSender);
  await controller.dispatch({ type: "OPEN_PLAYER", tabId: 1 }, popupSender);
  const playerId = new URL(createdTabs[0].url).searchParams.get("id");
  const playerSender = { id: "test-extension", url: createdTabs[0].url };

  // Source tab still holds the old 1700000000 URL; auto refresh fetches fresh 1700009999 directly.
  const refreshed = await controller.dispatch({ type: "GET_PLAYER", id: playerId, refresh: true, auto: true }, playerSender);
  assert.equal(refreshed.ok, true);
  assert.match(refreshed.media[0].url, /1700009999/);
  assert.equal(refreshed.media[0].label, "自定义课件");

  htmlMode = "login";
  await assert.rejects(
    controller.dispatch({ type: "GET_PLAYER", id: playerId, refresh: true, auto: true }, playerSender),
    (err) => err.reason === "login"
  );

  htmlMode = "network";
  await assert.rejects(
    controller.dispatch({ type: "GET_PLAYER", id: playerId, refresh: true, auto: true }, playerSender),
    (err) => err.reason === "network"
  );
});
