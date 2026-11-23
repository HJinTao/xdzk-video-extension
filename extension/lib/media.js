export const PLATFORM_HOST = "newes.chaoxing.com";
export const VIDEO_HOST = "kdlbptvideo.xidian.edu.cn";

export function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function isPlatformUrl(value) {
  return parseHttpUrl(value)?.hostname === PLATFORM_HOST;
}

export function isCourseSubtitleUrl(value) {
  const url = parseHttpUrl(value);
  return url?.hostname === PLATFORM_HOST && /\/getVideoSubtitles2Vtt$/i.test(url.pathname) && !!url.searchParams.get("workDetailId");
}

export function isMediaUrl(value) {
  const url = parseHttpUrl(value);
  return !!url && url.hostname === VIDEO_HOST && /\.mp4$/i.test(url.pathname);
}

// Keep the camera directory: two simultaneous recordings can share a basename.
export function mediaKey(value) {
  if (!isMediaUrl(value)) return null;
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "auth_key") url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export function signatureTime(value) {
  try {
    const token = [...new URL(value).searchParams].find(([key]) => key.toLowerCase() === "auth_key")?.[1];
    const stamp = Number(token?.split("-")[0]);
    return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
  } catch {
    return 0;
  }
}

export function preferUrl(previous, next) {
  if (!previous) return next;
  return signatureTime(previous) > signatureTime(next) ? previous : next;
}

export function responseSize(headers = []) {
  const header = (name) => headers.find((item) => item.name?.toLowerCase() === name)?.value || "";
  const total = /\/(\d+)\s*$/.exec(header("content-range"))?.[1];
  const length = Number(total || header("content-length"));
  return Number.isSafeInteger(length) && length > 0 ? length : 0;
}

export function recordingInfo(value) {
  const url = parseHttpUrl(value);
  if (!url) return { date: "", time: "", camera: "" };
  const parts = url.pathname.split("/").filter(Boolean);
  const camera = parts.at(-2) || "";
  const interval = /^(\d{13})-(\d{13})\.mp4$/i.exec(parts.at(-1) || "");
  if (interval) {
    const date = new Date(Number(interval[1]));
    if (!Number.isNaN(date.getTime())) {
      const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(date).map(({ type, value: part }) => [type, part]));
      return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}-${values.minute}`, camera };
    }
  }
  const folder = parts.find((part) => /^20\d{6}$/.test(part));
  return { date: folder ? `${folder.slice(0, 4)}-${folder.slice(4, 6)}-${folder.slice(6)}` : "", time: "", camera };
}

export function sanitizeName(value, fallback = "未命名", maxLength = 72) {
  const clean = String(value || "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  let result = [...clean].slice(0, maxLength).join("").replace(/[. ]+$/g, "");
  if (!result || /^\.+$/.test(result)) result = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result;
}

export function inferCourseTitle(snapshot = {}) {
  const text = String(snapshot.pageText || "").slice(0, 10000);
  const match = /课程\s*[：:]\s*([^\r\n]{1,120})/.exec(text);
  if (match) {
    const course = match[1].split(/\s*(?:教师|地点|班课|人数|进度|排课周)\s*[：:]/)[0].trim();
    if (course) return { title: sanitizeName(course), quality: 3 };
  }
  const generic = /^(课程直播|课程回放|直播回放|个人空间|智课平台|智慧课堂|西电智课|回放|播放页)$/;
  for (const heading of snapshot.headings || []) {
    const title = String(heading).trim();
    if (title && !generic.test(title) && title.length <= 72) return { title: sanitizeName(title), quality: 2 };
  }
  const title = String(snapshot.title || "").trim();
  return title && !generic.test(title) ? { title: sanitizeName(title), quality: 1 } : { title: "", quality: 0 };
}

export function downloadFilename(courseTitle, media, index = 0) {
  const info = recordingInfo(media.url);
  const channel = sanitizeName(media.label, `画面 ${index + 1}`, 32);
  // Always include an ordinal, even if both channels receive the same user label.
  const filename = [info.date, info.time, `${String(index + 1).padStart(2, "0")}_${channel}`].filter(Boolean).join("_");
  return `西电智课/${sanitizeName(courseTitle, "课程录播", 60)}/${filename}.mp4`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小待获取";
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / (1024 ** unit)).toFixed(unit === 1 ? 0 : 1)} ${["B", "KB", "MB", "GB"][unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
