export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
export const PRESET_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

export function bindPlaybackSpeed(panel, changeRate) {
  const doc = panel.ownerDocument;
  panel.innerHTML = `<label>倍速 <select aria-label="播放倍速"></select></label>
    <details><summary>自定义倍速</summary><div class="rate-values">
      <button type="button" aria-label="减慢 0.1 倍">−0.1×</button>
      <label><input type="number" step="any" inputmode="decimal" aria-label="自定义播放倍速"> ×</label>
      <button type="button" aria-label="加快 0.1 倍">+0.1×</button>
    </div></details>`;
  const select = panel.querySelector("select");
  if (panel.dataset.selectId) select.id = panel.dataset.selectId;
  const input = panel.querySelector("input");
  input.min = MIN_RATE;
  input.max = MAX_RATE;
  input.required = true;
  input.title = `${MIN_RATE}× 至 ${MAX_RATE}×`;
  const [slower, faster] = panel.querySelectorAll("button");
  let current;
  let custom;
  function option(rate) {
    const item = doc.createElement("option");
    item.value = String(rate);
    item.textContent = `${rate}×`;
    return item;
  }
  select.replaceChildren(...PRESET_RATES.map(option));
  function set(rate) {
    if (rate === current) return;
    current = rate;
    custom?.remove();
    if (!PRESET_RATES.includes(rate)) { custom = option(rate); select.append(custom); }
    select.value = String(rate);
    if (doc.activeElement !== input) input.value = rate;
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
  input.addEventListener("change", () => { if (input.reportValidity()) apply(input.valueAsNumber); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && input.reportValidity()) {
      event.preventDefault();
      apply(input.valueAsNumber);
      input.blur();
    }
  });
  input.addEventListener("blur", () => { input.value = current; });
  set(1);
  return { set };
}
