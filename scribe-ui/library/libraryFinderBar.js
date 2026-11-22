// The document library's full-window Finder toolbar.
const COMPACT = 100;
const MEDIUM = 200;
const LARGE = 300;
const MAX_IDLE = 320;
const ICON = 28;
const GAP = 8;
const ROW_BREAKPOINT = 485;
const ROW_HEIGHT = 40;

/**
 * @param {{
 *   bar: HTMLElement, controls: HTMLElement, surface: HTMLElement, title: HTMLElement,
 *   field: HTMLElement, input: HTMLInputElement, clear: HTMLElement, find: HTMLButtonElement,
 *   view: HTMLElement, sort: HTMLElement, separator: HTMLElement, add: HTMLElement, refresh: HTMLElement, more: HTMLElement,
 *   fontOf: (element: HTMLElement) => string, truncate: (text: string, width: number, font: string) => string,
 * }} elements
 */
export function createFinderBar({
  bar, controls, surface, title, field, input, clear, find, view, sort, separator, add, refresh, more, fontOf, truncate,
}) {
  const actions = {
    view, sort, separator, add, refresh, more,
  };
  const fromRight = /** @type {Array<[keyof typeof actions, HTMLElement]>} */ (Object.entries(actions)).reverse();
  const sortButton = /** @type {HTMLButtonElement} */ (sort.firstElementChild);
  const addButton = /** @type {HTMLButtonElement} */ (add.firstElementChild);
  const startZone = /** @type {HTMLElement} */ (title.closest('.scribe-library-bar-title')?.parentElement);
  const endZone = /** @type {HTMLElement} */ (controls.parentElement);
  const measure = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'));
  const row = document.createElement('div');
  row.className = 'scribe-library-finder-row';
  row.setAttribute('aria-hidden', 'true');
  surface.prepend(row);

  // The name is cut by the widths of three spans, its head, an ellipsis and its tail, which can transition where a text-overflow cut cannot.
  const label = document.createElement('span');
  label.className = 'scribe-library-finder-label';
  const pieces = ['head', 'dots', 'tail'].map((part) => {
    const el = document.createElement('span');
    el.className = `scribe-library-name-piece ${part}`;
    el.setAttribute('aria-hidden', 'true');
    return el;
  });

  /** @param {HTMLElement} el @param {string} prop @param {number} val */
  const pixels = (el, prop, val) => el.style.setProperty(prop, `${val}px`);
  const dimensions = () => {
    sortButton.style.width = '';
    addButton.style.width = '';
    for (const el of [sortButton, addButton]) el.classList.remove('icon-only');
    for (const el of Object.values(actions)) el.hidden = false;
    const width = (/** @type {HTMLElement} */ el) => Math.ceil(el.getBoundingClientRect().width);
    const widths = {
      view: width(view), sort: width(sort), separator: width(separator), add: width(add), refresh: width(refresh), more: width(more),
    };
    const dividerStyle = getComputedStyle(separator);
    const dividerMargin = parseFloat(dividerStyle.marginLeft) + parseFloat(dividerStyle.marginRight);
    const fieldStyle = getComputedStyle(field);
    const inputStyle = getComputedStyle(input);
    const fieldFrame = parseFloat(fieldStyle.paddingLeft) + parseFloat(fieldStyle.paddingRight)
      + parseFloat(fieldStyle.borderLeftWidth) + parseFloat(fieldStyle.borderRightWidth)
      + parseFloat(getComputedStyle(/** @type {SVGElement} */ (field.firstElementChild)).width)
      + parseFloat(getComputedStyle(clear).width) + 2 * parseFloat(fieldStyle.columnGap)
      + parseFloat(inputStyle.marginLeft) + parseFloat(inputStyle.marginRight);
    return {
      widths, dividerMargin, fieldFrame, inputFont: fontOf(input), titleFont: fontOf(title),
    };
  };
  /** @type {?ReturnType<typeof dimensions>} */
  let dims = null;
  let name = '';
  let editing = false;
  let tier = 0;
  let lastRoom = -1;
  let lastBarWidth = -1;
  let lastTier = -1;
  let lastIconOpen = false;
  let lastLip = -1;
  let rowOpen = false;
  let iconAtRest = false;

  /** @param {string} fullName @param {boolean} [resized] */
  const fit = (fullName, resized = false) => {
    const br = bar.getBoundingClientRect();
    if (!br.width || !controls.getClientRects().length || !br.height) return;
    if (!dims) {
      dims = dimensions();
      startZone.classList.add('scribe-finder-start');
      endZone.classList.add('scribe-finder-end');
      controls.classList.add('scribe-finder-controls');
      title.classList.add('scribe-finder-name');
      title.replaceChildren(label, ...pieces);
      field.style.width = '';
      field.classList.remove('popped');
      editing = field.contains(document.activeElement);
      zoneObserver.observe(startZone, { box: 'border-box' });
      zoneObserver.observe(endZone, { box: 'border-box' });
    }
    const {
      widths, dividerMargin, fieldFrame, inputFont, titleFont,
    } = dims;
    const left = title.getBoundingClientRect().left;
    const corner = endZone.querySelector('.scribe-shell-corner');
    const end = corner ? corner.getBoundingClientRect().left : br.right - parseFloat(getComputedStyle(endZone).paddingRight);
    const room = Math.max(0, end - left - GAP);
    const animate = name === fullName && Math.abs(room - lastRoom) < 0.5 && br.width === lastBarWidth;
    if (resized && animate) return;
    bar.classList.toggle('scribe-finder-motion', animate);
    row.classList.toggle('scribe-finder-motion', animate);
    name = fullName;
    lastRoom = room;
    lastBarWidth = br.width;
    measure.font = titleFont;
    const nameWidth = measure.measureText(name).width;
    const separateRow = br.width < ROW_BREAKPOINT;

    /**
     * The fit for a field of `requested` px, with the name allowed `nameCap` px at most.
     * @param {number} requested @param {number} nameCap @param {boolean} idle
     */
    const arrange = (requested, nameCap, idle) => {
      const slots = { ...widths, more: 0 };
      let icon = false;
      const actionsWidth = () => Object.values(slots).reduce((sum, w) => sum + (w ? w + GAP : 0), slots.separator ? dividerMargin : 0);
      const fits = () => nameCap + (icon ? ICON : requested) + actionsWidth() <= room;
      if (!fits()) slots.sort = ICON;
      if (!fits()) slots.add = ICON;
      if (!fits()) { slots.refresh = 0; slots.more = ICON; }
      if (!fits()) { slots.separator = 0; slots.add = 0; }
      if (!fits()) slots.sort = 0;
      if (!fits()) slots.view = 0;
      if (!fits() && idle) icon = true;
      const available = Math.max(0, room - actionsWidth());
      const budget = Math.min(nameCap, Math.max(0, available - (icon ? ICON : requested)));
      const text = truncate(name, budget + 0.001, titleFont);
      const titleWidth = Math.min(budget, measure.measureText(text).width);
      const fieldWidth = icon ? ICON : Math.min(idle ? MAX_IDLE : requested, available - titleWidth);
      return {
        slots, icon, text, titleWidth, fieldWidth,
      };
    };

    const rest = arrange(COMPACT, nameWidth, true);
    let target = rest;
    iconAtRest = separateRow || rest.icon;
    const base = rest.icon ? COMPACT : rest.fieldWidth;
    const medium = Math.max(base, MEDIUM);
    measure.font = inputFont;
    const needed = input.value ? measure.measureText(input.value).width + fieldFrame + GAP : 0;
    const requiredTier = needed <= base ? 0 : needed <= medium ? 1 : 2;
    tier = editing ? Math.max(tier, requiredTier) : requiredTier;
    measure.font = titleFont;
    const engaged = editing || !!input.value;
    rowOpen = separateRow && engaged;
    const iconOpen = iconAtRest && engaged;
    const appliedTier = separateRow ? 0 : tier;
    const height = controls.clientHeight;
    const lip = separateRow ? Math.max(br.bottom, surface.getBoundingClientRect().top) - (br.top + (br.height - height) / 2) : 0;
    if (animate && appliedTier === lastTier && iconOpen === lastIconOpen && lip === lastLip) return;
    lastTier = appliedTier;
    lastIconOpen = iconOpen;
    lastLip = lip;
    if (engaged && !separateRow) {
      if (rest.icon) target = arrange(base, rest.titleWidth, false);
      // Each tier starts from the name width the tier before left it, so the name never regains letters as the field grows, a paste that skips the middle tier included.
      if (tier >= 1 && medium > base) target = arrange(medium, target.titleWidth, false);
      if (tier === 2 && LARGE > medium) target = arrange(LARGE, target.titleWidth, false);
    }

    const { text, titleWidth, slots } = target;
    const cut = text !== name;
    const keep = cut ? text.length - 1 : name.length;
    const tailCount = Math.floor(keep / 2);
    const tailWidth = Math.min(titleWidth, tailCount ? measure.measureText(name.slice(-tailCount)).width : 0);
    const dotsWidth = cut ? Math.min(titleWidth - tailWidth, measure.measureText('…').width) : 0;
    // At rest the title is one text node, which the browser shapes as usual, ligatures included.
    // The pieces draw only while their widths are in motion.
    const nameChanged = label.textContent !== text;
    if (nameChanged) label.textContent = text;
    for (const [i, w] of [titleWidth - tailWidth - dotsWidth, dotsWidth, tailWidth].entries()) {
      pixels(pieces[i], 'width', w);
    }
    pieces[0].dataset.ink = name;
    pieces[1].dataset.ink = '…';
    pieces[2].dataset.ink = name;
    if (nameChanged || !animate) {
      const moves = pieces.flatMap((el) => el.getAnimations());
      title.classList.toggle('clipping', moves.length > 0);
      if (moves.length) {
        Promise.allSettled(moves.map((a) => a.finished)).then(() => {
          if (!pieces.some((el) => el.getAnimations().length)) title.classList.remove('clipping');
        });
      }
    }

    let right = 0;
    for (const [key, el] of fromRight) {
      const w = slots[key];
      const margin = el === separator && w ? dividerMargin / 2 : 0;
      pixels(el, '--finder-right', right + margin);
      pixels(el, '--finder-width', w);
      el.hidden = !w;
      el.inert = !w;
      if (el === sort || el === add) el.classList.toggle('finder-icon-only', w <= ICON);
      if (w) right += w + GAP + 2 * margin;
    }
    const showIcon = separateRow || target.icon;
    const showField = !showIcon || rowOpen;
    field.hidden = !showField;
    field.inert = !showField;
    find.hidden = !showIcon;
    find.inert = !showIcon;
    find.classList.toggle('on', rowOpen);
    find.setAttribute('aria-expanded', String(showField));
    pixels(field, '--finder-width', rowOpen ? Math.max(0, br.width - 2 * GAP) : showIcon ? ICON : target.fieldWidth);
    pixels(field, '--finder-left', rowOpen ? br.left - left - titleWidth : 0);
    field.classList.toggle('finder-row-field', separateRow);
    pixels(field, '--finder-lip', lip);
    pixels(field, '--scribe-finder-travel', rowOpen ? lip + (ROW_HEIGHT - height) / 2 : 0);
    row.style.height = `${rowOpen ? ROW_HEIGHT : 0}px`;
  };
  // Shell insets and the app-menu button can change the available room without resizing the window.
  // An animated title also resizes these zones, so only refit for an actual change of room.
  const zoneObserver = new ResizeObserver(() => { if (dims) fit(name, true); });

  const setEditing = (/** @type {boolean} */ value) => {
    if (!dims || editing === value) return;
    editing = value;
    fit(name);
  };
  field.addEventListener('focusin', () => setEditing(true));
  field.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof Node && field.contains(e.relatedTarget))) setEditing(false);
  });
  const focus = () => {
    setEditing(true); // Expose the real input before focusing it from a collapsed magnifier.
    input.focus({ preventScroll: true });
  };
  field.addEventListener('pointerdown', (e) => {
    if (!dims || e.button !== 0 || e.target === input || clear.contains(/** @type {Node} */ (e.target))) return;
    e.preventDefault();
    focus();
  });
  const reset = () => {
    if (!dims) return;
    zoneObserver.disconnect();
    dims = null;
    tier = 0;
    lastRoom = -1;
    rowOpen = false;
    iconAtRest = false;
    row.style.height = '0px';
    row.classList.remove('scribe-finder-motion');
    bar.classList.remove('scribe-finder-motion');
    startZone.classList.remove('scribe-finder-start');
    endZone.classList.remove('scribe-finder-end');
    controls.classList.remove('scribe-finder-controls');
    title.classList.remove('scribe-finder-name', 'clipping');
    title.textContent = name;
    field.classList.remove('finder-row-field');
    for (const el of [...Object.values(actions), field, find]) {
      el.inert = false;
      el.hidden = el === find || el === more;
      el.classList.remove('finder-icon-only');
    }
    find.classList.remove('on');
  };
  return {
    fit, focus, reset, rowOpen: () => rowOpen, iconAtRest: () => iconAtRest,
  };
}
