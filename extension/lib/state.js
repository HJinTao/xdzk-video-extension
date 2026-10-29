import { inferCourseTitle, isMediaUrl, mediaKey, preferUrl, recordingInfo } from "./media.js";

export function emptyState(tabId) {
  return { tabId, courseTitle: "", titleQuality: 0, titleOverride: "", frames: {}, media: [], updatedAt: 0 };
}

export function sortedMedia(state) {
  return [...state.media].sort((a, b) => (a.frameId - b.frameId) || ((a.videoIndex ?? 999) - (b.videoIndex ?? 999)) || (a.firstSeen - b.firstSeen) || a.key.localeCompare(b.key));
}

export function upsertMedia(state, candidate, now = Date.now()) {
  const key = mediaKey(candidate.url);
  if (!key) return false;
  let media = state.media.find((item) => item.key === key);
  if (!media) {
    if (state.media.length >= 40) return false;
    media = { key, url: candidate.url, frameId: candidate.frameId ?? 0, firstSeen: now, lastSeen: now, label: "", size: 0 };
    state.media.push(media);
  }
  media.url = preferUrl(media.url, candidate.url);
  media.lastSeen = now;
  for (const field of ["frameId", "documentId", "frameUrl", "videoIndex", "width", "height", "duration"]) {
    if (candidate[field] !== undefined && candidate[field] !== null && candidate[field] !== "") media[field] = candidate[field];
  }
  if (Number.isSafeInteger(candidate.size) && candidate.size > 0) media.size = candidate.size;
  if (candidate.source === "dom" && candidate.suggestedLabel && !media.label) media.label = String(candidate.suggestedLabel).slice(0, 48);
  media.camera = recordingInfo(media.url).camera;
  state.updatedAt = now;
  return true;
}

export function applySnapshot(state, snapshot, frame = {}, now = Date.now()) {
  const frameId = frame.frameId ?? 0;
  const previous = state.frames[frameId];
  const documentId = frame.documentId || "";
  const frameUrl = frame.url || snapshot.url || "";
  let changedDocument = previous && documentId && previous.documentId && previous.documentId !== documentId;
  if (previous && previous.url !== frameUrl) changedDocument = true;
  if (changedDocument) {
    state.media = state.media.filter((item) => item.frameId !== frameId || (documentId && item.documentId === documentId));
  }
  state.frames[frameId] = { url: frameUrl, documentId, updatedAt: now };
  if (snapshot.authoritative && Array.isArray(snapshot.media) && snapshot.media.length) {
    const currentKeys = new Set(snapshot.media.map((item) => mediaKey(item.url)).filter(Boolean));
    if (currentKeys.size) state.media = state.media.filter((item) => item.frameId !== frameId || currentKeys.has(item.key));
  }
  const title = inferCourseTitle(snapshot);
  if (title.title && (title.quality > state.titleQuality || (title.quality === state.titleQuality && frameId === 0))) {
    state.courseTitle = title.title;
    state.titleQuality = title.quality;
  }
  for (const item of (Array.isArray(snapshot.media) ? snapshot.media : []).slice(0, 40)) {
    if (!isMediaUrl(item.url)) continue;
    upsertMedia(state, {
      url: item.url, source: "dom", frameId, frameUrl, documentId,
      videoIndex: Number.isInteger(item.videoIndex) ? item.videoIndex : undefined,
      width: Number(item.width) || undefined, height: Number(item.height) || undefined,
      duration: Number.isFinite(item.duration) ? item.duration : undefined,
      suggestedLabel: item.suggestedLabel || ""
    }, now);
  }
  state.updatedAt = now;
  return state;
}
