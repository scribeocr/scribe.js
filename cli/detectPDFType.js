import fs from 'node:fs';

import { detectPdfType } from '../js/pdf/parsePdfDoc.js';
import { writeTextChunks } from '../js/export/writeText.js';

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

  const fd = fs.openSync(outputPath, 'w');
  try {
    for (const chunk of writeTextChunks({
      ocrCurrent: doc.pageStore.pageList(),
      reflowText: false,
      lineNumbers: false,
      pageMetrics: doc.pageMetrics,
    })) fs.writeFileSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }

  console.log('PDF Type:', type);

  await scribe.terminate();
};
