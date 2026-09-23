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

describe('Check basic recognition features.', () => {
  test('Should recognize basic .png image using single function', async () => {
    const txt = await scribe.extractText([`${ASSETS_PATH}/simple.png`]);
    expect(txt).toBe('Tesseract.js');
  });

  test('Should recognize basic .jpg image using single function', async () => {
    const txt = await scribe.extractText([`${ASSETS_PATH}/simple.jpg`]);
    expect(txt).toBe('Tesseract.js');
  });
});

describe('Check style detection.', () => {
  beforeAll(async () => {
    // This article page contains mostly italic text.
    doc = await scribe.openDocument([`${ASSETS_PATH}/italics_1.png`]);
    await doc.recognize({
      modeAdv: 'legacy',
    });
  });

  test('Italic words are identified correctly', async () => {
    expect(doc.ocr.active[0].lines[0].words[3].style.italic).toBe(false);
    expect(doc.ocr.active[0].lines[0].words[4].style.italic).toBe(true);
    expect(doc.ocr.active[0].lines[0].words[5].style.italic).toBe(true);
    expect(doc.ocr.active[0].lines[0].words[6].style.italic).toBe(false);
  });

  test('The page names the bundled engine as its text source', async () => {
    expect(doc.ocr.active[0].textSource, 'a page recognized by the bundled engine does not name it as the text source').toBe('scribe.js');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check font optimization features.', () => {
  beforeAll(async () => {
    // For this input image, font optimization significantly improves overlap quality.
    doc = await scribe.openDocument([`${ASSETS_PATH}/analyst_report.png`]);
    await doc.recognize({
      modeAdv: 'legacy',
    });
  });

  test('Font optimization improves overlap quality', async () => {
    if (!doc.fonts.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!doc.fonts.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(doc.fonts.optMetrics.NimbusSans).toBeLessThan(doc.fonts.rawMetrics.NimbusSans);
    expect(doc.fonts.optMetrics.NimbusSans).toBeLessThan(0.47);
  });

  test('Font optimization should be enabled when it improves overlap quality', async () => {
    expect(doc.fonts.state.enableOpt).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font optimization works with italics.', () => {
  beforeAll(async () => {
    // This article page contains mostly italic text.
    doc = await scribe.openDocument([`${ASSETS_PATH}/article_italics.png`]);
    await doc.recognize({
      modeAdv: 'legacy',
    });
  });

  test('Font optimization improves overlap quality with italics', async () => {
    if (!doc.fonts.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!doc.fonts.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(doc.fonts.optMetrics.Palatino).toBeLessThan(doc.fonts.rawMetrics.Palatino);
    expect(doc.fonts.optMetrics.Palatino).toBeLessThan(0.37);
  });

  test('Font optimization should be enabled when it improves overlap quality', async () => {
    expect(doc.fonts.state.enableOpt).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check auto-rotate features.', () => {
  test('Baseline overlap is decent', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple_paragraph.png`]);
    await doc.recognize({
      modeAdv: 'legacy',
    });

    if (!doc.fonts.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!doc.fonts.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(doc.fonts.optMetrics.NimbusRoman).toBeLessThan(0.45);
  });

  test('Overlap with clockwise rotation is decent', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple_paragraph_rot5.png`]);
    // 'quality' must select both engines. The pass-time and alternative-reading assertions below fail if it selects one.
    await doc.recognize({
      mode: 'quality',
    });

    if (!doc.fonts.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!doc.fonts.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(doc.fonts.optMetrics.NimbusRoman).toBeLessThan(0.45);

    // Regression guard: recognition used to install the engine's deskewed copy as the page raster, holding a second full-page PNG per skewed page for the document's lifetime.
    const native0 = await doc.images.native[0];
    const upload0 = await doc.images.nativeSrc[0];
    expect(native0, 'recognition replaced the uploaded raster with a deskewed copy').toBe(upload0);
    expect(native0.rotated, 'page raster is no longer in the upload frame after recognition').toBe(false);

    // Regression guard: the combined merge once decided which LSTM words belong to a Legacy line from page-frame boxes.
    // On a skewed page those are tall enough to reach the neighboring lines, so every line took words from above and below.
    const { lines } = doc.ocr.active[0];
    expect(lines.length, 'combined recognition of a skewed page lost or merged lines').toBe(14);
    expect(lines[0].words.map((w) => w.text).join(' '), 'a line of a skewed page took words from its neighbors')
      .toBe('JNJ announced this morning the acquisition of privately-held Aragon for $650 million');

    const words = lines.flatMap((line) => line.words);
    expect(words.find((w) => w.text === 'Aragon’s')?.lang, 'a recognized word carries the engine\'s language').toBe('eng');
    expect(doc.ocr.active[0].textSource, 'a page recognized by the bundled engine does not name it as the text source').toBe('scribe.js');
    expect(words.find((w) => w.text === 'Aragon’s')?.alt, 'a word with a classifier reading and a losing engine reading carries both, higher confidence first, each naming its origin in msg')
      .toEqual([{
        text: 'Aragons', conf: 68, span: 1, msg: 'c1',
      }, {
        text: 'Aragon‘s', conf: 63, span: 1, msg: 'a1',
      }]);
    expect(words.find((w) => w.text === '2012')?.alt, 'a word the engines disagreed on carries the other engine\'s reading with its confidence and the arbiter\'s rule').toEqual([{
      text: '20l2', conf: 89, span: 1, msg: 'a1',
    }]);
    expect(words.find((w) => w.text === 'be')?.alt, 'a word whose classifier preferred another reading carries that reading with its confidence').toEqual([{
      text: 'bc', conf: 88, span: 1, msg: 'c1',
    }]);
    expect(lines[0].words[0].alt, 'a word both engines agreed on carries no alternative reading').toBe(undefined);
    const repeated = words.filter((w) => w.alt?.some((a) => a.text === w.text) || (w.alt && new Set(w.alt.map((a) => a.text)).size !== w.alt.length));
    expect(repeated.length, 'an alternative reading repeats the shipped text or another alternative').toBe(0);

    // The core times its own passes; the dev telemetry and the timing runner read them from `doc.ocrTiming` by timing code.
    const timing = doc.ocrTiming[0].Combined;
    expect(typeof timing[0], 'the recognition run left no per-page timing record').toBe('number');
    expect(typeof timing[2], 'the core reported no Legacy pass time for a combined recognition').toBe('number');
    expect(typeof timing[3], 'the core reported no LSTM pass time for a combined recognition').toBe('number');
  });

  test('Overlap with counterclockwise rotation is decent', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple_paragraph_rotc5.png`]);
    await doc.recognize({
      modeAdv: 'legacy',
    });

    if (!doc.fonts.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!doc.fonts.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(doc.fonts.optMetrics.NimbusRoman).toBeLessThan(0.45);

    const native0 = await doc.images.native[0];
    const upload0 = await doc.images.nativeSrc[0];
    expect(native0, 'recognition replaced the uploaded raster with a deskewed copy').toBe(upload0);
    expect(native0.rotated, 'page raster is no longer in the upload frame after recognition').toBe(false);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Tesseract.js parameters can be set.', () => {
  test('Config option tessedit_char_whitelist can be set', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple.png`]);
    await doc.recognize({
      config: {
        tessedit_char_whitelist: '0123456789',
      },
    });
    const txt = await doc.exportData('text');
    expect(/\d{3,}/.test(txt) && !/[A-Za-z]/.test(txt)).toBe(true);
  });

  test('Config option tessedit_char_whitelist can be restored', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple.png`]);
    await doc.recognize({
      config: {
        tessedit_char_whitelist: '',
      },
    });
    const txt = await doc.exportData('text');
    expect(txt).toBe('Tesseract.js');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check comparison between OCR versions.', () => {
  test('Errors in uploaded OCR data are corrected', async () => {
    // These functions still require various dependencies to be loaded to run properly.
    // In some future version this should be fixed.
    await scribe.init({ ocr: true, font: true });

    /** @type {Parameters<typeof doc.compareOCR>[2]} */
    const compOptions = {
      mode: 'comb',
      supplementComp: false,
    };

    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr_errors.hocr`]);

    await doc.importFilesSupp([`${ASSETS_PATH}/testocr_missing_word.hocr`], 'Missing Word');

    const res = await doc.compareOCR(doc.ocr['User Upload'], doc.ocr['Missing Word'], compOptions);

    // The first word is present in the 'Missing Word' OCR data.
    expect(res.ocr[0].lines[0].words[0].text).toBe('This');
  });

  test('Comparisons handled correctly when word is missing from comparison OCR', async () => {
    /** @type {Parameters<typeof doc.compareOCR>[2]} */
    const compOptions1 = {
      mode: 'comb',
      supplementComp: false,
    };

    const res1 = await doc.compareOCR(doc.ocr['User Upload'], doc.ocr['Missing Word'], compOptions1);

    // The second word is missing in the 'Missing Word' OCR data, so the confidence should be 0 when compared to itself.
    expect(res1.ocr[0].lines[0].words[2].conf).toBe(0);

    /** @type {Parameters<typeof doc.compareOCR>[2]} */
    const compOptions2 = {
      mode: 'comb',
      supplementComp: true,
    };

    const res2 = await doc.compareOCR(doc.ocr['User Upload'], doc.ocr['Missing Word'], compOptions2);

    // When the `supplementComp` option is set to `true`, missing words should be supplemented with new recognition, so the confidence should be 100.
    expect(res2.ocr[0].lines[0].words[2].conf).toBe(100);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check monospace font detection and optimization (M.D.Fla.).', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/M.D.Fla._8_25-cv-03557-MSS-AEP_1_4_p6.pdf`]);
    await doc.recognize({ modeAdv: 'combined' });
  });

  test('NimbusMono is selected as serif default for monospace legal document', async () => {
    expect(doc.fonts.state.serifDefaultName).toBe('NimbusMono');
  });

  test('Font optimization is enabled and improves quality for monospace document', async () => {
    expect(doc.fonts.state.enableOpt).toBe(true);
    expect(doc.fonts.optMetrics.NimbusMono).toBeLessThan(doc.fonts.rawMetrics.NimbusMono);
  });

  test('Optimized NimbusMono font maintains uniform advance widths', async () => {
    const optFont = doc.fonts.opt.NimbusMono.normal.opentype;
    const advances = new Set();
    for (const char of 'abcdefghijklmnopqrstuvwxyz') {
      const glyph = optFont.charToGlyph(char);
      if (glyph && glyph.advanceWidth) advances.add(glyph.advanceWidth);
    }
    expect(advances.size).toBe(1);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check vanilla recognition engine.', () => {
  test('Enabling vanillaMode option should use unmodified recognition engine', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/bill.png`]);
    // Under vanillaMode 'quality' runs the LSTM engine alone, which is the only engine that reads the header row asserted below.
    await doc.recognize({
      vanillaMode: true, mode: 'quality',
    });
    // This region contains text that is recognized by the modified engine
    // however is missed by the unmodified ("vanilla") engine.
    // This test confirms that the unmodified Tesseract.js engine was used.
    const txt = scribe.utils.ocr.getRegionText(doc.ocr.active[0],
      {
        left: 24, top: 54, right: 930, bottom: 91,
      });

    expect(txt, 'the vanilla LSTM reading of the header row').toBe('Debits Credits Balance');
    const debits = doc.ocr.active[0].lines.flatMap((line) => line.words).find((w) => w.text === 'Debits');
    expect(debits?.lang, 'a word recognized by the vanilla engine carries its language').toBe('eng');
    // Vanilla Tesseract's font and style output is unreliable, so the vanilla converter should never read it.
    expect(debits?.style.font, 'a word recognized by the vanilla engine carries no Tesseract font').toBe(null);
    expect(doc.ocr.active[0].textSource, 'a page recognized by the vanilla engine does not name it as the text source').toBe('tesseract');
  });

  test('Combined mode is rejected with vanillaMode, whose cores carry no merge', async () => {
    await expect(doc.recognize({ vanillaMode: true, modeAdv: 'combined' }), 'a vanilla run with modeAdv combined must throw rather than run one engine')
      .rejects.toThrow("modeAdv 'combined' is not available with vanillaMode");
  });

  test('The bundled engine comes back after a vanilla run in the same session', async () => {
    // Regression guard: the worker treated a request for the bundled engine as "keep the current one", so every run after a vanilla run stayed vanilla.
    await doc.recognize({ mode: 'quality' });
    expect(doc.ocr.active[0].textSource, 'a run after a vanilla run in the same session still used the vanilla engine').toBe('scribe.js');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that a run which does not finish leaves the document as it was.', () => {
  const wordCount = (layer) => layer.reduce((n, page) => n + page.lines.reduce((m, line) => m + line.words.length, 0), 0);
  const rejection = (promise) => promise.then(() => null, (err) => err);

  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`]);
    await doc.textReady;
  });

  test('A run whose signal is already aborted rejects and changes nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(doc.recognize({ langs: ['eng'], ocrPages: 'all', signal: controller.signal }));
    expect(err?.name, 'a run on an aborted signal rejects with an AbortError').toBe('AbortError');
    expect(doc.ocr.active, 'the parsed text stays the active layer after an aborted run').toBe(doc.ocr.pdf);
    expect(wordCount(doc.ocr.active), 'the active text is untouched by an aborted run').toBe(497);
    expect(doc.ocr.active[0].lines[0].words[0].text, 'the first word after an aborted run').toBe('WHISTLEBLOWERS');
    expect(doc.inputData.ocrApplied, 'no page is marked OCR-applied by an aborted run').toBe(null);
  });

  // Regression: the run pointed the active layer at its empty result before any page landed, and a failure left it there.
  test('A run that fails on a missing language file rejects and changes nothing', async () => {
    const err = await rejection(doc.recognize({ langs: ['zzz'], ocrPages: 'all' }));
    expect(String(err?.message ?? err), 'a run on a language that cannot load rejects, naming the file').toMatch(/zzz\.traineddata/);
    expect(doc.ocr.active, 'the parsed text stays the active layer after a failed run').toBe(doc.ocr.pdf);
    expect(wordCount(doc.ocr.active), 'the active text is untouched by a failed run').toBe(497);
    expect(doc.ocr.active[0].lines[0].words[0].text, 'the first word after a failed run').toBe('WHISTLEBLOWERS');
    expect(doc.inputData.ocrApplied, 'no page is marked OCR-applied by a failed run').toBe(null);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
