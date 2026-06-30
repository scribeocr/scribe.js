import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import {
  ScribeViewer,
} from '../viewer.js';
import { UiText } from './viewerWordObjects.js';

export const colColorsHex = ['#287bb5', '#19aa9a', '#099b57'];

/**
 * Make a DOM element draggable, invoking the handlers on pointerdown/move/up with the pointer mapped to page-local coordinates (image px).
 * @param {HTMLElement} el
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number the element belongs to (its page-local origin).
 * @param {object} handlers
 * @param {(p: {x: number, y: number}) => void} [handlers.onStart]
 * @param {(p: {x: number, y: number}) => void} [handlers.onMove]
 * @param {() => void} [handlers.onEnd]
 */
export function makeDraggable(el, viewer, n, { onStart, onMove, onEnd } = {}) {
  let active = false;
  const toLocal = (e) => {
    const c = viewer.clientToContent(e.clientX, e.clientY);
    return { x: c.x - viewer._pageLeft(n), y: c.y - viewer.getPageStop(n) };
  };
  const onMovePointer = (e) => { if (active && onMove) onMove(toLocal(e)); };
  const onUpPointer = (e) => {
    if (!active) return;
    active = false;
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    el.removeEventListener('pointermove', onMovePointer);
    el.removeEventListener('pointerup', onUpPointer);
    if (onEnd) onEnd();
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    active = true;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (onStart) onStart(toLocal(e));
    el.addEventListener('pointermove', onMovePointer);
    el.addEventListener('pointerup', onUpPointer);
  });
}

/** Resolve the viewer for a layout object. Falls back to the default for backward compat. */
export function getLayoutViewer(obj) {
  return obj?.viewer || obj?.uiRegion?.viewer || obj?.uiTable?.viewer || ScribeViewer.getDefault();
}

/**
 * Converts a hex color to rgba with a specified alpha.
 * @param {string} hex - The hex color code.
 * @param {number} alpha - The alpha value for the rgba color.
 * @returns {string} The rgba color string.
 */
export const hexToRgba = (hex, alpha) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const setAlpha = (color, alpha) => color.replace(/,\s*[\d.]+\)/, `,${alpha})`);

/**
 * A layout box rendered as an absolutely-positioned `<div>` in page (content) space, with an optional editable label (a `UiText`).
 * Exposes the geometry/style accessor surface the layout drag/merge/render code relies on (`x()/y()/width()/height()`, `fill()/stroke()`, `draggable()`, `getClientRect()`, `destroy()`).
 */
export class UiLayout {
  /**
   * @param {LayoutDataColumn|LayoutRegion} layoutBox
   * @param {import('../viewer.js').ScribeViewer} [viewer] - The viewer this layout belongs to.
   *    Falls back to the default viewer when omitted.
   */
  constructor(layoutBox, viewer) {
    const _viewer = viewer || ScribeViewer.getDefault();
    const origX = layoutBox.coords.left;
    const origY = layoutBox.coords.top;
    const width = layoutBox.coords.right - layoutBox.coords.left;
    const height = layoutBox.coords.bottom - layoutBox.coords.top;

    // `instanceof LayoutDataColumn` should not be used to determine the type of the layout box,
    // as this will fail for layout boxes that were created in another thread.
    const n = layoutBox.type === 'dataColumn' ? layoutBox.table.page.n : layoutBox.page.n;

    // "Order" boxes are blue, "exclude" boxes are red, data columns are uncolored, as the color is added by the table.
    let fill = '';
    let stroke = '';
    if (layoutBox.type === 'order') {
      fill = 'rgba(0,137,114,0.25)';
      stroke = 'rgba(0,137,114,0.4)';
    } else if (layoutBox.type === 'exclude') {
      fill = 'rgba(193,84,57,0.25)';
      stroke = 'rgba(0,137,114,0.4)';
    } else if (layoutBox.type === 'dataColumn') {
      const colIndex = layoutBox.table.boxes.findIndex((x) => x.id === layoutBox.id);
      const colorBase = colColorsHex[colIndex % colColorsHex.length];
      fill = hexToRgba(colorBase, 0.3);
    }

    /** @type {import('../viewer.js').ScribeViewer} */
    this.viewer = _viewer;
    this._n = n;
    this.layoutBox = layoutBox;
    this._x = origX;
    this._y = origY;
    this._width = width;
    this._height = height;
    this._fill = fill;
    this._stroke = stroke;
    this._fillEnabled = true;
    this._strokeEnabled = true;
    this._draggable = true;
    this._listening = true;
    /** @type {Object<string, Array<Function>>} Drag/transform handlers keyed by event name. */
    this._handlers = {};
    /** Subclass hook: reposition linked controls while the box is being dragged. */
    this._reposition = () => {};
    /** @type {UiText|undefined} */
    this.label = undefined;

    this.el = document.createElement('div');
    this.el.className = 'scribe-layout';
    this.el.dataset.scribeKind = 'layout';
    /** @type {any} */ (this.el)._scribeObj = this;
    Object.assign(this.el.style, {
      position: 'absolute', boxSizing: 'border-box', cursor: 'move', zIndex: '1',
    });
    this._applyStyle();
    this._position();

    this.select = () => {
      this.stroke('rgba(40,123,181,1)');
      this.fill(setAlpha(this.fill(), 0.4));
    };

    this.deselect = () => {
      this.stroke('rgba(40,123,181,0.4)');
      this.fill(setAlpha(this.fill(), 0.25));
    };

    this.destroyRect = () => {
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = /** @type {any} */ (null);
    };
    this.destroy = () => {
      if (this.label) this.label.destroy();
      this.label = undefined;
      this.viewer.CanvasSelection.deselectDataColumnsByIds([this.layoutBox.id]);

      this.destroyRect();
      return this;
    };

    // `instanceof LayoutDataColumn` should not be used to determine the type of the layout box,
    // as this will fail for layout boxes that were created in another thread.
    if (layoutBox.type === 'order') {
      // Create dummy ocr data for the order box
      const pageObj = new scribe.utils.ocr.OcrPage(n, { width: 1, height: 1 });
      const box = {
        left: 0, right: 0, top: 0, bottom: 0,
      };
      const lineObjTemp = new scribe.utils.ocr.OcrLine(pageObj, box, [0, 0], 10, null);
      pageObj.lines = [lineObjTemp];
      const wordIDNew = scribe.utils.getRandomAlphanum(10);
      const wordObj = new scribe.utils.ocr.OcrWord(lineObjTemp, wordIDNew, String(layoutBox.order), box);
      wordObj.visualCoords = false;
      wordObj.style.size = 50;
      const label = new UiText({
        x: origX + width * 0.5,
        yActual: origY + height * 0.5,
        word: wordObj,
        dynamicWidth: true,
        viewer: _viewer,
        changeTextCallback: async (obj) => {
          layoutBox.order = parseInt(obj.word.text);
        },
        // eslint-disable-next-line no-unused-vars
        inputTextCallback: async (obj) => {
          if (!UiText.input) return;
          // Empty is the only allowed non-numeric value.
          if (UiText.input.textContent === '') return;
          if (!UiText.input.textContent
            || /[^\d]/.test(UiText.input.textContent)
            || parseInt(UiText.input.textContent) < 0
            || parseInt(UiText.input.textContent) > 99) {
            UiText.input.innerHTML = UiText.inputInnerHTMLLast;
            UiText.setCursor(UiText.inputCursorLast);
            return;
          }
        },
      });
      this.label = label;
    }

    this.addEventListener('dragmove', () => {
      if (UiText.input && UiText.input.parentElement && UiText.inputRemove) UiText.inputRemove();
      if (this.label) {
        this.label.x(this.x() + this.width() * 0.5);
        this.label.yActual = this.y() + this.height() * 0.5;
        UiText.updateWordCanvas(this.label);
      }
    });

    this.addEventListener('dragend', () => {
      UiLayout.updateLayoutBoxes(this);
    });

    this._wireDrag();
  }

  /** @param {number} [v] @returns {number} */
  x(v) { if (v === undefined) return this._x; this._x = v; this._position(); return this._x; }

  /** @param {number} [v] @returns {number} */
  y(v) { if (v === undefined) return this._y; this._y = v; this._position(); return this._y; }

  /** @param {number} [v] @returns {number} */
  width(v) { if (v === undefined) return this._width; this._width = v; this._position(); return this._width; }

  /** @param {number} [v] @returns {number} */
  height(v) { if (v === undefined) return this._height; this._height = v; this._position(); return this._height; }

  // Layout boxes are sized directly (via controls), never via a scale transform.
  /** @param {number} [v] @returns {number} */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  scaleX(v) { return 1; }

  /** @param {number} [v] @returns {number} */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  scaleY(v) { return 1; }

  /** @param {string} [v] @returns {string} */
  fill(v) { if (v === undefined) return this._fill; this._fill = v; this._applyStyle(); return this._fill; }

  /** @param {string} [v] @returns {string} */
  stroke(v) { if (v === undefined) return this._stroke; this._stroke = v; this._applyStyle(); return this._stroke; }

  /** @param {boolean} [v] @returns {boolean} */
  fillEnabled(v) { if (v === undefined) return this._fillEnabled; this._fillEnabled = v; this._applyStyle(); return this._fillEnabled; }

  /** @param {boolean} [v] @returns {boolean} */
  strokeEnabled(v) { if (v === undefined) return this._strokeEnabled; this._strokeEnabled = v; this._applyStyle(); return this._strokeEnabled; }

  /** @param {boolean} [v] @returns {boolean} */
  draggable(v) {
    if (v === undefined) return this._draggable;
    this._draggable = v;
    if (this.el) this.el.style.cursor = v ? 'move' : 'default';
    return this._draggable;
  }

  /** @param {boolean} [v] @returns {boolean} */
  listening(v) {
    if (v === undefined) return this._listening;
    this._listening = v;
    if (this.el) this.el.style.pointerEvents = v ? 'auto' : 'none';
    return this._listening;
  }

  /** Move the element to the top of its parent's stacking order. */
  moveToTop() { if (this.el && this.el.parentNode) this.el.parentNode.appendChild(this.el); }

  /**
   * Content-space axis-aligned bounding box of the box element.
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getClientRect() {
    const r = this.el.getBoundingClientRect();
    const tl = this.viewer.clientToContent(r.left, r.top);
    const br = this.viewer.clientToContent(r.right, r.bottom);
    return {
      x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y,
    };
  }

  _position() {
    if (!this.el) return;
    Object.assign(this.el.style, {
      left: `${this._x}px`, top: `${this._y}px`, width: `${this._width}px`, height: `${this._height}px`,
    });
  }

  _applyStyle() {
    if (!this.el) return;
    this.el.style.background = this._fillEnabled && this._fill ? this._fill : 'transparent';
    const bw = 'calc(2px / var(--scribe-zoom, 1))';
    this.el.style.border = this._strokeEnabled && this._stroke ? `${bw} solid ${this._stroke}` : `${bw} solid transparent`;
  }

  /**
   * Register a drag/transform handler.
   * @param {string} type
   * @param {Function} fn
   */
  addEventListener(type, fn) {
    if (!this._handlers[type]) this._handlers[type] = [];
    this._handlers[type].push(fn);
  }

  /**
   * @param {string} type
   * @param {Function} fn
   */
  on(type, fn) { this.addEventListener(type, fn); }

  /** @param {string} type */
  _fire(type) {
    (this._handlers[type] || []).forEach((fn) => fn());
  }

  /** Wire whole-box dragging (moves by the pointer delta, then writes the model on release). */
  _wireDrag() {
    makeDraggable(this.el, this.viewer, this._n, {
      onStart: (p) => {
        if (!this._draggable) return;
        this._grab = { x: p.x - this._x, y: p.y - this._y };
        this._fire('dragstart');
      },
      onMove: (p) => {
        if (!this._draggable || !this._grab) return;
        this.x(p.x - this._grab.x);
        this.y(p.y - this._grab.y);
        this._reposition();
        this._fire('dragmove');
      },
      onEnd: () => {
        if (!this._draggable) return;
        this._fire('dragend');
      },
    });
  }

  /**
   * Write the box's geometry back to its layout-box coordinates and mark the page's layout non-default.
   * @param {UiLayout} uiLayout
   */
  static updateLayoutBoxes(uiLayout) {
    const n = uiLayout.layoutBox.type === 'dataColumn' ? uiLayout.layoutBox.table.page.n : uiLayout.layoutBox.page.n;
    const width = uiLayout.width() * uiLayout.scaleX();
    const height = uiLayout.height() * uiLayout.scaleY();
    const right = uiLayout.x() + width;
    const bottom = uiLayout.y() + height;
    uiLayout.layoutBox.coords = {
      left: uiLayout.x(), top: uiLayout.y(), right, bottom,
    };
    const viewer = getLayoutViewer(uiLayout);
    viewer.doc.layoutRegions.pages[n].default = false;
    viewer.doc.layoutDataTables.pages[n].default = false;
  }

  /**
   * Update the UI to reflect the properties of the selected objects.
   * Should be called after new objects are selected.
   */
  static updateUI = () => { };
}

/**
 * Build a thin draggable control bar `<div>`: a 2px line centred in a 6px-thick hit area.
 * @param {'h'|'v'} orientation - 'h' for a horizontal bar (drags vertically), 'v' for a vertical bar.
 * @param {number} length - Bar length in page px.
 * @returns {HTMLDivElement}
 */
function makeControlElem(orientation, length) {
  const el = document.createElement('div');
  el.className = 'scribe-layout-control';
  el.dataset.scribeKind = 'layout-control';
  const common = { position: 'absolute', zIndex: '3', touchAction: 'none' };
  if (orientation === 'h') {
    Object.assign(el.style, common, {
      height: '6px',
      marginTop: '-3px',
      width: `${length}px`,
      cursor: 'row-resize',
      background: 'linear-gradient(black, black) center/100% 2px no-repeat',
    });
  } else {
    Object.assign(el.style, common, {
      width: '6px',
      marginLeft: '-3px',
      height: `${length}px`,
      cursor: 'col-resize',
      background: 'linear-gradient(black, black) center/2px 100% no-repeat',
    });
  }
  return el;
}

/**
 * Shared DOM base for the layout control bars (region/table edges and column separators).
 * Exposes the `x()/y()/points()/destroy()/moveToTop()` surface the drag handlers use; the line's length comes from `points()`.
 */
export class UiControlLine {
  /**
   * @param {import('../viewer.js').ScribeViewer} viewer
   * @param {number} n - Page number.
   * @param {'h'|'v'} orientation
   * @param {number} x
   * @param {number} y
   * @param {number} length
   */
  constructor(viewer, n, orientation, x, y, length) {
    this.viewer = viewer;
    this._n = n;
    this._orientation = orientation;
    this._x = x;
    this._y = y;
    this._length = length;
    this.el = makeControlElem(orientation, length);
    /** @type {any} */ (this.el)._scribeObj = this;
    this._position();
  }

  /** @param {number} [v] @returns {number} */
  x(v) { if (v === undefined) return this._x; this._x = v; this._position(); return this._x; }

  /** @param {number} [v] @returns {number} */
  y(v) { if (v === undefined) return this._y; this._y = v; this._position(); return this._y; }

  /**
   * Set the bar length from a points array (`[x0,y0,x1,y1]`, relative to the bar origin).
   * @param {Array<number>} arr
   */
  points(arr) {
    this._length = this._orientation === 'h' ? Math.abs(arr[2] - arr[0]) : Math.abs(arr[3] - arr[1]);
    this._position();
  }

  _position() {
    if (!this.el) return;
    this.el.style.left = `${this._x}px`;
    this.el.style.top = `${this._y}px`;
    if (this._orientation === 'h') this.el.style.width = `${this._length}px`;
    else this.el.style.height = `${this._length}px`;
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = /** @type {any} */ (null);
    return this;
  }

  moveToTop() { if (this.el && this.el.parentNode) this.el.parentNode.appendChild(this.el); }
}
