import test from "node:test";
import assert from "node:assert/strict";
import { mediaKey, isMediaUrl, isPlatformUrl, preferUrl, responseSize, recordingInfo, sanitizeName, inferCourseTitle, downloadFilename } from "../extension/lib/media.js";
import { applySnapshot, emptyState, upsertMedia } from "../extension/lib/state.js";
import { mediaUrl, snapshot, pageUrl } from "./fixtures.mjs";

test("deduplicates range requests and refreshed signatures while retaining the camera directory", () => {
  assert.equal(mediaKey(mediaUrl()), mediaKey(mediaUrl("CloudIPC-demo-a", 1700000300)));
  assert.notEqual(mediaKey(mediaUrl()), mediaKey(mediaUrl("CloudIPC-demo-b")));
  assert.equal(preferUrl(mediaUrl("CloudIPC-demo-a", 1700000300), mediaUrl()), mediaUrl("CloudIPC-demo-a", 1700000300));
  const state = emptyState(1);
  for (let i = 0; i < 10; i++) upsertMedia(state, { url: mediaUrl(), size: 791215769 });
  upsertMedia(state, { url: mediaUrl("CloudIPC-demo-b") });
  assert.equal(state.media.length, 2);
});

test("restricts resources to the observed platform and media host", () => {
  assert.equal(isMediaUrl(mediaUrl()), true);
  for (const value of ["javascript:alert(1)", "file:///tmp/a.mp4", "https://evil.test/a.mp4", "https://kdlbptvideo.xidian.edu.cn.evil.test/a.mp4", "https://user:pass@kdlbptvideo.xidian.edu.cn/a.mp4", "https://kdlbptvideo.xidian.edu.cn/a.m3u8"]) assert.equal(isMediaUrl(value), false);
  assert.equal(isPlatformUrl(pageUrl), true);
  assert.equal(isPlatformUrl("http://newes.chaoxing.com.evil.test/"), false);
});

test("uses the complete file length from a 206 response", () => {
  assert.equal(responseSize([{ name: "Content-Length", value: "32" }, { name: "Content-Range", value: "bytes 0-31/791215769" }]), 791215769);
  assert.equal(responseSize([{ name: "content-length", value: "42" }]), 42);
  assert.equal(responseSize([{ name: "Content-Range", value: "bytes 0-31/*" }]), 0);
});

test("extracts course metadata and uses China time for recording filenames", () => {
  assert.equal(inferCourseTitle(snapshot).title, "数据库系统");
  assert.equal(inferCourseTitle({ title: "课程直播" }).quality, 0);
  const info = recordingInfo(mediaUrl());
  assert.equal(info.date, "2026-09-11");
  assert.equal(info.time, "14-50");
  assert.equal(info.camera, "CloudIPC-demo-a");
  const filename = downloadFilename("数据库系统", { url: mediaUrl(), label: "课件" }, 1);
  assert.equal(filename, "西电智课/数据库系统/2026-09-11_14-50_02_课件.mp4");
});

test("makes valid Windows names and distinguishes identical channel labels", () => {
  assert.equal(sanitizeName("../CON: / 数据库?*  ."), ".. CON 数据库");
  assert.equal(sanitizeName("CON"), "_CON");
  assert.equal(sanitizeName(".."), "未命名");
  assert.equal(sanitizeName("中文".repeat(100), "", 12).length, 12);
  assert.notEqual(downloadFilename("课程", { url: mediaUrl(), label: "课件" }, 0), downloadFilename("课程", { url: mediaUrl("CloudIPC-demo-b"), label: "课件" }, 1));
});

test("removes the previous frame document and preserves metadata on repeated discovery", () => {
  const state = emptyState(1);
  applySnapshot(state, snapshot, { frameId: 2, documentId: "old", url: pageUrl });
  upsertMedia(state, { url: mediaUrl(), size: 791215769 });
  applySnapshot(state, snapshot, { frameId: 2, documentId: "old", url: pageUrl });
  assert.equal(state.media.length, 2);
  assert.equal(state.media[0].size, 791215769);
  applySnapshot(state, { ...snapshot, media: [{ url: mediaUrl("new-lesson") }] }, { frameId: 2, documentId: "new", url: pageUrl.replace("liveId=100", "liveId=101") });
  assert.equal(state.media.length, 1);
  assert.equal(state.media[0].camera, "new-lesson");
});

test("a changing player replaces the current frame's previous lesson while retaining other frames", () => {
  const state = emptyState(1);
  applySnapshot(state, snapshot, { frameId: 2, documentId: "same-doc", url: pageUrl });
  applySnapshot(state, { ...snapshot, media: [{ url: mediaUrl("other-frame") }] }, { frameId: 3, documentId: "other-doc", url: pageUrl });
  applySnapshot(state, { ...snapshot, authoritative: true, media: [{ url: mediaUrl("new-current") }] }, { frameId: 2, documentId: "same-doc", url: pageUrl });
  assert.deepEqual(state.media.map((media) => media.camera).sort(), ["new-current", "other-frame"]);
});
