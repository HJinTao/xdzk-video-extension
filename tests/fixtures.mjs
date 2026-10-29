export const pageUrl = "http://newes.chaoxing.com/xidianpj/frontLive/playVideo2Keda?liveId=100&workDetailId=200";
export function mediaUrl(camera = "CloudIPC-demo-a", stamp = 1700000000) {
  return `https://kdlbptvideo.xidian.edu.cn/vod/demo/20260911/${camera}/1789109401000-1789112400000.mp4?auth_key=${stamp}-0-0-demo`;
}
export const snapshot = {
  url: pageUrl, title: "课程直播", headings: [],
  pageText: "课程：数据库系统    教师：示例教师    地点：示例教室",
  media: [
    { url: mediaUrl(), videoIndex: 0, width: 1920, height: 1080, duration: 3000 },
    { url: mediaUrl("CloudIPC-demo-b"), videoIndex: 1, width: 1920, height: 1080, duration: 3000 }
  ]
};
export const popupSender = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
export const pageSender = { id: "test-extension", tab: { id: 1 }, frameId: 0, documentId: "doc-a", url: pageUrl };

export function createApi({ url = pageUrl } = {}) {
  const session = {};
  const local = {};
  const jobs = new Map();
  const downloadCalls = [];
  const storage = (data) => ({
    async get(keys) {
      await new Promise((done) => setTimeout(done, 1));
      if (typeof keys === "string") return structuredClone({ [keys]: data[keys] });
      return structuredClone({ ...keys, ...data });
    },
    async set(values) { await new Promise((done) => setTimeout(done, 1)); Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; }
  });
  const api = {
    runtime: { id: "test-extension", getURL: (path) => `chrome-extension://test-extension/${path}` },
    storage: { session: storage(session), local: storage(local) },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: { async get(id) { return { id, url, title: "课程直播" }; }, async query() { return [{ id: 1, url }]; }, async create() {} },
    scripting: { async executeScript() { return []; } },
    downloads: {
      async search({ id }) { return jobs.has(id) ? [structuredClone(jobs.get(id))] : []; },
      async download(options) {
        downloadCalls.push(options);
        const id = downloadCalls.length;
        jobs.set(id, { id, state: "in_progress", paused: false, canResume: true, bytesReceived: 0, totalBytes: 791215769 });
        return id;
      },
      async pause(id) { jobs.get(id).paused = true; },
      async resume(id) { jobs.get(id).paused = false; jobs.get(id).state = "in_progress"; },
      async cancel(id) { Object.assign(jobs.get(id), { state: "interrupted", error: "USER_CANCELED" }); }
    }
  };
  return { api, session, local, jobs, downloadCalls };
}
