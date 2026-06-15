import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { reorderOcrPage } from '../modifyOCR.js';
import { saveAs } from '../utils/miscUtils.js';
import { writePdf } from './pdf/writePdf.js';
import { overlayPdfText } from './pdf/writePdfOverlay.js';
import { subsetPdf } from './pdf/subsetPdf.js';
import { writeHocr } from './writeHocr.js';
import { writeText } from './writeText.js';
import { writeHtml } from './writeHtml.js';
import { writeAlto } from './writeAlto.js';
import { writeMarkdown } from './writeMarkdown.js';
import { OcrPage, removeCircularRefsOcr } from '../objects/ocrObjects.js';
import { removeCircularRefsDataTables } from '../objects/layoutObjects.js';

/** @typedef {import('../containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * @typedef {Object} ExportOptions
 * @property {number} [minPage=0] - First page to export.
 * @property {number} [maxPage=-1] - Last page to export (inclusive). -1 exports through the last page.
 * @property {?Array<number>} [pageArr=null] - Array of 0-based page indices to include.
 *    Overrides minPage/maxPage when provided.
 * @property {('invis'|'ebook'|'eval'|'proof'|'annot')} [displayMode]
 * @property {('color'|'gray'|'binary')} [colorMode]
 * @property {number} [overlayOpacity]
 * @property {boolean} [addOverlay]
 * @property {boolean} [autoRotate]
 * @property {number} [confThreshHigh]
 * @property {number} [confThreshMed]
 * @property {boolean} [standardizePageSize]
 * @property {boolean} [humanReadablePDF]
 * @property {boolean} [reflow]
 * @property {boolean} [lineNumbers]
 * @property {boolean} [removeMargins]
 * @property {boolean} [includeImages]
 * @property {boolean} [convertDupSourceTextToPaths] - When overlaying onto a PDF input,
 *    convert the input PDF's vector text to glyph outlines before adding the invisible OCR text layer.
 *    Ignored unless the export uses the overlay path (PDF input, addOverlay, displayMode !== 'ebook').
 * @property {boolean} [routePageCategories] - Apply the per-page flatten/passthrough routing regardless of display mode.
 *    Defaults to true for 'invis' and false otherwise.
 *    Review tooling sets it with displayMode 'proof' to render the searchable flow's routing with a visible confidence-coloured overlay.
 * @property {boolean} [embedFonts]
 * @property {boolean} [enableLayout]
 * @property {boolean} [xlsxFilenameColumn]
 * @property {boolean} [xlsxPageNumberColumn]
 * @property {boolean} [compressScribe]
 * @property {boolean} [includeExtraTextScribe]
 * @property {'width' | 'sentence'} [docxLineSplitMode]
 */

/**
 * Export this document's OCR data to the specified format.
 *
 * Every setting resolves as `options.X ?? scribeDocDefaults.X`.
 *
 * @param {ScribeDoc} doc
 * @param {'pdf'|'hocr'|'alto'|'docx'|'html'|'xlsx'|'txt'|'text'|'md'|'scribe'} [format='txt']
 * @param {ExportOptions} [options]
 * @returns {Promise<string|ArrayBuffer>}
 */
export async function exportData(doc, format = 'txt', options = {}) {
  if (format === 'text') format = 'txt';

  const minPage = options.minPage ?? 0;
  let maxPage = options.maxPage ?? -1;
  let pageArr = options.pageArr ?? null;

  // Every setting resolves as `options.X ?? scribeDocDefaults.X`. There is no per-doc
  // instance state for settings.
  const displayMode = options.displayMode ?? scribeDocDefaults.displayMode;
  const colorMode = options.colorMode ?? scribeDocDefaults.colorMode;
  const overlayOpacity = options.overlayOpacity ?? scribeDocDefaults.overlayOpacity;
  const addOverlay = options.addOverlay ?? scribeDocDefaults.addOverlay;
  const autoRotate = options.autoRotate ?? scribeDocDefaults.autoRotate;
  const confThreshHigh = options.confThreshHigh ?? scribeDocDefaults.confThreshHigh;
  const confThreshMed = options.confThreshMed ?? scribeDocDefaults.confThreshMed;
  const standardizePageSize = options.standardizePageSize ?? scribeDocDefaults.standardizePageSize;
  const humanReadablePDF = options.humanReadablePDF ?? scribeDocDefaults.humanReadablePDF;
  const reflow = options.reflow ?? scribeDocDefaults.reflow;
  const lineNumbers = options.lineNumbers ?? scribeDocDefaults.lineNumbers;
  const removeMargins = options.removeMargins ?? scribeDocDefaults.removeMargins;
  const includeImagesOpt = options.includeImages ?? scribeDocDefaults.includeImages;
  const convertDupSourceTextToPaths = options.convertDupSourceTextToPaths ?? scribeDocDefaults.convertDupSourceTextToPaths;
  const embedFonts = options.embedFonts ?? scribeDocDefaults.embedFonts;
  const enableLayout = options.enableLayout ?? scribeDocDefaults.enableLayout;
  const compressScribe = options.compressScribe ?? scribeDocDefaults.compressScribe;
  const includeExtraTextScribe = options.includeExtraTextScribe ?? scribeDocDefaults.includeExtraTextScribe;

  if (!pageArr) {
    if (maxPage === -1) maxPage = doc.inputData.pageCount - 1;
    pageArr = [];
    for (let i = minPage; i <= maxPage; i++) pageArr.push(i);
  }

  /** @type {Array<OcrPage>} */
  let ocrDownload = [];

  if (format !== 'hocr' && enableLayout) {
    // Reorder HOCR elements according to layout boxes
    for (let i = 0; i < doc.ocr.active.length; i++) {
      ocrDownload.push(reorderOcrPage(doc.ocr.active[i], doc.layoutRegions.pages[i]));
    }
  } else {
    ocrDownload = doc.ocr.active;
  }

  /** @type {string|ArrayBuffer} */
  let content;

  if (format === 'pdf') {
    if (convertDupSourceTextToPaths && !(displayMode !== 'ebook' && doc.inputData.pdfMode && addOverlay)) {
      console.warn('convertDupSourceTextToPaths is only applied when overlaying OCR text onto a PDF input '
        + "(requires a PDF input, addOverlay enabled, and displayMode other than 'ebook'); ignoring.");
    }

    // Surfaces per-annotation skips (a bad annotation no longer aborts the whole export).
    const warningHandler = (message) => doc.warningHandler({ message });

    const dimsLimit = { width: -1, height: -1 };
    if (standardizePageSize) {
      for (const i of pageArr) {
        dimsLimit.height = Math.max(dimsLimit.height, doc.pageMetrics[i].dims.height);
        dimsLimit.width = Math.max(dimsLimit.width, doc.pageMetrics[i].dims.width);
      }
    }

    // For proof or ocr mode the text layer needs to be combined with a background layer
    if (displayMode !== 'ebook') {
      const insertInputPDF = doc.inputData.pdfMode && addOverlay;

      const rotateBackground = !insertInputPDF && autoRotate;

      const rotateText = !rotateBackground;

      let insertInputFailed = false;

      if (insertInputPDF) {
        try {
          let basePdfData = doc.images.pdfData;
          let overlayOcrArr = ocrDownload;
          let overlayPageMetricsArr = doc.pageMetrics;
          let overlayAnnotationsPages = doc.annotations.pages;
          let pageCats = doc.inputData.pageCategories;
          if (pageArr.length < doc.inputData.pageCount) {
            const fullCats = pageCats;
            basePdfData = await subsetPdf(basePdfData, pageArr);
            overlayOcrArr = pageArr.map((i) => ocrDownload[i]);
            overlayPageMetricsArr = pageArr.map((i) => doc.pageMetrics[i]);
            overlayAnnotationsPages = pageArr.map((i) => doc.annotations.pages[i] || []);
            pageCats = fullCats ? pageArr.map((i) => fullCats[i]) : null;
          }

          // convertFullPages and convertBrokenType3 control per-page flatten vs. passthrough.
          // They default to the legacy path: a full overlay on every page plus broken-Type3 conversion.
          // The block below overrides that by routing on import-time page categories,
          // engaged for the searchable ('invis') flow by default and for a visible mode only when routePageCategories is set.
          // With routing off or categories absent (old .scribe.json sessions), the legacy defaults stand.
          /** @type {?number[]} */
          let convertFullPages = null;
          let convertBrokenType3 = true;
          // convertDupSourceTextToPaths converts ALL text to paths by explicit request,
          // so it skips the category routing below entirely.
          const routeCategories = options.routePageCategories ?? (displayMode === 'invis');
          if (routeCategories && !convertDupSourceTextToPaths && pageCats && pageCats.length > 0
            && (overlayOcrArr.length === 0 || overlayOcrArr.length === pageCats.length)) {
            const flagged = pageCats.map((c) => !!(c && (c.hasLargeImage || c.hasPathText || c.hasBrokenFontRun || c.hasImageText)));
            // Flatten exists ONLY to support an invisible text layer:
            // a flagged page is flattened exactly when it has overlay text to add (from any source), and that text is kept.
            // A flagged page with no text, and any clean page, gets an empty overlay and is left unflattened,
            // so its native text stays the only text layer.
            const ocrIn = overlayOcrArr;
            convertFullPages = [];
            overlayOcrArr = pageCats.map((c, i) => {
              const p = ocrIn[i];
              const hasWords = !!(p && p.lines && p.lines.length > 0);
              if (flagged[i] && hasWords) {
                convertFullPages.push(i);
                return p;
              }
              return new OcrPage(i, p?.dims || overlayPageMetricsArr[i].dims);
            });
            convertBrokenType3 = false;
          }

          content = await overlayPdfText({
            basePdfData,
            ocrArr: overlayOcrArr,
            pageMetricsArr: overlayPageMetricsArr,
            textMode: displayMode,
            rotateText,
            rotateBackground,
            confThreshHigh,
            confThreshMed,
            proofOpacity: overlayOpacity / 100,
            humanReadable: humanReadablePDF,
            annotationsPages: overlayAnnotationsPages,
            convertTextToPaths: convertDupSourceTextToPaths,
            convertFullPages,
            convertBrokenType3ToPaths: convertBrokenType3,
            docFonts: doc.fonts,
            warningHandler,
          });
        } catch (error) {
          console.error('Failed to overlay text onto input PDF, creating new PDF from rendered images instead.');
          console.error(error);
          insertInputFailed = true;
        }
      }

      // Build a fresh PDF (writePdf handles images natively; no mupdf convertImage* needed).
      if (!insertInputPDF || insertInputFailed) {
        const props = { rotated: rotateBackground, upscaled: false, colorMode };
        const binary = colorMode === 'binary';

        // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
        // Otherwise, the images uploaded by the user are used.
        const renderImage = binary || doc.inputData.pdfMode;
        const includeImages = doc.inputData.pdfMode || doc.inputData.imageMode;

        // Pre-render to benefit from parallel processing, since the loop below is synchronous.
        if (renderImage && includeImages) await doc.images.preRenderRange({ pageArr, binary, props });

        /** @type {ImageWrapper[]} */
        const images = [];
        if (includeImages) {
          for (const i of pageArr) {
            let image;
            if (binary) {
              image = await doc.images.getBinary(i, props);
            } else if (doc.inputData.pdfMode) {
              image = await doc.images.getNative(i, props);
            } else {
              image = await doc.images.nativeSrc[i];
            }
            images.push(image);
            doc.progressHandler({ n: i, type: 'export', info: {} });
          }
        }

        content = await writePdf({
          ocrArr: ocrDownload,
          pageMetricsArr: doc.pageMetrics,
          pageArr,
          textMode: displayMode,
          rotateText,
          rotateBackground,
          dimsLimit: { width: -1, height: -1 },
          confThreshHigh,
          confThreshMed,
          proofOpacity: overlayOpacity / 100,
          images,
          includeImages,
          annotationsPages: doc.annotations.pages,
          humanReadable: humanReadablePDF,
          docFonts: doc.fonts,
          doc,
          warningHandler,
        });
      }
    } else {
      content = await writePdf({
        ocrArr: ocrDownload,
        pageMetricsArr: doc.pageMetrics,
        pageArr,
        textMode: displayMode,
        rotateText: false,
        rotateBackground: true,
        dimsLimit,
        confThreshHigh,
        confThreshMed,
        proofOpacity: overlayOpacity / 100,
        annotationsPages: doc.annotations.pages,
        humanReadable: humanReadablePDF,
        docFonts: doc.fonts,
        doc,
        warningHandler,
      });
    }
  } else if (format === 'hocr') {
    content = writeHocr({
      ocrData: ocrDownload,
      pageArr,
      docFonts: doc.fonts,
      layoutRegions: doc.layoutRegions,
      pageMetrics: doc.pageMetrics,
      dataTablesSerialized: doc.serializeLayoutDataTables(),
      doc,
    });
  } else if (format === 'alto') {
    content = writeAlto({
      ocrData: ocrDownload, pageArr, pageMetrics: doc.pageMetrics, doc,
    });
  } else if (format === 'html') {
    const images = /** @type {Array<ImageWrapper>} */ ([]);
    if (includeImagesOpt) {
      const props = { rotated: autoRotate, upscaled: false, colorMode };
      const binary = colorMode === 'binary';

      // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
      // Otherwise, the images uploaded by the user are used.
      const renderImage = binary || doc.inputData.pdfMode;

      // Pre-render to benefit from parallel processing, since the loop below is synchronous.
      if (renderImage) await doc.images.preRenderRange({ pageArr, binary, props });

      for (const i of pageArr) {
        /** @type {ImageWrapper} */
        let image;
        if (binary) {
          image = await doc.images.getBinary(i, props);
        } else if (doc.inputData.pdfMode) {
          image = await doc.images.getNative(i, props);
        } else {
          image = await doc.images.nativeSrc[i];
        }
        images.push(image);
      }
    }

    content = writeHtml({
      ocrPages: ocrDownload,
      images,
      pageArr,
      reflowText: reflow,
      removeMargins,
      docFonts: doc.fonts,
      pageMetrics: doc.pageMetrics,
      displayMode,
      confThreshHigh,
      confThreshMed,
      overlayOpacity,
      embedFonts,
      doc,
    });
  } else if (format === 'txt') {
    content = writeText({
      ocrCurrent: ocrDownload,
      pageArr,
      reflowText: reflow,
      lineNumbers,
      pageMetrics: doc.pageMetrics,
      doc,
    });
  } else if (format === 'md') {
    content = writeMarkdown({
      ocrCurrent: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      pageArr,
      reflowText: reflow,
      pageMetrics: doc.pageMetrics,
      doc,
    });
  // Defining `DISABLE_DOCX_XLSX` disables docx/xlsx exports when using build tools.
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'docx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeDocx = (await import('./writeDocx.js')).writeDocx;
    content = await writeDocx({
      hocrCurrent: ocrDownload, pageArr, pageMetrics: doc.pageMetrics, reflowText: reflow, doc,
    });
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'xlsx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeXlsx = (await import('./writeTabular.js')).writeXlsx;
    content = await writeXlsx({
      ocrPageArr: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      inputData: doc.inputData,
      pageArr,
      xlsxFilenameColumn: options.xlsxFilenameColumn ?? scribeDocDefaults.xlsxFilenameColumn,
      xlsxPageNumberColumn: options.xlsxPageNumberColumn ?? scribeDocDefaults.xlsxPageNumberColumn,
      doc,
    });
  } else if (format === 'scribe') {
    const data = {
      ocr: removeCircularRefsOcr(ocrDownload, { includeText: includeExtraTextScribe }),
      fontState: doc.fonts.state,
      layoutRegions: doc.layoutRegions.pages,
      layoutDataTables: removeCircularRefsDataTables(doc.layoutDataTables.pages),
      annotations: doc.annotations.pages,
    };
    if (compressScribe) {
      const contentStr = JSON.stringify(data);
      const cs = new CompressionStream('gzip');
      const compressedStream = new Blob([new TextEncoder().encode(contentStr)]).stream().pipeThrough(cs);
      content = await new Response(compressedStream).arrayBuffer();
    } else {
      content = JSON.stringify(data, null, 2);
    }
  }

  return content;
}

/**
 * Run `exportData` for this document and save the result as a download (browser) or local file (Node.js).
 * @param {ScribeDoc} doc
 * @param {'pdf'|'hocr'|'alto'|'docx'|'xlsx'|'txt'|'text'|'md'|'html'|'scribe'} format
 * @param {string} fileName
 * @param {ExportOptions} [options]
 */
export async function download(doc, format, fileName, options = {}) {
  if (format === 'text') format = 'txt';
  const compressScribe = options.compressScribe ?? scribeDocDefaults.compressScribe;
  let ext;
  if (format === 'alto') {
    ext = 'xml';
  } else if (format === 'scribe' && !compressScribe) {
    ext = 'scribe.json';
  } else {
    ext = format;
  }
  fileName = fileName.replace(/\.\w{1,6}$/, `.${ext}`);
  const content = await exportData(doc, format, options);
  await saveAs(content, fileName);
}
