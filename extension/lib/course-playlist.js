import { isMediaUrl, isPlatformUrl, mediaKey, parseHttpUrl, recordingInfo, sanitizeName } from "./media.js";

export const XIDIAN_FID = "16820";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function extractLiveId(value) {
  const url = parseHttpUrl(value);
  if (!url || !isPlatformUrl(url.href)) return "";
  const liveId = url.searchParams.get("liveId") || "";
  return /^\d{1,20}$/.test(liveId) ? liveId : "";
}

export function extractSourceOrigin(value) {
  const url = parseHttpUrl(value);
  return url && isPlatformUrl(url.href) ? url.origin : "";
}

function toTimestamp(value) {
  if (Number.isFinite(value) && value > 0) return value > 1e11 ? value : value * 1000;
  if (value && typeof value === "object" && Number.isFinite(Number(value.time))) {
    const stamp = Number(value.time);
    return stamp > 1e11 ? stamp : stamp * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e11 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function shanghaiParts(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    shortDate: `${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: WEEKDAYS[weekdayMap[parts.weekday] ?? date.getDay()] || ""
  };
}

export function parseCourseLessons(rawItems = [], now = Date.now()) {
  if (!Array.isArray(rawItems)) return { courseKey: "", courseTitle: "", lessons: [] };
  const seen = new Set();
  const lessons = [];
  let courseCode = "";
  let courseName = "";

  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const rawId = item.id ?? item.liveId;
    const liveId = /^\d{1,20}$/.test(String(rawId ?? "")) ? String(rawId) : "";
    if (!liveId || seen.has(liveId)) continue;
    seen.add(liveId);

    if (!courseCode && item.courseCode) courseCode = String(item.courseCode).trim();
    if (!courseName && item.courseName) courseName = sanitizeName(item.courseName, "", 60);

    const startMs = toTimestamp(item.startTime);
    const endMs = toTimestamp(item.endTime);
    const start = shanghaiParts(startMs);
    const end = shanghaiParts(endMs);
    const week = Number.isFinite(Number(item.days)) && Number(item.days) > 0 ? Number(item.days) : 0;
    const section = item.jie !== undefined && item.jie !== null && String(item.jie).trim() !== ""
      ? String(item.jie).trim() : "";
    const duration = startMs && endMs && endMs > startMs ? Math.round((endMs - startMs) / 1000) : 0;
    const available = !endMs || endMs <= now;

    const customName = typeof item.liveName === "string" ? item.liveName.trim() : "";
    const parts = [];
    if (week) parts.push(`第 ${week} 周`);
    if (start?.weekday) parts.push(start.weekday);
    if (section) parts.push(`第 ${section} 节`);
    const scheduleTitle = parts.join(" ");
    const title = customName && customName !== courseName
      ? customName
      : scheduleTitle || (start ? `${start.date} ${start.time}` : `课次 ${liveId}`);

    lessons.push({
      liveId,
      title,
      courseName: item.courseName ? sanitizeName(item.courseName, "", 60) : courseName,
      courseCode: item.courseCode ? String(item.courseCode).trim() : courseCode,
      week,
      section,
      date: start?.date || "",
      shortDate: start?.shortDate || "",
      weekday: start?.weekday || "",
      timeRange: start && end ? `${start.time}–${end.time}` : start?.time || "",
      startMs,
      endMs,
      duration,
      available
    });
  }

  lessons.sort((a, b) => (a.startMs - b.startMs) || (Number(a.liveId) - Number(b.liveId)));
  lessons.forEach((lesson, index) => { lesson.index = index + 1; });

  const courseTitle = courseName || "";
  const courseKey = courseCode ? `code:${courseCode}` : courseTitle ? `name:${courseTitle}` : lessons[0] ? `live:${lessons[0].liveId}` : "";
  return { courseKey, courseTitle, lessons };
}

export function extractWorkDetailId(html = "") {
  if (typeof html !== "string" || !html) return "";
  for (const pattern of [/workDetailId\s*=\s*['"]?(\d{1,20})/, /workDetailId\s*:\s*['"]?(\d{1,20})/, /workDetailId=(\d{1,20})/]) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return "";
}

export function parsePlayVideoHtml(html, liveId = "") {
  if (typeof html !== "string" || !html.trim()) {
    return { ok: false, reason: "empty", error: "未获取到该课次的视频信息，请重试。" };
  }
  if (html.includes("请先登录") || html.includes("passport2.chaoxing.com")) {
    return { ok: false, reason: "login", error: "西电智课登录已过期，请先在原回放页面重新登录。" };
  }
  if (html.includes("视频回看生成中") || html.includes("需要1-3天处理完成")) {
    return { ok: false, reason: "generating", error: "该课次的视频回看仍在生成中，暂时无法播放。" };
  }
  if (html.includes("无权限") || html.includes("没有权限")) {
    return { ok: false, reason: "denied", error: "当前账号没有观看该课次回放的权限。" };
  }

  let encoded = "";
  for (const pattern of [/var\s+infostr\s*=\s*"([^"]+)"\s*;/, /infostr\s*=\s*"([^"]+)"/, /var\s+infostr\s*=\s*'([^']+)'/]) {
    const match = pattern.exec(html);
    if (match?.[1]) { encoded = match[1]; break; }
  }
  if (!encoded) {
    return { ok: false, reason: "missing", error: "该课次暂无可用的回放视频源。" };
  }

  let info;
  try {
    info = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return { ok: false, reason: "parse", error: "解析课次视频信息失败，请重试。" };
  }

  const videoPath = info?.videoPath;
  if (!videoPath || typeof videoPath !== "object") {
    return { ok: false, reason: "missing", error: "该课次尚未生成双路回放视频。" };
  }

  const now = Date.now();
  const candidates = [
    { url: videoPath.pptVideo, label: "课件", videoIndex: 0 },
    { url: videoPath.teacherTrack, label: "教室", videoIndex: 1 }
  ];
  const media = [];
  for (const entry of candidates) {
    if (typeof entry.url !== "string" || !isMediaUrl(entry.url)) continue;
    const key = mediaKey(entry.url);
    if (!key || media.some((item) => item.key === key)) continue;
    media.push({
      key,
      url: entry.url,
      label: entry.label,
      videoIndex: entry.videoIndex,
      frameId: 0,
      firstSeen: now,
      lastSeen: now,
      size: 0,
      camera: recordingInfo(entry.url).camera,
      liveId: String(liveId || "")
    });
  }

  if (!media.length) {
    return { ok: false, reason: "missing", error: "该课次没有识别到有效的 MP4 视频源。" };
  }
  return { ok: true, media };
}

// Self-contained functions serialized by chrome.scripting.executeScript inside
// the logged-in newes.chaoxing.com page so cookies and origin match seamlessly.
export async function fetchCoursePlaylistInPage(liveId, fid = "16820") {
  try {
    const body = new URLSearchParams({ liveId: String(liveId), fid: String(fid) });
    const response = await fetch(`${location.origin}/xidianpj/live/listSignleCourse`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return { ok: false, error: `课程目录请求失败（HTTP ${response.status}）。` };
    const text = (await response.text()).trim();
    if (!text) return { ok: false, error: "未获取到课程目录。" };
    if (text.includes("请先登录") || text.startsWith("<")) return { ok: false, loginRequired: true, error: "西电智课登录已过期，请先刷新原回放页并重新登录。" };
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return { ok: false, error: "课程目录响应格式异常。" };
    return { ok: true, items: data };
  } catch {
    return { ok: false, error: "读取课程目录失败，请确认原回放页已登录后重试。" };
  }
}

export async function fetchLessonPageInPage(liveId) {
  try {
    const response = await fetch(`${location.origin}/xidianpj/frontLive/playVideo2Keda?liveId=${encodeURIComponent(liveId)}`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(12000)
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "login", error: "西电智课登录已过期，请重新登录后更新视频源。" };
    }
    if (!response.ok) return { ok: false, reason: "network", error: `学校服务暂时不可用（HTTP ${response.status}），请检查网络后重试。` };
    return { ok: true, html: await response.text() };
  } catch {
    return { ok: false, reason: "network", error: "网络连接失败或请求超时，请检查网络后重试。" };
  }
}

export async function fetchLessonSubtitlesInPage(liveId) {
  try {
    const pageUrl = `${location.origin}/xidianpj/live/viewNewCourseLive1?isStudent=1&liveId=${encodeURIComponent(liveId)}`;
    const pageResponse = await fetch(pageUrl, { credentials: "same-origin", signal: AbortSignal.timeout(12000) });
    if (!pageResponse.ok) return { failed: true };
    const html = await pageResponse.text();
    if (html.includes("请先登录")) return { failed: true };
    let workDetailId = "";
    for (const pattern of [/workDetailId\s*=\s*['"]?(\d{1,20})/, /workDetailId\s*:\s*['"]?(\d{1,20})/, /workDetailId=(\d{1,20})/]) {
      const match = pattern.exec(html);
      if (match?.[1]) { workDetailId = match[1]; break; }
    }
    if (!workDetailId) return { failed: false };
    const subUrl = `${location.origin}/xidianpj/smartSupervisor/getVideoSubtitles2Vtt?workDetailId=${encodeURIComponent(workDetailId)}`;
    const subResponse = await fetch(subUrl, { credentials: "same-origin", signal: AbortSignal.timeout(12000) });
    if (!subResponse.ok) return { failed: true };
    let text = (await subResponse.text()).replace(/^\ufeff/, "").trim();
    const hasTiming = /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->/m;
    if (text.startsWith("{") || text.startsWith('"') || text.startsWith("[")) {
      let inline = "";
      try {
        JSON.parse(text, (_, value) => {
          if (typeof value === "string" && !inline && hasTiming.test(value)) inline = value;
          return value;
        });
      } catch { /* ignore malformed JSON */ }
      if (inline) text = inline;
    }
    if (hasTiming.test(text)) return { text };
    if (/^\s*</.test(text) || text.includes("请先登录")) return { failed: true };
    return { failed: false };
  } catch {
    return { failed: true };
  }
}
