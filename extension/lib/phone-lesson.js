import { isMediaUrl, mediaKey, parseHttpUrl, sanitizeName } from "./media.js";
import { replayAddress } from "./watch-history.js";

export function phoneLesson(value) {
  if (!Array.isArray(value?.media) || value.media.length < 1 || value.media.length > 2) throw new Error("请选择一路或两路录播画面。");
  const replay = replayAddress(value.replay);
  const media = value.media.map((item, i) => {
    if (!isMediaUrl(item?.url)) throw new Error("请使用西电视频服务器上的完整 MP4 链接。");
    return {
      key: mediaKey(item.url), url: item.url, label: sanitizeName(item.label, `画面 ${i + 1}`, 32),
      frameUrl: replayAddress(item.frameUrl) || replay,
      resumeAt: Number.isFinite(item.resumeAt) && item.resumeAt >= 0 ? item.resumeAt : null,
      resumeStamp: Number.isFinite(item.resumeStamp) ? item.resumeStamp : 0
    };
  });
  if (media.length === 2 && media[0].key === media[1].key) throw new Error("两路画面使用了相同的视频链接。");
  return { courseTitle: sanitizeName(value.courseTitle, "课程录播", 60), replay, media };
}

export function mobileAddress(value) {
  const url = parseHttpUrl(value);
  if (!url) throw new Error("请填写启动手机版后显示的完整网址。");
  url.hash = ""; url.search = "";
  if (!url.pathname.endsWith("/mobile.html")) url.pathname = url.pathname.replace(/\/?$/, "/") + "mobile.html";
  return url;
}

export function phoneLink(base, value) {
  const url = mobileAddress(base);
  const { courseTitle, replay, media } = phoneLesson(value);
  const cameras = media.map(({ url, label, frameUrl, resumeAt, resumeStamp }) => ({
    url, label, ...(frameUrl && frameUrl !== replay && { frameUrl }),
    ...(resumeAt !== null && { resumeAt, resumeStamp })
  }));
  url.hash = new URLSearchParams({ lesson: JSON.stringify({ courseTitle, replay, media: cameras }) }).toString();
  return url.href;
}

export function readPhoneLink(hash) {
  const text = new URLSearchParams(hash.replace(/^#/, "")).get("lesson");
  if (!text) return null;
  if (text.length > 48000) throw new Error("播放链接过长，请重新生成。");
  try { return phoneLesson(JSON.parse(text)); }
  catch { throw new Error("播放链接无效，请从电脑重新复制，或粘贴 MP4 地址。"); }
}
