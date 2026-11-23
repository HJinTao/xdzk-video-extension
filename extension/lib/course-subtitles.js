// Chrome runs this function in the source frame, with that page's login session.
// Keep it self-contained so scripting.executeScript can serialize it.
export async function readCourseSubtitles(mediaKey, frameUrl, observedUrl) {
  const page = new URL(location.href);
  if (frameUrl && frameUrl.split("#")[0] !== page.href.split("#")[0]) return { stale: true };
  const resources = performance.getEntriesByType("resource");
  const parse = (value, base = document.baseURI) => {
    try { return value ? new URL(value, base) : null; } catch { return null; }
  };
  const matchesMedia = (value) => {
    const url = parse(value);
    if (!url) return false;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (name.toLowerCase() === "auth_key") url.searchParams.delete(name);
    }
    url.searchParams.sort();
    return url.href === mediaKey;
  };
  const videos = [...document.querySelectorAll("video")];
  const isMP4 = (value) => /\.mp4$/i.test(parse(value)?.pathname || "");
  const sources = (video) => {
    const current = video.currentSrc || video.src;
    return isMP4(current) ? [current] : [...video.querySelectorAll("source[src]")].map((node) => node.src);
  };
  const video = videos.find((element) => sources(element).some(matchesMedia));
  if (!video && ((videos.length && videos.every((element) => sources(element).some(isMP4))) ||
    !resources.some((entry) => matchesMedia(entry.name)))) return { stale: true };

  const isCaption = (kind) => kind === "subtitles" || kind === "captions";
  const candidates = new Set();
  const allowedFile = (url) => url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
    (url.origin === page.origin || url.hostname === "kdlbptvideo.xidian.edu.cn") && /\.(vtt|srt)$/i.test(url.pathname);
  const lesson = page.searchParams.get("workDetailId");
  const isEndpoint = (url) => url?.origin === page.origin && page.hostname === "newes.chaoxing.com" &&
    /\/getVideoSubtitles2Vtt$/i.test(url.pathname) && (!lesson || url.searchParams.get("workDetailId") === lesson);

  if (video) {
    // Video.js can create an in-memory text track without a <track src>.
    const tracks = Array.from(video.textTracks || []).filter((track) => isCaption(track.kind));
    tracks.sort((a, b) => Number(b.mode === "showing") - Number(a.mode === "showing"));
    for (const track of tracks) {
      const disabled = track.mode === "disabled";
      try {
        if (disabled) track.mode = "hidden";
        const cues = Array.from(track.cues || [], ({ startTime, endTime, text }) => ({ startTime, endTime, text }))
          .filter((cue) => Number.isFinite(cue.startTime) && Number.isFinite(cue.endTime) && cue.endTime > cue.startTime && typeof cue.text === "string" && cue.text.trim());
        if (cues.length) return { cues };
      } finally { if (disabled) track.mode = "disabled"; }
    }
    for (const element of video.querySelectorAll("track[src]")) {
      if (!isCaption(element.getAttribute("kind") || "subtitles")) continue;
      const url = parse(element.src);
      if (allowedFile(url) || isEndpoint(url) || (url?.protocol === "blob:" && url.origin === page.origin)) candidates.add(url.href);
    }
  }
  // The replay frame can request course-level subtitles without creating a DOM track.
  if (isEndpoint(parse(observedUrl))) candidates.add(observedUrl);
  const endpoints = resources.map((entry) => parse(entry.name)).filter(isEndpoint);
  if (lesson || new Set(endpoints.map((url) => url.searchParams.get("workDetailId"))).size === 1) {
    for (const url of endpoints.reverse()) candidates.add(url.href);
  }

  const read = async (url) => {
    const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    return (await response.text()).trim();
  };
  let failed = false;
  const hasTiming = /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->/m;
  for (const address of candidates) {
    try {
      let text = await read(address);
      if (text.startsWith("{") || text.startsWith('"') || text.startsWith("[")) {
        // Some replay versions wrap the VTT or its file link inside JSON.
        let inline, file;
        JSON.parse(text, (_, value) => {
          if (typeof value === "string") {
            if (!inline && hasTiming.test(value)) inline = value;
            else if (!file && /\.(?:vtt|srt)(?:[?#]|$)/i.test(value) && !/\s/.test(value)) {
              const url = parse(value, address);
              if (allowedFile(url)) file = url;
            }
            if (value.includes("请先登录")) failed = true;
          }
          return value;
        });
        text = inline || (file ? await read(file.href) : "");
      }
      if (hasTiming.test(text)) return { text };
      if (/^\s*</.test(text) || text.includes("请先登录")) failed = true;
    } catch { failed = true; }
  }
  return { failed };
}
