// The Glyph object

import { check } from './types.js';
import { Path } from './path.js';

function getPathDefinition(glyph, path) {
  let _path = path || new Path();
  return {
    configurable: true,

    get() {
      if (typeof _path === 'function') {
        _path = _path();
      }

      return _path;
    },

    set(p) {
      _path = p;
    },
  };
}

/**
 * @typedef GlyphOptions
 * @type Object
 * @property {string} [name] - The glyph name
 * @property {number} [unicode]
 * @property {Array} [unicodes]
 * @property {number} [xMin]
 * @property {number} [yMin]
 * @property {number} [xMax]
 * @property {number} [yMax]
 * @property {number} [advanceWidth]
 * @property {number} [index]
 * @property {import('./path.js').Path} [path]
 */

export class Glyph {
  /**
   * @param {GlyphOptions} options
   */
  constructor(options) {
    /** @type {number} */
    this.index = options.index || 0;
    /** @type {string|null} */
    this.name = options.name || null;
    /** @type {number|undefined} */
    this.unicode = options.unicode || undefined;
    /** @type {number[]} */
    this.unicodes = options.unicodes || options.unicode !== undefined ? [options.unicode] : [];
    /** @type {number|undefined} */
    this.xMin = undefined;
    /** @type {number|undefined} */
    this.xMax = undefined;
    /** @type {number|undefined} */
    this.yMin = undefined;
    /** @type {number|undefined} */
    this.yMax = undefined;
    /** @type {number|undefined} */
    this.advanceWidth = undefined;
    /** @type {number|undefined} */
    this.leftSideBearing = undefined;
    /** @type {number|undefined} */
    this.numberOfContours = undefined;
    /** @type {boolean|undefined} */
    this.isComposite = undefined;
    /** @type {Array<{glyphIndex: number, xScale?: number, yScale?: number, scale01?: number, scale10?: number, dx: number, dy: number, matchedPoints?: number[]}>|undefined} */
    this.components = undefined;
    /** @type {number[]|undefined} */
    this.instructions = undefined;
    /** @type {Array<{x: number, y: number, onCurve?: boolean, lastPointOfContour?: boolean}>|undefined} */
    this.points = undefined;

    if ('xMin' in options) {
      this.xMin = options.xMin;
    }

    if ('yMin' in options) {
      this.yMin = options.yMin;
    }

    if ('xMax' in options) {
      this.xMax = options.xMax;
    }

    if ('yMax' in options) {
      this.yMax = options.yMax;
    }

    if ('advanceWidth' in options) {
      this.advanceWidth = options.advanceWidth;
    }

    Object.defineProperty(this, 'path', getPathDefinition(this, options.path));
  }

  addUnicode(unicode) {
    if (this.unicodes.length === 0) {
      this.unicode = unicode;
    }

    this.unicodes.push(unicode);
  }

  getBoundingBox() {
    return this.path.getBoundingBox();
  }

  getPath(x, y, fontSize, options) {
    x = x !== undefined ? x : 0;
    y = y !== undefined ? y : 0;
    fontSize = fontSize !== undefined ? fontSize : 72;
    if (!options) options = { };
    const commands = this.path.commands;
    const scale = 1 / (this.path.unitsPerEm || 1000) * fontSize;
    const xScale = options.xScale !== undefined ? options.xScale : scale;
    const yScale = options.yScale !== undefined ? options.yScale : scale;

    const p = new Path();
    for (let i = 0; i < commands.length; i += 1) {
      const cmd = commands[i];
      if (cmd.type === 'M') {
        p.moveTo(x + (cmd.x * xScale), y + (-cmd.y * yScale));
      } else if (cmd.type === 'L') {
        p.lineTo(x + (cmd.x * xScale), y + (-cmd.y * yScale));
      } else if (cmd.type === 'Q') {
        p.quadraticCurveTo(x + (cmd.x1 * xScale), y + (-cmd.y1 * yScale),
          x + (cmd.x * xScale), y + (-cmd.y * yScale));
      } else if (cmd.type === 'C') {
        p.curveTo(x + (cmd.x1 * xScale), y + (-cmd.y1 * yScale),
          x + (cmd.x2 * xScale), y + (-cmd.y2 * yScale),
          x + (cmd.x * xScale), y + (-cmd.y * yScale));
      } else if (cmd.type === 'Z') {
        p.closePath();
      }
    }

    return p;
  }

  getContours() {
    if (this.points === undefined) {
      return [];
    }

    const contours = [];
    let currentContour = [];
    for (let i = 0; i < this.points.length; i += 1) {
      const pt = this.points[i];
      currentContour.push(pt);
      if (pt.lastPointOfContour) {
        contours.push(currentContour);
        currentContour = [];
      }
    }

    check.argument(currentContour.length === 0, 'There are still points left in the current contour.');
    return contours;
  }

  getMetrics() {
    const commands = this.path.commands;
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < commands.length; i += 1) {
      const cmd = commands[i];
      if (cmd.type !== 'Z') {
        if (cmd.x < xMin) xMin = cmd.x;
        if (cmd.x > xMax) xMax = cmd.x;
        if (cmd.y < yMin) yMin = cmd.y;
        if (cmd.y > yMax) yMax = cmd.y;
      }

      if (cmd.type === 'Q' || cmd.type === 'C') {
        if (cmd.x1 < xMin) xMin = cmd.x1;
        if (cmd.x1 > xMax) xMax = cmd.x1;
        if (cmd.y1 < yMin) yMin = cmd.y1;
        if (cmd.y1 > yMax) yMax = cmd.y1;
      }

      if (cmd.type === 'C') {
        if (cmd.x2 < xMin) xMin = cmd.x2;
        if (cmd.x2 > xMax) xMax = cmd.x2;
        if (cmd.y2 < yMin) yMin = cmd.y2;
        if (cmd.y2 > yMax) yMax = cmd.y2;
      }
    }

    if (!Number.isFinite(xMin)) xMin = 0;
    if (!Number.isFinite(xMax)) xMax = this.advanceWidth;
    if (!Number.isFinite(yMin)) yMin = 0;
    if (!Number.isFinite(yMax)) yMax = 0;

    return {
      xMin,
      yMin,
      xMax,
      yMax,
      leftSideBearing: this.leftSideBearing,
      rightSideBearing: this.advanceWidth - this.leftSideBearing - (xMax - xMin),
    };
  }
}
