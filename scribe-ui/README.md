# Scribe UI
Scribe UI is a library for implementing a viewer or editor UI for PDFs and scanned documents.  In addition to performant rendering of PDFs, Scribe UI supports advanced editing features unsupported by other PDF viewer libraries--notably allowing end users to edit text both manually and automatically using OCR.

Web applications implemented using Scribe UI are below:
1. [Scribe OCR](https://scribeocr.com/)(repo [here](https://github.com/scribeocr/scribeocr)) - run OCR on scanned documents and proofread OCR text.
2. [Alch.io](https://alch.io/) (repo [here](https://github.com/scribeocr/alch.io)) - extract tables from PDFs and export to Excel.
3. [Scribe PDF Viewer](https://viewer.scribeocr.com/) (repo [here](https://github.com/scribeocr/scribe-pdf-viewer)) - minimal example of PDF viewer implemented with Scribe UI.

Scribe UI wraps [Scribe.js](https://github.com/scribeocr/scribe.js), which provides all of the logic unrelated to UI, including reading PDFs, rendering pages to images, and running OCR.

# Usage
To start using Scribe UI, add this repo as a submodule in your project.  Scribe UI is currently not published to NPM, and is not capable of running using a CDN due to issues with cross-origin policies.

Scribe UI is a UI toolkit for creating viewer and editor interfaces, rather than a single drop-in viewer.  Additionally, Scribe UI is not yet fully documented.  Therefore, the best way to start using Scribe UI is to review the example applications listed above.  The simplest example is the [Scribe PDF Viewer repo](https://github.com/scribeocr/scribe-pdf-viewer), which provides code for creating a basic PDF viewer (visually similar to the Chrome PDF viewer) using Scribe UI.

# Issues and Discussions
Please post any issues or discussion related to Scribe UI on the [Scribe OCR repo](https://github.com/scribeocr/scribeocr).  Consolidating discussion on that page avoids issues caused by the scope of each repo being unclear to new users, or issues being duplicated across repos.