import { ScribePDFViewer } from '../pdf-viewer.js';

const viewerAElem = /** @type {HTMLDivElement} */ (document.getElementById('viewerA'));
const viewerBElem = /** @type {HTMLDivElement} */ (document.getElementById('viewerB'));

// Two full editors on one page would fight over the shared `scribe-theme` store, so this demo opts out of the editing UI.
const viewerA = new ScribePDFViewer(viewerAElem, { edit: false });
const viewerB = new ScribePDFViewer(viewerBElem, { edit: false });

// Expose for console-driven testing.
/** @type {any} */
(globalThis).viewerA = viewerA;
/** @type {any} */
(globalThis).viewerB = viewerB;
