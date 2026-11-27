export function isEditableTarget(target) {
  const ElementCtor = target?.ownerDocument?.defaultView?.Element || globalThis.Element;
  if (!ElementCtor || !(target instanceof ElementCtor)) return false;
  if (target.isContentEditable) return true;
  if (target.matches("textarea, select")) return true;
  return target.matches("input") && target.id !== "timeline";
}

export function bindPlayerShortcuts(doc, { getEngine, onTogglePlayback, onSeekDelta, onVolumeDelta }) {
  const ElementCtor = doc.defaultView?.Element || globalThis.Element;
  const onKeyDown = (event) => {
    const engine = getEngine();
    if (!engine?.range() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (isEditableTarget(target)) return;
    if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 5;
      onSeekDelta(event.code === "ArrowRight" ? step : -step);
      return;
    }
    if (event.code === "Space") {
      if (ElementCtor && target instanceof ElementCtor && target.matches("a, summary, button:not(#play):not(#back):not(#forward)")) return;
      event.preventDefault();
      onTogglePlayback();
      return;
    }
    if ((event.code === "ArrowUp" || event.code === "ArrowDown") && engine.audio >= 0) {
      if (ElementCtor && target instanceof ElementCtor && target.matches("button, a, summary")) return;
      event.preventDefault();
      onVolumeDelta(event.code === "ArrowUp" ? 0.1 : -0.1);
    }
  };
  doc.addEventListener("keydown", onKeyDown);
  return () => doc.removeEventListener("keydown", onKeyDown);
}
