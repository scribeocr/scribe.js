#!/usr/bin/env node

import { Command, Option } from 'commander';

import {
  checkCLI,
  confCLI,
  debugCLI,
  detectPDFTypeCLI,
  evalInternalCLI, extractCLI, metadataCLI, overlayCLI, recognizeCLI, renderCLI, stripMetadataCLI, subsetCLI,
} from './cli.js';
import { parseModelOption, recognitionModels } from './recognitionModels.js';

const program = new Command();

program
  .command('conf')
  .argument('<ocr_file>', 'Input OCR file.  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Calculate confidence metric for OCR data using existing confidence info in the provided data.')
  .action(confCLI);

program
  .command('check')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .argument('<files...>', 'Input PDF file and OCR file(s).  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Calculate confidence metric for OCR data by running Tesseract OCR and comparing results.')
  .action(checkCLI);

program
  .command('eval')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .argument('<files...>', 'Input PDF file and OCR file(s).  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Evaluate internal OCR engine by recognizing document (provided PDF file), and comparing to ground truth (provided OCR file).')
  .action(evalInternalCLI);

program
  .command('extract')
  .argument('<input_file>', 'Input PDF file or directory (with --dir).')
  .argument('[output]', 'Output directory or file to save results.', '.')
  .addOption(new Option('-f, --format <ext>', 'Output format.').choices(['pdf', 'hocr', 'docx', 'xlsx', 'txt', 'text', 'html', 'md']).default('txt'))
  .option('-r, --reflow', 'Reflow text by combining lines into paragraphs.')
  .option('-d, --dir', 'Process all supported files in the input directory.')
  .option('-l, --line-numbers', 'Prepend page:line numbers to each line (e.g. 0:5  text). Only applies to txt format.')
  .description('Extract existing text from a PDF file and save in requested format (does not run OCR; use `recognize` for that).')
  .action(extractCLI);

program
  .command('overlay')
  .option('-o, --output <directory>', 'Directory for output file(s). Default is current directory.')
  .option('-v, --vis', 'Print OCR text visibly over provided PDF file with colors coded by confidence.')
  .option('-c, --conf', 'Print average confidence metric for document.')
  .option('-r, --robust', 'Generate confidence metrics by running Tesseract OCR and comparing, rather than using confidence info in provided data.')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .argument('<files...>', 'Input PDF file and OCR file(s).  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Add OCR data to provided PDF file and save result as PDF.')
  .action(overlayCLI);

program
  .command('recognize')
  .option('-o, --output <directory>', 'Directory for output file(s). Default is current directory.')
  .option('-v, --vis', 'Print OCR text visibly over provided PDF file with colors coded by confidence.')
  .option('-h, --hocr', 'Output .hocr intermediate data in addition to .pdf.')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .option('--model <name>', `Cloud recognition model. One of: ${Object.keys(recognitionModels).join(', ')}. Requires the matching @scribe.js/* adapter package. Default: built-in model.`)
  .option('-O, --model-option <key=value>', 'Option forwarded to the cloud model (e.g. --model-option region=us-east-1). Repeatable.', parseModelOption, {})
  .option('--local-adapters', 'Resolve --model from this repo\'s cloud-adapters/ tree instead of npm. For running from a scribe.js checkout. Also enabled by SCRIBE_LOCAL_ADAPTERS=1.')
  .addOption(new Option(
    '--ocr-pages <pages>',
    'Which pages to OCR. autoShallow: leave text-native docs alone, OCR only detected scanned sections; '
    + 'autoDeep (alias auto): also OCR lone image pages and image-borne text; all/none: every/no page.',
  ).choices(['all', 'auto', 'autoShallow', 'autoDeep', 'none']).default('autoShallow'))
  .argument('<files...>', 'Input PDF file and OCR file(s).  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Recognize text in PDF file using internal OCR engine or a cloud model.')
  .action(recognizeCLI);

program
  .command('render')
  .argument('<input_file>', 'Input PDF file.')
  .argument('[output]', 'Output directory for page images.', '.')
  .option('--dpi <number>', 'Render resolution in dots per inch.', '150')
  .option('--pages <range>', 'Comma/range list of 0-based pages to render (e.g. 0-4,7). Default: all.')
  .option('--gray', 'Render in grayscale instead of color.')
  .description('Render each page of a PDF to a PNG image.')
  .action(renderCLI);

program
  .command('subset')
  .argument('<input_file>', 'Input PDF file.')
  .argument('[output]', 'Output PDF file, or directory to write <stem>-p<pages>.pdf into.', '.')
  .option('--pages <range>', 'Comma/range list of 0-based pages to keep (e.g. 0-4,7).')
  .description('Write a new PDF containing only the selected pages of the input PDF.')
  .action(subsetCLI);

program
  .command('metadata')
  .argument('<pdf_file>', 'Input PDF file.')
  .option('--json', 'Emit the full metadata report as JSON.')
  .option('-o, --output <file>', 'With --json, write the report to this file instead of stdout.')
  .description('List every category of identifying metadata embedded in a PDF (does not modify the file).')
  .action(metadataCLI);

program
  .command('strip-metadata')
  .argument('<input_file>', 'Input PDF file.')
  .argument('[output]', 'Output PDF file, or directory to write <stem>-clean.pdf into.', '.')
  .option('--strip-tags', 'Also remove accessibility structure tags (kept by default).')
  .option('--strip-page-labels', 'Also remove page labels (kept by default).')
  .option('--strip-viewer-prefs', 'Also remove viewer preferences (kept by default).')
  .option('--drop-layers', 'Also drop optional-content (layer) configuration (kept by default).')
  .description('Write a privacy-cleaned copy of a PDF with identifying metadata removed; visible pages unchanged.')
  .action(stripMetadataCLI);

program
  .command('type')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('[output]', 'Output file path to save text.')
  .description('Detect PDF file type (\'Text native\', \'Image + OCR text\', or \'Image native\').')
  .action(detectPDFTypeCLI);

program
  .command('debug')
  .option('-o, --output <directory>', 'Directory for output file(s). Default is current directory.')
  .argument('[output_dir]', 'Directory for output file(s).', '.')
  .option('--list <items>', 'Comma separated list of visualizations to include.', (value) => value.split(','))
  .argument('<files...>', 'Input PDF file and OCR file(s).  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Generate and write Tesseract debugging images.')
  .action(debugCLI);

program.parse(process.argv);
