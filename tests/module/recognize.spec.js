import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';

// import { after, it } from 'mocha';
// import path from 'path';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

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
    await scribe.importFiles([`${ASSETS_PATH}/italics_1.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });
  });

  test('Italic words are identified correctly', async () => {
    expect(scribe.data.ocr.active[0].lines[0].words[3].style.italic).toBe(false);
    expect(scribe.data.ocr.active[0].lines[0].words[4].style.italic).toBe(true);
    expect(scribe.data.ocr.active[0].lines[0].words[5].style.italic).toBe(true);
    expect(scribe.data.ocr.active[0].lines[0].words[6].style.italic).toBe(false);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check font optimization features.', () => {
  beforeAll(async () => {
    // For this input image, font optimization significantly improves overlap quality.
    await scribe.importFiles([`${ASSETS_PATH}/analyst_report.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });
  });

  test('Font optimization improves overlap quality', async () => {
    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(scribe.data.font.optMetrics.NimbusSans).toBeLessThan(scribe.data.font.rawMetrics.NimbusSans);
    expect(scribe.data.font.optMetrics.NimbusSans).toBeLessThan(0.47);
  });

  test('Font optimization should be enabled when it improves overlap quality', async () => {
    expect(scribe.data.font.state.enableOpt).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font optimization works with italics.', () => {
  beforeAll(async () => {
    // This article page contains mostly italic text.
    await scribe.importFiles([`${ASSETS_PATH}/article_italics.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });
  });

  test('Font optimization improves overlap quality with italics', async () => {
    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(scribe.data.font.optMetrics.Palatino).toBeLessThan(scribe.data.font.rawMetrics.Palatino);
    expect(scribe.data.font.optMetrics.Palatino).toBeLessThan(0.37);
  });

  test('Font optimization should be enabled when it improves overlap quality', async () => {
    expect(scribe.data.font.state.enableOpt).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check auto-rotate features.', () => {
  test('Baseline overlap is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/simple_paragraph.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(scribe.data.font.optMetrics.NimbusRoman).toBeLessThan(0.45);
  });

  test('Overlap with clockwise rotation is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/simple_paragraph_rot5.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(scribe.data.font.optMetrics.NimbusRoman).toBeLessThan(0.45);
  });

  test('Overlap with counterclockwise rotation is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/simple_paragraph_rotc5.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    expect(scribe.data.font.optMetrics.NimbusRoman).toBeLessThan(0.45);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Tesseract.js parameters can be set.', () => {
  test('Config option tessedit_char_whitelist can be set', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/simple.png`]);
    await scribe.recognize({
      config: {
        tessedit_char_whitelist: '0123456789',
      },
    });
    const txt = await scribe.exportData('text');
    expect(/\d{3,}/.test(txt) && !/[A-Za-z]/.test(txt)).toBe(true);
  });

  test('Config option tessedit_char_whitelist can be restored', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/simple.png`]);
    await scribe.recognize({
      config: {
        tessedit_char_whitelist: '',
      },
    });
    const txt = await scribe.exportData('text');
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

    /** @type {Parameters<typeof scribe.compareOCR>[2]} */
    const compOptions = {
      mode: 'comb',
      supplementComp: false,
    };

    await scribe.importFiles([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr_errors.hocr`]);

    await scribe.importFilesSupp([`${ASSETS_PATH}/testocr_missing_word.hocr`], 'Missing Word');

    const res = await scribe.compareOCR(scribe.data.ocr['User Upload'], scribe.data.ocr['Missing Word'], compOptions);

    // The first word is present in the 'Missing Word' OCR data.
    expect(res.ocr[0].lines[0].words[0].text).toBe('This');
  });

  test('Comparisons handled correctly when word is missing from comparison OCR', async () => {
    /** @type {Parameters<typeof scribe.compareOCR>[2]} */
    const compOptions1 = {
      mode: 'comb',
      supplementComp: false,
    };

    const res1 = await scribe.compareOCR(scribe.data.ocr['User Upload'], scribe.data.ocr['Missing Word'], compOptions1);

    // The second word is missing in the 'Missing Word' OCR data, so the confidence should be 0 when compared to itself.
    expect(res1.ocr[0].lines[0].words[2].conf).toBe(0);

    /** @type {Parameters<typeof scribe.compareOCR>[2]} */
    const compOptions2 = {
      mode: 'comb',
      supplementComp: true,
    };

    const res2 = await scribe.compareOCR(scribe.data.ocr['User Upload'], scribe.data.ocr['Missing Word'], compOptions2);

    // When the `supplementComp` option is set to `true`, missing words should be supplemented with new recognition, so the confidence should be 100.
    expect(res2.ocr[0].lines[0].words[2].conf).toBe(100);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check monospace font detection and optimization (M.D.Fla.).', () => {
  // This test needs more time on slow CI runners.
  // It should be optimized to run faster in the future.
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/M.D.Fla._8_25-cv-03557-MSS-AEP_1_4_p5-8.pdf`]);
    await scribe.recognize({ modeAdv: 'combined' });
  });

  test('NimbusMono is selected as serif default for monospace legal document', async () => {
    expect(scribe.data.font.state.serifDefaultName).toBe('NimbusMono');
  });

  test('Font optimization is enabled and improves quality for monospace document', async () => {
    expect(scribe.data.font.state.enableOpt).toBe(true);
    expect(scribe.data.font.optMetrics.NimbusMono).toBeLessThan(scribe.data.font.rawMetrics.NimbusMono);
  });

  test('Optimized NimbusMono font maintains uniform advance widths', async () => {
    const optFont = scribe.data.font.opt.NimbusMono.normal.opentype;
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
    await scribe.importFiles([`${ASSETS_PATH}/bill.png`]);
    await scribe.recognize({
      vanillaMode: true,
    });
    // This region contains text that is recognized by the modified engine
    // however is missed by the unmodified ("vanilla") engine.
    // This test confirms that the unmodified Tesseract.js engine was used.
    const txt = scribe.utils.ocr.getRegionText(scribe.data.ocr.active[0],
      {
        left: 24, top: 54, right: 930, bottom: 91,
      });

    expect(txt).toBe('Debits Credits Balance');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
