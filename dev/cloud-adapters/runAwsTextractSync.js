import fs from 'fs';
import path from 'path';
import scribe from '../../scribe.js';
import { RecognitionModelTextract } from '../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';

const args = process.argv.slice(2);
const splitMode = args.includes('--split');
const regionsArgIdx = args.indexOf('--regions');
const regionsValue = regionsArgIdx !== -1 ? args[regionsArgIdx + 1] : null;
const regions = regionsValue ? regionsValue.split(',').map((r) => r.trim()).filter(Boolean) : null;
// Skip values that are flags or the regions value when finding the file path.
const skipIndices = new Set(regionsArgIdx !== -1 ? [regionsArgIdx, regionsArgIdx + 1] : []);
const filePath = args.find((a, i) => !a.startsWith('--') && !skipIndices.has(i));

if (!filePath) {
  console.error('Usage: node runAwsTextractSync.js <file> [--layout] [--tables] [--split] [--regions us-east-1,us-west-2,...]');
  console.error('');
  console.error('  <file>       Image or PDF file to process');
  console.error('  --layout     Enable layout analysis');
  console.error('  --tables     Enable table analysis');
  console.error('  --split      Write separate files per page instead of combining (PDF only)');
  console.error('  --regions    Comma-separated AWS regions for multi-region throughput scaling.');
  console.error('               Textract rate limits are per-region, so using N regions ≈ N× throughput.');
  console.error('               Omit to use a single region (from AWS_REGION env var or SDK defaults).');
  console.error('');
  console.error('AWS credentials and region must be configured via one of:');
  console.error('  - AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY env vars');
  console.error('  - ~/.aws/credentials and ~/.aws/config files (with optional AWS_PROFILE)');
  console.error('  - IAM role (when running on EC2/ECS/Lambda)');
  process.exit(1);
}

const modelOptions = {
  analyzeLayout: args.includes('--layout'),
  analyzeTables: args.includes('--tables'),
  ...(regions && regions.length > 1 && { region: regions }),
};

if (regions && regions.length > 1) {
  console.log(`Multi-region mode: distributing requests across ${regions.length} regions (${regions.join(', ')})`);
}

scribe.opt.keepRawData = true;
scribe.opt.printRecognitionTime = true;

await scribe.importFiles([filePath]);

console.log(`Processing ${scribe.inputData.pageCount} pages...`);

await scribe.recognize({
  model: RecognitionModelTextract,
  modelOptions,
});

const parsedPath = path.parse(filePath);
let suffix = 'AwsTextractSync.json';
if (modelOptions.analyzeLayout) {
  suffix = 'AwsTextractLayoutSync.json';
}

const rawData = scribe.data.ocrRaw.active;

if (!splitMode) {
  const pageResults = rawData.map((r) => JSON.parse(r));
  const combined = RecognitionModelTextract.combineTextractResponses(pageResults);
  const outputFileName = `${parsedPath.name}-${suffix}`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing combined result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(combined, null, 2));
} else {
  for (let i = 0; i < rawData.length; i++) {
    const outputFileName = `${parsedPath.name}-p${i}-${suffix}`;
    const outputPath = path.join(parsedPath.dir, outputFileName);
    console.log(`Writing result to ${outputPath}`);
    await fs.promises.writeFile(outputPath, JSON.stringify(JSON.parse(rawData[i]), null, 2));
  }
}

await scribe.terminate();
console.log('Done.');
