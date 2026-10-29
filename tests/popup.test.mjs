import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createController } from "../extension/lib/controller.js";
import { formatBytes, formatDuration, recordingInfo } from "../extension/lib/media.js";
import { createApi, snapshot, popupSender, pageSender } from "./fixtures.mjs";

const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
const code = (await readFile(new URL("../extension/popup.js", import.meta.url), "utf8")).replace(/^import .+;\r?\n/, "");

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
  fixture.api.scripting.executeScript = async () => { await controller.dispatch({ type: "PAGE_SNAPSHOT", snapshot }, pageSender); return []; };
  Object.assign(dom.window, { chrome: fixture.api, formatBytes, formatDuration, recordingInfo });
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
    document.querySelector("#download-all").click();
    await until(() => downloadCalls.length === 2);
    assert.match(downloadCalls[0].filename, /数据库 第1讲/);
    assert.match(downloadCalls[0].filename, /课件\.mp4$/);
    assert.equal(downloadCalls[0].saveAs, true);
    await until(() => document.querySelectorAll(".download-status:not([hidden])").length === 2);
    assert.equal(document.querySelector(".download-button").disabled, true);
  } finally { dom.window.close(); }
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
