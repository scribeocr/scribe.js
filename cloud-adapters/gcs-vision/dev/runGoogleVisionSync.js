import fs from 'fs';
import path from 'path';
import { OcrEngineGoogleVision } from '../ocrEngineGoogleVision.js';

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node runGoogleVisionSync.js <file>');
  console.error('');
  console.error('  <file>  Image file to process (PDF not supported by sync API)');
  process.exit(1);
}

const options = {
};

const result = await OcrEngineGoogleVision.recognizeFileSync(filePath, options);

if (!result.success) {
  console.error('Error:', result.error);
  process.exit(1);
}

const parsedPath = path.parse(filePath);
const suffix = 'GoogleVisionSync.json';

const outputFileName = `${parsedPath.name}-${suffix}`;
const outputPath = path.join(parsedPath.dir, outputFileName);
console.log(`Writing result to ${outputPath}`);
await fs.promises.writeFile(outputPath, JSON.stringify(result.data, null, 2));
