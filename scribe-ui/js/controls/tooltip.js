const SHOW_MS = 800;
const GAP = 6;
const EDGE = 6;

/**
 * Give each control inside `root` that has a `data-tip` attribute a tooltip showing that text.
 * A `data-tip-key` attribute adds the control's keyboard shortcut after the text.
 * @param {HTMLElement} root - A positioned element carrying the class passed to `addControlStyles`.
 * @returns {() => void} Removes the tooltips.
 */
export function installTooltips(root) {
  const tip = document.createElement('div');
  tip.className = 'scribe-tip';
  tip.setAttribute('role', 'tooltip');
  root.appendChild(tip);
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let timer = 0;
  /** @type {?HTMLElement} */
  let current = null;
  /** @type {?HTMLElement} The control the pointer pressed and has not left. */
  let pressed = null;

  /** @param {EventTarget | null} t */
  const anchorOf = (t) => (t instanceof Element ? /** @type {?HTMLElement} */ (t.closest('[data-tip]')) : null);

  const hide = () => {
    clearTimeout(timer);
    timer = 0;
    current = null;
    tip.classList.remove('on');
  };

  /** @param {HTMLElement} el */
  const show = (el) => {
    tip.textContent = el.dataset.tip || '';
    if (el.dataset.tipKey) {
      const key = document.createElement('span');
      key.className = 'scribe-tip-key';
      key.textContent = el.dataset.tipKey;
      tip.appendChild(key);
    }
    const a = el.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const x = Math.max(EDGE, Math.min(a.left - r.left + a.width / 2 - tw / 2, r.width - tw - EDGE));
    let y = a.bottom - r.top + GAP;
    if (y + th > r.height - EDGE) y = a.top - r.top - th - GAP;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    tip.classList.add('on');
    current = el;
  };

  /** @param {HTMLElement} el */
  const arm = (el) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      if (el.isConnected && root.contains(el)) show(el);
    }, SHOW_MS);
  };

  /** @param {MouseEvent} e */
  const onOver = (e) => {
    if (root.classList.contains('scribe-coarse')) return;
    const el = anchorOf(e.target);
    if (!el || el === current || el === pressed) return;
    hide();
    arm(el);
  };
  /** @param {MouseEvent} e */
  const onOut = (e) => {
    const el = anchorOf(e.target);
    if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
    pressed = null;
    hide();
  };
  /** @param {MouseEvent} e */
  const onDown = (e) => {
    pressed = anchorOf(e.target);
    hide();
  };
  /** @param {FocusEvent} e */
  const onFocusIn = (e) => {
    const el = anchorOf(e.target);
    if (!el || !el.matches(':focus-visible')) return;
    hide();
    arm(el);
  };
  /** @param {FocusEvent} e */
  const onFocusOut = (e) => {
    if (anchorOf(e.target)) hide();
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Escape') hide();
  };
  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  root.addEventListener('mousedown', onDown);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('keydown', onKey);
  return () => {
    hide();
    root.removeEventListener('mouseover', onOver);
    root.removeEventListener('mouseout', onOut);
    root.removeEventListener('mousedown', onDown);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    root.removeEventListener('keydown', onKey);
    tip.remove();
  };
}
