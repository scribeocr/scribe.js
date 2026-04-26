import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import { writeAlto } from '../../js/export/writeAlto.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/**
 * Reads a text file in any environment (browser or Node.js).
 * @param {string} filePath
 */
async function readTextFileUniversal(filePath) {
  if (typeof process !== 'undefined') {
    const { promises: fsPromises } = await import('node:fs');
    const contents = await fsPromises.readFile(filePath, 'utf-8');
    return contents;
  }

  const response = await fetch(filePath);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${filePath}`);
  }
  return await response.text();
}

/**
 * Function to normalize and extract content for comparison
 * @param {string} xmlStr
 */
const normalizeAlto = (xmlStr) => {
  xmlStr = xmlStr.replace(/<processingDateTime>[^<]*<\/processingDateTime>/g, '');
  xmlStr = xmlStr.replace(/<softwareCreator>[^<]*<\/softwareCreator>/g, '');
  xmlStr = xmlStr.replace(/<softwareName>[^<]*<\/softwareName>/g, '');
  xmlStr = xmlStr.replace(/<softwareVersion>[^<]*<\/softwareVersion>/g, '');
  // We delete the FONTSIZE attribute on import as it often appears to be inaccurate.
  xmlStr = xmlStr.replace(/\s*FONTSIZE="[^"]*"/g, '');

  xmlStr = xmlStr.replace(/<TopMargin[^>]*>\s*<\/TopMargin>/g, '');
  xmlStr = xmlStr.replace(/<LeftMargin[^>]*>\s*<\/LeftMargin>/g, '');
  xmlStr = xmlStr.replace(/<RightMargin[^>]*>\s*<\/RightMargin>/g, '');
  xmlStr = xmlStr.replace(/<BottomMargin[^>]*>\s*<\/BottomMargin>/g, '');

  xmlStr = xmlStr.replace(/<PrintSpace[^>]*>/g, '<PrintSpace>');

  // Remove position attributes from TextBlock.
  // Some of the test data is from Abbyy,
  // which does not tightly enclose TextBlock elements around text content.
  // Therefore, position attributes may differ after re-exporting.
  xmlStr = xmlStr.replace(/<TextBlock\s+([^>]*)>/g, (_match, attrs) => {
    const newAttrs = attrs.replace(/\s*VPOS="[^"]*"\s*/g, ' ')
      .replace(/\s*HPOS="[^"]*"\s*/g, ' ')
      .replace(/\s*WIDTH="[^"]*"\s*/g, ' ')
      .replace(/\s*HEIGHT="[^"]*"\s*/g, ' ')
      .trim();
    return `<TextBlock ${newAttrs}>`;
  });

  // Normalize confidence values to 2 decimal places
  xmlStr = xmlStr.replace(/WC="(\d+(?:\.\d+)?)"/g, (_match, value) => {
    const numValue = parseFloat(value);
    if (Number.isNaN(numValue)) {
      throw new Error(`Invalid WC value: "${value}" cannot be parsed to a number`);
    }
    return `WC="${numValue.toFixed(2)}"`;
  });

  xmlStr = xmlStr.replace(/<SP\s+([^>]*)\/>/g, (_match, attrs) => {
    const newAttrs = attrs.replace(/\s*VPOS="[^"]*"\s*/g, ' ').trim();
    return `<SP ${newAttrs}/>`;
  });

  xmlStr = xmlStr.replace(/\s+/g, ' ').trim();
  xmlStr = xmlStr.replace(/>/g, '>\n');
  return xmlStr;
};

// Using arrow functions breaks references to `this`.

describe('Check .alto export function.', () => {
  test('Should correctly export and reimport text content', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH}/the_past.alto.xml`]);

    const text1Before = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text3Before = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const text1After = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text3After = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    expect(text1Before).toBe(text1After);
    expect(text3Before).toBe(text3After);
  });

  test('Should correctly export and reimport confidence scores', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH}/the_past.alto.xml`]);

    const word1Before = scribe.data.ocr.active[0].lines[0].words[0];
    const word2Before = scribe.data.ocr.active[0].lines[0].words[1];
    const conf1Before = word1Before.conf;
    const conf2Before = word2Before.conf;

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const word1After = scribe.data.ocr.active[0].lines[0].words[0];
    const word2After = scribe.data.ocr.active[0].lines[0].words[1];

    expect(Math.abs((word1After.conf) - (conf1Before))).toBeLessThanOrEqual(1);
    expect(Math.abs((word2After.conf) - (conf2Before))).toBeLessThanOrEqual(1);
  });

  test('Should correctly export and reimport font styles', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH}/the_past.alto.xml`]);

    const boldBefore1 = scribe.data.ocr.active[0].lines[0].words[0].style.bold;
    const boldBefore2 = scribe.data.ocr.active[0].lines[0].words[1].style.bold;

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const boldAfter1 = scribe.data.ocr.active[0].lines[0].words[0].style.bold;
    const boldAfter2 = scribe.data.ocr.active[0].lines[0].words[1].style.bold;

    expect(boldBefore1).toBe(boldAfter1);
    expect(boldBefore2).toBe(boldAfter2);
  });

  test('Should correctly export and reimport font family', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH}/the_past.alto.xml`]);

    const fontBefore = scribe.data.ocr.active[0].lines[0].words[0].style.font;

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const fontAfter = scribe.data.ocr.active[0].lines[0].words[0].style.font;

    expect(fontBefore).toBe(fontAfter);
  });

  test('Should match original ALTO XML structure after round-trip (content-only comparison)', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH}/simple_paragraph.alto.xml`]);

    const originalAltoStr = await readTextFileUniversal(`${ASSETS_PATH}/simple_paragraph.alto.xml`);
    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const normalizedOriginal = normalizeAlto(originalAltoStr);
    const normalizedExported = normalizeAlto(altoOutStr);

    expect(normalizedExported).toBe(normalizedOriginal);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check non-contiguous pageArr subsetting for .alto export.', () => {
  test('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedAlto = await scribe.exportData('alto', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    expect(exportedAlto).toContain('Comstock');
    // "Security" only appears on page 2 — should be present
    expect(exportedAlto).toContain('Security');
    // "Munger" only appears on page 1 — should not be present
    expect(exportedAlto).not.toContain('Munger');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
