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