import { Command, Option } from 'commander';

import {
  checkCLI,
  confCLI,
  debugCLI,
  detectPDFTypeCLI,
  evalInternalCLI, extractCLI, overlayCLI, recognizeCLI,
} from './cli.js';

const program = new Command();

program
  .command('conf')
  .argument('<ocr_file>', 'Input OCR file.  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .description('Calculate confidence metric for OCR data using existing confidence info in the provided data.')
  .action(confCLI);

program
  .command('check')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('<ocr_file>', 'Input OCR file.  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .description('Calculate confidence metric for OCR data by running Tesseract OCR and comparing results.')
  .action(checkCLI);

program
  .command('eval')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('<ocr_file>', 'Input OCR file.  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .description('Evaluate internal OCR engine by recognizing document (provided PDF file), and comparing to ground truth (provided OCR file).')
  .action(evalInternalCLI);

program
  .command('extract')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('[output]', 'Output directory or file to save results.', '.')
  .addOption(new Option('-f, --format <ext>', 'Output format.').choices(['pdf', 'hocr', 'docx', 'xlsx', 'txt', 'text', 'html']).default('txt'))
  .option('-r, --reflow', 'Reflow text by combining lines into paragraphs.')
  .description('Extract text from PDF file and save in requested format.')
  .action(extractCLI);

program
  .command('overlay')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('<ocr_file>', 'Input OCR file.  Accepts .hocr and Abbyy .xml (with character-level data enabled).')
  .argument('[output_dir]', 'Directory for output file(s).', '.')
  .option('-v, --vis', 'Print OCR text visibly over provided PDF file with colors coded by confidence.')
  .option('-c, --conf', 'Print average confidence metric for document.')
  .option('-r, --robust', 'Generate confidence metrics by running Tesseract OCR and comparing, rather than using confidence info in provided data.')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .description('Add OCR data to provided PDF file and save result as PDF.')
  .action(overlayCLI);

program
  .command('recognize')
  .argument('<pdf_file>', 'Input PDF file.')
  .description('Recognize text in PDF file using internal OCR engine.')
  .option('-v, --vis', 'Print OCR text visibly over provided PDF file with colors coded by confidence.')
  .option('-h, --hocr', 'Output .hocr intermediate data in addition to .pdf.')
  .option('-w, --workers <number>', 'Number of workers to use. Default is up to 8.')
  .action(recognizeCLI);

program
  .command('type')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('[output]', 'Output file path to save text.')
  .description('Detect PDF file type (\'Text native\', \'Image + OCR text\', or \'Image native\').')
  .action(detectPDFTypeCLI);

program
  .command('debug')
  .argument('<pdf_file>', 'Input PDF file.')
  .argument('[output_dir]', 'Directory for output file(s).', '.')
  .option('--list <items>', 'Comma separated list of visualizations to include.', (value) => value.split(','))
  .description('Generate and write Tesseract debugging images.')
  .action(debugCLI);

program.parse(process.argv);
