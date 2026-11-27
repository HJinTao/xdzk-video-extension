import { formatBytes, formatDuration, recordingInfo } from "./lib/media.js";
import { bindSubtitles } from "./lib/subtitles.js";
import { createLecturePlayer } from "./lib/lecture-player.js";
import { bindPlaybackSpeed } from "./lib/playback-speed.js";
import { computeWatchStatus } from "./lib/watch-progress.js";

const $ = (id) => document.getElementById(id);
const $input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
const $button = (id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));
const $template = (id) => /** @type {HTMLTemplateElement} */ (document.getElementById(id));
const cards = new Map();
let tabId;
let state;
let poll;
let busy = false;
let pollInFlight = false;
let titleDirty = false;
let savingTitle;
let savingOptions;
let includeNewFiles = true;
let nextCardId = 0;
let playlistLoadedFor = "";

async function refreshPlaylistChip(liveId) {
  const chip = $("playlist-progress");
  if (!chip) return;
  if (!liveId) {
    playlistLoadedFor = "";
    chip.hidden = true;
    return;
  }
  if (playlistLoadedFor === liveId) return;
  playlistLoadedFor = liveId;
  try {
    const result = await send("GET_PLAYLIST");
    if (!result?.supported || !Array.isArray(result.lessons) || !result.lessons.length) {
      chip.hidden = true;
      return;
    }
    const available = result.lessons.filter((lesson) => lesson.available);
    const progress = result.progress || {};
    const watched = available.filter((lesson) => computeWatchStatus(progress[lesson.liveId]) === "watched").length;
    chip.textContent = `同课程 ${available.length} 节 · 已看 ${watched} 节`;
    chip.hidden = false;
  } catch {
    chip.hidden = true;
  }
}

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

function selectedFiles() {
  return (state?.media || []).filter(item => cards.get(item.key)?.querySelector(".file-check").checked);
}

function fileSize(item) {
  return item.size > 0 ? item.size : Math.max(0, item.download?.totalBytes || 0);
}

function updateSelection() {
  const selected = selectedFiles();
  const total = state?.media?.length || 0;
  const all = $input("select-all");
  all.checked = total > 0 && selected.length === total;
  all.indeterminate = selected.length > 0 && selected.length < total;
  all.disabled = !total;
  const bytes = selected.reduce((sum, item) => sum + fileSize(item), 0);
  const unknown = selected.filter(item => !fileSize(item)).length;
  let size = bytes ? formatBytes(bytes) : "0 B";
  if (unknown) size = bytes ? `至少 ${size}（${unknown} 项大小待获取）` : "大小待获取";
  const summary = `已选 ${selected.length} 个文件 · ${size}`;
  if ($("selection-total").textContent !== summary) $("selection-total").textContent = summary;
  $button("download-selected").disabled = busy || !selected.length;
}

async function act(operation) {
  if (busy) return;
  busy = true;
  $button("download-selected").disabled = true;
  $button("open-player").disabled = true;
  $button("scan").disabled = true;
  try {
    const result = await operation();
    if (result?.media) render(result);
    return result;
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    $button("scan").disabled = false;
    updateSelection();
    $button("open-player").disabled = (state?.media?.length || 0) < 1;
  }
}

async function persistTitle() {
  if (savingTitle) await savingTitle;
  if (!titleDirty) return;
  const value = $input("course-name").value;
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
  const card = /** @type {any} */ (document.importNode($template("media-template").content.firstElementChild, true));
  card.dataset.key = key;
  const check = card.querySelector(".file-check");
  check.checked = includeNewFiles;
  check.addEventListener("change", () => { updateSelection(); includeNewFiles = $input("select-all").checked; });
  const details = card.querySelector(".file-details");
  const more = card.querySelector(".file-tools");
  details.id = "file-details-" + ++nextCardId;
  more.setAttribute("aria-controls", details.id);
  more.addEventListener("click", () => {
    details.hidden = !details.hidden;
    more.setAttribute("aria-expanded", String(!details.hidden));
    if (details.hidden && !card.querySelector(".preview").hidden) card.querySelector(".preview-button").click();
  });
  const video = card.querySelector("video");
  card.subtitles = bindSubtitles(card.querySelector(".subtitles"), video, (key) => send("GET_SUBTITLES", { key }));
  card.subtitles.setSource(key);
  const speed = bindPlaybackSpeed(card.querySelector(".speed-control"), (value) => { video.defaultPlaybackRate = value; video.playbackRate = value; });
  video.addEventListener("ratechange", () => speed.set(video.playbackRate));
  const name = card.querySelector(".channel-name");
  name.addEventListener("change", () => {
    card.pendingName = send("RENAME_MEDIA", { key, value: name.value }).then(render);
    card.pendingName.catch((error) => notice(error.message, true));
  });
  card.querySelector(".preview-button").addEventListener("click", () => {
    const panel = card.querySelector(".preview");
    panel.hidden = !panel.hidden;
    card.querySelector(".preview-button").setAttribute("aria-expanded", String(!panel.hidden));
    card.querySelector(".preview-button").textContent = panel.hidden ? "预览画面" : "收起预览";
    if (panel.hidden) {
      video.pause();
      card.player.reset();
    } else {
      card.querySelector(".preview-error").hidden = true;
      if (card.player) card.player.url = card.media.url;
      else card.player = createLecturePlayer(video, card.media.url);
      card.subtitles.ensureCourse();
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
  syncPolling();
  if (!next.supported) return;
  if (!titleDirty && document.activeElement !== $("course-name")) $input("course-name").value = next.courseTitle;
  $("course-name").title = next.courseTitle;
  $input("save-as").checked = !!next.options.saveAs;
  const summary = next.media.length === 1 ? "已识别 1 路（单画面看课；若有双路请先分别播放）" :
    next.media.length ? `已识别 ${next.media.length} 路画面` : "等待回放视频加载";
  if ($("summary").textContent !== summary) $("summary").textContent = summary;
  $("empty").hidden = next.media.length > 0;
  $button("open-player").disabled = busy || next.media.length < 1;
  const openLabel = $("open-player-label");
  if (openLabel) openLabel.textContent = next.media.length === 1 ? "单画面看课" : "同步看课";
  void refreshPlaylistChip(next.liveId || "");
  const keys = new Set(next.media.map((media) => media.key));
  for (const [key, card] of cards) if (!keys.has(key)) { card.subtitles.setSource(""); card.player?.destroy(); card.remove(); cards.delete(key); }
  if (!cards.size) includeNewFiles = true;
  next.media.forEach((media, index) => {
    let card = cards.get(media.key);
    if (!card) { card = makeCard(media.key); cards.set(media.key, card); }
    card.media = media;
    card.querySelector(".file-label").textContent = media.label;
    card.querySelector(".file-check").setAttribute("aria-label", `选择${media.label}`);
    card.querySelector(".file-tools").setAttribute("aria-label", `${media.label}的操作`);
    const name = card.querySelector(".channel-name");
    if (document.activeElement !== name) name.value = media.label;
    const info = recordingInfo(media.url);
    const facts = card.querySelector(".media-facts");
    const resolution = media.width && media.height ? `${media.width}\u00a0×\u00a0${media.height}` : "";
    facts.textContent = ["MP4", formatDuration(media.duration), resolution].filter(Boolean).join(" ·\u00a0");
    facts.title = [info.date, media.camera || info.camera].filter(Boolean).join(" · ");
    card.querySelector(".file-size").textContent = formatBytes(fileSize(media));
    updateProgress(card, media);
    const position = $("media-list").children[index];
    if (position !== card) $("media-list").insertBefore(card, position || null);
  });
  updateSelection();
}

$("course-name").addEventListener("input", () => { titleDirty = true; });
$("course-name").addEventListener("change", () => { void persistTitle().catch((error) => notice(error.message, true)); });
$("save-as").addEventListener("change", () => {
  savingOptions = send("SET_OPTIONS", { saveAs: $input("save-as").checked });
  savingOptions.catch((error) => notice(error.message, true));
});
async function scanPage() {
  notice();
  $("scan-label").textContent = "识别中…";
  try {
    const result = await send("SCAN_TAB");
    if (result.notice) notice(result.notice);
    return result;
  } finally {
    $("scan-label").textContent = "重新识别";
  }
}
$("scan").addEventListener("click", () => { void act(async () => { await persistTitle(); return scanPage(); }); });
$("select-all").addEventListener("change", () => {
  includeNewFiles = $input("select-all").checked;
  for (const card of cards.values()) card.querySelector(".file-check").checked = includeNewFiles;
  updateSelection();
});
$("download-selected").addEventListener("click", () => { void act(async () => {
  const keys = selectedFiles().map(item => item.key);
  await persistTitle();
  if (savingOptions) await savingOptions;
  await Promise.all([...cards.values()].map((card) => card.pendingName));
  const result = await send("DOWNLOAD_SELECTED", { keys });
  notice(result.failed ? `有 ${result.failed} 路下载未开始，请查看画面下方提示。` : result.started ? `已开始 ${result.started} 路下载，可以关闭这个面板。` : "画面已经在下载中，可在浏览器下载列表查看。", !!result.failed);
  return result;
}); });
$("open-downloads").addEventListener("click", () => { void chrome.tabs.create({ url: "chrome://downloads/" }); });
$("open-player").addEventListener("click", () => { void act(async () => {
  await persistTitle();
  await Promise.all([...cards.values()].map((card) => card.pendingName));
  await send("OPEN_PLAYER");
  notice((state?.media?.length || 0) === 1 ? "已在新标签页打开单画面看课，无需先下载视频。" : "已在新标签页打开双路同步播放，无需先下载视频。");
}); });

async function refreshState() {
  if (busy || pollInFlight || !state?.supported) return;
  pollInFlight = true;
  try { render(await send("GET_STATE")); } catch { /* Keep the last useful state during navigation. */ }
  finally { pollInFlight = false; }
}

const hasStorageEvents = typeof chrome.storage?.onChanged?.addListener === "function";

function syncPolling() {
  const activeDownload = !!state?.media?.some((item) => item.download?.state === "in_progress");
  const needPoll = !!state?.supported && (activeDownload || !hasStorageEvents);
  if (needPoll && !poll) poll = setInterval(() => { void refreshState(); }, 1200);
  else if (!needPoll && poll) { clearInterval(poll); poll = null; }
}

function handleStorageChange(changes, area) {
  if (area === "session" && Number.isInteger(tabId) && Object.prototype.hasOwnProperty.call(changes, `tab:${tabId}`)) {
    void refreshState();
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (hasStorageEvents) chrome.storage.onChanged.addListener(handleStorageChange);
  render(await send("GET_STATE"));
  if (state.supported) await act(scanPage);
  syncPolling();
}

window.addEventListener("pagehide", () => {
  if (poll) { clearInterval(poll); poll = null; }
  if (hasStorageEvents) chrome.storage.onChanged.removeListener(handleStorageChange);
  for (const card of cards.values()) card.player?.destroy();
});
init().catch((error) => notice(error.message, true));
