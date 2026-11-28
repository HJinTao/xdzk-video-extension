import test from "node:test";
import assert from "node:assert/strict";
import { SyncPlayer, recordingOffset } from "../extension/lib/sync-player.js";
import { mediaUrl } from "./fixtures.mjs";

class Video extends EventTarget {
  seekNumber = 0;
  constructor(duration = 120) { super(); this.duration = duration; this.readyState = 4; this.paused = true; this.seeking = false; this.position = 0; this.speed = 1; this.silent = false; }
  emit(type) { this.dispatchEvent(new Event(type)); }
  get currentTime() { return this.position; }
  set currentTime(value) {
    const seek = ++this.seekNumber;
    this.position = value; this.seeking = true;
    queueMicrotask(() => this.emit("seeking"));
    queueMicrotask(() => {
      if (seek !== this.seekNumber) return;
      this.seeking = false;
      this.emit("seeked");
    });
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

test("buffered skips from the shared controls and either video keep both views playing", async (t) => {
  const { videos, engine } = setup();
  t.after(() => engine.destroy());
  let pauses = 0;
  for (const video of videos) {
    video.buffered = { length: 2, start: (i) => [0, 10][i], end: (i) => [5, 100][i] };
    video.addEventListener("pause", () => { pauses++; });
    video.addEventListener("seeking", () => { video.readyState = 1; video.emit("waiting"); });
    video.addEventListener("seeked", () => { video.readyState = 4; video.emit("canplay"); });
  }
  await engine.play();
  engine.seek(engine.time() + 10);
  engine.seek(engine.time() + 10);
  await flush();
  videos[1].currentTime += 5;
  await flush();
  videos[0].currentTime -= 5;
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [20, 20]);
  assert.equal(pauses, 0);
  assert.ok(engine.wantPlaying && videos.every((v) => !v.paused));

  engine.pause();
  engine.seek(40);
  await flush();
  assert.ok(!engine.wantPlaying && videos.every((v) => v.paused));
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

test("buffering holds only the ready peer so the buffering video keeps fetching and resumes together", async () => {
  const { videos, engine } = setup();
  try {
    await engine.play(); await flush();
    assert.ok(videos.every((video) => video.preload === "auto"));
    videos[1].readyState = 2; videos[1].emit("waiting"); await flush();
    assert.equal(videos[0].paused, true);
    assert.equal(videos[1].paused, false);
    assert.equal(engine.wantPlaying, true);
    videos[1].readyState = 4; videos[1].emit("canplay"); await flush();
    assert.ok(videos.every((video) => !video.paused));
    assert.equal(engine.buffering.size, 0);
  } finally { engine.destroy(); }
});

test("overlapping waits resume together unless the viewer pauses during buffering", async (t) => {
  const { videos, engine } = setup();
  t.after(() => engine.destroy());
  await engine.play();
  for (const cancel of [false, true]) {
    for (const video of videos) { video.readyState = 2; video.emit("waiting"); }
    await flush();
    assert.equal(engine.wantPlaying, true);
    assert.ok(videos.every((v) => !v.paused));
    videos[0].readyState = 4; videos[0].emit("canplay");
    assert.equal(videos[0].paused, true);
    assert.equal(videos[1].paused, false);
    if (cancel) {
      engine.pause();
      assert.ok(videos.every((v) => v.paused));
    }
    videos[1].readyState = 4; videos[1].emit("canplay");
    await flush();
    assert.equal(engine.wantPlaying, !cancel);
    assert.ok(videos.every((v) => v.paused === cancel));
  }
});

test("finishing a buffered jump at the shared end waits for an explicit replay", async (t) => {
  const { videos, engine } = setup();
  t.after(() => engine.destroy());
  videos[1].duration = 60;
  await engine.play();
  videos[1].readyState = 2;
  videos[1].emit("waiting");
  engine.seek(75);
  await flush();
  videos[1].readyState = 4;
  videos[1].emit("canplay");
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [60, 60]);
  assert.ok(!engine.wantPlaying && videos.every((v) => v.paused));

  await engine.play();
  await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [0, 0]);
  assert.ok(engine.wantPlaying && videos.every((v) => !v.paused));
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
    videos[0].readyState = 2; videos[0].emit("waiting");
    await starting; await flush();
    assert.equal(engine.wantPlaying, true);
    assert.equal(errors.length, 0);
    videos[1].play = originalPlay;
    videos[0].readyState = 4; videos[0].emit("canplay"); await flush();
    assert.ok(videos.every((video) => !video.paused));
  } finally { engine.destroy(); }
});

test("unbuffered seeks keep seeking videos unpaused and auto-resume once buffered", async (t) => {
  const { videos, engine } = setup();
  t.after(() => engine.destroy());
  await engine.play();
  await flush();
  for (const video of videos) {
    video.buffered = { length: 1, start: () => 0, end: () => 15 };
  }
  engine.seek(60);
  for (const video of videos) {
    video.readyState = 1;
    video.emit("waiting");
  }
  await flush();
  // Neither seeking video is paused while fetching the unbuffered range.
  assert.equal(engine.wantPlaying, true);
  assert.ok(videos.every((v) => !v.paused));

  // If one finishes first, it waits briefly while the slower peer stays unpaused.
  videos[0].readyState = 4; videos[0].emit("canplay");
  await flush();
  assert.equal(videos[0].paused, true);
  assert.equal(videos[1].paused, false);

  // Even if canplay is missed and only playing or tick arrives, playback resumes.
  videos[1].readyState = 4;
  engine.tick();
  await flush();
  assert.equal(engine.wantPlaying, true);
  assert.equal(engine.buffering.size, 0);
  assert.ok(videos.every((v) => !v.paused));

  // Seeking again while a peer is held releases the hold immediately.
  videos[1].readyState = 2; videos[1].emit("waiting");
  await flush();
  assert.equal(videos[0].paused, true);
  videos[1].readyState = 4;
  engine.seek(80);
  await flush();
  assert.ok(engine.wantPlaying && videos.every((v) => !v.paused));
});

test("seeking in fullscreen does not pause the visible video when the hidden muted peer buffers", async (t) => {
  const { videos, engine } = setup();
  t.after(() => engine.destroy());
  const fakeDoc = { fullscreenElement: videos[0] };
  videos.forEach((video) => { video.ownerDocument = fakeDoc; });
  let pauses = 0;
  videos[0].addEventListener("pause", () => { pauses++; });
  await engine.play();
  await flush();
  engine.seek(50);
  videos[1].readyState = 1;
  videos[1].emit("waiting");
  await flush();
  assert.equal(pauses, 0);
  assert.equal(engine.wantPlaying, true);
  assert.equal(videos[0].paused, false);
  assert.equal(engine.buffering.size, 0);
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
    videos[1].emit("ratechange");
    assert.equal(engine.rate, 1, "a second event reporting a correction must not change the requested speed");
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

test("switching audio promotes the audible video to leader so drift correction only nudges the muted peer", async (t) => {
  const { videos, engine } = setup();
  t.after(() => engine.destroy());
  await engine.play(); await flush();
  videos[0].position = 20; videos[1].position = 20.2;
  engine.tick(); await flush();
  assert.equal(videos[1].playbackRate, .96);

  engine.setAudio(1); await flush();
  assert.equal(engine.leader, 1);
  assert.equal(videos[1].playbackRate, 1);

  videos[0].position = 25; videos[1].position = 25.2;
  engine.tick(); await flush();
  assert.equal(videos[1].playbackRate, 1);
  assert.equal(videos[0].playbackRate, 1.04);
});

test("single-video SyncPlayer supports play, seek, rate, mute, buffering and ended cleanly", async (t) => {
  const video = new Video(90);
  let endedCount = 0;
  const errors = [];
  const engine = new SyncPlayer([video], {
    interval: 0,
    onError: (err) => errors.push(err),
    onEnded: () => { endedCount++; }
  });
  t.after(() => engine.destroy());

  assert.deepEqual(engine.range(), { start: 0, end: 90 });
  await engine.play(); await flush();
  assert.equal(engine.wantPlaying, true);
  assert.equal(video.paused, false);
  assert.equal(video.muted, false);

  engine.seek(30); await flush();
  assert.equal(video.currentTime, 30);
  engine.setRate(1.5); await flush();
  assert.equal(video.playbackRate, 1.5);
  engine.setAudio(-1); await flush();
  assert.equal(video.muted, true);
  engine.setAudio(0); await flush();
  assert.equal(video.muted, false);

  video.readyState = 2; video.emit("waiting"); await flush();
  assert.equal(engine.wantPlaying, true);
  assert.equal(video.paused, false);
  video.readyState = 4; video.emit("canplay"); await flush();
  assert.equal(engine.buffering.size, 0);

  video.position = 89.99;
  engine.tick(); await flush();
  assert.equal(engine.wantPlaying, false);
  assert.equal(endedCount, 1);
  assert.equal(errors.length, 0);
});

test("SyncPlayer supports initial offset, resync force-seek and sleep-gap wake detection", async (t) => {
  const emittedOffsets = [];
  const wakeEvents = [];
  const videos = [new Video(120), new Video(120)];
  let seekCounts = [0, 0];
  videos.forEach((video, index) => {
    video.addEventListener("seeking", () => { seekCounts[index]++; });
  });
  const engine = new SyncPlayer(videos, {
    interval: 0,
    offset: -5,
    sleepGapMs: 1000,
    onState: (state) => emittedOffsets.push(state.offset),
    onWake: (detail) => wakeEvents.push(detail)
  });
  t.after(() => engine.destroy());

  // Initial state reports the configured offset directly without flapping through 0.
  assert.deepEqual(emittedOffsets, [-5]);

  engine.seek(30); await flush();
  assert.deepEqual(videos.map((v) => v.currentTime), [30, 25]);
  seekCounts = [0, 0];

  // forceSeek: false skips seeking aligned videos, while forceSeek: true forces a seek flush.
  engine.resync({ forceSeek: false }); await flush();
  assert.deepEqual(seekCounts, [0, 0]);

  // Simulate a temporary drift-correction rate on the follower and verify resync restores engine.rate.
  engine.setElementRate(1, 1.04); await flush();
  assert.equal(videos[1].playbackRate, 1.04);
  engine.resync({ forceSeek: true }); await flush();
  assert.deepEqual(seekCounts, [1, 1]);
  assert.deepEqual(videos.map((v) => v.playbackRate), [1, 1]);
  assert.equal(engine.wantPlaying, false);

  // Simulating a wall-clock sleep gap triggers onWake once.
  engine.lastTickAt = Date.now() - 5000;
  engine.tick();
  assert.equal(wakeEvents.length, 1);
  assert.ok(wakeEvents[0].gapMs >= 5000);
  engine.tick();
  assert.equal(wakeEvents.length, 1);
});
