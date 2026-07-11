import { ScribeViewer } from '../../viewer.js';
import { TextSelection } from '../viewerTextSelection.js';

/**
 * Importing this module is the build-time opt-in for the custom (DOM-less) selection engine.
 * Import both this and `domSelectionEngine.js` to defer the choice to runtime via `ScribeViewer.customSelection`.
 */
ScribeViewer.registerSelectionEngine({
  kind: 'custom',
  /** @param {ScribeViewer} viewer */
  attach(viewer) {
    const textSel = new TextSelection(viewer);
    viewer.textSel = textSel;
    return textSel;
  },
});

export { TextSelection };
