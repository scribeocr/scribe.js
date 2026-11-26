import { opt } from '../containers/app.js';
import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { markFillTextRefs, syncFillText } from '../fillSign.js';
import { setFormValue } from '../formFields.js';
import {
  loadBuiltInFontsRaw,
} from '../fontContainerMain.js';
import { runOptimization } from '../fontEval.js';
import { calcCharMetricsLayer } from '../fontStatistics.js';
import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import {
  addCircularRefsDataTables, addCircularRefsRegions, LayoutDataTablePage, LayoutPage,
} from '../objects/layoutObjects.js';
import ocr, { OcrPage, addCircularRefsOcr, updateOcrFormat } from '../objects/ocrObjects.js';
import { PageMetrics } from '../objects/pageMetricsObjects.js';
import { reassignOutlineIds } from '../objects/outlineObjects.js';
import { checkCharWarn, convertOCR } from '../recognizeConvert.js';
import { assignPageLineNums } from './assignPageLineNums.js';
import { importImageFileToBase64 } from '../utils/imageUtils.js';
import {
  readOcrFile, clearObjectProperties, objectAssignDefined, readTextFile,
} from '../utils/miscUtils.js';
import { countOcrPages, importOCRFiles } from './importOCR.js';
import { extractInternalPDFText } from '../extractPDFText.js';
import { openSavedDoc } from '../containers/savedDoc.js';
import { PageStore, holdJson, pageRuns } from '../containers/pageStore.js';

/** @typedef {import('../containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Standardize file-like inputs between platforms.
 * If run in the browser, URLs are fetched and converted to `File` objects.
 * If using Node.js, file paths are converted into `FileNode` objects,
 * which have properties and methods similar to the browser `File` interface.
 * @param {Array<File>|FileList|Array<string>} files
 * @returns {Promise<Array<File>|Array<FileNode>>}
 */
export async function standardizeFiles(files) {
  if (typeof files[0] === 'string') {
    if (typeof process !== 'undefined') {
      const { wrapFilesNode } = await import('./nodeAdapter.js');
      return wrapFilesNode(/** @type {Array<string>} */(files));
    }

    // Fetch all URLs and convert the responses to Blobs
    const blobPromises = files.map((url) => fetch(url).then((response) => {
      if (!response.ok) {
        console.log(response);
        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
      }
      return response.blob().then((blob) => ({ blob, url }));
    }));

    // Wait for all fetches to complete
    const blobsAndUrls = await Promise.all(blobPromises);

    // Extract file name from URL and convert Blobs to File objects
    return blobsAndUrls.map(({ blob, url }) => {
      const fileName = url.split('/').pop();
      // A valid filename is necessary, as the import function uses the filename.
      if (!fileName) throw new Error(`Failed to extract file name from URL: ${url}`);
      return new File([blob], fileName, { type: blob.type });
    });
  }

  if (globalThis.FileList && files instanceof FileList) {
    return Array.from(files);
  }

  return /** @type {Array<File>} */ (files);
}

/**
 * Sorts single array of files into pdf, image, ocr, and unsupported files.
 * Used for browser interface, where files of multiple types may be uploaded using the same input.
 * @param {Array<File>|Array<FileNode>|FileList} files
 * @returns
 */
export async function sortInputFiles(files) {
  // Sort files into (1) HOCR files, (2) image files, or (3) unsupported using extension.
  /** @type {Array<File|FileNode>} */
  const imageFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const ocrFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const pdfFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const scribeFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const unsupportedFilesAll = [];
  const unsupportedExt = {};
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileExt = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase() || '';
    const fileNameLower = file.name.toLowerCase();

    if (fileNameLower.endsWith('.scribe.json')) {
      scribeFilesAll.push(file);
    // TODO: Investigate whether other file formats are supported (without additional changes)
    // Tesseract.js definitely supports more formats, so if the .pdfs we make also support a format,
    // then we should be able to expand the list of supported types without issue.
    // Update: It looks like .bmp does not work.
    } else if (['png', 'jpeg', 'jpg'].includes(fileExt)) {
      imageFilesAll.push(file);
      // All .gz files are assumed to be OCR data (xml) since all other file types can be compressed already
    } else if (['hocr', 'xml', 'html', 'gz', 'stext', 'json', 'txt', 'docx', 'md'].includes(fileExt)) {
      ocrFilesAll.push(file);
    } else if (['scribe'].includes(fileExt)) {
      scribeFilesAll.push(file);
    } else if (['pdf'].includes(fileExt)) {
      pdfFilesAll.push(file);
    } else {
      // Check if file without an extension could be a textract JSON file.
      // This is currently a hack and should be re-implemented in a better way.
      // Notably, (1) this only works for Textract JSON files stored in specific object types, and
      // (2) this reads the file content as text and then discards it after checking the content,
      // which is not ideal for performance.
      if ([''].includes(fileExt)) {
        try {
          const content = await readOcrFile(file);
          if (/"AnalyzeDocumentModelVersion"/i.test(content)) {
            ocrFilesAll.push(file);
            continue;
          }
        } catch (error) { /* empty */ }
      }

      unsupportedFilesAll.push(file);
      unsupportedExt[fileExt] = true;
    }
  }

  if (unsupportedFilesAll.length > 0) {
    const errorText = `Import includes unsupported file types: ${Object.keys(unsupportedExt).join(', ')}`;
    opt.warningHandler?.(errorText);
  }

  imageFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));
  ocrFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));

  return {
    pdfFiles: pdfFilesAll, imageFiles: imageFilesAll, ocrFiles: ocrFilesAll, scribeFiles: scribeFilesAll,
  };
}

/**
 * Read image files and return array of `ImageWrapper` objects,
 * without modifying any global state.
 * @param {Array<File>|FileList|Array<string>} files
 */
export const importImageFilesP = async (files) => {
  const files2 = await standardizeFiles(files);
  /** @type {ImageWrapper[]} */
  const images = [];
  for (let i = 0; i < files2.length; i++) {
    images[i] = await importImageFileToBase64(files2[i]).then(async (imgStr) => {
      const imgWrapper = new ImageWrapper(i, imgStr, 'native', false, false);
      return imgWrapper;
    });
  }
  return images;
};

/**
 * Assign `pageNum` and `lineNum` to every line of a text layer.
 * @param {PageStore} store
 * @param {string} layer - Name of a text layer, or `'active'`.
 */
export async function assignLayerLineNums(store, layer) {
  let sliceStart = Date.now();
  const words = [];
  for (let n = 0; n < store.slotCount(layer); n++) {
    if (Date.now() - sliceStart > 40) {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      sliceStart = Date.now();
    }
    words.push(store.pageCounts(n, layer)?.words ?? 0);
  }
  const cuts = pageRuns(words);
  /** @type {?{label: ?number}} */
  let carry = null;
  for (let c = 0; c < cuts.length - 1; c++) {
    const first = cuts[c];
    const carryIn = carry;
    carry = await store.held(async () => {
      /** @type {Array<?OcrPage|undefined>} */
      const pages = [];
      /** @type {Array<Array<?number|string|undefined>>} */
      const numsBefore = [];
      let readStart = Date.now();
      for (let n = first; n < cuts[c + 1]; n++) {
        if (Date.now() - readStart > 40) {
          await new Promise((resolve) => { setTimeout(resolve, 0); });
          readStart = Date.now();
        }
        const page = store.readOnlyPage(n, layer);
        pages.push(page);
        numsBefore.push(page ? page.lines.flatMap((line) => [line.lineNum, line.pageNum]) : []);
      }
      const out = assignPageLineNums(pages, carryIn);
      // Call getPage only on pages whose line or page numbers changed so unmodified pages keep their cached records.
      pages.forEach((page, k) => {
        if (page && page.lines.some((line, i) => line.lineNum !== numsBefore[k][2 * i] || line.pageNum !== numsBefore[k][2 * i + 1])) store.getPage(first + k, layer);
      });
      return out;
    });
  }
}

/**
 * Encoded page snapshot and metadata staged from a `.scribe` file during session restore.
 * @typedef {Object} StagedPage
 * @property {import('../containers/pageStore.js').PageSnapshot} snap
 * @property {dims} dims
 * @property {?number} angle
 * @property {boolean} lineNumMissing - Whether any line has `lineNum === undefined`.
 */

/**
 * Encode an `OcrPage` into a `StagedPage`.
 * @param {OcrPage} page
 * @returns {StagedPage}
 */
function stagePage(page) {
  return {
    snap: PageStore.snapshotOfPage(page),
    dims: page.dims,
    angle: page.angle,
    lineNumMissing: page.lines.some((line) => line.lineNum === undefined),
  };
}

/**
 * Read a .scribe file into the object its stores are restored from, without touching any document.
 * @param {string | File | FileNode | ArrayBuffer} scribeFile
 * @returns {Promise<{file: ScribeSaveData, segmentedNormalized: boolean}>} `segmentedNormalized` is set when the pages were normalized as they were read.
 */
async function readScribeFile(scribeFile) {
  /** @type {?Uint8Array} */
  let scribeBytes = null;
  if (scribeFile instanceof ArrayBuffer) scribeBytes = new Uint8Array(scribeFile);
  else if (typeof scribeFile !== 'string' && typeof scribeFile.arrayBuffer === 'function') scribeBytes = new Uint8Array(await scribeFile.arrayBuffer());

  /** @type {ScribeSaveData} */
  let scribeRestoreObj;
  // Segmented restores normalize pages inside applyRecord, so the whole-document sweeps below are skipped.
  let segmentedNormalized = false;
  if (!scribeBytes) {
    scribeRestoreObj = JSON.parse(await readOcrFile(scribeFile));
  } else {
    const isGzipped = scribeBytes[0] === 0x1F && scribeBytes[1] === 0x8B;

    let head = '';
    if (isGzipped) {
      const sniffReader = new Blob([scribeBytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const sniffDecoder = new TextDecoder('utf-8');
      let part = await sniffReader.read();
      while (!part.done && head.length < 32) {
        head += sniffDecoder.decode(part.value, { stream: true });
        part = await sniffReader.read();
      }
      await sniffReader.cancel().catch(() => {});
    } else {
      head = new TextDecoder('utf-8').decode(scribeBytes.subarray(0, 32));
    }

    if (!head.startsWith('{"scribeSegments"')) {
      // A single-JSON payload has to fit in one JavaScript string, which V8 caps at 2^29 - 24 characters.
      // Default exports past that cap are written on purpose, for consumers that parse them outside JavaScript.
      const STRING_CAP = 536_870_888;
      const tooLargeError = () => new Error('This .scribe file stores the document as a single JSON string longer than JavaScript supports, so it cannot be imported here. '
        + 'Re-export it with the scribeSegments option, or process it with non-JavaScript JSON tooling.');
      // The gzip ISIZE trailer gives the decompressed size mod 2^32, so it can understate a huge file but never overstate a small one.
      // No character takes more than four UTF-8 bytes, so a payload above four times the cap is certainly too long to parse.
      const utf8Len = isGzipped
        ? new DataView(scribeBytes.buffer, scribeBytes.byteOffset + scribeBytes.length - 4, 4).getUint32(0, true)
        : scribeBytes.length;
      if (utf8Len > STRING_CAP * 4) throw tooLargeError();
      try {
        scribeRestoreObj = JSON.parse(await readOcrFile(scribeFile));
      } catch (err) {
        // Node surfaces an over-cap TextDecoder.decode as a bogus invalid-encoding TypeError, so that error code only maps to the size error when the payload is actually past the cap.
        const overCapDecodeFailure = /** @type {?} */ (err)?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' && utf8Len > STRING_CAP;
        if (err instanceof RangeError || overCapDecodeFailure || /string longer|Invalid string length/.test(String(/** @type {?} */ (err)?.message))) throw tooLargeError();
        throw err;
      }
    } else {
      let stream = new Blob([scribeBytes]).stream();
      if (isGzipped) stream = stream.pipeThrough(new DecompressionStream('gzip'));
      const reader = stream.getReader();
      const decoder = new TextDecoder('utf-8');

      /** @type {?Record<string, any>} */
      let assembled = null;
      const applyHeader = (line) => {
        const header = line ? JSON.parse(line) : {};
        const n = header.pageCount || 0;
        assembled = {
          ocr: new Array(n).fill(null),
          fontState: header.fontState,
          layoutRegions: header.layoutRegions,
          layoutDataTables: header.layoutDataTables,
          annotations: header.annotations,
          pageRotations: header.pageRotations,
          outline: header.outline,
          inputData: header.inputData,
          session: header.session ? {
            ...header.session,
            contentEdits: header.session.contentEdits ?? new Array(n).fill(null),
            nativeText: new Array(n).fill(null),
            fillShapes: new Array(n).fill(null),
            truth: new Array(n).fill(null),
            hocrSource: { head: header.session.hocrSourceHead ?? null, pages: new Array(n).fill(null) },
          } : undefined,
        };
      };
      const applyRecord = (line) => {
        if (!line) return;
        const rec = JSON.parse(line);
        if (rec.ocr) {
          updateOcrFormat([rec.ocr]);
          addCircularRefsOcr([rec.ocr]);
          assembled.ocr[rec.i] = stagePage(rec.ocr);
        }
        if (assembled.session) {
          if (rec.nativeText !== undefined) assembled.session.nativeText[rec.i] = rec.nativeText;
          if (rec.fillShapes !== undefined) assembled.session.fillShapes[rec.i] = rec.fillShapes;
          if (rec.truth !== undefined) assembled.session.truth[rec.i] = rec.truth;
          if (rec.hocrSource !== undefined) assembled.session.hocrSource.pages[rec.i] = rec.hocrSource;
        }
      };

      // Decoding chunks to strings and joining them re-copies every record, which made large restores GC-bound.
      // Splitting on '\n' at the byte level is safe because that byte cannot appear inside a multi-byte UTF-8 character.
      /** @type {Uint8Array[]} Byte segments since the last completed line. */
      let pendingBytes = [];
      let pendingLen = 0;
      const applyLineBytes = (segTail) => {
        let recBytes = segTail;
        if (pendingLen) {
          recBytes = new Uint8Array(pendingLen + segTail.length);
          let off = 0;
          for (const p of pendingBytes) { recBytes.set(p, off); off += p.length; }
          recBytes.set(segTail, off);
          pendingBytes = [];
          pendingLen = 0;
        }
        const line = decoder.decode(recBytes);
        if (!assembled) applyHeader(line);
        else applyRecord(line);
      };
      const feedBytes = (chunk) => {
        let start = 0;
        let nl = chunk.indexOf(0x0A, start);
        while (nl !== -1) {
          applyLineBytes(chunk.subarray(start, nl));
          start = nl + 1;
          nl = chunk.indexOf(0x0A, start);
        }
        if (start < chunk.length) {
          const rest = chunk.subarray(start);
          pendingBytes.push(rest);
          pendingLen += rest.length;
        }
      };
      let part = await reader.read();
      while (!part.done) {
        feedBytes(part.value);
        part = await reader.read();
      }
      if (pendingLen) applyLineBytes(new Uint8Array(0));
      scribeRestoreObj = /** @type {ScribeSaveData} */ (assembled);
      segmentedNormalized = true;
    }
  }
  return { file: scribeRestoreObj, segmentedNormalized };
}

/**
 * Restore session data from a `.scribe` file or saved files into `doc`.
 * @param {ScribeDoc} doc
 * @param {Awaited<ReturnType<typeof readScribeFile>>} read
 * @param {'whole'|'docBlocks'|'pageRecords'} [part='whole']
 * @param {?{layer: ?string, pages: Array<?import('../containers/savedDoc.js').SavedPage>}} [records] - Pre-encoded saved-file pages to load into `layer`.
 *   `layer` is `null` when the document has no text.
 * @returns {Promise<{rotations: ?Array<number>, sourceIndices: ?Array<?number>, outline: ?Array<import('../objects/outlineObjects.js').OutlineNode>, angles: ?Array<?number>}>}
 *   `angles` holds per-page deskew angles from `.scribe` page records, or `null` when `part` is `'docBlocks'` or `records` is provided.
 */
async function restoreSession(doc, { file: scribeRestoreObj, segmentedNormalized }, part = 'whole', records = null) {
  const docBlocks = part !== 'pageRecords';
  const pageRecords = part !== 'docBlocks';
  if (part === 'whole' && scribeRestoreObj.fontState) {
    objectAssignDefined(doc.fonts.state, scribeRestoreObj.fontState);
    await doc.runOptimization().catch((err) => {
      if (err?.name === 'WorkerTerminatedError') throw err;
      doc.warningHandler({ message: `Font optimization failed, so the default fonts are used: ${err?.message || err}` });
    });
  }
  if (pageRecords && scribeRestoreObj.layoutRegions) {
    doc.layoutRegions.pages = addCircularRefsRegions(scribeRestoreObj.layoutRegions);
  }
  if (pageRecords && scribeRestoreObj.layoutDataTables) {
    addCircularRefsDataTables(scribeRestoreObj.layoutDataTables);
    doc.layoutDataTables.pages = scribeRestoreObj.layoutDataTables;
  }
  if (docBlocks && scribeRestoreObj.annotations) {
    // Older `.scribe` files hold a placed image as a row of the stamp annotation type, with an image and no source object.
    for (const page of scribeRestoreObj.annotations) {
      for (const a of /** @type {Array<{type: string, srcRef?: number, imageData?: unknown}>} */ (page || [])) {
        if (a && a.type === 'stamp' && a.srcRef == null && typeof a.imageData === 'string') a.type = 'scribeFillSignImage';
      }
    }
    doc.annotations.pages = scribeRestoreObj.annotations;
    doc.annotations.restored = true;
  }
  if (docBlocks && scribeRestoreObj.session) {
    if (scribeRestoreObj.session.contentEdits) doc.contentEdits.pages = scribeRestoreObj.session.contentEdits;
    if (scribeRestoreObj.session.editedAt != null) doc.sessionMarks.editedAt = scribeRestoreObj.session.editedAt;
    if (scribeRestoreObj.session.recognizedAt != null) doc.sessionMarks.recognizedAt = scribeRestoreObj.session.recognizedAt;
    if (scribeRestoreObj.session.fillText) markFillTextRefs(doc, scribeRestoreObj.session.fillText);
    if (Array.isArray(scribeRestoreObj.session.stampSources)) {
      doc.stampSources.pages = scribeRestoreObj.session.stampSources.map((p) => (p ? p.map(([srcRef, left, top, right, bottom]) => ({
        srcRef,
        bbox: {
          left, top, right, bottom,
        },
      })) : null));
    }
    if (scribeRestoreObj.session.tableExport) {
      doc.tableExport.excluded = { ...(scribeRestoreObj.session.tableExport.excluded || {}) };
      doc.tableExport.names = { ...(scribeRestoreObj.session.tableExport.names || {}) };
    }
    if (Array.isArray(scribeRestoreObj.session.assistantChats)) doc.assistantChats.chats = scribeRestoreObj.session.assistantChats;
    if (Array.isArray(scribeRestoreObj.session.redactions?.terms)) {
      doc.redactions = {
        terms: scribeRestoreObj.session.redactions.terms,
        matchCase: !!scribeRestoreObj.session.redactions.matchCase,
        scannedAt: scribeRestoreObj.session.redactions.scannedAt ?? null,
      };
    }
  }
  if (pageRecords && scribeRestoreObj.session) {
    if (Array.isArray(scribeRestoreObj.session.type3GlyphMappings)) {
      for (const [hash, text] of scribeRestoreObj.session.type3GlyphMappings) doc.type3GlyphMappings.set(hash, text);
    }
    if (scribeRestoreObj.session.nativeText) {
      for (let i = 0; i < scribeRestoreObj.session.nativeText.length; i++) {
        const nt = scribeRestoreObj.session.nativeText[i];
        if (!nt) continue;
        // A fresh restore has no existing entry to merge into.
        // Rebuilding these per-word dictionaries via spread anyway costs seconds on multi-thousand-page documents.
        const existing = doc.nativeText.pages[i];
        doc.nativeText.pages[i] = existing && Object.keys(existing).length ? { ...existing, ...nt } : nt;
      }
    }
    if (scribeRestoreObj.session.truth) {
      for (let i = 0; i < scribeRestoreObj.session.truth.length; i++) doc.truth.pages[i] = scribeRestoreObj.session.truth[i] ?? null;
    }
    if (scribeRestoreObj.session.hocrSource) {
      if (scribeRestoreObj.session.hocrSource.head) doc.hocrSource.head['User Upload'] = scribeRestoreObj.session.hocrSource.head;
      const pages = scribeRestoreObj.session.hocrSource.pages || [];
      for (let i = 0; i < pages.length; i++) if (pages[i]) doc.hocrSource.pages[i] = { 'User Upload': holdJson(pages[i]) };
    }
    if (scribeRestoreObj.session.fillShapes) {
      const site = (/** @type {Array<number>} */ t) => ({
        left: t[0], top: t[1], right: t[2], bottom: t[3],
      });
      for (let i = 0; i < scribeRestoreObj.session.fillShapes.length; i++) {
        const enc = scribeRestoreObj.session.fillShapes[i];
        if (!enc) continue;
        /** @type {PageFillShapes} */
        const shapes = {};
        if (enc.i) shapes.images = enc.i.map((t) => ({ ...site(t), sites: t[4].map((st) => ({ ...site(st), ...(st[4] !== -1 ? { objNum: st[4] } : {}) })) }));
        if (enc.p) shapes.paths = enc.p.map((t) => ({ ...site(t), sites: t[4].map((st) => ({ ...site(st), paint: st[4], commands: st[5] })) }));
        if (enc.q) shapes.squares = enc.q.map((t) => ({ ...site(t), stroke: !!t[4] }));
        if (enc.m) shapes.marks = enc.m.map(site);
        if (enc.g) shapes.glyphBoxes = enc.g.map((t) => ({ id: t[0], bbox: site(t.slice(1)) }));
        if (enc.pi) shapes.pathsIneligible = true;
        if (enc.mo) shapes.marksOverflow = true;
        doc.fillShapes.pages[i] = shapes;
      }
    }
  }

  // `.inputData` added to .scribe in June 2026, do not assume this field exists for re-imports.
  // This line also skips when `inputData` has already been calculated for the active session, which is presumed more accurate.
  if (docBlocks && scribeRestoreObj.inputData) {
    if (doc.inputData.pdfType == null && scribeRestoreObj.inputData.pdfType) {
      doc.inputData.pdfType = scribeRestoreObj.inputData.pdfType;
    }
    if (doc.inputData.pageStats == null && scribeRestoreObj.inputData.pageStats) {
      doc.inputData.pageStats = scribeRestoreObj.inputData.pageStats;
      doc.inputData.requiresOCR = !!scribeRestoreObj.inputData.requiresOCR;
    }
    // A document that was never recognized saves null here, so leave it null rather than filling in a default.
    if (doc.inputData.ocrApplied == null && scribeRestoreObj.inputData.ocrApplied) {
      doc.inputData.ocrApplied = scribeRestoreObj.inputData.ocrApplied;
    }
  }

  const savedRotations = scribeRestoreObj.pageRotations ?? null;
  const savedSourceIndices = scribeRestoreObj.session?.pageSourceIndices ?? null;
  /** @type {?Array<?number>} */
  let savedAngles = null;
  if (pageRecords && records) {
    const { layer } = records;
    if (layer !== null) {
      doc.pageStore.add(layer, records.pages.length);
      records.pages.forEach((page, i) => {
        doc.inputData.xmlMode[i] = true;
        if (!page) return;
        doc.pageStore.setRecords(i, layer, page.record, page.detail, page.flags, page.counts);
        if (page.order) doc.pageStore.setDetailOrder(i, layer, page.order);
        if (doc.pageMetrics[i]) doc.pageMetrics[i].angle = page.angle;
      });
      doc.pageStore.active = layer;
    }
  } else if (pageRecords) {
    const pages = scribeRestoreObj.ocr;
    if (!segmentedNormalized) {
      updateOcrFormat(pages);
      addCircularRefsOcr(pages);
    }

    doc.pageStore.add('User Upload', pages.length);
    savedAngles = [];
    let lineNumMissing = false;
    for (let i = 0; i < pages.length; i++) {
      const read = /** @type {?OcrPage|StagedPage} */ (pages[i]);
      const staged = read && 'snap' in read ? read : stagePage(read || new OcrPage(i, { height: 1920, width: 1080 }));
      pages[i] = null;
      doc.inputData.xmlMode[i] = true;
      if (part === 'whole') {
        doc.pageMetrics[i] = new PageMetrics(staged.dims);
        doc.pageMetrics[i].angle = staged.angle;
        doc.pageMetrics[i].rotation = savedRotations?.[i] || 0;
        doc.pageMetrics[i].sourcePageN = savedSourceIndices?.[i] ?? null;
      } else if (doc.pageMetrics[i]) {
        // The pages were arranged when the document opened, so the deskew angle is all the page records add.
        doc.pageMetrics[i].angle = staged.angle;
      }
      if (staged.lineNumMissing) lineNumMissing = true;
      savedAngles[i] = staged.angle;
      doc.pageStore.setSnapshot(i, 'User Upload', staged.snap);
    }
    // A saved line with no number holds null, so only a file from before these fields has `lineNum` undefined.
    if (lineNumMissing) await assignLayerLineNums(doc.pageStore, 'User Upload');
    doc.pageStore.active = 'User Upload';
  }
  if (part === 'pageRecords' && scribeRestoreObj.fontState) {
    objectAssignDefined(doc.fonts.state, scribeRestoreObj.fontState);
    // The PDF is already open, so evaluating would re-score the fonts against the pages and overwrite the saved default fonts.
    await runOptimization(doc, 'active', false).catch((err) => {
      if (err?.name === 'WorkerTerminatedError') throw err;
      doc.warningHandler({ message: `Font optimization failed, so the default fonts are used: ${err?.message || err}` });
    });
  }

  // The caller applies `outline` after the PDF loads, since openMainPDF's parse of the source /Outlines would otherwise clobber it.
  // A returned `null` (key absent) means a pre-outline .scribe, so the PDF's own bookmarks win; `[]` means the session deliberately had none.
  return {
    rotations: savedRotations,
    sourceIndices: savedSourceIndices,
    outline: 'outline' in scribeRestoreObj ? (scribeRestoreObj.outline || []) : null,
    angles: savedAngles,
  };
}

/**
 * An object with this shape can be used to provide input to the `importFiles` function,
 * without needing that function to figure out the file types.
 * This is required when using ArrayBuffer inputs.
 * @public
 * @typedef {Object} SortedInputFiles
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [pdfFiles]
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [imageFiles]
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [ocrFiles]
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [scribeFiles]
 */

/**
 * Import files into `doc`.
 * @param {ScribeDoc} doc
 * @param {Array<File>|FileList|Array<string>|SortedInputFiles} files - Flat inputs are sorted by extension, with strings treated as URLs in browsers and file paths in Node.js.
 * @param {Object} [options]
 * @param {typeof import('../containers/scribeDoc.js').ScribeDoc.defaults.usePDFText} [options.usePDFText]
 * @param {boolean} [options.keepPDFTextAlways]
 * @param {boolean} [options.skipFontOpt]
 * @param {boolean} [options.usePdfSharedBuffer]
 * @param {number} [options.pdfWorkerN] - Fixed PDF worker-pool size for this document.
 * @param {'width' | 'sentence'} [options.docxLineSplitMode]
 * @param {boolean} [options.deferText] - For PDF inputs, resolve once renderable and run text extraction in the background behind `doc.textReady`.
 * @param {Promise<unknown>} [options.textStart] - With `deferText`, wait for this promise to settle before starting background text extraction.
 * @param {() => void} [options.onProgress] - Internal callback fired after each page parse, OCR conversion, or layout chunk.
 * @param {SavedOpen} [options.saved] - Internal option to open a single PDF from document-library saved files.
 *   Restores page order, annotations, and bookmarks before resolving, then loads page text in the background behind `doc.textReady`.
 */
export async function importFiles(doc, files, options = {}) {
  const usePDFText = options.usePDFText ?? scribeDocDefaults.usePDFText;
  const keepPDFTextAlways = options.keepPDFTextAlways ?? scribeDocDefaults.keepPDFTextAlways;
  const skipFontOpt = options.skipFontOpt ?? scribeDocDefaults.skipFontOpt;
  const usePdfSharedBuffer = options.usePdfSharedBuffer ?? opt.usePdfSharedBuffer;
  const docxLineSplitMode = options.docxLineSplitMode ?? scribeDocDefaults.docxLineSplitMode;
  const deferText = options.deferText ?? false;
  if (!files) throw new Error('No files provided.');

  // Wait for any in-flight extraction before clearing, so its workers don't write stale pages into the new document.
  // A held-back extraction has nothing in flight and would never settle on its own, so it is settled here.
  if (doc._textStartPending) doc._textReadySettle?.();
  await doc.textReady;

  await doc.clear();
  // Pre-warm the general worker pool, except with `opt.inProcess`.
  if (!opt.inProcess) gs.getGeneralScheduler();

  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let pdfFiles = [];
  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let imageFiles = [];
  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let ocrFiles = [];
  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let scribeFiles = [];
  // These statements contain many ts-ignore comments, because the TypeScript interpreter apparently cannot properly narrow arrays.
  // See: https://github.com/microsoft/TypeScript/issues/42384
  if ('pdfFiles' in files || 'imageFiles' in files || 'ocrFiles' in files || 'scribeFiles' in files) {
    if (files.pdfFiles && files.pdfFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      pdfFiles = files.pdfFiles;
    } else if (files.pdfFiles) {
      // @ts-ignore
      pdfFiles = await standardizeFiles(files.pdfFiles);
    }
    if (files.imageFiles && files.imageFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      imageFiles = files.imageFiles;
    } else if (files.imageFiles) {
      // @ts-ignore
      imageFiles = await standardizeFiles(files.imageFiles);
    }
    if (files.ocrFiles && files.ocrFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      ocrFiles = files.ocrFiles;
    } else if (files.ocrFiles) {
      // @ts-ignore
      ocrFiles = await standardizeFiles(files.ocrFiles);
    }
    if (files.scribeFiles && files.scribeFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      scribeFiles = files.scribeFiles;
    } else if (files.scribeFiles) {
      // @ts-ignore
      scribeFiles = await standardizeFiles(files.scribeFiles);
    }
  } else {
    // @ts-ignore
    const filesStand = await standardizeFiles(files);
    if (files[0] instanceof ArrayBuffer) throw new Error('ArrayBuffer inputs must be sorted by file type.');
    ({
      pdfFiles, imageFiles, ocrFiles, scribeFiles,
    } = await sortInputFiles(filesStand));
  }

  if (pdfFiles.length === 0 && imageFiles.length === 0 && ocrFiles.length === 0 && scribeFiles.length === 0) {
    const errorText = 'No supported files found.';
    doc.errorHandler({ message: errorText });
    return;
  } if (pdfFiles.length > 0 && imageFiles.length > 0) {
    const errorText = 'PDF and image files cannot be imported together. Only first PDF file will be imported.';
    doc.warningHandler({ message: errorText });
    pdfFiles.length = 1;
    imageFiles.length = 0;
  } else if (pdfFiles.length > 1) {
    const errorText = 'Multiple PDF files are not supported. Only first PDF file will be imported.';
    doc.warningHandler({ message: errorText });
    pdfFiles.length = 1;
    imageFiles.length = 0;
  }

  if (pdfFiles[0] && !(pdfFiles[0] instanceof ArrayBuffer)) {
    doc.inputData.inputFileNames = [pdfFiles[0].name];
  } else if (imageFiles[0] && !(imageFiles[0] instanceof ArrayBuffer)) {
    // @ts-ignore
    doc.inputData.inputFileNames = imageFiles.map((x) => x.name);
  }

  // Set default download name
  if (pdfFiles.length > 0 && 'name' in pdfFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${pdfFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (imageFiles.length > 0 && 'name' in imageFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${imageFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (ocrFiles.length > 0 && 'name' in ocrFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${ocrFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (scribeFiles.length > 0 && 'name' in scribeFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${scribeFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  }

  doc.inputData.pdfMode = pdfFiles.length === 1;
  doc.inputData.imageMode = !!(imageFiles.length > 0 && !doc.inputData.pdfMode);
  doc.images.inputModes.image = !!(imageFiles.length > 0 && !doc.inputData.pdfMode);

  /** @type {number[]|null} */
  let restoredRotations = null;
  /** @type {Array<?number>|null} */
  let restoredSourceIndices = null;
  /** @type {Array<import('../objects/outlineObjects.js').OutlineNode>|null} */
  let restoredOutline = null;
  /** @type {?Array<?number>} */
  let restoredAngles = null;
  if (options.saved && (pdfFiles.length !== 1 || imageFiles.length > 0 || ocrFiles.length > 0 || scribeFiles.length > 0)) {
    throw new Error('A document opens from its saved files with its PDF alone.');
  }
  const saved = options.saved ? await openSavedDoc(options.saved.records, options.saved.work ?? null) : null;
  if (scribeFiles[0] || saved) {
    // Clone saved.blocks so in-place document edits do not mutate the baseline blocks that the next incremental save diffs against.
    const restoreRes = saved
      ? await restoreSession(doc, { file: structuredClone(saved.blocks), segmentedNormalized: true }, 'docBlocks')
      : await restoreSession(doc, await readScribeFile(scribeFiles[0]));
    restoredRotations = restoreRes.rotations;
    restoredSourceIndices = restoreRes.sourceIndices;
    restoredOutline = restoreRes.outline;
    restoredAngles = restoreRes.angles;
  }

  const xmlModeImport = ocrFiles.length > 0;

  let pageCount;
  let pageCountImage;
  /** @type {TextSource} */
  let format;

  if (doc.inputData.pdfMode) {
    // If no XML data is provided, page sizes are calculated using muPDF alone
    await doc.images.openMainPDF(pdfFiles[0], { usePdfSharedBuffer, pdfWorkerN: options.pdfWorkerN });

    pageCountImage = doc.images.pageCount;
    doc.images.loadCount = doc.images.pageCount;
  } else if (doc.inputData.imageMode) {
    pageCountImage = imageFiles.length;
  }

  const oemName = 'User Upload';
  let pdfTextExtracted = false;
  if (xmlModeImport) {
    doc.pageStore.add(oemName, doc.inputData.pageCount);
    doc.pageStore.active = oemName;

    const ocrData = await importOCRFiles(Array.from(ocrFiles));

    format = /** @type {("hocr" | "abbyy" | "alto" | "stext" | "textract" | "text")} */ (ocrData.format);

    // The text import functions require built-in fonts to be loaded, and run in a general worker.
    // The pool is started first because fonts reach workers only as they load, so a pool created afterwards, as `opt.inProcess` does by skipping the pre-warm above, would have none.
    if (['text', 'docx', 'md'].includes(format)) {
      await gs.getGeneralScheduler();
      await loadBuiltInFontsRaw();
    }

    doc.ocrRaw.active = ocrData.hocrRaw;
    // Textract, Google Document AI and Azure Document Intelligence data come in document-level or arbitrary chunks, so the array length says nothing about their page count.
    // Text, Markdown and DOCX inputs have no pages of their own.
    const pagedOcr = !['textract', 'google_doc_ai', 'azure_doc_intel', 'text', 'docx', 'md'].includes(format);
    if (pageCountImage && pagedOcr && doc.ocrRaw.active.length !== pageCountImage) {
      const ocrRawAll = doc.ocrRaw.active;
      const ocrPageCount = ocrRawAll.length;
      const mismatch = `The OCR file has ${ocrPageCount} page${ocrPageCount === 1 ? '' : 's'} but the ${doc.inputData.pdfMode ? 'PDF' : 'image input'} has ${pageCountImage}`;
      // Archive.org's ABBYY and hOCR files include scan leaves (insert cards, blank leaves, plates) that the item's PDF omits, at varying positions.
      // Neither truncation nor a constant offset lines such a file up, and a wrong guess silently puts every page's text on the wrong page.
      let reason = doc.inputData.pdfMode ? '' : 'only a PDF text layer can match OCR pages to pages';
      /** @type {?Int32Array} The OCR page of each page, -1 where none belongs. */
      let pageMap = null;
      /** @type {string[]} */
      let ocrTexts = [];
      if (!reason) {
        await extractInternalPDFText(doc, {
          usePDFText, keepPDFTextAlways, supplemental: true, onProgress: options.onProgress,
        });
        pdfTextExtracted = true;
        const normText = (/** @type {string} */ s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const pdfTexts = Array.from({ length: pageCountImage }, (_, i) => {
          const page = doc.getPage(i, { layer: 'pdf' });
          return page ? normText(ocr.getPageText(page)) : '';
        });
        ocrTexts = ocrRawAll.map((str) => {
          let text;
          if (format === 'alto') {
            text = (str.match(/CONTENT=(?:"[^"]*"|'[^']*')/g) || []).map((m) => m.slice(9, -1)).join(' ');
          } else if (format === 'stext') {
            text = (str.match(/\bc=(?:"[^"]*"|'[^']*')/g) || []).map((m) => m.slice(3, -1)).join('');
          } else if (format === 'google_vision') {
            try { text = JSON.parse(str).fullTextAnnotation?.text || ''; } catch { text = ''; }
          } else {
            text = str.replace(/<[^>]*>/g, ' ');
          }
          return normText(text.replace(/&[^;\s]{1,8};/g, ''));
        });
        const shinglesOf = (/** @type {string} */ t) => {
          const set = new Set();
          if (t.length < 16) return set;
          for (let i = 0; i + 8 <= t.length; i++) {
            let h = 2166136261;
            for (let c = i; c < i + 8; c++) h = Math.imul(h ^ t.charCodeAt(c), 16777619);
            set.add(h >>> 0);
          }
          return set;
        };
        const pdfSh = pdfTexts.map(shinglesOf);
        const ocrSh = ocrTexts.map(shinglesOf);
        const M = pageCountImage;
        const N = ocrPageCount;
        /** @type {Map<number, number[]>} */
        const postings = new Map();
        for (let j = 0; j < N; j++) {
          for (const h of ocrSh[j]) {
            const list = postings.get(h);
            if (list) list.push(j); else postings.set(h, [j]);
          }
        }
        const sim = new Float32Array(M * N);
        const counts = new Int32Array(N);
        for (let i = 0; i < M; i++) {
          if (!pdfSh[i].size) continue;
          counts.fill(0);
          for (const h of pdfSh[i]) {
            const list = postings.get(h);
            if (list) for (const j of list) counts[j]++;
          }
          for (let j = 0; j < N; j++) {
            // Dividing by the larger fingerprint stops a page whose text is only a fragment of another page's, such as a running head, from matching that page.
            const s = counts[j] / Math.max(pdfSh[i].size, ocrSh[j].size);
            if (s >= 0.5) sim[i * N + j] = s;
          }
        }
        // Order-preserving matching that maximizes total similarity (a weighted longest common subsequence).
        // Backpointers: 1 pairs the two pages, 2 skips the page, 3 skips the OCR page.
        const W = N + 1;
        const score = new Float64Array((M + 1) * W);
        const step = new Uint8Array((M + 1) * W);
        for (let i = 1; i <= M; i++) {
          for (let j = 1; j <= N; j++) {
            const s = sim[(i - 1) * N + (j - 1)];
            let best = score[(i - 1) * W + j];
            let from = 2;
            if (score[i * W + (j - 1)] > best) {
              best = score[i * W + (j - 1)];
              from = 3;
            }
            if (s > 0 && score[(i - 1) * W + (j - 1)] + s > best) {
              best = score[(i - 1) * W + (j - 1)] + s;
              from = 1;
            }
            score[i * W + j] = best;
            step[i * W + j] = from;
          }
        }
        pageMap = new Int32Array(M).fill(-1);
        let anchors = 0;
        for (let i = M, j = N; i > 0 && j > 0;) {
          const from = step[i * W + j];
          if (from === 1) {
            pageMap[i - 1] = j - 1;
            anchors++;
            i--;
            j--;
          } else if (from === 2) {
            i--;
          } else {
            j--;
          }
        }
        // The bar rejects another document's OCR file, which matches a page or two at most, and a partial file, which matches only its share of the pages.
        const textPages = pdfTexts.filter((t) => t.length >= 16).length;
        if (anchors < 2 || anchors < 0.9 * textPages) {
          reason = `only ${anchors} of the ${textPages} PDF pages with text matched an OCR page`;
          pageMap = null;
        } else {
          // Between two matched pairs, an equal number of unmatched pages on each side (blank leaves, plates) pair up in order.
          let prevPage = -1;
          let prevOcr = -1;
          for (let i = 0; i <= M; i++) {
            if (i < M && pageMap[i] < 0) continue;
            const curOcr = i < M ? pageMap[i] : N;
            if (i - prevPage === curOcr - prevOcr) for (let d = 1; d < i - prevPage; d++) pageMap[prevPage + d] = prevOcr + d;
            prevPage = i;
            prevOcr = curOcr;
          }
        }
      }
      if (!pageMap) {
        const err = /** @type {Error & {ocrPages: number, pageCount: number}} */ (new Error(`${mismatch}, and the pages could not be matched (${reason}), so the OCR was not imported.`));
        err.name = 'OcrPageMismatchError';
        err.ocrPages = ocrPageCount;
        err.pageCount = pageCountImage;
        throw err;
      }
      const used = new Uint8Array(ocrPageCount);
      for (let i = 0; i < pageCountImage; i++) if (pageMap[i] >= 0) used[pageMap[i]] = 1;
      const droppedWithText = [];
      for (let j = 0; j < ocrPageCount; j++) if (!used[j] && ocrTexts[j].length >= 16) droppedWithText.push(j);
      const pagesWithoutOcr = [];
      for (let i = 0; i < pageCountImage; i++) if (pageMap[i] < 0) pagesWithoutOcr.push(i);
      const matched = pageCountImage - pagesWithoutOcr.length;
      doc.inputData.ocrPageMatch = {
        ocrPages: ocrPageCount, matched, droppedWithText, pagesWithoutOcr,
      };
      const listPages = (/** @type {number[]} */ arr) => arr.slice(0, 12).map((i) => i + 1).join(', ') + (arr.length > 12 ? ', …' : '');
      const droppedNote = droppedWithText.length ? `, ${droppedWithText.length} of them carrying text (OCR pages ${listPages(droppedWithText)})` : '';
      const withoutNote = pagesWithoutOcr.length ? `; ${pagesWithoutOcr.length} pages have no OCR page (pages ${listPages(pagesWithoutOcr)})` : '';
      doc.warningHandler({ message: `${mismatch}. ${matched} OCR pages were matched to pages by their text; ${ocrPageCount - matched} were not used${droppedNote}${withoutNote}.` });
      doc.ocrRaw.active = Array.from(pageMap, (j) => (j >= 0 ? ocrRawAll[j] : null));
    }

    format = /** @type {("hocr" | "abbyy" | "alto" | "stext" | "textract" | "text")} */ (ocrData.format);
    if (format === 'hocr' && ocrData.hocrHead) doc.hocrSource.head[oemName] = ocrData.hocrHead;
  }

  const pageCountOcr = doc.ocrRaw.active?.length ? countOcrPages(format, doc.ocrRaw.active) : doc.pageStore.slotCount();

  if (xmlModeImport && (doc.inputData.imageMode || doc.inputData.pdfMode)) {
    if (pageCountImage !== pageCountOcr) {
      const warningHTML = `Page mismatch detected. Image data has ${pageCountImage} pages while OCR data has ${pageCountOcr} pages.`;
      doc.warningHandler({ message: warningHTML });
    }
  }

  doc.inputData.pageCount = pageCountImage ?? pageCountOcr;
  // A session whose pages were deleted or moved has its own page count, not the source file's.
  if (restoredSourceIndices?.some((s) => s != null)) doc.inputData.pageCount = restoredSourceIndices.length;

  // OCR imported from external files (.hocr/.xml/Textract/etc.) becomes the active layer for every page,
  // so mark each page OCR-applied for the export flatten gate (a category-flagged page flattens iff OCR was applied to it).
  // Skip if a .scribe restore already set an explicit array.
  if (xmlModeImport && doc.inputData.ocrApplied == null) {
    doc.inputData.ocrApplied = Array(doc.inputData.pageCount).fill(true);
  }

  doc.ocrRaw.active = doc.ocrRaw.active || Array(pageCount);

  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.layoutRegions.pages[i]) {
      doc.layoutRegions.pages[i] = new LayoutPage(i);
    }
  }

  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.layoutDataTables.pages[i]) {
      doc.layoutDataTables.pages[i] = new LayoutDataTablePage(i);
    }
  }

  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.annotations.pages[i]) {
      doc.annotations.pages[i] = [];
    }
  }

  // Full-length so page insert/delete splice these arrays in lockstep (spliceFull skips short arrays).
  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.contentEdits.pages[i]) {
      doc.contentEdits.pages[i] = [];
    }
    // A page the `pdf` layer holds keeps these in its records, and reading them here would bring every page into memory.
    if (!doc.pageStore.hasPage(i, 'pdf')) {
      if (!doc.nativeText.pages[i]) {
        doc.nativeText.pages[i] = {};
      }
      if (doc.fillShapes.pages[i] === undefined) {
        doc.fillShapes.pages[i] = null;
      }
    }
    if (doc.truth.pages[i] === undefined) {
      doc.truth.pages[i] = null;
    }
    if (doc.hocrSource.pages[i] === undefined) {
      doc.hocrSource.pages[i] = null;
    }
  }

  // Render first page for PDF only
  if (doc.inputData.pdfMode && !xmlModeImport) {
    doc.progressHandler({ n: 0, type: 'importPDF', info: { } });
  }

  if (doc.inputData.imageMode) {
    doc.images.pageCount = imageFiles.length;
    for (let i = 0; i < imageFiles.length; i++) {
      doc.images.nativeSrc[i] = await importImageFileToBase64(imageFiles[i]).then(async (imgStr) => {
        const imgWrapper = new ImageWrapper(i, imgStr, 'native', false, false);
        const imageDims = await imageUtils.getDims(imgWrapper);
        doc.pageMetrics[i] = new PageMetrics(imageDims);
        return imgWrapper;
      });
      doc.images.loadCount++;
      doc.progressHandler({ n: i, type: 'importImage', info: { } });
    }
  }

  // Re-apply page angles from .scribe data after PDF/image loading overwrites pageMetrics.
  // The PDF/image loading creates new PageMetrics with correct dimensions but angle=null.
  if (scribeFiles[0] || saved) {
    // The source load builds its per-page arrays in source order, so a session whose pages were deleted or moved is put back in its own order.
    if (restoredSourceIndices?.some((s) => s != null)) {
      const order = restoredSourceIndices.map((s, i) => s ?? i);
      const sourceMetrics = doc.pageMetrics.slice();
      const sourceDims = doc.images.pdfDims300.slice();
      const sourceImages = doc.images.nativeSrc.slice();
      if (order.every((s) => s >= 0 && s < sourceMetrics.length)) {
        doc.pageMetrics.length = 0;
        if (sourceDims.length) doc.images.pdfDims300.length = 0;
        if (sourceImages.length) doc.images.nativeSrc.length = 0;
        order.forEach((s, i) => {
          doc.pageMetrics[i] = new PageMetrics(sourceMetrics[s].dims);
          doc.pageMetrics[i].sourcePageN = s;
          if (sourceDims.length) doc.images.pdfDims300[i] = sourceDims[s];
          if (sourceImages.length) doc.images.nativeSrc[i] = sourceImages[s];
        });
        doc.inputData.pageCount = order.length;
        doc.images.pageCount = order.length;
        doc.images.loadCount = order.length;
      } else {
        doc.warningHandler({ message: 'The session refers to pages the source file does not have, so the source page order is kept.' });
      }
    }
    // An image document with no text has an empty text layer, so the page count bounds this loop.
    for (let i = 0; i < doc.pageMetrics.length; i++) {
      const angle = restoredAngles?.[i];
      if (angle != null) doc.pageMetrics[i].angle = angle;
      if (restoredRotations?.[i]) {
        doc.pageMetrics[i].rotation = restoredRotations[i];
      }
    }
    // Re-apply the session's saved bookmarks, overriding those the PDF load parsed from the source's own /Outlines.
    if (restoredOutline != null) {
      doc.outline.length = 0;
      for (const n of reassignOutlineIds(restoredOutline)) doc.outline.push(n);
    }
  }

  if (saved) {
    const { pageDims, onError } = /** @type {SavedOpen} */ (options.saved);
    if (pageDims?.length === doc.pageMetrics.length) {
      pageDims.forEach(([width, height], i) => { doc.pageMetrics[i].dims = { width, height }; });
    }
    if (saved.slots.length !== (saved.layer === null ? 0 : doc.inputData.pageCount)) throw new Error('The saved files do not hold the pages this document has.');
    doc._textMissing = true;
    if (options.saved.text === false) return;
    doc.textReady = new Promise((resolve) => {
      const settle = () => resolve(null);
      doc._textReadySettle = settle;
      (async () => {
        /** @type {Array<?import('../containers/savedDoc.js').SavedPage>} */
        const pages = [];
        for (let from = 0; from < saved.slots.length; from += 64) {
          pages.push(...await saved.read(from, Math.min(saved.slots.length, from + 64), true));
          if (doc._textReadySettle !== settle) return null;
        }
        // Load built-in fonts before restoreSession activates the text layer so getFont callers never see GlobalFonts.raw uninitialized.
        await loadBuiltInFontsRaw();
        if (doc._textReadySettle !== settle) return null;
        const file = structuredClone(saved.blocks);
        if (saved.layer !== null) {
          file.session.nativeText = pages.map((page) => page?.extras?.nativeText ?? null);
          file.session.fillShapes = pages.map((page) => page?.extras?.fillShapes ?? null);
          if (pages.some((page) => page?.extras?.truth)) file.session.truth = pages.map((page) => page?.extras?.truth ?? null);
          file.session.hocrSource = { head: file.session.hocrSourceHead ?? null, pages: pages.map((page) => page?.extras?.hocrSource ?? null) };
        }
        doc.tableLinkSuggestions = file.tableLinks ?? [];
        await restoreSession(doc, { file, segmentedNormalized: true }, 'pageRecords', { layer: saved.layer, pages });
        if (doc._textReadySettle !== settle) return null;
        /** @type {Map<import('../containers/pageStore.js').HeldRecord, number|string>} */
        const keyOf = new Map();
        saved.slots.forEach((slot, n) => {
          const held = slot && saved.layer !== null ? doc.pageStore.cleanRecord(n, saved.layer) : null;
          if (slot && held) keyOf.set(held, slot.key);
        });
        doc._saved = {
          layer: saved.layer, keys: saved.slots.map((slot) => (slot ? slot.key : null)), keyOf, baseBlocks: saved.baseBlocks, basePages: saved.basePages,
        };
        doc._textMissing = false;
        for (const [row, { n, swept }] of doc._liftsOwed.fillText) {
          const placed = (doc.annotations.pages[n] || []).includes(row);
          const contents = row.contents;
          if (!placed) row.contents = '';
          for (const bbox of swept) syncFillText(doc, n, row, bbox);
          row.contents = contents;
        }
        const recording = doc.docHistory.suspended;
        doc.docHistory.suspended = true;
        try {
          for (const [name, value] of doc._liftsOwed.formValues) setFormValue(doc, name, value);
        } finally {
          doc.docHistory.suspended = recording;
        }
        doc._liftsOwed = { fillText: new Map(), formValues: new Map() };
        return { type: doc.inputData.pdfType };
      })().then(
        (res) => {
          if (doc._textReadySettle !== settle) return;
          doc._textReadySettle = null;
          resolve(res);
        },
        (err) => {
          if (doc._textReadySettle !== settle) return;
          doc._textReadySettle = null;
          if (onError) onError(err);
          else doc.errorHandler({ message: `The document's saved text could not be read: ${err instanceof Error ? err.message : err}` });
          resolve(null);
        },
      );
    });
    return;
  }

  if (xmlModeImport) {
    // Process OCR using web worker, reading from file first if that has not been done already
    const reported = doc.progressHandler;
    // Each converted page reports itself to the document's handler, which is how a host watching the import hears of it.
    if (options.onProgress) {
      const onProgress = options.onProgress;
      doc.progressHandler = (msg) => {
        onProgress();
        reported(msg);
      };
    }
    try {
      await convertOCR(doc, doc.ocrRaw.active, true, format, oemName, doc.pageMetrics, { docxLineSplitMode });
    } finally {
      doc.progressHandler = reported;
    }
    if (!scribeDocDefaults.keepRawData) doc.ocrRaw.active = Array(doc.ocrRaw.active.length);

    const pagesWithoutOcr = doc.inputData.ocrPageMatch?.pagesWithoutOcr;
    if (pagesWithoutOcr?.length && doc.images.pdfDims300) {
      const ratios = [];
      for (let n = 0; n < doc.inputData.pageCount; n++) {
        const width = doc.getPage(n)?.dims?.width;
        if (width && doc.images.pdfDims300[n]?.width) ratios.push(width / doc.images.pdfDims300[n].width);
      }
      ratios.sort((a, b) => a - b);
      const ratio = ratios[Math.floor(ratios.length / 2)] || 1;
      for (const n of pagesWithoutOcr) {
        if (doc.images.pdfDims300[n] && doc.pageMetrics[n]) {
          doc.pageMetrics[n].dims = { width: doc.images.pdfDims300[n].width * ratio, height: doc.images.pdfDims300[n].height * ratio };
        }
        // Per-page consumers expect a page object at every index, so a page without an OCR page gets an empty one.
        if (doc.pageMetrics[n]) doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), oemName);
      }
    }

    if (!skipFontOpt && !['stext', 'textract', 'google_vision', 'google_doc_ai', 'azure_doc_intel'].includes(format)) {
      await checkCharWarn(doc, doc.convertPageWarn);
      const charMetrics = await calcCharMetricsLayer(doc.pageStore, 'active');

      if (Object.keys(charMetrics).length > 0) {
        clearObjectProperties(doc.fonts.state.charMetrics);
        Object.assign(doc.fonts.state.charMetrics, charMetrics);
      }
      await doc.runOptimization().catch((err) => {
        if (err?.name === 'WorkerTerminatedError') throw err;
        doc.warningHandler({ message: `Font optimization failed, so the default fonts are used: ${err?.message || err}` });
      });
    }
    await assignLayerLineNums(doc.pageStore, oemName);
  }

  // A PDF still needs parsing when an OCR file accompanies it.
  if (!scribeFiles[0] && !pdfTextExtracted && doc.inputData.pdfMode && (usePDFText.native.main || usePDFText.native.supp || usePDFText.ocr.main || usePDFText.ocr.supp || keepPDFTextAlways)) {
    const extractOptions = {
      usePDFText, keepPDFTextAlways, supplemental: xmlModeImport, onProgress: options.onProgress,
    };
    if (deferText) {
      doc.textReady = new Promise((resolve) => {
        const settle = () => resolve(null);
        doc._textReadySettle = settle;
        doc._textStartPending = !!options.textStart;
        const begin = options.textStart ? Promise.resolve(options.textStart).catch(() => {}) : Promise.resolve();
        begin.then(() => {
          doc._textStartPending = false;
          // A clear or terminate settled this import while the host still held extraction back, so nothing runs on the cleared document.
          if (doc._textReadySettle !== settle) return;
          extractInternalPDFText(doc, extractOptions).then(
            (res) => {
              doc._textReadySettle = null;
              resolve(res);
            },
            (err) => {
              doc._textReadySettle = null;
              console.error('Deferred PDF text extraction failed:', err);
              resolve(null);
            },
          );
        });
      });
    } else {
      await extractInternalPDFText(doc, extractOptions);
    }
  }
}

/**
 * Saved files and options for reopening a document.
 * @typedef {Object} SavedOpen
 * @property {Blob} records - Base records file written at initial ingest.
 * @property {?Blob} [work] - Incremental work file holding edits saved since ingest.
 * @property {Array<[number, number]>} [pageDims] - Saved per-page `[width, height]` overrides for documents whose page dimensions came from an OCR file.
 * @property {boolean} [text=true] - When false, opens the PDF render-only without loading saved page text.
 * @property {(err: unknown) => void} [onError] - Called if background saved-text loading fails, overriding `doc.errorHandler`.
 */

/**
 * Import supplemental OCR files into this document, such as an alternate OCR version or ground truth data.
 * This function should not be used to import the main OCR files.
 * @param {ScribeDoc} doc
 * @param {Array<File>|FileList|Array<string>} files
 * @param {string} ocrName - Name of the OCR version (e.g. "Ground Truth")
 */
export async function importFilesSupp(doc, files, ocrName) {
  if (!files || files.length === 0) return;

  doc.pageStore.add(ocrName, doc.inputData.pageCount);

  const curFiles = await standardizeFiles(files);

  /** @type {Array<File|FileNode>} */
  const ocrFilesAll = [];
  for (let i = 0; i < curFiles.length; i++) ocrFilesAll.push(curFiles[i]);

  ocrFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));

  const ocrData = await importOCRFiles(ocrFilesAll);

  const pageCountHOCR = countOcrPages(ocrData.format, ocrData.hocrRaw);

  // If both OCR data and image data are present, confirm they have the same number of pages
  if (doc.images.pageCount > 0 && doc.images.pageCount !== pageCountHOCR) {
    const warningHTML = `Page mismatch detected. Image data has ${doc.images.pageCount} pages while OCR data has ${pageCountHOCR} pages.`;
    doc.warningHandler({ message: warningHTML });
  }

  const format = /** @type {("hocr" | "abbyy" | "stext" | "textract" | "text")} */ (ocrData.format);
  if (format === 'hocr' && ocrData.hocrHead) doc.hocrSource.head[ocrName] = ocrData.hocrHead;

  await convertOCR(doc, ocrData.hocrRaw, false, format, ocrName, doc.pageMetrics);
  await assignLayerLineNums(doc.pageStore, ocrName);
}
