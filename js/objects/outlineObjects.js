/**
 * A PDF document outline (bookmarks) as an editable tree.
 *
 * Destinations are stored as zero-based page indices into the current page order (the same convention as `pageMetrics.sourcePageN`),
 * so page edits only remap indices instead of tracking PDF object numbers.
 *
 * `doc.outline` is an array of top-level nodes, empty when the document has no bookmarks.
 *
 * @typedef {Object} OutlineDest
 * @property {number} pageIndex - Zero-based page index into the current page order.
 * @property {Array<string|number|null>} view - Raw PDF destination tail after the page ref (e.g. `['XYZ', -4, 796, 0]`), preserved verbatim.
 * @property {number} [yFrac] - Vertical target as a fraction of the visual page height from the top, in [0, 1].
 *   Absent when `view` carries no usable vertical position (e.g. `['Fit']`).
 *
 * @typedef {Object} OutlineNode
 * @property {number} id - Stable per-document node id for the editing UI and undo/redo.
 * @property {string} title
 * @property {?OutlineDest} dest - Internal page target, or null for a structural, URI, or title-only node.
 * @property {?string} action - Opaque PDF action string for a non-GoTo bookmark (URI or remote GoToR), re-emitted verbatim on write.
 * @property {boolean} open - Expanded state, a UI hint set from the `/Count` sign on parse.
 * @property {Array<OutlineNode>} children
 */

let idCounter = 0;

/** @returns {number} A fresh node id, unique within this module's lifetime. */
function nextOutlineId() { idCounter += 1; return idCounter; }

/**
 * Create an OutlineNode with a fresh id, filling unspecified fields with defaults.
 * @param {Partial<OutlineNode>} [props]
 * @returns {OutlineNode}
 */
export function makeOutlineNode({
  title = '', dest = null, action = null, open = true, children = [],
} = {}) {
  return {
    id: nextOutlineId(), title, dest, action, open, children,
  };
}

/**
 * Assign a fresh id to every node so an incoming outline has ids unique within this module's counter.
 * The ids may come from another counter, such as the parse worker's separate module instance.
 * Mutates in place and returns the same array.
 * @param {Array<OutlineNode>} nodes
 * @returns {Array<OutlineNode>}
 */
export function reassignOutlineIds(nodes) {
  for (const node of nodes) {
    node.id = nextOutlineId();
    reassignOutlineIds(node.children);
  }
  return nodes;
}

/**
 * Deep-clone an outline tree (for history snapshots and non-mutating transforms), preserving ids.
 * @param {Array<OutlineNode>} nodes
 * @returns {Array<OutlineNode>}
 */
export function cloneOutline(nodes) {
  return nodes.map((n) => ({
    id: n.id,
    title: n.title,
    dest: n.dest ? { pageIndex: n.dest.pageIndex, view: [...n.dest.view], yFrac: n.dest.yFrac } : null,
    action: n.action,
    open: n.open,
    children: cloneOutline(n.children),
  }));
}

/**
 * Remap every destination's page index through `map`.
 * A node whose page maps to `null` is dropped, but its surviving descendants are promoted to the nearest surviving ancestor rather than lost with it.
 * A node with no page destination (structural or URI/action) always survives.
 * Pure: returns a new tree with ids preserved.
 * @param {Array<OutlineNode>} nodes
 * @param {(oldIndex: number) => (number|null)} map
 * @returns {Array<OutlineNode>}
 */
export function remapOutline(nodes, map) {
  const out = [];
  for (const n of nodes) {
    const children = remapOutline(n.children, map);
    if (n.dest == null) {
      out.push({
        id: n.id, title: n.title, dest: null, action: n.action, open: n.open, children,
      });
      continue;
    }
    const ni = map(n.dest.pageIndex);
    if (ni == null) {
      out.push(...children); // page gone: drop this node, promote its surviving descendants
    } else {
      out.push({
        id: n.id, title: n.title, dest: { pageIndex: ni, view: [...n.dest.view], yFrac: n.dest.yFrac }, action: n.action, open: n.open, children,
      });
    }
  }
  return out;
}

/**
 * Build a `remapOutline` map from a page-selection array: `pageArr[k]` is the old page index placed at output position `k`.
 * Old indices absent from `pageArr` map to null (dropped). A repeated old index maps to its first output position.
 * @param {Array<number>} pageArr
 * @returns {(oldIndex: number) => (number|null)}
 */
export function pageArrIndexMap(pageArr) {
  const m = new Map();
  for (let k = 0; k < pageArr.length; k += 1) if (!m.has(pageArr[k])) m.set(pageArr[k], k);
  return (old) => (m.has(old) ? m.get(old) : null);
}

/**
 * Shift every destination's page index by `delta` (no drops).
 * @param {Array<OutlineNode>} nodes
 * @param {number} delta
 * @returns {Array<OutlineNode>}
 */
export function offsetOutline(nodes, delta) {
  return remapOutline(nodes, (old) => old + delta);
}

/**
 * Locate a node by id, returning its sibling array and index alongside it so callers can detach or reparent it in place.
 * @param {Array<OutlineNode>} nodes
 * @param {number} id
 * @returns {?{ node: OutlineNode, siblings: Array<OutlineNode>, index: number }}
 */
export function findOutlineEntry(nodes, id) {
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].id === id) return { node: nodes[i], siblings: nodes, index: i };
    const found = findOutlineEntry(nodes[i].children, id);
    if (found) return found;
  }
  return null;
}

/**
 * Whether `id` is `node` itself or anywhere in its subtree.
 * @param {OutlineNode} node
 * @param {number} id
 * @returns {boolean}
 */
export function isOutlineDescendant(node, id) {
  if (node.id === id) return true;
  return node.children.some((c) => isOutlineDescendant(c, id));
}

/**
 * Concatenate several outlines into one, offsetting each part's destinations by its page offset.
 * A `wrapperTitle` nests that part under one titled top-level node, so each source document becomes a single top-level bookmark.
 * @param {Array<{ nodes: Array<OutlineNode>, pageOffset: number, wrapperTitle?: string }>} parts
 * @returns {Array<OutlineNode>}
 */
export function concatOutlines(parts) {
  const out = [];
  for (const part of parts) {
    const shifted = offsetOutline(part.nodes || [], part.pageOffset);
    if (part.wrapperTitle != null) {
      out.push({
        id: 0,
        title: part.wrapperTitle,
        dest: { pageIndex: part.pageOffset, view: ['Fit'] },
        action: null,
        open: true,
        children: shifted,
      });
    } else {
      out.push(...shifted);
    }
  }
  return reassignOutlineIds(out);
}

/**
 * Divide a document into contiguous page segments at each top-level bookmark, for "split at bookmarks".
 * A top-level bookmark starts a new segment at the earliest destination page in its subtree, so a title-only parent inherits the first destination among its descendants.
 * Two top-level bookmarks sharing a start page collapse to one segment (a split can't cut mid-page).
 * @param {Array<OutlineNode>} nodes - The document outline (top-level nodes).
 * @param {number} pageCount - Total pages in the document.
 * @param {string} [leadTitle] - Title for the pages-before-the-first-bookmark segment.
 * @returns {Array<{ title: string, pageArr: Array<number> }>} One entry per output document, in page order.
 *   `pageArr` is that segment's contiguous 0-based page indices.
 *   Fewer than 2 entries means there is nothing to split.
 */
export function outlineSplitSegments(nodes, pageCount, leadTitle = 'Front matter') {
  const earliestDest = (node) => {
    let min = node.dest ? node.dest.pageIndex : null;
    for (const c of node.children) {
      const cm = earliestDest(c);
      if (cm != null && (min == null || cm < min)) min = cm;
    }
    return min;
  };
  const titleByCut = new Map(); // start page -> title; the first bookmark on a shared page wins
  for (const n of nodes) {
    const start = earliestDest(n);
    if (start != null && start >= 0 && start < pageCount && !titleByCut.has(start)) titleByCut.set(start, n.title || '');
  }
  const cuts = [...titleByCut.keys()].sort((a, b) => a - b);
  if (cuts.length === 0) return [];

  const range = (s, e) => Array.from({ length: e - s }, (_, k) => s + k);
  const segments = [];
  if (cuts[0] > 0) segments.push({ title: leadTitle, pageArr: range(0, cuts[0]) });
  for (let i = 0; i < cuts.length; i += 1) {
    const end = i + 1 < cuts.length ? cuts[i + 1] : pageCount;
    segments.push({ title: titleByCut.get(cuts[i]) || leadTitle, pageArr: range(cuts[i], end) });
  }
  return segments;
}
