/* eslint-disable import/no-relative-packages */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { toolHandlers, resetState } from '../../mcp/tools.js';
import {
  findXrefOffset, parseXref, ObjectCache, getPageObjects,
} from '../../js/pdf/parsePdfUtils.js';

/** @param {Uint8Array} pdfBytes */
function countPdfPages(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  return getPageObjects(objCache).length;
}

scribe.opt.workerN = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', 'test-assets');
const TMP = path.resolve(__dirname, '..', '..', 'tmp');

// MCP tests are Node-only (they use fs paths).
const describeNode = typeof process !== 'undefined' ? describe : describe.skip;

describeNode('MCP tool: load_document', function () {
  this.timeout(10000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should load complaint_1.pdf with companion data', async () => {
    const result = await toolHandlers.load_document({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
    });
    assert.strictEqual(result.pageCount, 2);
    assert.strictEqual(result.hasOcrData, true);
  });
});

describeNode('MCP tool: extract_document_text', function () {
  this.timeout(20000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should extract text with page:line prefixes', async () => {
    const result = await toolHandlers.extract_document_text({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
    });
    assert.isString(result.text);
    assert.match(result.text, /^0:0\s/m);
    assert.strictEqual(result.startPage, 0);
    assert.strictEqual(result.endPage, 1);
    assert.strictEqual(result.pageCount, 2);
    assert.strictEqual(result.hasMore, false);
  });

  it('Should write full text to outputPath', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_extract_test.txt');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const result = await toolHandlers.extract_document_text({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
      outputPath,
    });
    assert.isTrue(fs.existsSync(outputPath));
    assert.strictEqual(result.charCount, 4635);
    assert.strictEqual(result.pageCount, 2);
    fs.unlinkSync(outputPath);
  });

  it('Should paginate with startPage and maxChars', async () => {
    const result = await toolHandlers.extract_document_text({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
      startPage: 0,
      maxChars: 500,
    });
    assert.strictEqual(result.startPage, 0);
    assert.strictEqual(result.endPage, 0);
    assert.strictEqual(result.hasMore, true);
  });
});

describeNode('MCP tool: create_highlighted_pdf', function () {
  this.timeout(20000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should create a highlighted PDF with 3 lines highlighted', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_highlight_test.pdf');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const result = await toolHandlers.create_highlighted_pdf({
      file: path.join(ASSETS, 'complaint_1.pdf'),
      dataFile: path.join(ASSETS, 'complaint_1.abbyy.xml'),
      outputPath,
      highlights: [{ page: 0, startLine: 0, endLine: 2 }],
    });
    assert.isTrue(fs.existsSync(outputPath));
    assert.strictEqual(result.highlightsApplied, 1);
    assert.strictEqual(result.totalLinesHighlighted, 3);
    fs.unlinkSync(outputPath);
  });
});

describeNode('MCP tool: subset_pdf', function () {
  this.timeout(10000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should extract pages 0 and 2 from a 12-page PDF', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_subset_test.pdf');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const result = await toolHandlers.subset_pdf({
      file: path.join(ASSETS, 'CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf'),
      outputPath,
      pages: [0, 2],
    });
    assert.isTrue(fs.existsSync(outputPath));
    assert.strictEqual(result.outputPages, 2);
    assert.deepEqual(result.pagesIncluded, [0, 2]);
    assert.strictEqual(countPdfPages(new Uint8Array(fs.readFileSync(outputPath))), 2);
    fs.unlinkSync(outputPath);
  });
});

describeNode('MCP tool: merge_pdfs', function () {
  this.timeout(10000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should merge complaint_1 (2 pages) and academic_article_1 (1 page) into 3 pages', async () => {
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
    assert.isTrue(fs.existsSync(outputPath));
    assert.strictEqual(countPdfPages(new Uint8Array(fs.readFileSync(outputPath))), 3);
    fs.unlinkSync(outputPath);
  });
});

describeNode('MCP tool: define_tables + extract_tables', function () {
  this.timeout(20000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should define 1 table with 2 rows and report creation metadata', async () => {
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
    assert.strictEqual(result.tablesCreated, 1);
    assert.strictEqual(result.totalRows, 2);
    assert.strictEqual(result.page, 0);
  });
});

describeNode('MCP tool: convert_docx_to_json', function () {
  this.timeout(20000);

  afterEach(async () => {
    resetState();
    await scribe.terminate();
  });

  it('Should convert iris.docx to valid scribe.json', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const outputPath = path.join(TMP, 'mcp_docx_test.scribe.json');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    await toolHandlers.convert_docx_to_json({
      file: path.join(ASSETS, 'iris.docx'),
      outputPath,
    });
    assert.isTrue(fs.existsSync(outputPath));
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.isObject(parsed);
    fs.unlinkSync(outputPath);
  });
});
