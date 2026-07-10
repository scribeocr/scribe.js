// Styles for viewer. Separate file as importing another viewer module would cause import cycle.

/** Filled speech-bubble mark meaning "a comment is here". */
export const COMMENT_MARK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path fill="currentColor" d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4 3.4V16H5.5A2.5 2.5 0 0 1 3 13.5v-7A2.5 2.5 0 0 1 5.5 4z"/></svg>';

let layerStyleSheetInjected = false;
/** Inject the one-time viewer stylesheet whose band opacity lives in `--scribe-hl-o` so the hover/selected lift can scale it with one class. */
export function ensureLayerStyleSheet() {
  if (layerStyleSheetInjected || typeof document === 'undefined') return;
  layerStyleSheetInjected = true;
  const styleEl = document.createElement('style');
  styleEl.textContent = '.scribe-hide-text-layer .scribe-layer-text{display:none}'
    + '.scribe-hide-overlay-layer .scribe-layer-overlay{display:none}'
    + '.scribe-hide-image-layer .scribe-layer-image{display:none!important}'
    + '.scribe-hl-band{opacity:var(--scribe-hl-o,1);transition:opacity .12s ease}'
    // Hover and selected (mini toolbar open) share the same lift.
    + '.scribe-hl-band.scribe-hl-hover,.scribe-hl-band.scribe-hl-sel{opacity:min(1,calc(var(--scribe-hl-o,1)*1.56))}'
    // The highlight layer is scaled by the zoom, so dividing it back out holds a constant on-screen size.
    // The highlight group is pointer-events:none, so the mark opts back in.
    + '.scribe-hl-cmark{position:absolute;width:calc(14px/var(--scribe-zoom,1));height:calc(14px/var(--scribe-zoom,1));'
    + 'pointer-events:auto;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(30,26,16,.3))}'
    + '.scribe-hl-cmark svg{width:100%;height:100%;display:block;pointer-events:none}'
    + '.scribe-hl-cmark:focus-visible{outline:2px solid var(--scribe-accent,#1c62d4);outline-offset:1px;border-radius:3px}';
  document.head.appendChild(styleEl);
}
