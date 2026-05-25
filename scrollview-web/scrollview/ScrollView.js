import { drawColorLegend, getRandomAlphanum } from '../src/common.js';
import { SVImageHandler } from './ui/SVImageHandler.js';
import { SVWindow } from './ui/SVWindow.js';

let scribeCanvasPromise = null;

/**
 * There should never be more than 1 `ScrollView` object, as the use of `static` properties creates issues.
 * This is inherited from how the Java ScrollView code is written.
 * This can likely be fixed if having multiple `ScrollView` objects is determined to be necessary,
 * as this only impacts the polyLine drawing code.
 */
export class ScrollView {
  /**
   *
   * @param {Object} [param]
   * @param {boolean} [param.lightTheme=false]
   */
  constructor({
    lightTheme = false,
  } = {}) {
    this.lightTheme = lightTheme;
    this.svId = getRandomAlphanum(10);
    this.createCanvas = (width, height) => new OffscreenCanvas(width, height);
  }

  async _init() {
    if (this._initDone) return;
    if (typeof process !== 'undefined') {
      if (!scribeCanvasPromise) scribeCanvasPromise = import('@scribe.js/canvas');
      const skia = await scribeCanvasPromise;
      this.createCanvas = (width, height) => skia.createCanvas(width, height);
    }
    this._initDone = true;
  }

  /** @type {Object.<string, SVWindow>} */
  windows = {};

  // Some window names are re-used.  For example, "With Images" may appear multiple times.
  // When multiple windows are created with the same name, a number is appended to make the file names unique.
  nameCount = {};

  /**
   * @typedef {Object} DebugVis
   * @property {*} canvas - Canvas with visualization.
   * @property {*} canvasLegend - Canvas with legend, if requested.
   */

  /**
   *
   * @param {boolean} [createLegend=false] - Whether to create a legend explaining the meaning of each color.
   * @returns
   */
  async getAll(createLegend = false) {
    await this._init();
    /** @type {Object<string, DebugVis>} */
    const outputObj = {};

    for (const [key, value] of Object.entries(this.windows)) {
      const name = this.windows[key].name;

      if (this.nameCount[name] === undefined) this.nameCount[name] = 0;

      this.nameCount[name]++;

      const nameFull = `${name}_${String(this.nameCount[name])}`;

      let canvasLegend;
      let nonemptyLegend = false;
      if (createLegend) {
        canvasLegend = this.createCanvas(200, 200);
        nonemptyLegend = drawColorLegend(canvasLegend, nameFull, this.windows[key].penColorsRect, this.windows[key].penColorsLine, this.lightTheme);
      }

      outputObj[nameFull] = {
        canvas: this.windows[key].canvas,
        canvasLegend: createLegend && nonemptyLegend ? canvasLegend : null,
      };
    }

    return outputObj;
  }

  /**
   * Parse a comma-separated list of arguments into arrays of different types.
   * @param {string} argList - The argument list as a string.
   * @param {number[]} intList - Array to store integers.
   * @param {number[]} floatList - Array to store floats.
   * @param {string[]} stringList - Array to store strings.
   * @param {boolean[]} boolList - Array to store booleans.
   */
  static parseArguments(argList, intList, floatList, stringList, boolList) {
    let str = null;
    const intPattern = /^[0-9-][0-9]*$/;
    const floatPattern = /^[0-9-][0-9]*\\.[0-9]*$/;

    argList.split(',').forEach((argStr) => {
      if (str !== null) {
        str += `,${argStr}`;
      } else if (argStr.length === 0) {
        return;
      } else {
        const quote = argStr.charAt(0);
        if (quote === '\'' || quote === '"') {
          str = argStr;
        }
      }
      if (str !== null) {
        const quote = str.charAt(0);
        const len = str.length;
        if (len > 1 && str.charAt(len - 1) === quote) {
          let slash = len - 1;
          while (slash > 0 && str.charAt(slash - 1) === '\\') --slash;
          if ((len - 1 - slash) % 2 === 0) {
            stringList.push(str.substring(1, len - 1).replace(/\\(.)/g, '$1'));
            str = null;
          }
        }
      } else if (floatPattern.test(argStr)) {
        floatList.push(parseFloat(argStr));
      } else if (argStr === 'true') {
        boolList.push(true);
      } else if (argStr === 'false') {
        boolList.push(false);
      } else if (intPattern.test(argStr)) {
        intList.push(parseInt(argStr, 10));
      }
    });

    if (str !== null) {
      throw new Error('Unterminated string');
    }
  }

  /**
   * Split function that replicates Java `split` method behavior,
   * with all text after `limit` being included in the final element.
   *
   * @param {string} string
   * @param {*} pattern
   * @param {*} limit
   */
  static splitJava(string, pattern, limit) {
    let idStrs = string.split(pattern); // Split without a limit

    if (idStrs.length > limit) {
      // If there are more elements than the limit, concatenate the rest back into the last element
      idStrs = idStrs.slice(0, limit - 1).concat(idStrs.slice(limit - 1).join(' '));
    }
    return idStrs;
  }

  imageWaiting = false;

  imageXPos = 0;

  imageYPos = 0;

  windowID = 0;

  /**
   *
   * @param {string} inputLine
   */
  async IOLoop(inputLine) {
    if (!inputLine) return;

    if (this.windows[this.windowID] && this.windows[this.windowID].polylineSize > this.windows[this.windowID].polylineScanned) {
      // We are processing a polyline.
      // Read pairs of coordinates separated by commas.
      let first = true;
      for (const coordStr of inputLine.replace(/[,\s]+$/, '').split(',')) {
        const coord = Number.parseInt(coordStr);
        if (first) {
          this.windows[this.windowID].polylineXCoords[this.windows[this.windowID].polylineScanned] = coord;
        } else {
          this.windows[this.windowID].polylineYCoords[this.windows[this.windowID].polylineScanned++] = coord;
        }
        first = !first;
      }
      console.assert(first);
    } else if (this.imageWaiting) {
      const image = await SVImageHandler.readImage(inputLine);
      this.windows[this.windowID].drawImageInternal(image, this.imageXPos, this.imageYPos);
      this.imageWaiting = false;
    } else {
      // Process this normally.
      await this.processInput(inputLine);
    }
  }

  /**
   * Processes a command line input, interpreting and executing it as needed.
   * @param {string} inputLine - The input command line.
   */
  async processInput(inputLine) {
    if (!inputLine) {
      return;
    }

    if (!this.createCanvas) {
      throw new Error('createCanvas method must be defined prior to running processInput.');
    }

    // Check if the command starts with 'w', indicating a window operation
    if (inputLine.charAt(0) === 'w') {
      // Parse the command without the leading 'w'
      const noWLine = inputLine.substring(1);
      const idStrs = this.constructor.splitJava(noWLine, /[ :]/, 2);
      this.windowID = parseInt(idStrs[0], 10);

      // Find the parentheses to isolate arguments
      const start = inputLine.indexOf('(');
      const end = inputLine.lastIndexOf(')');

      // Arrays to hold parsed arguments
      const intList = [];
      const floatList = [];
      const stringList = [];
      const boolList = [];

      // Assuming parseArguments is already defined and adapted to JavaScript
      this.constructor.parseArguments(inputLine.substring(start + 1, end), intList, floatList, stringList, boolList);

      const colon = inputLine.indexOf(':');
      if (colon > 1 && colon < start) {
        // Extract the function name
        const func = inputLine.substring(colon + 1, start);

        // Call the appropriate function on the window object
        // Assuming this.windows is an array of objects with methods as defined in Java
        switch (func) {
          case 'drawLine':
            this.windows[this.windowID].drawLine(intList[0], intList[1], intList[2], intList[3]);
            break;
          case 'createPolyline':
            this.windows[this.windowID].createPolyline(intList[0]);
            break;
          case 'drawPolyline':
            this.windows[this.windowID].drawPolyline();
            break;
          case 'drawRectangle':
            this.windows[this.windowID].drawRectangle(intList[0], intList[1], intList[2], intList[3]);
            break;
          case 'setVisible':
            this.windows[this.windowID].setVisible(boolList[0]);
            break;
          case 'setAlwaysOnTop':
            this.windows[this.windowID].setAlwaysOnTop(boolList[0]);
            break;
          case 'addMessage':
            this.windows[this.windowID].addMessage(stringList[0]);
            break;
          case 'addMessageBox':
            this.windows[this.windowID].addMessageBox();
            break;
          case 'clear':
            this.windows[this.windowID].clear();
            break;
          case 'setStrokeWidth':
            this.windows[this.windowID].setStrokeWidth(floatList[0]);
            break;
          case 'drawEllipse':
            this.windows[this.windowID].drawEllipse(intList[0], intList[1], intList[2], intList[3]);
            break;
          case 'pen':
            if (intList.length === 4) {
              this.windows[this.windowID].pen(intList[0], intList[1], intList[2], intList[3]);
            } else {
              this.windows[this.windowID].pen(intList[0], intList[1], intList[2]);
            }
            break;
          case 'brush':
            if (intList.length === 4) {
              this.windows[this.windowID].brush(intList[0], intList[1], intList[2], intList[3]);
            } else {
              this.windows[this.windowID].brush(intList[0], intList[1], intList[2]);
            }
            break;
          case 'textAttributes':
            this.windows[this.windowID].textAttributes(stringList[0], intList[0], boolList[0], boolList[1], boolList[2]);
            break;
          case 'drawText':
            this.windows[this.windowID].drawText(intList[0], intList[1], stringList[0]);
            break;
          case 'addMenuBarItem':
            if (boolList.length > 0) {
              this.windows[this.windowID].addMenuBarItem(stringList[0], stringList[1], intList[0], boolList[0]);
            } else if (intList.length > 0) {
              this.windows[this.windowID].addMenuBarItem(stringList[0], stringList[1], intList[0]);
            } else {
              this.windows[this.windowID].addMenuBarItem(stringList[0], stringList[1]);
            }
            break;
          case 'addPopupMenuItem':
            if (stringList.length === 4) {
              this.windows[this.windowID].addPopupMenuItem(stringList[0], stringList[1], intList[0], stringList[2], stringList[3]);
            } else {
              this.windows[this.windowID].addPopupMenuItem(stringList[0], stringList[1]);
            }
            break;
          case 'update':
            this.windows[this.windowID].update();
            break;
          case 'showInputDialog':
            this.windows[this.windowID].showInputDialog(stringList[0]);
            break;
          case 'showYesNoDialog':
            this.windows[this.windowID].showYesNoDialog(stringList[0]);
            break;
          case 'zoomRectangle':
            this.windows[this.windowID].zoomRectangle(intList[0], intList[1], intList[2], intList[3]);
            break;
          case 'readImage':
            this.imageWaiting = true;
            this.imageXPos = intList[0];
            this.imageYPos = intList[1];
            break;
          case 'drawImage':
            this.windows[this.windowID].drawImage();
            // Assuming PImage is adapted to JavaScript
            // const image = new PImage(stringList[0]);
            // this.windows[this.windowID].drawImage(image, intList[0], intList[1]);
            break;
          case 'destroy':
            this.windows[this.windowID].destroy();
            break;
          default:
            // Handle unrecognized function call
            console.log(`Unrecognized function call: ${func}`);
            break;
        }
      } else if (idStrs[1].startsWith('= luajava.newInstance')) {
        // No colon. Check for create window.
        this.windows[this.windowID] = new SVWindow(stringList[1],
          intList[0], intList[1],
          intList[2], intList[3],
          intList[4], intList[5],
          intList[6], this.createCanvas, this.lightTheme);
      }
    }
  }

  queue = [];

  isProcessing = false;

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const { args, resolve } = this.queue.shift();
      try {
        const result = await this.IOLoop(...args);
        resolve(result);
      } catch (error) {
        resolve(Promise.reject(error));
      }
    }

    this.isProcessing = false;
  }

  async IOLoopWrapper(...args) {
    return new Promise((resolve, reject) => {
      this.queue.push({ args, resolve, reject });
      this.processQueue();
    });
  }

  /**
   *
   * @param {string} inputStr
   */
  async processVisStr(inputStr) {
    await this._init();
    const inputArr = inputStr.split(/[\r\n]+/).filter((x) => x);
    for (let i = 0; i < inputArr.length; i++) {
      await this.IOLoopWrapper(inputArr[i]);
    }
  }
}
