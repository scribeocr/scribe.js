import { toUtf16BeHex } from '../../pdf/pdfPrimitives.js';

/**
 * Serialize an outline (bookmark) tree into PDF `/Outlines` objects, shared by every terminal write path.
 * The caller pre-maps destinations to output page objects, so a bookmark's `/Dest` stays correct across subset/reorder/merge.
 *
 * @param {Array<import('../../objects/outlineObjects.js').OutlineNode>} nodes - Top-level outline nodes
 *   (already remapped to the output page order).
 * @param {Array<number>} pageObjNumByIndex - Output page index -> page object number in the output PDF.
 * @param {number} startObjNum - First object number the writer may allocate.
 * @returns {?{ objects: Array<{ objNum: number, content: string }>, rootObjNum: number, nextObjNum: number }}
 *   The outline objects (order is arbitrary), the `/Outlines` root object number to reference from the catalog, and the next free object number.
 *   Null when there is nothing to write.
 */
export function buildOutlineObjects(nodes, pageObjNumByIndex, startObjNum) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  // Pre-order object-number assignment: root, then each node depth-first.
  let next = startObjNum;
  const rootObjNum = next;
  next += 1;
  const assign = (list) => list.map((node) => {
    const objNum = next;
    next += 1;
    return { node, objNum, children: assign(node.children) };
  });
  const tree = assign(nodes);

  const objects = [];
  const emitSiblings = (entries, parentObjNum) => {
    for (let k = 0; k < entries.length; k += 1) {
      const e = entries[k];
      let dict = `<</Title <${toUtf16BeHex(e.node.title || '')}>/Parent ${parentObjNum} 0 R`;
      if (k > 0) dict += `/Prev ${entries[k - 1].objNum} 0 R`;
      if (k < entries.length - 1) dict += `/Next ${entries[k + 1].objNum} 0 R`;
      if (e.children.length) {
        const count = visibleCount(e.node.children);
        dict += `/First ${e.children[0].objNum} 0 R/Last ${e.children[e.children.length - 1].objNum} 0 R/Count ${e.node.open ? count : -count}`;
      }
      const pageObjNum = e.node.dest ? pageObjNumByIndex[e.node.dest.pageIndex] : undefined;
      if (pageObjNum != null) {
        dict += `/Dest[${pageObjNum} 0 R${viewToPdf(e.node.dest.view)}]`;
      } else if (e.node.action) {
        dict += `/A ${e.node.action}`;
      }
      dict += '>>';
      objects.push({ objNum: e.objNum, content: `${e.objNum} 0 obj\n${dict}\nendobj\n\n` });
      if (e.children.length) emitSiblings(e.children, e.objNum);
    }
  };
  emitSiblings(tree, rootObjNum);

  const rootCount = visibleCount(nodes);
  objects.push({
    objNum: rootObjNum,
    content: `${rootObjNum} 0 obj\n<</Type/Outlines/First ${tree[0].objNum} 0 R/Last ${tree[tree.length - 1].objNum} 0 R/Count ${rootCount}>>\nendobj\n\n`,
  });

  return { objects, rootObjNum, nextObjNum: next };
}

/** Number of items visible when the given sibling list is shown, recursing only into open nodes. */
function visibleCount(nodes) {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.open) count += visibleCount(node.children);
  }
  return count;
}

/**
 * Render a destination view tail (e.g. `['XYZ', -4, 796, 0]`) as the PDF text after the page ref.
 * @param {Array<string|number|null>} view - Empty or non-array yields the `/Fit` default.
 * @returns {string}
 */
function viewToPdf(view) {
  if (!Array.isArray(view) || view.length === 0) return ' /Fit';
  return ` ${view.map((v, i) => (i === 0 ? `/${v}` : (v === null ? 'null' : String(v)))).join(' ')}`;
}
