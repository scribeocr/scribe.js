import {
  describe, it, expect, beforeEach, afterEach, afterAll,
} from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import scribe from '../../scribe.js';
import {
  checkCLI, confCLI, extractCLI, overlayCLI,
} from '../../cli/cli.js';
import { getRandomAlphanum } from '../../js/utils/miscUtils.js';
import { ASSETS_PATH } from '../module/_paths.js';

scribe.opt.workerN = 1;

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
    console.log = (output) => {
      consoleOutput += output;
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
    expect(consoleOutput).toContain('181 of 185');
  }, 30000);

  it('Overlay .pdf and Abbyy .xml file.', async () => {
    const tmpDir = tmpUnique.get();
    await overlayCLI([`${ASSETS_PATH}/henreys_grave.pdf`, `${ASSETS_PATH}/henreys_grave.abbyy.xml`], { output: tmpDir, vis: true });
    expect(fs.existsSync(`${tmpDir}/henreys_grave_vis.pdf`)).toBe(true);
  }, 20000);

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
    expect(consoleOutput).toContain('181 of 185');
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

  afterAll(() => {
    tmpUnique.delete();
  });
});
