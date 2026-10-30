import test from "node:test";
import assert from "node:assert/strict";
import { SyncPlayer, recordingOffset } from "../extension/lib/sync-player.js";
import { mediaUrl } from "./fixtures.mjs";

class Video extends EventTarget {
  constructor(duration = 120) { super(); this.duration = duration; this.readyState = 4; this.paused = true; this.seeking = false; this.position = 0; this.speed = 1; this.silent = false; }
  emit(type) { this.dispatchEvent(new Event(type)); }
  get currentTime() { return this.position; }
  set currentTime(value) {
    this.position = value; this.seeking = true;
    queueMicrotask(() => this.emit("seeking"));
    queueMicrotask(() => { this.seeking = false; this.emit("seeked"); });
  }
  get playbackRate() { return this.speed; }
  set playbackRate(value) { this.speed = value; queueMicrotask(() => this.emit("ratechange")); }
  get muted() { return this.silent; }
  set muted(value) { this.silent = value; queueMicrotask(() => this.emit("volumechange")); }
  play() {
    if (this.rejectPlay) return Promise.reject(new Error("NotAllowedError"));
    if (!this.paused) return Promise.resolve();
    this.paused = false; queueMicrotask(() => this.emit("play")); return Promise.resolve();
  }
  pause() { if (!this.paused) { this.paused = true; queueMicrotask(() => this.emit("pause")); } }
}
const flush = () => new Promise((done) => setTimeout(done, 10));
function setup(options = {}) {
  const videos = [new Video(), new Video()];
  const errors = [];
  const engine = new SyncPlayer(videos, { interval: 0, onError: (error) => errors.push(error), ...options });
  return { videos, engine, errors };
}

test("seeking either paused video updates the other without an event feedback loop", async () => {
  const { videos, engine } = setup();
  try {
    videos[0].currentTime = 37; await flush();
    assert.equal(videos[1].currentTime, 37);
    videos[1].currentTime = 82; await flush();
    assert.equal(videos[0].currentTime, 82);
    assert.equal(engine.leader, 1);
    assert.equal(engine.wantPlaying, false);
  } finally { engine.destroy(); }
});

test("native play, pause and playback rate changes propagate to both videos", async () => {
  const { videos, engine, errors } = setup();
  try {
    await videos[1].play(); await flush();
    assert.ok(videos.every((video) => !video.paused));
    assert.equal(engine.wantPlaying, true);
    videos[0].playbackRate = 1.5; await flush();
    assert.equal(videos[1].playbackRate, 1.5);
    videos[1].pause(); await flush();
    assert.ok(videos.every((video) => video.paused));
    assert.equal(engine.wantPlaying, false);
    assert.equal(errors.length, 0);
  } finally { engine.destroy(); }
});

test("buffering pauses the pair without losing the intent to resume", async () => {
  const { videos, engine } = setup();
  try {
    await engine.play(); await flush();
    videos[1].readyState = 2; videos[1].emit("waiting"); await flush();
    assert.ok(videos.every((video) => video.paused));
    assert.equal(engine.wantPlaying, true);
    videos[1].readyState = 4; videos[1].emit("canplay"); await flush();
    assert.ok(videos.every((video) => !video.paused));
    assert.equal(engine.buffering.size, 0);
  } finally { engine.destroy(); }
});

test("buffering during an unresolved play ignores the resulting AbortError and resumes", async () => {
  const { videos, engine, errors } = setup();
  const originalPlay = videos[1].play.bind(videos[1]);
  const originalPause = videos[1].pause.bind(videos[1]);
  let rejectPending;
  videos[1].play = function() { this.paused = false; return new Promise((_, reject) => { rejectPending = reject; }); };
  videos[1].pause = function() { originalPause(); rejectPending?.(new Error("AbortError")); };
  try {
    const starting = engine.play();
    videos[1].readyState = 2; videos[1].emit("waiting");
    await starting; await flush();
    assert.equal(engine.wantPlaying, true);
    assert.equal(errors.length, 0);
    videos[1].play = originalPlay;
    videos[1].readyState = 4; videos[1].emit("canplay"); await flush();
    assert.ok(videos.every((video) => !video.paused));
  } finally { engine.destroy(); }
});

test("only the chosen audio stays enabled even if native volume controls unmute the other video", async () => {
  const { videos, engine } = setup();
  try {
    engine.setAudio(1); await flush();
    assert.deepEqual(videos.map((video) => video.muted), [true, false]);
    videos[0].muted = false; await flush();
    assert.deepEqual(videos.map((video) => video.muted), [true, false]);
    engine.setAudio(-1); await flush();
    assert.ok(videos.every((video) => video.muted));
  } finally { engine.destroy(); }
});

test("offsets clamp seeks to the shared interval and support dragging the second video", async () => {
  const { videos, engine } = setup();
  try {
    engine.setOffset(-5); await flush();
    assert.deepEqual(engine.range(), { start: 5, end: 120 });
    assert.deepEqual(videos.map((video) => video.currentTime), [5, 0]);
    videos[1].currentTime = 12; await flush();
    assert.equal(videos[0].currentTime, 17);
    engine.seek(1000); await flush();
    assert.deepEqual(videos.map((video) => video.currentTime), [120, 115]);
    assert.equal(recordingOffset(mediaUrl(), mediaUrl().replace("1789109401000", "1789109406000")), -5);
  } finally { engine.destroy(); }
});

test("drift correction follows the chosen leader and never reverses the user seek", async () => {
  const { videos, engine } = setup();
  try {
    await engine.play(); await flush();
    videos[0].position = 30; videos[1].position = 30.2;
    engine.tick(); await flush();
    assert.equal(videos[1].playbackRate, .96);
    videos[1].position = 32;
    engine.tick(); await flush();
    assert.equal(videos[1].currentTime, 30);
    assert.equal(engine.leader, 0);
    videos[1].currentTime = 60; await flush();
    assert.equal(videos[0].currentTime, 60);
    assert.equal(engine.leader, 1);
  } finally { engine.destroy(); }
});

test("the shorter recording ends the pair and a rejected play leaves both paused", async () => {
  const { videos, engine, errors } = setup();
  try {
    videos[1].duration = 60;
    await engine.play(); await flush();
    videos[0].position = 59.99; videos[1].position = 59.99;
    engine.tick(); await flush();
    assert.equal(engine.wantPlaying, false);
    assert.ok(videos.every((video) => video.paused));
    videos[1].rejectPlay = true;
    await engine.play(); await flush();
    assert.equal(engine.wantPlaying, false);
    assert.ok(videos.every((video) => video.paused));
    assert.equal(errors.length, 1);
  } finally { engine.destroy(); }
});
