# Scribe.js
Scribe.js is a JavaScript library that performs OCR and extracts text from images and PDFs.  

Common use cases:
1. Recognize text from images.
2. Extract text from user-uploaded `.pdf` files.
	1. If the `.pdf` file is already text-native, scribe.js can extract the existing text.
	2. If the `.pdf` file is image-native, scribe.js can recognize text using OCR.
3. Write `.pdf` files that include a high-quality invisible text layer.
	1. scribe.js can insert text into an existing `.pdf` file, making it searchable.

Scribe.js is a library intended for developers.  End users who want to scan documents should see the officially-supported GUI at [scribeocr.com](https://scribeocr.com/) (repo [here](https://github.com/scribeocr/scribeocr)).

# Setup
Install from `npm` by running the following:
```sh
npm i scribe.js-ocr
```

Scribe.js is written in JavaScript using ESM, so can be imported directly from browser or Node.js JavaScript code without a build step.
```js
// Import statement in browser:
import scribe from 'node_modules/scribe.js-ocr/scribe.js';
// Import statement for Node.js:
import scribe from 'scribe.js-ocr';

// Basic usage
scribe.extractText(['https://tesseract.projectnaptha.com/img/eng_bw.png'])
	.then((res) => console.log(res))
```

When using Scribe.js in the browser, all files must be served from the same origin as the file importing Scribe.js.  This means that importing Scribe.js from a CDN will not work.  There is no UMD version.

# Templates
The following are template repos showing how Scribe.js can be used within various frameworks/build systems.  

- Browser with ESM (no build): https://github.com/scribeocr/scribe.js-example-esm-browser
- Browser with Next.js: https://github.com/scribeocr/scribe.js-example-next.js
- Browser with Webpack 5: https://github.com/scribeocr/scribe.js-example-webpack5
- Browser with Vue.js v2: https://github.com/scribeocr/scribe.js-example-vue2

Contributions are appreciated--if you are using Scribe.js within a framework not listed below, consider making a basic repo and adding to this list with a PR, especially if non-obvious steps were required.

# Scribe.js vs. Tesseract.js
Considering whether Scribe.js or Tesseract.js is better for your project?  Read [this article](./docs/scribe_vs_tesseract.md).

# Documentation
- [Basic Browser Examples](./examples/browser/)
- [Basic Node.js Examples](./examples/node/)
- [Scribe.js vs. Tesseract.js Comparison](./docs/scribe_vs_tesseract.md)
- [API](./docs/API.md)

## Projects and Examples
The following are examples and projects built using Scribe.js.  Additional examples can be found in the [examples](https://github.com/scribeocr/scribe.js/tree/master/examples) directory. 

- Projects
   - Scribe OCR: officially supported GUI front-end for Scribe.js
      - Site at [scribeocr.com](https://scribeocr.com/), repo at [github.com/scribeocr/scribeocr](https://github.com/scribeocr/scribeocr)

If you have a project or example repo that uses Scribe.js, feel free to add it to this list using a pull request. Examples submitted should be well documented such that new users can run them; projects should be functional and actively maintained.

# Contributing
To work on a local copy, simply clone with `--recurse-submodules` and install.  Please run the automated tests before making a PR.
```sh
## Clone the repo, including recursively cloning submodules
git clone --recurse-submodules git@github.com:scribeocr/scribe.js.git
cd scribe.js

## Install dependencies
npm i

## Make changes
## [...]

## Run automated tests before making PR
npm run test
```
