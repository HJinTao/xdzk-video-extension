(() => {
  const params = new URLSearchParams(location.search);
  const unsupported = params.has("unsupported");
  const empty = params.has("empty");
  const playerDemo = location.pathname.endsWith("/player.html");
  const state = {
    ok: true, supported: !unsupported, courseTitle: playerDemo ? "双路同步播放 · 示例视频" : "数据库系统", options: { saveAs: false },
    media: empty ? [] : [0, 1].map((index) => {
      const camera = `CloudIPC-demo-${index ? "b" : "a"}`;
      return {
        key: camera, camera, label: index ? "课件画面" : "教室画面", width: 1920, height: 1080, duration: 3000,
        size: index ? 462123456 : 791215769,
        url: playerDemo ? "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" : `https://kdlbptvideo.xidian.edu.cn/vod/demo/20260911/${camera}/1789109401000-1789112400000.mp4?auth_key=1700000000-0-0-demo`
      };
    })
  };
  window.chrome = {
    tabs: { async query() { return [{ id: 1 }]; }, async create() {} },
    runtime: {
      async sendMessage(message) {
        if (message.type === "GET_SUBTITLES") return { ok: true, text: "WEBVTT\n\n00:00.000 --> 00:02.000\n一朵花正在风中摇曳。\n\n00:02.000 --> 00:05.000\n镜头对准了花瓣。" };
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
