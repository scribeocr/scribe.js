#!/usr/bin/env node
// Run `node examples/node/recognize-basic.js path/to/image.jpg` to recognize text in an image.
import scribe from '../../scribe.js';

const [,, imagePath] = process.argv;

(async () => {
  const res = await scribe.recognizeFiles([imagePath]);
  console.log(res);
  await scribe.terminate();
})();
