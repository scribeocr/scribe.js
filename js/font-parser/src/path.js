// Geometric objects

function derive(v0, v1, v2, v3, t) {
  return (1 - t) ** 3 * v0
        + 3 * (1 - t) ** 2 * t * v1
        + 3 * (1 - t) * t ** 2 * v2
        + t ** 3 * v3;
}

class BoundingBox {
  constructor() {
    this.x1 = Number.NaN;
    this.y1 = Number.NaN;
    this.x2 = Number.NaN;
    this.y2 = Number.NaN;
  }

  isEmpty() {
    return Number.isNaN(this.x1) || Number.isNaN(this.y1) || Number.isNaN(this.x2) || Number.isNaN(this.y2);
  }

  addPoint(x, y) {
    if (typeof x === 'number') {
      if (Number.isNaN(this.x1) || Number.isNaN(this.x2)) { this.x1 = x; this.x2 = x; }
      if (x < this.x1) { this.x1 = x; }
      if (x > this.x2) { this.x2 = x; }
    }
    if (typeof y === 'number') {
      if (Number.isNaN(this.y1) || Number.isNaN(this.y2)) { this.y1 = y; this.y2 = y; }
      if (y < this.y1) { this.y1 = y; }
      if (y > this.y2) { this.y2 = y; }
    }
  }

  addX(x) { this.addPoint(x, null); }

  addY(y) { this.addPoint(null, y); }

  addBezier(x0, y0, x1, y1, x2, y2, x, y) {
    const p0 = [x0, y0]; const p1 = [x1, y1]; const p2 = [x2, y2]; const p3 = [x, y];
    this.addPoint(x0, y0);
    this.addPoint(x, y);
    for (let i = 0; i <= 1; i++) {
      const b = 6 * p0[i] - 12 * p1[i] + 6 * p2[i];
      const a = -3 * p0[i] + 9 * p1[i] - 9 * p2[i] + 3 * p3[i];
      const c = 3 * p1[i] - 3 * p0[i];
      if (a === 0) {
        if (b === 0) continue;
        const t = -c / b;
        if (t > 0 && t < 1) {
          if (i === 0) this.addX(derive(p0[i], p1[i], p2[i], p3[i], t));
          if (i === 1) this.addY(derive(p0[i], p1[i], p2[i], p3[i], t));
        }
        continue;
      }
      const b2ac = b ** 2 - 4 * c * a;
      if (b2ac < 0) continue;
      const t1 = (-b + Math.sqrt(b2ac)) / (2 * a);
      if (t1 > 0 && t1 < 1) {
        if (i === 0) this.addX(derive(p0[i], p1[i], p2[i], p3[i], t1));
        if (i === 1) this.addY(derive(p0[i], p1[i], p2[i], p3[i], t1));
      }
      const t2 = (-b - Math.sqrt(b2ac)) / (2 * a);
      if (t2 > 0 && t2 < 1) {
        if (i === 0) this.addX(derive(p0[i], p1[i], p2[i], p3[i], t2));
        if (i === 1) this.addY(derive(p0[i], p1[i], p2[i], p3[i], t2));
      }
    }
  }

  addQuad(x0, y0, x1, y1, x, y) {
    const cp1x = x0 + 2 / 3 * (x1 - x0);
    const cp1y = y0 + 2 / 3 * (y1 - y0);
    const cp2x = cp1x + 1 / 3 * (x - x0);
    const cp2y = cp1y + 1 / 3 * (y - y0);
    this.addBezier(x0, y0, cp1x, cp1y, cp2x, cp2y, x, y);
  }
}

/**
 * @typedef {({type: 'M', x: number, y: number} | {type: 'L', x: number, y: number} |
 * {type: 'C', x1: number, y1: number, x2: number, y2: number, x: number, y: number} |
 * {type: 'Q', x1: number, y1: number, x: number, y: number} | {type: 'Z'})} PathCommand
 */

/**
 * A bézier path containing a set of path commands similar to a SVG path.
 * Paths can be drawn on a context using `draw`.
 */
class Path {
  constructor() {
    /** @type {PathCommand[]} */
    this.commands = [];
    /** @type {string|null} */
    this.fill = 'black';
    /** @type {string|null} */
    this.stroke = null;
    /** @type {number} */
    this.strokeWidth = 1;
    /** @type {number} */
    this.unitsPerEm = 0;
  }

  moveTo(x, y) {
    this.commands.push({ type: 'M', x, y });
  }

  lineTo(x, y) {
    this.commands.push({ type: 'L', x, y });
  }

  curveTo(x1, y1, x2, y2, x, y) {
    this.commands.push({
      type: 'C', x1, y1, x2, y2, x, y,
    });
  }

  quadTo(x1, y1, x, y) {
    this.commands.push({
      type: 'Q', x1, y1, x, y,
    });
  }

  close() {
    this.commands.push({ type: 'Z' });
  }

  extend(pathOrCommands) {
    if (pathOrCommands.commands) {
      pathOrCommands = pathOrCommands.commands;
    } else if (pathOrCommands instanceof BoundingBox) {
      const box = pathOrCommands;
      this.moveTo(box.x1, box.y1);
      this.lineTo(box.x2, box.y1);
      this.lineTo(box.x2, box.y2);
      this.lineTo(box.x1, box.y2);
      this.close();
      return;
    }

    Array.prototype.push.apply(this.commands, pathOrCommands);
  }

  getBoundingBox() {
    const box = new BoundingBox();

    let startX = 0;
    let startY = 0;
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i < this.commands.length; i++) {
      const cmd = this.commands[i];
      switch (cmd.type) {
        case 'M':
          box.addPoint(cmd.x, cmd.y);
          startX = prevX = cmd.x;
          startY = prevY = cmd.y;
          break;
        case 'L':
          box.addPoint(cmd.x, cmd.y);
          prevX = cmd.x;
          prevY = cmd.y;
          break;
        case 'Q':
          box.addQuad(prevX, prevY, cmd.x1, cmd.y1, cmd.x, cmd.y);
          prevX = cmd.x;
          prevY = cmd.y;
          break;
        case 'C':
          box.addBezier(prevX, prevY, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          prevX = cmd.x;
          prevY = cmd.y;
          break;
        case 'Z':
          prevX = startX;
          prevY = startY;
          break;
        default:
          throw new Error(`Unexpected path command ${cmd.type}`);
      }
    }
    if (box.isEmpty()) {
      box.addPoint(0, 0);
    }
    return box;
  }

  draw(ctx) {
    ctx.beginPath();
    for (let i = 0; i < this.commands.length; i += 1) {
      const cmd = this.commands[i];
      if (cmd.type === 'M') {
        ctx.moveTo(cmd.x, cmd.y);
      } else if (cmd.type === 'L') {
        ctx.lineTo(cmd.x, cmd.y);
      } else if (cmd.type === 'C') {
        ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
      } else if (cmd.type === 'Q') {
        ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
      } else if (cmd.type === 'Z') {
        ctx.closePath();
      }
    }

    if (this.fill) {
      ctx.fillStyle = this.fill;
      ctx.fill();
    }

    if (this.stroke) {
      ctx.strokeStyle = this.stroke;
      ctx.lineWidth = this.strokeWidth;
      ctx.stroke();
    }
  }

  toPathData(decimalPlaces) {
    decimalPlaces = decimalPlaces !== undefined ? decimalPlaces : 2;

    function floatToString(v) {
      if (Math.round(v) === v) {
        return `${Math.round(v)}`;
      }
      return v.toFixed(decimalPlaces);
    }

    function packValues() {
      let s = '';
      for (let i = 0; i < arguments.length; i += 1) {
        const v = arguments[i];
        if (v >= 0 && i > 0) {
          s += ' ';
        }

        s += floatToString(v);
      }

      return s;
    }

    let d = '';
    for (let i = 0; i < this.commands.length; i += 1) {
      const cmd = this.commands[i];
      if (cmd.type === 'M') {
        d += `M${packValues(cmd.x, cmd.y)}`;
      } else if (cmd.type === 'L') {
        d += `L${packValues(cmd.x, cmd.y)}`;
      } else if (cmd.type === 'C') {
        d += `C${packValues(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y)}`;
      } else if (cmd.type === 'Q') {
        d += `Q${packValues(cmd.x1, cmd.y1, cmd.x, cmd.y)}`;
      } else if (cmd.type === 'Z') {
        d += 'Z';
      }
    }

    return d;
  }

  toSVG(decimalPlaces) {
    let svg = '<path d="';
    svg += this.toPathData(decimalPlaces);
    svg += '"';
    if (this.fill && this.fill !== 'black') {
      if (this.fill === null) {
        svg += ' fill="none"';
      } else {
        svg += ` fill="${this.fill}"`;
      }
    }

    if (this.stroke) {
      svg += ` stroke="${this.stroke}" stroke-width="${this.strokeWidth}"`;
    }

    svg += '/>';
    return svg;
  }
}

// Method aliases for API compatibility
Path.prototype.bezierCurveTo = Path.prototype.curveTo;
Path.prototype.quadraticCurveTo = Path.prototype.quadTo;
Path.prototype.closePath = Path.prototype.close;

export { Path, BoundingBox };
