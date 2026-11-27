import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mediaUrl, pageUrl } from "./fixtures.mjs";

const code = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

function page(html, resources = []) {
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
  const messages = [];
  dom.window.chrome = { runtime: { async sendMessage(message) { messages.push(message); return { ok: true }; } } };
  dom.window.performance.getEntriesByType = () => resources;
  return { dom, messages };
}

test("collects two video elements and source children, ignores untrusted sources", async () => {
  const { dom, messages } = page(`<body>课程：数据库系统 教师：示例<video title="教室" src="${mediaUrl()}"></video><video><source src="${mediaUrl("CloudIPC-demo-b")}"></video><video src="https://evil.test/file.mp4"></video></body>`);
  await dom.window.eval(code);
  assert.equal(messages[0].snapshot.media.length, 2);
  assert.equal(messages[0].snapshot.media[0].suggestedLabel, "教室");
  assert.equal(messages[0].snapshot.media[1].videoIndex, 1);
  await dom.window.eval(code);
  assert.equal(messages.length, 2, "reinjecting forces one scan instead of registering more observers");
  dom.window.close();
});

test("recovers sources requested before installation and picks up dynamic players", async () => {
  const { dom, messages } = page("<body><video src='blob:demo'></video></body>", [{ name: mediaUrl() }]);
  await dom.window.eval(code);
  assert.equal(messages[0].snapshot.media[0].url, mediaUrl());
  const source = dom.window.document.createElement("source");
  source.src = mediaUrl("CloudIPC-demo-b");
  dom.window.document.querySelector("video").append(source);
  await new Promise((done) => setTimeout(done, 440));
  assert.ok(messages.at(-1).snapshot.media.some((media) => media.url === mediaUrl("CloudIPC-demo-b")));
  dom.window.close();
});

test("caches course pageText after first match so playback DOM mutations do not trigger innerText reflows", async () => {
  const { dom, messages } = page(`<body>课程：数据库系统 教师：示例<div id="clock">00:00</div><video src="${mediaUrl()}"></video></body>`);
  let innerTextReads = 0;
  Object.defineProperty(dom.window.document.body, "innerText", {
    configurable: true,
    get() {
      innerTextReads++;
      return "课程：数据库系统 教师：示例";
    }
  });
  await dom.window.eval(code);
  assert.equal(innerTextReads, 1);

  dom.window.document.getElementById("clock").textContent = "00:01";
  const second = dom.window.document.createElement("video");
  second.setAttribute("src", mediaUrl("CloudIPC-demo-b"));
  dom.window.document.body.append(second);
  await new Promise((done) => setTimeout(done, 420));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].snapshot.media.length, 2);
  assert.equal(innerTextReads, 1, "passive mutation scan reuses cached course pageText without calling innerText");

  await dom.window.eval(code);
  assert.equal(innerTextReads, 2, "explicit forced rescan refreshes pageText");
  dom.window.close();
});
