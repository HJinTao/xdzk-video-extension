export const WATCHED_RATIO = 0.9;
export const MIN_WATCH_SECONDS = 5;
export const RESUME_END_MARGIN = 10;
export const PROGRESS_LIMIT = 500;
export const PROGRESS_KEY = "watchProgress:v1";
export const PREFS_KEY = "playerPrefs:v1";

export function computeWatchStatus(record) {
  if (!record || typeof record !== "object") return "unwatched";
  if (record.status === "watched") return "watched";
  if (record.manual && record.status === "unwatched") return "unwatched";
  const ratio = Number(record.ratio) || 0;
  const time = Number(record.time) || 0;
  if (ratio >= WATCHED_RATIO) return "watched";
  if (time >= MIN_WATCH_SECONDS) return "watching";
  return "unwatched";
}

export function resumeTimeFor(record, duration = 0) {
  if (!record || computeWatchStatus(record) !== "watching") return 0;
  const time = Number(record.time) || 0;
  const total = Number.isFinite(duration) && duration > 0 ? duration : Number(record.duration) || 0;
  if (time < MIN_WATCH_SECONDS) return 0;
  if (total > 0 && time >= Math.max(0, total - RESUME_END_MARGIN)) return 0;
  return time;
}

export function mergeWatchProgress(existing, { liveId, courseKey = "", time = 0, duration = 0, ended = false, now = Date.now() }) {
  const id = String(liveId || "");
  if (!id) return null;
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : Number(existing?.duration) || 0;
  const rawTime = Number.isFinite(time) && time >= 0 ? time : 0;
  const clampedTime = safeDuration > 0 ? Math.min(rawTime, safeDuration) : rawTime;
  const ratio = ended ? 1 : safeDuration > 0 ? Math.min(1, clampedTime / safeDuration) : Number(existing?.ratio) || 0;

  const wasWatched = computeWatchStatus(existing) === "watched";
  let status = "unwatched";
  if (ended || ratio >= WATCHED_RATIO || wasWatched) status = "watched";
  else if (clampedTime >= MIN_WATCH_SECONDS) status = "watching";

  return {
    liveId: id,
    courseKey: courseKey || existing?.courseKey || "",
    time: ended && safeDuration > 0 ? safeDuration : clampedTime,
    duration: safeDuration,
    ratio: status === "watched" ? Math.max(ratio, existing?.ratio || 0, ended ? 1 : WATCHED_RATIO) : ratio,
    status,
    manual: status === "watched" && wasWatched && !!existing?.manual && !ended && ratio < WATCHED_RATIO,
    updatedAt: now
  };
}

export function toggleManualWatched(existing, { liveId, courseKey = "", now = Date.now() }) {
  const id = String(liveId || "");
  if (!id) return null;
  const currentlyWatched = computeWatchStatus(existing) === "watched";
  if (currentlyWatched) {
    return {
      liveId: id,
      courseKey: courseKey || existing?.courseKey || "",
      time: 0,
      duration: Number(existing?.duration) || 0,
      ratio: 0,
      status: "unwatched",
      manual: true,
      updatedAt: now
    };
  }
  const duration = Number(existing?.duration) || 0;
  return {
    liveId: id,
    courseKey: courseKey || existing?.courseKey || "",
    time: duration || Number(existing?.time) || 0,
    duration,
    ratio: 1,
    status: "watched",
    manual: true,
    updatedAt: now
  };
}

export function createProgressStore(storageArea) {
  let chain = Promise.resolve();
  const serialize = (task) => {
    const next = chain.then(task);
    chain = next.catch(() => {});
    return next;
  };

  async function readMap() {
    const raw = (await storageArea.get({ [PROGRESS_KEY]: {} }))[PROGRESS_KEY];
    return raw && typeof raw === "object" ? { ...raw } : {};
  }

  async function writeMap(map) {
    const entries = Object.entries(map);
    if (entries.length > PROGRESS_LIMIT) {
      entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
      map = Object.fromEntries(entries.slice(0, PROGRESS_LIMIT));
    }
    await storageArea.set({ [PROGRESS_KEY]: map });
    return map;
  }

  return {
    getAll: () => chain.then(readMap),
    save: (update) => serialize(async () => {
      const map = await readMap();
      const id = String(update?.liveId || "");
      if (!id) return null;
      const merged = mergeWatchProgress(map[id], update);
      if (!merged) return null;
      map[id] = merged;
      await writeMap(map);
      return merged;
    }),
    toggleWatched: (liveId, courseKey = "") => serialize(async () => {
      const map = await readMap();
      const id = String(liveId || "");
      if (!id) return null;
      const toggled = toggleManualWatched(map[id], { liveId: id, courseKey });
      if (!toggled) return null;
      map[id] = toggled;
      await writeMap(map);
      return toggled;
    }),
    getPrefs: () => chain.then(async () => {
      const stored = (await storageArea.get({ [PREFS_KEY]: {} }))[PREFS_KEY];
      return { autoPlayNext: stored?.autoPlayNext !== false };
    }),
    setPrefs: (patch = {}) => serialize(async () => {
      const stored = (await storageArea.get({ [PREFS_KEY]: {} }))[PREFS_KEY] || {};
      const next = { autoPlayNext: stored.autoPlayNext !== false };
      if (typeof patch.autoPlayNext === "boolean") next.autoPlayNext = patch.autoPlayNext;
      await storageArea.set({ [PREFS_KEY]: next });
      return next;
    })
  };
}
