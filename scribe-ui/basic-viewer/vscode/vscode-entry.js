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

/** @typedef {Error & {kind?: 'denied'|'missing'|'unreadable'|'other'}} ReadError */
/**
 * An Error tagged with the kind of read failure.
 * @param {'denied'|'missing'|'unreadable'|'other'} kind
 * @param {string} message
 * @returns {ReadError}
 */
const readError = (kind, message) => Object.assign(new Error(message), { kind });

const readDoc = async () => {
  const res = await fetch(`${config.doc}${config.doc.includes('?') ? '&' : '?'}v=${Date.now()}`).catch((err) => { throw readError('other', err instanceof Error ? err.message : String(err)); });
  if (res.status === 401) throw readError('denied', 'VS Code denied access to the file');
  if (res.status === 404) throw readError('missing', 'the file is missing or unreadable');
  if (!res.ok) throw readError('other', `${res.status} ${res.statusText}`);
  return { buffer: await res.arrayBuffer(), name: config.name };
};

let eventQueue = Promise.resolve();
const enqueue = (fn) => { eventQueue = eventQueue.then(fn).catch((err) => { console.error(err); }); };

/**
 * Show why the file did not open, with Try again.
 * @param {unknown} err
 */
const showOpenFailure = (err) => {
  const kind = err instanceof Error ? /** @type {ReadError} */ (err).kind : undefined;
  const message = err instanceof Error ? err.message : String(err);
  let text;
  let hint = '';
  if (kind === 'denied') {
    text = 'VS Code didn’t let the viewer read the file.';
    hint = 'Closing this tab and reopening the file asks VS Code again.';
  } else if (kind === 'missing') {
    text = 'The file is missing or can’t be read.';
    hint = 'This tab opens the file as soon as it appears.';
  } else if (kind === 'unreadable') {
    text = `The file isn’t a ${/\.pdf$/i.test(config.name) ? 'PDF' : 'document'} the viewer can read.`;
    hint = 'If it is still being written, this tab opens it when the write finishes. To see it as text, use Reopen Editor With… and choose Text Editor.';
  } else {
    text = `The file couldn’t be read: ${message}.`;
  }
  pdfViewer._showPaneMessage({
    title: `Couldn’t open ${config.name}`,
    text,
    hint,
    actionLabel: 'Try again',
    onAction: () => {
      // The extension answers with a reload, or restarts the page when the file now resolves to another folder.
      pdfViewer._showPaneMessage({ busy: true, text: 'Opening…' });
      post({ type: 'retry' });
    },
  });
};

const openDoc = async () => {
  try {
    await handleLoadFile(config.doc, config.page || 0, readDoc, { onOpenFailed: () => showOpenFailure(readError('unreadable', 'the file could not be opened')) });
  } catch (err) {
    showOpenFailure(err);
  }
};

/** Whether the viewer's banner is showing a reload failure or file-deletion notice from this entry. */
let bannerUp = false;

enqueue(async () => {
  await openDoc();
  post({ type: 'ready' });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'navigate') {
    enqueue(() => ScribeViewer.displayPage(message.page, true, false));
  } else if (message.type === 'reload') {
    enqueue(async () => {
      if (!pdfViewer.doc) {
        await openDoc();
        return;
      }
      try {
        const { buffer, name } = await readDoc();
        const replaced = await pdfViewer.replaceActiveDoc(new File([buffer], name, { type: /\.pdf$/i.test(name) ? 'application/pdf' : '' }));
        if (!replaced) throw readError('unreadable', 'the new version did not open');
        if (bannerUp) {
          pdfViewer._hideBanner();
          bannerUp = false;
        }
      } catch (err) {
        const kind = err instanceof Error ? /** @type {ReadError} */ (err).kind : undefined;
        const detail = err instanceof Error ? err.message : String(err);
        let reason;
        if (kind === 'denied') reason = 'VS Code denied access to the file.';
        else if (kind === 'missing') reason = 'The file is missing or can’t be read.';
        else if (kind === 'unreadable') reason = `The new version isn’t a ${/\.pdf$/i.test(config.name) ? 'PDF' : 'document'} the viewer can read.`;
        else reason = `The new version couldn’t be read: ${detail}.`;
        pdfViewer._showBanner(`${reason} This is the last version that opened.`, { lead: `Couldn’t reload ${config.name}` });
        bannerUp = true;
        throw err;
      }
    });
  } else if (message.type === 'deleted') {
    // Queued behind any open or reload in flight, which decides whether a document is there to flag.
    enqueue(() => {
      if (pdfViewer.doc) {
        pdfViewer._showBanner('This is the last version there was.', { kind: 'warn', lead: `${config.name} is no longer there` });
        bannerUp = true;
      } else {
        showOpenFailure(readError('missing', 'the file is missing'));
      }
    });
  } else if (message.type === 'highlight') {
    enqueue(() => handleHighlights(message.highlights));
  }
});
