import {
  describe, test, expect, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import scribe from '../../scribe.js';
import { toolHandlers, resetState } from '../../mcp/tools.js';
import {
  findXrefOffset, parseXref, ObjectCache, getPageObjects,
} from '../../js/pdf/parsePdfUtils.js';

scribe.opt.workerN = 1;

// MCP tools touch the filesystem (paths, output files), so the suite is
// inherently Node-only. Skip the whole file under browser projects.
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
const describeNode = isNode ? describe : describe.skip;

/** @param {Uint8Array} pdfBytes */
function countPdfPages(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  return getPageObjects(objCache).length;
}

const __dirname = isNode ? path.dirname(fileURLToPath(import.meta.url)) : '';
const ASSETS = isNode ? path.resolve(__dirname, '..', 'test-assets') : '';
const TMP = isNode ? path.resolve(__dirname, '..', '..', 'tmp') : '';

describeNode('MCP tool: load_document', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should load complaint_1.pdf with companion data', async () => {
    const result = await toolHandlers.load_document({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
    });
    expect(result.pageCount).toBe(2);
    expect(result.hasOcrData).toBe(true);
  });
});

describeNode('MCP tool: extract_document_text', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should extract text with page:line prefixes', async () => {
    const result = await toolHandlers.extract_document_text({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
    });
    expect(typeof result.text).toBe('string');
    expect(result.text).toMatch(/^0:0\s/m);
    expect(result.startPage).toBe(0);
    expect(result.endPage).toBe(1);
    expect(result.pageCount).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  test('Should write full text to outputPath', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_extract_test.txt');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const result = await toolHandlers.extract_document_text({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.charCount).toBe(4635);
    expect(result.pageCount).toBe(2);
    fs.unlinkSync(outputPath);
  });

  test('Should paginate with startPage and maxChars', async () => {
    const result = await toolHandlers.extract_document_text({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
      startPage: 0,
      maxChars: 500,
    });
    expect(result.startPage).toBe(0);
    expect(result.endPage).toBe(0);
    expect(result.hasMore).toBe(true);
  });
});

describeNode('MCP tool: create_highlighted_pdf', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should create a highlighted PDF with 3 lines highlighted', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_highlight_test.pdf');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const result = await toolHandlers.create_highlighted_pdf({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
      outputPath,
      highlights: [{ page: 0, startLine: 0, endLine: 2 }],
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.highlightsApplied).toBe(1);
    expect(result.totalLinesHighlighted).toBe(3);
    fs.unlinkSync(outputPath);
  });
});

describeNode('MCP tool: subset_pdf', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should extract pages 0 and 2 from a 12-page PDF', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_subset_test.pdf');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const result = await toolHandlers.subset_pdf({
      file: path.join(ASSETS, 'CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf'),
      outputPath,
      pages: [0, 2],
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.outputPages).toBe(2);
    expect(result.pagesIncluded).toEqual([0, 2]);
    expect(countPdfPages(new Uint8Array(fs.readFileSync(outputPath)))).toBe(2);
    fs.unlinkSync(outputPath);
  });
});

describeNode('MCP tool: merge_pdfs', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should merge complaint_1 (2 pages) and academic_article_1 (1 page) into 3 pages', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_merge_test.pdf');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    await toolHandlers.merge_pdfs({
      files: [
        { file: path.join(ASSETS, 'complaint_1.pdf') },
        { file: path.join(ASSETS, 'academic_article_1.pdf') },
      ],
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(countPdfPages(new Uint8Array(fs.readFileSync(outputPath)))).toBe(3);
    fs.unlinkSync(outputPath);
  });
});

describeNode('MCP tool: define_tables + extract_tables', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should define 1 table with 2 rows and report creation metadata', async () => {
    await toolHandlers.load_document({
      file: path.join(ASSETS, 'border_patrol_tables.pdf'),
      dataFile: path.join(ASSETS, 'border_patrol_tables.abbyy.xml'),
    });

    const result = await toolHandlers.define_tables({
      page: 0,
      tables: [{
        rows: [
          ['Name', 'Value'],
          ['Alice', '100'],
        ],
      }],
    });
    expect(result.tablesCreated).toBe(1);
    expect(result.totalRows).toBe(2);
    expect(result.page).toBe(0);
  });
});

describeNode('MCP tool: convert_docx_to_json', () => {
  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  test('Should convert iris.docx to valid scribe.json', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_docx_test.scribe.json');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    await toolHandlers.convert_docx_to_json({
      file: path.join(ASSETS, 'iris.docx'),
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    fs.unlinkSync(outputPath);
  });
});
