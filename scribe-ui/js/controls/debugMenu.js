// Debug menu: developer-only tools, installed only when `DEBUG_MENU` in scribe-ui/devFlags.js is on and stripped from public builds.
import { UiText } from '../viewerWordObjects.js';

/** Bug glyph for the Debug section's rows. */
const BUG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="8" y="8" width="8" height="11" rx="4"/>'
  + '<path d="M9 8a3 3 0 0 1 6 0M12 11v8M5.5 12h13M6 8.5 4 7M18 8.5 20 7M5 16l-2 1.5M19 16l2 1.5"/></svg>';

/**
 * Append a "Debug" section to the app menu: a header row plus dev-only toggles.
 * @param {ReturnType<import('./toolbar.js').createAppMenu>} appMenu - The app menu built in pdf-viewer.js.
 * @param {import('../../viewer.js').ScribeViewer} viewer - The viewer whose overlay the tools act on.
 */
export function installDebugMenu(appMenu, viewer) {
  appMenu.addSeparator();

  const header = document.createElement('div');
  header.textContent = 'Debug';
  Object.assign(header.style, {
    padding: '4px 11px 2px',
    fontSize: '10.5px',
    fontWeight: '700',
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: 'var(--scribe-ink-3)',
    userSelect: 'none',
  });
  appMenu.menuElem.appendChild(header);

  // Off (the default) = the model-driven built-in engine; On = the DOM engine, whose invisible word spans sit under the browser's native selection.
  appMenu.addToggle(
    'DOM-based text selection',
    BUG_SVG,
    () => !viewer.useCustomSelection,
    () => {
      viewer.setSelectionEngineDebug(viewer.useCustomSelection ? 'dom' : 'custom');
      syncOverlayRow();
    },
  );

  // Rebuild the text layer so the mode change reaches already-rendered pages.
  appMenu.addToggle(
    'Proof mode (word editing)',
    BUG_SVG,
    () => UiText.enableEditing,
    () => {
      UiText.enableEditing = !UiText.enableEditing;
      viewer.state.displayMode = UiText.enableEditing ? 'proof' : 'invis';
      viewer.destroyText(false);
      viewer.displayPage(viewer.state.cp.n, false, true);
    },
  );

  // The overlay is built from this flag, so toggling rebuilds the text layer to apply.
  // Only the DOM engine has an overlay to disable (the built-in engine draws selection from the model), so this row is greyed and inert while the built-in engine is active.
  const overlayRow = appMenu.addToggle(
    'Disable text overlay',
    BUG_SVG,
    () => viewer.textOverlayDisabledDebug,
    () => {
      viewer.textOverlayDisabledDebug = !viewer.textOverlayDisabledDebug;
      viewer.destroyText(false);
      viewer.displayPage(viewer.state.cp.n, false, true);
    },
  );

  const syncOverlayRow = () => {
    const inert = viewer.useCustomSelection;
    overlayRow.item.style.opacity = inert ? '0.45' : '';
    overlayRow.item.style.pointerEvents = inert ? 'none' : '';
    overlayRow.item.title = inert ? 'DOM-based text selection only' : '';
    overlayRow.item.tabIndex = inert ? -1 : 0;
    overlayRow.sync();
  };
  syncOverlayRow();
}
