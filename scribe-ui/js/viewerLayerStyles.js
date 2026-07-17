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
    // Set on the zoom layer during an active iOS pinch: rotated page-sized groups each cost a full unscaled-layout surface, so they sit out the pinch.
    + '.scribe-zoom.scribe-pinch .scribe-group{display:none!important}'
    + '.scribe-hl-band{opacity:var(--scribe-hl-o,1);transition:opacity .12s ease}'
    // Hover and selected (mini toolbar open) share the same lift.
    + '.scribe-hl-band.scribe-hl-hover,.scribe-hl-band.scribe-hl-sel{opacity:min(1,calc(var(--scribe-hl-o,1)*1.56))}'
    // The highlight layer is scaled by the zoom, so dividing it back out holds a constant on-screen size.
    // The highlight group is pointer-events:none, so the mark opts back in.
    + '.scribe-hl-cmark{position:absolute;width:calc(14px/var(--scribe-zoom,1));height:calc(14px/var(--scribe-zoom,1));'
    + 'pointer-events:auto;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(30,26,16,.3))}'
    + '.scribe-hl-cmark svg{width:100%;height:100%;display:block;pointer-events:none}'
    + '.scribe-hl-cmark:focus-visible{outline:2px solid var(--scribe-accent,#1c62d4);outline-offset:1px;border-radius:3px}'
    // A translucent hatch keeps the content reviewable until export applies the real redaction.
    // The red is hardcoded, not a theme token, because page-space chrome is never themed.
    + '.scribe-redact-mark{position:absolute;box-sizing:border-box;'
    + 'background:repeating-linear-gradient(45deg,rgba(209,73,61,.24) 0 calc(4px/var(--scribe-zoom,1)),'
    + 'transparent calc(4px/var(--scribe-zoom,1)) calc(7px/var(--scribe-zoom,1)));'
    + 'border:calc(2px/var(--scribe-zoom,1)) solid #d1493d;pointer-events:none;'
    + 'transition:background-color .12s ease}'
    // Applied when the mark's comments-panel row is hovered (the panel-to-page half of the hover sync).
    // The hatch above lives in background-image, so background-color is free to add the fill without clobbering it.
    + '.scribe-redact-mark.scribe-redact-hover{background-color:rgba(209,73,61,.16)}'
    // The export preview: the mark becomes the black box export will paint.
    // Placed after the hover rule so this solid fill wins when both classes are set.
    + '.scribe-redact-mark.scribe-redact-preview-on{background:#000;border-color:#000}'
    // The tab lives in the unblended tab layer (not the blended redaction layer) so its label stays opaque, and opts back into pointer events since that layer is pointer-events:none.
    + '.scribe-redact-tab{position:absolute;transform:translateY(-100%);pointer-events:auto;cursor:pointer;'
    + 'user-select:none;background:#d1493d;color:#fff;font-family:system-ui,-apple-system,sans-serif;'
    + 'font-size:calc(7.5px/var(--scribe-zoom,1));font-weight:700;line-height:1;'
    + 'letter-spacing:calc(.6px/var(--scribe-zoom,1));text-transform:uppercase;'
    + 'padding:calc(3px/var(--scribe-zoom,1)) calc(6px/var(--scribe-zoom,1)) calc(2.5px/var(--scribe-zoom,1));'
    + 'border-radius:calc(3px/var(--scribe-zoom,1)) calc(3px/var(--scribe-zoom,1)) 0 0}'
    + '.scribe-redact-tab:hover{background:#b93a2f}'
    + '.scribe-redact-tab.pinned{background:#7f2015}'
    // The live box shown while drag-drawing a region mark.
    + '.scribe-redact-preview{position:absolute;box-sizing:border-box;'
    + 'background:repeating-linear-gradient(45deg,rgba(209,73,61,.14) 0 calc(4px/var(--scribe-zoom,1)),'
    + 'transparent calc(4px/var(--scribe-zoom,1)) calc(7px/var(--scribe-zoom,1)));'
    + 'border:calc(2px/var(--scribe-zoom,1)) dashed #d1493d;pointer-events:none}';
  document.head.appendChild(styleEl);
}
