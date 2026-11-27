import { enhanceSelect } from "./custom-select.js";

const timingLine = /^((?:\d+:)?\d{2}:\d{2})[.,](\d{3})[ \t]+-->[ \t]+((?:\d+:)?\d{2}:\d{2})[.,](\d{3})(?=[ \t]|$)/gm;

function timestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, "0")}`;
}

/** @param {{ text?: string, cues?: Array<{ startTime: number, endTime: number, text: string }> }} [input] */
export function toWebVtt({ text, cues } = {}) {
  if (cues?.length) {
    text = cues.map((cue) => `${timestamp(cue.startTime)} --> ${timestamp(cue.endTime)}\n${cue.text}`).join("\n\n");
  }
  const body = (text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!body.match(timingLine)) throw new Error("没有找到带时间码的字幕，请选择有效的 SRT 或 VTT 文件。");
  if (/^WEBVTT(?:[ \t\n]|$)/.test(body)) return body;
  return "WEBVTT\n\n" + body.replace(timingLine, "$1.$2 --> $3.$4") + "\n";
}

// One control belongs to one video, so native seeking, speed and fullscreen all
// use that video's own clock, including when the two cameras have an offset.
/**
 * @param {HTMLElement} container
 * @param {HTMLVideoElement} video
 * @param {(key: string) => Promise<any>} readCourse
 * @param {(track: TextTrack | null) => void} [onTrackChange]
 */
export function bindSubtitles(container, video, readCourse, onTrackChange = () => {}) {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  container.innerHTML = `<label>字幕 <select class="subtitle-mode"><option value="off">关闭</option><option value="course">课程字幕</option></select></label>
    <button type="button" class="subtitle-import">导入字幕</button><input type="file" accept=".srt,.vtt" hidden>
    <small class="subtitle-status" role="status" hidden></small>`;
  const select = /** @type {HTMLSelectElement} */ (container.querySelector("select"));
  const selectUi = enhanceSelect(select);
  const input = /** @type {HTMLInputElement} */ (container.querySelector("input"));
  const status = /** @type {HTMLElement} */ (container.querySelector("small"));
  let key = "";
  let revision = 0;
  let tried = false;
  let loading = false;
  let display = true;
  let active, pending, course, local;

  function selectedTrack() {
    const track = active?.element.track;
    return track && (track.mode === "showing" || (!display && track.mode === "hidden")) ? track : null;
  }
  function notify(text = "") {
    status.textContent = text;
    status.hidden = !text;
  }
  function remove(track) {
    if (!track) return;
    track.element.remove();
    view.URL.revokeObjectURL(track.url);
  }
  function start() {
    revision++;
    loading = false;
    remove(pending);
    pending = null;
    notify();
    return revision;
  }
  function fail(text) {
    loading = false;
    remove(pending);
    pending = null;
    select.value = selectedTrack() ? active.mode : "off";
    selectUi.sync();
    notify(text);
    onTrackChange(selectedTrack());
  }
  function attach(mode, data, version) {
    const element = doc.createElement("track");
    element.kind = "captions";
    element.label = data.label;
    const url = view.URL.createObjectURL(new view.Blob([data.vtt], { type: "text/vtt;charset=utf-8" }));
    pending = { element, url, mode, data };
    element.addEventListener("error", () => {
      if (revision === version && pending?.element === element) fail("字幕加载失败，请重新选择课程字幕或导入本地文件。");
    });
    element.addEventListener("load", () => {
      if (revision !== version || pending?.element !== element) return;
      if (!element.track.cues?.length) { fail("这份字幕没有可显示的内容，请导入有效的字幕文件。"); return; }
      remove(active);
      active = pending;
      pending = null;
      loading = false;
      if (mode === "file") {
        local = data;
        let option = /** @type {HTMLOptionElement | null} */ (select.querySelector('[value="file"]'));
        if (!option) { option = doc.createElement("option"); option.value = "file"; select.append(option); }
        option.textContent = data.label;
      } else course = data;
      element.track.mode = display ? "showing" : "hidden";
      select.value = mode;
      selectUi.sync();
      notify();
      onTrackChange(element.track);
    });
    element.src = url;
    video.append(element);
    element.track.mode = "hidden"; // Let Chrome parse the new track before replacing the visible one.
  }
  async function selectTrack() {
    tried = true;
    const mode = select.value;
    const version = start();
    if (mode === "off") { remove(active); active = null; onTrackChange(null); return; }
    loading = true;
    onTrackChange(selectedTrack());
    try {
      let data = mode === "file" ? local : course;
      if (!data) {
        notify("正在读取课程字幕…");
        const result = await readCourse(key);
        if (revision !== version) return;
        data = { label: "课程字幕", vtt: toWebVtt(result) };
      }
      attach(mode, data, version);
    } catch (error) { if (revision === version) fail(error.message); }
  }
  select.addEventListener("change", selectTrack);
  container.querySelector(".subtitle-import").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    tried = true;
    const version = start();
    loading = true;
    onTrackChange(selectedTrack());
    try {
      if (!/\.(srt|vtt)$/i.test(file.name)) throw new Error("请选择 SRT 或 VTT 字幕文件。");
      const text = await file.text();
      if (revision === version) attach("file", { label: file.name, vtt: toWebVtt({ text }) }, version);
    } catch (error) { if (revision === version) fail(error.message); }
  });
  video.textTracks?.addEventListener?.("change", () => {
    if (active && !pending && status.hidden) {
      const track = selectedTrack();
      select.value = track ? active.mode : "off";
      selectUi.sync();
      onTrackChange(track);
    }
  });
  return {
    get track() { return selectedTrack(); },
    get source() {
      const track = selectedTrack();
      return track ? { track, mode: active.mode, vtt: active.data.vtt } : null;
    },
    get loading() { return loading; },
    setDisplay(visible) {
      const track = selectedTrack();
      display = visible;
      const mode = visible ? "showing" : "hidden";
      if (track && track.mode !== mode) track.mode = mode;
    },
    ensureCourse() {
      if (!key || tried) return;
      select.value = "course";
      void selectTrack();
    },
    setSource(nextKey) {
      container.hidden = !nextKey;
      if (key === nextKey) return;
      start();
      key = nextKey;
      tried = false;
      remove(active);
      active = course = local = null;
      select.querySelector('[value="file"]')?.remove();
      select.value = "off";
      selectUi.sync();
      onTrackChange(null);
    }
  };
}
