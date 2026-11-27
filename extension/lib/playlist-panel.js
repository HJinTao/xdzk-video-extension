import { formatClock } from "./media.js";
import { computeWatchStatus } from "./watch-progress.js";

const AUTO_NEXT_SECONDS = 5;

export function lessonStatusMeta(lesson, record) {
  if (!lesson.available) return { status: "upcoming", badge: "尚未开始", percent: 0 };
  const status = computeWatchStatus(record);
  if (status === "watched") return { status: "watched", badge: "已看完", percent: 100 };
  if (status === "watching") {
    const percent = Math.min(99, Math.max(1, Math.round((Number(record?.ratio) || 0) * 100)));
    return { status: "watching", badge: `看到 ${formatClock(record.time)} · ${percent}%`, percent };
  }
  return { status: "unwatched", badge: "未看", percent: 0 };
}

export function bindPlaylistPanel(doc, {
  onSelectLesson,
  onToggleWatched,
  onRefresh,
  onAutoNextChange,
  onOpenReview,
  onLayoutChange
}) {
  const $ = (id) => doc.getElementById(id);
  let lessons = [];
  let progressMap = {};
  let currentLiveId = "";
  let switching = false;
  let filter = "all";
  let autoPlayNext = true;
  let countdownTimer = null;
  let countdownTarget = null;
  let countdownLeft = 0;

  function adjacentLesson(direction) {
    if (!lessons.length || !currentLiveId) return null;
    const currentIndex = lessons.findIndex((item) => item.liveId === currentLiveId);
    if (currentIndex < 0) return null;
    for (let i = currentIndex + direction; i >= 0 && i < lessons.length; i += direction) {
      if (lessons[i].available) return lessons[i];
    }
    return null;
  }

  function updateHeading(explicitTitle = "") {
    const current = lessons.find((item) => item.liveId === currentLiveId);
    const parts = [];
    if (current) {
      parts.push(`第 ${current.index} 讲 · ${current.title}`);
      if (current.shortDate) parts.push(current.shortDate);
      if (current.timeRange) parts.push(current.timeRange);
    } else if (explicitTitle) {
      parts.push(explicitTitle);
    }
    const text = parts.join(" · ");
    const el = $("lesson-subtitle");
    el.textContent = text;
    el.hidden = !text;
  }

  function updateNav() {
    const hasPlaylist = lessons.length > 0;
    $("toggle-playlist").hidden = !hasPlaylist;
    $("prev-lesson").hidden = !hasPlaylist;
    $("next-lesson").hidden = !hasPlaylist;
    $("auto-next-wrap").hidden = !hasPlaylist;
    doc.querySelectorAll(".side-tab-playlist").forEach((button) => {
      /** @type {HTMLElement} */ (button).hidden = !hasPlaylist;
    });
    if (!hasPlaylist) return;
    const available = lessons.filter((item) => item.available);
    const watchedCount = available.filter((item) => computeWatchStatus(progressMap[item.liveId]) === "watched").length;
    $("playlist-badge").textContent = `${watchedCount}/${available.length}`;
    $("playlist-summary").textContent = `已看 ${watchedCount} / ${available.length} 节`;
    const overallFill = $("playlist-overall-fill");
    if (overallFill) overallFill.style.width = `${available.length ? Math.round((watchedCount / available.length) * 100) : 0}%`;
    /** @type {HTMLButtonElement} */ ($("prev-lesson")).disabled = switching || !adjacentLesson(-1);
    /** @type {HTMLButtonElement} */ ($("next-lesson")).disabled = switching || !adjacentLesson(1);
  }

  function scrollCurrentIntoView() {
    const active = $("playlist-list").querySelector('[data-current="true"]');
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }

  function render() {
    updateNav();
    updateHeading();
    const list = $("playlist-list");
    list.replaceChildren();
    const visible = lessons.filter((lesson) => {
      const status = computeWatchStatus(progressMap[lesson.liveId]);
      if (filter === "watched") return status === "watched";
      if (filter === "unwatched") return lesson.available && status !== "watched";
      return true;
    });
    if (!visible.length) {
      $("playlist-status").textContent = lessons.length ? "当前筛选条件下没有课次。" : "未获取到同课程目录。";
      $("playlist-status").hidden = false;
      return;
    }
    $("playlist-status").hidden = true;
    for (const lesson of visible) {
      const record = progressMap[lesson.liveId];
      const meta = lessonStatusMeta(lesson, record);
      const isCurrent = lesson.liveId === currentLiveId;
      const li = doc.createElement("li");
      li.className = "playlist-item";
      li.dataset.liveId = lesson.liveId;
      li.dataset.status = meta.status;
      li.dataset.current = String(isCurrent);

      const selectBtn = doc.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "lesson-select";
      selectBtn.disabled = switching || !lesson.available;
      if (isCurrent) selectBtn.setAttribute("aria-current", "true");

      const top = doc.createElement("div");
      top.className = "lesson-top";
      const ord = doc.createElement("span");
      ord.className = "lesson-index";
      ord.textContent = String(lesson.index).padStart(2, "0");
      const title = doc.createElement("strong");
      title.className = "lesson-title";
      title.textContent = lesson.title;
      top.append(ord, title);
      if (isCurrent) {
        const nowTag = doc.createElement("span");
        nowTag.className = "lesson-now";
        nowTag.textContent = "当前";
        top.append(nowTag);
      }

      const sub = doc.createElement("div");
      sub.className = "lesson-meta";
      const schedule = [lesson.shortDate || lesson.date, lesson.timeRange].filter(Boolean).join(" ");
      const scheduleSpan = doc.createElement("span");
      scheduleSpan.textContent = schedule || "录播回放";
      const stateSpan = doc.createElement("span");
      stateSpan.className = `lesson-state state-${meta.status}`;
      stateSpan.textContent = meta.badge;
      sub.append(scheduleSpan, stateSpan);

      selectBtn.append(top, sub);
      if (meta.percent > 0 && lesson.available) {
        const bar = doc.createElement("div");
        bar.className = "lesson-progress";
        const fill = doc.createElement("span");
        fill.style.width = `${meta.percent}%`;
        bar.append(fill);
        selectBtn.append(bar);
      }
      selectBtn.addEventListener("click", () => onSelectLesson(lesson.liveId));

      li.append(selectBtn);
      if (lesson.available) {
        const markBtn = doc.createElement("button");
        markBtn.type = "button";
        markBtn.className = "lesson-mark";
        const isWatched = meta.status === "watched";
        markBtn.setAttribute("aria-pressed", String(isWatched));
        markBtn.title = isWatched ? "标记为未看" : "标记为已看";
        markBtn.innerHTML = isWatched
          ? '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.3 2.3 4.8-5"/></svg>'
          : '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>';
        markBtn.setAttribute("aria-label", `${lesson.title}${isWatched ? "，标记为未看" : "，标记为已看"}`);
        markBtn.addEventListener("click", () => onToggleWatched(lesson.liveId));
        li.append(markBtn);
      }
      list.append(li);
    }
  }

  function show(open, { focus = true } = {}) {
    if (open && !$("review").hidden) {
      $("review").hidden = true;
      $("toggle-review").setAttribute("aria-expanded", "false");
    }
    $("playlist-panel").hidden = !open;
    $("toggle-playlist").setAttribute("aria-expanded", String(open));
    onLayoutChange();
    if (open) {
      scrollCurrentIntoView();
      if (focus) $("playlist-filter").focus();
    } else if (focus) {
      $("toggle-playlist").focus();
    }
  }

  function cancelCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    countdownTarget = null;
    countdownLeft = 0;
    $("next-countdown").hidden = true;
  }

  function startCountdown(nextLesson) {
    cancelCountdown();
    countdownTarget = nextLesson;
    countdownLeft = AUTO_NEXT_SECONDS;
    const renderCountdown = () => {
      $("next-countdown-text").textContent = `${countdownLeft} 秒后自动播放下一节：第 ${nextLesson.index} 讲 · ${nextLesson.title}`;
    };
    renderCountdown();
    $("next-countdown").hidden = false;
    countdownTimer = setInterval(() => {
      countdownLeft -= 1;
      if (countdownLeft <= 0) {
        const target = countdownTarget;
        cancelCountdown();
        if (target) onSelectLesson(target.liveId);
      } else {
        renderCountdown();
      }
    }, 1000);
  }

  $("prev-lesson").addEventListener("click", () => { const prev = adjacentLesson(-1); if (prev) onSelectLesson(prev.liveId); });
  $("next-lesson").addEventListener("click", () => { const next = adjacentLesson(1); if (next) onSelectLesson(next.liveId); });
  $("play-next-now").addEventListener("click", () => {
    const target = countdownTarget || adjacentLesson(1);
    cancelCountdown();
    if (target) onSelectLesson(target.liveId);
  });
  $("cancel-next").addEventListener("click", cancelCountdown);
  $("auto-next").addEventListener("change", () => {
    autoPlayNext = /** @type {HTMLInputElement} */ ($("auto-next")).checked;
    if (!autoPlayNext) cancelCountdown();
    onAutoNextChange(autoPlayNext);
  });
  $("toggle-playlist").addEventListener("click", () => show($("playlist-panel").hidden));
  $("close-playlist").addEventListener("click", () => show(false));
  doc.querySelectorAll(".side-tab-review").forEach((button) => button.addEventListener("click", () => onOpenReview()));
  doc.querySelectorAll(".side-tab-playlist").forEach((button) => button.addEventListener("click", () => show(true)));
  $("refresh-playlist").addEventListener("click", () => onRefresh());
  $("playlist-filter").addEventListener("change", () => {
    filter = /** @type {HTMLSelectElement} */ ($("playlist-filter")).value;
    render();
  });
  $("playlist-locate").addEventListener("click", () => {
    if (filter !== "all") {
      filter = "all";
      /** @type {HTMLSelectElement} */ ($("playlist-filter")).value = "all";
      render();
    }
    scrollCurrentIntoView();
  });

  return {
    get lessons() { return lessons; },
    get progressMap() { return progressMap; },
    get autoPlayNext() { return autoPlayNext; },
    setLessons(next) { lessons = Array.isArray(next) ? next : []; },
    setProgressMap(next) { progressMap = next && typeof next === "object" ? next : {}; },
    setProgressRecord(liveId, record) {
      progressMap[liveId] = record;
      if (lessons.length) render();
    },
    setCurrentLiveId(liveId) { currentLiveId = liveId || ""; },
    setSwitching(next) { switching = !!next; },
    setAutoPlayNext(next) {
      autoPlayNext = !!next;
      /** @type {HTMLInputElement} */ ($("auto-next")).checked = autoPlayNext;
      if (!autoPlayNext) cancelCountdown();
    },
    setRefreshDisabled(disabled) { /** @type {HTMLButtonElement} */ ($("refresh-playlist")).disabled = !!disabled; },
    setStatus(text = "") {
      $("playlist-status").textContent = text;
      $("playlist-status").hidden = !text;
    },
    adjacentLesson,
    updateHeading,
    updateNav,
    render,
    show,
    scrollCurrentIntoView,
    startCountdown,
    cancelCountdown,
    destroy: cancelCountdown
  };
}
