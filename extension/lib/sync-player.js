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
  constructor(videos, { onState = () => {}, onError = () => {}, interval = 250 } = {}) {
    if (videos.length !== 2) throw new Error("请选择两路画面。");
    this.videos = videos;
    this.onState = onState;
    this.onError = onError;
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
      this.listen(video, "seeking", () => this.onSeek(index));
      this.listen(video, "seeked", () => {
        if (video.seeking) return;
        delete this.expected[index].seek;
        this.resumeIfReady();
        this.emit();
      });
      // Queued events report the element's current state. Only a change away
      // from the last commanded state is a new native play or pause.
      this.listen(video, "play", () => {
        if (video.paused || this.expected[index].playing === true) return;
        this.leader = index;
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
        if (!this.wantPlaying || video.readyState >= 3 || isBufferedSeek(video)) return;
        this.buffering.add(index);
        this.generation += 1;
        this.pauseElements();
        this.emit();
      });
      this.listen(video, "canplay", () => { this.resumeIfReady(); this.emit(); });
      this.listen(video, "loadedmetadata", () => { this.seek(this.time()); this.emit(); });
      this.listen(video, "durationchange", () => this.emit());
      this.listen(video, "ended", () => { this.pause(); this.emit(); });
      this.listen(video, "error", () => {
        this.pause();
        this.onError(`画面 ${index + 1} 加载失败，请刷新原回放页面、重新识别后更新视频源。`);
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
    const [first, second] = this.videos.map((video) => video.duration);
    if (![first, second].every((duration) => Number.isFinite(duration) && duration > 0)) return null;
    const start = Math.max(0, -this.offset);
    const end = Math.min(first, second - this.offset);
    return end > start ? { start, end } : null;
  }

  time() {
    return Math.max(0, (this.videos[this.leader].currentTime || 0) - (this.leader === 1 ? this.offset : 0));
  }

  setTime(index, value) {
    const video = this.videos[index];
    if (!Number.isFinite(value) || video.readyState < 1) return;
    const target = Math.max(0, Number.isFinite(video.duration) ? Math.min(value, video.duration) : value);
    if (Math.abs(video.currentTime - target) < .035) return;
    this.expected[index].seek = target;
    try { video.currentTime = target; } catch { delete this.expected[index].seek; }
  }

  seek(value) {
    const range = this.range();
    const time = range ? Math.max(range.start, Math.min(value, range.end)) : Math.max(0, value);
    this.videos.forEach((_, index) => this.setTime(index, time + (index === 1 ? this.offset : 0)));
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
    this.leader = 0;
    this.seek(time);
    if (!this.range()) this.pause();
    this.emit();
  }

  setAudio(index) {
    if (![0, 1, -1].includes(index)) return;
    this.audio = index;
    this.enforceAudio();
    this.emit();
  }

  enforceAudio() {
    this.videos.forEach((video, index) => {
      const muted = index !== this.audio;
      if (video.muted !== muted) video.muted = muted;
    });
  }

  pauseElements() {
    this.videos.forEach((video, index) => {
      this.expected[index].playing = false;
      if (!video.paused) video.pause();
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

  async play() {
    if (this.destroyed) return;
    const range = this.range();
    if (!range) { this.pause(); this.onError("请等待两路视频就绪，并确认它们有重叠的播放时间。"); return; }
    if (this.time() >= range.end - .1) {
      if (this.wantPlaying) { this.pause(); return; }
      this.seek(range.start);
    } else this.seek(this.time());
    this.wantPlaying = true;
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
    if (!this.wantPlaying || !this.buffering.size) return;
    if (this.videos.every((video) => video.readyState >= 3 && !video.seeking)) {
      this.buffering.clear();
      void this.play();
    }
  }

  tick() {
    if (this.destroyed) return;
    const range = this.range();
    if (this.wantPlaying && range && this.time() >= range.end - .06) { this.seek(range.end); this.pause(); }
    if (this.wantPlaying && !this.buffering.size && this.videos.every((video) => !video.paused && !video.seeking && video.readyState >= 3)) {
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
