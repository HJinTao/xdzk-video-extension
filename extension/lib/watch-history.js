import { formatClock, isMediaUrl, isPlatformUrl, recordingInfo, sanitizeName } from "./media.js";

const prefix = "watched:";
export const HISTORY_LIMIT = 50;

// Persist only a school replay entry point and stable camera paths. Query
// parameters on the MP4 belong to the current playback session.
export function replayAddress(value) {
  if (!isPlatformUrl(value)) return "";
  const url = new URL(value);
  if (!url.pathname.startsWith("/xidianpj/")) return "";
  const safe = new URL(url.pathname, url.origin);
  for (const key of ["liveId", "workDetailId", "isStudent", "status", "isshowpl", "noLiveStream"]) {
    const param = url.searchParams.get(key);
    if (/^\d{1,20}$/.test(param || "")) safe.searchParams.set(key, param);
  }
  return safe.searchParams.has("workDetailId") || safe.searchParams.has("liveId") ? safe.href : "";
}

export function cameraPath(url) { return isMediaUrl(url) ? new URL(url).pathname : ""; }

export function watchEntry(title, media, page, samples, updatedAt = Date.now()) {
  const positions = [];
  for (const sample of samples.slice(0, 2)) {
    if (!sample) continue;
    const item = media.find(m => m.key === sample.key);
    const path = cameraPath(item?.url);
    if (!path || !Number.isFinite(sample.time) || sample.time < 0 || !Number.isFinite(sample.duration) || sample.duration <= 0) continue;
    positions.push({ path, time: Math.min(sample.time, sample.duration), duration: sample.duration, updatedAt });
  }
  if (!positions.length) return null;
  const first = media.find(item => cameraPath(item.url) === positions[0].path);
  const pages = [first.frameUrl, page].map(replayAddress).filter(Boolean);
  const exact = pages.find(link => new URL(link).searchParams.has("workDetailId"));
  const ids = exact && new URL(exact).searchParams;
  const id = ids ? `lesson/${ids.get("liveId") || ""}/${ids.get("workDetailId")}` : "video" + cameraPath(media[0].url);
  const info = recordingInfo(first.url);
  return { id, title: sanitizeName(title, "课程录播"), replay: exact || pages[0] || "", recording: [info.date, info.time].filter(Boolean).join(" "), positions, updatedAt };
}

export function resumeInfo(entries, url) {
  const path = cameraPath(url);
  for (const entry of entries) {
    const found = entry.positions.find(p => p.path === path);
    if (found) return { resumeAt: found.time >= found.duration - 1 ? 0 : found.time, resumeStamp: found.updatedAt ?? entry.updatedAt };
  }
  return { resumeAt: null, resumeStamp: 0 };
}

export function createWatchStore(area) {
  let tail = Promise.resolve();
  const serialize = task => {
    const job = tail.then(task);
    tail = job.catch(() => {});
    return job;
  };
  async function entries() {
    const data = await area.get(null);
    return Object.entries(data).filter(([key, item]) => key.startsWith(prefix) && item && Array.isArray(item.positions) && item.positions.length)
      .map(([, item]) => item).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return {
    list: () => tail.then(entries),
    save: entry => serialize(async () => {
      if (!entry) return;
      const key = prefix + entry.id;
      const existing = (await area.get(key))[key];
      if (existing?.updatedAt > entry.updatedAt) return;
      const previous = (existing?.positions || []).filter(old => !entry.positions.some(now => now.path === old.path));
      await area.set({ [key]: { ...entry, positions: [...entry.positions, ...previous].slice(0, 40) } });
      const old = (await entries()).slice(HISTORY_LIMIT);
      if (old.length) await area.remove(old.map(item => prefix + item.id));
    }),
    remove: id => serialize(() => area.remove(prefix + id))
  };
}

// A scan, download, metadata load or automatic resume seek is not a viewing.
export function trackWatching(video, persist) {
  let watched = false, lastAt = 0, lastTime = -1;
  function flush(force = true) {
    if (!watched || !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime)) return;
    const now = Date.now();
    if (lastTime === video.currentTime || (!force && now - lastAt < 5000)) return;
    lastAt = now;
    lastTime = video.currentTime;
    persist(now);
  }
  video.addEventListener("playing", () => { watched = true; flush(); });
  video.addEventListener("timeupdate", () => flush(false));
  for (const event of ["pause", "seeked", "ended"]) video.addEventListener(event, () => flush());
  return {
    flush,
    reset() { flush(); watched = false; lastAt = 0; lastTime = -1; }
  };
}

export function renderWatchList(list, entries, remove, open) {
  const doc = list.ownerDocument;
  list.replaceChildren();
  if (!entries.length) {
    const empty = doc.createElement("li");
    empty.textContent = "还没有观看记录。播放录播后，进度会自动保存在这里。";
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = doc.createElement("li"), name = doc.createElement("strong"), meta = doc.createElement("small");
    const position = entry.positions[0];
    name.textContent = entry.title;
    meta.textContent = [entry.recording, `${formatClock(position.time)} / ${formatClock(position.duration)}`].filter(Boolean).join(" · ");
    const info = doc.createElement("div"); info.append(name, meta); row.append(info);
    if (open) {
      const action = open(entry);
      if (action) row.append(action);
    }
    const button = doc.createElement("button");
    button.type = "button"; button.className = "text-button"; button.textContent = "移除";
    button.setAttribute("aria-label", "移除 " + entry.title);
    button.addEventListener("click", () => remove(entry.id));
    row.append(button); list.append(row);
  }
}
