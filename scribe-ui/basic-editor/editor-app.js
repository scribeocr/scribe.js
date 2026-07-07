// Bootstrap for the standalone PDF editor: mount a full-screen editor into the page.
import { ScribePDFEditor } from './pdf-editor.js';

const container = /** @type {HTMLDivElement} */ (document.getElementById('pdfEditorCont'));
const editor = new ScribePDFEditor(container, { keyboardScope: 'global', comments: true });

// Expose for console-driven testing/debugging.
/** @type {any} */
(globalThis).editor = editor;

export { editor };
