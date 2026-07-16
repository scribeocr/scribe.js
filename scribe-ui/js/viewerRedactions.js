// Create, render, hit-test, and delete `type:'redact'` annotations.
// A mark is content slated for true removal at export: every export deletes the marked text, vector glyphs, and image pixels rather than covering them.
// In the viewer and `.scribe` saves the mark stays reviewable and deletable.
import { bboxToPageSpace } from '../../js/addHighlights.js';

/**
 * Return the redaction marks on page n.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {AnnotationRedact[]}
 */
export function pageRedactions(viewer, n) {
  return /** @type {AnnotationRedact[]} */ ((viewer.doc.annotations.pages[n] || []).filter((a) => a.type === 'redact'));
}

/**
 * Next free `rd-N` group id, numbered above every existing mark so ids stay unique even after a `.scribe` restore.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
function nextGroupId(viewer) {
  let groupN = 0;
  for (const pageAnnots of viewer.doc.annotations.pages) {
    for (const annot of pageAnnots || []) {
      if (annot.type !== 'redact') continue;
      const m = /^rd-(\d+)$/.exec(annot.groupId);
      if (m) groupN = Math.max(groupN, Number(m[1]) + 1);
    }
  }
  return `rd-${groupN}`;
}

/**
 * Whether an existing mark on page n already fully covers `b` (page space).
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {bbox} b
 */
function redactionCovers(viewer, n, b) {
  return pageRedactions(viewer, n).some((a) => a.bbox.left <= b.left && a.bbox.right >= b.right
    && a.bbox.top <= b.top && a.bbox.bottom >= b.bottom);
}

/**
 * Mark the given model words for redaction: one group per gesture, one rect per run of adjacent words on a line.
 * Words an existing mark already covers are skipped, so re-marking the same text never stacks duplicate rects.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<OcrWord>} words
 * @returns {number} Marks added.
 */
export function redactWords(viewer, words) {
  if (!words || words.length === 0) return 0;
  const newWords = words.filter((word) => {
    const page = word.line.page;
    return !redactionCovers(viewer, page.n, bboxToPageSpace(word.bbox, word.line.orientation, page.dims));
  });
  if (newWords.length === 0) return 0;
  const groupId = nextGroupId(viewer);
  const pages = new Set();
  let added = 0;
  /** @type {?{ line: OcrLine, lastIdx: number, bbox: bbox }} */
  let run = null;
  const flushRun = () => {
    if (!run) return;
    const page = run.line.page;
    if (!viewer.doc.annotations.pages[page.n]) viewer.doc.annotations.pages[page.n] = [];
    viewer.doc.annotations.pages[page.n].push({
      type: 'redact', bbox: bboxToPageSpace(run.bbox, run.line.orientation, page.dims), groupId,
    });
    pages.add(page.n);
    added++;
    run = null;
  };
  for (const word of newWords) {
    const idx = word.line.words.indexOf(word);
    if (run && word.line === run.line && idx === run.lastIdx + 1) {
      run.bbox.left = Math.min(run.bbox.left, word.bbox.left);
      run.bbox.top = Math.min(run.bbox.top, word.bbox.top);
      run.bbox.right = Math.max(run.bbox.right, word.bbox.right);
      run.bbox.bottom = Math.max(run.bbox.bottom, word.bbox.bottom);
      run.lastIdx = idx;
      continue;
    }
    flushRun();
    run = { line: word.line, lastIdx: idx, bbox: { ...word.bbox } };
  }
  flushRun();
  for (const n of pages) viewer.renderRedactions(n);
  // Surface the new mark in an open comments panel (marks are listed like highlights).
  if (viewer._rebuildCommentsPanel) viewer._rebuildCommentsPanel();
  return added;
}

/**
 * Mark a page region for redaction (box-draw or programmatic), clamped to the page.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {bbox} box - Page coords (top-left origin).
 * @returns {boolean} Whether a mark was added.
 */
export function redactRegion(viewer, n, box) {
  const dims = viewer.doc.pageMetrics[n]?.dims;
  const left = Math.max(0, Math.min(box.left, box.right));
  const top = Math.max(0, Math.min(box.top, box.bottom));
  const right = Math.min(dims ? dims.width : Infinity, Math.max(box.left, box.right));
  const bottom = Math.min(dims ? dims.height : Infinity, Math.max(box.top, box.bottom));
  if (!(right > left && bottom > top)) return false;
  // Skip a box an existing mark already covers; a new rect would only duplicate it.
  if (redactionCovers(viewer, n, {
    left, top, right, bottom,
  })) return false;
  if (!viewer.doc.annotations.pages[n]) viewer.doc.annotations.pages[n] = [];
  viewer.doc.annotations.pages[n].push({
    type: 'redact',
    bbox: {
      left, top, right, bottom,
    },
    groupId: nextGroupId(viewer),
  });
  viewer.renderRedactions(n);
  if (viewer._rebuildCommentsPanel) viewer._rebuildCommentsPanel();
  return true;
}

/**
 * Remove one mark group everywhere it appears.
 * The whole group goes at once because a partially-deleted redaction is never wanted, whereas highlight groups delete per-page.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} groupId
 */
export function removeRedactionGroup(viewer, groupId) {
  let removed = false;
  for (let n = 0; n < viewer.doc.annotations.pages.length; n++) {
    const pageAnnots = viewer.doc.annotations.pages[n];
    if (!pageAnnots || pageAnnots.length === 0) continue;
    const kept = pageAnnots.filter((a) => a.type !== 'redact' || a.groupId !== groupId);
    if (kept.length !== pageAnnots.length) {
      viewer.doc.annotations.pages[n] = kept;
      viewer.renderRedactions(n);
      removed = true;
    }
  }
  // Drop the deleted mark's row from an open comments panel, and the tab if it was anchored here.
  if (removed && viewer._rebuildCommentsPanel) viewer._rebuildCommentsPanel();
  if (removed && viewer._redactTab && viewer._redactTab.groupId === groupId) hideRedactTabNow(viewer);
}

/**
 * The redaction mark under a client point, if any.
 * Uses only mark geometry, not the text index or word objects, so it works on image-only pages.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} clientX
 * @param {number} clientY
 * @returns {?{ n: number, groupId: string, annot: AnnotationRedact }}
 */
export function hitTestRedaction(viewer, clientX, clientY) {
  const pt = viewer.clientToPage(clientX, clientY);
  if (!pt) return null;
  for (const annot of pageRedactions(viewer, pt.n)) {
    if (pt.x >= annot.bbox.left && pt.x <= annot.bbox.right && pt.y >= annot.bbox.top && pt.y <= annot.bbox.bottom) {
      return { n: pt.n, groupId: annot.groupId, annot };
    }
  }
  return null;
}

/**
 * Render (or re-render) page n's redaction marks into its dedicated layer.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderPageRedactions(viewer, n) {
  const group = viewer.getRedactionsGroup(n);
  if (!group) return;
  const st = viewer._redactTab;
  group.replaceChildren();
  for (const annot of pageRedactions(viewer, n)) {
    const mark = document.createElement('div');
    mark.className = 'scribe-redact-mark';
    mark.dataset.groupId = annot.groupId;
    // A rebuild must not drop an active export preview (e.g. a re-render while the tab is pinned).
    if (st && st.on && annot.groupId === st.groupId) mark.classList.add('scribe-redact-preview-on');
    mark.style.left = `${annot.bbox.left}px`;
    mark.style.top = `${annot.bbox.top}px`;
    mark.style.width = `${annot.bbox.right - annot.bbox.left}px`;
    mark.style.height = `${annot.bbox.bottom - annot.bbox.top}px`;
    group.appendChild(mark);
  }
}

// Marks are pointer-transparent, so the Preview tab's hover uses a geometric hit test.
// TAB_FORGIVE_PX pads that hit test and TAB_LINGER_MS delays hiding, so a diagonal pointer path from mark to tab never loses the hover.
const TAB_FORGIVE_PX = 4;
const TAB_LINGER_MS = 350;

/** Toggle the applied-black preview class on every rendered mark of a group. */
function setRedactPreview(viewer, groupId, on) {
  for (const group of viewer._redactGroups) {
    if (!group) continue;
    for (const mark of group.children) {
      if (/** @type {HTMLElement} */ (mark).dataset.groupId === groupId) mark.classList.toggle('scribe-redact-preview-on', on);
    }
  }
  if (viewer._redactTab) viewer._redactTab.on = on;
}

/**
 * Hide the tab after the linger delay, unless it is re-hovered or pinned first.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function hideRedactTabSoon(viewer) {
  const st = viewer._redactTab;
  if (!st || st.pinned || !st.el.isConnected) return;
  clearTimeout(st.hideT);
  // Touch has no hover to keep the tab alive, so it must linger long enough for the next tap to reach it.
  const linger = viewer._lastPrimaryPointerType === 'touch' ? 2500 : TAB_LINGER_MS;
  st.hideT = setTimeout(() => {
    const s = viewer._redactTab;
    if (!s || s.pinned) return;
    if (s.on) setRedactPreview(viewer, s.groupId, false);
    s.el.remove();
  }, linger);
}

/** Hide the tab and clear any preview immediately. */
function hideRedactTabNow(viewer) {
  const st = viewer._redactTab;
  if (!st) return;
  clearTimeout(st.hideT);
  if (st.on) setRedactPreview(viewer, st.groupId, false);
  st.pinned = false;
  st.el.classList.remove('pinned');
  st.el.remove();
  st.groupId = '';
  st.n = -1;
}

/**
 * The mousemove handler on the scroll container: reveal the tab on the hovered mark, or start the linger toward hiding it.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {MouseEvent} event
 */
export function updateRedactTab(viewer, event) {
  const st = viewer._redactTab;
  // Over the tab itself the DOM handlers own the state; just keep it alive.
  if (st && event.target instanceof Node && st.el.contains(event.target)) {
    clearTimeout(st.hideT);
    return;
  }
  // A pinned preview stays put until the tab is clicked again.
  if (st && st.pinned) return;
  const pt = viewer.clientToPage(event.clientX, event.clientY);
  const pad = TAB_FORGIVE_PX / viewer.zoomLevel;
  let hit = null;
  if (pt && viewer.doc.pageMetrics[pt.n]) {
    for (const annot of pageRedactions(viewer, pt.n)) {
      if (pt.x >= annot.bbox.left - pad && pt.x <= annot.bbox.right + pad
        && pt.y >= annot.bbox.top - pad && pt.y <= annot.bbox.bottom + pad) { hit = annot; break; }
    }
  }
  if (!hit) {
    hideRedactTabSoon(viewer);
    return;
  }
  let state = st;
  if (!state) {
    const el = /** @type {HTMLSpanElement} */ (document.createElement('span'));
    el.className = 'scribe-redact-tab';
    el.textContent = 'Preview';
    el.addEventListener('mouseenter', () => {
      const s = viewer._redactTab;
      if (!s) return;
      clearTimeout(s.hideT);
      setRedactPreview(viewer, s.groupId, true);
    });
    el.addEventListener('mouseleave', () => {
      const s = viewer._redactTab;
      if (!s || s.pinned) return;
      setRedactPreview(viewer, s.groupId, false);
      hideRedactTabSoon(viewer);
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = viewer._redactTab;
      if (!s) return;
      s.pinned = !s.pinned;
      el.classList.toggle('pinned', s.pinned);
      // The pointer is on the tab mid-click, so the hover preview stays on either way.
      setRedactPreview(viewer, s.groupId, true);
    });
    state = {
      el, n: -1, groupId: '', left: 0, top: 0, hideT: 0, pinned: false, on: false,
    };
    viewer._redactTab = state;
  }
  clearTimeout(state.hideT);
  // Anchor to the group's top rect, not the hovered one: otherwise the single tab would hop line to line as the pointer moves through a multi-line group's per-line rects.
  let anchor = hit;
  for (const annot of pageRedactions(viewer, pt.n)) {
    if (annot.groupId !== hit.groupId) continue;
    if (annot.bbox.top < anchor.bbox.top
      || (annot.bbox.top === anchor.bbox.top && annot.bbox.left < anchor.bbox.left)) anchor = annot;
  }
  const moved = state.n !== pt.n || state.groupId !== anchor.groupId
    || state.left !== anchor.bbox.left || state.top !== anchor.bbox.top;
  if (!moved && state.el.isConnected) return;
  // Moving to a different group takes any active hover preview along.
  if (state.on && state.groupId !== anchor.groupId) setRedactPreview(viewer, state.groupId, false);
  state.n = pt.n;
  state.groupId = anchor.groupId;
  state.left = anchor.bbox.left;
  state.top = anchor.bbox.top;
  // Position the tab flush against the mark's top-left corner (CSS lifts it to sit just above the top edge).
  state.el.style.left = `${anchor.bbox.left}px`;
  state.el.style.top = `${anchor.bbox.top}px`;
  const tabGroup = viewer.getRedactTabGroup(pt.n);
  if (tabGroup && state.el.parentElement !== tabGroup) tabGroup.appendChild(state.el);
}
