import { mediaRole } from "./player-prefs.js";

// Course ASR subtitles are timed to the classroom/teacher stream; fall back to
// camera 0 when channels have generic labels (matching the replay page DOM).
export function resolveCourseSubtitleAnchor(pair = []) {
  if (pair.length < 2 || !pair[0] || !pair[1]) return 0;
  const classroom = pair.findIndex((item) => mediaRole(item) === "classroom");
  if (classroom >= 0) return classroom;
  const slide = pair.findIndex((item) => mediaRole(item) === "slide");
  if (slide >= 0) return 1 - slide;
  return 0;
}

// Keep at most one reusable shared track per video. The review sidebar always
// reads the original track, whose cue times are on its own camera's clock.
export function bindPairedSubtitles(videos, controls) {
  const copies = videos.map(() => ({ track: null, origin: null, shift: 0 }));

  function updateCopy(index, origin, shift, visible, force = false) {
    const copy = copies[index];
    if (!origin && !copy.origin) return;
    if (!copy.track) copy.track = videos[index].addTextTrack("captions", "双路共享字幕");
    const target = copy.track;
    if (force || copy.origin !== origin || copy.shift !== shift) {
      target.mode = "hidden";
      for (const cue of Array.from(target.cues || [])) target.removeCue(cue);
      const { VTTCue } = videos[index].ownerDocument.defaultView;
      for (const cue of Array.from(origin?.cues || [])) {
        const start = Math.max(0, cue.startTime + shift);
        const end = cue.endTime + shift;
        if (!(end > start)) continue;
        const twin = new VTTCue(start, end, cue.text);
        for (const prop of ["id", "vertical", "snapToLines", "line", "lineAlign", "position", "positionAlign", "size", "align", "region"]) {
          if (cue[prop] !== undefined) twin[prop] = cue[prop];
        }
        target.addCue(twin);
      }
      copy.origin = origin;
      copy.shift = shift;
    }
    const mode = !origin ? "disabled" : visible ? "showing" : "hidden";
    if (target.mode !== mode) target.mode = mode;
  }

  return function update(offset, visible, { force = false, courseAnchor = 0 } = {}) {
    const sources = controls.map(control => control.source);
    const [first, second] = sources;
    const sameCourse = first?.mode === "course" && second?.mode === "course" && first.vtt === second.vtt;
    const anchor = courseAnchor === 1 ? 1 : 0;
    const origins = sources.map((own, index) => {
      const other = 1 - index;
      if (own?.mode === "file") return index;
      if (sources[other]?.mode === "file") return other;
      if (sameCourse) return anchor;
      if (own) return index;
      return sources[other] ? other : null;
    });
    controls.forEach((control, i) => control.setDisplay(visible && origins[i] === i));
    origins.forEach((source, i) => {
      const origin = source !== null && source !== i ? sources[source].track : null;
      updateCopy(i, origin, i === 1 ? offset : -offset, visible, force);
    });
    return origins;
  };
}
