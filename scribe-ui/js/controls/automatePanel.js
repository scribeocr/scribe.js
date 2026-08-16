// The Automate panel: the automation surface docked on the right edge.
// It shows the catalog at rest and one tool's run thread while working, with a strip pinning a live run whenever the catalog is showing.
import { makeIconButton, formatTimestamp } from './toolbar.js';
import { AUTOMATIONS, CATEGORY_ORDER, MODE_GROUPS } from '../automations/registry.js';

const lineIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

/** The Automate identity glyph, drawn on the toolbar opener and the panel header. */
const AUTOMATE_SVG = lineIcon('<path d="M5 7.2l5.6 4.8L5 16.8z"/><path d="M14 7.5h5.5M14 12h5.5M14 16.5h3.5"/>');
const BACK_SVG = lineIcon('<path d="M14 6l-6 6 6 6"/>');
const SEND_SVG = lineIcon('<path d="M4.5 11.4L19.5 4.5 15.6 19.5l-3.9-5.2z"/><path d="M11.7 14.3l7.8-9.8"/>');
const SPIN_SVG = lineIcon('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5"/>');
const CHECK_SVG = lineIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');
const FILE_SVG = lineIcon('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13 3.5V8h4.5"/>');
const ROW_ICON_FALLBACK = AUTOMATE_SVG;

export const AUTOMATE_PANEL_WIDTH = 340;

const injected = new Set();

function addAutomateStyles(rootClass) {
  if (injected.has(rootClass)) return;
  injected.add(rootClass);
  const r = rootClass;
  const style = document.createElement('style');
  style.textContent = `
    .${r} .scribe-library-bar .scribe-automate-toggle, .${r} .scribe-library-bar .scribe-automate-sep { display: none; }
    .${r} .scribe-am-panel {
      position: absolute; right: 0; width: ${AUTOMATE_PANEL_WIDTH}px; z-index: 10; box-sizing: border-box;
      background: var(--scribe-surface); border-left: 1px solid var(--scribe-line);
      display: flex; flex-direction: column; color: var(--scribe-ink); font-size: 13px; overflow: hidden;
    }
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
      display: flex; align-items: center; gap: 8px; border: 1px solid var(--scribe-line-strong); border-radius: 9px;
      background: var(--scribe-surface); padding: 5px 4px 5px 10px; min-width: 0;
    }
    .${r} .scribe-am-cbox:focus-within { border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-am-cbox input {
      flex: 1; border: none; outline: none; background: none; font: inherit; font-size: 12.5px; color: var(--scribe-ink); min-width: 0;
    }
    .${r} .scribe-am-cbox input::placeholder { color: var(--scribe-ink-3); }
    .${r} .scribe-am-send { color: var(--scribe-ink-3); }
    .${r} .scribe-am-send.ready { color: var(--scribe-accent); }
  `;
  document.head.appendChild(style);
}

/**
 * Build the Automate panel and its toolbar opener.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @param {string} rootClass
 * @param {{onLayoutChange: () => void}} hooks
 */
export function createAutomatePanel(app, rootClass, hooks) {
  addAutomateStyles(rootClass);
  const host = { app, viewer: app.scribe };

  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-am-panel';
  panelElem.style.display = 'none';

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
  const stripResume = document.createElement('button');
  stripResume.type = 'button';
  stripResume.className = 'scribe-am-strip-resume';
  stripResume.textContent = 'Resume';
  strip.append(stripIc, stripTx, stripResume);

  const catalog = document.createElement('div');
  catalog.className = 'scribe-am-catalog';

  const thread = document.createElement('div');
  thread.className = 'scribe-am-thread';
  thread.style.display = 'none';

  const composer = document.createElement('div');
  composer.className = 'scribe-am-composer';
  const cbox = document.createElement('div');
  cbox.className = 'scribe-am-cbox';
  const cinput = document.createElement('input');
  cinput.type = 'text';
  cinput.placeholder = 'Search automations';
  cinput.setAttribute('aria-label', 'Search automations');
  const csend = document.createElement('span');
  csend.className = 'scribe-am-ib scribe-am-send';
  csend.role = 'button';
  csend.tabIndex = 0;
  csend.title = 'Open the first match';
  csend.innerHTML = SEND_SVG;
  cbox.append(cinput, csend);
  composer.appendChild(cbox);

  panelElem.append(hd, strip, catalog, thread, composer);

  const toggleElem = makeIconButton('Automate', AUTOMATE_SVG);
  toggleElem.classList.add('cr-labeled-button', 'scribe-automate-toggle', 'scribe-phone-hide');
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'cr-btn-label';
  toggleLabel.textContent = 'Automate';
  toggleElem.appendChild(toggleLabel);

  /** 'rest' (catalog) or 'thread' (one tool's run). */
  let view = 'rest';
  let openState = false;
  /** @type {?string} The active tool mode's title, for the "For <mode>" catalog group. */
  let modeName = null;
  /** @type {?{entry: Object, title: string, status: 'form'|'running'|'done'|'failed', seen: boolean}} */
  let activeRun = null;

  const setView = (next) => {
    view = next;
    const rest = next === 'rest';
    catalog.style.display = rest ? '' : 'none';
    composer.style.display = rest ? '' : 'none';
    thread.style.display = rest ? 'none' : '';
    backBtn.style.display = rest ? 'none' : '';
    hdIcon.style.display = rest ? '' : 'none';
    hdTitle.textContent = rest ? 'Automate' : (activeRun ? activeRun.title : 'Automate');
    syncStrip();
    if (rest) paintCatalog();
  };

  function syncStrip() {
    const show = view === 'rest' && activeRun
      && (activeRun.status === 'running' || (activeRun.status !== 'form' && !activeRun.seen));
    strip.style.display = show ? 'flex' : 'none';
    if (show) stripTx.textContent = `${activeRun.title} — ${activeRun.status === 'running' ? 'running…' : 'done'}`;
  }

  /** Rows the composer's Enter can launch, refreshed by every catalog paint. */
  let firstLaunchable = null;

  function paintCatalog() {
    catalog.textContent = '';
    firstLaunchable = null;
    const filter = cinput.value.trim().toLowerCase();
    const matches = (entry) => !filter || `${entry.title} ${entry.description}`.toLowerCase().includes(filter);
    const addGroup = (label, entries) => {
      if (!entries.length) return;
      const h = document.createElement('div');
      h.className = 'scribe-am-cat';
      h.textContent = label;
      catalog.appendChild(h);
      for (const entry of entries) catalog.appendChild(buildRow(entry));
    };
    let shown = 0;
    const modeGroup = !filter && modeName ? MODE_GROUPS[modeName] : null;
    if (modeGroup) {
      const entries = modeGroup.ids.map((id) => AUTOMATIONS.find((a) => a.id === id)).filter(Boolean);
      addGroup(modeGroup.label, entries);
      shown += entries.length;
    }
    for (const cat of CATEGORY_ORDER) {
      const entries = AUTOMATIONS.filter((a) => a.category === cat && matches(a));
      addGroup(cat, entries);
      shown += entries.length;
    }
    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'scribe-am-empty';
      empty.textContent = 'No matches';
      catalog.appendChild(empty);
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
    if (!why) {
      row.addEventListener('click', () => launch(entry));
      if (!firstLaunchable) firstLaunchable = row;
    }
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

  backBtn.addEventListener('click', () => {
    if (activeRun && activeRun.status === 'form') activeRun = null;
    setView('rest');
  });
  stripResume.addEventListener('click', () => {
    if (!activeRun) return;
    activeRun.seen = true;
    setView('thread');
  });

  cinput.addEventListener('input', () => {
    csend.classList.toggle('ready', !!cinput.value.trim());
    if (view === 'rest') paintCatalog();
  });
  const launchFirst = () => { if (firstLaunchable) firstLaunchable.click(); };
  cinput.addEventListener('keydown', (e) => { if (e.key === 'Enter') launchFirst(); });
  csend.addEventListener('click', launchFirst);

  const open = () => {
    if (openState) return;
    openState = true;
    panelElem.style.display = 'flex';
    toggleElem.classList.add('active');
    if (view === 'rest') paintCatalog();
    hooks.onLayoutChange();
  };
  const close = () => {
    if (!openState) return;
    openState = false;
    panelElem.style.display = 'none';
    toggleElem.classList.remove('active');
    hooks.onLayoutChange();
  };
  toggleElem.addEventListener('click', () => (openState ? close() : open()));
  closeBtn.addEventListener('click', close);

  // The catalog's enabled/disabled reasons depend on the active document.
  const onDocChange = () => { if (openState && view === 'rest') paintCatalog(); };
  app.container.addEventListener('scribe-active-doc-change', onDocChange);

  return {
    panelElem,
    toggleElem,
    width: AUTOMATE_PANEL_WIDTH,
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
     * Open the panel with Redact terms staged from a selection, for the selection menu's hand-off row.
     * The form is only staged, so Run stays a deliberate click.
     */
    stageRedactTerms: (term) => {
      open();
      const entry = AUTOMATIONS.find((a) => a.id === 'redact-terms');
      if (entry) launch(entry, { terms: [term] });
    },
    destroy: () => app.container.removeEventListener('scribe-active-doc-change', onDocChange),
  };
}
