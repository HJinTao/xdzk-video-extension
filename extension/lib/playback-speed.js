export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
export const PRESET_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

const POPOVER_OPEN_EVENT = "xdzk:ui-popover-open";
let nextSpeedId = 0;

/**
 * @param {HTMLElement} panel
 * @param {(rate: number) => void} changeRate
 */
export function bindPlaybackSpeed(panel, changeRate) {
  const doc = panel.ownerDocument;
  const win = doc.defaultView;
  const popoverId = `speed-popover-${++nextSpeedId}`;
  panel.innerHTML = `<span class="speed-label">倍速</span>
    <div class="speed-stepper" data-open="false">
      <button type="button" class="speed-step speed-slower" aria-label="减慢 0.1 倍" title="减慢 0.1×">−</button>
      <button type="button" class="speed-step speed-faster" aria-label="加快 0.1 倍" title="加快 0.1×">+</button>
      <select class="sr-only" tabindex="-1" aria-hidden="true" aria-label="播放倍速"></select>
      <button type="button" class="speed-trigger" role="combobox" aria-haspopup="dialog" aria-expanded="false" aria-controls="${popoverId}" aria-label="选择播放倍速">
        <span class="speed-trigger-value">1×</span>
        <svg viewBox="0 0 24 24" class="icon ui-select-chevron" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div id="${popoverId}" class="speed-popover" role="dialog" aria-label="播放倍速设置" hidden>
        <div class="speed-presets" role="listbox" aria-label="常用倍速"></div>
        <div class="speed-custom">
          <label class="rate-values">
            <span>自定义</span>
            <span class="number-field"><input type="number" step="any" inputmode="decimal" aria-label="自定义播放倍速"><span class="number-unit">×</span></span>
          </label>
        </div>
      </div>
    </div>`;

  const stepper = /** @type {HTMLElement} */ (panel.querySelector(".speed-stepper"));
  const select = /** @type {HTMLSelectElement} */ (panel.querySelector("select"));
  if (panel.dataset.selectId) select.id = panel.dataset.selectId;
  const input = /** @type {HTMLInputElement} */ (panel.querySelector("input"));
  input.min = String(MIN_RATE);
  input.max = String(MAX_RATE);
  input.required = true;
  input.title = `${MIN_RATE}× 至 ${MAX_RATE}×`;
  const slower = /** @type {HTMLButtonElement} */ (panel.querySelector(".speed-slower"));
  const faster = /** @type {HTMLButtonElement} */ (panel.querySelector(".speed-faster"));
  const trigger = /** @type {HTMLButtonElement} */ (panel.querySelector(".speed-trigger"));
  const triggerValue = /** @type {HTMLElement} */ (panel.querySelector(".speed-trigger-value"));
  const popover = /** @type {HTMLElement} */ (panel.querySelector(".speed-popover"));
  const presetsBox = /** @type {HTMLElement} */ (panel.querySelector(".speed-presets"));

  let current = 1;
  /** @type {HTMLOptionElement | undefined} */
  let custom;
  let isOpen = false;

  function option(rate) {
    const item = doc.createElement("option");
    item.value = String(rate);
    item.textContent = `${rate}×`;
    return item;
  }

  select.replaceChildren(...PRESET_RATES.map(option));
  const presetButtons = PRESET_RATES.map((rate) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "speed-preset";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", "false");
    btn.dataset.rate = String(rate);
    btn.textContent = `${rate}×`;
    btn.addEventListener("click", () => {
      apply(rate);
      close(true);
    });
    return btn;
  });
  presetsBox.replaceChildren(...presetButtons);

  function open() {
    if (isOpen) return;
    doc.dispatchEvent(new (win?.CustomEvent || CustomEvent)(POPOVER_OPEN_EVENT, { detail: stepper }));
    const rect = trigger.getBoundingClientRect();
    const viewHeight = win?.innerHeight || 0;
    const spaceBelow = viewHeight - rect.bottom;
    stepper.dataset.placement = viewHeight > 0 && spaceBelow < 220 && rect.top > spaceBelow ? "top" : "bottom";
    isOpen = true;
    stepper.dataset.open = "true";
    trigger.setAttribute("aria-expanded", "true");
    popover.hidden = false;
  }

  function close(restoreFocus = false) {
    if (!isOpen) return;
    isOpen = false;
    stepper.dataset.open = "false";
    trigger.setAttribute("aria-expanded", "false");
    popover.hidden = true;
    if (restoreFocus) trigger.focus();
  }

  function set(rate) {
    if (rate === current && triggerValue.textContent === `${rate}×`) return;
    current = rate;
    custom?.remove();
    if (!PRESET_RATES.includes(rate)) { custom = option(rate); select.append(custom); }
    select.value = String(rate);
    triggerValue.textContent = `${rate}×`;
    presetButtons.forEach((btn) => {
      btn.setAttribute("aria-selected", String(Number(btn.dataset.rate) === rate));
    });
    if (doc.activeElement !== input) input.value = String(rate);
    slower.disabled = rate <= MIN_RATE;
    faster.disabled = rate >= MAX_RATE;
  }

  function apply(rate) {
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE || rate === current) return;
    set(rate);
    changeRate(rate);
  }

  const nudge = (step) => apply(Math.max(MIN_RATE, Math.min(MAX_RATE, Number((current + step).toFixed(6)))));
  select.addEventListener("change", () => apply(Number(select.value)));
  slower.addEventListener("click", () => nudge(-0.1));
  faster.addEventListener("click", () => nudge(0.1));
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen) close(false);
    else open();
  });
  input.addEventListener("change", () => { if (input.reportValidity()) apply(input.valueAsNumber); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && input.reportValidity()) {
      event.preventDefault();
      apply(input.valueAsNumber);
      input.blur();
      close(true);
    }
  });
  input.addEventListener("blur", () => { input.value = String(current); });

  const onOutsidePointer = (event) => {
    if (isOpen && !stepper.contains(/** @type {Node} */ (event.target))) close(false);
  };
  const onOtherPopover = (event) => {
    if (isOpen && /** @type {CustomEvent} */ (event).detail !== stepper) close(false);
  };
  const onKeyDown = (event) => {
    if (isOpen && event.key === "Escape") { event.preventDefault(); close(true); }
  };
  doc.addEventListener("pointerdown", onOutsidePointer);
  doc.addEventListener(POPOVER_OPEN_EVENT, onOtherPopover);
  doc.addEventListener("keydown", onKeyDown);

  set(1);
  return {
    set,
    destroy() {
      doc.removeEventListener("pointerdown", onOutsidePointer);
      doc.removeEventListener(POPOVER_OPEN_EVENT, onOtherPopover);
      doc.removeEventListener("keydown", onKeyDown);
    }
  };
}
