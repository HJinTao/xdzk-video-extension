import { formatBytes, formatDuration, recordingInfo } from "./lib/media.js";

const $ = (id) => document.getElementById(id);
const cards = new Map();
let tabId;
let state;
let poll;
let busy = false;
let pollInFlight = false;
let titleDirty = false;
let savingTitle;
let savingOptions;

async function send(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...fields });
  if (!result?.ok) throw new Error(result?.error || "扩展暂时没有响应，请重新打开面板。" );
  return result;
}

function notice(message = "", error = false) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
  $("notice").classList.toggle("error", error);
}

async function act(operation) {
  if (busy) return;
  busy = true;
  $("download-all").disabled = true;
  $("open-player").disabled = true;
  $("scan").disabled = true;
  try {
    const result = await operation();
    if (result?.media) render(result);
    return result;
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    $("scan").disabled = false;
    $("download-all").disabled = !state?.media?.length;
    $("open-player").disabled = (state?.media?.length || 0) < 2;
  }
}

async function persistTitle() {
  if (savingTitle) await savingTitle;
  if (!titleDirty) return;
  const value = $("course-name").value;
  titleDirty = false;
  savingTitle = send("SET_TITLE", { value }).then(render).finally(() => { savingTitle = null; });
  await savingTitle;
}

function updateProgress(card, media) {
  const item = media.download;
  const status = card.querySelector(".download-status");
  const button = card.querySelector(".download-button");
  const control = card.querySelector(".control-button");
  const error = card.querySelector(".card-error");
  status.hidden = !item;
  error.hidden = true;
  button.disabled = item?.state === "in_progress";
  button.textContent = item?.state === "complete" ? "再次下载 ↓" : item?.state === "in_progress" ? "下载中…" : "下载视频 ↓";
  if (item) {
    const total = item.totalBytes > 0 ? item.totalBytes : media.size;
    const percentage = total > 0 ? Math.min(100, Math.max(0, item.bytesReceived / total * 100)) : 0;
    const progress = card.querySelector("progress");
    if (total > 0 || item.state === "complete") progress.value = item.state === "complete" ? 100 : percentage;
    else progress.removeAttribute("value");
    card.querySelector(".progress-label").textContent = item.state === "complete" ? "已保存到本地" :
      item.state === "interrupted" ? "下载已中断" : item.paused ? "已暂停" : `${item.bytesReceived ? formatBytes(item.bytesReceived) : "0 B"} / ${formatBytes(total)}  ·  ${Math.round(percentage)}%`;
    control.hidden = item.state === "complete" || (item.state === "interrupted" && !item.canResume);
    control.textContent = item.paused || item.state === "interrupted" ? "继续下载" : "暂停";
    control.dataset.action = item.paused || item.state === "interrupted" ? "resume" : "pause";
    if (item.state === "interrupted") {
      error.hidden = false;
      error.textContent = item.error === "USER_CANCELED" ? "下载已取消，可点击“下载视频”重新开始。" : "下载中断。可以尝试继续；若链接失效，请刷新回放后重新识别再下载。";
    }
  }
  if (media.downloadError) { error.textContent = media.downloadError; error.hidden = false; }
}

function makeCard(key) {
  const card = $("media-template").content.firstElementChild.cloneNode(true);
  card.dataset.key = key;
  const name = card.querySelector(".channel-name");
  name.addEventListener("change", () => {
    card.pendingName = send("RENAME_MEDIA", { key, value: name.value }).then(render);
    card.pendingName.catch((error) => notice(error.message, true));
  });
  card.querySelector(".preview-button").addEventListener("click", () => {
    const panel = card.querySelector(".preview");
    const video = panel.querySelector("video");
    panel.hidden = !panel.hidden;
    card.querySelector(".preview-button").textContent = panel.hidden ? "预览画面" : "收起预览";
    if (panel.hidden) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } else {
      card.querySelector(".preview-error").hidden = true;
      video.src = card.media.url;
      video.play().catch(() => {});
    }
  });
  card.querySelector("video").addEventListener("error", () => { card.querySelector(".preview-error").hidden = false; });
  card.querySelector(".copy-button").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(card.media.url);
      notice("已复制完整视频链接。链接失效时，请回到播放页重新识别。" );
    } catch { notice("浏览器未允许复制，请使用“下载视频”保存。", true); }
  });
  card.querySelector(".download-button").addEventListener("click", () => { void act(async () => {
    await persistTitle();
    if (savingOptions) await savingOptions;
    if (card.pendingName) await card.pendingName;
    const result = await send("DOWNLOAD_MEDIA", { key });
    notice(result.failed ? "下载未开始，请查看画面下方提示。" : "已交给浏览器下载，可以关闭这个面板。", !!result.failed);
    return result;
  }); });
  card.querySelector(".control-button").addEventListener("click", (event) => {
    const action = event.currentTarget.dataset.action;
    void act(() => send("CONTROL_DOWNLOAD", { key, action }));
  });
  return card;
}

function render(next) {
  state = next;
  $("workspace").hidden = !next.supported;
  $("unsupported").hidden = next.supported;
  if (!next.supported) return;
  if (!titleDirty && document.activeElement !== $("course-name")) $("course-name").value = next.courseTitle;
  $("save-as").checked = !!next.options.saveAs;
  $("media-count").textContent = next.media.length;
  $("summary").textContent = next.media.length ? `已识别 ${next.media.length} 路画面 · 可预览、改名后下载` : "等待回放视频加载";
  $("empty").hidden = next.media.length > 0;
  $("download-all").disabled = busy || !next.media.length;
  $("open-player").disabled = busy || next.media.length < 2;
  $("copy-cloud-links").disabled = !next.media.length;
  const keys = new Set(next.media.map((media) => media.key));
  for (const [key, card] of cards) if (!keys.has(key)) { card.remove(); cards.delete(key); }
  next.media.forEach((media, index) => {
    let card = cards.get(media.key);
    if (!card) { card = makeCard(media.key); cards.set(media.key, card); }
    card.media = media;
    card.querySelector(".channel-number").textContent = String(index + 1).padStart(2, "0");
    const name = card.querySelector(".channel-name");
    if (document.activeElement !== name) name.value = media.label;
    const info = recordingInfo(media.url);
    card.querySelector(".media-facts").textContent = [info.date, media.width && media.height ? `${media.width} × ${media.height}` : "", formatDuration(media.duration), formatBytes(media.size)].filter(Boolean).join("  ·  ");
    card.querySelector(".camera-id").textContent = media.camera || info.camera || "录播视频";
    updateProgress(card, media);
    const position = $("media-list").children[index];
    if (position !== card) $("media-list").insertBefore(card, position || null);
  });
}

$("course-name").addEventListener("input", () => { titleDirty = true; });
$("course-name").addEventListener("change", () => { void persistTitle().catch((error) => notice(error.message, true)); });
$("save-as").addEventListener("change", () => {
  savingOptions = send("SET_OPTIONS", { saveAs: $("save-as").checked });
  savingOptions.catch((error) => notice(error.message, true));
});
$("scan").addEventListener("click", () => { void act(async () => {
  await persistTitle();
  notice("正在检查当前回放页面…" );
  const result = await send("SCAN_TAB");
  notice(result.notice || (result.media.length ? "已更新画面。预览后可以修改画面名称。" : "请在回放页点击播放，再重新识别。"));
  return result;
}); });
$("download-all").addEventListener("click", () => { void act(async () => {
  await persistTitle();
  if (savingOptions) await savingOptions;
  await Promise.all([...cards.values()].map((card) => card.pendingName));
  const result = await send("DOWNLOAD_ALL");
  notice(result.failed ? `有 ${result.failed} 路下载未开始，请查看画面下方提示。` : result.started ? `已开始 ${result.started} 路下载，可以关闭这个面板。` : "画面已经在下载中，可在浏览器下载列表查看。", !!result.failed);
  return result;
}); });
$("open-downloads").addEventListener("click", () => { void chrome.tabs.create({ url: "chrome://downloads/" }); });
$("open-cloud").addEventListener("click", () => { void chrome.tabs.create({ url: "https://yun.123pan.cn/" }); });
$("copy-cloud-links").addEventListener("click", async () => {
  try {
    const links = state?.media?.map((item) => item.url) || [];
    if (!links.length) return;
    await navigator.clipboard.writeText(links.join("\n"));
    notice(`已复制 ${links.length} 路视频链接，每行一个。请到 123 云盘创建离线任务；当前尚未上传视频。`);
  } catch { notice("浏览器未允许复制，请使用各画面的“复制链接”重试。", true); }
});
$("open-player").addEventListener("click", () => { void act(async () => {
  await persistTitle();
  await Promise.all([...cards.values()].map((card) => card.pendingName));
  await send("OPEN_PLAYER");
  notice("已在新标签页打开双路同步播放，无需先下载视频。");
}); });

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  render(await send("GET_STATE"));
  if (state.supported) await act(async () => {
    const result = await send("SCAN_TAB");
    if (result.notice) notice(result.notice);
    return result;
  });
  poll = setInterval(async () => {
    if (busy || pollInFlight) return;
    pollInFlight = true;
    try { render(await send("GET_STATE")); } catch { /* Keep the last useful state during navigation. */ }
    finally { pollInFlight = false; }
  }, 1200);
}

window.addEventListener("pagehide", () => { clearInterval(poll); });
init().catch((error) => notice(error.message, true));
