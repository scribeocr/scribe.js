# Scribe UI
Scribe UI is a library for implementing a viewer or editor UI for PDFs and scanned documents.  In addition to performant rendering of PDFs, Scribe UI supports advanced editing features unsupported by other PDF viewer libraries--notably allowing end users to edit text both manually and automatically using OCR.

Web applications implemented using Scribe UI are below:
1. [Scribe OCR](https://scribeocr.com/)(repo [here](https://github.com/scribeocr/scribeocr)) - run OCR on scanned documents and proofread OCR text.
2. [Alch.io](https://alch.io/) (repo [here](https://github.com/scribeocr/alch.io)) - extract tables from PDFs and export to Excel.
3. [Scribe PDF Viewer](https://viewer.scribeocr.com/) (repo [here](https://github.com/scribeocr/scribe-pdf-viewer)) - minimal example of PDF viewer implemented with Scribe UI.

Scribe UI wraps [Scribe.js](https://github.com/scribeocr/scribe.js), which provides all of the logic unrelated to UI, including reading PDFs, rendering pages to images, and running OCR.

# Usage
Scribe UI ships as part of the `scribe.js-ocr` npm package:

```sh
npm i scribe.js-ocr
```

```js
import { ScribeViewer } from 'scribe.js-ocr/scribe-ui/viewer.js';
```

Individual toolkit modules are available under `scribe.js-ocr/scribe-ui/js/`. Scribe UI cannot run from a CDN due to cross-origin policies; serve it from the same origin as the importing page.

Scribe UI is a UI toolkit for creating viewer and editor interfaces, rather than a single drop-in viewer.  Additionally, Scribe UI is not yet fully documented.  Therefore, the best way to start using Scribe UI is to review the example applications listed above.  The simplest example is the [Scribe PDF Viewer repo](https://github.com/scribeocr/scribe-pdf-viewer), which provides code for creating a basic PDF viewer (visually similar to the Chrome PDF viewer) using Scribe UI.

# Basic Viewer (Web)
A minimal browser version of the viewer lives at [`basic-viewer/index.html`](basic-viewer/index.html).

From the `scribe.js` repository root:

```bash
npx http-server
```

Then open `http://localhost:8080/scribe-ui/basic-viewer/index.html` in a browser. Load a PDF from the in-page UI.
