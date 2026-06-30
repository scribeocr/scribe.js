import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import {
  ScribeViewer,
} from '../viewer.js';
import { UiText } from './viewerWordObjects.js';

const colColorsHex = ['#287bb5', '#19aa9a', '#099b57'];

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
function makeDraggable(el, viewer, n, { onStart, onMove, onEnd } = {}) {
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
function getLayoutViewer(obj) {
  return obj?.viewer || obj?.uiRegion?.viewer || obj?.uiTable?.viewer || ScribeViewer.getDefault();
}

/**
 * Converts a hex color to rgba with a specified alpha.
 * @param {string} hex - The hex color code.
 * @param {number} alpha - The alpha value for the rgba color.
 * @returns {string} The rgba color string.
 */
const hexToRgba = (hex, alpha) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const setAlpha = (color, alpha) => color.replace(/,\s*[\d.]+\)/, `,${alpha})`);

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
   * @param {UiLayout|UiDataColumn} uiLayout
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
class UiControlLine {
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

class UiRegionControlHorizontal extends UiControlLine {
  /**
   *
   * @param {UiRegion} uiRegion
   */
  constructor(uiRegion, top = true) {
    const c = uiRegion.layoutBox.coords;
    const n = uiRegion.layoutBox.page.n;
    super(uiRegion.viewer, n, 'h', c.left, top ? c.top : c.bottom, c.right - c.left);

    this.uiRegion = uiRegion;
    this.boundTop = 0;
    this.boundBottom = 10000;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        if (top) {
          this.boundTop = 0;
          this.boundBottom = this.uiRegion.bottomControl.y() - 20;
        } else {
          this.boundTop = this.uiRegion.topControl.y() + 20;
          this.boundBottom = this.viewer.doc.pageMetrics[n].dims.height;
        }
      },
      onMove: (p) => {
        const newY = Math.max(this.boundTop, Math.min(this.boundBottom, p.y));
        this.y(newY);
        const box = this.uiRegion.layoutBox.coords;
        if (top) {
          box.top = newY;
          this.uiRegion.y(box.top);
          this.uiRegion.height(box.bottom - box.top);
          this.uiRegion.leftControl.y(box.top);
          this.uiRegion.rightControl.y(box.top);
          this.uiRegion.leftControl.points([0, 0, 0, box.bottom - box.top]);
          this.uiRegion.rightControl.points([0, 0, 0, box.bottom - box.top]);
        } else {
          box.bottom = newY;
          this.uiRegion.height(box.bottom - box.top);
          this.uiRegion.leftControl.points([0, 0, 0, box.bottom - box.top]);
          this.uiRegion.rightControl.points([0, 0, 0, box.bottom - box.top]);
        }

        if (this.uiRegion.label) {
          this.uiRegion.label.x(this.uiRegion.x() + this.uiRegion.width() * 0.5);
          this.uiRegion.label.yActual = this.uiRegion.y() + this.uiRegion.height() * 0.5;
          UiText.updateWordCanvas(this.uiRegion.label);
        }
      },
      onEnd: () => { this.viewer.drag.isResizingColumns = false; },
    });
  }
}

class UiRegionControlVertical extends UiControlLine {
  /**
   *
   * @param {UiRegion} uiRegion
   */
  constructor(uiRegion, left = true) {
    const c = uiRegion.layoutBox.coords;
    const n = uiRegion.layoutBox.page.n;
    super(uiRegion.viewer, n, 'v', left ? c.left : c.right, c.top, c.bottom - c.top);

    this.uiRegion = uiRegion;
    this.boundLeft = 0;
    this.boundRight = 10000;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        if (left) {
          this.boundLeft = 0;
          this.boundRight = this.uiRegion.rightControl.x() - 20;
        } else {
          this.boundLeft = this.uiRegion.leftControl.x() + 20;
          this.boundRight = this.viewer.doc.pageMetrics[n].dims.width;
        }
      },
      onMove: (p) => {
        const newX = Math.max(this.boundLeft, Math.min(this.boundRight, p.x));
        this.x(newX);
        const box = this.uiRegion.layoutBox.coords;
        if (left) {
          box.left = newX;
          this.uiRegion.x(box.left);
          this.uiRegion.width(box.right - box.left);
          this.uiRegion.topControl.x(box.left);
          this.uiRegion.bottomControl.x(box.left);
          this.uiRegion.topControl.points([0, 0, box.right - box.left, 0]);
          this.uiRegion.bottomControl.points([0, 0, box.right - box.left, 0]);
        } else {
          box.right = newX;
          this.uiRegion.width(box.right - box.left);
          this.uiRegion.topControl.points([0, 0, box.right - box.left, 0]);
          this.uiRegion.bottomControl.points([0, 0, box.right - box.left, 0]);
        }

        if (this.uiRegion.label) {
          this.uiRegion.label.x(this.uiRegion.x() + this.uiRegion.width() * 0.5);
          this.uiRegion.label.yActual = this.uiRegion.y() + this.uiRegion.height() * 0.5;
          UiText.updateWordCanvas(this.uiRegion.label);
        }
      },
      onEnd: () => { this.viewer.drag.isResizingColumns = false; },
    });
  }
}

export class UiDataTableControl extends UiControlLine {
  /**
   *
   * @param {UiDataTable} uiTable
   */
  constructor(uiTable, top = true) {
    const tc = uiTable.coords;
    const n = uiTable.layoutDataTable.page.n;
    super(uiTable.viewer, n, 'h', tc.left, top ? tc.top : tc.bottom, tc.right - tc.left);

    this.uiTable = uiTable;
    this.boundTop = 0;
    this.boundBottom = 10000;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        if (top) {
          this.boundTop = 0;
          this.boundBottom = this.uiTable.bottomControl.y() - 20;
        } else {
          this.boundTop = this.uiTable.topControl.y() + 20;
          this.boundBottom = this.viewer.doc.pageMetrics[n].dims.height;
        }
      },
      onMove: (p) => {
        const newY = Math.max(this.boundTop, Math.min(this.boundBottom, p.y));
        this.y(newY);
        if (top) {
          uiTable.coords.top = newY;
          uiTable.columns.forEach((column) => {
            column.layoutBox.coords.top = newY;
            column.y(newY);
            column.height(column.layoutBox.coords.bottom - newY);
          });
          uiTable.colLines.forEach((colLine) => {
            colLine.y(newY);
            colLine.points([0, 0, 0, uiTable.coords.bottom - uiTable.coords.top]);
          });
        } else {
          uiTable.coords.bottom = newY;
          uiTable.columns.forEach((column) => {
            column.layoutBox.coords.bottom = newY;
            column.height(newY - column.layoutBox.coords.top);
          });
          uiTable.colLines.forEach((colLine) => {
            colLine.points([0, 0, 0, uiTable.coords.bottom - uiTable.coords.top]);
          });
        }
      },
      onEnd: () => {
        this.viewer.drag.isResizingColumns = false;
        renderLayoutDataTable(this.viewer, this.uiTable.layoutDataTable);
      },
    });
  }
}

export class UiDataColSep extends UiControlLine {
  /**
   *
   * @param {UiDataColumn} columnLeft
   * @param {UiDataColumn} columnRight
   * @param {UiDataTable} uiTable
   */
  constructor(columnLeft, columnRight, uiTable) {
    const x = columnRight ? columnRight.layoutBox.coords.left : columnLeft.layoutBox.coords.right;
    const y = columnRight ? columnRight.layoutBox.coords.top : columnLeft.layoutBox.coords.top;
    const n = uiTable.layoutDataTable.page.n;
    super(uiTable.viewer, n, 'v', x, y, uiTable.coords.bottom - uiTable.coords.top);

    this.next = () => this.uiTable.colLines.find((obj) => obj.x() > this.x());
    this.prev = () => this.uiTable.colLines.slice().reverse().find((obj) => obj.x() < this.x());

    this.boundLeft = 0;
    this.boundRight = 10000;

    this.uiTable = uiTable;
    this.columnLeft = columnLeft;
    this.columnRight = columnRight;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        // Bounds are the neighbouring separators (or the page edges), in page space.
        const boundLeftRaw = this.prev()?.x() ?? 0;
        const boundRightRaw = this.next()?.x() ?? this.viewer.doc.pageMetrics[n].dims.width;
        // Add minimum width between columns to prevent lines from overlapping.
        const minColWidthAbs = Math.min((boundRightRaw - boundLeftRaw) / 3, 10);
        this.boundLeft = boundLeftRaw + minColWidthAbs;
        this.boundRight = boundRightRaw - minColWidthAbs;
      },
      onMove: (p) => {
        const newX = Math.max(this.boundLeft, Math.min(this.boundRight, p.x));
        this.x(newX);
        if (this.columnLeft) {
          this.columnLeft.layoutBox.coords.right = newX;
          this.columnLeft.width(this.columnLeft.layoutBox.coords.right - this.columnLeft.layoutBox.coords.left);
        } else {
          this.uiTable.topControl.x(newX);
          this.uiTable.bottomControl.x(newX);
          this.uiTable.topControl.points([0, 0, uiTable.coords.right - newX, 0]);
          this.uiTable.bottomControl.points([0, 0, uiTable.coords.right - newX, 0]);
        }

        if (this.columnRight) {
          this.columnRight.layoutBox.coords.left = newX;
          this.columnRight.x(this.columnRight.layoutBox.coords.left);
          this.columnRight.width(this.columnRight.layoutBox.coords.right - this.columnRight.layoutBox.coords.left);
        } else {
          this.uiTable.topControl.points([0, 0, newX - uiTable.coords.left, 0]);
          this.uiTable.bottomControl.points([0, 0, newX - uiTable.coords.left, 0]);
        }
      },
      onEnd: () => {
        this.viewer.drag.isResizingColumns = false;
        if (!this.columnLeft || !this.columnRight) {
          renderLayoutDataTable(this.viewer, this.uiTable.layoutDataTable);
        } else {
          if (this.uiTable.pageObj) {
            this.uiTable.tableContent = scribe.utils.extractSingleTableContent(this.uiTable.pageObj, this.uiTable.layoutBoxesArr);
          }
          // eslint-disable-next-line no-use-before-define
          UiDataTable.colorTableWords(this.uiTable);
        }
      },
    });
  }
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderLayoutDataTables(viewer, n) {
  if (!viewer.doc.layoutDataTables.pages[n].tables) return;
  Object.values(viewer.doc.layoutDataTables.pages[n].tables).forEach((table) => {
    renderLayoutDataTable(viewer, table);
  });
}

export class UiDataTable {
  /**
   * @param {OcrPage|undefined} pageObj - The page object that the table is on.
   *    This can be undefined in the fringe case where the user makes layout boxes without any OCR data.
   * @param {InstanceType<typeof scribe.layout.LayoutDataTable>} layoutDataTable
   * @param {boolean} [lockColumns=true]
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  // eslint-disable-next-line default-param-last
  constructor(pageObj, layoutDataTable, lockColumns = true, viewer) {
    /** @type {import('../viewer.js').ScribeViewer} */
    this.viewer = viewer || ScribeViewer.getDefault();
    // The `columns` array is expected to be sorted left to right in other code.
    this.layoutBoxesArr = Object.values(layoutDataTable.boxes).sort((a, b) => a.coords.left - b.coords.left);

    const tableLeft = Math.min(...this.layoutBoxesArr.map((x) => x.coords.left));
    const tableRight = Math.max(...this.layoutBoxesArr.map((x) => x.coords.right));
    const tableTop = Math.min(...this.layoutBoxesArr.map((x) => x.coords.top));
    const tableBottom = Math.max(...this.layoutBoxesArr.map((x) => x.coords.bottom));

    this.coords = {
      left: tableLeft, top: tableTop, right: tableRight, bottom: tableBottom,
    };

    this.pageObj = pageObj;

    this.layoutDataTable = layoutDataTable;
    this.lockColumns = lockColumns;

    // eslint-disable-next-line no-use-before-define
    this.columns = this.layoutBoxesArr.map((layoutBox) => new UiDataColumn(layoutBox, this, this.viewer));

    /**
     * Removes the table from the canvas.
     * Does not impact the underlying data.
     */
    this.destroy = () => {
      this.columns.forEach((column) => column.destroy());
      this.colLines.forEach((colLine) => colLine.destroy());
      this.rowLines.forEach((rowLine) => rowLine.remove());
      this.rowSpans.forEach((rowSpan) => rowSpan.remove());

      this.topControl.destroy();
      this.bottomControl.destroy();

      // Restore colors of words that were colored by this table.
      const wordIdArr = this.tableContent?.rowWordArr.flat().flat().map((x) => x.id) || [];
      const canvasDeselectWords = this.viewer.getUiWords().filter((x) => wordIdArr.includes(x.word.id));
      canvasDeselectWords.forEach((x) => {
        const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(x.word, this.viewer.state.displayMode,
          scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);

        x.fill(fill);
        x.opacity(opacity);
      });

      return this;
    };

    /**
     * Delete the table, both from the layout data and from the canvas.
     */
    this.delete = () => {
      const tableIndex = this.viewer.doc.layoutDataTables.pages[this.layoutDataTable.page.n].tables.findIndex((x) => x.id === this.layoutDataTable.id);
      this.viewer.doc.layoutDataTables.pages[this.layoutDataTable.page.n].tables.splice(tableIndex, 1);
      this.destroy();
      this.viewer.doc.layoutRegions.pages[this.layoutDataTable.page.n].default = false;
      this.viewer.doc.layoutDataTables.pages[this.layoutDataTable.page.n].default = false;
    };

    const group = this.viewer.getOverlayGroup(layoutDataTable.page.n);

    /** @type {Array<UiDataColSep>} */
    this.colLines = [];
    for (let i = 0; i <= this.columns.length; i++) {
      const colLine = new UiDataColSep(this.columns[i - 1], this.columns[i], this);
      this.colLines.push(colLine);
      group.appendChild(colLine.el);
    }

    this.topControl = new UiDataTableControl(this, true);
    this.bottomControl = new UiDataTableControl(this, false);

    group.appendChild(this.topControl.el);
    group.appendChild(this.bottomControl.el);

    /** @type {Array<HTMLDivElement>} */
    this.rowLines = [];

    /** @type {Array<HTMLDivElement>} */
    this.rowSpans = [];

    /** @type {?ReturnType<typeof scribe.utils.extractSingleTableContent>} */
    this.tableContent = null;

    if (pageObj) {
      this.tableContent = scribe.utils.extractSingleTableContent(pageObj, this.layoutBoxesArr);

      this.rowLines = this.tableContent.rowBottomArr.map((rowBottom) => {
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute',
          left: `${tableLeft}px`,
          top: `${rowBottom}px`,
          width: `${tableRight - tableLeft}px`,
          height: '0',
          borderTop: 'calc(2px / var(--scribe-zoom, 1)) solid rgba(0,0,0,0.25)',
          pointerEvents: 'none',
        });
        return line;
      });

      UiDataTable.colorTableWords(this);

      this.rowLines.forEach((rowLine) => {
        group.appendChild(rowLine);
      });
    }
  }

  /**
   * Calculate what words are in each column and color them accordingly.
   * @param {UiDataTable} uiDataTable
   */
  static colorTableWords(uiDataTable) {
    if (!uiDataTable.tableContent) return;
    const viewer = uiDataTable.viewer;

    const group = viewer.getOverlayGroup(uiDataTable.layoutDataTable.page.n);

    uiDataTable.rowSpans.forEach((rowSpan) => rowSpan.remove());

    /** @type {Array<Array<string>>} */
    const colWordIdArr = [];
    for (let i = 0; i < uiDataTable.columns.length; i++) {
      colWordIdArr.push([]);
    }

    for (let i = 0; i < uiDataTable.tableContent.rowWordArr.length; i++) {
      const row = uiDataTable.tableContent.rowWordArr[i];
      for (let j = 0; j < row.length; j++) {
        const wordArr = row[j];
        if (wordArr.length === 0) continue;
        colWordIdArr[j].push(...wordArr.map((word) => (word.id)));
        const wordBoxArr = wordArr.map((word) => word.bbox);
        const spanBox = scribe.utils.ocr.calcBboxUnion(wordBoxArr);
        const colorBase = colColorsHex[j % colColorsHex.length];
        const fillCol = hexToRgba(colorBase, 0.3);

        const rowSpan = document.createElement('div');
        Object.assign(rowSpan.style, {
          position: 'absolute',
          left: `${spanBox.left}px`,
          top: `${spanBox.top}px`,
          width: `${spanBox.right - spanBox.left}px`,
          height: `${spanBox.bottom - spanBox.top}px`,
          background: fillCol,
          border: `1px solid ${fillCol}`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        });
        uiDataTable.rowSpans.push(rowSpan);
        group.appendChild(rowSpan);
      }
    }

    const canvasWords = viewer.getUiWords();
    for (let i = 0; i < colWordIdArr.length; i++) {
      const colWordIndex = colWordIdArr[i];
      const colorBase = colColorsHex[i % colColorsHex.length];
      const fillCol = setAlpha(colorBase, 1);
      canvasWords.filter((x) => colWordIndex.includes(x.word.id)).forEach((x) => {
        x.fill(fillCol);
        x.opacity(1);
      });
    }
  }
}

/**
 * Render a layout data table on the canvas.
 * If the data table already exists on the canvas, it is automatically removed.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {InstanceType<typeof scribe.layout.LayoutDataTable>} layoutDataTable
 */
export function renderLayoutDataTable(viewer, layoutDataTable) {
  if (!layoutDataTable || Object.keys(layoutDataTable.boxes).length === 0) {
    console.log(`Skipping table ${layoutDataTable?.id} as it has no boxes`);
    return;
  }

  const uiLayoutExisting = viewer.getUiDataTables().find((x) => x.layoutDataTable.id === layoutDataTable.id);

  const wordIdOldArr = uiLayoutExisting?.tableContent?.rowWordArr.flat().flat().map((x) => x.id);

  if (uiLayoutExisting) uiLayoutExisting.destroy();

  const uiLayout = new UiDataTable(viewer.doc.ocr.active[layoutDataTable.page.n], layoutDataTable, true, viewer);

  if (wordIdOldArr) {
    const wordIdNewArr = uiLayout.tableContent?.rowWordArr.flat().flat().map((x) => x.id) || [];
    const wordIdDeselectArr = wordIdOldArr.filter((x) => !wordIdNewArr.includes(x));
    const canvasDeselectWords = viewer.getUiWords().filter((x) => wordIdDeselectArr.includes(x.word.id));
    canvasDeselectWords.forEach((x) => {
      const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(x.word, viewer.state.displayMode,
        scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);

      x.fill(fill);
      x.opacity(opacity);
    });
  }

  uiLayout.columns.forEach((column) => {
    const group = viewer.getOverlayGroup(column.uiTable.layoutDataTable.page.n);
    group.appendChild(column.el);
  });
  uiLayout.colLines.forEach((colLine) => colLine.moveToTop());
  uiLayout.topControl.moveToTop();
  uiLayout.bottomControl.moveToTop();
}

export class UiRegion extends UiLayout {
  /**
   * @param {LayoutRegion} layoutBox
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  constructor(layoutBox, viewer) {
    super(layoutBox, viewer);

    this.layoutBox = layoutBox;

    this.topControl = new UiRegionControlHorizontal(this, true);
    this.bottomControl = new UiRegionControlHorizontal(this, false);

    this.leftControl = new UiRegionControlVertical(this, true);
    this.rightControl = new UiRegionControlVertical(this, false);

    const group = this.viewer.getOverlayGroup(layoutBox.page.n);

    group.appendChild(this.topControl.el);
    group.appendChild(this.bottomControl.el);
    group.appendChild(this.leftControl.el);
    group.appendChild(this.rightControl.el);

    // When the whole region box is dragged, keep its four edge controls aligned to the new bounds.
    this._reposition = () => {
      this.topControl.x(this.x());
      this.topControl.y(this.y());
      this.bottomControl.x(this.x());
      this.bottomControl.y(this.y() + this.height());
      this.leftControl.x(this.x());
      this.leftControl.y(this.y());
      this.rightControl.x(this.x() + this.width());
      this.rightControl.y(this.y());
    };

    this.destroyLayout = this.destroy;

    /**
     * Removes the region from the canvas.
     * Does not impact the underlying data.
     */
    this.destroy = () => {
      this.topControl.destroy();
      this.bottomControl.destroy();
      this.leftControl.destroy();
      this.rightControl.destroy();

      this.destroyLayout();

      return this;
    };
  }
}

export class UiDataColumn extends UiLayout {
  /**
   * @param {LayoutDataColumn} layoutBox
   * @param {UiDataTable} uiTable
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  constructor(layoutBox, uiTable, viewer) {
    super(layoutBox, viewer || uiTable?.viewer);
    // Overwrite layoutBox so type inference works correctly, and `layoutBox` gets type `LayoutDataColumn` instead of `LayoutBox`.
    this.layoutBox = layoutBox;
    this.uiTable = uiTable;
    this.draggable(false);
    this.select = () => {
      this.fill(setAlpha(this.fill(), 0.5));
      this.fillEnabled(true);
    };
    this.deselect = () => {
      this.fill(setAlpha(this.fill(), 0.3));
      this.strokeEnabled(false);
    };

    /**
     * Delete the column, both from the layout data and from the canvas.
     */
    this.delete = () => {
      const colIndexI = this.layoutBox.table.boxes.findIndex((x) => x.id === this.layoutBox.id);
      this.layoutBox.table.boxes.splice(colIndexI, 1);
      this.destroy();
      this.viewer.doc.layoutRegions.pages[layoutBox.table.page.n].default = false;
      this.viewer.doc.layoutDataTables.pages[layoutBox.table.page.n].default = false;
      if (this.layoutBox.table.boxes.length === 0) {
        const tableIndex = this.viewer.doc.layoutDataTables.pages[layoutBox.table.page.n].tables.findIndex((x) => x.id === this.layoutBox.table.id);
        this.viewer.doc.layoutDataTables.pages[layoutBox.table.page.n].tables.splice(tableIndex, 1);
        this.uiTable.destroy();
      }
    };

    this.next = () => {
      const next = this.uiTable.columns.find((x) => x.x() > this.x());
      return next;
    };

    this.prev = () => {
      const prev = this.uiTable.columns.slice().reverse().find((x) => x.x() < this.x());
      return prev;
    };
  }
}

/**
 *
 * @param {Array<UiDataColumn>} selectedDataColumns
 * @returns
 */
export const checkDataColumnsAdjacent = (selectedDataColumns) => {
  selectedDataColumns.sort((a, b) => a.x() - b.x());
  const selectedDataColumnsIds = selectedDataColumns.map((x) => x.layoutBox.id);
  let colI = selectedDataColumns[0];
  let adjacent = true;
  for (let i = 1; i < selectedDataColumns.length; i++) {
    const colINext = colI.next();
    if (!colINext || !selectedDataColumnsIds.includes(colINext.layoutBox.id)) {
      adjacent = false;
      break;
    }
    colI = colINext;
  }
  return adjacent;
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {LayoutDataTable} table
 */
const getAdjacentTables = (viewer, table) => {
  const adjacentTables = [];

  const tableBox = scribe.utils.calcTableBbox(table);

  const tableYMid = (tableBox.top + tableBox.bottom) / 2;

  const tablesBoxesAll = viewer.doc.layoutDataTables.pages[table.page.n].tables.map((x) => scribe.utils.calcTableBbox(x));
  const tables = viewer.doc.layoutDataTables.pages[table.page.n].tables.filter((x, i) => tablesBoxesAll[i].top < tableYMid && tablesBoxesAll[i].bottom > tableYMid).sort((a, b) => {
    const boxA = scribe.utils.calcTableBbox(a);
    const boxB = scribe.utils.calcTableBbox(b);
    return boxA.left - boxB.left;
  });

  const index = tables.findIndex((x) => x.id === table.id);

  if (index > 0) adjacentTables.push(tables[index - 1]);
  if (index < tables.length - 1) adjacentTables.push(tables[index + 1]);
  return adjacentTables;
};

/**
 * @param {Array<LayoutDataTable>} dataTables
 * @param {import('../viewer.js').ScribeViewer} [viewer]
 */
export const checkDataTablesAdjacent = (dataTables, viewer) => {
  const _viewer = viewer || ScribeViewer.getDefault();
  for (let i = 0; i < dataTables.length - 1; i++) {
    const table = dataTables[i];
    const tableNext = dataTables[i + 1];
    const adjacentTableIds = getAdjacentTables(_viewer, table).map((x) => x.id);

    if (!adjacentTableIds.includes(tableNext.id)) {
      return false;
    }
  }

  return true;
};

/**
 *
 * @param {Array<UiDataColumn>} columns
 */
export const mergeDataColumns = (columns) => {
  if (!columns || columns.length < 2 || !checkDataColumnsAdjacent(columns)) return;

  columns = columns.slice();

  const table = columns[0].uiTable.layoutDataTable;
  const viewer = getLayoutViewer(columns[0]);

  columns.sort((a, b) => a.x() - b.x());
  columns[0].layoutBox.coords.right = columns[columns.length - 1].layoutBox.coords.right;

  for (let i = 1; i < columns.length; i++) {
    columns[i].delete();
  }

  columns[0].uiTable.destroy();

  renderLayoutDataTable(viewer, table);
};

/**
 * Cleans a table to conform to the following rules:
 * 1. Columns must have no space between them (no overlap, no gap).
 * 2. Columns must have the same height.
 * This function is run after combining tables, as combining separate tables results in columns that do not conform to these rules.
 * @param {LayoutDataTable} table
 */
const cleanLayoutDataColumns = (table) => {
  const columnsArr = table.boxes;
  columnsArr.sort((a, b) => a.coords.left - b.coords.left);

  // Step 1: If columns overlap by a small amount, separate them.
  for (let i = 0; i < columnsArr.length - 1; i++) {
    const column = columnsArr[i];
    const nextColumn = columnsArr[i + 1];

    const gap = nextColumn.coords.left - column.coords.right;

    if (gap < 0 && gap >= 10) {
      const midpoint = Math.round(column.coords.right + gap / 2);
      column.coords.right = midpoint;
      nextColumn.coords.left = midpoint;
    }
  }

  // Step 2: If columns overlap by a large amount, delete one of them.
  for (let i = 0; i < columnsArr.length - 1; i++) {
    const column = columnsArr[i];
    const nextColumn = columnsArr[i + 1];

    column.coords.top = Math.min(column.coords.top, nextColumn.coords.top);
    column.coords.bottom = Math.max(column.coords.bottom, nextColumn.coords.bottom);

    const gap = nextColumn.coords.left - column.coords.right;

    if (gap < 0) {
      columnsArr.splice(i + 1, 1);
      i--;
    }
  }

  // Step 3: If columns have a gap between them, expand the columns to fill the gap.
  for (let i = 0; i < columnsArr.length - 1; i++) {
    const column = columnsArr[i];
    const nextColumn = columnsArr[i + 1];

    const gap = nextColumn.coords.left - column.coords.right;

    if (gap > 0) {
      const midpoint = Math.round(column.coords.right + gap / 2);
      column.coords.right = midpoint;
      nextColumn.coords.left = midpoint;
    }
  }

  // Step 4: Standardize all columns to the same height.
  const tableTop = Math.min(...columnsArr.map((x) => x.coords.top));
  const tableBottom = Math.max(...columnsArr.map((x) => x.coords.bottom));

  columnsArr.forEach((x) => {
    x.coords.top = tableTop;
    x.coords.bottom = tableBottom;
  });

  // Replace table boxes with cleaned columns.
  table.boxes = columnsArr;
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderLayoutBoxes(viewer, n) {
  const group = viewer.getOverlayGroup(n);
  // The group's rotation is set by `createGroup` from the page's deskew + user rotation; clear only its contents.
  group.replaceChildren();

  if (!viewer.overlayGroupsRenderIndices.includes(n)) viewer.overlayGroupsRenderIndices.push(n);

  Object.values(viewer.doc.layoutRegions.pages[n].boxes).forEach((box) => {
    const uiLayout = new UiRegion(box, viewer);
    group.appendChild(uiLayout.el);
    if (uiLayout.label) group.appendChild(uiLayout.label.el);
    uiLayout.topControl.moveToTop();
    uiLayout.bottomControl.moveToTop();
    uiLayout.leftControl.moveToTop();
    uiLayout.rightControl.moveToTop();
  });
  renderLayoutDataTables(viewer, n);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} level
 */
export function setLayoutBoxInclusionLevelClick(viewer, level) {
  const selectedRegions = viewer.CanvasSelection.getUiRegions();
  const selectedDataColumns = viewer.CanvasSelection.getUiDataColumns();

  const changedPages = {};

  const selectedArr = selectedRegions.map((x) => x.layoutBox.id);
  selectedArr.push(...selectedDataColumns.map((x) => x.layoutBox.id));

  selectedRegions.forEach((x) => {
    if (x.layoutBox.inclusionLevel !== level) changedPages[x.layoutBox.page.n] = true;
    x.layoutBox.inclusionLevel = level;
  });

  selectedDataColumns.forEach((x) => {
    if (x.layoutBox.inclusionLevel !== level) changedPages[x.layoutBox.table.page.n] = true;
    x.layoutBox.inclusionLevel = level;
  });

  Object.keys(changedPages).forEach((n) => {
    renderLayoutBoxes(viewer, Number(n));
    viewer.CanvasSelection.selectLayoutBoxesById(selectedArr);
  });
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} rule
 */
export function setLayoutBoxInclusionRuleClick(viewer, rule) {
  const selectedRegions = viewer.CanvasSelection.getUiRegions();
  const selectedDataColumns = viewer.CanvasSelection.getUiDataColumns();

  const changedPages = {};

  const selectedArr = selectedRegions.map((x) => x.layoutBox.id);
  selectedArr.push(...selectedDataColumns.map((x) => x.layoutBox.id));

  selectedRegions.forEach((x) => {
    if (x.layoutBox.inclusionRule !== rule) changedPages[x.layoutBox.page.n] = true;
    x.layoutBox.inclusionRule = rule;
  });
  selectedDataColumns.forEach((x) => {
    if (x.layoutBox.inclusionRule !== rule) changedPages[x.layoutBox.table.page.n] = true;
    x.layoutBox.inclusionRule = rule;
  });

  Object.keys(changedPages).forEach((n) => {
    renderLayoutBoxes(viewer, Number(n));
    viewer.CanvasSelection.selectLayoutBoxesById(selectedArr);
  });
}

/**
 *
 * @param {Array<LayoutDataTable>} tables
 */
export const mergeDataTables = (tables) => {
  if (!tables || tables.length < 2) return;
  const viewer = ScribeViewer.getDefault();
  if (!checkDataTablesAdjacent(tables, viewer)) return;

  const tableFirst = tables[0];

  const n = tableFirst.page.n;

  for (let i = 1; i < tables.length; i++) {
    tables[i].boxes.forEach((x) => {
      x.table = tableFirst;
      tableFirst.boxes.push(x);
    });
    const tableIndex = viewer.doc.layoutDataTables.pages[n].tables.findIndex((x) => x.id === tables[i].id);
    viewer.doc.layoutDataTables.pages[n].tables.splice(tableIndex, 1);
  }
  viewer.doc.layoutRegions.pages[n].default = false;
  viewer.doc.layoutDataTables.pages[n].default = false;

  cleanLayoutDataColumns(tableFirst);

  renderLayoutBoxes(viewer, n);
};

/**
 *
 * @param {UiDataColumn} column
 * @param {number} x - Point to split the column at
 */
export const splitDataColumn = (column, x) => {
  if (!column) return;

  // Add minimum width between columns to prevent lines from overlapping.
  const minColWidthAbs = Math.min((column.layoutBox.coords.right - column.layoutBox.coords.left) / 3, 10);

  // If the split point is outside the column, split at the center.
  if (x <= (column.layoutBox.coords.left + minColWidthAbs) || x >= (column.layoutBox.coords.right - minColWidthAbs)) {
    x = Math.round(column.layoutBox.coords.left + (column.layoutBox.coords.right - column.layoutBox.coords.left) / 2);
  }

  const bboxLeft = {
    left: column.layoutBox.coords.left, top: column.layoutBox.coords.top, right: x, bottom: column.layoutBox.coords.bottom,
  };
  const bboxRight = {
    left: x, top: column.layoutBox.coords.top, right: column.layoutBox.coords.right, bottom: column.layoutBox.coords.bottom,
  };

  column.layoutBox.coords = bboxLeft;

  const layoutBoxLeft = new scribe.layout.LayoutDataColumn(bboxRight, column.layoutBox.table);

  column.uiTable.layoutDataTable.boxes.push(layoutBoxLeft);

  column.uiTable.layoutDataTable.boxes.sort((a, b) => a.coords.left - b.coords.left);

  const viewer = getLayoutViewer(column);
  column.uiTable.destroy();
  renderLayoutDataTable(viewer, column.uiTable.layoutDataTable);
};

/**
 * Splits a table into two or three tables.
 * All columns in `columns` are inserted into a new table, all columns to the left of `columns` are inserted into a new table,
 * and all columns to the right of `columns` are inserted into a new table.
 * The old table is removed.
 * @param {Array<UiDataColumn>} columns
 */
export const splitDataTable = (columns) => {
  if (!columns || columns.length === 0 || columns.length === columns[0].layoutBox.table.boxes.length || !checkDataColumnsAdjacent(columns)) return;

  const viewer = getLayoutViewer(columns[0]);

  columns.sort((a, b) => a.x() - b.x());

  const n = columns[0].layoutBox.table.page.n;

  const layoutDataColumns0 = columns[0].layoutBox.table.boxes.filter((x) => x.coords.left < columns[0].layoutBox.coords.left);
  const layoutDataColumns1 = columns.map((x) => x.layoutBox);
  const layoutDataColumns2 = columns[0].layoutBox.table.boxes.filter((x) => x.coords.left > columns[columns.length - 1].layoutBox.coords.left);

  const tableExisting = layoutDataColumns1[0].table;
  const tableIndex = viewer.doc.layoutDataTables.pages[n].tables.findIndex((x) => x.id === tableExisting.id);
  viewer.doc.layoutDataTables.pages[n].tables.splice(tableIndex, 1);

  [layoutDataColumns0, layoutDataColumns1, layoutDataColumns2].forEach((layoutDataColumns) => {
    if (layoutDataColumns.length === 0) return;

    const table = new scribe.layout.LayoutDataTable(columns[0].layoutBox.table.page);

    layoutDataColumns.forEach((layoutDataColumn) => {
      layoutDataColumn.table = table;
      table.boxes.push(layoutDataColumn);
    });

    viewer.doc.layoutDataTables.pages[n].tables.push(table);
  });

  viewer.doc.layoutRegions.pages[n].default = false;
  viewer.doc.layoutDataTables.pages[n].default = false;

  renderLayoutDataTables(viewer, n);
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number.
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.left
 * @param {number} box.top
 * @param {string} type
 */
export function addLayoutBox(viewer, n, box, type) {
  const maxPriority = Math.max(...Object.values(viewer.doc.layoutRegions.pages[n].boxes).map((layoutRegion) => layoutRegion.order), -1);

  const bbox = {
    left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height,
  };

  const region = new scribe.layout.LayoutRegion(viewer.doc.layoutRegions.pages[n], maxPriority + 1, bbox, type);

  viewer.doc.layoutRegions.pages[n].boxes[region.id] = region;

  renderLayoutBoxes(viewer, n);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number.
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.left
 * @param {number} box.top
 */
export function addLayoutDataTable(viewer, n, box) {
  const bbox = {
    left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height,
  };

  const lines = viewer.doc.ocr.active[n].lines.filter((line) => scribe.utils.calcBoxOverlap(line.bbox, bbox) > 0.5);

  let columnBboxArr;
  if (lines.length > 0) {
    const lineBoxes = lines.map((line) => line.bbox);
    const columnBoundArr = scribe.utils.calcColumnBounds(lineBoxes);
    columnBboxArr = columnBoundArr.map((column) => ({
      left: column.left,
      top: bbox.top,
      right: column.right,
      bottom: bbox.bottom,
    }));

    columnBboxArr[0].left = bbox.left;
    columnBboxArr[columnBboxArr.length - 1].right = bbox.right;
    for (let i = 0; i < columnBboxArr.length - 1; i++) {
      const boundRight = (columnBboxArr[i].right + columnBboxArr[i + 1].left) / 2;
      columnBboxArr[i].right = boundRight;
      columnBboxArr[i + 1].left = boundRight;
    }
  } else {
    columnBboxArr = [{ ...bbox }];
  }

  const dataTable = new scribe.layout.LayoutDataTable(viewer.doc.layoutDataTables.pages[n]);

  columnBboxArr.forEach((columnBbox) => {
    const layoutBox = new scribe.layout.LayoutDataColumn(columnBbox, dataTable);
    dataTable.boxes.push(layoutBox);
  });

  viewer.doc.layoutDataTables.pages[n].tables.push(dataTable);

  viewer.doc.layoutRegions.pages[n].default = false;
  viewer.doc.layoutDataTables.pages[n].default = false;

  renderLayoutDataTable(viewer, dataTable);
}

/**
 * Apply the layout regions from one page to range of other pages.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} srcN - Page number of the source layout.
 * @param {number} minN - Minimum page number to apply the layout to.
 * @param {number} maxN - Maximum page number to apply the layout to (inclusive).
 */
function applyLayoutRegions(viewer, srcN, minN, maxN) {
  const srcRegions = viewer.doc.layoutRegions.pages[srcN].boxes;
  for (let i = minN; i <= maxN; i++) {
    if (i === srcN) continue;
    const boxes = structuredClone(srcRegions);
    for (const [, value] of Object.entries(boxes)) {
      value.id = scribe.utils.getRandomAlphanum(10);
      value.page = viewer.doc.layoutRegions.pages[i];
    }
    viewer.doc.layoutRegions.pages[i].boxes = boxes;
    if (Math.abs(i - viewer.state.cp.n) < 2) {
      renderLayoutBoxes(viewer, i);
    }
  }
}

/**
 * Apply the layout data tables from one page to range of other pages.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} srcN - Page number of the source layout.
 * @param {number} minN - Minimum page number to apply the layout to.
 * @param {number} maxN - Maximum page number to apply the layout to (inclusive).
 */
function applyLayoutDataTables(viewer, srcN, minN, maxN) {
  const srcTables = viewer.doc.layoutDataTables.pages[srcN].tables;
  for (let i = minN; i <= maxN; i++) {
    if (i === srcN) continue;
    const tables = structuredClone(srcTables);
    tables.forEach((x) => {
      x.id = scribe.utils.getRandomAlphanum(10);
      x.page = viewer.doc.layoutDataTables.pages[i];
    });
    viewer.doc.layoutDataTables.pages[i].tables = tables;
    if (Math.abs(i - viewer.state.cp.n) < 2) {
      renderLayoutBoxes(viewer, i);
    }
  }
}

export class layout {
  static renderLayoutBoxes = renderLayoutBoxes;

  static setLayoutBoxInclusionLevelClick = setLayoutBoxInclusionLevelClick;

  static setLayoutBoxInclusionRuleClick = setLayoutBoxInclusionRuleClick;

  static mergeDataTables = mergeDataTables;

  static splitDataColumn = splitDataColumn;

  static splitDataTable = splitDataTable;

  static addLayoutBox = addLayoutBox;

  static addLayoutDataTable = addLayoutDataTable;

  static applyLayoutRegions = applyLayoutRegions;

  static applyLayoutDataTables = applyLayoutDataTables;
}
