const POPOVER_OPEN_EVENT = "xdzk:ui-popover-open";
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" class="icon ui-select-chevron" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" class="icon ui-select-check" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>';

let nextUiId = 0;

/**
 * Progressively enhances a native <select> with a themed floating dropdown while
 * keeping the underlying <select> value, options and change events in sync.
 * @param {HTMLSelectElement} select
 * @param {{ align?: "left" | "right", placement?: "auto" | "top" | "bottom" }} [options]
 */
export function enhanceSelect(select, { align = "left", placement = "auto" } = {}) {
  const doc = select.ownerDocument;
  const win = doc.defaultView;
  const root = doc.createElement("div");
  root.className = "ui-select";
  root.dataset.align = align;
  root.dataset.open = "false";

  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "ui-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const listId = `ui-select-list-${++nextUiId}`;
  trigger.setAttribute("aria-controls", listId);
  if (select.getAttribute("aria-label")) trigger.setAttribute("aria-label", select.getAttribute("aria-label"));

  const valueNode = doc.createElement("span");
  valueNode.className = "ui-select-value";
  trigger.append(valueNode);
  trigger.insertAdjacentHTML("beforeend", CHEVRON_SVG);

  const menu = doc.createElement("div");
  menu.id = listId;
  menu.className = "ui-select-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  if (select.parentNode) select.parentNode.insertBefore(root, select);
  select.classList.add("sr-only", "ui-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  root.append(select, trigger, menu);

  let isOpen = false;
  let activeIndex = -1;
  /** @type {HTMLButtonElement[]} */
  let optionButtons = [];

  function visibleOptions() {
    return Array.from(select.options).filter((opt) => !opt.hidden);
  }

  function highlight(index) {
    if (!optionButtons.length) { activeIndex = -1; return; }
    activeIndex = (index + optionButtons.length) % optionButtons.length;
    optionButtons.forEach((btn, idx) => {
      btn.classList.toggle("is-active", idx === activeIndex);
    });
    const current = optionButtons[activeIndex];
    if (current && typeof current.scrollIntoView === "function") current.scrollIntoView({ block: "nearest" });
  }

  function sync() {
    const opts = visibleOptions();
    const selected = select.selectedOptions?.[0] || opts.find((opt) => opt.value === select.value) || opts[0];
    valueNode.textContent = selected ? selected.textContent.trim() : "";
    trigger.title = valueNode.textContent;
    trigger.disabled = select.disabled || opts.length === 0;
    root.classList.toggle("is-disabled", trigger.disabled);
    if (trigger.disabled && isOpen) close(false);

    const frag = doc.createDocumentFragment();
    optionButtons = opts.map((opt) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "ui-select-option";
      btn.setAttribute("role", "option");
      const isSelected = opt.value === select.value;
      btn.setAttribute("aria-selected", String(isSelected));
      btn.disabled = opt.disabled;
      btn.dataset.value = opt.value;
      const text = doc.createElement("span");
      text.className = "ui-select-option-label";
      text.textContent = opt.textContent.trim();
      btn.append(text);
      btn.insertAdjacentHTML("beforeend", CHECK_SVG);
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        choose(opt.value);
      });
      frag.append(btn);
      return btn;
    });
    menu.replaceChildren(frag);
    const selectedIdx = optionButtons.findIndex((btn) => btn.getAttribute("aria-selected") === "true");
    activeIndex = selectedIdx >= 0 ? selectedIdx : 0;
    if (isOpen && optionButtons.length) highlight(activeIndex);
  }

  function choose(value) {
    const changed = select.value !== value;
    select.value = value;
    close(true);
    sync();
    if (changed) select.dispatchEvent(new (win?.Event || Event)("change", { bubbles: true }));
  }

  function updatePlacement() {
    if (placement === "top" || placement === "bottom") {
      root.dataset.placement = placement;
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const viewHeight = win?.innerHeight || 0;
    const spaceBelow = viewHeight - rect.bottom;
    const spaceAbove = rect.top;
    root.dataset.placement = viewHeight > 0 && spaceBelow < 210 && spaceAbove > spaceBelow ? "top" : "bottom";
  }

  function open() {
    if (isOpen || trigger.disabled) return;
    sync();
    if (!optionButtons.length) return;
    doc.dispatchEvent(new (win?.CustomEvent || CustomEvent)(POPOVER_OPEN_EVENT, { detail: root }));
    updatePlacement();
    isOpen = true;
    root.dataset.open = "true";
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    const selectedIdx = optionButtons.findIndex((btn) => btn.getAttribute("aria-selected") === "true");
    highlight(selectedIdx >= 0 ? selectedIdx : 0);
  }

  function close(restoreFocus = false) {
    if (!isOpen) return;
    isOpen = false;
    root.dataset.open = "false";
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
    if (restoreFocus) trigger.focus();
  }

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen) close(false);
    else open();
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isOpen) open();
      else highlight(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) open();
      else highlight(activeIndex - 1);
    } else if (event.key === "Home" && isOpen) {
      event.preventDefault();
      highlight(0);
    } else if (event.key === "End" && isOpen) {
      event.preventDefault();
      highlight(optionButtons.length - 1);
    } else if ((event.key === "Enter" || event.key === " ") && isOpen) {
      event.preventDefault();
      const target = optionButtons[activeIndex];
      if (target && !target.disabled) choose(target.dataset.value || "");
    } else if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      close(true);
    }
  });

  const onOutsidePointer = (event) => {
    if (isOpen && !root.contains(/** @type {Node} */ (event.target))) close(false);
  };
  const onOtherPopover = (event) => {
    if (isOpen && /** @type {CustomEvent} */ (event).detail !== root) close(false);
  };
  const onKeyDownDoc = (event) => {
    if (isOpen && event.key === "Escape") { event.preventDefault(); close(true); }
  };

  doc.addEventListener("pointerdown", onOutsidePointer);
  doc.addEventListener(POPOVER_OPEN_EVENT, onOtherPopover);
  doc.addEventListener("keydown", onKeyDownDoc);
  select.addEventListener("change", sync);

  const observer = win?.MutationObserver ? new win.MutationObserver(sync) : null;
  observer?.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden"] });

  sync();

  return {
    root,
    trigger,
    menu,
    sync,
    open,
    close,
    focus() { trigger.focus(); },
    destroy() {
      observer?.disconnect();
      doc.removeEventListener("pointerdown", onOutsidePointer);
      doc.removeEventListener(POPOVER_OPEN_EVENT, onOtherPopover);
      doc.removeEventListener("keydown", onKeyDownDoc);
      select.removeEventListener("change", sync);
    }
  };
}

/**
 * Progressively enhances a short-option native <select> (2–3 choices) into an
 * inline segmented pill bar synced with the underlying <select>.
 * @param {HTMLSelectElement} select
 */
export function enhanceSegmentedSelect(select) {
  const doc = select.ownerDocument;
  const win = doc.defaultView;
  const root = doc.createElement("div");
  root.className = "ui-segmented";
  root.setAttribute("role", "radiogroup");
  if (select.getAttribute("aria-label")) root.setAttribute("aria-label", select.getAttribute("aria-label"));

  const wrap = doc.createElement("div");
  wrap.className = "ui-segmented-wrap";
  if (select.parentNode) select.parentNode.insertBefore(wrap, select);
  select.classList.add("sr-only", "ui-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  wrap.append(select, root);

  /** @type {HTMLButtonElement[]} */
  let buttons = [];

  function sync() {
    const opts = Array.from(select.options).filter((opt) => !opt.hidden);
    const frag = doc.createDocumentFragment();
    buttons = opts.map((opt) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "ui-segmented-btn";
      btn.setAttribute("role", "radio");
      const checked = opt.value === select.value;
      btn.setAttribute("aria-checked", String(checked));
      btn.disabled = select.disabled || opt.disabled;
      btn.textContent = opt.textContent.trim();
      btn.dataset.value = opt.value;
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const changed = select.value !== opt.value;
        select.value = opt.value;
        sync();
        if (changed) select.dispatchEvent(new (win?.Event || Event)("change", { bubbles: true }));
      });
      frag.append(btn);
      return btn;
    });
    root.replaceChildren(frag);
    root.classList.toggle("is-disabled", select.disabled);
  }

  select.addEventListener("change", sync);
  const observer = win?.MutationObserver ? new win.MutationObserver(sync) : null;
  observer?.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden"] });

  sync();

  return {
    root: wrap,
    sync,
    focus() {
      const target = buttons.find((btn) => btn.getAttribute("aria-checked") === "true" && !btn.disabled)
        || buttons.find((btn) => !btn.disabled);
      target?.focus();
    },
    destroy() {
      observer?.disconnect();
      select.removeEventListener("change", sync);
    }
  };
}
