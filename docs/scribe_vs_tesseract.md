# Overview
Scribe.js and Tesseract.js are both JavaScript packages that allow for running OCR in the browser or Node.js.  As both packages have advantages and disadvantages, this article explains how the packages differ, and should help developers decide which package is right for their project.

## TL;DR
Tesseract.js is smaller and faster than Scribe.js.  Projects that only need to extract text from `.png` and `.jpeg` images, and are satisfied with "pretty good" accuracy, should use Tesseract.js.  Scribe.js builds on Tesseract.js by providing more accurate OCR results and more features.  Most notably, Scribe.js provides PDF support, including the ability to extract existing text from PDFs, run OCR on PDFs, and add text layers to PDFs.  Developers unsure of the tradeoffs should try both packages using images their application is likely to encounter. 

# Scope
The reason why Tesseract.js and Scribe.js exist as separate packages, despite providing similar features and containing shared code, is that the scope of both projects is different.  Tesseract.js has a significantly narrower scope compared to Scribe.js.

**The goal of Tesseract.js is to bring Tesseract--a popular program we do not maintain--to JavaScript.**  As long as the JavaScript interface is user-friendly and works correctly, and recognition results are similar to Tesseract on desktop, Tesseract.js is working as intended.  All bugs inherited from the main Tesseract codebase are outside of the scope of the Tesseract.js project.  As a result, a large number of Tesseract.js Git Issues, including virtually all accuracy-related issues, are closed as out of scope.

**The goal of Scribe.js is to provide high-quality text extraction in JavaScript.**  Scribe.js was created to build on Tesseract.js and support many valid bug reports and feature requests that are outside of the scope of Tesseract.js.  For example, two of the most common requests from Tesseract.js users are improved OCR accuracy and PDF support.  Scribe.js (optionally) includes a custom OCR model that differs from, and generally outperforms, Tesseract.  When provided a text-native `.pdf`, Scribe.js can bypass OCR entirely and return the raw text.

# Differences
### PDF Support
Tesseract.js does not support `.pdf` files.  The only way to extract text from `.pdf` files using Tesseract.js is to render the `.pdf` file into a series of `.png` images using a separate library and then recognizing those `.png` images.  In addition to being slow, this process is often unnecessary, as many modern `.pdf` files are already text-native, meaning that no OCR needs to occur.  

Scribe OCR does support `.pdf` files, and can extract text from `.pdf` files in multiple ways.  Scribe OCR can recognize the contents of the `.pdf` file using OCR.  Additionally, for `.pdf` files that are text-native or contain an existing OCR layer, the existing text can be extracted directly.  The latter method is significantly faster compared to rendering the `.pdf` to images and running OCR.

### OCR Quality
Scribe.js produces results that are generally more accurate than Tesseract.js.  
1. Particularly for high-quality scans and screenshots, Scribe.js misidentifies fewer words.
2. Scribe.js often recognizes words that are skipped entirely by Tesseract.
3. Scribe.js can identify font styles, which Tesseract is incapable of.
	1. This can be observed by using the GUI at [scribeocr.com](https://scribeocr.com/).

### GUI
Scribe OCR contains a GUI web application that end-users can use to scan documents.  Tesseract.js is intended for developers within other applications, so is unsuitable for end users. 

### File Size
The additional features added by Scribe.js take up more space.  Enabling PDF support requires loading multiple megabytes of dependencies.  Using the Scribe.js default `quality` OCR model loads more language data than Tesseract.js does by default.

Notably, these resources are only loaded if requested--the PDF resources are only loaded if a PDF file is uploaded or exported, and setting OCR mode to `speed` prevents additional data from being downloaded.  However, if all optional features are disabled, Scribe.js has little to offer over Tesseract.js. 

### Speed
The Scribe.js default `quality` recognition mode runs additional recognition and checks, which therefore increases runtime.  The amount varies significantly document-to-document, but is often in the range of a 40-90% increase versus the `speed` mode (which provides results similar to to Tesseract.js).  For applications where accuracy is not critical, this increase in runtime may not be worth it.

### License
Tesseract.js is Apache 2.0 licensed.  This is a permissive license that imposes no meaningful restrictions on use.  Scribe.js is AGPL 3.0 licensed, which is a copy-left license.  As a result, to use Scribe.js in your program--whether on the front-end or server-side--you must either (1) publish your program under AGPL 3.0 or a compatible license or (2) obtain a proprietary license (contact admin@scribeocr.com).
