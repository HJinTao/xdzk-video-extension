import { MIN_RATE, MAX_RATE } from "./playback-speed.js";

function isBufferedSeek(video) {
  const { buffered, currentTime } = video;
  if (!video.seeking || !buffered) return false;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime < buffered.end(i)) return true;
  }
  return false;
}

export class SyncPlayer {
  constructor(videos, { onState = () => {}, onError = () => {}, onEnded = () => {}, interval = 250 } = {}) {
    if (!Array.isArray(videos) || videos.length < 1 || videos.length > 2) throw new Error("请至少选择一路画面。");
    this.videos = videos;
    this.onState = onState;
    this.onError = onError;
    this.onEnded = onEnded;
    this.offset = 0;
    this.rate = 1;
    this.leader = 0;
    this.wantPlaying = false;
    this.buffering = new Set();
    this.expected = videos.map(() => ({}));
    this.listeners = [];
    this.generation = 0;
    this.destroyed = false;
    videos.forEach((video, index) => {
      const onReady = () => {
        if (this.isReady(index)) this.buffering.delete(index);
        if (this.wantPlaying && this.buffering.size) this.holdReadyPeers();
        this.resumeIfReady();
        this.emit();
      };
      this.listen(video, "seeking", () => this.onSeek(index));
      this.listen(video, "seeked", () => {
        if (video.seeking) return;
        delete this.expected[index].seek;
        onReady();
      });
      // Queued events report the element's current state. Only a change away
      // from the last commanded state is a new native play or pause.
      this.listen(video, "play", () => {
        if (video.paused || this.expected[index].playing === true) return;
        this.leader = this.audio >= 0 ? this.audio : index;
        void this.play();
      });
      this.listen(video, "pause", () => {
        if (!video.paused || this.expected[index].playing === false) return;
        this.pause();
      });
      this.listen(video, "ratechange", () => {
        // Multiple queued ratechange events can all report the latest correction.
        if (Math.abs(video.playbackRate - this.expected[index].rate) < .001) return;
        delete this.expected[index].rate;
        this.setRate(video.playbackRate);
      });
      this.listen(video, "waiting", () => {
        // Chromium also sends waiting while it decodes an already buffered seek.
        if (!this.wantPlaying || video.readyState >= 3 || isBufferedSeek(video) || this.shouldIgnorePeerWait(index)) return;
        this.buffering.add(index);
        this.generation += 1;
        this.holdReadyPeers();
        this.emit();
      });
      this.listen(video, "canplay", onReady);
      this.listen(video, "canplaythrough", onReady);
      this.listen(video, "playing", onReady);
      this.listen(video, "loadedmetadata", () => { this.seek(this.time()); this.emit(); });
      this.listen(video, "durationchange", () => this.emit());
      this.listen(video, "ended", () => {
        if (this.wantPlaying) this.finish();
        else { this.pause(); this.emit(); }
      });
      this.listen(video, "error", () => {
        const wasPlaying = this.wantPlaying;
        this.pause();
        this.onError(`画面 ${index + 1} 加载失败，请刷新原回放页面、重新识别后更新视频源。`, {
          kind: "media",
          index,
          wasPlaying,
          code: video.error?.code || 0
        });
      });
      this.listen(video, "volumechange", () => this.enforceAudio());
    });
    this.audio = 0;
    this.enforceAudio();
    if (interval > 0) this.timer = setInterval(() => this.tick(), interval);
    this.emit();
  }

  listen(target, event, callback) {
    target.addEventListener(event, callback);
    this.listeners.push(() => target.removeEventListener(event, callback));
  }

  range() {
    if (this.videos.length === 1) {
      const duration = this.videos[0].duration;
      return Number.isFinite(duration) && duration > 0 ? { start: 0, end: duration } : null;
    }
    const [first, second] = this.videos.map((video) => video.duration);
    if (![first, second].every((duration) => Number.isFinite(duration) && duration > 0)) return null;
    const start = Math.max(0, -this.offset);
    const end = Math.min(first, second - this.offset);
    return end > start ? { start, end } : null;
  }

  time() {
    const leader = this.leader < this.videos.length ? this.leader : 0;
    return Math.max(0, (this.videos[leader].currentTime || 0) - (leader === 1 ? this.offset : 0));
  }

  setTime(index, value) {
    const video = this.videos[index];
    if (!Number.isFinite(value) || video.readyState < 1) return;
    const target = Math.max(0, Number.isFinite(video.duration) ? Math.min(value, video.duration) : value);
    if (Math.abs(video.currentTime - target) < .035) return;
    this.expected[index].seek = target;
    try { video.currentTime = target; } catch { delete this.expected[index].seek; }
  }

  isReady(index) {
    const video = this.videos[index];
    return video.readyState >= 3 && !video.seeking;
  }

  isFullscreen(index) {
    const fullscreen = this.videos[index]?.ownerDocument?.fullscreenElement;
    return !!(fullscreen && (fullscreen === this.videos[index] || fullscreen.contains?.(this.videos[index])));
  }

  shouldIgnorePeerWait(index) {
    if (this.videos.length < 2) return false;
    return this.isFullscreen(1 - index) && this.videos[index].muted;
  }

  seek(value) {
    const range = this.range();
    const time = range ? Math.max(range.start, Math.min(value, range.end)) : Math.max(0, value);
    this.videos.forEach((_, index) => this.setTime(index, time + (index === 1 ? this.offset : 0)));
    if (this.wantPlaying) {
      if (range && time >= range.end - .06) {
        this.pause();
        return;
      }
      // Release any buffer-hold pause so both videos fetch the new seek target in parallel.
      if (this.buffering.size || this.videos.some((video) => video.paused)) {
        this.buffering.clear();
        void this.play({ align: false });
        return;
      }
    }
    this.emit();
  }

  onSeek(index) {
    const expected = this.expected[index].seek;
    if (Number.isFinite(expected) && Math.abs(this.videos[index].currentTime - expected) < .08) return;
    delete this.expected[index].seek;
    this.leader = index;
    this.seek(this.time());
  }

  setElementRate(index, value) {
    if (Math.abs(this.videos[index].playbackRate - value) < .001) return;
    this.expected[index].rate = value;
    this.videos[index].playbackRate = value;
  }

  setRate(value) {
    if (!Number.isFinite(value) || value < MIN_RATE || value > MAX_RATE) return;
    this.rate = value;
    this.videos.forEach((_, index) => this.setElementRate(index, value));
    this.emit();
  }

  setOffset(value) {
    if (!Number.isFinite(value) || Math.abs(value) > 86400) return;
    const time = this.time();
    this.offset = value;
    this.leader = this.audio >= 0 ? this.audio : 0;
    this.seek(time);
    if (!this.range()) this.pause();
    this.emit();
  }

  setAudio(index) {
    if (index !== -1 && (index < 0 || index >= this.videos.length)) return;
    this.audio = index;
    if (index >= 0 && this.leader !== index) {
      this.leader = index;
      this.setElementRate(index, this.rate);
    }
    this.enforceAudio();
    this.emit();
  }

  enforceAudio() {
    this.videos.forEach((video, index) => {
      const muted = index !== this.audio;
      if (video.muted !== muted) video.muted = muted;
    });
  }

  pauseElement(index) {
    const video = this.videos[index];
    this.expected[index].playing = false;
    if (!video.paused) video.pause();
  }

  pauseElements() {
    this.videos.forEach((_, index) => this.pauseElement(index));
  }

  holdReadyPeers() {
    if (this.videos.length < 2) return;
    // Pause only a ready peer while the other video buffers. Leaving buffering
    // videos unpaused prevents Chromium from stopping range fetches at readyState 2.
    this.videos.forEach((video, index) => {
      const peer = 1 - index;
      if (this.buffering.has(index) && video.paused) {
        this.expected[index].playing = true;
        try { Promise.resolve(video.play()).catch(() => {}); } catch {}
      } else if (this.isReady(index) && !this.buffering.has(index) && this.buffering.has(peer) && !this.shouldIgnorePeerWait(peer)) {
        this.pauseElement(index);
      }
    });
  }

  pause() {
    this.generation += 1;
    this.wantPlaying = false;
    this.buffering.clear();
    this.pauseElements();
    this.videos.forEach((_, index) => this.setElementRate(index, this.rate));
    this.emit();
  }

  async play({ align = true } = {}) {
    if (this.destroyed) return;
    const range = this.range();
    if (!range) {
      this.pause();
      this.onError(this.videos.length === 1 ? "请等待视频就绪后再播放。" : "请等待两路视频就绪，并确认它们有重叠的播放时间。");
      return;
    }
    if (this.time() >= range.end - .1) {
      if (this.wantPlaying) { this.pause(); return; }
      this.seek(range.start);
    } else if (align) {
      this.videos.forEach((_, index) => this.setTime(index, this.time() + (index === 1 ? this.offset : 0)));
    } else if (this.videos.length === 2) {
      const follower = 1 - this.leader;
      const target = this.time() + (follower === 1 ? this.offset : 0);
      if (Math.abs(this.videos[follower].currentTime - target) > .35) this.setTime(follower, target);
    }
    this.wantPlaying = true;
    this.videos.forEach((video) => { if (video.preload !== "auto") video.preload = "auto"; });
    if (this.buffering.size) { this.emit(); return; }
    const generation = ++this.generation;
    const results = await Promise.allSettled(this.videos.map((video, index) => {
      this.expected[index].playing = true;
      if (!video.paused) return Promise.resolve();
      try { return Promise.resolve(video.play()); } catch (error) { return Promise.reject(error); }
    }));
    if (this.destroyed || generation !== this.generation) return;
    if (results.some((result) => result.status === "rejected")) {
      this.pause();
      this.onError("播放未开始，请再次点击“播放”；如果视频源已失效，请更新视频源。");
    }
    this.emit();
  }

  resumeIfReady() {
    if (!this.wantPlaying) return;
    for (const index of [...this.buffering]) {
      if (this.isReady(index) || this.shouldIgnorePeerWait(index)) this.buffering.delete(index);
    }
    if (this.buffering.size) return;
    if (this.videos.every((_, index) => this.isReady(index)) && this.videos.some((video) => video.paused)) {
      void this.play({ align: false });
    }
  }

  finish() {
    if (!this.wantPlaying || this.destroyed) return;
    this.pause();
    this.onEnded();
  }

  tick() {
    if (this.destroyed) return;
    const range = this.range();
    if (this.wantPlaying && range && this.time() >= range.end - .06) {
      this.videos.forEach((_, index) => this.setTime(index, range.end + (index === 1 ? this.offset : 0)));
      this.finish();
      return;
    }
    if (this.wantPlaying) {
      this.resumeIfReady();
      this.videos.forEach((video, index) => {
        if (video.paused && !this.isReady(index) && (this.buffering.has(index) || video.seeking)) {
          this.expected[index].playing = true;
          try { Promise.resolve(video.play()).catch(() => {}); } catch {}
        }
      });
    }
    if (this.videos.length === 2 && this.wantPlaying && !this.buffering.size && this.videos.every((video) => !video.paused && !video.seeking && video.readyState >= 3)) {
      const follower = 1 - this.leader;
      const target = this.time() + (follower === 1 ? this.offset : 0);
      const difference = this.videos[follower].currentTime - target;
      if (Math.abs(difference) > .45) { this.setElementRate(follower, this.rate); this.setTime(follower, target); }
      else {
        const corrected = Math.abs(difference) > .08 ? this.rate * (difference > 0 ? .96 : 1.04) : this.rate;
        this.setElementRate(follower, Math.max(MIN_RATE, Math.min(MAX_RATE, corrected)));
      }
    }
    this.emit();
  }

  emit() {
    if (!this.destroyed) this.onState({ time: this.time(), range: this.range(), playing: this.wantPlaying, buffering: this.buffering.size > 0, rate: this.rate, audio: this.audio, offset: this.offset });
  }

  destroy() {
    this.destroyed = true;
    this.generation += 1;
    clearInterval(this.timer);
    for (const remove of this.listeners) remove();
    this.pauseElements();
  }
}

export function recordingOffset(firstUrl, secondUrl) {
  const start = (url) => { try { return Number(/\/(\d{13})-\d{13}\.mp4$/i.exec(new URL(url).pathname)?.[1]); } catch { return NaN; } };
  const first = start(firstUrl), second = start(secondUrl);
  return Number.isFinite(first) && Number.isFinite(second) ? (first - second) / 1000 : 0;
}
