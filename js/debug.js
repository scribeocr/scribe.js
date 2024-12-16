import { opt } from './containers/app.js';
import { pageMetricsArr } from './containers/dataContainer.js';
import { ImageCache } from './containers/imageContainer.js';
import { gs } from './generalWorkerMain.js';
import { loadImageElem } from './utils/imageUtils.js';
import { ca } from './canvasAdapter.js';

/**
 * @typedef {Object} CompDebugParamsBrowser
 * @property {HTMLCanvasElement|OffscreenCanvas} canvas
 * @property {Array<Array<CompDebugBrowser>>} compDebugArrArr
 * @property {'browser'} context
 */

/**
 * @typedef {Object} CompDebugParamsNode
 * @property {Array<Array<CompDebugNode>>} compDebugArrArr
 * @property {'node'} context
 */

/**
 * @param {CompDebugParamsBrowser|CompDebugParamsNode} args
 */
export async function drawDebugImages(args) {
  let canvas = args.canvas;
  const compDebugArrArr = args.compDebugArrArr;
  const context = args.context;

  let top = 5;

  let canvasHeight = 5;
  let canvasWidth = 200;

  compDebugArrArr.forEach((a) => {
    a.forEach((x) => {
      canvasHeight += x.dims.height + 25;
      canvasWidth = Math.max(x.dims.width * 3 + 30, canvasWidth);
    });
  });

  if (!canvas) {
    canvas = await ca.createCanvas(canvasWidth, canvasHeight);
  } else {
    canvas.height = canvasHeight;
    canvas.width = canvasWidth;
  }

  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const fontSize = 10;
  ctx.fillStyle = 'black';
  ctx.font = `${fontSize}px NimbusSans`;

  for (const compDebugArr of compDebugArrArr) {
    for (const compDebugObj of compDebugArr) {
      // Whether "B" option is chosen
      let chosen = compDebugObj.errorRawB < compDebugObj.errorRawA;
      if (compDebugObj.errorAdjB && compDebugObj.errorAdjA) {
        chosen = compDebugObj.errorAdjB < compDebugObj.errorAdjA;
      }

      // Set a minimum width so the metrics are always readable
      const colWidth = Math.max(compDebugObj.dims.width, 50);

      // Calculating position and size based on provided values
      const rectX = 5 + colWidth + 10 + Number(chosen) * (colWidth + 10) - 3;
      const rectY = top - 3;
      const rectWidth = compDebugObj.dims.width + 6;
      const rectHeight = compDebugObj.dims.height + 6;

      // Drawing the rectangle
      ctx.fillRect(rectX, rectY, rectWidth, rectHeight);

      if (context === 'browser' && compDebugObj.context === 'browser') {
        const topI = top;
        await [compDebugObj.imageRaw, compDebugObj.imageA, compDebugObj.imageB].forEach(async (image, i) => {
          if (!image) return;
          const imgElem = document.createElement('img');
          await loadImageElem(image, imgElem);
          ctx.drawImage(imgElem, 5 + i * (colWidth + 10), topI);
        });
      } else if (context === 'node' && compDebugObj.context === 'node') {
        const imgElem0 = await ca.getImageBitmap(compDebugObj.imageRaw);
        const imgElem1 = await ca.getImageBitmap(compDebugObj.imageA);
        const imgElem2 = await ca.getImageBitmap(compDebugObj.imageB);

        ctx.drawImage(imgElem0, 5, top);
        ctx.drawImage(imgElem1, 5 + colWidth + 10, top);
        ctx.drawImage(imgElem2, 5 + 2 * (colWidth + 10), top);
      } else {
        throw new Error('Attempted to draw debug images in wrong context.');
      }

      if (compDebugObj.errorRawA || compDebugObj.errorAdjA) {
        let debugStr1 = '';
        if (compDebugObj.errorAdjA) debugStr1 += `${String(Math.round((compDebugObj.errorAdjA) * 1e3) / 1e3)} `;
        if (compDebugObj.errorRawA) debugStr1 += `[${String(Math.round((compDebugObj.errorRawA) * 1e3) / 1e3)}]`;
        ctx.fillText(debugStr1, 5 + colWidth + 10, top + compDebugObj.dims.height + fontSize + 3);
      }

      if (compDebugObj.errorRawB || compDebugObj.errorAdjB) {
        let debugStr2 = '';
        if (compDebugObj.errorRawB) debugStr2 += `${String(Math.round((compDebugObj.errorRawB) * 1e3) / 1e3)} `;
        if (compDebugObj.errorAdjB) debugStr2 += `[${String(Math.round((compDebugObj.errorAdjB) * 1e3) / 1e3)}]`;
        ctx.fillText(debugStr2, 5 + 2 * (colWidth + 10), top + compDebugObj.dims.height + fontSize + 3);
      }

      top += compDebugObj.dims.height + 25;
    }
  }

  return canvas;
}

/**
 *
 * @param {OcrPage} page
 */
export async function renderPageStatic(page) {
  const image = await ImageCache.getNative(page.n, { rotated: opt.autoRotate, upscaled: false });

  const res = gs.renderPageStaticImp({
    page,
    image,
    angle: pageMetricsArr[page.n].angle,
  });

  return res;
}
