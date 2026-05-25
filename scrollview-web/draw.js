import fs from 'fs';
import path from 'path';
import { ScrollView } from './scrollview/ScrollView.js';
import { writeCanvasNodeAll } from './src/ScrollViewNode.js';

const filePath = process.argv[2];
const outputDir = process.argv[3] || '.';
const fileBase = `${outputDir}/${path.basename(filePath)}`;

if (!filePath) {
  console.error('Please provide a file path as an argument.');
  process.exit(1);
}

const sv = new ScrollView({
  lightTheme: true,
});

const inputData = fs.readFileSync(filePath, { encoding: 'utf-8' });

await sv.processVisStr(inputData);

const visObj = await sv.getAll(false);

writeCanvasNodeAll(visObj, fileBase);
