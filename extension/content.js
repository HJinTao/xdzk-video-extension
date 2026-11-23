(() => {
  const key = "__xdzkRecorderV1";
  if (globalThis[key]) return globalThis[key].scan();

  let timer;
  let lastPayload = "";
  let disconnected = false;
  let pageContext = location.href;
  let resourceCutoff = 0;
  const videoHost = "kdlbptvideo.xidian.edu.cn";
  const watched = new Map();
  const resumed = new WeakMap();
  const videoUrl = video => video.currentSrc || video.src || video.querySelector("source[src]")?.src || "";
  const pageMedia = () => {
    const media = [];
    const add = (value, attributes = {}) => {
      try {
        const url = new URL(value, location.href);
        if (!["http:", "https:"].includes(url.protocol) || url.hostname !== videoHost || !/\.mp4$/i.test(url.pathname)) return false;
        if (!media.some((item) => item.url === url.href)) media.push({ url: url.href, ...attributes });
        return true;
      } catch { return false; }
    };
    [...document.querySelectorAll("video")].forEach((video, videoIndex) => {
      const attributes = {
        videoIndex,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        suggestedLabel: video.getAttribute("aria-label") || video.getAttribute("title") || ""
      };
      if (!add(video.currentSrc || video.getAttribute("src"), attributes)) {
        video.querySelectorAll("source").forEach((source) => add(source.getAttribute("src"), attributes));
      }
    });
    // Also recover already requested sources when the extension was installed mid-playback.
    if (!media.length) for (const entry of performance.getEntriesByType("resource")) {
      if ((entry.startTime || 0) >= resourceCutoff) add(entry.name);
    }
    return media.slice(0, 40);
  };

  const scan = async (force = true) => {
    if (disconnected) return { ok: false };
    if (pageContext !== location.href) { resourceCutoff = performance.now(); pageContext = location.href; }
    const media = pageMedia();
    const snapshot = {
      url: location.href,
      title: document.title,
      headings: [...document.querySelectorAll("h1, h2")].slice(0, 8).map((node) => node.textContent.trim()),
      pageText: (document.body?.innerText || document.body?.textContent || "").slice(0, 10000),
      media,
      authoritative: media.some((item) => Number.isInteger(item.videoIndex))
    };
    // Do not repeatedly send whole snapshots on video controls / playback timers.
    const signature = JSON.stringify([snapshot.url, snapshot.title, snapshot.headings, snapshot.pageText.slice(0, 700), snapshot.media]);
    if (!force && signature === lastPayload) return { ok: true };
    lastPayload = signature;
    try {
      const response = await chrome.runtime.sendMessage({ type: "PAGE_SNAPSHOT", snapshot });
      if (response?.resume?.length && location.href === snapshot.url) {
        for (const video of document.querySelectorAll("video")) {
          const url = videoUrl(video);
          const position = response.resume.find(item => item.url === url)?.time;
          const path = url && new URL(url, location.href).pathname;
          if (position > 0 && video.readyState >= 1 && resumed.get(video) !== path) {
            resumed.set(video, path);
            video.currentTime = Math.min(position, video.duration || position);
          }
        }
      }
      return response;
    } catch {
      // A reload invalidates old content-script contexts; let the new instance take over.
      disconnected = true;
      observer.disconnect();
      clearTimeout(timer);
      return { ok: false };
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void scan(false); }, 350);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "title", "aria-label"] });
  document.addEventListener("loadedmetadata", schedule, true);
  document.addEventListener("durationchange", schedule, true);
  function progress(video, event) {
    if (disconnected || !(video instanceof HTMLVideoElement)) return;
    const url = videoUrl(video);
    let playback = watched.get(video);
    if (event === "playing" && playback?.url !== url) {
      playback = { url, at: 0, time: -1 };
      watched.set(video, playback);
      void scan(false);
    }
    if (!playback || playback.url !== url || !url || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const at = Date.now();
    if (playback.time === video.currentTime || (event === "timeupdate" && at - playback.at < 5000)) return;
    playback.time = video.currentTime;
    playback.at = at;
    void chrome.runtime.sendMessage({ type: "PAGE_WATCH", url, time: video.currentTime, duration: video.duration, at }).catch(() => {});
  }
  for (const event of ["playing", "timeupdate", "seeked", "pause", "ended"]) {
    document.addEventListener(event, e => progress(e.target, event), true);
  }
  const flush = () => { for (const video of watched.keys()) { if (video.isConnected) progress(video, "flush"); else watched.delete(video); } };
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
  window.addEventListener("popstate", schedule);
  globalThis[key] = { scan };
  return scan();
})();
