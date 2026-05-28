import { ScribePDFViewer } from '../pdf-viewer.js';

const viewerAElem = /** @type {HTMLDivElement} */ (document.getElementById('viewerA'));
const viewerBElem = /** @type {HTMLDivElement} */ (document.getElementById('viewerB'));

const viewerA = new ScribePDFViewer(viewerAElem);
const viewerB = new ScribePDFViewer(viewerBElem);

// Expose for console-driven testing.
/** @type {any} */
(globalThis).viewerA = viewerA;
/** @type {any} */
(globalThis).viewerB = viewerB;
