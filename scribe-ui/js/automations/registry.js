// The automation registry: the manifest read by the Automate panel's catalog, the app menu, and the selection menu's hand-off rows.
// Tool code loads lazily through `load`, so an unused automation costs nothing.

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

const REDACT_TERMS_SVG = lineIcon('<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/><path d="M7.5 9h9"/>'
  + '<rect x="7.5" y="12" width="6.5" height="3.2" rx="0.6" fill="currentColor" stroke="none"/>');
const EXTRACT_HIGHLIGHTS_SVG = lineIcon('<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16M4 14.5h16M10 10v9M15 10v9"/>');

/**
 * @typedef {Object} AutomationOutcomeRow
 * @property {'ok'|'flag'|'file'|'info'} kind - Row accent: success, needs attention, produced file, or neutral.
 * @property {string} text
 * @property {{label: string, onClick: () => void}} [action]
 */

/**
 * @typedef {Object} AutomationOutcome
 * @property {Array<AutomationOutcomeRow>} rows
 * @property {{label: string, onClick: () => (void | Promise<void>)}} [review] - The done state's primary action.
 */

/**
 * @typedef {Object} AutomationHost
 * @property {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @property {import('../../viewer.js').ScribeViewer} viewer
 */

/**
 * @typedef {Object} AutomationModule
 * @property {(host: AutomationHost, prefill?: Object) => {formElem: HTMLElement, getParams: () => ?Object, focus: () => void}} [buildForm]
 *   Omitted when the tool takes no parameters.
 *   The panel then renders its description with a bare Run.
 * @property {(params: ?Object) => string} [describeParams] - One-line record of what ran, shown with the run's status.
 * @property {(host: AutomationHost, params: ?Object, progress: (frac: number, caption: string) => void) => Promise<AutomationOutcome>} run
 */

/**
 * @typedef {Object} AutomationEntry
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} category - Catalog group heading.
 * @property {'mechanical'|'ai-assisted'|'ai-only'} engine - Mechanical automations never send document content anywhere.
 *   The AI engines render as quiet chips at browse time.
 * @property {'read'|'mutate'|'destructive'} effects
 * @property {string} svg
 * @property {(viewer: import('../../viewer.js').ScribeViewer) => ?string} disabledWhy - Reason the tool
 *   cannot run right now, or null when it can.
 * @property {() => Promise<AutomationModule>} load
 */

/** @type {Array<AutomationEntry>} */
export const AUTOMATIONS = [
  {
    id: 'redact-terms',
    title: 'Redact terms',
    description: 'Stage redactions over every occurrence of the terms you list.',
    category: 'Privacy',
    engine: 'mechanical',
    effects: 'mutate',
    svg: REDACT_TERMS_SVG,
    disabledWhy: (viewer) => (viewer.doc && viewer.doc.pageMetrics.length ? null : 'Open a document first'),
    load: () => import('./redactTerms.js'),
  },
  {
    id: 'extract-highlights',
    title: 'Extract highlights to Excel',
    description: 'Every highlighted passage with its comment and author, as a spreadsheet.',
    category: 'Review',
    engine: 'mechanical',
    effects: 'read',
    svg: EXTRACT_HIGHLIGHTS_SVG,
    disabledWhy: (viewer) => {
      if (!viewer.doc || !viewer.doc.pageMetrics.length) return 'Open a document first';
      for (const pageAnnots of viewer.doc.annotations.pages) {
        for (const a of pageAnnots || []) {
          if ((a.type ?? 'highlight') === 'highlight' && 'groupId' in a && 'color' in a) return null;
        }
      }
      return 'This document has no highlights';
    },
    load: () => import('./extractHighlights.js'),
  },
];

/** Catalog group order. */
export const CATEGORY_ORDER = ['Review', 'Privacy', 'Assemble', 'File'];

/**
 * Tools surfaced in a "For <mode>" group atop the catalog while that tool mode is active.
 * Keys are the mode buttons' titles.
 * @type {Object<string, {label: string, ids: Array<string>}>}
 */
export const MODE_GROUPS = {
  Redact: { label: 'For redacting', ids: ['redact-terms'] },
};
