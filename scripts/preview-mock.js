(() => {
  const params = new URLSearchParams(location.search);
  const unsupported = params.has("unsupported");
  const empty = params.has("empty");
  const playerDemo = location.pathname.endsWith("/player.html");
  const demoVideo = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
  const lessons = [
    { liveId: "12771541", index: 1, title: "第 1 周 周一 第 1-2 节", shortDate: "09-07", timeRange: "08:30–10:05", duration: 5700, available: true },
    { liveId: "12771542", index: 2, title: "第 1 周 周三 第 1-2 节", shortDate: "09-09", timeRange: "08:30–10:05", duration: 5700, available: true },
    { liveId: "12771543", index: 3, title: "第 2 周 周一 第 1-2 节", shortDate: "09-14", timeRange: "08:30–10:05", duration: 5700, available: true },
    { liveId: "12771544", index: 4, title: "第 2 周 周三 第 1-2 节", shortDate: "09-16", timeRange: "08:30–10:05", duration: 5700, available: true },
    { liveId: "12771545", index: 5, title: "第 3 周 周一 第 1-2 节", shortDate: "09-21", timeRange: "08:30–10:05", duration: 5700, available: false }
  ];
  const progress = {
    "12771541": { liveId: "12771541", courseKey: "code:CS101", time: 5700, duration: 5700, ratio: 1, status: "watched", manual: false, updatedAt: Date.now() - 86400000 },
    "12771542": { liveId: "12771542", courseKey: "code:CS101", time: 2380, duration: 5700, ratio: 0.42, status: "watching", manual: false, updatedAt: Date.now() - 3600000 }
  };
  const prefs = { autoPlayNext: true, rate: 1, volume: 1, captionsEnabled: true, audio: null, courses: {} };
  let currentLiveId = "12771543";
  const makeMedia = (liveId) => [0, 1].map((index) => {
    const camera = `CloudIPC-demo-${liveId}-${index ? "b" : "a"}`;
    return {
      key: camera, camera, label: index ? "课件画面" : "教室画面", width: 1920, height: 1080, duration: 3000,
      size: index ? 462123456 : 791215769,
      url: playerDemo ? `${demoVideo}#${liveId}-${index}` : `https://kdlbptvideo.xidian.edu.cn/vod/demo/20260911/${camera}/1789109401000-1789112400000.mp4?auth_key=1700000000-0-0-demo`
    };
  });
  const state = {
    ok: true, supported: !unsupported, courseTitle: "数据库系统", liveId: currentLiveId, currentLiveId,
    lessonTitle: lessons[2].title, options: { saveAs: false },
    media: empty ? [] : makeMedia(currentLiveId)
  };
  window.chrome = {
    tabs: { async query() { return [{ id: 1 }]; }, async create() {} },
    runtime: {
      async sendMessage(message) {
        if (message.type === "GET_SUBTITLES") return { ok: true, text: "WEBVTT\n\n00:00.000 --> 00:02.000\n一朵花正在风中摇曳。\n\n00:02.000 --> 00:05.000\n镜头对准了花瓣。" };
        if (message.type === "GET_PLAYLIST") {
          return structuredClone({ ok: true, supported: true, courseKey: "code:CS101", courseTitle: state.courseTitle, currentLiveId, lessons, progress, prefs });
        }
        if (message.type === "LOAD_LESSON") {
          currentLiveId = message.liveId;
          state.currentLiveId = currentLiveId;
          state.media = makeMedia(currentLiveId);
          const found = lessons.find((item) => item.liveId === currentLiveId);
          return structuredClone({ ok: true, courseTitle: state.courseTitle, lessonTitle: found?.title || "", currentLiveId, media: state.media });
        }
        if (message.type === "SAVE_PROGRESS") {
          const ratio = message.ended ? 1 : message.duration > 0 ? Math.min(1, message.time / message.duration) : 0;
          const prev = progress[message.liveId];
          const status = message.ended || ratio >= 0.9 || prev?.status === "watched" ? "watched" : message.time >= 5 ? "watching" : "unwatched";
          progress[message.liveId] = { liveId: message.liveId, courseKey: message.courseKey || "code:CS101", time: message.time, duration: message.duration, ratio, status, manual: false, updatedAt: Date.now() };
          return structuredClone({ ok: true, record: progress[message.liveId] });
        }
        if (message.type === "TOGGLE_WATCHED") {
          const prev = progress[message.liveId];
          const watched = prev?.status !== "watched";
          progress[message.liveId] = { liveId: message.liveId, courseKey: message.courseKey || "code:CS101", time: watched ? (prev?.duration || 0) : 0, duration: prev?.duration || 0, ratio: watched ? 1 : 0, status: watched ? "watched" : "unwatched", manual: true, updatedAt: Date.now() };
          return structuredClone({ ok: true, record: progress[message.liveId] });
        }
        if (message.type === "SET_PLAYER_PREFS") {
          if (typeof message.autoPlayNext === "boolean") prefs.autoPlayNext = message.autoPlayNext;
          if (Number.isFinite(Number(message.rate))) prefs.rate = Number(message.rate);
          if (Number.isFinite(Number(message.volume))) prefs.volume = Number(message.volume);
          if (typeof message.captionsEnabled === "boolean") prefs.captionsEnabled = message.captionsEnabled;
          if (message.audio !== undefined) prefs.audio = message.audio;
          if (message.courseKey && (message.audio !== undefined || message.offset !== undefined)) {
            prefs.courses[message.courseKey] = { ...(prefs.courses[message.courseKey] || {}), ...(message.audio !== undefined ? { audio: message.audio } : {}), ...(message.offset === null ? {} : message.offset !== undefined ? { offset: Number(message.offset) } : {}) };
            if (message.offset === null) delete prefs.courses[message.courseKey].offset;
          }
          return structuredClone({ ok: true, prefs });
        }
        if (message.type === "OPEN_PLAYER") { window.open("/player.html?id=demo", "_blank"); return { ok: true }; }
        if (message.type === "SET_OPTIONS") state.options.saveAs = message.saveAs;
        if (message.type === "SET_TITLE") state.courseTitle = message.value;
        if (message.type === "RENAME_MEDIA") state.media.find((item) => item.key === message.key).label = message.value;
        let started = 0;
        if (["DOWNLOAD_ALL", "DOWNLOAD_MEDIA", "DOWNLOAD_SELECTED"].includes(message.type)) {
          for (const media of state.media) if (message.type === "DOWNLOAD_ALL" || media.key === message.key || message.keys?.includes(media.key)) {
            if (media.download?.state === "in_progress") continue;
            media.download = { id: 1, state: "in_progress", paused: false, bytesReceived: Math.round(media.size * .37), totalBytes: media.size };
            started++;
          }
        }
        if (message.type === "CONTROL_DOWNLOAD") {
          const download = state.media.find((item) => item.key === message.key).download;
          download.paused = message.action === "pause";
        }
        return structuredClone({ ...state, started, failed: 0 });
      }
    }
  };
})();
