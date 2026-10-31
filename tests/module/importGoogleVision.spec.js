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

describe('Check Google Vision JSON import function.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/ascenders_descenders_test_GoogleVision.json`]);
  });

  test('Should correctly import text content from AWS Textract (default settings)', async () => {
    const text1 = doc.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = doc.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = doc.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    expect(text1).toBe('Ascenders On');
    expect(text2).toBe('query png');
    expect(text3).toBe('we can');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that text orientation is handled correctly in Google Vision imports.', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let docRot;
  beforeAll(async () => {
    docRot = await scribe.openDocument([`${ASSETS_PATH}/econometrica_example_all_orientations-GoogleVision.json`]);
  });

  test('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    const orientations = docRot.ocr.active.map((page) => page.lines[0].words[0].line.orientation);
    expect(orientations, 'three pages upright, three reading upward, three upside down, three reading downward').toEqual([0, 0, 0, 3, 3, 3, 2, 2, 2, 1, 1, 1]);
  });

  // Vision reads each page on its own, so a turned page's boxes differ from the upright page's by a few pixels.
  const roundBbox = (/** @type {{left: number, top: number, right: number, bottom: number}} */ b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)]));
  test('Lines oriented at 90 degrees counterclockwise have coordinates calculated correctly', async () => {
    const upright = docRot.ocr.active[0].lines[2].words[0];
    expect(upright.text, 'the compared word on the upright page').toBe('WALRAS');
    expect(roundBbox(upright.bbox), 'the box of the compared word on the upright page').toEqual({
      left: 713, top: 266, right: 897, bottom: 298,
    });
    const word = docRot.ocr.active[3].lines[2].words[0];
    expect(word.text, 'the compared word on the page reading upward').toBe('WALRAS');
    expect(roundBbox(word.bbox), 'the box of a line reading upward, in its frame, lands where the upright page has it').toEqual({
      left: 713, top: 264, right: 900, bottom: 296,
    });
  });

  test('Lines oriented at 90 degrees clockwise have coordinates calculated correctly', async () => {
    const word = docRot.ocr.active[9].lines[2].words[0];
    expect(word.text, 'the compared word on the page reading downward').toBe('WALRAS');
    expect(roundBbox(word.bbox), 'the box of a line reading downward, in its frame, lands where the upright page has it').toEqual({
      left: 713, top: 269, right: 897, bottom: 301,
    });
  });

  test('Lines oriented at 180 degrees have coordinates calculated correctly', async () => {
    const word = docRot.ocr.active[6].lines[2].words[0];
    expect(word.text, 'the compared word on the upside-down page').toBe('WALRAS');
    expect(roundBbox(word.bbox), 'the box of an upside-down line, in its frame, lands where the upright page has it').toEqual({
      left: 713, top: 267, right: 898, bottom: 300,
    });
  });

  test('A line reading downward is stored in its upright frame', async () => {
    const line = docRot.ocr.active[9].lines[5];
    expect(roundBbox(line.bbox), 'the frame box of a line reading downward').toEqual({
      left: 712, top: 457, right: 1354, bottom: 493,
    });
  });

  test('A paragraph on a page reading downward is stored in its lines\' frame', async () => {
    const line = docRot.ocr.active[9].lines[5];
    expect(line.par.lines.length, 'the paragraph of the compared line holds that line alone').toBe(1);
    expect(roundBbox(line.par.bbox), 'the paragraph box of a line reading downward, in the line\'s frame').toEqual({
      left: 712, top: 457, right: 1354, bottom: 493,
    });
  });

  // The split that puts stacked margin numbers on separate lines would cut a sideways line at nearly every word if it compared page-space boxes.
  test('The words of a sideways line stay on one line', async () => {
    const down = docRot.ocr.active[9];
    expect(down.lines.length, 'line count of a page whose text reads downward').toBe(52);
    expect(down.lines[5].words.map((x) => x.text).join(' '), 'a line reading downward keeps its words').toBe('Department of Economics , UPF Barcelona');
    const up = docRot.ocr.active[3];
    expect(up.lines.length, 'line count of a page whose text reads upward').toBe(52);
    expect(up.lines[5].words.map((x) => x.text).join(' '), 'a line reading upward keeps its words').toBe('Department of Economics , UPF Barcelona');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
