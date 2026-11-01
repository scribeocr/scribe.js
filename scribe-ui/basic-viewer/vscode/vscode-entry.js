// The settings module comes first so its options hold before the bootstrap builds the viewer.
import './vscode-opt.js';
import {
  ScribeViewer, pdfViewer, handleHighlights, handleLoadFile,
} from '../example-app.js';
import { scribe } from '../pdf-viewer.js';

const config = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('viewer-config')).dataset.config || '{}');
const vscodeApi = typeof /** @type {any} */ (globalThis).acquireVsCodeApi === 'function' ? /** @type {any} */ (globalThis).acquireVsCodeApi() : null;
const post = (message) => { vscodeApi?.postMessage(message); };

if (!pdfViewer) throw new Error('vscode-entry.js requires the bootstrap viewer, which example-app.js builds on #pdfViewerCont.');

// A download from a webview lands on the machine running the window, which in a remote session is not where the document lives, so the extension saves through VS Code's own dialog.
scribe.opt.saveAs = async (content, fileName) => {
  let bytes;
  if (content instanceof Blob) bytes = new Uint8Array(await content.arrayBuffer());
  else if (content instanceof ArrayBuffer) bytes = new Uint8Array(content);
  else if (typeof content === 'string') bytes = new TextEncoder().encode(content);
  else bytes = content;
  post({ type: 'save', name: fileName, bytes });
};
scribe.opt.openExternal = (url) => post({ type: 'openExternal', url });

const applyTheme = () => pdfViewer.setTheme(document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast') ? 'dark' : 'light');
applyTheme();
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

const readDoc = async () => {
  const res = await fetch(`${config.doc}${config.doc.includes('?') ? '&' : '?'}v=${Date.now()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { buffer: await res.arrayBuffer(), name: config.name };
};

let eventQueue = Promise.resolve();
const enqueue = (fn) => { eventQueue = eventQueue.then(fn).catch((err) => { console.error(err); }); };

enqueue(async () => {
  try {
    await handleLoadFile(config.doc, config.page || 0, readDoc);
  } catch (err) {
    pdfViewer._showToast(`Couldn't open “${config.name}” — ${err instanceof Error ? err.message : err}`);
  }
  post({ type: 'ready' });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'navigate') {
    enqueue(() => ScribeViewer.displayPage(message.page, true, false));
  } else if (message.type === 'reload') {
    enqueue(async () => {
      const { buffer, name } = await readDoc();
      await pdfViewer.replaceActiveDoc(new File([buffer], name, { type: /\.pdf$/i.test(name) ? 'application/pdf' : '' }));
    });
  } else if (message.type === 'deleted') {
    pdfViewer._showToast(`“${config.name}” is no longer there. This is the last version there was.`);
  } else if (message.type === 'highlight') {
    enqueue(() => handleHighlights(message.highlights));
  }
});
