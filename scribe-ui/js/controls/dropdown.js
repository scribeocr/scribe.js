/**
 * The time after the menu opens during which a release over a row is ignored.
 */
const HOLD_MS = 200;

/** @param {HTMLElement} row */
const isDisabled = (row) => row.classList.contains('disabled') || row.getAttribute('aria-disabled') === 'true' || /** @type {HTMLButtonElement} */ (row).disabled === true;

/**
 * Give a menu that opens from buttons the behavior of a native menu.
 * A release over a row or Enter on it fires the row's click.
 * @param {Object} opts
 * @param {(anchor: HTMLElement) => ?HTMLElement} opts.show - Show the menu for the button `anchor` and return the menu element, or null to leave it closed.
 * @param {() => void} opts.hide - Hide or remove the menu.
 * @param {string} opts.rows - Selector for the menu's rows.
 * @returns {{
 *   attachTrigger: (el: HTMLElement) => void,
 *   open: (anchor: HTMLElement, focusRow?: 'first' | 'last' | null) => boolean,
 *   close: (refocus?: boolean) => void,
 *   isOpen: () => boolean,
 *   destroy: () => void,
 * }}
 */
export function createDropdown({ show, hide, rows }) {
  /** @type {Set<HTMLElement>} */
  const triggers = new Set();
  /** @type {?HTMLElement} */
  let menu = null;
  /** @type {?HTMLElement} */
  let anchor = null;
  let openedAt = 0;
  let pressType = '';
  let pressOnAnchor = false;
  let pressInMenu = false;
  /** @type {?HTMLElement} */
  let pressRow = null;
  let ignoreClick = false;
  let deferTimer = 0;

  const isOpen = () => menu !== null;
  /** @param {?Node} node */
  const inTrigger = (node) => {
    for (const t of triggers) {
      if (!t.isConnected) triggers.delete(t);
      else if (node && t.contains(node)) return true;
    }
    return false;
  };
  /** @param {?Element} node */
  const rowAt = (node) => {
    const row = node && node.closest ? /** @type {?HTMLElement} */ (node.closest(rows)) : null;
    return row && menu && menu.contains(row) ? row : null;
  };
  // Rows hidden by CSS, such as a collapsed submenu's, match the selector too.
  const liveRows = () => (menu ? /** @type {HTMLElement[]} */ ([...menu.querySelectorAll(rows)]).filter((r) => !isDisabled(r) && r.offsetParent !== null) : []);
  const focusAnchor = () => {
    const target = anchor && anchor.isConnected ? anchor : [...triggers].find((t) => t.isConnected);
    if (target) target.focus();
  };
  /** @param {HTMLElement} row */
  const run = (row) => {
    row.click();
    ignoreClick = true;
  };

  const close = (refocus = false) => {
    if (!menu) return;
    const focusInside = menu.contains(document.activeElement);
    clearTimeout(deferTimer);
    deferTimer = 0;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    menu.removeEventListener('pointerover', onMenuPointerOver);
    menu = null;
    pressOnAnchor = false;
    pressInMenu = false;
    pressRow = null;
    hide();
    for (const t of triggers) {
      if (t.isConnected) t.setAttribute('aria-expanded', 'false');
      else triggers.delete(t);
    }
    if (refocus || focusInside) focusAnchor();
    anchor = null;
  };

  /**
   * Open the menu from the button `el`.
   * @param {HTMLElement} el
   * @param {'first' | 'last' | null} [focusRow] - The row that takes focus, for a keyboard open.
   */
  const open = (el, focusRow = null) => {
    if (menu) close();
    const shown = show(el);
    if (!shown) return false;
    menu = shown;
    anchor = el;
    openedAt = performance.now();
    ignoreClick = false;
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (menu.querySelectorAll(rows))) {
      if (!row.hasAttribute('tabindex') && row.tabIndex < 0) row.tabIndex = -1;
    }
    for (const t of triggers) {
      if (t.isConnected) t.setAttribute('aria-expanded', String(t === el));
      else triggers.delete(t);
    }
    document.addEventListener('pointerup', onDocPointerUp, true);
    document.addEventListener('pointercancel', onDocPointerCancel, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    menu.addEventListener('pointerover', onMenuPointerOver);
    // A menu opened by a release still gets that release's click in this task, which must not dismiss it.
    deferTimer = setTimeout(() => {
      deferTimer = 0;
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('click', onDocClick, true);
    }, 0);
    if (focusRow && !menu.contains(document.activeElement)) {
      const list = liveRows();
      const row = focusRow === 'first' ? list[0] : list[list.length - 1];
      if (row) row.focus();
    }
    return true;
  };

  /** @param {PointerEvent} e */
  function onDocPointerDown(e) {
    ignoreClick = false;
    if (!menu) return;
    const t = /** @type {Node} */ (e.target);
    if (menu.contains(t)) {
      if (e.button === 0) {
        pressInMenu = true;
        pressRow = rowAt(/** @type {Element} */(t));
      }
      return;
    }
    // The button's own handler decides what a press on it does.
    if (inTrigger(t)) return;
    close();
  }
  /** @param {PointerEvent} e */
  function onDocPointerUp(e) {
    if (!menu || e.button !== 0) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const row = rowAt(under);
    const outside = !menu.contains(under) && !inTrigger(under);
    if (pressOnAnchor) {
      pressOnAnchor = false;
      if (outside) close();
      else if (row && performance.now() - openedAt >= HOLD_MS) run(row);
      else ignoreClick = true;
      return;
    }
    if (!pressInMenu) return;
    pressInMenu = false;
    const from = pressRow;
    pressRow = null;
    // A press and release on the same row already fires that row's click.
    if (row) {
      if (row !== from) run(row);
    } else if (outside) {
      close();
    }
  }
  function onDocPointerCancel() {
    pressOnAnchor = false;
    pressInMenu = false;
    pressRow = null;
  }
  /** @param {MouseEvent} e */
  function onDocClick(e) {
    // A release the menu handled is followed by a click on the common ancestor of the press and release targets, which must not dismiss it.
    if (ignoreClick) {
      ignoreClick = false;
      return;
    }
    if (!menu) return;
    const t = /** @type {Node} */ (e.target);
    if (menu.contains(t) || inTrigger(t)) return;
    close();
  }
  /** @param {KeyboardEvent} e */
  function onDocKeyDown(e) {
    if (!menu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const active = document.activeElement;
    const list = liveRows();
    if (!menu.contains(active)) {
      if (anchor && active && anchor.contains(active) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const row = e.key === 'ArrowDown' ? list[0] : list[list.length - 1];
        if (row) row.focus();
      }
      return;
    }
    const i = list.indexOf(/** @type {HTMLElement} */(rowAt(active) || active));
    /** @param {HTMLElement | undefined} row */
    const go = (row) => {
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      row.focus();
    };
    if (e.key === 'ArrowDown') go(list[(i + 1) % list.length]);
    else if (e.key === 'ArrowUp') go(i < 0 ? list[list.length - 1] : list[(i - 1 + list.length) % list.length]);
    else if (e.key === 'Home') go(list[0]);
    else if (e.key === 'End') go(list[list.length - 1]);
    else if (e.key === 'Enter' || e.key === ' ') {
      const row = rowAt(active);
      if (row && !isDisabled(row)) {
        e.preventDefault();
        e.stopPropagation();
        run(row);
      }
    } else if (e.key === 'Tab') {
      focusAnchor();
      close();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const next = list.slice(i + 1).concat(list.slice(0, i + 1)).find((r) => (r.textContent || '').trim().toLowerCase().startsWith(k));
      go(next);
    }
  }
  /** @param {PointerEvent} e */
  function onMenuPointerOver(e) {
    // Rows highlight on focus as well as hover, so the hovered row takes the focus to keep one row highlighted.
    if (!menu || !menu.contains(document.activeElement)) return;
    const row = rowAt(/** @type {Element} */(e.target));
    if (row && row !== document.activeElement && !isDisabled(row)) row.focus();
  }

  /** @param {PointerEvent} e */
  function onTriggerPointerDown(e) {
    pressType = e.pointerType;
    // A finger or pen opens on the tap's click instead, since a touch press may turn into a scroll.
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    const el = /** @type {HTMLElement} */ (e.currentTarget);
    if (menu && anchor === el) {
      close();
      return;
    }
    if (open(el)) pressOnAnchor = true;
  }
  /** @param {MouseEvent} e */
  function onTriggerClick(e) {
    const el = /** @type {HTMLElement} */ (e.currentTarget);
    // A click from the keyboard or a script has a detail of 0.
    if (e.detail === 0) {
      if (menu && anchor === el) close(true);
      else open(el, 'first');
      return;
    }
    if (pressType === 'mouse') return;
    if (menu && anchor === el) close();
    else open(el);
  }
  /** @param {KeyboardEvent} e */
  function onTriggerKeyDown(e) {
    const el = /** @type {HTMLElement} */ (e.currentTarget);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (menu) return;
      e.preventDefault();
      open(el, e.key === 'ArrowDown' ? 'first' : 'last');
      return;
    }
    // A button already turns these keys into a click.
    if ((e.key === 'Enter' || e.key === ' ') && el.tagName !== 'BUTTON') {
      e.preventDefault();
      if (menu && anchor === el) close(true);
      else open(el, 'first');
    }
  }

  /** @param {HTMLElement} el */
  const attachTrigger = (el) => {
    if (triggers.has(el)) return;
    triggers.add(el);
    if (!el.hasAttribute('aria-haspopup')) el.setAttribute('aria-haspopup', 'menu');
    el.setAttribute('aria-expanded', String(menu !== null && anchor === el));
    el.addEventListener('pointerdown', onTriggerPointerDown);
    el.addEventListener('click', onTriggerClick);
    el.addEventListener('keydown', onTriggerKeyDown);
  };
  const destroy = () => {
    close();
    for (const t of triggers) {
      t.removeEventListener('pointerdown', onTriggerPointerDown);
      t.removeEventListener('click', onTriggerClick);
      t.removeEventListener('keydown', onTriggerKeyDown);
    }
    triggers.clear();
  };

  return {
    attachTrigger, open, close, isOpen, destroy,
  };
}
