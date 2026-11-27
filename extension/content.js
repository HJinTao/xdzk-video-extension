(() => {
  const key = "__xdzkRecorderV1";
  if (globalThis[key]) return globalThis[key].scan();

  let timer;
  let lastPayload = "";
  let disconnected = false;
  let pageContext = location.href;
  let resourceCutoff = 0;
  let cachedHeadings = [];
  let cachedPageText = "";
  let lastTextReadAt = 0;
  let hasCourseText = false;
  const videoHost = "kdlbptvideo.xidian.edu.cn";
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
    if (pageContext !== location.href) {
      resourceCutoff = performance.now();
      pageContext = location.href;
      cachedHeadings = [];
      cachedPageText = "";
      lastTextReadAt = 0;
      hasCourseText = false;
    }
    const media = pageMedia();
    const now = performance.now();
    // Avoid triggering synchronous innerText layout reflows on every playback DOM mutation.
    if (force || (!hasCourseText && (lastTextReadAt === 0 || now - lastTextReadAt >= 1500))) {
      cachedHeadings = [...document.querySelectorAll("h1, h2")].slice(0, 8).map((node) => node.textContent.trim());
      cachedPageText = (document.body?.innerText || document.body?.textContent || "").slice(0, 10000);
      lastTextReadAt = now;
      hasCourseText = /课程\s*[：:]/.test(cachedPageText);
    }
    const snapshot = {
      url: location.href,
      title: document.title,
      headings: cachedHeadings,
      pageText: cachedPageText,
      media,
      authoritative: media.some((item) => Number.isInteger(item.videoIndex))
    };
    // Do not repeatedly send whole snapshots on video controls / playback timers.
    const signature = JSON.stringify([snapshot.url, snapshot.title, snapshot.headings, snapshot.pageText.slice(0, 700), snapshot.media]);
    if (!force && signature === lastPayload) return { ok: true };
    lastPayload = signature;
    try {
      return await chrome.runtime.sendMessage({ type: "PAGE_SNAPSHOT", snapshot });
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
  window.addEventListener("popstate", schedule);
  globalThis[key] = { scan };
  return scan();
})();
