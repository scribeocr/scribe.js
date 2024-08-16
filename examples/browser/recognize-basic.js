import scribe from '../../scribe.js';
// Pre-load OCR and font data to avoid delay when user uploads a file.
await scribe.init({ ocr: true, font: true });

const elm = /** @type {HTMLInputElement} */ (document.getElementById('uploader'));
elm.addEventListener('change', async () => {
  if (!elm.files) return;
  const text = await scribe.recognizeFiles(elm.files);
  console.log(text);
});
