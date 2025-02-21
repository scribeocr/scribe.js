import fs from 'fs';
import scribe from '../scribe.js';

/**
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {string} [outputPath] - Output file path.
 *    If provided, the text will be extracted and saved to this path.
 */
export const detectPDFType = async (pdfFile, outputPath) => {
  const mupdfScheduler = await scribe.data.image.getMuPDFScheduler(1);
  const w = mupdfScheduler.workers[0];

  const fileData = await fs.readFileSync(pdfFile);

  const pdfDoc = await w.openDocument(fileData, 'file.pdf');
  w.pdfDoc = pdfDoc;

  let type = 'Image Native';

  if (outputPath) {
    const res = await w.detectExtractText();
    type = res.type;
    fs.writeFileSync(outputPath, res.text);
  } else {
    const nativeCode = await w.checkNativeText();
    type = ['Text native', 'Image + OCR text', 'Image native'][nativeCode];
  }

  console.log('PDF Type:', type);

  mupdfScheduler.scheduler.terminate();

};
