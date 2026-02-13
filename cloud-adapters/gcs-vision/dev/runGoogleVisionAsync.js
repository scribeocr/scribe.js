import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OcrEngineGoogleVision } from '../ocrEngineGoogleVision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = path.join(__dirname, './assets/Prof. Houde FTC White Paper - abridged.pdf');

const combineResponses = true;

const options = {
  gcsBucket: 'vision-test-misc-us-east-1',
};

const result = await OcrEngineGoogleVision.recognizeFileAsync(filePath, options);

if (!result.success) {
  console.error('Error:', result.error);
  process.exit(1);
}

const parsedPath = path.parse(filePath);
const suffix = 'GoogleVision.json';

if (combineResponses) {
  const outputFileName = `${parsedPath.name}-${suffix}`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing combined result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(OcrEngineGoogleVision.combineGoogleVisionAsyncResponses(result.data), null, 2));
} else {
  for (let i = 0; i < result.data.length; i++) {
    const outputFileName = `${parsedPath.name}-p${i}-${suffix}`;
    const outputPath = path.join(parsedPath.dir, outputFileName);
    console.log(`Writing result to ${outputPath}`);
    await fs.promises.writeFile(outputPath, JSON.stringify(result.data[i], null, 2));
  }
}
