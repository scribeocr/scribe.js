import { findXrefOffset, parseXref, ObjectCache } from '../js/pdf/parsePdfUtils.js';
import { getPageObjects } from '../js/pdf/parsePdfDoc.js';
import { renderPdfPageAsImage } from '../js/pdf/renderPdfPage.js';
import { ca } from '../js/canvasAdapter.js';

/**
 * Render one page of a PDF to a PNG data URL.
 * @param {Uint8Array|ArrayBuffer} pdfData
 * @param {number} pageIndex
 * @param {'color'|'gray'} [colorMode='color']
 * @returns {Promise<{dataUrl: string, colorMode: string}>}
 */
export async function renderPdfPage(pdfData, pageIndex, colorMode = 'color') {
  if (typeof process !== 'undefined') await ca.getCanvasNode();
  const bytes = pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
  const objCache = new ObjectCache(bytes, parseXref(bytes, findXrefOffset(bytes)));
  const page = getPageObjects(objCache)[pageIndex];
  try {
    return await renderPdfPageAsImage(
      page.objText, objCache, page.cropBox || page.mediaBox,
      pageIndex, colorMode, page.rotate,
    );
  } finally {
    if (typeof process !== 'undefined') {
      ca.unregisterFontsMatching((n) => n.startsWith(`_pdf_d${objCache.docId}_`));
    }
  }
}
