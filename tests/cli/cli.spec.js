import {
  describe, it, expect, beforeAll, beforeEach, afterEach, afterAll,
} from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import scribe from '../../scribe.js';
import {
  checkCLI, confCLI, detectPDFTypeCLI, extractCLI, overlayCLI, renderCLI, subsetCLI,
} from '../../cli/cli.js';
import { getRandomAlphanum } from '../../js/utils/miscUtils.js';
import { getPngDimensions } from '../../js/utils/imageUtils.js';
import { ASSETS_PATH } from '../module/_paths.js';

scribe.opt.workerN = 1;

/**
 * Build a 1-page PDF whose page content stream only invokes a Form XObject (`/Fm0 Do`),
 * so 100% of the visible text (~490 letters, well above any native-text threshold) lives inside it.
 * @returns {Uint8Array}
 */
function makeFormXObjectTextPdf() {
  const sentence = 'The entire visible text layer of this page is drawn inside a Form XObject.';
  let form = 'BT /F1 12 Tf 72 720 Td 14 TL\n';
  for (let i = 0; i < 8; i++) form += `(${sentence}) Tj T*\n`;
  form += 'ET';
  const pageContent = 'q 1 0 0 1 0 0 cm /Fm0 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(pageContent)} >>\nstream\n${pageContent}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Length ${Buffer.byteLength(form)} >>\nstream\n${form}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

// Warm the worker/OCR/font engine once before any test runs.
// This is necessary for tests to pass consistently on GitHub.
beforeAll(async () => {
  await scribe.init({ font: true, ocr: true });
  await scribe.terminate();
}, 120000);

describe('Check Node.js commands.', () => {
  let originalConsoleLog;
  let consoleOutput;

  // The temp directory used for testing must be different than the temp directory used in the application code,
  // as the latter is deleted at the end of the function.
  let tmpUniqueDir;
  const tmpUnique = {
    get: () => {
      if (!tmpUniqueDir) {
        tmpUniqueDir = `${tmpdir()}/${getRandomAlphanum(8)}`;
        fs.mkdirSync(tmpUniqueDir);
      }
      return tmpUniqueDir;
    },
    delete: () => {
      if (tmpUniqueDir) fs.rmSync(tmpUniqueDir, { recursive: true, force: true });
    },
  };

  beforeEach(() => {
    originalConsoleLog = console.log;
    consoleOutput = '';
    console.log = (...args) => {
      consoleOutput += args.join(' ');
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  it('Should print confidence of Abbyy .xml file.', async () => {
    await confCLI([`${ASSETS_PATH}/henreys_grave.abbyy.xml`]);
    expect(consoleOutput).toContain('178 of 185');
  }, 10000);

  it('Should check contents of Abbyy .xml file.', async () => {
    // CLI equivalent: node cli/scribe.js check tests/test-assets/henreys_grave.pdf tests/test-assets/henreys_grave.abbyy.xml
    // Workers is set to 1 to avoid results changing based on the number of CPU cores due to the OCR engine learning.
    await checkCLI([`${ASSETS_PATH}/henreys_grave.pdf`, `${ASSETS_PATH}/henreys_grave.abbyy.xml`], { workers: 1 });
    expect(consoleOutput).toMatch(/18[12] of 185/);
  }, 30000);

  // Regression: this PDF draws its entire text layer inside a Form XObject, with the page content stream doing only `/Fm0 Do`.
  // The no-output `type` branch's lean detectPdfType did not descend into it, so it counted zero characters and misreported the file as "Image native".
  it('Should classify a PDF whose text is entirely inside a Form XObject as Text native (`type`, no output path).', async () => {
    const pdfPath = `${tmpUnique.get()}/formxobj_text.pdf`;
    fs.writeFileSync(pdfPath, makeFormXObjectTextPdf());
    await detectPDFTypeCLI(pdfPath);
    expect(consoleOutput, '`type` (no output) must count Form-XObject-borne text and report Text native, not Image native').toContain('Text native');
  }, 30000);

  it('Should classify as Text native and write the surviving Form-XObject text (`type`, with output path).', async () => {
    const pdfPath = `${tmpUnique.get()}/formxobj_text_out.pdf`;
    fs.writeFileSync(pdfPath, makeFormXObjectTextPdf());
    const outputPath = `${tmpUnique.get()}/formxobj_type.txt`;
    await detectPDFTypeCLI(pdfPath, outputPath);
    expect(consoleOutput, '`type` (with output) must report Form-XObject-borne text as Text native').toContain('Text native');
    const extractedText = fs.readFileSync(outputPath, 'utf8');
    expect(extractedText, 'Form-XObject text must survive extraction via `type --output`').toContain('drawn inside a Form XObject');
  }, 60000);

  describe('overlayCLI on henreys_grave (vis mode) — output PDF contract', () => {
    /** @type {string} */
    let outputPath;
    /** @type {boolean} */
    let outputExists;
    /** @type {string} */
    let extractedText;
    /** @type {Map<string, number>} */
    let colorCounts;
    /** @type {Set<number>} */
    let opacities;

    beforeAll(async () => {
      const tmpDir = tmpUnique.get();
      await overlayCLI(
        [`${ASSETS_PATH}/henreys_grave.pdf`, `${ASSETS_PATH}/henreys_grave.abbyy.xml`],
        { output: tmpDir, vis: true },
      );
      outputPath = `${tmpDir}/henreys_grave_vis.pdf`;
      outputExists = fs.existsSync(outputPath);
      if (!outputExists) {
        extractedText = '';
        colorCounts = new Map();
        opacities = new Set();
        return;
      }
      const outputBytes = fs.readFileSync(outputPath);
      const outputArrayBuffer = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength);
      scribe.ScribeDoc.defaults.usePDFText.native.main = true;
      scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
      scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
      const doc = await scribe.openDocument({ pdfFiles: [outputArrayBuffer] });
      doc.ocr.active = doc.ocr.pdf;
      extractedText = /** @type {string} */ (await doc.exportData('text'));
      colorCounts = new Map();
      opacities = new Set();
      for (const page of doc.ocr.active) {
        for (const line of page.lines) {
          for (const w of line.words) {
            colorCounts.set(w.style.color, (colorCounts.get(w.style.color) || 0) + 1);
            opacities.add(w.style.opacity);
          }
        }
      }
      await doc.terminate();
    }, 20000);

    it('writes the expected output PDF to the requested directory', () => {
      expect(outputExists).toBe(true);
    });

    it('round-tripped PDF text contains the source word "HENRY"', () => {
      expect(extractedText).toContain('HENRY');
    });

    it('round-tripped PDF text contains the source word "GRAVE"', () => {
      expect(extractedText).toContain('GRAVE');
    });

    it('overlays 178 high-confidence words coloured green (#00ff80) per the Abbyy confidence scores', () => {
      expect(colorCounts.get('#00ff80')).toBe(178);
    });

    it('overlays 7 low-confidence words coloured red (#ff0000) per the Abbyy confidence scores', () => {
      expect(colorCounts.get('#ff0000')).toBe(7);
    });

    it('strips the input PDF\'s pre-existing invisible OCR layer (no third color leaks through)', () => {
      // If the strip regressed, the 195 default-black words from the input's
      // `3 Tr` layer would surface as a third color (#000000) here.
      expect(colorCounts.size).toBe(2);
    });

    it('every overlaid word renders at the proof-mode opacity of 0.8 (no opacity-0 leakage from input layer)', () => {
      expect([...opacities]).toEqual([0.8]);
    });
  });

  it('Overlay .pdf and Abbyy .xml file and print confidence.', async () => {
    const tmpDir = tmpUnique.get();
    await overlayCLI([`${ASSETS_PATH}/henreys_grave.pdf`, `${ASSETS_PATH}/henreys_grave.abbyy.xml`], { output: tmpDir, conf: true, vis: true });
    expect(consoleOutput).toContain('178 of 185');
    expect(fs.existsSync(`${tmpDir}/henreys_grave_vis.pdf`)).toBe(true);
  }, 20000);

  // TODO: The files should be deleted between tests;
  it('Overlay .pdf and Abbyy .xml file, validating OCR results.', async () => {
    const tmpDir = tmpUnique.get();
    await overlayCLI([`${ASSETS_PATH}/henreys_grave.pdf`, `${ASSETS_PATH}/henreys_grave.abbyy.xml`], { output: tmpDir, robust: true, vis: true });
    expect(fs.existsSync(`${tmpDir}/henreys_grave_vis.pdf`)).toBe(true);
  }, 30000);

  it('Overlay .pdf and Abbyy .xml file, validating OCR results and printing confidence.', async () => {
    const tmpDir = tmpUnique.get();
    await overlayCLI([`${ASSETS_PATH}/henreys_grave.pdf`, `${ASSETS_PATH}/henreys_grave.abbyy.xml`], {
      output: tmpDir, robust: true, conf: true, vis: true, workers: 1,
    });
    expect(consoleOutput).toMatch(/18[12] of 185/);
    expect(fs.existsSync(`${tmpDir}/henreys_grave_vis.pdf`)).toBe(true);
  }, 30000);

  afterAll(() => {
    tmpUnique.delete();
  });
});

describe('Extract CLI command.', () => {
  let tmpUniqueDir;
  const tmpUnique = {
    get: () => {
      if (!tmpUniqueDir) {
        tmpUniqueDir = `${tmpdir()}/${getRandomAlphanum(8)}`;
        fs.mkdirSync(tmpUniqueDir);
      }
      return tmpUniqueDir;
    },
    delete: () => {
      if (tmpUniqueDir) fs.rmSync(tmpUniqueDir, { recursive: true, force: true });
    },
  };

  it('Should extract text from a single PDF file.', async () => {
    const tmpDir = tmpUnique.get();
    const outputPath = `${tmpDir}/academic_article_1.txt`;

    await extractCLI(`${ASSETS_PATH}/academic_article_1.pdf`, outputPath, { format: 'txt' });

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('WHISTLEBLOWERS');
  }, 15000);

  // Regression gate: cli/extract.js must enable `usePDFText.ocr.main` so OCR-layer PDFs
  // (image pages with an invisible text layer) actually surface their text.
  it('Should extract text from a PDF whose pages are images with an invisible OCR layer.', async () => {
    // Reset to defaults so the CLI is forced to enable extraction itself rather than
    // inheriting `usePDFText.ocr.main = true` from a prior test.
    scribe.ScribeDoc.defaults.usePDFText.ocr.main = false;

    const tmpDir = tmpUnique.get();
    const outputPath = `${tmpDir}/scribe_test_pdf1.txt`;

    await extractCLI(`${ASSETS_PATH}/scribe_test_pdf1.pdf`, outputPath, { format: 'txt' });

    expect(fs.existsSync(outputPath)).toBe(true);
    const lines = fs.readFileSync(outputPath, 'utf8').split('\n');
    expect(lines.length).toBe(25);
    expect(lines[0]).toBe('henry’s grave.');
    expect(lines[2]).toBe('HENRY’S GRAVE. Standing beside the consecrated mound,');
  }, 15000);

  afterAll(() => {
    tmpUnique.delete();
  });
});

describe('Render CLI command.', () => {
  let tmpUniqueDir;
  const tmpUnique = {
    get: () => {
      if (!tmpUniqueDir) {
        tmpUniqueDir = `${tmpdir()}/${getRandomAlphanum(8)}`;
        fs.mkdirSync(tmpUniqueDir);
      }
      return tmpUniqueDir;
    },
    delete: () => {
      if (tmpUniqueDir) fs.rmSync(tmpUniqueDir, { recursive: true, force: true });
    },
  };

  it('Should render a single PDF page to a PNG at the requested DPI.', async () => {
    const tmpDir = tmpUnique.get();

    await renderCLI(`${ASSETS_PATH}/academic_article_1.pdf`, tmpDir, { dpi: '150', pages: '0' });

    const outputPath = `${tmpDir}/academic_article_1-0.png`;
    expect(fs.existsSync(outputPath)).toBe(true);

    const bytes = fs.readFileSync(outputPath);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4E);
    expect(bytes[3]).toBe(0x47);

    const { width, height } = getPngDimensions(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(width).toBe(1013);
    expect(height).toBe(1500);
  }, 20000);

  afterAll(() => {
    tmpUnique.delete();
  });
});

describe('Subset CLI command.', () => {
  let tmpUniqueDir;
  const tmpUnique = {
    get: () => {
      if (!tmpUniqueDir) {
        tmpUniqueDir = `${tmpdir()}/${getRandomAlphanum(8)}`;
        fs.mkdirSync(tmpUniqueDir);
      }
      return tmpUniqueDir;
    },
    delete: () => {
      if (tmpUniqueDir) fs.rmSync(tmpUniqueDir, { recursive: true, force: true });
    },
  };

  /** @type {boolean} */
  let outputExists;
  /** @type {boolean} */
  let validPdfHeader;
  /** @type {number} */
  let pageCount;
  /** @type {string} */
  let page0Text;
  /** @type {string} */
  let page1Text;

  beforeAll(async () => {
    const tmpDir = tmpUnique.get();
    const outputPath = `${tmpDir}/iris-subset.pdf`;
    await subsetCLI(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`, outputPath, { pages: '0,2' });

    outputExists = fs.existsSync(outputPath);
    const outputBytes = fs.readFileSync(outputPath);
    validPdfHeader = outputBytes.subarray(0, 5).toString('latin1') === '%PDF-';

    const ab = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength);
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    const doc = await scribe.openDocument({ pdfFiles: [ab] });
    doc.ocr.active = doc.ocr.pdf;
    pageCount = doc.inputData.pageCount;
    page0Text = /** @type {string} */ (await doc.exportData('text', { minPage: 0, maxPage: 0 }));
    page1Text = /** @type {string} */ (await doc.exportData('text', { minPage: 1, maxPage: 1 }));
    await doc.terminate();
  }, 20000);

  it('writes the subset PDF to the requested path', () => {
    expect(outputExists).toBe(true);
  });

  it('writes a valid PDF (header starts with %PDF-)', () => {
    expect(validPdfHeader).toBe(true);
  });

  it('keeps exactly the 2 requested pages out of the 3-page input', () => {
    expect(pageCount).toBe(2);
  });

  it('keeps input page 0 as subset page 0 (retains the "Iris (plant)" title)', () => {
    expect(page0Text).toContain('Iris (plant)');
  });

  it('keeps input page 2 as subset page 1, dropping page 1', () => {
    // This phrase is unique to input page 2. It is absent from the dropped page 1.
    expect(page1Text).toContain('non-receptive lower face of the stigma');
  });

  it('derives a page-range filename when the output is a directory', async () => {
    const tmpDir = tmpUnique.get();
    await subsetCLI(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`, tmpDir, { pages: '0,2' });
    expect(fs.existsSync(`${tmpDir}/Iris (plant) - Wikipedia_123-p0_2.pdf`)).toBe(true);
  });

  afterAll(() => {
    tmpUnique.delete();
  });
});
