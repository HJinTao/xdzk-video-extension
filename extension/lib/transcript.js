import { formatClock } from "./media.js";

// The browser parses both course and imported captions. Use those same native
// cues for text, timing and highlighting, including overlapping cues.
export function bindTranscript(panel, seekToCue) {
  const doc = panel.ownerDocument;
  const find = (selector) => panel.querySelector(selector);
  const search = find("#cue-search");
  const follow = find("#cue-follow");
  const list = find("#cue-list");
  const count = find("#cue-count");
  const empty = find("#cue-empty");
  let track = null;
  const rows = new Map();
  let highlighted = new Set();
  let start, end;

  function followCurrent() {
    if (panel.hidden || !follow.checked || search.value.trim()) return;
    if (list.contains(doc.activeElement) && doc.activeElement.matches(":focus-visible")) return;
    const current = rows.get(highlighted.values().next().value);
    if (!current || current.item.hidden) return;
    const itemBox = current.item.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (itemBox.top < listBox.top || itemBox.bottom > listBox.bottom) {
      list.scrollTop += itemBox.top - listBox.top - list.clientHeight / 3;
    }
  }

  function highlight() {
    const next = new Set(Array.from(track?.activeCues || []));
    for (const cue of highlighted) if (!next.has(cue)) rows.get(cue)?.button.removeAttribute("aria-current");
    for (const cue of next) if (!highlighted.has(cue)) rows.get(cue)?.button.setAttribute("aria-current", "true");
    highlighted = next;
    followCurrent();
  }

  function filter() {
    const query = search.value.trim().toLowerCase();
    let matches = 0;
    for (const row of rows.values()) {
      row.item.hidden = !row.searchText.includes(query);
      if (!row.item.hidden) matches++;
    }
    count.textContent = query ? `匹配 ${matches} / ${rows.size} 条` : `共 ${rows.size} 条`;
    find(".transcript-tools").hidden = !rows.size;
    list.hidden = !matches;
    empty.hidden = matches > 0;
    empty.textContent = rows.size ? "没有匹配的字幕，试试其他关键词。" : "选择课程字幕，或导入 SRT / VTT 文件。";
    if (!query) followCurrent();
  }

  function setAvailable(cue, button) {
    const outside = start !== undefined && (cue.endTime <= start || cue.startTime >= end);
    button.disabled = start === undefined || outside;
    button.title = outside ? "超出两路画面的共同播放范围" : "";
  }

  function setTrack(next) {
    if (next === track) return;
    track?.removeEventListener("cuechange", highlight);
    track = next;
    rows.clear();
    highlighted.clear();
    const fragment = doc.createDocumentFragment();
    for (const cue of Array.from(track?.cues || [])) {
      const text = (cue.getCueAsHTML?.().textContent ?? cue.text ?? "").trim();
      if (!text || !Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime)) continue;
      const item = doc.createElement("li");
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.start = String(cue.startTime);
      const stamp = doc.createElement("time");
      stamp.textContent = formatClock(cue.startTime);
      const content = doc.createElement("span");
      content.textContent = text;
      button.append(stamp, content);
      item.append(button);
      fragment.append(item);
      rows.set(cue, { item, button, searchText: stamp.textContent + " " + text.toLowerCase() });
      setAvailable(cue, button);
    }
    list.replaceChildren(fragment);
    list.scrollTop = 0;
    search.value = "";
    filter();
    track?.addEventListener("cuechange", highlight);
    highlight();
  }
  search.addEventListener("input", filter);
  follow.addEventListener("change", followCurrent);
  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-start]");
    if (button && !button.disabled) seekToCue(Number(button.dataset.start));
  });
  return {
    setTrack,
    followCurrent,
    setWindow(range, offset = 0) {
      const nextStart = range ? range.start + offset : undefined;
      const nextEnd = range ? range.end + offset : undefined;
      if (nextStart === start && nextEnd === end) return;
      start = nextStart;
      end = nextEnd;
      for (const [cue, row] of rows) setAvailable(cue, row.button);
    }
  };
}
