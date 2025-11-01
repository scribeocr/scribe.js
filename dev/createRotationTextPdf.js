import { writeFile } from 'fs/promises';
import { writePdf } from '../js/export/pdf/writePdf.js';
import { importImageFilesP } from '../js/import/import.js';
import scribe from '../scribe.js';
import { PageMetrics } from '../js/objects/pageMetricsObjects.js';
import { imageUtils } from '../js/objects/imageObjects.js';

await scribe.init({ font: true });
const images = await importImageFilesP([
  './tests/assets/testocr.png',
]);

const pageMetricsImages = images.map((image) => {
  const imageDims = imageUtils.getDims(image);
  return new PageMetrics(imageDims);
});

const majorAngles = [0, 90, 180, 270];
const minorAngles = [0, 5, -5];
for (let i = 0; i < majorAngles.length; i++) {
  for (let j = 0; j < minorAngles.length; j++) {
    if (i === 0 && j === 0) continue;
    images.push(images[0]);
    pageMetricsImages.push(new PageMetrics(pageMetricsImages[0].dims));
    const angle = majorAngles[i] + minorAngles[j];
    const index = i * 3 + j;
    pageMetricsImages[index].angle = angle;
  }
}

const pdfStr = await writePdf({
  images,
  pageMetricsArr: pageMetricsImages,
  includeImages: true,
  rotateBackground: true,
  rotateOrientation: true,
});

const enc = new TextEncoder();
const pdfEnc = enc.encode(pdfStr);

await writeFile('./tests/assets/testocr_all_orientations.pdf', pdfEnc);
await scribe.terminate();
