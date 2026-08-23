// The automation registry: the manifest read by the Automate panel's catalog, the app menu, and the selection menu's hand-off rows.
// Tool code loads lazily through `load`, so an unused automation costs nothing.
import { detectHeadingBookmarks } from '../../../js/objects/outlineObjects.js';

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

const REDACT_TERMS_SVG = lineIcon('<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/><path d="M7.5 9h9"/>'
  + '<rect x="7.5" y="12" width="6.5" height="3.2" rx="0.6" fill="currentColor" stroke="none"/>');
const EXTRACT_HIGHLIGHTS_SVG = lineIcon('<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16M4 14.5h16M10 10v9M15 10v9"/>');
const EXTRACT_TABLES_SVG = lineIcon('<rect x="4" y="4.5" width="16" height="15" rx="1.5"/><path d="M4 9.5h16M4 14.5h16M9.5 9.5v10"/>');
const GENERATE_BOOKMARKS_SVG = lineIcon('<path d="M5 4.5h6.2v14.6l-3.1-2.3-3.1 2.3z"/><path d="M14.8 7.5h4.7M14.8 12h4.7M14.8 16.5h3.2"/>');

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
 * @property {{label: string, onClick: () => void, undoneText: string}} [undo] - Quiet foot action that reverses the run.
 *   The thread replaces the outcome with `undoneText` once it runs.
 * @property {{text: string, actionLabel: string, params: Object}} [offer] - Follow-up block under the results.
 *   Accepting it re-runs the tool with `params`.
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
 * @property {(viewer: import('../../viewer.js').ScribeViewer) => ?string} disabledWhy - Reason the tool cannot run right now, or null when it can.
 * @property {(host: AutomationHost) => void} [openInstead] - Clicking the catalog row runs this instead of opening the form pipeline, for a tool whose surface is a viewer mode's workspace.
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
    id: 'extract-tables',
    title: 'Extract tables',
    description: 'Review every detected table and export the workbook.',
    category: 'Extract',
    engine: 'mechanical',
    effects: 'read',
    svg: EXTRACT_TABLES_SVG,
    // No table count in the gate, because "no tables found" is a legitimate result and a document still extracting text has no knowable count yet.
    disabledWhy: (viewer) => (viewer.doc && viewer.doc.pageMetrics.length ? null : 'Open a document first'),
    openInstead: (host) => host.app._extractTablesTool?.open(),
    load: () => import('./extractTables.js'),
  },
  {
    id: 'extract-highlights',
    title: 'Extract highlights to Excel',
    description: 'Every highlighted passage with its comment and author, as a spreadsheet.',
    category: 'Extract',
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
  {
    id: 'generate-bookmarks',
    title: 'Generate bookmarks',
    description: 'Build bookmarks from the headings detected in the document.',
    category: 'Assemble',
    engine: 'ai-assisted',
    effects: 'mutate',
    svg: GENERATE_BOOKMARKS_SVG,
    disabledWhy: (viewer) => {
      const doc = viewer.doc;
      if (!doc || !doc.pageMetrics.length) return 'Open a document first';
      if (!doc.inputData || doc.inputData.pdfType !== 'text') return 'Needs a PDF with original digital text';
      // While deferred text extraction is still running the candidates are unknowable, so the row stays enabled and the run waits.
      if (!doc._textReadySettle && detectHeadingBookmarks(doc).length < 3) return 'Not enough headings detected in this document';
      return null;
    },
    load: () => import('./generateBookmarks.js'),
  },
];

/** Catalog group order. */
export const CATEGORY_ORDER = ['Extract', 'Privacy', 'Assemble', 'File'];

/**
 * Tools surfaced in a "For <mode>" group atop the catalog while that tool mode is active.
 * Keys are the mode buttons' titles.
 * @type {Object<string, {label: string, ids: Array<string>}>}
 */
export const MODE_GROUPS = {
  Redact: { label: 'For redacting', ids: ['redact-terms'] },
};

/**
 * Tools surfaced in a "For <view>" group atop the catalog while that sidebar view is active.
 * Keys are the app's sidebar view keys.
 * @type {Object<string, {label: string, ids: Array<string>}>}
 */
export const SIDEBAR_GROUPS = {
  bookmarks: { label: 'For bookmarks', ids: ['generate-bookmarks'] },
};
