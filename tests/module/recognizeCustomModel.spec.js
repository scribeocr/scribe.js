import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

const PAGE_COUNT = 7;

// Helper function to read file content in both Node.js and browser environments
async function readFileContent(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  const response = await fetch(filePath);
  return response.text();
}

class MockGoogleVisionModel {
  static config = {
    name: 'Mock Google Vision',
    outputFormat: 'google_vision',
  };

  static fixturePages = [];

  static pageIndex = 0;

  static async recognizeImage(imageData, options = {}) {
    const rawData = MockGoogleVisionModel.fixturePages[MockGoogleVisionModel.pageIndex];
    MockGoogleVisionModel.pageIndex++;
    return { success: true, rawData, format: 'google_vision' };
  }
}

class MockTextractModel {
  static config = {
    name: 'Mock Textract',
    outputFormat: 'textract',
  };

  static fixturePages = [];

  static pageIndex = 0;

  static async recognizeImage(imageData, options = {}) {
    const rawData = MockTextractModel.fixturePages[MockTextractModel.pageIndex];
    MockTextractModel.pageIndex++;
    return { success: true, rawData, format: 'textract' };
  }
}

class ScatteredFailModel {
  static config = {
    name: 'Scattered Fail',
    outputFormat: 'google_vision',
  };

  static fixturePages = [];

  static pageIndex = 0;

  static failPages = new Set([2, 5]);

  static async recognizeImage(imageData, options = {}) {
    const idx = ScatteredFailModel.pageIndex;
    ScatteredFailModel.pageIndex++;
    if (ScatteredFailModel.failPages.has(idx)) {
      return { success: false, error: new Error('Transient error'), format: 'google_vision' };
    }
    const rawData = ScatteredFailModel.fixturePages[idx];
    return { success: true, rawData, format: 'google_vision' };
  }
}

class MockTextractDocumentModeModel {
  static config = {
    name: 'Mock Textract DocumentMode',
    outputFormat: 'textract',
    documentMode: true,
  };

  static fixturePages = [];

  static lastDocInput = null;

  static async* recognizeDocument(doc, options = {}) {
    MockTextractDocumentModeModel.lastDocInput = doc;
    yield { progress: { stage: 'open', pct: 0 } };
    for (let i = 0; i < MockTextractDocumentModeModel.fixturePages.length; i++) {
      if (i === 3) yield { pageNum: 3, progress: { stage: 'analysis', pct: 43 } };
      yield { pageNum: i, rawData: MockTextractDocumentModeModel.fixturePages[i] };
    }
  }
}

class PageSelectionDocModeModel {
  static config = {
    name: 'Page Selection DocMode',
    outputFormat: 'textract',
    documentMode: true,
    documentModePageSelection: true,
  };

  static fixturePages = [];

  static lastInput = null;

  static async* recognizeDocument(input) {
    PageSelectionDocModeModel.lastInput = input;
    // These two entries name unselected pages, which the library must drop.
    yield { pageNum: 2, progress: { stage: 'analysis', pct: 20 } };
    yield { pageNum: 0, rawData: PageSelectionDocModeModel.fixturePages[0] };
    for (const n of input.pages) {
      yield { pageNum: n, rawData: PageSelectionDocModeModel.fixturePages[n] };
    }
  }
}

class UnderYieldDocModeModel {
  static config = {
    name: 'Under Yield DocMode',
    outputFormat: 'textract',
    documentMode: true,
  };

  static fixturePages = [];

  static async* recognizeDocument() {
    for (let i = 0; i < 3; i++) {
      yield { pageNum: i, rawData: UnderYieldDocModeModel.fixturePages[i] };
    }
  }
}

class AllFailDocModeModel {
  static config = {
    name: 'All Fail DocMode',
    outputFormat: 'textract',
    documentMode: true,
  };

  // eslint-disable-next-line no-empty-function
  static async* recognizeDocument() {}
}

class FailingModel {
  static config = {
    name: 'Failing Model',
    outputFormat: 'hocr',
  };

  static pageIndex = 0;

  static async recognizeImage(imageData, options = {}) {
    FailingModel.pageIndex++;
    // Fail on page index 3
    if (FailingModel.pageIndex - 1 === 3) {
      return { success: false, error: new Error('API limit reached'), format: 'hocr' };
    }
    // Return empty success for other pages (will produce empty OCR)
    return { success: false, error: new Error('Not a real model'), format: 'hocr' };
  }
}

class SlowAbortModel {
  static config = {
    name: 'Slow Abort Textract',
    outputFormat: 'textract',
  };

  static sharedFixture = null;

  static perCallDelayMs = 300;

  static async recognizeImage(imageData, options = {}) {
    await new Promise((resolve) => setTimeout(resolve, SlowAbortModel.perCallDelayMs));
    if (options.signal && options.signal.aborted) {
      return { success: false, error: new Error('aborted by signal'), format: 'textract' };
    }
    return { success: true, rawData: SlowAbortModel.sharedFixture, format: 'textract' };
  }
}

class SlowAbortDocumentModeModel {
  static config = {
    name: 'Slow Abort DocumentMode',
    outputFormat: 'textract',
    documentMode: true,
  };

  static fixturePages = [];

  static perPageDelayMs = 300;

  static lastOptionsSignal = null;

  static async* recognizeDocument(doc, options = {}) {
    SlowAbortDocumentModeModel.lastOptionsSignal = options.signal || null;
    for (let i = 0; i < SlowAbortDocumentModeModel.fixturePages.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, SlowAbortDocumentModeModel.perPageDelayMs));
      if (options.signal && options.signal.aborted) return;
      yield { pageNum: i, rawData: SlowAbortDocumentModeModel.fixturePages[i] };
    }
  }
}

describe('Check custom model recognition with Google Vision format.', () => {
  beforeAll(async () => {
    const gvDir = `${ASSETS_PATH}/tests/test-assets/trident_v_connecticut_general/googleVision`;
    const gvDirAlt = `${ASSETS_PATH}/trident_v_connecticut_general/googleVision`;

    MockGoogleVisionModel.fixturePages = [];
    MockGoogleVisionModel.pageIndex = 0;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-GoogleVisionSync.json`;
      MockGoogleVisionModel.fixturePages[i] = await readFileContent(`${gvDirAlt}/${filename}`);
    }

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);
    await doc.recognize({ model: MockGoogleVisionModel });
  });

  test('Should produce OCR data for all 7 pages', async () => {
    for (let i = 0; i < PAGE_COUNT; i++) {
      expect(doc.ocr.active[i]).toBeTruthy();
      expect(doc.ocr.active[i].lines.length > 0).toBe(true);
    }
  });

  test('Should correctly recognize text on page 0', async () => {
    const firstWord = doc.ocr.active[0].lines[0].words[0].text;
    expect(firstWord).toBe('564');
  });

  test('Should correctly recognize text on page 6', async () => {
    const firstWord = doc.ocr.active[6].lines[0].words[0].text;
    expect(firstWord).toBe('570');
  });

  test('Should set active OCR to the custom model results', async () => {
    expect(doc.ocr.active).toBe(doc.ocr['Mock Google Vision']);
  });

  test('Should have correct page numbers on OcrPage objects', async () => {
    for (let i = 0; i < PAGE_COUNT; i++) {
      expect(doc.ocr.active[i].n).toBe(i);
    }
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check custom model recognition with Textract format.', () => {
  beforeAll(async () => {
    const txDir = `${ASSETS_PATH}/trident_v_connecticut_general/awsTextract`;

    MockTextractModel.fixturePages = [];
    MockTextractModel.pageIndex = 0;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      MockTextractModel.fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);
    await doc.recognize({ model: MockTextractModel });
  });

  test('Should produce OCR data for all 7 pages', async () => {
    for (let i = 0; i < PAGE_COUNT; i++) {
      expect(doc.ocr.active[i]).toBeTruthy();
      expect(doc.ocr.active[i].lines.length > 0).toBe(true);
    }
  });

  test('Should correctly recognize text on page 0', async () => {
    const firstWord = doc.ocr.active[0].lines[0].words[0].text;
    expect(firstWord).toBe('564');
  });

  test('Should correctly recognize text on page 6', async () => {
    const firstWord = doc.ocr.active[6].lines[0].words[0].text;
    expect(firstWord).toBe('570');
  });

  test('Should set active OCR to the custom model results', async () => {
    expect(doc.ocr.active).toBe(doc.ocr['Mock Textract']);
  });

  test('Should have correct page numbers on OcrPage objects', async () => {
    for (let i = 0; i < PAGE_COUNT; i++) {
      expect(doc.ocr.active[i].n).toBe(i);
    }
  });

  test('Should have unique word IDs across all pages', async () => {
    const allIds = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
      for (const line of doc.ocr.active[i].lines) {
        for (const word of line.words) {
          allIds.push(word.id);
        }
      }
    }
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check custom model recognition in documentMode (Textract).', () => {
  let preRenderSpyCalls = 0;
  let originalPreRender;
  const recognizeMsgs = [];

  beforeAll(async () => {
    const txDir = `${ASSETS_PATH}/trident_v_connecticut_general/awsTextract`;

    MockTextractDocumentModeModel.fixturePages = [];
    MockTextractDocumentModeModel.lastDocInput = null;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      MockTextractDocumentModeModel.fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    originalPreRender = doc.images.preRenderRange;
    preRenderSpyCalls = 0;
    doc.images.preRenderRange = async function (...args) {
      preRenderSpyCalls++;
      return originalPreRender.apply(this, args);
    };

    const originalProgressHandler = scribe.opt.progressHandler;
    scribe.opt.progressHandler = (msg) => {
      if (msg && msg.type === 'recognize') recognizeMsgs.push(msg);
    };

    try {
      await doc.recognize({ model: MockTextractDocumentModeModel });
    } finally {
      doc.images.preRenderRange = originalPreRender;
      scribe.opt.progressHandler = originalProgressHandler;
    }
  });

  test('Should skip ImageCache.preRenderRange on the documentMode path', async () => {
    expect(preRenderSpyCalls).toBe(0);
  });

  test('Should hand the PDF bytes and page count to recognizeDocument', async () => {
    expect(MockTextractDocumentModeModel.lastDocInput).toBeTruthy();
    expect(MockTextractDocumentModeModel.lastDocInput.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(MockTextractDocumentModeModel.lastDocInput.pdfBytes.byteLength > 0).toBe(true);
    expect(MockTextractDocumentModeModel.lastDocInput.pageCount).toBe(PAGE_COUNT);
    expect(MockTextractDocumentModeModel.lastDocInput.pageDims.length).toBe(PAGE_COUNT);
  });

  test('Should produce OCR data for all 7 pages', async () => {
    for (let i = 0; i < PAGE_COUNT; i++) {
      expect(doc.ocr.active[i]).toBeTruthy();
      expect(doc.ocr.active[i].lines.length > 0).toBe(true);
    }
  });

  test('Should correctly recognize text on page 0', async () => {
    const firstWord = doc.ocr.active[0].lines[0].words[0].text;
    expect(firstWord).toBe('564');
  });

  test('Should correctly recognize text on page 6', async () => {
    const firstWord = doc.ocr.active[6].lines[0].words[0].text;
    expect(firstWord).toBe('570');
  });

  test('Should set active OCR to the documentMode model results', async () => {
    expect(doc.ocr.active).toBe(doc.ocr['Mock Textract DocumentMode']);
  });

  test('Should forward non-terminal progress entries to progressHandler', async () => {
    const progressMsgs = recognizeMsgs.filter((m) => m.info && m.info.status === 'progress');
    expect(progressMsgs.length, 'both progress entries reach progressHandler').toBe(2);
    expect(progressMsgs[0].n, 'a document-level stage entry has no page number').toBe(undefined);
    expect(progressMsgs[0].info.stage, 'the document-level stage name is forwarded').toBe('open');
    expect(progressMsgs[0].info.pct, 'the document-level pct is forwarded').toBe(0);
    expect(progressMsgs[0].info.engineName, 'progress messages carry the engine name').toBe('Mock Textract DocumentMode');
    expect(typeof progressMsgs[0].info.timestamp, 'progress messages carry a timestamp').toBe('number');
    expect(progressMsgs[1].n, 'a page-scoped progress entry keeps its page number').toBe(3);
    expect(progressMsgs[1].info.stage, 'the page-scoped stage name is forwarded').toBe('analysis');
    expect(progressMsgs[1].info.pct, 'the page-scoped pct is forwarded').toBe(43);
  });

  test('Should not count progress entries toward per-page received events', async () => {
    const receivedMsgs = recognizeMsgs.filter((m) => m.info && m.info.status === 'received');
    expect(receivedMsgs.length, 'exactly one received event per terminal entry').toBe(PAGE_COUNT);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check documentMode page selection and missing-page accounting.', () => {
  // Each recognize() call reassigns doc.ocr.active and doc.inputData.ocrApplied.
  let selectionLayer;
  let selectionCombined;
  let selectionOcrApplied;
  const selectionMsgs = [];
  const selectionWarnings = [];
  let underYieldLayer;
  const underYieldWarnings = [];
  let allFailError = null;

  beforeAll(async () => {
    const txDir = `${ASSETS_PATH}/trident_v_connecticut_general/awsTextract`;
    const fixturePages = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }
    PageSelectionDocModeModel.fixturePages = fixturePages;
    PageSelectionDocModeModel.lastInput = null;
    UnderYieldDocModeModel.fixturePages = fixturePages;

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    const originalProgressHandler = scribe.opt.progressHandler;
    const originalWarningHandler = scribe.opt.warningHandler;
    try {
      scribe.opt.progressHandler = (msg) => {
        if (msg && msg.type === 'recognize') selectionMsgs.push(msg);
      };
      scribe.opt.warningHandler = (msg) => selectionWarnings.push(msg);
      await doc.recognize({
        model: PageSelectionDocModeModel,
        ocrPages: [false, true, false, false, false, false, true],
      });
      selectionLayer = doc.ocr.active;
      selectionCombined = doc.ocr.Combined;
      selectionOcrApplied = doc.inputData.ocrApplied.slice();

      scribe.opt.progressHandler = originalProgressHandler;
      scribe.opt.warningHandler = (msg) => underYieldWarnings.push(msg);
      await doc.recognize({ model: UnderYieldDocModeModel });
      underYieldLayer = doc.ocr.active;

      scribe.opt.warningHandler = () => {};
      try {
        await doc.recognize({ model: AllFailDocModeModel });
      } catch (err) {
        allFailError = err;
      }
    } finally {
      scribe.opt.progressHandler = originalProgressHandler;
      scribe.opt.warningHandler = originalWarningHandler;
    }
  });

  test('Should pass the selected page list to the model', async () => {
    expect(PageSelectionDocModeModel.lastInput.pages, 'the flagged model receives the 0-based selected page indices').toEqual([1, 6]);
    expect(PageSelectionDocModeModel.lastInput.pageCount, 'the input still describes the whole document').toBe(PAGE_COUNT);
  });

  test('Should apply the model OCR to selected pages', async () => {
    // Page 6 is the one page where native and OCR text differ at the first word ('57' vs '570').
    expect(selectionLayer[6].lines[0].words[0].text, 'a selected page carries the model OCR text').toBe('570');
    expect(selectionLayer[6].lines.length, 'a selected page has the OCR line count, not the native one').toBe(100);
    expect(selectionLayer[1].lines[0].words[0].text, 'the other selected page carries the model OCR text').toBe('565');
    expect(selectionLayer[1].lines.length, 'the other selected page has the OCR line count').toBe(33);
  });

  test('Should keep native text on unselected pages', async () => {
    // Line counts distinguish the sources: native page 0 has 339 lines, the model OCR 98.
    expect(selectionLayer[0].lines.length, 'an unselected page keeps the native line count even when the model yields it anyway').toBe(339);
    expect(selectionLayer[0].lines[0].words[0].text, 'an unselected page keeps the native text').toBe('564');
    expect(selectionLayer[5].lines.length, 'a never-yielded unselected page keeps the native line count').toBe(362);
    expect(selectionLayer[5].lines[0].words[0].text, 'a never-yielded unselected page keeps the native text').toBe('569');
    expect(selectionLayer, 'a partial selection assembles the Combined layer').toBe(selectionCombined);
  });

  test('Should narrow ocrApplied to the selection', async () => {
    expect(selectionOcrApplied, 'ocrApplied matches the page selection exactly').toEqual([false, true, false, false, false, false, true]);
  });

  test('Should drop entries for unselected pages with a single warning', async () => {
    expect(selectionWarnings.length, 'the flag suppresses the whole-PDF warning, leaving only the dropped-entry warning').toBe(1);
    expect(selectionWarnings[0], 'the dropped unselected result is reported once').toBe('Document-mode model returned results for unselected page(s) (0); they were ignored.');
    const progressMsgs = selectionMsgs.filter((m) => m.info && m.info.status === 'progress');
    expect(progressMsgs.length, 'progress entries for unselected pages are dropped, not forwarded').toBe(0);
    const receivedNs = selectionMsgs.filter((m) => m.info && m.info.status === 'received').map((m) => m.n);
    expect(receivedNs, 'received events fire only for selected pages').toEqual([1, 6]);
  });

  test('Should keep the OCR data of pages that yielded', async () => {
    expect(underYieldLayer[0].lines.length, 'a yielded page keeps its OCR data').toBe(98);
    expect(underYieldLayer[0].lines[0].words[0].text, 'a yielded page keeps its OCR text').toBe('564');
    expect(underYieldLayer[2].lines.length, 'the last yielded page keeps its OCR data').toBe(102);
  });

  test('Should treat never-yielded pages as failed pages, not silent holes', async () => {
    for (const n of [3, 4, 5, 6]) {
      expect(underYieldLayer[n], `page ${n} is an empty page object, not an undefined hole`).toBeTruthy();
      expect(underYieldLayer[n].lines.length, `page ${n} has no OCR lines after the model skipped it`).toBe(0);
    }
    expect(underYieldWarnings.length, 'four per-page failure warnings plus one summary').toBe(5);
    expect(underYieldWarnings[0], 'a never-yielded page gets the standard per-page failure warning').toBe('Recognition failed for page 3: no result was returned for this page.');
    expect(underYieldWarnings[4], 'the failure summary lists every never-yielded page').toBe('Recognition failed for 4 page(s) (3, 4, 5, 6). These pages will have no OCR data.');
  });

  test('Should throw when the model yields no pages at all', async () => {
    expect(allFailError, 'a model that never yields a terminal entry fails the run').not.toBeNull();
    expect(allFailError.message, 'the all-pages-failed error names the cause').toBe('Recognition failed for all pages. Last error message: no result was returned for this page.');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check custom model progress reporting.', () => {
  test('Should report progress for each page', async () => {
    MockGoogleVisionModel.pageIndex = 0;

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    const progressPages = [];
    const originalHandler = scribe.opt.progressHandler;
    scribe.opt.progressHandler = (msg) => {
      if (msg.type === 'convert' && msg.info.engineName === 'Mock Google Vision') {
        progressPages.push(msg.n);
      }
    };

    await doc.recognize({ model: MockGoogleVisionModel });

    scribe.opt.progressHandler = originalHandler;

    expect(progressPages.length).toBe(PAGE_COUNT);
    const sortedPages = [...progressPages].sort((a, b) => a - b);
    expect(sortedPages).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check custom model error handling.', () => {
  test('Should abort after consecutive failures', async () => {
    FailingModel.pageIndex = 0;

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    const warnings = [];
    const originalHandler = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (msg) => {
      warnings.push(msg);
    };

    // Force sequential processing so failures are detected before all pages are dispatched.
    const originalWorkerN = scribe.opt.workerN;
    scribe.opt.workerN = 1;

    let thrownError = null;
    try {
      await doc.recognize({ model: FailingModel });
    } catch (err) {
      thrownError = err;
    }

    scribe.opt.warningHandler = originalHandler;
    scribe.opt.workerN = originalWorkerN;

    expect(thrownError).not.toBeNull();
    expect(thrownError.message.includes('consecutive failures')).toBe(true);
    expect(thrownError.message.includes('Not a real model')).toBe(true);
    // With workerN=1, should have aborted after exactly 3 failures (the threshold)
    expect(warnings.length).toBe(3);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check custom model scattered failure handling.', () => {
  beforeAll(async () => {
    const gvDirAlt = `${ASSETS_PATH}/trident_v_connecticut_general/googleVision`;

    ScatteredFailModel.fixturePages = [];
    ScatteredFailModel.pageIndex = 0;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-GoogleVisionSync.json`;
      ScatteredFailModel.fixturePages[i] = await readFileContent(`${gvDirAlt}/${filename}`);
    }

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);
  });

  test('Should return partial results and warn about failed pages', async () => {
    const warnings = [];
    const originalHandler = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (msg) => {
      warnings.push(msg);
    };

    await doc.recognize({ model: ScatteredFailModel });

    scribe.opt.warningHandler = originalHandler;

    // Pages 2 and 5 should have failed
    const summaryWarning = warnings.find((w) => w.includes('page(s)'));
    expect(summaryWarning).toBeTruthy();
    expect(summaryWarning.includes('2')).toBe(true);
    expect(summaryWarning.includes('5')).toBe(true);

    // Successful pages should have OCR data
    for (const i of [0, 1, 3, 4, 6]) {
      expect(doc.ocr.active[i]).toBeTruthy();
      expect(doc.ocr.active[i].lines.length > 0).toBe(true);
    }

    // Failed pages should have no lines
    expect(doc.ocr.active[2].lines.length).toBe(0);
    expect(doc.ocr.active[5].lines.length).toBe(0);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check AbortSignal handling on the per-image path.', () => {
  let thrownError = null;

  beforeAll(async () => {
    const txDir = `${ASSETS_PATH}/trident_v_connecticut_general/awsTextract`;
    const filename = 'trident_v_connecticut_general_000-AwsTextractLayoutSync.json';
    SlowAbortModel.sharedFixture = await readFileContent(`${txDir}/${filename}`);
    SlowAbortModel.perCallDelayMs = 300;

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    // Force sequential dispatch so the abort window is deterministic.
    const originalWorkerN = scribe.opt.workerN;
    scribe.opt.workerN = 1;

    // Abort after the first page has completed and been converted, guaranteeing partial
    // results. Hooking the progress handler avoids racing against preRenderRange, which
    // could otherwise eat a fixed-delay abort window before any page dispatches.
    const ac = new AbortController();
    const originalProgressHandler = scribe.opt.progressHandler;
    let convertCount = 0;
    scribe.opt.progressHandler = (msg) => {
      if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === 'Slow Abort Textract') {
        convertCount++;
        if (convertCount === 1) ac.abort();
      }
    };

    try {
      await doc.recognize({ model: SlowAbortModel, signal: ac.signal });
    } catch (err) {
      thrownError = err;
    } finally {
      scribe.opt.workerN = originalWorkerN;
      scribe.opt.progressHandler = originalProgressHandler;
    }
  });

  test('Should throw an AbortError when aborted mid-run', async () => {
    expect(thrownError).not.toBeNull();
    expect(thrownError.name).toBe('AbortError');
  });

  test('Should preserve partial OCR results for pages that completed before abort', async () => {
    const engineOcr = doc.ocr['Slow Abort Textract'] || [];
    const completedPages = engineOcr.filter((p) => p && p.lines && p.lines.length > 0);
    expect(completedPages.length > 0).toBe(true);
    expect(completedPages.length < PAGE_COUNT).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check AbortSignal handling on the documentMode path.', () => {
  let thrownError = null;

  beforeAll(async () => {
    const txDir = `${ASSETS_PATH}/trident_v_connecticut_general/awsTextract`;
    SlowAbortDocumentModeModel.fixturePages = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      SlowAbortDocumentModeModel.fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }
    SlowAbortDocumentModeModel.perPageDelayMs = 300;
    SlowAbortDocumentModeModel.lastOptionsSignal = null;

    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    // Abort once the first page has been received and converted — guarantees partial
    // results regardless of how long the library takes to start consuming the stream.
    const ac = new AbortController();
    const originalProgressHandler = scribe.opt.progressHandler;
    let convertCount = 0;
    scribe.opt.progressHandler = (msg) => {
      if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === 'Slow Abort DocumentMode') {
        convertCount++;
        if (convertCount === 1) ac.abort();
      }
    };

    try {
      await doc.recognize({ model: SlowAbortDocumentModeModel, signal: ac.signal });
    } catch (err) {
      thrownError = err;
    } finally {
      scribe.opt.progressHandler = originalProgressHandler;
    }
  });

  test('Should throw an AbortError when aborted mid-stream', async () => {
    expect(thrownError).not.toBeNull();
    expect(thrownError.name).toBe('AbortError');
  });

  test('Should forward the signal into the model via options', async () => {
    expect(SlowAbortDocumentModeModel.lastOptionsSignal).toBeTruthy();
    expect(SlowAbortDocumentModeModel.lastOptionsSignal.aborted).toBe(true);
  });

  test('Should preserve partial OCR results on the documentMode engine', async () => {
    const engineOcr = doc.ocr['Slow Abort DocumentMode'] || [];
    const completedPages = engineOcr.filter((p) => p && p.lines && p.lines.length > 0);
    expect(completedPages.length > 0).toBe(true);
    expect(completedPages.length < PAGE_COUNT).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
