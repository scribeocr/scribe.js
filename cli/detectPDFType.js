import fs from 'node:fs';

import { detectPdfType } from '../js/pdf/parsePdfDoc.js';

const typeMap = {
  text: 'Text native',
  ocr: 'Image + OCR text',
  image: 'Image native',
};

/**
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {string} [outputPath] - Output file path.
 *    If provided, the text will be extracted and saved to this path.
 */
export const detectPDFType = async (pdfFile, outputPath) => {
  if (!outputPath) {
    const pdfBytes = new Uint8Array(fs.readFileSync(pdfFile));
    const { type } = detectPdfType(pdfBytes);
    console.log('PDF Type:', typeMap[type] || 'Image native');
    return;
  }

  const { default: scribe } = await import('../scribe.js');
  const doc = await scribe.openDocument([pdfFile]);
  const type = typeMap[doc.inputData.pdfType] || 'Image native';

  const text = scribe.utils.writeText({
    ocrCurrent: doc.ocr.active,
    reflowText: false,
    lineNumbers: false,
    pageMetrics: doc.pageMetrics,
  });
  fs.writeFileSync(outputPath, text);

  console.log('PDF Type:', type);

  await doc.terminate();
  await scribe.terminate();
};
