import { makeIconButton, formatTimestamp } from './toolbar.js';
import { AUTOMATIONS, CATEGORY_ORDER, MODE_GROUPS } from '../automations/registry.js';
import { runAssistantTurn } from '../assistant/assistant.js';
import { makeAssistantTrace, buildTraceEnvelope } from '../assistant/trace.js';
import { VERBS, navigateToReceipt } from '../assistant/verbs.js';
import { CODE_FONT_FAMILY, collectMdRefs, parseMdBlocks } from '../../../js/utils/parseMd.js';

const lineIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

/** The Automate identity glyph, drawn on the toolbar opener and the panel header. */
const AUTOMATE_SVG = lineIcon('<path d="M5 7.2l5.6 4.8L5 16.8z"/><path d="M14 7.5h5.5M14 12h5.5M14 16.5h3.5"/>');
const BACK_SVG = lineIcon('<path d="M14 6l-6 6 6 6"/>');
const SEND_SVG = lineIcon('<path d="M4.5 11.4L19.5 4.5 15.6 19.5l-3.9-5.2z"/><path d="M11.7 14.3l7.8-9.8"/>');
const SPIN_SVG = lineIcon('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5"/>');
const STOP_SVG = lineIcon('<rect x="7" y="7" width="10" height="10" rx="1.5"/>');
const READ_SVG = lineIcon('<path d="M12 5.5C9.8 4 6.8 3.8 4 4.4v14.2c2.8-.6 5.8-.4 8 1.1 2.2-1.5 5.2-1.7 8-1.1V4.4c-2.8-.6-5.8-.4-8 1.1z"/><path d="M12 5.5v14.2"/>');
const CHEVRON_SVG = lineIcon('<path d="M7.5 10l4.5 4.5 4.5-4.5"/>');
const CHECK_SVG = lineIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');
const FILE_SVG = lineIcon('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13 3.5V8h4.5"/>');
const ROW_ICON_FALLBACK = AUTOMATE_SVG;

export const AUTOMATE_PANEL_WIDTH = 340;
const AUTOMATE_MIN_WIDTH = 280;
const AUTOMATE_MAX_WIDTH = 720;

const injected = new Set();

function addAutomateStyles(rootClass) {
  if (injected.has(rootClass)) return;
  injected.add(rootClass);
  const r = rootClass;
  const style = document.createElement('style');
  style.textContent = `
    .${r} .scribe-library-bar .scribe-automate-toggle, .${r} .scribe-library-bar .scribe-automate-sep { display: none; }
    .${r} .scribe-am-panel {
      position: absolute; right: 0; z-index: 10; box-sizing: border-box;
      background: var(--scribe-surface); border-left: 1px solid var(--scribe-line);
      display: flex; flex-direction: column; color: var(--scribe-ink); font-size: 13px; overflow: hidden;
    }
    .${r} .scribe-am-resize {
      position: absolute; top: 0; left: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 8; touch-action: none;
    }
    .${r} .scribe-am-resize:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-hd {
      display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 8px 0 12px;
      border-bottom: 1px solid var(--scribe-line); flex: none;
    }
    .${r} .scribe-am-hd-ic { width: 16px; height: 16px; color: var(--scribe-ink-2); flex: none; }
    .${r} .scribe-am-hd-title {
      font-size: 13px; font-weight: 600; color: var(--scribe-ink); min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .${r} .scribe-am-ib {
      width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
      color: var(--scribe-ink-3); cursor: pointer; flex: none; -webkit-tap-highlight-color: transparent;
    }
    .${r} .scribe-am-ib:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-am-ib svg { width: 15px; height: 15px; }
    .${r} .scribe-am-hd-close { margin-left: auto; }
    .${r} .scribe-am-strip {
      display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; flex: none;
      background: var(--scribe-accent-soft); border-bottom: 1px solid var(--scribe-line);
      font-size: 12px; font-weight: 600; color: var(--scribe-ink);
    }
    .${r} .scribe-am-strip-ic { width: 14px; height: 14px; color: var(--scribe-accent); flex: none; }
    .${r} .scribe-am-strip-tx { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-strip-resume {
      margin-left: auto; flex: none; border: none; background: none; font: inherit; font-size: 12px; font-weight: 600;
      color: var(--scribe-accent); cursor: pointer; padding: 2px 8px; border-radius: 5px;
    }
    .${r} .scribe-am-strip-resume:hover { background: var(--scribe-active); }
    .${r} .scribe-am-catalog { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 6px 8px; min-height: 0; }
    .${r} .scribe-am-cat {
      font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
      color: var(--scribe-ink-3); padding: 10px 11px 3px;
    }
    .${r} .scribe-am-row {
      display: flex; align-items: flex-start; gap: 11px; padding: 8px 11px; border-radius: 7px; cursor: pointer;
      width: 100%; box-sizing: border-box; border: none; background: none; font: inherit; color: inherit; text-align: left;
      -webkit-tap-highlight-color: transparent;
    }
    .${r} .scribe-am-row:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-row-ic { width: 19px; height: 19px; color: var(--scribe-ink-2); flex: none; margin-top: 1px; }
    .${r} .scribe-am-row-col { min-width: 0; flex: 1; display: grid; gap: 1px; }
    .${r} .scribe-am-row-title { font-size: 13px; color: var(--scribe-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-row-desc { font-size: 12px; color: var(--scribe-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-row.disabled { cursor: default; }
    .${r} .scribe-am-row.disabled:hover { background: none; }
    .${r} .scribe-am-row.disabled .scribe-am-row-ic, .${r} .scribe-am-row.disabled .scribe-am-row-title { color: var(--scribe-ink-3); }
    .${r} .scribe-am-row.disabled .scribe-am-row-desc { color: var(--scribe-ink-3); }
    .${r} .scribe-am-chip {
      flex: none; align-self: center; font-size: 9.5px; font-weight: 700; letter-spacing: .05em;
      border-radius: 4px; padding: 2px 6px; margin-left: 8px;
    }
    .${r} .scribe-am-chip.ai { color: var(--scribe-accent); background: var(--scribe-accent-soft); }
    .${r} .scribe-am-chip.aiopt { color: var(--scribe-ink-2); background: var(--scribe-sunken); }
    .${r} .scribe-am-empty { font-size: 12.5px; color: var(--scribe-ink-3); padding: 12px 11px; }
    .${r} .scribe-am-thread {
      flex: 1; overflow-y: auto; overflow-x: hidden; padding: 12px; min-height: 0;
      display: grid; grid-template-columns: minmax(0, 1fr); gap: 11px; align-content: start;
    }
    .${r} .scribe-am-desc { font-size: 12.5px; color: var(--scribe-ink-2); line-height: 1.5; margin: 0; }
    .${r} .scribe-am-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .${r} .scribe-am-label { font-size: 12px; font-weight: 600; color: var(--scribe-ink-2); }
    .${r} .scribe-am-terms {
      display: flex; flex-wrap: wrap; gap: 5px; border: 1px solid var(--scribe-line-strong); border-radius: 7px;
      padding: 6px 7px; background: var(--scribe-canvas); cursor: text;
    }
    .${r} .scribe-am-terms:focus-within { border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-am-chip-term, .${r} .scribe-am-chip { line-height: 1.4; }
    .${r} .scribe-am-terms .scribe-am-chip-x { color: var(--scribe-ink-3); cursor: pointer; padding: 0 1px; }
    .${r} .scribe-am-terms .scribe-am-chip-x:hover { color: var(--scribe-ink); }
    .${r} .scribe-am-terms > .scribe-am-chip-term {
      display: inline-flex; align-items: center; gap: 5px; background: var(--scribe-sunken); border-radius: 5px;
      padding: 2px 7px; font-size: 11.5px; color: var(--scribe-ink);
    }
    .${r} .scribe-am-terms-input {
      flex: 1; min-width: 90px; border: none; outline: none; background: none; font: inherit; font-size: 12.5px; color: var(--scribe-ink);
    }
    .${r} .scribe-am-terms-input::placeholder { color: var(--scribe-ink-3); }
    .${r} .scribe-am-opts { display: flex; gap: 14px; flex-wrap: wrap; }
    .${r} .scribe-am-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--scribe-ink); cursor: pointer; }
    .${r} .scribe-am-check input { accent-color: var(--scribe-accent); margin: 0; }
    .${r} .scribe-am-foot { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
    .${r} .scribe-am-foot-grow { flex: 1; }
    .${r} .scribe-am-run {
      display: inline-flex; align-items: center; border: 1px solid var(--scribe-accent); border-radius: 6px;
      background: none; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--scribe-accent);
      padding: 4px 14px; cursor: pointer; white-space: nowrap;
    }
    .${r} .scribe-am-run:hover { background: var(--scribe-active); }
    .${r} .scribe-am-quiet {
      border: none; background: none; font: inherit; font-size: 12.5px; color: var(--scribe-ink-2);
      cursor: pointer; padding: 4px 10px; border-radius: 6px; white-space: nowrap;
    }
    .${r} .scribe-am-quiet:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-am-status { display: flex; align-items: baseline; gap: 10px; font-size: 11.5px; color: var(--scribe-ink-2); }
    .${r} .scribe-am-status-params { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-status-state { margin-left: auto; white-space: nowrap; flex: none; }
    .${r} .scribe-am-status-state.done { color: #2e7d4f; font-weight: 600; }
    .${r}[data-theme="dark"] .scribe-am-status-state.done { color: #5abd85; }
    .${r} .scribe-am-status-state.failed { color: var(--scribe-danger); font-weight: 600; }
    .${r} .scribe-am-bar { height: 5px; border-radius: 3px; background: var(--scribe-sunken); overflow: hidden; }
    .${r} .scribe-am-bar > i { display: block; height: 100%; width: 0%; background: var(--scribe-accent); border-radius: 3px; transition: width .2s ease; }
    .${r} .scribe-am-caption { font-size: 11.5px; color: var(--scribe-ink-2); }
    .${r} .scribe-am-result { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--scribe-ink); min-width: 0; }
    .${r} .scribe-am-result-ic { width: 14px; height: 14px; flex: none; color: var(--scribe-ink-3); }
    .${r} .scribe-am-result.ok .scribe-am-result-ic { color: #2e7d4f; }
    .${r}[data-theme="dark"] .scribe-am-result.ok .scribe-am-result-ic { color: #5abd85; }
    .${r} .scribe-am-result.flag .scribe-am-result-ic { color: var(--scribe-danger); }
    .${r} .scribe-am-result-tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-am-result-act {
      margin-left: auto; flex: none; border: none; background: none; font: inherit; font-size: 12px; font-weight: 600;
      color: var(--scribe-accent); cursor: pointer; padding: 1px 7px; border-radius: 5px; white-space: nowrap;
    }
    .${r} .scribe-am-result-act:hover { background: var(--scribe-active); }
    .${r} .scribe-am-composer { flex: none; border-top: 1px solid var(--scribe-line); padding: 9px 10px; }
    .${r} .scribe-am-cbox {
      display: flex; flex-direction: column; align-items: stretch; gap: 2px; border: 1px solid var(--scribe-line-strong); border-radius: 9px;
      background: var(--scribe-surface); padding: 7px 8px 4px 10px; min-width: 0;
    }
    .${r} .scribe-am-cbox:focus-within { border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-am-cbar { display: flex; align-items: center; min-width: 0; }
    .${r} .scribe-am-cbar .scribe-am-send { margin-left: auto; }
    /* The column box makes the main axis vertical, so a flexed basis would override the height fitComposer sets. */
    .${r} .scribe-am-cbox textarea {
      flex: none; border: none; outline: none; background: none; font: inherit; font-size: 12.5px; color: var(--scribe-ink); min-width: 0;
      box-sizing: border-box; resize: none; overflow-y: auto; line-height: 18px; padding: 4px 0; min-height: 26px; max-height: 152px;
    }
    .${r} .scribe-am-cbox textarea::placeholder { color: var(--scribe-ink-3); }
    .${r} .scribe-am-cbox textarea::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-am-cbox textarea::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-am-cbox textarea::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
    /* Firefox lacks ::-webkit-scrollbar and shows a fat native bar in this narrow field.
       Scoping the standard fallback to non-webkit engines keeps Chrome on the 5px bar above. */
    @supports not selector(::-webkit-scrollbar) {
      .${r} .scribe-am-cbox textarea, .${r} .scribe-as-exp { scrollbar-width: thin; scrollbar-color: var(--scribe-scrollbar) transparent; }
    }
    /* Coarse pointers get the 16px input font that keeps iOS from zooming, so the line box and the cap grow with it. */
    .${r}.scribe-coarse .scribe-am-cbox textarea { line-height: 22px; min-height: 30px; max-height: 184px; }
    .${r} .scribe-am-send { color: var(--scribe-ink-3); }
    .${r} .scribe-am-send.ready { color: var(--scribe-accent); }
    .${r} .scribe-am-send.stop { color: var(--scribe-ink-2); }
    .${r} .scribe-am-model {
      display: inline-flex; align-items: center; gap: 3px; border: none; background: none; cursor: pointer;
      font: inherit; font-size: 11.5px; font-weight: 500; color: var(--scribe-ink-2); padding: 2px 6px;
      border-radius: 5px; white-space: nowrap; min-width: 0; -webkit-tap-highlight-color: transparent;
    }
    .${r} .scribe-am-model:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-am-model-chev { width: 10px; height: 10px; flex: none; }
    .${r} .scribe-am-model:focus-visible, .${r} .scribe-am-mrow:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: 1px; }
    .${r} .scribe-am-mmenu {
      position: absolute; left: 10px; z-index: 12; min-width: 208px; max-width: calc(100% - 20px); box-sizing: border-box;
      padding: 5px; background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 10px;
      box-shadow: var(--scribe-menu-shadow);
    }
    .${r} .scribe-am-mrow {
      display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box; text-align: left;
      padding: 7px 9px; border-radius: 6px; cursor: pointer; border: none; background: none; font: inherit;
      color: var(--scribe-ink); -webkit-tap-highlight-color: transparent;
    }
    .${r} .scribe-am-mrow:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-mcol { min-width: 0; flex: 1; display: grid; gap: 1px; }
    .${r} .scribe-am-mname { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-mhint { font-size: 11px; color: var(--scribe-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-mcheck { width: 14px; height: 14px; flex: none; color: var(--scribe-accent); visibility: hidden; }
    .${r} .scribe-am-mrow[aria-checked="true"] .scribe-am-mcheck { visibility: visible; }
    .${r} .scribe-as-mark { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--scribe-ink-3); }
    .${r} .scribe-as-mark::before, .${r} .scribe-as-mark::after { content: ''; flex: 1; height: 1px; background: var(--scribe-line); }
    .${r} .scribe-as-user { display: grid; justify-items: start; }
    .${r} .scribe-as-user-tx {
      background: var(--scribe-sunken); border-radius: 8px; padding: 6px 10px; max-width: 100%; box-sizing: border-box;
      font-size: 12.5px; color: var(--scribe-ink); line-height: 1.5; overflow-wrap: break-word;
    }
    .${r} .scribe-as-prose { font-size: 12.5px; color: var(--scribe-ink); line-height: 1.55; overflow-wrap: break-word; }
    .${r} .scribe-as-prose p, .${r} .scribe-as-prose blockquote { margin: 0 0 6px; white-space: pre-wrap; }
    .${r} .scribe-as-prose ul, .${r} .scribe-as-prose ol { margin: 0 0 6px; padding-left: 20px; }
    .${r} .scribe-as-prose ul ul, .${r} .scribe-as-prose ul ol, .${r} .scribe-as-prose ol ul, .${r} .scribe-as-prose ol ol { margin-bottom: 0; }
    .${r} .scribe-as-prose li { white-space: pre-wrap; }
    .${r} .scribe-as-prose blockquote { padding-left: 10px; border-left: 2px solid var(--scribe-line); color: var(--scribe-ink-2); }
    .${r} .scribe-as-prose blockquote > :last-child { margin-bottom: 0; }
    .${r} .scribe-as-prose li.scribe-as-task { list-style: none; }
    .${r} .scribe-as-prose .scribe-as-h { font-weight: 600; margin: 0 0 6px; }
    .${r} .scribe-as-prose code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; background: var(--scribe-sunken); border-radius: 4px; padding: 0 3px; }
    .${r} .scribe-as-prose pre { margin: 0 0 6px; padding: 6px 8px; background: var(--scribe-sunken); border-radius: 6px; overflow-x: auto; }
    .${r} .scribe-as-prose pre code { display: block; padding: 0; background: none; white-space: pre; }
    .${r} .scribe-as-prose > :last-child { margin-bottom: 0; }
    .${r} .scribe-as-rail { display: grid; gap: 6px; border-left: 2px solid var(--scribe-line); margin-left: 5px; padding-left: 10px; }
    .${r} .scribe-as-receipt {
      display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--scribe-ink-2); min-width: 0;
      cursor: pointer; border-radius: 5px; margin: 0 -4px; padding: 1px 4px;
    }
    .${r} .scribe-as-receipt:hover { background: var(--scribe-hover); }
    .${r} .scribe-as-receipt-ic { width: 14px; height: 14px; flex: none; color: var(--scribe-ink-3); }
    .${r} .scribe-as-receipt.act .scribe-as-receipt-ic { color: #2e7d4f; }
    .${r}[data-theme="dark"] .scribe-as-receipt.act .scribe-as-receipt-ic { color: #5abd85; }
    .${r} .scribe-as-receipt-tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-as-receipt-act {
      margin-left: auto; flex: none; border: none; background: none; font: inherit; font-size: 11.5px; font-weight: 600;
      color: var(--scribe-accent); cursor: pointer; padding: 0 6px; border-radius: 4px; white-space: nowrap;
    }
    .${r} .scribe-as-receipt-act:hover { background: var(--scribe-active); }
    .${r} .scribe-as-receipt.removed .scribe-as-receipt-tx { text-decoration: line-through; color: var(--scribe-ink-3); }
    .${r} .scribe-as-removed-tag { margin-left: auto; flex: none; font-size: 11.5px; color: var(--scribe-ink-3); padding: 0 6px; }
    .${r} .scribe-as-batch-dim { flex: none; color: var(--scribe-ink-3); white-space: nowrap; }
    .${r} .scribe-as-batch-dim:empty { display: none; }
    .${r} .scribe-as-chev { width: 12px; height: 12px; flex: none; color: var(--scribe-ink-3); transition: transform .16s ease; }
    .${r} .scribe-as-receipt.open .scribe-as-chev { transform: rotate(180deg); }
    .${r} .scribe-as-exp {
      display: grid; gap: 5px; margin: 1px 0 3px 18px; max-height: 176px; overflow-y: auto; padding-right: 4px;
      transition: max-height .18s ease, opacity .18s ease;
    }
    .${r} .scribe-as-exp-fold { max-height: 0 !important; opacity: 0; }
    .${r} .scribe-as-exp::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-as-exp::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-as-exp::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
    .${r} .scribe-as-item {
      display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--scribe-ink-2); min-width: 0;
      cursor: pointer; border-radius: 5px; margin: 0 -4px; padding: 1px 4px;
    }
    .${r} .scribe-as-item:hover { background: var(--scribe-hover); }
    .${r} .scribe-as-item-pg { flex: none; font-size: 11px; color: var(--scribe-ink-3); font-variant-numeric: tabular-nums; min-width: 22px; }
    .${r} .scribe-as-item-tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-as-item.removed .scribe-as-item-tx { text-decoration: line-through; color: var(--scribe-ink-3); }
    .${r} .scribe-as-ghost { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--scribe-ink-3); min-width: 0; }
    .${r} .scribe-as-ghost .scribe-as-receipt-ic svg { animation: scribe-as-spin 1s linear infinite; }
    @keyframes scribe-as-spin { to { transform: rotate(360deg); } }
    .${r} .scribe-as-flag { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--scribe-ink); }
    .${r} .scribe-as-flag .scribe-as-receipt-ic { color: var(--scribe-danger); }
    .${r} .scribe-as-key {
      display: grid; gap: 8px; border: 1px solid var(--scribe-line); border-radius: 8px; padding: 10px 11px;
      background: var(--scribe-canvas); font-size: 12.5px; color: var(--scribe-ink); margin: 8px 6px;
    }
    .${r} .scribe-as-key input {
      border: 1px solid var(--scribe-line-strong); border-radius: 7px; background: var(--scribe-surface);
      font: inherit; font-size: 12.5px; color: var(--scribe-ink); padding: 5px 9px; width: 100%; box-sizing: border-box;
    }
    .${r} .scribe-as-key input:focus { outline: none; border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-as-key-note { font-size: 11.5px; color: var(--scribe-ink-3); }
    .${r} .scribe-as-key-error { font-size: 11.5px; color: var(--scribe-danger); }
  `;
  document.head.appendChild(style);
}

/**
 * Build the Automate panel and its toolbar opener.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @param {string} rootClass
 * @param {{onLayoutChange: () => void, onResize: (width: number, phase: 'start'|'move'|'end') => void, assistantTrace?: boolean}} hooks
 *   `onResize` reports the width a left-edge drag asks for, which the host clamps and applies.
 *   `assistantTrace` turns on the dev-only conversation trace that `exportTrace` returns.
 */
export function createAutomatePanel(app, rootClass, hooks) {
  addAutomateStyles(rootClass);
  const host = { app, viewer: app.scribe };

  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-am-panel';
  panelElem.style.display = 'none';
  panelElem.style.width = `${AUTOMATE_PANEL_WIDTH}px`;

  const hd = document.createElement('div');
  hd.className = 'scribe-am-hd';
  const backBtn = document.createElement('span');
  backBtn.className = 'scribe-am-ib';
  backBtn.role = 'button';
  backBtn.tabIndex = 0;
  backBtn.title = 'Back to all automations';
  backBtn.innerHTML = BACK_SVG;
  backBtn.style.display = 'none';
  const hdIcon = document.createElement('span');
  hdIcon.className = 'scribe-am-hd-ic';
  hdIcon.innerHTML = AUTOMATE_SVG;
  const hdTitle = document.createElement('span');
  hdTitle.className = 'scribe-am-hd-title';
  hdTitle.textContent = 'Automate';
  const closeBtn = document.createElement('span');
  closeBtn.className = 'scribe-am-ib scribe-am-hd-close';
  closeBtn.role = 'button';
  closeBtn.tabIndex = 0;
  closeBtn.title = 'Close panel';
  closeBtn.innerHTML = '×';
  hd.append(backBtn, hdIcon, hdTitle, closeBtn);

  // Pinned strip for a live (or freshly finished, unseen) run while the catalog is showing.
  const strip = document.createElement('div');
  strip.className = 'scribe-am-strip';
  strip.style.display = 'none';
  const stripIc = document.createElement('span');
  stripIc.className = 'scribe-am-strip-ic';
  stripIc.innerHTML = SPIN_SVG;
  const stripTx = document.createElement('span');
  stripTx.className = 'scribe-am-strip-tx';
  const stripStop = document.createElement('button');
  stripStop.type = 'button';
  stripStop.className = 'scribe-am-strip-resume';
  stripStop.textContent = 'Stop';
  stripStop.style.display = 'none';
  const stripResume = document.createElement('button');
  stripResume.type = 'button';
  stripResume.className = 'scribe-am-strip-resume';
  stripResume.textContent = 'Resume';
  strip.append(stripIc, stripTx, stripStop, stripResume);

  const catalog = document.createElement('div');
  catalog.className = 'scribe-am-catalog';

  const thread = document.createElement('div');
  thread.className = 'scribe-am-thread';
  thread.style.display = 'none';

  // The assistant conversation view; the active document's rows are swapped in when it opens.
  const asstThread = document.createElement('div');
  asstThread.className = 'scribe-am-thread';
  asstThread.style.display = 'none';

  const composer = document.createElement('div');
  composer.className = 'scribe-am-composer';
  const cbox = document.createElement('div');
  cbox.className = 'scribe-am-cbox';
  const cinput = document.createElement('textarea');
  cinput.rows = 1;
  cinput.placeholder = 'Ask about this document';
  cinput.setAttribute('aria-label', 'Ask about this document');
  const cbar = document.createElement('div');
  cbar.className = 'scribe-am-cbar';
  const modelChip = document.createElement('button');
  modelChip.type = 'button';
  modelChip.className = 'scribe-am-model';
  modelChip.style.display = 'none';
  modelChip.setAttribute('aria-haspopup', 'menu');
  modelChip.setAttribute('aria-expanded', 'false');
  const modelLabel = document.createElement('span');
  const modelChev = document.createElement('span');
  modelChev.className = 'scribe-am-model-chev';
  modelChev.innerHTML = CHEVRON_SVG;
  modelChip.append(modelLabel, modelChev);
  const csend = document.createElement('span');
  csend.className = 'scribe-am-ib scribe-am-send';
  csend.role = 'button';
  csend.tabIndex = 0;
  csend.title = 'Send';
  csend.innerHTML = SEND_SVG;
  cbar.append(modelChip, csend);
  cbox.append(cinput, cbar);
  composer.appendChild(cbox);

  panelElem.append(hd, strip, catalog, thread, asstThread, composer);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'scribe-am-resize';
  panelElem.appendChild(resizeHandle);

  const toggleElem = makeIconButton('Automate', AUTOMATE_SVG);
  toggleElem.classList.add('cr-labeled-button', 'scribe-automate-toggle', 'scribe-phone-hide');
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'cr-btn-label';
  toggleLabel.textContent = 'Automate';
  toggleElem.appendChild(toggleLabel);

  /** 'rest' (catalog), 'thread' (one tool's run), or 'assistant' (the conversation). */
  let view = 'rest';
  let openState = false;
  /** @type {?string} The active tool mode's title, for the "For <mode>" catalog group. */
  let modeName = null;
  /** @type {?{entry: Object, title: string, status: 'form'|'running'|'done'|'failed', seen: boolean}} */
  let activeRun = null;
  /** What the strip currently pins, so its buttons act on the right thing. */
  let stripMode = 'auto';

  const setView = (next) => {
    view = next;
    closeModelMenu(false);
    const rest = next === 'rest';
    const asst = next === 'assistant';
    catalog.style.display = rest ? '' : 'none';
    composer.style.display = rest || asst ? '' : 'none';
    thread.style.display = next === 'thread' ? '' : 'none';
    asstThread.style.display = asst ? '' : 'none';
    backBtn.style.display = rest ? 'none' : '';
    hdIcon.style.display = rest ? '' : 'none';
    hdTitle.textContent = rest ? 'Automate' : asst ? 'Assistant' : (activeRun ? activeRun.title : 'Automate');
    if (asst) {
      const c = app.doc ? convos.get(app.doc) : null;
      if (c) c.unseen = false;
    }
    syncStrip();
    if (rest) paintCatalog();
  };

  function syncStrip() {
    const auto = view === 'rest' && activeRun
      && (activeRun.status === 'running' || (activeRun.status !== 'form' && !activeRun.seen));
    const c = app.doc ? convos.get(app.doc) : null;
    const asst = !auto && view !== 'assistant' && !!c && (c.running || c.unseen);
    stripMode = auto ? 'auto' : 'asst';
    strip.style.display = auto || asst ? 'flex' : 'none';
    stripStop.style.display = asst && c.running ? '' : 'none';
    if (auto) stripTx.textContent = `${activeRun.title} — ${activeRun.status === 'running' ? 'running…' : 'done'}`;
    else if (asst) stripTx.textContent = `Assistant — ${c.running ? 'working…' : 'done'}`;
  }

  function paintCatalog() {
    catalog.textContent = '';
    const addGroup = (label, entries) => {
      if (!entries.length) return;
      const h = document.createElement('div');
      h.className = 'scribe-am-cat';
      h.textContent = label;
      catalog.appendChild(h);
      for (const entry of entries) catalog.appendChild(buildRow(entry));
    };
    const modeGroup = modeName ? MODE_GROUPS[modeName] : null;
    if (modeGroup) {
      const entries = modeGroup.ids.map((id) => AUTOMATIONS.find((a) => a.id === id)).filter(Boolean);
      addGroup(modeGroup.label, entries);
    }
    for (const cat of CATEGORY_ORDER) {
      addGroup(cat, AUTOMATIONS.filter((a) => a.category === cat));
    }
  }

  function buildRow(entry) {
    const why = entry.disabledWhy(host.viewer);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `scribe-am-row${why ? ' disabled' : ''}`;
    const ic = document.createElement('span');
    ic.className = 'scribe-am-row-ic';
    ic.innerHTML = entry.svg || ROW_ICON_FALLBACK;
    const col = document.createElement('span');
    col.className = 'scribe-am-row-col';
    const title = document.createElement('span');
    title.className = 'scribe-am-row-title';
    title.textContent = entry.title;
    const desc = document.createElement('span');
    desc.className = 'scribe-am-row-desc';
    desc.textContent = why || entry.description;
    if (!why) desc.title = entry.description;
    col.append(title, desc);
    row.append(ic, col);
    if (entry.engine === 'ai-only') {
      const chip = document.createElement('span');
      chip.className = 'scribe-am-chip ai';
      chip.textContent = 'AI';
      row.appendChild(chip);
    } else if (entry.engine === 'ai-assisted') {
      const chip = document.createElement('span');
      chip.className = 'scribe-am-chip aiopt';
      chip.textContent = 'AI OPTIONAL';
      row.appendChild(chip);
    }
    if (!why) row.addEventListener('click', () => launch(entry));
    return row;
  }

  /**
   * Open a tool's thread, showing its form and then its run.
   * @param {Object} entry
   * @param {Object} [prefill]
   */
  async function launch(entry, prefill) {
    activeRun = {
      entry, title: entry.title, status: 'form', seen: true,
    };
    thread.textContent = '';
    setView('thread');
    let module;
    try {
      module = await entry.load();
    } catch (err) {
      console.error(`Failed to load the "${entry.id}" automation:`, err);
      renderFailed('The tool failed to load.');
      return;
    }
    // The user may have navigated away (or launched something else) while the module loaded.
    if (!activeRun || activeRun.entry !== entry) return;

    const form = module.buildForm ? module.buildForm(host, prefill) : null;
    if (!form) {
      const desc = document.createElement('p');
      desc.className = 'scribe-am-desc';
      desc.textContent = entry.description;
      thread.appendChild(desc);
    } else {
      thread.appendChild(form.formElem);
    }
    const foot = document.createElement('div');
    foot.className = 'scribe-am-foot';
    const grow = document.createElement('span');
    grow.className = 'scribe-am-foot-grow';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'scribe-am-quiet';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      activeRun = null;
      setView('rest');
    });
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'scribe-am-run';
    runBtn.textContent = 'Run';
    runBtn.addEventListener('click', () => {
      const params = form ? form.getParams() : null;
      if (form && params === null) return;
      startRun(entry, module, params);
    });
    foot.append(grow, cancel, runBtn);
    thread.appendChild(foot);
    if (form) form.focus();
  }

  const paramsLine = (module, entry, params) => (module.describeParams ? module.describeParams(params) : entry.description);

  function startRun(entry, module, params) {
    const run = {
      entry, title: entry.title, status: 'running', seen: view === 'thread',
    };
    activeRun = run;
    thread.textContent = '';
    const status = document.createElement('div');
    status.className = 'scribe-am-status';
    const statusParams = document.createElement('span');
    statusParams.className = 'scribe-am-status-params';
    statusParams.textContent = paramsLine(module, entry, params);
    statusParams.title = statusParams.textContent;
    const statusState = document.createElement('span');
    statusState.className = 'scribe-am-status-state';
    statusState.textContent = 'Running…';
    status.append(statusParams, statusState);
    const bar = document.createElement('div');
    bar.className = 'scribe-am-bar';
    const barFill = document.createElement('i');
    bar.appendChild(barFill);
    const caption = document.createElement('div');
    caption.className = 'scribe-am-caption';
    caption.textContent = '';
    thread.append(status, bar, caption);
    syncStrip();

    const progress = (frac, text) => {
      barFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
      caption.textContent = text || '';
    };

    module.run(host, params, progress).then((outcome) => {
      if (activeRun !== run) return;
      run.status = 'done';
      run.seen = view === 'thread';
      bar.remove();
      caption.remove();
      statusState.textContent = `Done ${formatTimestamp(new Date().toISOString())}`;
      statusState.classList.add('done');
      for (const rowSpec of outcome.rows || []) thread.appendChild(buildResultRow(rowSpec));
      if (outcome.review) {
        const foot = document.createElement('div');
        foot.className = 'scribe-am-foot';
        const grow = document.createElement('span');
        grow.className = 'scribe-am-foot-grow';
        const cta = document.createElement('button');
        cta.type = 'button';
        cta.className = 'scribe-am-run';
        cta.textContent = outcome.review.label;
        cta.addEventListener('click', () => outcome.review.onClick());
        foot.append(grow, cta);
        thread.appendChild(foot);
      }
      syncStrip();
    }).catch((err) => {
      console.error(`The "${entry.id}" automation failed:`, err);
      if (activeRun !== run) return;
      run.status = 'failed';
      run.seen = view === 'thread';
      bar.remove();
      caption.remove();
      statusState.textContent = 'Failed';
      statusState.classList.add('failed');
      renderFailed('Something went wrong — see the console for details.');
      syncStrip();
    });
  }

  function renderFailed(message) {
    thread.appendChild(buildResultRow({ kind: 'flag', text: message }));
  }

  function buildResultRow(spec) {
    const row = document.createElement('div');
    row.className = `scribe-am-result ${spec.kind || 'info'}`;
    const ic = document.createElement('span');
    ic.className = 'scribe-am-result-ic';
    ic.innerHTML = spec.kind === 'ok' ? CHECK_SVG : (spec.kind === 'flag' ? FLAG_SVG : FILE_SVG);
    const tx = document.createElement('span');
    tx.className = 'scribe-am-result-tx';
    tx.textContent = spec.text;
    tx.title = spec.text;
    row.append(ic, tx);
    if (spec.action) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'scribe-am-result-act';
      act.textContent = spec.action.label;
      act.addEventListener('click', spec.action.onClick);
      row.appendChild(act);
    }
    return row;
  }

  /**
   * One conversation per document, alive for the document session and gone with it.
   * `listElem` (display: contents) holds the conversation's rows so they lay out as thread items directly.
   * `adapter` holds whichever adapter the last turn ran on, for the export envelope's descriptor.
   * @type {WeakMap<Object, {messages: Array, listElem: HTMLElement, running: boolean, abort: ?AbortController, unseen: boolean,
   *   prose: ?HTMLElement, proseSrc: string, rail: ?HTMLElement, trace: ?import('../assistant/trace.js').AssistantTrace, adapter: ?Object}>}
   */
  const convos = new WeakMap();

  /** Aborts for every in-flight turn, so destroy can stop streams whose documents it can no longer reach. */
  const activeAborts = new Set();

  const convoFor = (doc) => {
    let c = convos.get(doc);
    if (!c) {
      c = {
        messages: [],
        listElem: document.createElement('div'),
        running: false,
        abort: null,
        unseen: false,
        prose: null,
        proseSrc: '',
        rail: null,
        trace: hooks.assistantTrace ? makeAssistantTrace() : null,
        adapter: null,
      };
      c.listElem.style.display = 'contents';
      convos.set(doc, c);
    }
    return c;
  };

  const scrollAssistant = () => {
    if (view === 'assistant') asstThread.scrollTop = asstThread.scrollHeight;
  };

  function openAssistant(doc) {
    const c = convoFor(doc);
    if (asstThread.firstChild !== c.listElem) {
      asstThread.textContent = '';
      asstThread.appendChild(c.listElem);
    }
    setView('assistant');
    asstThread.scrollTop = asstThread.scrollHeight;
  }

  const fitComposer = () => {
    cinput.style.height = 'auto';
    cinput.style.height = `${cinput.scrollHeight}px`;
  };

  const syncComposer = () => {
    const c = app.doc ? convos.get(app.doc) : null;
    const running = !!(c && c.running);
    csend.innerHTML = running ? STOP_SVG : SEND_SVG;
    csend.title = running ? 'Stop' : 'Send';
    csend.classList.toggle('stop', running);
    csend.classList.toggle('ready', !running && !!cinput.value.trim());
  };

  const stopTurn = () => {
    const c = app.doc ? convos.get(app.doc) : null;
    c?.abort?.abort();
  };

  /** @type {?HTMLElement} */
  let modelMenu = null;
  /** @type {?import('../assistant/assistant.js').AssistantAdapter} The adapter behind the chip, null when the active one offers no roster. */
  let modelAdapter = null;

  const modelLabelFor = (adapter) => adapter.models.find((m) => m.id === adapter.model)?.label ?? adapter.model;

  const setChipLabel = (label) => {
    modelLabel.textContent = label;
    modelChip.setAttribute('aria-label', `Model: ${label}`);
  };

  async function syncModelChip() {
    const adapter = await app.getAssistantAdapter();
    modelAdapter = adapter && Array.isArray(adapter.models) && adapter.models.length ? adapter : null;
    if (!modelAdapter) {
      closeModelMenu(false);
      modelChip.style.display = 'none';
      return;
    }
    modelChip.style.display = '';
    setChipLabel(modelLabelFor(modelAdapter));
  }

  function onModelMenuPointerDown(e) {
    if (modelMenu && !modelMenu.contains(e.target) && !modelChip.contains(e.target)) closeModelMenu(false);
  }

  function closeModelMenu(refocus) {
    if (!modelMenu) return;
    modelMenu.remove();
    modelMenu = null;
    modelChip.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onModelMenuPointerDown, true);
    if (refocus) modelChip.focus();
  }

  function pickModel(option) {
    const adapter = modelAdapter;
    const changed = adapter.model !== option.id;
    closeModelMenu(true);
    if (!changed) return;
    app.setAssistantModel(option.id);
    setChipLabel(modelLabelFor(adapter));
    const c = app.doc ? convos.get(app.doc) : null;
    if (c && c.messages.length) {
      const last = c.listElem.lastElementChild;
      if (last && last.classList.contains('scribe-as-mark')) {
        last.textContent = option.label;
      } else {
        const mark = document.createElement('div');
        mark.className = 'scribe-as-mark';
        mark.textContent = option.label;
        c.listElem.appendChild(mark);
      }
      c.prose = null;
      c.rail = null;
      scrollAssistant();
    }
  }

  function openModelMenu() {
    if (modelMenu) {
      closeModelMenu(true);
      return;
    }
    if (!modelAdapter) return;
    const menu = document.createElement('div');
    menu.className = 'scribe-am-mmenu';
    menu.setAttribute('role', 'menu');
    const rows = [];
    for (const option of modelAdapter.models) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'scribe-am-mrow';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(option.id === modelAdapter.model));
      const col = document.createElement('span');
      col.className = 'scribe-am-mcol';
      const name = document.createElement('span');
      name.className = 'scribe-am-mname';
      name.textContent = option.label;
      col.appendChild(name);
      if (option.hint) {
        const hint = document.createElement('span');
        hint.className = 'scribe-am-mhint';
        hint.textContent = option.hint;
        col.appendChild(hint);
      }
      const check = document.createElement('span');
      check.className = 'scribe-am-mcheck';
      check.innerHTML = CHECK_SVG;
      row.append(col, check);
      row.addEventListener('click', () => pickModel(option));
      rows.push(row);
      menu.appendChild(row);
    }
    menu.addEventListener('keydown', (e) => {
      const idx = rows.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        rows[(idx + 1) % rows.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        rows[(idx - 1 + rows.length) % rows.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        rows[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        rows[rows.length - 1].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeModelMenu(true);
      } else if (e.key === 'Tab') {
        closeModelMenu(false);
      }
    });
    menu.style.bottom = `${panelElem.clientHeight - composer.offsetTop + 6}px`;
    panelElem.appendChild(menu);
    modelMenu = menu;
    modelChip.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onModelMenuPointerDown, true);
    (rows.find((row) => row.getAttribute('aria-checked') === 'true') || rows[0]).focus();
  }

  /**
   * The receipt row: navigates on click, and carries the act's ordinary removal when it has one.
   * @param {import('../assistant/verbs.js').VerbReceipt} receipt
   * @param {number} tier
   */
  function receiptRow(receipt, tier) {
    const row = document.createElement('div');
    row.className = `scribe-as-receipt${tier >= 1 ? ' act' : ''}`;
    const ic = document.createElement('span');
    ic.className = 'scribe-as-receipt-ic';
    ic.innerHTML = tier >= 1 ? CHECK_SVG : READ_SVG;
    const tx = document.createElement('span');
    tx.className = 'scribe-as-receipt-tx';
    tx.textContent = receipt.label;
    tx.title = receipt.label;
    row.append(ic, tx);
    if (receipt.page != null) row.addEventListener('click', () => navigateToReceipt(app.scribe, receipt));
    if (receipt.remove) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'scribe-as-receipt-act';
      act.textContent = receipt.remove.label;
      act.addEventListener('click', (e) => {
        e.stopPropagation();
        receipt.remove.run();
        row.classList.add('removed');
        const tag = document.createElement('span');
        tag.className = 'scribe-as-removed-tag';
        tag.textContent = 'Removed';
        act.replaceWith(tag);
      });
      row.appendChild(act);
    }
    return row;
  }

  /**
   * Render one reply segment's accumulated markdown into `el`, replacing its contents.
   * @param {HTMLElement} el
   * @param {string} src - The segment's full markdown so far, not just the newest delta.
   */
  function renderProse(el, src) {
    const appendRuns = (parent, runs) => {
      for (const run of runs) {
        // Model text reaches the DOM only as text nodes, never through innerHTML.
        /** @type {Node} */
        let node = document.createTextNode(run.text);
        if (run.font === CODE_FONT_FAMILY) {
          const code = document.createElement('code');
          code.appendChild(node);
          node = code;
        }
        if (run.sup) {
          const sup = document.createElement('sup');
          sup.appendChild(node);
          node = sup;
        }
        if (run.italic) {
          const it = document.createElement('i');
          it.appendChild(node);
          node = it;
        }
        if (run.bold) {
          const b = document.createElement('b');
          b.appendChild(node);
          node = b;
        }
        // A run's link target is dropped, because a model-authored URL would bypass the external-link guard.
        parent.appendChild(node);
      }
    };

    const lines = src.split('\n');
    const blocks = parseMdBlocks(lines, collectMdRefs(lines), '');
    const frag = document.createDocumentFragment();
    /** @type {Array<{elem: HTMLElement, depth: number, ordered: boolean}>} */
    let lists = [];
    /** @type {?HTMLElement} */
    let quoteEl = null;
    for (const b of blocks) {
      if (b.quoted && !quoteEl) {
        quoteEl = document.createElement('blockquote');
        frag.appendChild(quoteEl);
        lists = [];
      } else if (!b.quoted && quoteEl) {
        quoteEl = null;
        lists = [];
      }
      const root = quoteEl || frag;
      if (b.kind === 'code') {
        lists = [];
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = b.runs.map((r) => r.text).join('');
        pre.appendChild(code);
        root.appendChild(pre);
      } else if (b.kind === 'heading') {
        lists = [];
        const h = document.createElement('div');
        h.className = 'scribe-as-h';
        appendRuns(h, b.runs);
        root.appendChild(h);
      } else if (b.listDepth !== null) {
        while (lists.length && lists[lists.length - 1].depth > b.listDepth) lists.pop();
        const ordered = /^\d/.test(b.marker || '');
        let top = lists[lists.length - 1];
        if (top && top.depth === b.listDepth && top.ordered !== ordered) {
          lists.pop();
          top = lists[lists.length - 1];
        }
        if (!top || top.depth < b.listDepth) {
          const listEl = document.createElement(ordered ? 'ol' : 'ul');
          const start = ordered && b.marker ? parseInt(b.marker, 10) : 1;
          if (start !== 1) listEl.start = start;
          (top ? (top.elem.lastElementChild || top.elem) : root).appendChild(listEl);
          top = { elem: listEl, depth: b.listDepth, ordered };
          lists.push(top);
        }
        const li = document.createElement('li');
        if (b.marker === '☐' || b.marker === '☑') {
          li.className = 'scribe-as-task';
          li.appendChild(document.createTextNode(`${b.marker} `));
        }
        appendRuns(li, b.runs);
        top.elem.appendChild(li);
      } else {
        lists = [];
        const p = document.createElement('p');
        if (b.kind === 'footnote' && b.footnoteLabel) {
          const sup = document.createElement('sup');
          sup.textContent = b.footnoteLabel;
          p.append(sup, ' ');
        }
        appendRuns(p, b.runs);
        root.appendChild(p);
      }
    }
    el.replaceChildren(frag);
  }

  async function runTurn(doc, c, adapter, ask) {
    c.running = true;
    c.abort = new AbortController();
    c.adapter = adapter;
    activeAborts.add(c.abort);
    syncComposer();
    syncStrip();
    let ghost = null;

    /**
     * The unbroken run of same-kind receipts currently accumulating on the rail.
     * @type {?{key: string, verbName: string, pending: Array<{receipt: Object, row: HTMLElement}>, batch: ?Object}}
     */
    let actRun = null;

    // Auto-follow yields while the pointer is inside the window, so a row is not scrolled out from under a click.
    const windowScroll = (exp) => {
      if (exp.style.display !== 'none' && !exp.matches(':hover')) exp.scrollTop = exp.scrollHeight;
    };

    /** End the accumulating run and fold its open item window into the resting batch row. */
    const foldRunWindow = () => {
      const b = actRun?.batch;
      actRun = null;
      if (!b || b.exp.style.display === 'none') return;
      const exp = b.exp;
      // The reflow pins the starting height, so the collapse animates instead of jumping.
      exp.style.maxHeight = `${exp.scrollHeight}px`;
      exp.getBoundingClientRect();
      exp.classList.add('scribe-as-exp-fold');
      b.row.classList.remove('open');
      setTimeout(() => {
        exp.classList.remove('scribe-as-exp-fold');
        exp.style.maxHeight = '';
        exp.style.display = 'none';
      }, 200);
    };

    const removedTag = () => {
      const tag = document.createElement('span');
      tag.className = 'scribe-as-removed-tag';
      tag.textContent = 'Removed';
      return tag;
    };

    const appendToBatch = (receipt, alreadyRemoved) => {
      const b = actRun.batch;
      b.units += receipt.batch.units ?? 1;
      b.pages.push(receipt.page);
      if (receipt.batch.removeAllLabel) b.removeAllLabel = receipt.batch.removeAllLabel;
      const lo = Math.min(...b.pages) + 1;
      const hi = Math.max(...b.pages) + 1;
      b.tx.textContent = receipt.batch.label(b.units, lo === hi ? `page ${lo}` : `pages ${lo}–${hi}`);
      b.tx.title = b.tx.textContent;

      const item = document.createElement('div');
      item.className = 'scribe-as-item';
      item.tabIndex = 0;
      const pg = document.createElement('span');
      pg.className = 'scribe-as-item-pg';
      pg.textContent = String(receipt.page + 1);
      const tx = document.createElement('span');
      tx.className = 'scribe-as-item-tx';
      tx.textContent = receipt.quote ? `“${receipt.quote}”` : receipt.label;
      tx.title = tx.textContent;
      item.append(pg, tx);
      item.addEventListener('click', () => navigateToReceipt(app.scribe, receipt));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') navigateToReceipt(app.scribe, receipt);
      });
      const entry = { receipt, item, removed: false };
      const markRemoved = () => {
        entry.removed = true;
        item.classList.add('removed');
        b.removed += 1;
        b.dim.textContent = `· ${b.removed} removed`;
      };
      if (alreadyRemoved) {
        item.appendChild(removedTag());
        markRemoved();
      } else if (receipt.remove) {
        const act = document.createElement('button');
        act.type = 'button';
        act.className = 'scribe-as-receipt-act';
        act.textContent = receipt.remove.label;
        act.addEventListener('click', (e) => {
          e.stopPropagation();
          receipt.remove.run();
          act.replaceWith(removedTag());
          markRemoved();
        });
        item.appendChild(act);
      }
      b.entries.push(entry);
      b.exp.appendChild(item);
      windowScroll(b.exp);

      if (receipt.remove && b.removeAllLabel && !b.actBtn) {
        const act = document.createElement('button');
        act.type = 'button';
        act.className = 'scribe-as-receipt-act';
        act.textContent = 'Remove all';
        act.addEventListener('click', (e) => {
          e.stopPropagation();
          doc.docHistory.group(b.removeAllLabel, () => {
            for (const en of b.entries) {
              if (!en.removed && en.receipt.remove) en.receipt.remove.run();
            }
          });
          for (const en of b.entries) {
            if (en.removed) continue;
            en.removed = true;
            en.item.classList.add('removed');
            en.item.querySelector('.scribe-as-receipt-act')?.replaceWith(removedTag());
          }
          b.row.classList.add('removed');
          b.dim.textContent = '';
          b.chev.remove();
          act.replaceWith(removedTag());
          b.exp.style.display = 'none';
          if (actRun?.batch === b) actRun = null;
        });
        b.row.insertBefore(act, b.chev);
        b.chev.style.marginLeft = '';
        b.actBtn = act;
      }
    };

    const convertToBatch = () => {
      const b = {
        units: 0, pages: [], removed: 0, entries: [], removeAllLabel: null, actBtn: null,
      };
      b.row = document.createElement('div');
      b.row.className = 'scribe-as-receipt act open';
      b.row.tabIndex = 0;
      const ic = document.createElement('span');
      ic.className = 'scribe-as-receipt-ic';
      ic.innerHTML = CHECK_SVG;
      b.tx = document.createElement('span');
      b.tx.className = 'scribe-as-receipt-tx';
      b.dim = document.createElement('span');
      b.dim.className = 'scribe-as-batch-dim';
      b.chev = document.createElement('span');
      b.chev.className = 'scribe-as-chev';
      b.chev.innerHTML = CHEVRON_SVG;
      b.chev.style.marginLeft = 'auto';
      b.row.append(ic, b.tx, b.dim, b.chev);
      b.exp = document.createElement('div');
      b.exp.className = 'scribe-as-exp';
      const toggleExp = () => {
        if (b.row.classList.contains('removed')) return;
        const open = b.exp.style.display === 'none';
        b.exp.style.display = open ? '' : 'none';
        b.row.classList.toggle('open', open);
      };
      b.row.addEventListener('click', toggleExp);
      b.row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleExp();
        }
      });
      const first = actRun.pending[0].row;
      c.rail.insertBefore(b.row, first);
      c.rail.insertBefore(b.exp, first);
      actRun.batch = b;
      const pending = actRun.pending;
      actRun.pending = [];
      for (const p of pending) {
        p.row.remove();
        appendToBatch(p.receipt, p.row.classList.contains('removed'));
      }
    };

    try {
      c.messages = await runAssistantTurn({
        host,
        adapter,
        messages: c.messages,
        ask,
        signal: c.abort.signal,
        trace: c.trace ?? undefined,
        onText: (delta) => {
          if (!c.prose) {
            foldRunWindow();
            const p = document.createElement('div');
            p.className = 'scribe-as-prose';
            c.listElem.appendChild(p);
            c.prose = p;
            c.proseSrc = '';
            c.rail = null;
          }
          c.proseSrc += delta;
          renderProse(c.prose, c.proseSrc);
          scrollAssistant();
        },
        onVerbStart: ({ call, caption }) => {
          if (!c.rail) {
            const r = document.createElement('div');
            r.className = 'scribe-as-rail';
            c.listElem.appendChild(r);
            c.rail = r;
            c.prose = null;
          }
          ghost = document.createElement('div');
          ghost.className = 'scribe-as-ghost';
          const ic = document.createElement('span');
          ic.className = 'scribe-as-receipt-ic';
          ic.innerHTML = SPIN_SVG;
          const tx = document.createElement('span');
          tx.className = 'scribe-as-receipt-tx';
          tx.textContent = caption;
          ghost.append(ic, tx);
          const b = actRun?.batch;
          const inWindow = !!b && actRun.verbName === call.name && b.exp.style.display !== 'none';
          (inWindow ? b.exp : c.rail).appendChild(ghost);
          if (inWindow) windowScroll(b.exp);
          scrollAssistant();
        },
        onVerbEnd: ({ call, res }) => {
          if (ghost) {
            ghost.remove();
            ghost = null;
          }
          if (!res.receipt || !c.rail) return;
          const receipt = res.receipt;
          const key = receipt.batch && receipt.page != null ? `${call.name}:${receipt.batch.key}` : null;
          if (actRun && actRun.key !== key) foldRunWindow();
          if (!key) {
            c.rail.appendChild(receiptRow(receipt, VERBS.find((v) => v.name === call.name)?.tier ?? 0));
          } else {
            if (!actRun) {
              actRun = {
                key, verbName: call.name, pending: [], batch: null,
              };
            }
            if (actRun.batch) {
              appendToBatch(receipt, false);
            } else {
              const row = receiptRow(receipt, VERBS.find((v) => v.name === call.name)?.tier ?? 0);
              c.rail.appendChild(row);
              actRun.pending.push({ receipt, row });
              if (actRun.pending.length >= 3) convertToBatch();
            }
          }
          scrollAssistant();
        },
      });
    } catch (err) {
      // A user-initiated Stop aborts the stream mid-read; everything already landed stays, and that is not a failure.
      if (!c.abort?.signal.aborted) {
        console.error('The assistant turn failed:', err);
        const flag = document.createElement('div');
        flag.className = 'scribe-as-flag';
        const ic = document.createElement('span');
        ic.className = 'scribe-as-receipt-ic';
        ic.innerHTML = FLAG_SVG;
        const tx = document.createElement('span');
        tx.className = 'scribe-as-receipt-tx';
        tx.textContent = 'Something went wrong — see the console for details.';
        flag.append(ic, tx);
        c.listElem.appendChild(flag);
        scrollAssistant();
      }
    } finally {
      if (ghost) ghost.remove();
      foldRunWindow();
      c.running = false;
      activeAborts.delete(c.abort);
      c.abort = null;
      c.prose = null;
      c.rail = null;
      c.unseen = view !== 'assistant';
      syncComposer();
      syncStrip();
    }
  }

  /** @type {?HTMLElement} */
  let keyCard = null;

  /** The in-panel key surface. Opened by a keyless ask; the pending ask stays in the composer and sends on save. */
  function showKeyCard() {
    keyCard?.remove();
    keyCard = document.createElement('div');
    keyCard.className = 'scribe-as-key';
    const title = document.createElement('b');
    title.textContent = 'AI assistant';
    const explain = document.createElement('span');
    explain.style.color = 'var(--scribe-ink-2)';
    explain.style.fontSize = '12px';
    explain.textContent = 'Paste an Anthropic API key. Calls go directly from this browser to Anthropic; the key is never sent anywhere else.';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'sk-ant-…';
    const error = document.createElement('span');
    error.className = 'scribe-as-key-error';
    error.style.display = 'none';
    const foot = document.createElement('div');
    foot.className = 'scribe-am-foot';
    const grow = document.createElement('span');
    grow.className = 'scribe-am-foot-grow';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'scribe-am-quiet';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { keyCard.remove(); keyCard = null; });
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'scribe-am-run';
    save.textContent = 'Save key';
    const submit = async () => {
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      try {
        await app.setAssistantKey(key);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        error.style.display = '';
        return;
      }
      keyCard.remove();
      keyCard = null;
      syncModelChip();
      submitAsk();
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    foot.append(grow, cancel, save);
    if (app.getStoredAssistantKey?.()) {
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'scribe-am-quiet';
      forget.textContent = 'Forget key';
      forget.addEventListener('click', () => {
        app.forgetAssistantKey();
        keyCard.remove();
        keyCard = null;
        syncModelChip();
      });
      foot.insertBefore(forget, grow);
    }
    const note = document.createElement('span');
    note.className = 'scribe-as-key-note';
    note.textContent = 'The key is saved in this browser until you remove it.';
    keyCard.append(title, explain, input, error, foot, note);
    setView('rest');
    catalog.insertBefore(keyCard, catalog.firstChild);
    input.focus();
  }

  async function submitAsk() {
    const doc = app.doc;
    if (!doc || doc.pageMetrics.length === 0) return;
    const text = cinput.value.trim();
    if (!text) return;
    const c = convoFor(doc);
    if (c.running) return;
    const adapter = await app.getAssistantAdapter();
    if (!adapter) {
      showKeyCard();
      return;
    }
    cinput.value = '';
    fitComposer();
    openAssistant(doc);
    const row = document.createElement('div');
    row.className = 'scribe-as-user';
    const tx = document.createElement('span');
    tx.className = 'scribe-as-user-tx';
    tx.textContent = text;
    row.appendChild(tx);
    c.listElem.appendChild(row);
    c.prose = null;
    c.rail = null;
    scrollAssistant();
    runTurn(doc, c, adapter, text);
  }

  backBtn.addEventListener('click', () => {
    if (activeRun && activeRun.status === 'form') activeRun = null;
    setView('rest');
  });
  stripStop.addEventListener('click', stopTurn);
  stripResume.addEventListener('click', () => {
    if (stripMode === 'asst') {
      if (app.doc) openAssistant(app.doc);
      return;
    }
    if (!activeRun) return;
    activeRun.seen = true;
    setView('thread');
  });

  cinput.addEventListener('input', () => {
    fitComposer();
    syncComposer();
  });
  cinput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const c = app.doc ? convos.get(app.doc) : null;
      if (!c || !c.running) submitAsk();
    } else if (e.key === 'Escape') {
      stopTurn();
    }
  });
  csend.addEventListener('click', () => {
    const c = app.doc ? convos.get(app.doc) : null;
    if (c && c.running) stopTurn();
    else submitAsk();
  });
  modelChip.addEventListener('click', openModelMenu);

  /**
   * Set the panel width.
   * @param {number} px
   * @returns {number} The applied width, clamped to the panel's bounds.
   */
  const setWidth = (px) => {
    const containerW = (panelElem.parentElement && panelElem.parentElement.clientWidth) || 0;
    const max = Math.max(AUTOMATE_MIN_WIDTH, Math.min(AUTOMATE_MAX_WIDTH, containerW - 80));
    const applied = Math.max(AUTOMATE_MIN_WIDTH, Math.min(max, Math.round(px)));
    panelElem.style.width = `${applied}px`;
    return applied;
  };

  let resizeStartX = 0;
  let resizeStartW = 0;
  function onResizeMove(e) {
    hooks.onResize(resizeStartW - (e.clientX - resizeStartX), 'move');
  }
  function onResizeEnd(e) {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    window.removeEventListener('pointercancel', onResizeEnd);
    hooks.onResize(resizeStartW - (e.clientX - resizeStartX), 'end');
  }
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizeStartX = e.clientX;
    resizeStartW = parseFloat(panelElem.style.width) || panelElem.getBoundingClientRect().width;
    hooks.onResize(resizeStartW, 'start');
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
    // The host stays in its drag regime until an 'end' report, so a canceled drag must deliver one too.
    window.addEventListener('pointercancel', onResizeEnd);
  });

  const open = () => {
    if (openState) return;
    openState = true;
    panelElem.style.display = 'flex';
    toggleElem.classList.add('active');
    if (view === 'rest') paintCatalog();
    syncModelChip();
    hooks.onLayoutChange();
  };
  const close = () => {
    if (!openState) return;
    openState = false;
    closeModelMenu(false);
    panelElem.style.display = 'none';
    toggleElem.classList.remove('active');
    hooks.onLayoutChange();
  };
  toggleElem.addEventListener('click', () => (openState ? close() : open()));
  closeBtn.addEventListener('click', close);

  // The catalog's enabled/disabled reasons and the conversation both belong to the active document.
  const onDocChange = () => {
    if (!openState) return;
    if (view === 'assistant') setView('rest');
    else if (view === 'rest') paintCatalog();
    syncComposer();
    syncStrip();
  };
  app.container.addEventListener('scribe-active-doc-change', onDocChange);

  return {
    panelElem,
    toggleElem,
    get width() { return parseFloat(panelElem.style.width) || AUTOMATE_PANEL_WIDTH; },
    setWidth,
    open,
    close,
    isOpen: () => openState,
    /** Called by the mode-change funnel so the catalog can surface the active mode's automations. */
    syncMode: (name) => {
      if (name === modeName) return;
      modeName = name;
      if (openState && view === 'rest') paintCatalog();
    },
    /**
     * The document's conversation trace as a versioned envelope, for the dev-only log export.
     * Null when tracing is off or the document has no conversation.
     * @param {?import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
     */
    exportTrace: (doc) => {
      if (!doc) return null;
      const c = convos.get(doc);
      if (!c?.trace) return null;
      return buildTraceEnvelope(c.trace, {
        adapter: c.adapter,
        doc: { baseName: app._baseName(), pageCount: doc.pageMetrics.length },
        flags: { automate: true, assistantTrace: true },
        messages: c.messages,
      });
    },
    /**
     * Open the panel with Redact terms staged from a selection, for the selection menu's hand-off row.
     * The form is only staged, so Run stays a deliberate click.
     */
    stageRedactTerms: (term) => {
      open();
      const entry = AUTOMATIONS.find((a) => a.id === 'redact-terms');
      if (entry) launch(entry, { terms: [term] });
    },
    destroy: () => {
      for (const abort of activeAborts) abort.abort();
      activeAborts.clear();
      closeModelMenu(false);
      app.container.removeEventListener('scribe-active-doc-change', onDocChange);
    },
  };
}
