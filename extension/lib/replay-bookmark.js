// Kept self-contained so native web views and the optional bookmark can read the open replay.
export function collectReplay(root) {
  if (root.location.hostname !== "newes.chaoxing.com") return null;
  const media = [], visited = new Set(), paths = new Set();
  let videoCount = 0;
  function read(doc) {
    if (!doc || visited.has(doc) || doc.location.hostname !== "newes.chaoxing.com") return;
    visited.add(doc);
    const page = new URL(doc.location.href), replay = new URL(page.pathname, page.origin);
    for (const key of ["liveId", "workDetailId", "isStudent", "status", "isshowpl", "noLiveStream"]) {
      const value = page.searchParams.get(key);
      if (/^\d{1,20}$/.test(value || "")) replay.searchParams.set(key, value);
    }
    for (const video of doc.querySelectorAll("video")) {
      videoCount++;
      for (const src of [video.currentSrc, video.src, ...Array.from(video.querySelectorAll("source[src]"), s => s.src)]) {
        if (!src) continue;
        let url;
        try { url = new URL(src, doc.baseURI); } catch { continue; }
        if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "kdlbptvideo.xidian.edu.cn" || url.username || url.password || !/\.mp4$/i.test(url.pathname)) continue;
        if (!paths.has(url.pathname)) {
          paths.add(url.pathname);
          media.push({ url: url.href, label: video.getAttribute("aria-label") || video.title, frameUrl: replay.href, resumeAt: video.currentTime });
        }
        break;
      }
    }
    for (const frame of doc.querySelectorAll("iframe")) {
      try { read(frame.contentDocument); } catch { /* Only the current school's readable frames participate. */ }
    }
  }
  read(root);
  if (!media.length || media.length > 2) return null;
  const title = (root.body?.innerText || "").match(/课程\s*[：:]\s*([^\r\n]{1,100})/)?.[1]?.split(/教师|地点|班课/)[0].trim() || root.title;
  return { courseTitle: title, replay: media[0].frameUrl, media, videoCount };
}

function openReplay(playerAddress, collect) {
  const lesson = collect(document);
  if (!lesson) { alert("请在智课里进入具体课次，点播放，等一至两路录播画面加载后再使用书签。"); return; }
  const target = new URL(playerAddress);
  target.hash = new URLSearchParams({ lesson: JSON.stringify(lesson) }).toString();
  location.assign(target.href);
}

export function replayBookmark(base) {
  return "javascript:" + encodeURIComponent("(" + openReplay.toString() + ")(" + JSON.stringify(base) + "," + collectReplay.toString() + ")");
}
