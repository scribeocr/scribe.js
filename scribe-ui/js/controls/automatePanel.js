import { makeIconButton, formatTimestamp } from './toolbar.js';
import {
  AUTOMATIONS, CATEGORY_ORDER, MODE_GROUPS, SIDEBAR_GROUPS,
} from '../automations/registry.js';
import { runAssistantTurn } from '../assistant/assistant.js';
import { makeAssistantTrace, buildTraceEnvelope } from '../assistant/trace.js';
import { VERBS, navigateToReceipt } from '../assistant/verbs.js';
import { CODE_FONT_FAMILY, collectMdRefs, parseMdBlocks } from '../../../js/utils/parseMd.js';

const lineIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

/** The Automate identity glyph, drawn on the toolbar opener and the panel header. */
const AUTOMATE_SVG = lineIcon('<path d="M5 7.2l5.6 4.8L5 16.8z"/><path d="M14 7.5h5.5M14 12h5.5M14 16.5h3.5"/>');
// Drawn in the header when the panel opens straight into the Inspect Document workspace, with no catalog behind it.
const INSPECT_SVG = lineIcon('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.01"/>');
const BACK_SVG = lineIcon('<path d="M14 6l-6 6 6 6"/>');
const SEND_SVG = lineIcon('<path d="M4.5 11.4L19.5 4.5 15.6 19.5l-3.9-5.2z"/><path d="M11.7 14.3l7.8-9.8"/>');
const SPIN_SVG = lineIcon('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5"/>');
const STOP_SVG = lineIcon('<rect x="7" y="7" width="10" height="10" rx="1.5"/>');
const READ_SVG = lineIcon('<path d="M12 5.5C9.8 4 6.8 3.8 4 4.4v14.2c2.8-.6 5.8-.4 8 1.1 2.2-1.5 5.2-1.7 8-1.1V4.4c-2.8-.6-5.8-.4-8 1.1z"/><path d="M12 5.5v14.2"/>');
const CHEVRON_SVG = lineIcon('<path d="M7.5 10l4.5 4.5 4.5-4.5"/>');
const CHECK_SVG = lineIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const X_SVG = lineIcon('<path d="M7 7l10 10M17 7L7 17"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');
const FILE_SVG = lineIcon('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13 3.5V8h4.5"/>');
const INFO_SVG = lineIcon('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.01"/>');
const CHAT_SVG = lineIcon('<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-3.5 3v-3h-2v-9z"/>');
const PLUS_SVG = lineIcon('<path d="M12 5.5v13M5.5 12h13"/>');
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
    .${r} .scribe-am-tray { flex: none; background: var(--scribe-canvas); border-bottom: 1px solid var(--scribe-line); padding: 5px 6px 4px; }
    .${r} .scribe-am-crow {
      display: flex; align-items: flex-start; gap: 10px; padding: 8px 11px; border-radius: 7px; cursor: pointer;
      width: 100%; box-sizing: border-box; border: none; background: none; font: inherit; color: inherit; text-align: left;
      -webkit-tap-highlight-color: transparent;
    }
    .${r} .scribe-am-crow:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-crow:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: -2px; }
    .${r} .scribe-am-crow-ic { width: 16px; height: 16px; color: var(--scribe-ink-2); flex: none; margin-top: 2px; }
    .${r} .scribe-am-crow-col { min-width: 0; flex: 1; display: grid; gap: 1px; }
    .${r} .scribe-am-crow-title { font-size: 13px; color: var(--scribe-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-crow-snip { font-size: 12px; color: var(--scribe-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-crow-time { flex: none; font-size: 11px; color: var(--scribe-ink-3); font-variant-numeric: tabular-nums; margin-top: 2px; }
    .${r} .scribe-am-tray-all {
      display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; border: none; background: none;
      font: inherit; font-size: 12px; font-weight: 600; color: var(--scribe-accent); cursor: pointer;
      padding: 5px 11px; border-radius: 6px; text-align: left; -webkit-tap-highlight-color: transparent;
    }
    .${r} .scribe-am-tray-all:hover { background: var(--scribe-active); }
    .${r} .scribe-am-tray-all svg { width: 11px; height: 11px; transform: rotate(-90deg); }
    .${r} .scribe-as-run { display: grid; gap: 7px; border: 1px solid var(--scribe-line); border-radius: 8px; background: var(--scribe-canvas); padding: 9px 10px; }
    .${r} .scribe-as-run-hd { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .${r} .scribe-as-run-ic { width: 14px; height: 14px; flex: none; color: var(--scribe-ink-2); }
    .${r} .scribe-as-run-tt { font-size: 12.5px; font-weight: 600; color: var(--scribe-ink); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-as-run-st { margin-left: auto; flex: none; font-size: 11px; font-weight: 600; color: #2e7d4f; }
    .${r}[data-theme="dark"] .scribe-as-run-st { color: #5abd85; }
    .${r} .scribe-as-run-st.undone { color: var(--scribe-ink-3); }
    .${r} .scribe-as-run-params { font-size: 11.5px; color: var(--scribe-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-as-run-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
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
    .${r} .scribe-am-rdwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .${r} .scribe-am-rdbody {
      flex: 1; overflow-y: auto; overflow-x: hidden; padding: 12px; min-height: 0;
      display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-content: start;
    }
    .${r} .scribe-am-trow {
      display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 7px 9px;
      border-radius: 7px; align-items: center;
    }
    .${r} .scribe-am-trow:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-trow-t { font-size: 13px; color: var(--scribe-ink); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-trow-n { font-size: 12px; color: var(--scribe-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; grid-column: 1; }
    .${r} .scribe-am-trow-acts { grid-row: 1 / span 2; grid-column: 2; display: inline-flex; gap: 2px; visibility: hidden; }
    .${r} .scribe-am-trow:hover .scribe-am-trow-acts, .${r} .scribe-am-trow.menuopen .scribe-am-trow-acts { visibility: visible; }
    .${r} .scribe-am-trow.removed .scribe-am-trow-t, .${r} .scribe-am-trow.removed .scribe-am-trow-n { text-decoration: line-through; color: var(--scribe-ink-3); }
    .${r} .scribe-am-trow-mode { cursor: pointer; }
    .${r} .scribe-am-trow-mode:hover { color: var(--scribe-accent); }
    .${r} .scribe-am-trow-mode:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: 1px; border-radius: 3px; }
    .${r} .scribe-am-trow-edit {
      border: 1px solid var(--scribe-accent); border-radius: 4px; font: inherit; font-size: 12.5px;
      color: var(--scribe-ink); background: var(--scribe-surface); padding: 1px 5px; width: 140px; outline: none;
    }
    .${r} .scribe-am-rdfoot { flex: none; border-top: 1px solid var(--scribe-line); padding: 9px 12px; display: grid; gap: 7px; }
    .${r} .scribe-am-rdsum { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--scribe-ink-2); }
    .${r} .scribe-am-rdsum b { color: var(--scribe-ink); font-weight: 600; }
    .${r} .scribe-am-rdnote { font-size: 11px; color: var(--scribe-ink-3); }
    .${r} .scribe-am-rdrescan { color: var(--scribe-accent); cursor: pointer; }
    .${r} .scribe-am-rdrescan:hover { text-decoration: underline; }
    .${r} .scribe-am-thread {
      flex: 1; overflow-y: auto; overflow-x: hidden; padding: 12px; min-height: 0;
      display: grid; grid-template-columns: minmax(0, 1fr); gap: 11px; align-content: start;
    }
    .${r} .scribe-am-tables { flex: 1; min-height: 0; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    /* Without user-select none, shift-click in this list runs the browser's text selection. */
    /* Rows sit flush because a row gap would break a selected run's capsule into segments. */
    .${r} .scribe-am-xtlist { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; user-select: none; }
    .${r} .scribe-am-xtrow {
      display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--scribe-ink);
      padding: 4px 7px; border-radius: 6px; cursor: pointer; min-width: 0;
    }
    .${r} .scribe-am-xtrow:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-xtrow.sel { background: var(--scribe-active); }
    .${r} .scribe-am-xtrow-tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-am-xtrow.sub { padding-left: 36px; font-size: 12px; color: var(--scribe-ink-2); }
    .${r} .scribe-am-xtglyph { width: 13px; height: 13px; flex: none; color: var(--scribe-ink-3); display: inline-flex; }
    .${r} .scribe-am-xtglyph.link { color: var(--scribe-accent); }
    .${r} .scribe-am-xtglyph.link.muted { color: var(--scribe-ink-3); }
    .${r} .scribe-am-xtglyph.chev { cursor: pointer; transition: transform 140ms; }
    .${r} .scribe-am-xtglyph.chev.open { transform: rotate(90deg); }
    .${r} .scribe-am-xtsugdiv { display: flex; align-items: center; gap: 8px; padding: 10px 7px 3px; font-size: 10.5px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--scribe-ink-3); }
    .${r} .scribe-am-xtsugdiv::after { content: ''; flex: 1; border-top: 1px solid var(--scribe-line); order: 1; }
    .${r} .scribe-am-xtsugall { order: 2; border: 0; background: none; color: var(--scribe-accent); font: 600 11.5px inherit; font-family: inherit; cursor: pointer; padding: 0; text-transform: none; letter-spacing: 0; }
    .${r} .scribe-am-xtwhy { color: var(--scribe-ink-3); font-size: 11px; }
    .${r} .scribe-am-xtsugacts { margin-left: auto; display: inline-flex; gap: 2px; flex: none; }
    /* Revealed by visibility, not display, and capped to the text height, so hovering a row shifts nothing. */
    .${r} .scribe-am-xtsubacts { margin-left: auto; display: inline-flex; visibility: hidden; flex: none; }
    .${r} .scribe-am-xtsubacts .scribe-am-xtsugact { height: 14px; padding: 1px 2px; }
    .${r} .scribe-am-xtrow:hover .scribe-am-xtsubacts, .${r} .scribe-am-xtrow:focus-within .scribe-am-xtsubacts { visibility: visible; }
    /* Inset shadows, not borders, so selecting a row never shifts the list. */
    .${r} .scribe-am-xtrow.msel {
      background: var(--scribe-active); border-radius: 0;
      box-shadow: inset 1px 0 0 var(--scribe-accent-ring), inset -1px 0 0 var(--scribe-accent-ring);
    }
    .${r} .scribe-am-xtrow.msel.cap-top {
      border-radius: 6px 6px 0 0;
      box-shadow: inset 1px 0 0 var(--scribe-accent-ring), inset -1px 0 0 var(--scribe-accent-ring), inset 0 1px 0 var(--scribe-accent-ring);
    }
    .${r} .scribe-am-xtrow.msel.cap-bot {
      border-radius: 0 0 6px 6px;
      box-shadow: inset 1px 0 0 var(--scribe-accent-ring), inset -1px 0 0 var(--scribe-accent-ring), inset 0 -1px 0 var(--scribe-accent-ring);
    }
    .${r} .scribe-am-xtrow.msel.cap-solo { border-radius: 6px; box-shadow: inset 0 0 0 1px var(--scribe-accent-ring); }
    .${r} .scribe-am-xtrow.msel .scribe-am-xtsubacts { visibility: visible; }
    .${r} .scribe-am-xtsugact { border: 0; background: none; cursor: pointer; border-radius: 4px; padding: 2px; width: 20px; height: 20px; color: var(--scribe-accent); }
    .${r} .scribe-am-xtsugact.muted { color: var(--scribe-ink-3); }
    .${r} .scribe-am-xtsugact:hover { background: var(--scribe-accent-wash); }
    @media (prefers-reduced-motion: reduce) { .${r} .scribe-am-xtglyph.chev { transition: none; } }
    .${r} .scribe-am-xtfoot { flex: none; border-top: 1px solid var(--scribe-line); margin: 0 -12px -12px; padding: 8px 12px 12px; display: grid; gap: 8px; }
    .${r} .scribe-am-xtsum {
      display: flex; align-items: center; gap: 7px; width: 100%; box-sizing: border-box; border: none; background: none;
      font: inherit; font-size: 12px; color: var(--scribe-ink-2); cursor: pointer; padding: 4px 6px; border-radius: 6px; text-align: left;
    }
    .${r} .scribe-am-xtsum:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-xtsum.open svg { transform: rotate(180deg); }
    .${r} .scribe-am-xtreceipt { display: grid; gap: 6px; border: 1px solid var(--scribe-line); border-radius: 7px; background: var(--scribe-canvas); padding: 9px 10px; }
    .${r} .scribe-am-xtexport { display: flex; justify-content: flex-end; }
    .${r} .scribe-am-catalog::-webkit-scrollbar, .${r} .scribe-am-thread::-webkit-scrollbar, .${r} .scribe-am-rdbody::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-am-catalog::-webkit-scrollbar-track, .${r} .scribe-am-thread::-webkit-scrollbar-track, .${r} .scribe-am-rdbody::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-am-catalog::-webkit-scrollbar-thumb, .${r} .scribe-am-thread::-webkit-scrollbar-thumb, .${r} .scribe-am-rdbody::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
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
    .${r} .scribe-am-input {
      border: 1px solid var(--scribe-line-strong); border-radius: 7px; padding: 6px 8px; background: var(--scribe-canvas);
      font: inherit; font-size: 12.5px; color: var(--scribe-ink); outline: none; width: 130px;
    }
    .${r} .scribe-am-input:focus { border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-am-input::placeholder { color: var(--scribe-ink-3); }
    .${r} .scribe-am-opts { display: flex; gap: 14px; flex-wrap: wrap; }
    .${r} .scribe-am-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--scribe-ink); cursor: pointer; }
    .${r} .scribe-am-check input { accent-color: var(--scribe-accent); margin: 0; }
    .${r} .scribe-am-check.off { color: var(--scribe-ink-3); cursor: default; }
    .${r} .scribe-am-note {
      display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--scribe-ink-2);
      background: var(--scribe-canvas); border: 1px solid var(--scribe-line); border-radius: 7px; padding: 8px 10px;
    }
    .${r} .scribe-am-note.quiet { background: none; border: none; padding: 0; }
    .${r} .scribe-am-note-ic { width: 14px; height: 14px; flex: none; color: var(--scribe-ink-3); margin-top: 1px; }
    .${r} .scribe-am-note-ic svg { width: 100%; height: 100%; display: block; }
    .${r} .scribe-am-boost { display: grid; gap: 3px; }
    .${r} .scribe-am-boost-hint { font-size: 11px; color: var(--scribe-ink-3); margin-left: 22px; }
    .${r} .scribe-am-offer {
      display: grid; gap: 8px; border: 1px solid var(--scribe-line); border-radius: 7px;
      background: var(--scribe-canvas); padding: 9px 10px; font-size: 12px; color: var(--scribe-ink-2);
    }
    .${r} .scribe-am-offer-row { display: flex; align-items: flex-start; gap: 8px; }
    .${r} .scribe-am-offer-act {
      justify-self: end; border: none; background: none; font: inherit; font-size: 12px; font-weight: 600;
      color: var(--scribe-accent); cursor: pointer; padding: 2px 8px; border-radius: 5px; white-space: nowrap;
    }
    .${r} .scribe-am-offer-act:hover { background: var(--scribe-active); }
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
    .${r} .scribe-am-inswrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .${r} .scribe-am-ins { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 2px 12px 12px; }
    .${r} .scribe-am-ins::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-am-ins::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-am-ins::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
    .${r} .scribe-am-ins .scribe-am-cat { padding: 10px 0 3px; }
    .${r} .scribe-am-ins-kv { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 0 10px; padding: 3px 0; font-size: 12.5px; line-height: 1.35; }
    .${r} .scribe-am-ins-k { color: var(--scribe-ink-2); }
    .${r} .scribe-am-ins-v { color: var(--scribe-ink); overflow-wrap: anywhere; }
    .${r} .scribe-am-ins-notset { color: var(--scribe-ink-3); font-style: italic; }
    .${r} .scribe-am-ins-empty { padding: 6px 0 4px; }
    .${r} .scribe-am-ins-scope { margin: 10px 0 0; gap: 14px; }
    .${r} .scribe-am-ins-size { display: grid; gap: 2px 0; margin: 2px 0 4px; }
    .${r} .scribe-am-ins-cat { display: grid; grid-template-columns: minmax(0, 1fr) auto 34px; gap: 0 8px; font-size: 12px; line-height: 1.3; padding-top: 3px; align-items: baseline; }
    .${r} .scribe-am-ins-cat-l { color: var(--scribe-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-am-ins-cat-n { color: var(--scribe-ink-3); }
    .${r} .scribe-am-ins-cat-b { color: var(--scribe-ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .${r} .scribe-am-ins-cat-p { color: var(--scribe-ink-3); text-align: right; font-variant-numeric: tabular-nums; }
    .${r} .scribe-am-ins-bar { margin: 3px 0 2px; }
    .${r} .scribe-am-ins-bar > i { transition: none; }
    .${r} .scribe-am-ins-note { font-size: 11px; color: var(--scribe-ink-3); padding: 2px 0 0; }
    .${r} .scribe-am-ins-tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
    .${r} .scribe-am-ins-tbl th { text-align: left; font-weight: 600; color: var(--scribe-ink-2); padding: 4px 4px; border-bottom: 1px solid var(--scribe-line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${r} .scribe-am-ins-tbl td { padding: 4px 4px; border-bottom: 1px solid var(--scribe-line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
    .${r} .scribe-am-ins-tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
    .${r} .scribe-am-ins-tbl tr.x { cursor: pointer; }
    .${r} .scribe-am-ins-tbl tr.x:hover td { background: var(--scribe-hover); }
    .${r} .scribe-am-ins-tbl tr.sel td { background: var(--scribe-active); color: var(--scribe-accent); }
    .${r} .scribe-am-ins-emb.no { color: #b45309; font-weight: 600; }
    .${r}[data-theme="dark"] .scribe-am-ins-emb.no { color: #f0b35a; }
    .${r} .scribe-am-ins-tw { display: inline-block; width: 12px; height: 12px; vertical-align: -2px; margin-right: 3px; color: var(--scribe-ink-3); transition: transform .12s; }
    .${r} .scribe-am-ins-tbl tr.open .scribe-am-ins-tw { transform: rotate(90deg); }
    .${r} .scribe-am-ins-det td { white-space: normal; padding: 4px 5px 8px 20px; background: var(--scribe-canvas); }
    .${r} .scribe-am-ins-det .scribe-am-ins-kv { font-size: 11.5px; grid-template-columns: 100px minmax(0, 1fr); }
    .${r} .scribe-am-ins-sample { font-size: 18px; line-height: 1.25; color: var(--scribe-ink); margin: 2px 0 6px; overflow-wrap: anywhere; }
    .${r} .scribe-am-ins-more { font-size: 11.5px; color: var(--scribe-ink-3); padding: 4px 4px 0; }
    .${r} .scribe-am-ins-more-link { color: var(--scribe-accent); text-decoration: none; }
    .${r} .scribe-am-ins-more-link:hover { text-decoration: underline; }
    .${r} .scribe-am-ins-list { position: relative; }
    .${r} .scribe-am-ins-fewer { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--scribe-ink-3); padding: 5px 4px 4px; background: var(--scribe-surface); border-top: 1px solid var(--scribe-line); }
    .${r} .scribe-am-ins-cathd { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0 2px; }
    .${r} .scribe-am-ins-cathd .scribe-am-cat { padding: 0; }
    .${r} .scribe-am-ins-pick { display: inline-flex; align-items: center; gap: 5px; border: none; background: none; font: inherit; font-size: 11.5px; font-weight: 600; color: var(--scribe-ink-2); padding: 3px 7px 3px 5px; margin-right: -7px; border-radius: 5px; cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; }
    .${r} .scribe-am-ins-pick:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-am-ins-pick.on { color: var(--scribe-accent); background: var(--scribe-active); }
    .${r} .scribe-am-ins-pick-ic { width: 13px; height: 13px; display: inline-flex; flex: none; }
    .${r} .scribe-am-ins-xrow { cursor: pointer; border-radius: 4px; margin: 0 -4px; padding-left: 4px; padding-right: 4px; }
    .${r} .scribe-am-ins-xrow:hover { background: var(--scribe-hover); }
    .${r} .scribe-am-ins-xrow:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: -2px; }
    .${r} .scribe-am-ins-xrow .scribe-am-ins-v { display: flex; align-items: center; gap: 4px; }
    .${r} .scribe-am-ins-xrow .scribe-am-ins-tw { margin: 0; }
    .${r} .scribe-am-ins-xrow.open .scribe-am-ins-tw { transform: rotate(90deg); }
    .${r} .scribe-am-ins-xmp { background: var(--scribe-canvas); border-radius: 6px; padding: 3px 8px 6px; margin: 2px 0 4px; }
    .${r} .scribe-am-ins-xmp .scribe-am-ins-kv { font-size: 11.5px; grid-template-columns: 118px minmax(0, 1fr); }
    .${r} .scribe-am-ins-schema { font-size: 11px; font-weight: 600; color: var(--scribe-ink-3); padding: 7px 0 1px; }
    .${r} .scribe-am-ins-schema:first-child { padding-top: 2px; }
    .${r} .scribe-am-ins-schema span { font-weight: 400; overflow-wrap: anywhere; }
    .${r} .scribe-am-ins-tech .scribe-am-ins-k { overflow-wrap: anywhere; }
    .${r} .scribe-am-ins-lang { color: var(--scribe-ink-3); font-size: 11px; }
    .${r} .scribe-am-ins-nest { margin: 1px 0 3px 10px; padding-left: 8px; border-left: 2px solid var(--scribe-line); }
    .${r} .scribe-am-ins-nest .scribe-am-ins-kv { padding: 2px 0; }
    .${r} .scribe-am-ins-nest-hd { font-size: 11px; color: var(--scribe-ink-3); padding: 3px 0 0; }
    .${r} .scribe-am-ins-xmlline { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--scribe-ink-3); padding: 5px 0 0; }
    .${r} .scribe-am-ins-xml { font: 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--scribe-ink-2); background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 6px; padding: 7px 9px; margin: 5px 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .${r} .scribe-am-ins-xml .t, .${r} .scribe-am-ins-xml .a { color: var(--scribe-ink-3); }
    .${r} .scribe-am-ins-xml .n { color: var(--scribe-ink-2); }
    .${r} .scribe-am-ins-xml .v { color: var(--scribe-ink); }
    .${r}.scribe-phone .scribe-am-ins { padding: 2px 14px 14px; }
    .${r}.scribe-phone .scribe-am-ins-kv { font-size: 14px; grid-template-columns: 120px minmax(0, 1fr); padding: 5px 0; }
    .${r}.scribe-phone .scribe-am-ins-tbl { font-size: 13px; }
    .${r}.scribe-phone .scribe-am-ins-pick { font-size: 13px; padding: 6px 10px 6px 8px; margin-right: -10px; }
    .${r}.scribe-phone .scribe-am-ins-pick-ic { width: 15px; height: 15px; }
    .${r}.scribe-phone .scribe-am-ins-more, .${r}.scribe-phone .scribe-am-ins-fewer { font-size: 13px; }
    .${r}.scribe-phone .scribe-am-ins-xmp .scribe-am-ins-kv { font-size: 13px; grid-template-columns: 136px minmax(0, 1fr); }
    .${r}.scribe-phone .scribe-am-ins-schema, .${r}.scribe-phone .scribe-am-ins-lang, .${r}.scribe-phone .scribe-am-ins-nest-hd { font-size: 12px; }
    .${r}.scribe-phone .scribe-am-ins-xmlline { font-size: 13px; }
    .${r}.scribe-phone .scribe-am-ins-xml { font-size: 12px; }
    .${r}.scribe-phone .scribe-am-ins-cat { font-size: 13.5px; }
    .${r}.scribe-phone .scribe-am-ins-scope .scribe-am-check { font-size: 14px; }
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
    .${r} .scribe-as-receipt-gact {
      margin-left: auto; flex: none; border: none; background: none; cursor: pointer; width: 18px; height: 18px;
      border-radius: 4px; color: var(--scribe-ink-3); display: inline-flex; align-items: center; justify-content: center; padding: 0;
    }
    .${r} .scribe-as-receipt-gact:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
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
    .${r} .scribe-am-be-count { display: flex; align-items: baseline; gap: 8px; }
    .${r} .scribe-am-be-count b { font-size: 16px; font-weight: 650; color: var(--scribe-ink); font-variant-numeric: tabular-nums; }
    .${r} .scribe-am-be-count span { font-size: 12px; color: var(--scribe-ink-2); }
    .${r} .scribe-am-be-rules { display: grid; gap: 6px; }
    .${r} .scribe-am-be-rule { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .${r} .scribe-am-be-sel {
      display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border: 1px solid var(--scribe-line-strong);
      border-radius: 6px; background: var(--scribe-canvas); font: inherit; font-size: 12px; color: var(--scribe-ink);
      white-space: nowrap; cursor: pointer; flex: none; max-width: 100%;
    }
    .${r} .scribe-am-be-sel:hover { border-color: var(--scribe-ink-3); }
    .${r} .scribe-am-be-sel:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: 1px; }
    .${r} .scribe-am-be-sel.grow { flex: 1; min-width: 0; }
    .${r} .scribe-am-be-sel .tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-am-be-caret { color: var(--scribe-ink-3); font-size: 9px; flex: none; margin-left: auto; }
    .${r} .scribe-am-be-val {
      flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--scribe-line-strong); border-radius: 6px;
      background: var(--scribe-canvas); font: inherit; font-size: 12px; color: var(--scribe-ink); outline: none;
    }
    .${r} .scribe-am-be-val:focus { border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-am-be-rx { width: 22px; height: 22px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; color: var(--scribe-ink-3); cursor: pointer; flex: none; }
    .${r} .scribe-am-be-rx:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-am-be-rx svg { width: 14px; height: 14px; }
    .${r} .scribe-am-be-add { border: none; background: none; font: inherit; font-size: 12px; font-weight: 600; color: var(--scribe-accent); cursor: pointer; padding: 4px 6px; border-radius: 5px; justify-self: start; }
    .${r} .scribe-am-be-add:hover { background: var(--scribe-active); }
    .${r} .scribe-am-be-swatch {
      display: inline-block; width: 11px; height: 11px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .22);
      flex: none; margin-right: 7px; vertical-align: -1px;
    }
    .${r}[data-theme="dark"] .scribe-am-be-swatch { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); }
    .${r} .scribe-am-be-hex { font-variant-numeric: tabular-nums; letter-spacing: .02em; }
    .${r} .scribe-am-be-snips { display: grid; gap: 8px; }
    .${r} .scribe-am-be-snip { border: 1px solid var(--scribe-line); border-radius: 7px; overflow: hidden; cursor: pointer; background: var(--scribe-canvas); text-align: left; padding: 0; font: inherit; color: inherit; }
    .${r} .scribe-am-be-snip:hover { border-color: var(--scribe-line-strong); }
    .${r} .scribe-am-be-snip:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: -2px; }
    .${r} .scribe-am-be-simg { position: relative; height: 44px; background: #fff; overflow: hidden; }
    .${r} .scribe-am-be-sline { position: absolute; white-space: nowrap; line-height: 1; }
    .${r} .scribe-am-be-sline.hit { background: var(--scribe-active); outline: 1.5px solid var(--scribe-accent); outline-offset: 1px; border-radius: 2px; }
    .${r} .scribe-am-be-sbar { display: flex; align-items: center; gap: 7px; padding: 3px 8px; font-size: 11px; color: var(--scribe-ink-2); min-width: 0; }
    .${r} .scribe-am-be-sbar b { font-weight: 600; color: var(--scribe-ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .${r} .scribe-am-be-sbar .pg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .${r} .scribe-am-be-skeep { margin-left: auto; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: #2e7d4f; flex: none; }
    .${r}[data-theme="dark"] .scribe-am-be-skeep { color: #5abd85; }
    .${r} .scribe-am-be-sx { font-size: 11px; padding: 1px 8px; flex: none; }
    .${r} .scribe-am-be-snip.excl .scribe-am-be-skeep { color: var(--scribe-ink-3); }
    .${r} .scribe-am-be-snip.excl .scribe-am-be-simg { opacity: .45; }
    .${r} .scribe-am-be-snip.excl .scribe-am-be-simg::after { content: ''; position: absolute; left: 8px; right: 8px; top: 50%; border-top: 2px solid var(--scribe-ink-3); }
    .${r} .scribe-am-be-seg { display: flex; background: var(--scribe-sunken); border-radius: 8px; padding: 3px; gap: 2px; }
    .${r} .scribe-am-be-seg button { flex: 1; height: 26px; border: none; border-radius: 6px; background: none; font: inherit; font-size: 12.5px; color: var(--scribe-ink-2); cursor: pointer; }
    .${r} .scribe-am-be-seg button.on { background: var(--scribe-surface); box-shadow: 0 1px 2px rgba(20, 30, 60, .10); color: var(--scribe-ink); font-weight: 600; }
    .${r} .scribe-am-be-seg button:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: -2px; }
    .${r} .scribe-am-run.danger { border-color: var(--scribe-danger); color: var(--scribe-danger); }
    .${r} .scribe-am-run.danger:hover { background: var(--scribe-danger-soft); }
    .${r} .scribe-am-run:disabled { border-color: var(--scribe-line-strong); color: var(--scribe-ink-3); cursor: default; background: none; }
    .${r} .scribe-am-quiet:disabled { color: var(--scribe-ink-3); cursor: default; background: none; }
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
  // Without the automation content the panel hosts the mode workspaces only: no catalog, composer or tray.
  // Nothing is left to go back to, so closing a workspace closes the panel.
  const automations = hooks.automations !== false;

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
  const hdGrow = document.createElement('span');
  hdGrow.style.flex = '1';
  const plusBtn = document.createElement('span');
  plusBtn.className = 'scribe-am-ib';
  plusBtn.role = 'button';
  plusBtn.tabIndex = 0;
  plusBtn.title = 'New chat';
  plusBtn.innerHTML = PLUS_SVG;
  plusBtn.style.display = 'none';
  const closeBtn = document.createElement('span');
  closeBtn.className = 'scribe-am-ib';
  closeBtn.role = 'button';
  closeBtn.tabIndex = 0;
  closeBtn.title = 'Close panel';
  closeBtn.innerHTML = '×';
  hd.append(backBtn, hdIcon, hdTitle, hdGrow, plusBtn, closeBtn);

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

  const tray = document.createElement('div');
  tray.className = 'scribe-am-tray';
  tray.style.display = 'none';

  const catalog = document.createElement('div');
  catalog.className = 'scribe-am-catalog';

  const chatsElem = document.createElement('div');
  chatsElem.className = 'scribe-am-catalog';
  chatsElem.style.display = 'none';

  const thread = document.createElement('div');
  thread.className = 'scribe-am-thread';
  thread.style.display = 'none';

  // The assistant conversation view; the active document's rows are swapped in when it opens.
  const asstThread = document.createElement('div');
  asstThread.className = 'scribe-am-thread';
  asstThread.style.display = 'none';

  // The tables workspace, populated by the extract-tables module while its mode is active.
  const tablesElem = document.createElement('div');
  tablesElem.className = 'scribe-am-tables';
  tablesElem.style.display = 'none';

  // The Inspect Document workspace, populated by the inspect-document module while its mode is active.
  const inspectElem = document.createElement('div');
  inspectElem.className = 'scribe-am-inswrap';
  inspectElem.style.display = 'none';

  // The Redactions workspace, populated by the redact-terms module when its catalog row opens it.
  const redactElem = document.createElement('div');
  redactElem.className = 'scribe-am-rdwrap';
  redactElem.style.display = 'none';

  // The Bulk Edit workspace, populated by the bulk-edit module when its catalog row opens it.
  const bulkElem = document.createElement('div');
  bulkElem.className = 'scribe-am-rdwrap';
  bulkElem.style.display = 'none';

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

  panelElem.append(hd, strip, tray, catalog, chatsElem, thread, asstThread, tablesElem, inspectElem, redactElem, bulkElem, composer);

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
    // The workspace's canvas marks and pick mode belong to its view, so leaving the view ends them.
    if (view === 'bulk' && next !== 'bulk') closeBulkWorkspace();
    view = next;
    closeModelMenu(false);
    const rest = next === 'rest';
    // No catalog: "rest" is the closed panel.
    if (rest && !automations) { if (openState) close(); return; }
    const asst = next === 'assistant';
    const chatsList = next === 'chats';
    catalog.style.display = rest ? '' : 'none';
    chatsElem.style.display = chatsList ? '' : 'none';
    composer.style.display = rest || asst ? '' : 'none';
    thread.style.display = next === 'thread' ? '' : 'none';
    asstThread.style.display = asst ? '' : 'none';
    tablesElem.style.display = next === 'tables' ? '' : 'none';
    inspectElem.style.display = next === 'inspect' ? '' : 'none';
    redactElem.style.display = next === 'redact' ? '' : 'none';
    bulkElem.style.display = next === 'bulk' ? '' : 'none';
    backBtn.style.display = rest || !automations ? 'none' : '';
    hdIcon.style.display = rest || !automations ? '' : 'none';
    if (!automations) hdIcon.innerHTML = next === 'inspect' ? INSPECT_SVG : (AUTOMATIONS.find((a) => a.id === 'extract-tables')?.svg || AUTOMATE_SVG);
    plusBtn.style.display = asst ? '' : 'none';
    const st = app.doc ? docStates.get(app.doc) : null;
    hdTitle.textContent = rest ? 'Automate'
      : chatsList ? 'Chats'
        : next === 'tables' ? 'Extract tables'
          : next === 'inspect' ? 'Inspect Document'
            : next === 'redact' ? 'Redactions'
              : next === 'bulk' ? 'Bulk Edit'
                : asst ? (st?.activeRec?.title ?? 'Assistant')
                  : (activeRun ? activeRun.title : 'Automate');
    if (asst && st) {
      const live = st.activeRec ? st.live.get(st.activeRec) : st.draft;
      if (live) live.unseen = false;
    }
    if (!automations) return;
    syncStrip();
    paintTray();
    if (rest) paintCatalog();
    if (chatsList) paintChatsList();
  };

  function stripTarget() {
    const st = app.doc ? docStates.get(app.doc) : null;
    if (!st) return null;
    let unseen = null;
    for (const live of [...st.live.values(), ...(st.draft ? [st.draft] : [])]) {
      if (live.running) return live;
      if (live.unseen && !unseen) unseen = live;
    }
    return unseen;
  }

  function syncStrip() {
    const auto = view === 'rest' && activeRun
      && (activeRun.status === 'running' || (activeRun.status !== 'form' && !activeRun.seen));
    const st = app.doc ? docStates.get(app.doc) : null;
    const att = stripTarget();
    const viewingAtt = view === 'assistant' && !!st && (st.activeRec ? st.live.get(st.activeRec) : st.draft) === att;
    const asst = !auto && !!att && !viewingAtt;
    stripMode = auto ? 'auto' : 'asst';
    strip.style.display = auto || asst ? 'flex' : 'none';
    stripStop.style.display = asst && att.running ? '' : 'none';
    if (auto) stripTx.textContent = `${activeRun.title} — ${activeRun.status === 'running' ? 'running…' : 'done'}`;
    else if (asst) stripTx.textContent = `${att.rec?.title ?? 'Assistant'} — ${att.running ? 'working…' : 'done'}`;
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
    const sideGroup = SIDEBAR_GROUPS[app._activeSidebar];
    if (sideGroup) {
      const entries = sideGroup.ids.map((id) => AUTOMATIONS.find((a) => a.id === id)).filter(Boolean);
      addGroup(sideGroup.label, entries);
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
    if (!why) row.addEventListener('click', () => (entry.openInstead ? entry.openInstead(host) : launch(entry)));
    return row;
  }

  /**
   * Open a tool's thread, showing its form and then its run.
   * @param {Object} entry
   * @param {Object} [prefill]
   */
  async function launch(entry, prefill) {
    // Captured now rather than at completion, because the user may navigate to another chat while the run works.
    const filingRec = view === 'assistant' && app.doc ? stateFor(app.doc).activeRec : null;
    activeRun = {
      entry, title: entry.title, status: 'form', seen: true, doc: app.doc, filingRec,
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
      entry,
      title: entry.title,
      status: 'running',
      seen: view === 'thread',
      doc: activeRun?.doc ?? app.doc,
      filingRec: activeRun?.filingRec ?? null,
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
      const runDoc = run.doc;
      let chatRec = null;
      let chatEntry = null;
      let chatCard = null;
      if (runDoc) {
        // The captured chat may have been evicted by the cap since launch, so fall back to a new one.
        chatRec = run.filingRec && runDoc.assistantChats.chats.includes(run.filingRec) ? run.filingRec : newChatRecord(runDoc, entry.title);
        chatEntry = {
          kind: 'run',
          toolId: entry.id,
          title: entry.title,
          params: paramsLine(module, entry, params),
          time: new Date().toISOString(),
          state: 'done',
          rows: (outcome.rows || []).map((r) => ({ kind: r.kind || 'info', text: r.text })),
          relayed: false,
        };
        chatRec.log.push(chatEntry);
        const liveChat = docStates.get(runDoc)?.live.get(chatRec);
        if (liveChat) {
          liveChat.prose = null;
          liveChat.rail = null;
          chatCard = buildRunCard(chatEntry, outcome.review ? { label: outcome.review.label, onClick: outcome.review.onClick } : null);
          liveChat.listElem.appendChild(chatCard);
          scrollAssistant();
        }
        touchChat(runDoc, chatRec);
      }
      /** @type {Array<HTMLElement>} Everything the done state adds, so an undo can replace it wholesale. */
      const doneEls = [];
      const append = (el) => { doneEls.push(el); thread.appendChild(el); };
      for (const rowSpec of outcome.rows || []) append(buildResultRow(rowSpec));
      if (outcome.offer) {
        const block = document.createElement('div');
        block.className = 'scribe-am-offer';
        const orow = document.createElement('div');
        orow.className = 'scribe-am-offer-row';
        const oic = document.createElement('span');
        oic.className = 'scribe-am-note-ic';
        oic.innerHTML = INFO_SVG;
        const otx = document.createElement('span');
        otx.textContent = outcome.offer.text;
        orow.append(oic, otx);
        const act = document.createElement('button');
        act.type = 'button';
        act.className = 'scribe-am-offer-act';
        act.textContent = outcome.offer.actionLabel;
        act.addEventListener('click', () => startRun(entry, module, outcome.offer.params));
        block.append(orow, act);
        append(block);
      }
      if (outcome.review || outcome.undo) {
        const foot = document.createElement('div');
        foot.className = 'scribe-am-foot';
        const grow = document.createElement('span');
        grow.className = 'scribe-am-foot-grow';
        foot.appendChild(grow);
        if (outcome.undo) {
          const undoBtn = document.createElement('button');
          undoBtn.type = 'button';
          undoBtn.className = 'scribe-am-quiet';
          undoBtn.textContent = outcome.undo.label;
          undoBtn.addEventListener('click', () => {
            outcome.undo.onClick();
            for (const el of doneEls) el.remove();
            statusState.textContent = 'Undone';
            statusState.classList.remove('done');
            thread.appendChild(buildResultRow({ kind: 'info', text: outcome.undo.undoneText }));
            if (chatEntry) {
              chatEntry.state = 'undone';
              chatEntry.rows = [{ kind: 'info', text: outcome.undo.undoneText }];
              if (chatCard) {
                const rebuilt = buildRunCard(chatEntry);
                chatCard.replaceWith(rebuilt);
                chatCard = rebuilt;
              }
              touchChat(runDoc, chatRec);
            }
          });
          foot.appendChild(undoBtn);
        }
        if (outcome.review) {
          const cta = document.createElement('button');
          cta.type = 'button';
          cta.className = 'scribe-am-run';
          cta.textContent = outcome.review.label;
          cta.addEventListener('click', () => outcome.review.onClick());
          foot.appendChild(cta);
        }
        append(foot);
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
    ic.innerHTML = spec.kind === 'ok' ? CHECK_SVG : (spec.kind === 'flag' ? FLAG_SVG : (spec.kind === 'file' ? FILE_SVG : INFO_SVG));
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
   * Live view state per document.
   * The chat records themselves live on `doc.assistantChats.chats`, which is what the session block serializes, so anything kept here is lost on reload.
   * A draft is a chat opened from the "+" button that gets no record until its first content arrives, and `activeRec` stays null while one is open.
   * @type {WeakMap<Object, {live: Map<AssistantChatRecord, Object>, activeRec: ?AssistantChatRecord, draft: ?Object}>}
   */
  const docStates = new WeakMap();

  /** Aborts for every in-flight turn, so destroy can stop streams whose documents it can no longer reach. */
  const activeAborts = new Set();

  const stateFor = (doc) => {
    let st = docStates.get(doc);
    if (!st) {
      st = { live: new Map(), activeRec: null, draft: null };
      docStates.set(doc, st);
    }
    return st;
  };

  const CHAT_CAP = 50;

  const newChatRecord = (doc, title) => {
    const now = new Date().toISOString();
    const rec = {
      id: `c${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      log: [],
    };
    const chats = doc.assistantChats.chats;
    const st = stateFor(doc);
    chats.push(rec);
    while (chats.length > CHAT_CAP) {
      let oldest = -1;
      for (let i = 0; i < chats.length - 1; i++) {
        // Evicting a chat mid-turn would leave the turn writing into a record the store no longer holds.
        if (st.live.get(chats[i])?.running) continue;
        if (oldest === -1 || chats[i].updatedAt < chats[oldest].updatedAt) oldest = i;
      }
      if (oldest === -1) break;
      const [gone] = chats.splice(oldest, 1);
      st.live.delete(gone);
    }
    return rec;
  };

  const touchChat = (doc, rec) => {
    rec.updatedAt = new Date().toISOString();
    app.onAssistantHistoryEdited?.(doc);
    paintTray();
  };

  const mostRecentRec = (doc) => {
    let latest = null;
    for (const rec of doc.assistantChats.chats) {
      if (!latest || rec.updatedAt > latest.updatedAt) latest = rec;
    }
    return latest;
  };

  const newDraft = () => {
    const live = {
      rec: null,
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
    live.listElem.style.display = 'contents';
    return live;
  };

  const removedTag = () => {
    const tag = document.createElement('span');
    tag.className = 'scribe-as-removed-tag';
    tag.textContent = 'Removed';
    return tag;
  };

  /**
   * A tool run's card in the chat.
   * A restored card gets no `review` action, since that closure died with the session that ran the tool.
   * @param {AssistantChatLogEntry} entry
   * @param {?{label: string, onClick: () => void}} [review]
   */
  function buildRunCard(entry, review) {
    const card = document.createElement('div');
    card.className = 'scribe-as-run';
    const hdRow = document.createElement('div');
    hdRow.className = 'scribe-as-run-hd';
    const ic = document.createElement('span');
    ic.className = 'scribe-as-run-ic';
    ic.innerHTML = AUTOMATIONS.find((a) => a.id === entry.toolId)?.svg || AUTOMATE_SVG;
    const tt = document.createElement('span');
    tt.className = 'scribe-as-run-tt';
    tt.textContent = entry.title;
    const stTx = document.createElement('span');
    stTx.className = `scribe-as-run-st${entry.state === 'undone' ? ' undone' : ''}`;
    stTx.textContent = entry.state === 'undone' ? 'Undone' : `Done ${formatTimestamp(entry.time)}`;
    hdRow.append(ic, tt, stTx);
    const params = document.createElement('div');
    params.className = 'scribe-as-run-params';
    params.textContent = entry.params;
    params.title = entry.params;
    card.append(hdRow, params);
    for (const rowSpec of entry.rows || []) card.appendChild(buildResultRow(rowSpec));
    if (review && entry.state !== 'undone') {
      const foot = document.createElement('div');
      foot.className = 'scribe-as-run-foot';
      const cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'scribe-am-run';
      cta.textContent = review.label;
      cta.addEventListener('click', review.onClick);
      foot.appendChild(cta);
      card.appendChild(foot);
    }
    return card;
  }

  /**
   * The live view for a chat record, replaying its stored log into rows on first touch.
   * Replayed receipt rows navigate but offer no removal, since those actions closed over annotation objects from the session that recorded them.
   */
  const liveFor = (doc, rec) => {
    const st = stateFor(doc);
    let live = st.live.get(rec);
    if (live) return live;
    live = newDraft();
    live.rec = rec;
    if (rec.log.length) {
      /** @type {?HTMLElement} */
      let rail = null;
      for (const entry of rec.log) {
        if (entry.kind === 'receipt' || entry.kind === 'batch') {
          if (!rail) {
            rail = document.createElement('div');
            rail.className = 'scribe-as-rail';
            live.listElem.appendChild(rail);
          }
        } else {
          rail = null;
        }
        if (entry.kind === 'user') {
          const row = document.createElement('div');
          row.className = 'scribe-as-user';
          const tx = document.createElement('span');
          tx.className = 'scribe-as-user-tx';
          tx.textContent = entry.text;
          row.appendChild(tx);
          live.listElem.appendChild(row);
        } else if (entry.kind === 'prose') {
          const p = document.createElement('div');
          p.className = 'scribe-as-prose';
          renderProse(p, entry.md || '');
          live.listElem.appendChild(p);
        } else if (entry.kind === 'mark' || entry.kind === 'flag') {
          const row = document.createElement('div');
          row.className = entry.kind === 'mark' ? 'scribe-as-mark' : 'scribe-as-flag';
          if (entry.kind === 'flag') {
            const ic = document.createElement('span');
            ic.className = 'scribe-as-receipt-ic';
            ic.innerHTML = FLAG_SVG;
            const tx = document.createElement('span');
            tx.className = 'scribe-as-receipt-tx';
            tx.textContent = entry.text;
            row.append(ic, tx);
          } else {
            row.textContent = entry.text;
          }
          live.listElem.appendChild(row);
        } else if (entry.kind === 'receipt') {
          rail.appendChild(receiptRow(entry, entry.tier ?? 0, entry.removed));
        } else if (entry.kind === 'batch') {
          const row = document.createElement('div');
          row.className = `scribe-as-receipt act${entry.removed ? ' removed' : ''}`;
          row.tabIndex = 0;
          const ic = document.createElement('span');
          ic.className = 'scribe-as-receipt-ic';
          ic.innerHTML = CHECK_SVG;
          const tx = document.createElement('span');
          tx.className = 'scribe-as-receipt-tx';
          tx.textContent = entry.label;
          tx.title = entry.label;
          row.append(ic, tx);
          rail.appendChild(row);
          if (entry.removed) {
            row.appendChild(removedTag());
          } else {
            const chev = document.createElement('span');
            chev.className = 'scribe-as-chev';
            chev.innerHTML = CHEVRON_SVG;
            chev.style.marginLeft = 'auto';
            row.appendChild(chev);
            const exp = document.createElement('div');
            exp.className = 'scribe-as-exp';
            exp.style.display = 'none';
            for (const item of entry.items || []) {
              const itemRow = document.createElement('div');
              itemRow.className = `scribe-as-item${item.removed ? ' removed' : ''}`;
              itemRow.tabIndex = 0;
              const pg = document.createElement('span');
              pg.className = 'scribe-as-item-pg';
              pg.textContent = item.page != null ? String(item.page + 1) : '';
              const itx = document.createElement('span');
              itx.className = 'scribe-as-item-tx';
              itx.textContent = item.label;
              itx.title = item.label;
              itemRow.append(pg, itx);
              if (item.removed) itemRow.appendChild(removedTag());
              if (item.page != null) {
                itemRow.addEventListener('click', () => navigateToReceipt(app.scribe, item));
                itemRow.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter') navigateToReceipt(app.scribe, item);
                });
              }
              exp.appendChild(itemRow);
            }
            rail.appendChild(exp);
            const toggleExp = () => {
              const open = exp.style.display === 'none';
              exp.style.display = open ? '' : 'none';
              row.classList.toggle('open', open);
            };
            row.addEventListener('click', toggleExp);
            row.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleExp();
              }
            });
          }
        } else if (entry.kind === 'run') {
          live.listElem.appendChild(buildRunCard(entry));
        }
      }
      const mark = document.createElement('div');
      mark.className = 'scribe-as-mark';
      mark.textContent = `Restored · ${formatTimestamp(rec.updatedAt)}`;
      live.listElem.appendChild(mark);
    }
    st.live.set(rec, live);
    return live;
  };

  const scrollAssistant = () => {
    if (view === 'assistant') asstThread.scrollTop = asstThread.scrollHeight;
  };

  function openChat(doc, live) {
    const st = stateFor(doc);
    st.activeRec = live.rec;
    st.draft = live.rec ? st.draft : live;
    if (asstThread.firstChild !== live.listElem) {
      asstThread.textContent = '';
      asstThread.appendChild(live.listElem);
    }
    setView('assistant');
    asstThread.scrollTop = asstThread.scrollHeight;
  }

  const chatSnippet = (rec) => {
    for (let i = rec.log.length - 1; i >= 0; i--) {
      const entry = rec.log[i];
      if (entry.kind === 'prose' && entry.md) return entry.md.split('\n', 1)[0];
      if (entry.kind === 'user') return entry.text || '';
      if (entry.kind === 'run') return entry.rows?.[0]?.text || entry.title || '';
      if (entry.kind === 'batch' || entry.kind === 'receipt') return entry.label || '';
      if (entry.kind === 'flag') return entry.text || '';
    }
    return '';
  };

  const chatRow = (doc, rec) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'scribe-am-crow';
    const ic = document.createElement('span');
    ic.className = 'scribe-am-crow-ic';
    ic.innerHTML = CHAT_SVG;
    const col = document.createElement('span');
    col.className = 'scribe-am-crow-col';
    const title = document.createElement('span');
    title.className = 'scribe-am-crow-title';
    title.textContent = rec.title;
    const snip = document.createElement('span');
    snip.className = 'scribe-am-crow-snip';
    snip.textContent = chatSnippet(rec);
    col.append(title, snip);
    const time = document.createElement('span');
    time.className = 'scribe-am-crow-time';
    time.textContent = formatTimestamp(rec.updatedAt);
    row.append(ic, col, time);
    // The active-doc-change event can fire before `app.doc` switches, so a painted row may hold the outgoing document's record.
    // Re-resolving by id at click time keeps the row bound to whatever document is actually open.
    row.addEventListener('click', () => {
      const cur = app.doc;
      if (!cur) return;
      const target = cur.assistantChats.chats.find((r) => r.id === rec.id);
      if (target) openChat(cur, liveFor(cur, target));
      else paintTray();
    });
    return row;
  };

  const TRAY_CAP = 2;

  function paintTray() {
    const doc = app.doc;
    const chats = doc ? doc.assistantChats.chats : [];
    const show = view === 'rest' && chats.length > 0;
    tray.style.display = show ? '' : 'none';
    if (!show) return;
    tray.textContent = '';
    const sorted = [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    for (const rec of sorted.slice(0, TRAY_CAP)) tray.appendChild(chatRow(doc, rec));
    if (sorted.length > TRAY_CAP) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'scribe-am-tray-all';
      all.append(document.createTextNode(`All chats (${sorted.length})`));
      const chev = document.createElement('span');
      chev.innerHTML = CHEVRON_SVG;
      all.appendChild(chev.firstElementChild);
      all.addEventListener('click', () => setView('chats'));
      tray.appendChild(all);
    }
  }

  function paintChatsList() {
    chatsElem.textContent = '';
    const doc = app.doc;
    if (!doc) return;
    const sorted = [...doc.assistantChats.chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    for (const rec of sorted) chatsElem.appendChild(chatRow(doc, rec));
  }

  const fitComposer = () => {
    cinput.style.height = 'auto';
    cinput.style.height = `${cinput.scrollHeight}px`;
  };

  /**
   * The document's in-flight turn, if any.
   * At most one turn runs per document, so the first match is the only one.
   */
  const runningLive = (doc) => {
    const st = doc ? docStates.get(doc) : null;
    if (!st) return null;
    for (const live of [...st.live.values(), ...(st.draft ? [st.draft] : [])]) {
      if (live.running) return live;
    }
    return null;
  };

  const syncComposer = () => {
    const running = !!runningLive(app.doc);
    csend.innerHTML = running ? STOP_SVG : SEND_SVG;
    csend.title = running ? 'Stop' : 'Send';
    csend.classList.toggle('stop', running);
    csend.classList.toggle('ready', !running && !!cinput.value.trim());
  };

  const stopTurn = () => {
    runningLive(app.doc)?.abort?.abort();
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
    const doc = app.doc;
    const st = doc ? docStates.get(doc) : null;
    const rec = st && view === 'assistant' ? st.activeRec : (doc ? mostRecentRec(doc) : null);
    const live = rec && st ? st.live.get(rec) : (st?.draft ?? null);
    if (live && live.rec && live.rec.messages.length) {
      const last = live.listElem.lastElementChild;
      const lastLog = live.rec.log[live.rec.log.length - 1];
      if (last && last.classList.contains('scribe-as-mark') && lastLog?.kind === 'mark') {
        last.textContent = option.label;
        lastLog.text = option.label;
      } else {
        const mark = document.createElement('div');
        mark.className = 'scribe-as-mark';
        mark.textContent = option.label;
        live.listElem.appendChild(mark);
        live.rec.log.push({ kind: 'mark', text: option.label });
      }
      live.prose = null;
      live.rail = null;
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
   * A replayed row passes `removed`, since its receipt carries no live removal closure.
   * @param {import('../assistant/verbs.js').VerbReceipt} receipt
   * @param {number} tier
   * @param {boolean} [removed]
   */
  function receiptRow(receipt, tier, removed) {
    const row = document.createElement('div');
    row.className = `scribe-as-receipt${tier >= 1 ? ' act' : ''}${removed ? ' removed' : ''}`;
    const ic = document.createElement('span');
    ic.className = 'scribe-as-receipt-ic';
    ic.innerHTML = tier >= 1 ? CHECK_SVG : READ_SVG;
    const tx = document.createElement('span');
    tx.className = 'scribe-as-receipt-tx';
    tx.textContent = receipt.label;
    tx.title = receipt.label;
    row.append(ic, tx);
    if (removed) row.appendChild(removedTag());
    if (receipt.page != null) row.addEventListener('click', () => navigateToReceipt(app.scribe, receipt));
    if (receipt.remove) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'scribe-as-receipt-gact';
      act.innerHTML = X_SVG;
      act.title = receipt.remove.label;
      act.setAttribute('aria-label', receipt.remove.label);
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

  /**
   * Run one turn in a chat, which must already have a record.
   * `ask` is the text sent to the model, which may carry a run recap that the visible user row does not.
   */
  async function runTurn(doc, c, adapter, ask) {
    const rec = c.rec;
    c.running = true;
    c.abort = new AbortController();
    c.adapter = adapter;
    activeAborts.add(c.abort);
    syncComposer();
    syncStrip();
    let ghost = null;
    /** @type {?string} The loop's terminal reason. Stays null when the turn throws. */
    let endReason = null;
    /** True once the turn rendered anything the user can read. */
    let sawContent = false;

    // Turn-liveness row, hidden while a verb ghost is already showing the turn is alive.
    const wait = document.createElement('div');
    wait.className = 'scribe-as-ghost';
    const waitIc = document.createElement('span');
    waitIc.className = 'scribe-as-receipt-ic';
    waitIc.innerHTML = SPIN_SVG;
    const waitTx = document.createElement('span');
    waitTx.className = 'scribe-as-receipt-tx';
    waitTx.textContent = 'Working…';
    wait.append(waitIc, waitTx);
    c.listElem.appendChild(wait);

    const appendFlag = (text) => {
      const flag = document.createElement('div');
      flag.className = 'scribe-as-flag';
      const ic = document.createElement('span');
      ic.className = 'scribe-as-receipt-ic';
      ic.innerHTML = FLAG_SVG;
      const tx = document.createElement('span');
      tx.className = 'scribe-as-receipt-tx';
      tx.textContent = text;
      flag.append(ic, tx);
      c.listElem.appendChild(flag);
      rec.log.push({ kind: 'flag', text });
      scrollAssistant();
    };

    const appendMark = (text) => {
      const mark = document.createElement('div');
      mark.className = 'scribe-as-mark';
      mark.textContent = text;
      c.listElem.appendChild(mark);
      rec.log.push({ kind: 'mark', text });
      scrollAssistant();
    };

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

    const appendToBatch = (receipt, alreadyRemoved) => {
      const b = actRun.batch;
      b.units += receipt.batch.units ?? 1;
      b.pages.push(receipt.page);
      if (receipt.batch.removeAllLabel) b.removeAllLabel = receipt.batch.removeAllLabel;
      const lo = Math.min(...b.pages) + 1;
      const hi = Math.max(...b.pages) + 1;
      b.tx.textContent = receipt.batch.label(b.units, lo === hi ? `page ${lo}` : `pages ${lo}–${hi}`);
      b.tx.title = b.tx.textContent;
      b.logEntry.label = b.tx.textContent;

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
      const itemLog = {
        page: receipt.page,
        label: tx.textContent,
        bbox: receipt.bbox,
        wordIds: receipt.wordIds,
        ...(alreadyRemoved ? { removed: true } : {}),
      };
      b.logEntry.items.push(itemLog);
      const entry = { receipt, item, removed: false };
      const markRemoved = () => {
        entry.removed = true;
        itemLog.removed = true;
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
        act.className = 'scribe-as-receipt-gact';
        act.innerHTML = X_SVG;
        act.title = receipt.remove.label;
        act.setAttribute('aria-label', receipt.remove.label);
        act.addEventListener('click', (e) => {
          e.stopPropagation();
          receipt.remove.run();
          act.replaceWith(removedTag());
          markRemoved();
          touchChat(doc, rec);
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
            en.item.querySelector('.scribe-as-receipt-gact')?.replaceWith(removedTag());
          }
          b.row.classList.add('removed');
          b.dim.textContent = '';
          b.chev.remove();
          act.replaceWith(removedTag());
          b.exp.style.display = 'none';
          b.logEntry.removed = true;
          for (const it of b.logEntry.items) it.removed = true;
          touchChat(doc, rec);
          if (actRun?.batch === b) actRun = null;
        });
        b.row.insertBefore(act, b.chev);
        b.chev.style.marginLeft = '';
        b.actBtn = act;
      }
    };

    const convertToBatch = () => {
      const b = {
        units: 0,
        pages: [],
        removed: 0,
        entries: [],
        removeAllLabel: null,
        actBtn: null,
        logEntry: { kind: 'batch', label: '', items: [] },
      };
      // The rows just folded into the batch, so their individual log entries must fold too or a restore shows both.
      for (const p of actRun.pending) {
        const i = rec.log.indexOf(p.logEntry);
        if (i !== -1) rec.log.splice(i, 1);
      }
      rec.log.push(b.logEntry);
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
      rec.messages = await runAssistantTurn({
        host,
        adapter,
        messages: rec.messages,
        ask,
        signal: c.abort.signal,
        trace: c.trace ?? undefined,
        onText: (delta) => {
          sawContent = true;
          if (!c.prose) {
            foldRunWindow();
            const p = document.createElement('div');
            p.className = 'scribe-as-prose';
            c.listElem.appendChild(p);
            c.prose = p;
            c.proseSrc = '';
            c.rail = null;
            c.proseLog = { kind: 'prose', md: '' };
            rec.log.push(c.proseLog);
          }
          c.proseSrc += delta;
          c.proseLog.md = c.proseSrc;
          renderProse(c.prose, c.proseSrc);
          c.listElem.appendChild(wait);
          scrollAssistant();
        },
        onVerbStart: ({ call, caption }) => {
          wait.style.display = 'none';
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
          wait.style.display = '';
          c.listElem.appendChild(wait);
          if (!res.receipt || !c.rail) return;
          sawContent = true;
          const receipt = res.receipt;
          const tier = VERBS.find((v) => v.name === call.name)?.tier ?? 0;
          // Wrapping the removal keeps the log in step, so a restored chat shows the passage as removed.
          const logReceipt = () => {
            const entry = {
              kind: 'receipt',
              label: receipt.label,
              page: receipt.page,
              bbox: receipt.bbox,
              wordIds: receipt.wordIds,
              quote: receipt.quote,
              tier,
            };
            rec.log.push(entry);
            const shown = receipt.remove ? {
              ...receipt,
              remove: {
                label: receipt.remove.label,
                run: () => {
                  receipt.remove.run();
                  entry.removed = true;
                  touchChat(doc, rec);
                },
              },
            } : receipt;
            return { entry, row: receiptRow(shown, tier) };
          };
          const key = receipt.batch && receipt.page != null ? `${call.name}:${receipt.batch.key}` : null;
          if (actRun && actRun.key !== key) foldRunWindow();
          if (!key) {
            c.rail.appendChild(logReceipt().row);
          } else {
            if (!actRun) {
              actRun = {
                key, verbName: call.name, pending: [], batch: null,
              };
            }
            if (actRun.batch) {
              appendToBatch(receipt, false);
            } else {
              const logged = logReceipt();
              c.rail.appendChild(logged.row);
              actRun.pending.push({ receipt, row: logged.row, logEntry: logged.entry });
              if (actRun.pending.length >= 3) convertToBatch();
            }
          }
          scrollAssistant();
        },
        onTurnEnd: ({ reason }) => { endReason = reason; },
      });
    } catch (err) {
      // Adopting the settled thread keeps the model's memory matching the rows still on screen.
      const thrown = /** @type {{thread?: Array<import('../assistant/assistant.js').AssistantMessage>}} */ (err);
      if (thrown.thread) rec.messages = thrown.thread;
      // A user-initiated Stop aborts the stream mid-read; everything already landed stays, and that is not a failure.
      if (c.abort?.signal.aborted) {
        endReason = 'aborted';
      } else {
        console.error('The assistant turn failed:', err);
        appendFlag('Something went wrong — see the console for details.');
      }
    } finally {
      if (ghost) ghost.remove();
      wait.remove();
      foldRunWindow();
      if (endReason === 'max-tokens') appendFlag('The reply hit its length limit before finishing. Say “continue” to pick up where it left off.');
      else if (endReason === 'refusal') appendFlag('The model declined this request.');
      else if (endReason === 'max-steps') appendFlag('Stopped at the step limit for a single ask. Send a message to continue.');
      else if (endReason === 'aborted') appendMark('Stopped');
      else if (endReason === 'completed' && !sawContent) appendMark('The assistant ended its turn without replying.');
      c.running = false;
      activeAborts.delete(c.abort);
      c.abort = null;
      c.prose = null;
      c.rail = null;
      c.proseLog = null;
      c.unseen = !(view === 'assistant' && stateFor(doc).activeRec === rec);
      touchChat(doc, rec);
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
    if (runningLive(doc)) return;
    const adapter = await app.getAssistantAdapter();
    if (!adapter) {
      showKeyCard();
      return;
    }
    const st = stateFor(doc);
    let live;
    if (view === 'assistant') {
      live = st.activeRec ? liveFor(doc, st.activeRec) : (st.draft ?? newDraft());
    } else {
      const rec = mostRecentRec(doc);
      live = rec ? liveFor(doc, rec) : newDraft();
    }
    if (!live.rec) {
      live.rec = newChatRecord(doc, text.length > 60 ? `${text.slice(0, 57)}…` : text);
      st.live.set(live.rec, live);
      if (st.draft === live) st.draft = null;
    }
    cinput.value = '';
    fitComposer();
    openChat(doc, live);
    const row = document.createElement('div');
    row.className = 'scribe-as-user';
    const tx = document.createElement('span');
    tx.className = 'scribe-as-user-tx';
    tx.textContent = text;
    row.appendChild(tx);
    live.listElem.appendChild(row);
    live.rec.log.push({ kind: 'user', text });
    live.prose = null;
    live.rail = null;
    scrollAssistant();
    // A catalog run never reaches the model on its own, so an unrelayed one rides ahead of the ask as a recap.
    const recaps = [];
    for (const entry of live.rec.log) {
      if (entry.kind !== 'run' || entry.relayed || entry.state !== 'done') continue;
      entry.relayed = true;
      recaps.push(`[Tool run] ${entry.title} — ${entry.params}. Outcome: ${(entry.rows || []).map((r) => r.text).join('; ')}.`);
    }
    runTurn(doc, live, adapter, recaps.length ? `${recaps.join('\n')}\n\n${text}` : text);
  }

  /** @type {?{refresh: () => void}} */
  let wsHandle = null;
  let wsPriorView = 'rest';

  async function openTablesWorkspace() {
    open();
    if (view !== 'tables') wsPriorView = view;
    setView('tables');
    if (wsHandle) { wsHandle.refresh(); return; }
    const module = await AUTOMATIONS.find((a) => a.id === 'extract-tables').load();
    // The mode may have exited (or the view moved on) during the await.
    if (view !== 'tables' || wsHandle) return;
    tablesElem.textContent = '';
    wsHandle = module.buildTablesWorkspace(host, tablesElem);
    app.scribe.onLayoutTablesEdited = () => wsHandle?.refresh();
  }

  function closeTablesWorkspace() {
    if (!wsHandle && view !== 'tables') return;
    app.scribe.onLayoutTablesEdited = null;
    wsHandle = null;
    tablesElem.textContent = '';
    if (view === 'tables') setView(wsPriorView === 'tables' ? 'rest' : wsPriorView);
  }

  /** @type {?ReturnType<import('../automations/inspectDocument.js').buildInspectWorkspace>} */
  let inspectHandle = null;
  let inspectPriorView = 'rest';
  /** Whether the mode opened a closed panel, so leaving the mode closes it again. */
  let inspectOpenedPanel = false;

  /** Called by the Inspect Document mode: show its workspace, building it on first use and refreshing it after. */
  async function openInspectWorkspace() {
    if (view !== 'inspect') inspectOpenedPanel = !openState;
    open();
    if (view !== 'inspect') inspectPriorView = view;
    setView('inspect');
    if (inspectHandle) { inspectHandle.refresh(); return; }
    const module = await import('../automations/inspectDocument.js');
    // The mode may have exited (or the view moved on) during the await.
    if (view !== 'inspect' || inspectHandle) return;
    inspectElem.textContent = '';
    inspectHandle = module.buildInspectWorkspace(host, inspectElem);
  }

  /** Called when the Inspect Document mode exits: tear the workspace down and restore the prior view. */
  function closeInspectWorkspace() {
    if (!inspectHandle && view !== 'inspect') return;
    inspectHandle?.teardown();
    inspectHandle = null;
    inspectElem.textContent = '';
    if (view === 'inspect') setView(inspectPriorView === 'inspect' ? 'rest' : inspectPriorView);
    // Done, Esc and View close both the mode and the panel it opened; a panel that was already open stays.
    if (inspectOpenedPanel) close();
    inspectOpenedPanel = false;
  }

  /** @type {?{refresh: () => void, prefill: (term: string) => void}} */
  let redactHandle = null;

  /**
   * Open the Redactions workspace, rebuilding it against the active document.
   * @param {string} [prefillTerm] - Term left in the add box, which never stages marks on its own.
   */
  async function openRedactionsWorkspace(prefillTerm) {
    open();
    setView('redact');
    const module = await AUTOMATIONS.find((a) => a.id === 'redact-terms').load();
    if (view !== 'redact') return;
    redactElem.textContent = '';
    redactHandle = module.buildRedactionsWorkspace(host, redactElem);
    if (prefillTerm) redactHandle.prefill(prefillTerm);
  }

  /** @type {?{refresh: () => void, teardown: () => void}} */
  let bulkHandle = null;

  function closeBulkWorkspace() {
    bulkHandle?.teardown();
    bulkHandle = null;
    bulkElem.textContent = '';
  }

  /** Open the Bulk Edit workspace, rebuilding it against the active document. */
  async function openBulkEditWorkspace() {
    open();
    setView('bulk');
    const module = await AUTOMATIONS.find((a) => a.id === 'bulk-edit').load();
    if (view !== 'bulk') return;
    closeBulkWorkspace();
    bulkHandle = module.buildBulkEditWorkspace(host, bulkElem);
  }

  backBtn.addEventListener('click', () => {
    // Panel navigation only, because the canvas mode keeps running whatever the panel shows.
    // The toolbar button and the banner's Done are that mode's only exits.
    if (activeRun && activeRun.status === 'form') activeRun = null;
    setView('rest');
  });
  stripStop.addEventListener('click', stopTurn);
  stripResume.addEventListener('click', () => {
    if (stripMode === 'asst') {
      const att = stripTarget();
      if (app.doc && att) openChat(app.doc, att);
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
      if (!runningLive(app.doc)) submitAsk();
    } else if (e.key === 'Escape') {
      stopTurn();
    }
  });
  csend.addEventListener('click', () => {
    if (runningLive(app.doc)) stopTurn();
    else submitAsk();
  });
  plusBtn.addEventListener('click', () => {
    if (app.doc) openChat(app.doc, newDraft());
  });
  plusBtn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && app.doc) {
      e.preventDefault();
      openChat(app.doc, newDraft());
    }
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
    if (automations) {
      if (view === 'rest') paintCatalog();
      paintTray();
      syncModelChip();
    }
    hooks.onLayoutChange();
  };
  const close = () => {
    if (!openState) return;
    openState = false;
    if (view === 'bulk') setView('rest');
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
    if (view === 'redact') {
      // The workspace binds to the outgoing document's term store, so a stale view must not survive the switch.
      redactHandle = null;
      redactElem.textContent = '';
      setView('rest');
    } else if (view === 'bulk' || view === 'assistant' || view === 'chats') setView('rest');
    else if (view === 'rest') paintCatalog();
    paintTray();
    syncComposer();
    syncStrip();
    // The active-doc-change event can fire before the new document is attached, so repaint again once the switch settles.
    setTimeout(() => {
      paintTray();
      syncComposer();
      syncStrip();
    }, 0);
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
      if (automations && openState && view === 'rest') paintCatalog();
    },
    /** Called when the sidebar view changes so the catalog can surface that view's automations. */
    syncSidebar: () => {
      if (automations && openState && view === 'rest') paintCatalog();
    },
    /** Whether the automation content (catalog, composer, hand-offs) is on; the workspaces are hosted either way. */
    automations,
    /**
     * The document's conversation trace as a versioned envelope, for the dev-only log export.
     * Null when tracing is off or the document has no conversation.
     * @param {?import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
     */
    exportTrace: (doc) => {
      if (!doc) return null;
      const st = docStates.get(doc);
      if (!st) return null;
      const recent = mostRecentRec(doc);
      const live = (st.activeRec && st.live.get(st.activeRec)) || st.draft || (recent && st.live.get(recent)) || null;
      if (!live?.trace) return null;
      return buildTraceEnvelope(live.trace, {
        adapter: live.adapter,
        doc: { baseName: app._baseName(), pageCount: doc.pageMetrics.length },
        flags: { automate: true, assistantTrace: true },
        messages: live.rec ? live.rec.messages : [],
      });
    },
    /**
     * Open the panel with a tool staged from a hand-off surface (selection menu, bookmarks panel).
     * The form is only staged, so Run stays a deliberate click.
     * @param {string} id
     * @param {Object} [prefill]
     */
    launchAutomation: (id, prefill) => {
      open();
      const entry = AUTOMATIONS.find((a) => a.id === id);
      if (!entry) return;
      if (entry.openInstead) entry.openInstead(host, prefill);
      else launch(entry, prefill);
    },
    /** Open the Redactions workspace. */
    openRedactionsWorkspace,
    /** Open the Bulk Edit workspace. */
    openBulkEditWorkspace,
    /** Re-render the Redactions workspace's counts after a mark mutation, and do nothing when that view is hidden. */
    refreshRedactions: () => {
      if (view === 'redact') redactHandle?.refresh();
    },
    /** Called by the Extract Tables mode: show the tables workspace (count note + table list + export block). */
    openTablesWorkspace,
    /** Called when the Extract Tables mode exits: tear the workspace down and restore the prior view. */
    closeTablesWorkspace,
    openInspectWorkspace,
    closeInspectWorkspace,
    /** The live Inspect Document workspace, for the mode's page interactions; null while it is closed. */
    inspectWorkspace: () => inspectHandle,
    destroy: () => {
      closeBulkWorkspace();
      closeInspectWorkspace();
      for (const abort of activeAborts) abort.abort();
      activeAborts.clear();
      closeModelMenu(false);
      app.container.removeEventListener('scribe-active-doc-change', onDocChange);
    },
  };
}
