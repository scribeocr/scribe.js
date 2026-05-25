import { getBoxColorFunc, getLineColorFunc, getViewColor } from './constants.js';

/**
 *
 * @param {*} canvas
 * @param {string} name
 * @param {Object<string, string>} colorsRect
 * @param {Object<string, string>} colorsLine
 * @param {boolean} [lightTheme=false] Assume white background instead of black background.
 * This function was added for this project; no analagous function exists in Tesseract.
 *
 * Returns `true` if anything meaningful was drawn to the canvas, otherwise returns `false`.
 *
 */
export function drawColorLegend(canvas, name, colorsRect, colorsLine, lightTheme = false) {
  const boxColorFunc = getBoxColorFunc(name);
  const lineColorFunc = getLineColorFunc(name);

  if (!(boxColorFunc && colorsRect) && !(lineColorFunc && colorsLine)) return false;

  // const canvas = document.createElement('canvas');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

  let startY = 10; // Starting Y position for the first color
  const boxHeight = 20; // Height of the color box
  const boxWidth = 40; // Width of the color box
  const padding = 10; // Padding between boxes
  const textPadding = 10; // Padding between box and text
  const lineHeight = boxHeight + padding; // Calculate line height for each entry

  const elemsCt = (Object.keys(colorsRect).length || 0) * !!boxColorFunc + (Object.keys(colorsLine).length || 0) * !!lineColorFunc;

  canvas.width = 500;
  canvas.height = lineHeight * elemsCt + padding;

  // Set the background of the canvas to black
  ctx.fillStyle = lightTheme ? 'white' : 'black';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (colorsRect && boxColorFunc) {
    Object.keys(colorsRect).map((color) => {
      const colorObj = boxColorFunc(color);

      const colorLabelArr = [];
      for (const [key, value] of Object.entries(colorObj)) {
        colorLabelArr.push(`${key}: ${value}`);
      }

      // Add a stroke around the box
      ctx.strokeStyle = getViewColor(color, lightTheme);
      ctx.lineWidth = 2;
      ctx.strokeRect(padding, startY, boxWidth, boxHeight);

      // Draw the text
      ctx.fillStyle = lightTheme ? 'black' : 'white';
      ctx.textBaseline = 'middle'; // Align text vertically in the middle of the box
      let offsetX = 0;
      for (let i = 0; i < colorLabelArr.length; i++) {
        ctx.fillText(colorLabelArr[i], padding + boxWidth + textPadding + offsetX, startY + boxHeight / 2);
        offsetX += 200;
      }

      // Move startY for the next color box
      startY += lineHeight;
    });
  }

  if (colorsLine && lineColorFunc) {
    Object.keys(colorsLine).map((color) => {
      const colorObj = lineColorFunc(color);

      const colorLabelArr = [];
      for (const [key, value] of Object.entries(colorObj)) {
        colorLabelArr.push(`${key}: ${value}`);
      }

      // Add a stroke around the box
      ctx.strokeStyle = getViewColor(color, lightTheme);
      ctx.lineWidth = 2;
      ctx.fillStyle = getViewColor(color, lightTheme);
      // ctx.strokeRect(padding, startY, boxWidth, boxHeight);

      ctx.beginPath();
      ctx.roundRect(padding, startY + 7, boxWidth, 3, [40]);
      ctx.stroke();
      ctx.fill();

      // Draw the text
      ctx.fillStyle = lightTheme ? 'black' : 'white';
      ctx.textBaseline = 'middle';
      let offsetX = 0;
      for (let i = 0; i < colorLabelArr.length; i++) {
        ctx.fillText(colorLabelArr[i], padding + boxWidth + textPadding + offsetX, startY + boxHeight / 2);
        offsetX += 200;
      }

      // Move startY for the next color box
      startY += lineHeight;
    });
  }

  return true;
}

/**
 * Generates a random integer.
 *
 * @param {number} min - The minimum value (inclusive).
 * @param {number} max - The maximum value (exclusive).
 *
 * Taken from: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random
 */
export function getRandomInt(min, max) {
  const minI = Math.ceil(min);
  const maxI = Math.floor(max);
  return Math.floor(Math.random() * (maxI - minI) + minI); // The maximum is exclusive and the minimum is inclusive
}

/**
 * Generates a random alphanumeric string of a specified length.
 *
 * @param {number} num - The length of the alphanumeric string to generate.
 */
export function getRandomAlphanum(num) {
  const outArr = new Array(num);
  for (let i = 0; i < num; i++) {
    let intI = getRandomInt(1, 62);
    if (intI <= 10) {
      intI += 47;
    } else if (intI <= 36) {
      intI = intI - 10 + 64;
    } else {
      intI = intI - 36 + 96;
    }
    outArr[i] = String.fromCharCode(intI);
  }
  return outArr.join('');
}
