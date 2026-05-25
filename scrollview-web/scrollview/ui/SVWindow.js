// Disabling eslint rules that would increase differences between Java/JavaScript versions.
/* eslint-disable no-param-reassign */

import { getViewColor } from '../../src/constants.js';

export class SVWindow {
  /**
   * Construct a new SVWindow and set it visible.
   *
   * @param {string} name Title of the window.
   * @param {number} hash Unique internal representation. This has to be the same as
   *        defined by the client, as they use this to refer to the windows.
   * @param {number} posX X position of where to draw the window (upper left).
   * @param {number} posY Y position of where to draw the window (upper left).
   * @param {number} sizeX The width of the window.
   * @param {number} sizeY The height of the window.
   * @param {number} canvasSizeX The canvas width of the window.
   * @param {number} canvasSizeY The canvas height of the window.
   * @param {*} createCanvas
   * @param {boolean} [lightTheme=false] Assume white background instead of black background.
   */
  constructor(name, hash, posX, posY, sizeX, sizeY, canvasSizeX, canvasSizeY, createCanvas, lightTheme = false) {
    // Provide defaults for sizes.
    if (sizeX <= 0) sizeX = canvasSizeX;
    if (sizeY <= 0) sizeY = canvasSizeY;
    if (canvasSizeX <= 0) canvasSizeX = sizeX;
    if (canvasSizeY <= 0) canvasSizeY = sizeY;

    // Avoid later division by zero.
    if (sizeX <= 0) {
      sizeX = 1;
      canvasSizeX = sizeX;
    }
    if (sizeY <= 0) {
      sizeY = 1;
      canvasSizeY = sizeY;
    }

    // Initialize variables
    this.name = name;
    this.hash = hash;
    this.currentPenColor = 'black';
    this.currentBrushColor = 'rgb(0, 0, 0, 0)';
    this.currentFont = 'normal 12px Times';
    this.stroke = 2;

    // Keep track of all stroke colors so they can be listed to the user.
    // Tesseract uses many different (often similar) colors, so it can be otherwise difficult to determine which color is being used.
    this.penColorsRect = {};
    this.penColorsLine = {};

    /** @type {Array<number>} */
    this.polylineXCoords = [];

    /** @type {Array<number>} */
    this.polylineYCoords = [];

    this.polylineSize = 0;

    this.polylineScanned = 0;

    // Determine the initial size and zoom factor of the window.
    // If the window is too big, rescale it and zoom out.
    //  shrinkfactor = 1;

    // if (sizeX > MAX_WINDOW_X) {
    // shrinkfactor = (sizeX + MAX_WINDOW_X - 1) / MAX_WINDOW_X;
    // }
    // if (sizeY / shrinkfactor > MAX_WINDOW_Y) {
    // shrinkfactor = (sizeY + MAX_WINDOW_Y - 1) / MAX_WINDOW_Y;
    // }
    // winSizeX = sizeX / shrinkfactor;
    // winSizeY = sizeY / shrinkfactor;
    // double initialScalingfactor = 1.0 / shrinkfactor;
    // if (winSizeX > canvasSizeX || winSizeY > canvasSizeY) {
    // initialScalingfactor = Math.min(1.0 * winSizeX / canvasSizeX,
    //                         1.0 * winSizeY / canvasSizeY);
    // }

    // Setup the actual window (its size, camera, title, etc.)
    this.canvasSizeX = canvasSizeX;
    this.canvasSizeY = canvasSizeY;

    this.canvas = createCanvas(this.canvasSizeX, this.canvasSizeY);

    // Add the canvas to the document's body
    // document.body.appendChild(this.canvas);
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));

    this.lightTheme = lightTheme;
  }

  /**
   * Draw a line from (x1, y1) to (x2, y2) using the current pen color and stroke.
   * @param {number} x1 - The x-coordinate of the start point of the line.
   * @param {number} y1 - The y-coordinate of the start point of the line.
   * @param {number} x2 - The x-coordinate of the end point of the line.
   * @param {number} y2 - The y-coordinate of the end point of the line.
   */
  drawLine(x1, y1, x2, y2) {
    // Assuming currentPenColor and stroke are globally accessible
    // and have been set before this function is called.

    this.ctx.beginPath(); // Begin a new path

    this.ctx.moveTo(x1, y1); // Move the pen to the start point
    this.ctx.lineTo(x2, y2); // Draw a line to the end point

    // this.ctx.strokeStyle = 'red'; // Set the color of the line

    this.ctx.strokeStyle = getViewColor(this.currentPenColor, this.lightTheme); // Set the color of the line
    this.ctx.lineWidth = this.stroke; // Set the width of the line
    this.penColorsLine[this.currentPenColor] = true;

    this.ctx.stroke(); // Render the path
  }

  /**
   * Draw a rectangle given the two points (x1, y1) and (x2, y2) using the current
   * stroke, pen color for the border, and the brush to fill the interior.
   * @param {number} x1 - The x-coordinate of the first point.
   * @param {number} y1 - The y-coordinate of the first point.
   * @param {number} x2 - The x-coordinate of the opposite point.
   * @param {number} y2 - The y-coordinate of the opposite point.
   */
  drawRectangle(x1, y1, x2, y2) {
    // Correcting the coordinates if necessary
    if (x1 > x2) {
      const t = x1;
      x1 = x2;
      x2 = t;
    }
    if (y1 > y2) {
      const t = y1;
      y1 = y2;
      y2 = t;
    }

    // Assuming currentPenColor and currentBrushColor are globally accessible
    // and have been set before this function is called.

    // Set the stroke style (border color) and fill style (interior color)
    this.ctx.strokeStyle = getViewColor(this.currentPenColor, this.lightTheme);
    this.ctx.fillStyle = getViewColor(this.currentBrushColor, this.lightTheme);
    // When windows are first created, there is an instruction to draw a grey rectangle around the entire canvas.
    // This is not added to `this.penColorsRect` as the color gray conveys no meaning in this context so should not be added to keys.
    if (!(x1 === 0 && y1 === 0 && x2 === this.canvasSizeX && y2 === this.canvasSizeY)) this.penColorsRect[this.currentPenColor] = true;
    // this.ctx.fillStyle = 'blue';
    // this.ctx.strokeStyle = 'green';

    // Set the stroke width
    this.ctx.lineWidth = this.stroke;

    // Draw the rectangle
    this.ctx.beginPath();
    this.ctx.rect(x1, y1, x2 - x1, y2 - y1);

    // Fill the rectangle's interior and then stroke (draw) its border
    this.ctx.fill();
    this.ctx.stroke();
  }

  /** Set the pen color to an RGBA value */
  pen(red, green, blue, alpha = 255) {
    this.currentPenColor = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  /** Set the brush to an RGBA color */
  brush(red, green, blue, alpha = 255) {
    this.currentBrushColor = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  /**
   * Allows you to specify the thickness with which to draw lines, recantgles
   * and ellipses.
   * @param {number} width The new thickness.
   */
  setStrokeWidth(width) {
    this.stroke = width;
  }

  // createPolyline(...args) {
  //   const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
  //   console.log(`${func} not implemented.`);
  // }

  /**
   * Start setting up a new polyline.
   * @param {number} length - Number of coordinate pairs.
   */
  createPolyline(length) {
    this.polylineXCoords = new Array(length);
    this.polylineYCoords = new Array(length);
    this.polylineSize = length;
    this.polylineScanned = 0;
  }

  /**
   * Draw the now complete polyline.
   */
  drawPolyline() {
    const numCoords = this.polylineXCoords.length;
    if (numCoords < 2) {
      return;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(this.polylineXCoords[0], this.polylineYCoords[0]);

    for (let p = 1; p < numCoords; ++p) {
      this.ctx.lineTo(this.polylineXCoords[p], this.polylineYCoords[p]);
    }

    // Set the stroke style and apply it
    this.ctx.strokeStyle = getViewColor(this.currentPenColor, this.lightTheme);
    this.ctx.lineWidth = this.stroke;
    this.ctx.stroke();
    this.penColorsRect[this.currentPenColor] = true;

    this.polylineSize = 0;
  }

  /**
   * Draw some text at (x, y) using the current pen color and text attributes.
   * @param {number} x - The x-coordinate for the text.
   * @param {number} y - The y-coordinate for the text.
   * @param {string} text - The text to be drawn.
   */
  drawText(x, y, text) {
    this.ctx.fillStyle = this.currentPenColor;
    this.ctx.font = this.currentFont;

    this.ctx.fillText(text, x, y);
  }

  /**
   * Define how to display text.
   * @param {string} font - The font family.
   * @param {number} pixelSize - The size of the font in pixels.
   * @param {boolean} bold - Whether the font is bold.
   * @param {boolean} italic - Whether the font is italic.
   * @param {boolean} underlined - Whether the font is underlined (currently not supported).
   */
  textAttributes(font, pixelSize, bold, italic, underlined) {
    let fontStyle = '';
    if (italic) {
      fontStyle += 'italic ';
    }
    if (bold) {
      fontStyle += 'bold ';
    }

    // Combine the font properties into a CSS font string
    this.currentFont = `${fontStyle} ${pixelSize}px ${font}`;
  }

  setVisible(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  setAlwaysOnTop(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  addMessage(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  addMessageBox(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  clear(...args) {
    // Not printing warning for `clear` as this is not implemented by design.
    // In a non-interactive context, it does not make sense for a canvas to be cleared by later commands.
    // Insructions sent to the same window will overlap--hopefully this is obvious.
  }

  drawEllipse(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  addMenuBarItem(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  addPopupMenuItem(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  update(...args) {
    // Not printing warning for `update` as this is not implemented by design.
    // The `update` function updates the UI in the Java application; this happens automatically in this implementation.
  }

  showInputDialog(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  showYesNoDialog(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  zoomRectangle(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  /**
   * Draw the image with the given name at (x,y).
   * @param {ImageBitmap} img
   * @param {number} xPos
   * @param {number} yPos
   */
  drawImageInternal(img, xPos, yPos) {
    this.ctx.drawImage(img, xPos, yPos);
  }

  drawImage(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }

  destroy(...args) {
    const func = (new Error()).stack?.split('\n')[1].trim().split(' ')[1] || 'Function ';
    console.log(`${func} not implemented.`);
  }
}
