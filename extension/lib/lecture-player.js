import Artplayer from "../vendor/artplayer/artplayer.js";
import { PRESET_RATES } from "./playback-speed.js";

Artplayer.PLAYBACK_RATE = [...PRESET_RATES];
Artplayer.RECONNECT_TIME_MAX = 0; // The replay page supplies a fresh signed URL when requested.

export function createLecturePlayer(video, url, { hotkey = true } = {}) {
  const player = new Artplayer({
    container: video.parentElement,
    proxy: () => video,
    url,
    lang: "zh-cn",
    theme: "#88baff",
    volume: 1,
    muted: video.muted,
    mutex: false,
    hotkey,
    fullscreen: true,
    setting: true,
    playbackRate: true,
    playsInline: true,
    moreVideoAttr: { controls: false, preload: video.preload }
  });
  // Artplayer shows the center play mask on every video:seeked until the next
  // timeupdate; suppress that flicker while playback is active.
  player.on("video:seeked", () => {
    if (!video.paused) player.mask.show = false;
  });
  return player;
}
