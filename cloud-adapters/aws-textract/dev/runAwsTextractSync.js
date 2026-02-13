import fs from 'fs';
import path from 'path';
import { OcrEngineAWSTextract } from '../ocrEngineAwsTextract.js';

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node runAwsTextractSync.js <file> [--layout] [--tables]');
  console.error('');
  console.error('  <file>     Image file to process (PDF not supported by sync API)');
  console.error('  --layout   Enable layout analysis');
  console.error('  --tables   Enable table analysis');
  process.exit(1);
}

const options = {
  analyzeLayout: args.includes('--layout'),
  analyzeLayoutTables: args.includes('--tables'),
};

const result = await OcrEngineAWSTextract.recognizeFileSync(filePath, options);

if (!result.success) {
  console.error('Error:', result.error);
  process.exit(1);
}

const parsedPath = path.parse(filePath);
let suffix = 'AwsTextractSync.json';
if (options.analyzeLayout) {
  suffix = 'AwsTextractLayoutSync.json';
}

const outputFileName = `${parsedPath.name}-${suffix}`;
const outputPath = path.join(parsedPath.dir, outputFileName);
console.log(`Writing result to ${outputPath}`);
await fs.promises.writeFile(outputPath, JSON.stringify(result.data, null, 2));
