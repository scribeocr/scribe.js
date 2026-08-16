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
    // A native selection anchored in the page container reaches the raster, and WebKit paints the whole page image blue.
    // Chrome leaves the canvas out of the range, so this rule looks like a no-op there.
    + '.scribe-layer-image{user-select:none;-webkit-user-select:none}'
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
    + 'border:calc(2px/var(--scribe-zoom,1)) dashed #d1493d;pointer-events:none}'
    // The wash sits in ::before so it still tints an edited field, where `.scribe-field-dirty` turns the element's own background opaque white.
    + '.scribe-field{position:absolute;box-sizing:border-box;pointer-events:auto;cursor:text;'
    + 'border:calc(1px/var(--scribe-zoom,1)) solid rgb(103,144,213)}'
    + '.scribe-field::before{content:"";position:absolute;inset:0;pointer-events:none;'
    + 'border-radius:inherit;background:rgba(28,98,212,.08)}'
    + '.scribe-field:hover::before{background:rgba(28,98,212,.14)}'
    + '.scribe-field-checkbox,.scribe-field-radio,.scribe-field-choice{cursor:pointer}'
    + '.scribe-field-radio{border-radius:50%}'
    // Text selection ignores presses that land on `.scribe-field`, so dropping pointer events here keeps the text under a read-only field selectable.
    + '.scribe-field-ro{pointer-events:none;cursor:default;border-color:#a5a5a5}'
    + '.scribe-field-ro::before{background:rgba(0,0,0,.055)}'
    + '.scribe-field:focus,.scribe-field:focus-within{outline:none;border-color:#1c62d4;'
    + 'box-shadow:0 0 0 calc(2px/var(--scribe-zoom,1)) rgba(28,98,212,.30)}'
    + '.scribe-field-req::after{content:"";position:absolute;'
    + 'right:calc(-3px/var(--scribe-zoom,1));top:calc(-3px/var(--scribe-zoom,1));'
    + 'width:calc(7px/var(--scribe-zoom,1));height:calc(7px/var(--scribe-zoom,1));border-radius:50%;'
    + 'background:#d1493d;border:calc(1.5px/var(--scribe-zoom,1)) solid #fff}'
    // The page raster underneath still shows the field's pre-edit value, so the box goes opaque to hide it.
    + '.scribe-field-dirty{background:#fff}'
    + '.scribe-field-cover{position:absolute;inset:0;pointer-events:none;border-radius:inherit;overflow:hidden}'
    + '.scribe-field-covertext{position:absolute;white-space:pre;line-height:1;color:#141414;'
    + 'font-family:Helvetica,Arial,sans-serif}'
    + '.scribe-field-checkbox .scribe-field-cover,.scribe-field-radio .scribe-field-cover'
    + '{display:flex;align-items:center;justify-content:center}'
    + '.scribe-field-check{width:78%;height:78%;fill:none;stroke:#141414;stroke-width:3.4;'
    + 'stroke-linecap:round;stroke-linejoin:round}'
    + '.scribe-field-radio-dot{width:45%;height:45%;border-radius:50%;background:#141414}'
    + '.scribe-field-input{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;'
    + 'border:none;outline:none;margin:0;background:#fff;color:#141414;resize:none;'
    + 'font-family:Helvetica,Arial,sans-serif;line-height:1.15;border-radius:inherit}'
    // Comb editing: the input turns fully transparent and a live cover beneath it renders the per-cell spans.
    // The caret is drawn as a bar on the active cell boundary.
    + '.scribe-field-input-comb{background:transparent;color:transparent;caret-color:transparent}'
    + '.scribe-field-input-comb::selection{background:transparent;color:transparent}'
    + '.scribe-field-combedit{background-color:#fff}'
    + '.scribe-field-combsep{position:absolute;top:0;bottom:0;width:calc(1px/var(--scribe-zoom,1));'
    + 'margin-left:calc(-0.5px/var(--scribe-zoom,1));background:#6b6b6b}'
    + '.scribe-field-caret{position:absolute;width:calc(1.5px/var(--scribe-zoom,1));'
    + 'margin-left:calc(-0.75px/var(--scribe-zoom,1));background:#1c62d4;pointer-events:none;'
    + 'animation:scribe-field-caret-blink 1.1s steps(1) infinite}'
    + '.scribe-field-caret-off{display:none}'
    + '.scribe-field-combsel{background:rgba(28,98,212,.28)}'
    + '@keyframes scribe-field-caret-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}'
    // The choice popover is not drawn on the page, so it uses the theme tokens rather than the hardcoded page-space colors.
    + '.scribe-field-pop{position:fixed;z-index:1000;max-height:260px;overflow-y:auto;padding:4px;box-sizing:border-box;'
    + 'background:var(--scribe-surface,#fff);border:1px solid var(--scribe-line,#e4e8ef);'
    + 'border-radius:8px;box-shadow:var(--scribe-menu-shadow,0 4px 14px rgba(20,30,60,.13))}'
    + '.scribe-field-pop-item{padding:5px 10px;border-radius:5px;cursor:pointer;'
    + 'font:12.5px system-ui,-apple-system,sans-serif;color:var(--scribe-ink,#1f2530);'
    + 'white-space:pre;max-width:min(420px,90vw);overflow:hidden;text-overflow:ellipsis}'
    + '.scribe-field-pop-item:hover,.scribe-field-pop-item.active{background:var(--scribe-hover,rgba(28,42,68,.06))}'
    + '.scribe-field-pop-item.current{font-weight:650;color:var(--scribe-accent,#1c62d4)}'
    // An edited field's opaque white fill hides the document's own printed box, so it keeps a neutral border in its place.
    + '.scribe-fields-off .scribe-field::before{background:transparent}'
    + '.scribe-fields-off .scribe-field-req::after{display:none}'
    + '.scribe-fields-off .scribe-field:not(:focus):not(:focus-within){border-color:transparent;box-shadow:none}'
    + '.scribe-fields-off .scribe-field-dirty:not(:focus):not(:focus-within){border-color:#6b6b6b}'
    + '.scribe-item{position:absolute;pointer-events:auto;cursor:move;touch-action:none}'
    + '.scribe-item-ink{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block}'
    + '.scribe-item-ink path{fill:none;stroke-linecap:round;stroke-linejoin:round}'
    + '.scribe-item-img{position:absolute;inset:0;width:100%;height:100%;user-select:none;-webkit-user-drag:none}'
    + '.scribe-item-ghost{pointer-events:none;opacity:.6}'
    // Detected fillable spots reuse the live field overlay's border and wash, page-space and never themed.
    // The snap variant is the armed ghost's landing ring.
    + '.scribe-fd-target{position:absolute;pointer-events:none;box-sizing:border-box;'
    + 'border:calc(1px/var(--scribe-zoom,1)) solid rgb(103,144,213);background:rgba(28,98,212,.16)}'
    + '.scribe-fd-snap{position:absolute;pointer-events:none;box-sizing:border-box;'
    + 'border:calc(1.5px/var(--scribe-zoom,1)) solid #1c62d4;background:rgba(28,98,212,.10);'
    + 'box-shadow:0 0 0 calc(2px/var(--scribe-zoom,1)) rgba(28,98,212,.25)}'
    // The font and 1.2 line-height mirror the Helvetica layout `syncFillText` uses for the lifted words, so the item matches the exported PDF.
    + '.scribe-item-text{font-family:Helvetica,Arial,sans-serif;line-height:1.2;white-space:pre;color:#000}'
    + '.scribe-item-text-editing{position:absolute;pointer-events:auto;cursor:text;user-select:text;'
    + 'outline:calc(1.5px/var(--scribe-zoom,1)) solid #1c62d4;outline-offset:calc(2px/var(--scribe-zoom,1));'
    + 'background:transparent;caret-color:#1c62d4}'
    + '.scribe-item-text-editing:focus{outline:calc(1.5px/var(--scribe-zoom,1)) solid #1c62d4}'
    + '.scribe-item-sel{outline:calc(1.5px/var(--scribe-zoom,1)) solid #1c62d4;'
    + 'outline-offset:calc(2px/var(--scribe-zoom,1))}'
    + '.scribe-item-dot{position:absolute;width:calc(9px/var(--scribe-zoom,1));height:calc(9px/var(--scribe-zoom,1));'
    + 'border-radius:50%;background:#1c62d4;border:calc(1.5px/var(--scribe-zoom,1)) solid #fff;pointer-events:auto}'
    + '.scribe-item-dot-nw{left:calc(-6px/var(--scribe-zoom,1));top:calc(-6px/var(--scribe-zoom,1));cursor:nwse-resize}'
    + '.scribe-item-dot-ne{right:calc(-6px/var(--scribe-zoom,1));top:calc(-6px/var(--scribe-zoom,1));cursor:nesw-resize}'
    + '.scribe-item-dot-sw{left:calc(-6px/var(--scribe-zoom,1));bottom:calc(-6px/var(--scribe-zoom,1));cursor:nesw-resize}'
    + '.scribe-item-dot-se{right:calc(-6px/var(--scribe-zoom,1));bottom:calc(-6px/var(--scribe-zoom,1));cursor:nwse-resize}'
    + '.scribe-item-freetext{position:absolute;pointer-events:none;font-family:Helvetica,Arial,sans-serif;'
    + 'line-height:1.2;white-space:pre-wrap;overflow:hidden;box-sizing:border-box;padding:2px}'
    + '.scribe-item-shape{position:absolute;pointer-events:none;overflow:visible}'
    + '.scribe-fs-armed .scribe-viewport{cursor:crosshair}'
    + '.scribe-field-sig{cursor:pointer}';
  document.head.appendChild(styleEl);
}
