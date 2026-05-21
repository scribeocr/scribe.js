import fs from 'node:fs';
import scribe from '../scribe.js';

/**
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {string} [outputPath] - Output file path.
 *    If provided, the text will be extracted and saved to this path.
 */
export const detectPDFType = async (pdfFile, outputPath) => {
  const doc = await scribe.openDocument([pdfFile]);

  const typeMap = {
    text: 'Text native',
    ocr: 'Image + OCR text',
    image: 'Image native',
  };
  const type = typeMap[doc.inputData.pdfType] || 'Image native';

  if (outputPath) {
    const text = scribe.utils.writeText({
      ocrCurrent: doc.ocr.active,
      reflowText: false,
      lineNumbers: false,
      pageMetrics: doc.pageMetrics,
    });
    fs.writeFileSync(outputPath, text);
  }

  console.log('PDF Type:', type);

  await doc.terminate();
  await scribe.terminate();
};
