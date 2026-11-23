import { createWatchStore, resumeInfo, watchEntry } from "./watch-history.js";
import { phoneLesson } from "./phone-lesson.js";

const sessionKey = "xdzk:active-lesson";
const ns = "xdzk:";

export function webPlayback(view) {
  const area = {
    async get(key) {
      const keys = key === null ? Object.keys(view.localStorage).filter(k => k.startsWith(ns + "watched:")).map(k => k.slice(ns.length)) : [key];
      const result = {};
      for (const k of keys) {
        try { result[k] = JSON.parse(view.localStorage.getItem(ns + k)); } catch { /* Ignore a damaged record. */ }
      }
      return result;
    },
    async set(obj) { for (const [k, value] of Object.entries(obj)) view.localStorage.setItem(ns + k, JSON.stringify(value)); },
    async remove(keys) { for (const k of [].concat(keys)) view.localStorage.removeItem(ns + k); }
  };
  const history = createWatchStore(area);
  function active() {
    try { return phoneLesson(JSON.parse(view.sessionStorage.getItem(sessionKey))); }
    catch { throw new Error("请返回手机版首页，打开本节录播的播放链接。"); }
  }
  return {
    history,
    setLesson(value) { view.sessionStorage.setItem(sessionKey, JSON.stringify(phoneLesson(value))); },
    async lesson() {
      const lesson = active();
      // Storage may be disabled by the browser while video playback still works.
      const entries = await history.list().catch(() => []);
      for (const item of lesson.media) {
        const local = resumeInfo(entries, item.url);
        if (local.resumeAt !== null && local.resumeStamp >= item.resumeStamp) Object.assign(item, local);
      }
      return lesson;
    },
    async progress(samples, at) {
      const lesson = active();
      await history.save(watchEntry(lesson.courseTitle, lesson.media, lesson.replay, samples, at));
    }
  };
}
