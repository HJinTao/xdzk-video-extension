import Artplayer from "../vendor/artplayer/artplayer.js";
import { PRESET_RATES } from "./playback-speed.js";

Artplayer.PLAYBACK_RATE = [...PRESET_RATES];
Artplayer.RECONNECT_TIME_MAX = 0; // The replay page supplies a fresh signed URL when requested.

export function createLecturePlayer(video, url) {
  return new Artplayer({
    container: video.parentElement,
    proxy: () => video,
    url,
    lang: "zh-cn",
    theme: "#57c4b6",
    volume: 1,
    muted: video.muted,
    mutex: false,
    fullscreen: true,
    setting: true,
    playbackRate: true,
    playsInline: true,
    moreVideoAttr: { controls: false, preload: video.preload }
  });
}
