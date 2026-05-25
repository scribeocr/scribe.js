# Overview
This repo contains code for generating debugging visualizations for the Tesseract OCR engine.  It is a JavaScript-based alternative to the Java GUI program found in the `ScrollView` directory in the Tesseract repo.  Generate debugging visualizations at with your own images at [debug.scribeocr.com](https://debug.scribeocr.com/).

**Please note:** this code requires a modified version of Tesseract/Tesseract.js to run, and is currently only usable within [scribeocr.com](https://scribeocr.com/), the Scribe.js library, and the website linked above.  Please thumbs-up [this issue](https://github.com/scribeocr/scribeocr/issues/41) if you have interest in better integration with the main Tesseract program, and we can look into this if there is enough demand. 

# Running Code

### Browser
To run the included website ([debug.scribeocr.com](https://debug.scribeocr.com/)) yourself locally, simply run a web server from this directory.  Below is an example using `http-server`.

```sh
npx http-server
```
To use the example, visit the URL indicated, which is usually `localhost:8080`.

### Node.js
Start by installing all dependencies.

```sh
npm i
```

Run the following command to generate visualizations using the provided example data.

```sh
node draw.js example_data/bill_vis.txt
```