// Debug menu: developer-only tools, installed only when `DEBUG_MENU` in scribe-ui/devFlags.js is on and stripped from public builds.

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

  // The overlay is built from this flag, so toggling it requires clearing the built text and re-rendering to apply.
  appMenu.addToggle(
    'Disable text overlay',
    BUG_SVG,
    () => viewer.textOverlayDisabledDebug,
    () => {
      viewer.textOverlayDisabledDebug = !viewer.textOverlayDisabledDebug;
      viewer.destroyText(false);
      viewer.displayPage(viewer.state.cp.n, false, true);
    },
  );

  // The flag is read live on the next right-click, so toggling it needs no re-render.
  appMenu.addToggle(
    'Disable custom context menu',
    BUG_SVG,
    () => viewer.contextMenuDisabledDebug,
    () => { viewer.contextMenuDisabledDebug = !viewer.contextMenuDisabledDebug; },
  );
}
