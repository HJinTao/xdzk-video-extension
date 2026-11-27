import { MIN_RATE, MAX_RATE } from "./playback-speed.js";

export const COURSE_PREFS_LIMIT = 200;
const SLIDE_PATTERN = /课件|幻灯|投屏|屏幕|桌面|PPT|slides?/i;
const CLASSROOM_PATTERN = /教室|老师|讲台|教师|全景|板书|classroom|teacher/i;

export function channelRole(label = "") {
  const text = String(label || "");
  if (SLIDE_PATTERN.test(text)) return "slide";
  if (CLASSROOM_PATTERN.test(text)) return "classroom";
  return "";
}

export function buildAudioPref(audioIndex, pair = []) {
  if (audioIndex === -1) return { mode: "muted" };
  if (audioIndex !== 0 && audioIndex !== 1) return null;
  const role = channelRole(pair[audioIndex]?.label);
  return role ? { mode: "channel", role, index: audioIndex } : { mode: "channel", index: audioIndex };
}

export function normalizeAudioPref(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.mode === "muted") return { mode: "muted" };
  if (raw.mode === "channel") {
    const index = raw.index === 0 || raw.index === 1 ? raw.index : undefined;
    const role = raw.role === "slide" || raw.role === "classroom" ? raw.role : undefined;
    if (role === undefined && index === undefined) return null;
    const result = { mode: "channel" };
    if (role !== undefined) result.role = role;
    if (index !== undefined) result.index = index;
    return result;
  }
  return null;
}

function normalizeRate(value, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) && num >= MIN_RATE && num <= MAX_RATE ? num : fallback;
}

function normalizeVolume(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) return fallback;
  return Math.round(num * 100) / 100;
}

function normalizeOffset(value) {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) && Math.abs(num) <= 86400 ? num : undefined;
}

function normalizeCourseKey(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export function normalizePlayerPrefs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const courses = {};
  if (source.courses && typeof source.courses === "object") {
    const entries = [];
    for (const [key, value] of Object.entries(source.courses)) {
      const cleanKey = normalizeCourseKey(key);
      if (!cleanKey || !value || typeof value !== "object") continue;
      const audio = normalizeAudioPref(value.audio);
      const offset = normalizeOffset(value.offset);
      if (!audio && offset === undefined) continue;
      const entry = { updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0 };
      if (audio) entry.audio = audio;
      if (offset !== undefined) entry.offset = offset;
      entries.push([cleanKey, entry]);
    }
    if (entries.length > COURSE_PREFS_LIMIT) {
      entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      entries.length = COURSE_PREFS_LIMIT;
    }
    for (const [key, entry] of entries) courses[key] = entry;
  }
  return {
    autoPlayNext: source.autoPlayNext !== false,
    rate: normalizeRate(source.rate, 1),
    volume: normalizeVolume(source.volume, 1),
    captionsEnabled: source.captionsEnabled !== false,
    audio: normalizeAudioPref(source.audio),
    courses
  };
}

/**
 * @param {any} existing
 * @param {Record<string, any>} [patch]
 * @param {number} [now]
 */
export function mergePlayerPrefs(existing, patch = {}, now = Date.now()) {
  const next = normalizePlayerPrefs(existing);
  if (!patch || typeof patch !== "object") return next;

  if (typeof patch.autoPlayNext === "boolean") next.autoPlayNext = patch.autoPlayNext;
  if (patch.rate !== undefined) next.rate = normalizeRate(patch.rate, next.rate);
  if (patch.volume !== undefined) next.volume = normalizeVolume(patch.volume, next.volume);
  if (typeof patch.captionsEnabled === "boolean") next.captionsEnabled = patch.captionsEnabled;

  const hasAudio = Object.prototype.hasOwnProperty.call(patch, "audio");
  const normalizedAudio = hasAudio ? normalizeAudioPref(patch.audio) : undefined;
  if (hasAudio && (normalizedAudio || patch.audio === null)) next.audio = normalizedAudio;

  const courseKey = normalizeCourseKey(patch.courseKey);
  const hasOffset = Object.prototype.hasOwnProperty.call(patch, "offset");
  if (courseKey && (hasAudio || hasOffset)) {
    const entry = { ...(next.courses[courseKey] || {}), updatedAt: now };
    if (hasAudio) {
      if (normalizedAudio) entry.audio = normalizedAudio;
      else if (patch.audio === null) delete entry.audio;
    }
    if (hasOffset) {
      if (patch.offset === null) delete entry.offset;
      else {
        const offset = normalizeOffset(patch.offset);
        if (offset !== undefined) entry.offset = offset;
      }
    }
    if (entry.audio || entry.offset !== undefined) {
      next.courses[courseKey] = entry;
      const entries = Object.entries(next.courses);
      if (entries.length > COURSE_PREFS_LIMIT) {
        entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        next.courses = Object.fromEntries(entries.slice(0, COURSE_PREFS_LIMIT));
      }
    } else {
      delete next.courses[courseKey];
    }
  }
  return next;
}

export function resolveAudioPref(prefs, courseKey = "", pair = []) {
  const cleanKey = normalizeCourseKey(courseKey);
  const candidate = (cleanKey && prefs?.courses?.[cleanKey]?.audio) || prefs?.audio || null;
  if (!candidate) return 0;
  if (candidate.mode === "muted") return -1;
  if (candidate.role) {
    const matched = pair.findIndex((item) => channelRole(item?.label) === candidate.role);
    if (matched >= 0) return matched;
  }
  if (candidate.index === 0 || candidate.index === 1) return candidate.index;
  return 0;
}

export function resolveOffsetPref(prefs, courseKey = "") {
  const cleanKey = normalizeCourseKey(courseKey);
  const value = cleanKey ? prefs?.courses?.[cleanKey]?.offset : undefined;
  return Number.isFinite(value) ? value : undefined;
}
