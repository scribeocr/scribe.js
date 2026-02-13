import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OcrEngineAWSTextract } from '../ocrEngineAwsTextract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Note: The sync interface does not support .pdf files.
const filePath = path.join(__dirname, './assets/trident_v_connecticut_general/trident_v_connecticut_general_006.png');

const options = {
  analyzeLayout: true,
  analyzeLayoutTables: true,
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
