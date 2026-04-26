import fs from 'node:fs';
import scribe from '../scribe.js';

/**
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {string} [outputPath] - Output file path.
 *    If provided, the text will be extracted and saved to this path.
 */
export const detectPDFType = async (pdfFile, outputPath) => {
  await scribe.importFiles([pdfFile]);

  const typeMap = {
    text: 'Text native',
    ocr: 'Image + OCR text',
    image: 'Image native',
  };
  const type = typeMap[scribe.inputData.pdfType] || 'Image native';

  if (outputPath) {
    const text = scribe.utils.writeText({
      ocrCurrent: scribe.data.ocr.active,
      reflowText: false,
      lineNumbers: false,
    });
    fs.writeFileSync(outputPath, text);
  }

  console.log('PDF Type:', type);

  await scribe.terminate();
};
