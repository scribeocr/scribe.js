// Bookmarks (document outline) side panel, a sibling of the page-thumbnails rail.
// Renders scribe.doc.outline as a navigable tree: clicking a bookmark jumps to its destination.
// Rows are text-first, like a book's table of contents: hierarchy comes from indentation and type (top-level entries semibold, title-only parents as section labels), not per-row icons.
import { makeIconButton } from './toolbar.js';
import { detectHeadingBookmarks, nestHeadingOutline } from '../../../js/objects/outlineObjects.js';

// A bookmark-ribbon glyph for the toolbar toggle (also the view's tab in the unified sidebar's switch strip).
export const BOOKMARK_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><path d="M4 2a1 1 0 0 0-1 1v11l5-3 5 3V3a1 1 0 0 0-1-1H4z"/></svg>';
// Disclosure chevron for expandable rows, stroked to match the toolbar's icon language.
// Points right when collapsed.
// The `.open` class rotates it to point down.
const TWISTY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
// Plus glyph for the header's persistent add button.
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
// The Automate identity glyph, marking controls that open that panel.
// Copied rather than imported because the panel module is load-gated, and importing it here would defeat that.
const AUTOMATE_GLYPH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M5 7.2l5.6 4.8L5 16.8z"/><path d="M14 7.5h5.5M14 12h5.5M14 16.5h3.5"/></svg>';
// The Generate-bookmarks tool icon, copied from the automation registry for the direct-run button that off builds keep.
const GEN_HEADINGS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M5 4.5h6.2v14.6l-3.1-2.3-3.1 2.3z"/><path d="M14.8 7.5h4.7M14.8 12h4.7M14.8 16.5h3.2"/></svg>';
const DOTS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01"/></svg>';
// A touch press-drag scrolls the list, so a touch drag arms only after a still press this long.
const LIFT_HOLD_MS = 250;
const MENU_HOLD_MS = 350;
const INDENT_PX = 21;

/** @typedef {import('../../../js/objects/outlineObjects.js').OutlineNode} OutlineNode */

/**
 * A press on a row that may still become a drag: a mouse press promotes once the pointer moves, a touch press once it holds still.
 * @typedef {Object} BookmarkDragPress
 * @property {number} id - The pressed node's id.
 * @property {OutlineNode} node
 * @property {HTMLElement} row - The pressed row, which the drag lifts from.
 * @property {number} x - Pointer clientX at the press.
 * @property {number} y - Pointer clientY at the press.
 * @property {?ReturnType<typeof setTimeout>} holdT - Hold-to-lift timer, null on a mouse press and once the hold has fired.
 * @property {boolean} touch - Whether the press came from touch.
 */

/**
 * One visible row a drag can drop against, in the tree's pre-drag layout coordinates.
 * @typedef {Object} BookmarkDragEntry
 * @property {OutlineNode} node
 * @property {number} depth
 * @property {Array<OutlineNode>} chain - `chain[k]` is the ancestor at depth k.
 * @property {HTMLElement} elem - The rendered row.
 * @property {number} top
 * @property {number} bottom
 */

/**
 * Where a drag would land: a gap between visible rows, at the depth the pointer's x has chosen.
 * @typedef {Object} BookmarkDropTarget
 * @property {?OutlineNode} parent - The node the row would nest under, null at top level.
 * @property {number} atIndex - Insertion index among the parent's children, with the dragged node removed.
 * @property {number} depth - The chosen depth, clamped to the legal range.
 * @property {number} minDepth - Shallowest depth legal for this gap.
 * @property {number} maxDepth - Deepest depth legal for this gap.
 * @property {number} lineTop - The gap's y in the pre-drag layout.
 */

/**
 * A live row drag: the lifted card, the slot it would settle into, and the pre-drag geometry the hit tests run against.
 * @typedef {Object} BookmarkDrag
 * @property {number} id - The dragged node's id.
 * @property {OutlineNode} node
 * @property {Array<BookmarkDragEntry>} entries - Every visible row except the dragged one and its subtree.
 * @property {?BookmarkDropTarget} drop - Where the drag would land, null until the first pointer move.
 * @property {HTMLElement} srcRow - The row the drag lifted from.
 * @property {?OutlineNode} adoptNode - The node currently marked as the adopting parent.
 * @property {?HTMLElement} adoptElem - That node's row.
 * @property {number} lastX - Last pointer clientX, so edge auto-scroll can re-derive the drop under a still pointer.
 * @property {number} lastY
 * @property {number} scrollRaf - Edge auto-scroll animation-frame handle.
 * @property {HTMLElement} srcWrapper - The source row's wrapper, which spans its subtree.
 * @property {number} srcTop - The wrapper's offsetTop before the lift.
 * @property {number} srcH - The wrapper's height, the span the lift removes.
 * @property {number} srcRowH - The row's own height, the gap the card opens.
 * @property {number} grabDY - Offset of the grab point within the row.
 * @property {number} pressX - Pointer clientX at the press, the origin for depth travel.
 * @property {number} ownDepth - The dragged row's depth at the press.
 * @property {HTMLElement} cloneElem - The row copy inside the card.
 * @property {number} treeLeft - The tree's left edge, relative to the panel.
 * @property {number} treeW - The tree's width.
 * @property {HTMLElement} ghostElem - The floating card tracking the pointer.
 * @property {HTMLElement} railsElem - Container for the legal-depth rails.
 * @property {string} railsKey - The depth range the rails were last built for.
 * @property {HTMLElement} plateElem - Marker for the slot the card will settle into.
 * @property {boolean} armed - True while the card is parked over its own slot awaiting a grab.
 */

/**
 * Create the bookmarks (document outline) side panel.
 * @param {*} scribe - The ScribeViewer instance.
 * @param {{ onNavigate: (dest: { pageIndex: number, yFrac?: number }) => void, onResize?: (width: number, phase: 'start'|'move'|'end') => void,
 *   onRenameFocus?: (focused: boolean) => void, onMoveSession?: (active: boolean) => void }} handlers
 *   `onNavigate` receives the clicked bookmark's whole destination, so the host can honor its within-page position (`yFrac`), not just the page.
 *   `onResize` fires as the right-edge handle is dragged, with the desired width and the drag phase: `start` (pointerdown), `move` (each pointermove), and `end` (release).
 *   `onRenameFocus` fires as an inline rename takes and releases focus, so a phone host can lift the sheet clear of the on-screen keyboard.
 *   `onMoveSession` fires as the phone Move session starts and ends, so the host can swap the sheet header for the session bar.
 * @returns {{ panelElem: HTMLDivElement, toggleElem: HTMLSpanElement, rebuild: () => void,
 * setActive: () => void, setVisible: (v: boolean) => void, destroy: () => void,
 * addAtPage: (pageIndex?: number) => void, setPhoneMode: (on: boolean) => void, endMoveSession: () => void }}
 */
export function createBookmarksPanel(scribe, {
  onNavigate, onResize, onRenameFocus, onMoveSession,
}) {
  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-bookmarks-panel';
  panelElem.style.width = '240px';
  panelElem.tabIndex = -1;

  // A header bar (uppercase title + persistent add button) sits above the tree in editor mode, giving "add a bookmark" a home that stays put whether the list is empty or full.
  const headerElem = document.createElement('div');
  headerElem.className = 'scribe-bm-hd';
  const headerTitle = document.createElement('span');
  headerTitle.className = 'scribe-bm-hd-title';
  headerTitle.textContent = 'Bookmarks';
  const addElem = document.createElement('button');
  addElem.type = 'button';
  addElem.className = 'scribe-bm-add';
  addElem.title = 'Add bookmark at current page';
  addElem.setAttribute('aria-label', 'Add bookmark at current page');
  addElem.innerHTML = PLUS_SVG;
  addElem.addEventListener('click', () => addBookmarkAtPage());
  headerElem.append(headerTitle, addElem);
  panelElem.appendChild(headerElem);

  const treeElem = document.createElement('div');
  treeElem.className = 'scribe-bm-tree';
  panelElem.appendChild(treeElem);

  // Right-edge drag handle, mirroring the thumbnail rail's, so the sidebar is resizable from either view. The drag reports the desired width to the host via onResize.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'scribe-bm-resize';
  panelElem.appendChild(resizeHandle);

  // Reused context menu (mounted on the viewer root so the panel's overflow does not clip it).
  const menuElem = document.createElement('div');
  menuElem.className = 'scribe-bm-menu';
  menuElem.style.display = 'none';
  (scribe.outerElem || panelElem).appendChild(menuElem);

  const toggleElem = makeIconButton('Bookmarks', BOOKMARK_SVG);

  let activeRow = /** @type {?Element} */ (null);
  let visible = false;
  let phoneMode = false;
  let moveSession = false;
  /** @type {?HTMLElement} */
  let menuSubjectRow = null;
  // Bookmark node ids selected for a bulk action.
  const selected = new Set();
  const editing = () => !!(scribe.opt && scribe.opt.enablePageEditing);
  const currentPage = () => (scribe.state && scribe.state.cp ? scribe.state.cp.n : 0);
  const outline = () => (scribe.doc && scribe.doc.outline) || [];
  /**
   * Whether a real document is loaded.
   * `scribe.doc` is an empty ScribeDoc with 0 pages when nothing is open, so its presence alone is not enough.
   * @returns {boolean}
   */
  const hasDoc = () => !!(scribe.doc && scribe.doc.pageMetrics && scribe.doc.pageMetrics.length);

  /**
   * Walk the outline for the node with `id`, returning its location among its siblings.
   * @param {?number} id - Null for the parent of a top-level node, which has no entry to find.
   * @returns {{ node: OutlineNode, parentId: ?number, index: number, siblings: Array<OutlineNode>, grandparentId: ?number }|null}
   */
  function context(id) {
    const search = (nodes, parentId, grandparentId) => {
      for (let i = 0; i < nodes.length; i += 1) {
        if (nodes[i].id === id) {
          return {
            node: nodes[i], parentId, index: i, siblings: nodes, grandparentId,
          };
        }
        const found = search(nodes[i].children, nodes[i].id, parentId);
        if (found) return found;
      }
      return null;
    };
    return search(outline(), null, null);
  }

  function closeMenu() {
    menuElem.style.display = 'none';
    menuElem.textContent = '';
    if (menuSubjectRow) { menuSubjectRow.classList.remove('scribe-bm-menu-subject'); menuSubjectRow = null; }
  }

  /** Start the phone Move session, which makes a still press lift rows instead of opening the row menu. */
  function startMoveSession() {
    if (moveSession) return;
    moveSession = true;
    if (onMoveSession) onMoveSession(true);
  }

  /** End the phone Move session, setting down whatever card is in hand. */
  function endMoveSession() {
    if (!moveSession) return;
    moveSession = false;
    if (drag) onDragEnd(new PointerEvent('pointerup'));
    if (onMoveSession) onMoveSession(false);
  }

  /**
   * Show the reused context menu at viewport point (x, y), positioned within the host.
   * @param {number} x - Viewport x coordinate to place the menu at.
   * @param {number} y - Viewport y coordinate to place the menu at.
   */
  function showMenuAt(x, y) {
    menuElem.style.display = 'block';
    const host = (scribe.outerElem || panelElem).getBoundingClientRect();
    menuElem.style.left = `${x - host.left}px`;
    menuElem.style.top = `${y - host.top}px`;
  }

  /**
   * Add a top-level bookmark at `pageIndex` (default: the current page) and drop the new row straight into rename.
   * @param {number} [pageIndex]
   */
  function addBookmarkAtPage(pageIndex = currentPage()) {
    if (!hasDoc()) return;
    const top = outline();
    let atIndex = top.length;
    for (let i = 0; i < top.length; i += 1) {
      if (top[i].dest && top[i].dest.pageIndex > pageIndex) { atIndex = i; break; }
    }
    const id = scribe.doc.addBookmark({ title: 'New bookmark', pageIndex, atIndex });
    afterEdit();
    focusRename(id);
  }

  /**
   * Show the empty-space context menu at viewport point (x, y), offering to add a bookmark at the current page (editor-only).
   * @param {number} x - Viewport x coordinate for the menu.
   * @param {number} y - Viewport y coordinate for the menu.
   */
  function openAddMenu(x, y) {
    menuElem.textContent = '';
    const item = document.createElement('div');
    item.className = 'scribe-bm-menu-item';
    item.textContent = 'Add bookmark at current page';
    item.addEventListener('click', () => { closeMenu(); addBookmarkAtPage(); });
    menuElem.appendChild(item);
    appendGenerateMenuRow();
    showMenuAt(x, y);
  }

  /**
   * Append the Automate hand-off row ("Generate from headings…") to the open menu, behind a separator.
   * @returns {boolean} Whether the row was added.
   */
  function appendGenerateMenuRow() {
    if (!automateHandOffAvailable() || !scribe.doc || detectHeadingBookmarks(scribe.doc).length < 3) return false;
    const sep = document.createElement('div');
    sep.className = 'scribe-bm-menu-sep';
    menuElem.appendChild(sep);
    const item = document.createElement('div');
    item.className = 'scribe-bm-menu-item scribe-bm-menu-hand';
    const label = document.createElement('span');
    label.textContent = 'Generate from headings…';
    const glyph = document.createElement('span');
    glyph.className = 'scribe-bm-autoglyph';
    glyph.innerHTML = AUTOMATE_GLYPH_SVG;
    item.append(label, glyph);
    item.addEventListener('click', () => { closeMenu(); scribe._automatePanel.launchAutomation('generate-bookmarks'); });
    menuElem.appendChild(item);
    return true;
  }

  /** Begin inline rename of a bookmark row, committing to doc.renameBookmark on Enter/blur. */
  function startRename(node, labelElem) {
    const input = document.createElement('input');
    input.className = 'scribe-bm-rename';
    if (labelElem.classList.contains('structural')) input.classList.add('structural');
    input.value = node.title;
    labelElem.replaceWith(input);
    input.focus();
    input.select();
    // iOS decides its small-input zoom at focus, so the row-sized font goes on only after focus() returns.
    input.classList.add('scribe-bm-rename-live');
    if (onRenameFocus) onRenameFocus(true);
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (onRenameFocus) onRenameFocus(false);
      if (save && input.value !== node.title) { scribe.doc.renameBookmark(node.id, input.value); afterEdit(); } else rebuild();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }

  /**
   * Open the per-row edit menu at the pointer, populated with the operations valid for `node`.
   * @param {*} node - Outline node the menu operates on.
   * @param {number} x - Pointer x coordinate to anchor the menu.
   * @param {number} y - Pointer y coordinate to anchor the menu.
   * @param {HTMLElement} labelElem - The row's label element, replaced during inline rename.
   */
  function openMenu(node, x, y, labelElem) {
    menuElem.textContent = '';
    const ctx = context(node.id);
    const add = (label, enabled, fn) => {
      const item = document.createElement('div');
      item.className = 'scribe-bm-menu-item';
      item.textContent = label;
      if (!enabled) item.classList.add('disabled');
      else item.addEventListener('click', () => { closeMenu(); fn(); });
      menuElem.appendChild(item);
    };
    add('Rename', true, () => startRename(node, labelElem));
    add('Set to current page', true, () => { scribe.doc.setBookmarkDest(node.id, currentPage()); afterEdit(); });
    add('Add sub-bookmark here', true, () => {
      const id = scribe.doc.addBookmark({ title: 'New bookmark', pageIndex: currentPage(), parentId: node.id });
      node.open = true; afterEdit(); focusRename(id);
    });
    add('Move up', !!ctx && ctx.index > 0, () => { scribe.doc.moveBookmark(node.id, ctx.parentId, ctx.index - 1); afterEdit(); });
    add('Move down', !!ctx && ctx.index < ctx.siblings.length - 1, () => { scribe.doc.moveBookmark(node.id, ctx.parentId, ctx.index + 1); afterEdit(); });
    add('Indent (nest under previous)', !!ctx && ctx.index > 0, () => { scribe.doc.moveBookmark(node.id, ctx.siblings[ctx.index - 1].id, null); afterEdit(); });
    add('Outdent', !!ctx && ctx.parentId != null, () => {
      const parent = context(ctx.parentId);
      scribe.doc.moveBookmark(node.id, ctx.grandparentId, parent ? parent.index + 1 : null); afterEdit();
    });
    if (appendGenerateMenuRow()) {
      const sep = document.createElement('div');
      sep.className = 'scribe-bm-menu-sep';
      menuElem.appendChild(sep);
    }
    add('Delete', true, () => { scribe.doc.removeBookmarks([node.id]); afterEdit(); });

    showMenuAt(x, y);
  }

  /**
   * Open the phone row menu (Rename / Move / Delete).
   * A dots tap opens a dropdown below the button; a still press opens a callout centered above the row, clear of the held finger.
   * Either placement flips to the row's other side when it would run off the sheet.
   * @param {*} node - Outline node the menu operates on.
   * @param {HTMLElement} row - The node's rendered row.
   * @param {'dots'|'hold'} [invocation]
   */
  function openPhoneRowMenu(node, row, invocation = 'dots') {
    const label = /** @type {HTMLElement} */ (row.querySelector('.scribe-bm-label'));
    const wrapper = /** @type {HTMLElement} */ (row.parentElement);
    const dots = /** @type {HTMLElement} */ (row.querySelector('.scribe-bm-dots'));
    if (!label || !dots) return;
    menuElem.textContent = '';
    const add = (text, enabled, danger, fn) => {
      const item = document.createElement('div');
      item.className = danger ? 'scribe-bm-menu-item danger' : 'scribe-bm-menu-item';
      if (!enabled) item.classList.add('disabled');
      else item.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); fn(); });
      item.textContent = text;
      menuElem.appendChild(item);
    };
    add('Rename', true, false, () => startRename(node, label));
    add('Move', allIds().length > 1, false, () => { startMoveSession(); armMove(node); });
    add('Delete', true, true, () => {
      const commit = () => { scribe.doc.removeBookmarks([node.id]); afterEdit(); };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { commit(); return; }
      wrapper.style.overflow = 'hidden';
      wrapper.style.height = `${wrapper.getBoundingClientRect().height}px`;
      wrapper.getBoundingClientRect();
      wrapper.style.transition = 'height 160ms ease, opacity 160ms ease';
      wrapper.style.height = '0';
      wrapper.style.opacity = '0';
      setTimeout(commit, 180);
    });
    menuElem.style.display = 'block';
    const host = (scribe.outerElem || panelElem).getBoundingClientRect();
    const panelRect = panelElem.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const mw = menuElem.offsetWidth;
    const mh = menuElem.offsetHeight;
    let x;
    let y;
    if (invocation === 'hold') {
      x = rowRect.left + (rowRect.width - mw) / 2;
      const above = rowRect.top - 2 - mh;
      y = above >= panelRect.top + 4 ? above : rowRect.bottom + 2;
    } else {
      const dotsRect = dots.getBoundingClientRect();
      x = dotsRect.right - mw;
      const below = dotsRect.bottom + 2;
      y = below + mh <= panelRect.bottom - 4 ? below : rowRect.top - 2 - mh;
    }
    menuElem.style.left = `${Math.max(4, x - host.left)}px`;
    menuElem.style.top = `${y - host.top}px`;
    row.classList.add('scribe-bm-menu-subject');
    menuSubjectRow = row;
  }

  /**
   * Render one outline node (and, when open, its children) as indented rows.
   * @param {{id: string, title: string, dest: {pageIndex: number, yFrac?: number}|null, children: any[], open: boolean}} node - Outline node to render.
   * @param {number} depth - Nesting depth, used to indent the row.
   * @returns {HTMLDivElement} Wrapper element holding the node's row and, when open, its rendered children.
   */
  function renderNode(node, depth) {
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'scribe-bm-row';
    row.style.paddingLeft = `${8 + depth * INDENT_PX}px`;
    row.dataset.page = node.dest ? String(node.dest.pageIndex) : '';
    if (node.dest) row.dataset.yfrac = String(typeof node.dest.yFrac === 'number' ? node.dest.yFrac : 0);
    row.dataset.id = node.id;
    if (selected.has(node.id)) row.classList.add('selected');
    // Top-level entries (class 'top') render semibold, and title-only parents (class 'structural') render as section labels.
    if (depth === 0 && node.dest) row.classList.add('top');
    if (!node.dest) row.classList.add('structural');

    const twisty = document.createElement('span');
    twisty.className = 'scribe-bm-twisty';
    if (node.children.length) {
      twisty.innerHTML = TWISTY_SVG;
      twisty.classList.toggle('open', node.open);
      twisty.addEventListener('click', (e) => { e.stopPropagation(); node.open = !node.open; rebuild(); });
    }
    row.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'scribe-bm-label';
    label.textContent = node.title || '(untitled)';
    if (!node.dest) label.classList.add('structural');
    row.appendChild(label);

    if (node.dest) {
      const pageBadge = document.createElement('span');
      pageBadge.className = 'scribe-bm-page';
      pageBadge.textContent = String(node.dest.pageIndex + 1);
      row.appendChild(pageBadge);
    }
    if (phoneMode && editing()) {
      const dots = document.createElement('button');
      dots.type = 'button';
      dots.className = 'scribe-bm-dots';
      dots.title = 'Bookmark actions';
      dots.setAttribute('aria-label', 'Bookmark actions');
      dots.innerHTML = DOTS_SVG;
      dots.addEventListener('click', (e) => {
        e.stopPropagation();
        openPhoneRowMenu(node, row);
      });
      row.appendChild(dots);
    }

    row.addEventListener('click', (e) => {
      if (consumeDragClick()) return;
      if (phoneMode && editing()) {
        if (lastTap.id === node.id && Date.now() - lastTap.t < 400) {
          lastTap.id = null;
          startRename(node, label);
        } else {
          lastTap.id = node.id;
          lastTap.t = Date.now();
          if (node.dest) onNavigate(node.dest);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) { toggleSelect(node.id); return; }
      clearSelection();
      if (node.dest) onNavigate(node.dest);
      else if (node.children.length) { node.open = !node.open; rebuild(); }
    });
    row.addEventListener('dblclick', () => {
      if (phoneMode && editing()) return;
      if (node.dest) onNavigate(node.dest);
      if (node.children.length && !node.open) { node.open = true; rebuild(); }
    });
    if (editing()) {
      // A phone long-press fires contextmenu, which would pop this menu over the row as it lifts into a drag.
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (phoneMode) return;
        openMenu(node, e.clientX, e.clientY, label);
      });
      row.addEventListener('pointerdown', (e) => beginRowDrag(e, node, row));
    }

    wrapper.appendChild(row);
    if (node.children.length && node.open) {
      const kids = document.createElement('div');
      for (const c of node.children) kids.appendChild(renderNode(c, depth + 1));
      wrapper.appendChild(kids);
    }
    return wrapper;
  }

  function rebuild() {
    closeMenu();
    // The header (with its persistent add button) shows only in editor mode with a document open.
    // Without a header the tree melds to the panel top.
    const showHeader = editing() && hasDoc();
    headerElem.style.display = showHeader ? '' : 'none';
    panelElem.classList.toggle('scribe-bm-has-header', showHeader);
    treeElem.textContent = '';
    activeRow = null;
    const nodes = outline();
    if (nodes.length === 0) {
      // No document loaded -> nothing to bookmark, so leave the panel blank (not even "No bookmarks yet"), matching the thumbnail rail, which is also empty before a document is open.
      if (!hasDoc()) return;
      if (!editing()) {
        const empty = document.createElement('div');
        empty.className = 'scribe-bm-empty';
        empty.textContent = 'No bookmarks.';
        treeElem.appendChild(empty);
        return;
      }
      treeElem.appendChild(buildEmptyEditorState());
      return;
    }
    for (const node of nodes) treeElem.appendChild(renderNode(node, 0));
    applyActive();
  }

  /**
   * Build the empty state shown when an editor opens a document with no bookmarks.
   * @returns {HTMLDivElement}
   */
  function buildEmptyEditorState() {
    const empty = document.createElement('div');
    empty.className = 'scribe-bm-empty scribe-bm-empty-editor';
    const msg = document.createElement('div');
    msg.className = 'scribe-bm-empty-msg';
    msg.textContent = 'No bookmarks in this document yet.';
    empty.appendChild(msg);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'scribe-bm-empty-btn';
    addBtn.textContent = 'Add bookmark';
    addBtn.addEventListener('click', () => addBookmarkAtPage());
    empty.appendChild(addBtn);
    const headings = scribe.doc ? detectHeadingBookmarks(scribe.doc) : [];
    if (headings.length >= 3) {
      const genBtn = document.createElement('button');
      genBtn.type = 'button';
      genBtn.className = 'scribe-bm-empty-btn';
      const hint = document.createElement('div');
      hint.className = 'scribe-bm-empty-hint';
      if (automateHandOffAvailable()) {
        genBtn.innerHTML = `<span>Generate from headings…</span><span class="scribe-bm-autoglyph">${AUTOMATE_GLYPH_SVG}</span>`;
        genBtn.addEventListener('click', () => scribe._automatePanel.launchAutomation('generate-bookmarks'));
        hint.textContent = 'Runs in Automate — uses the headings this app already finds. You can edit or undo the result.';
      } else {
        genBtn.innerHTML = `${GEN_HEADINGS_SVG}<span>Generate from headings</span>`;
        genBtn.addEventListener('click', () => generateFromHeadings());
        hint.textContent = 'Uses the headings this app already finds in the layout. You can edit or undo the result.';
      }
      empty.appendChild(genBtn);
      empty.appendChild(hint);
    } else {
      watchTextReady();
    }
    return empty;
  }

  /**
   * Whether "Generate from headings" should hand off to the Automate panel rather than run directly.
   * Phone layouts keep the direct path because the Automate panel is desktop-only.
   */
  function automateHandOffAvailable() {
    return !phoneMode && !!scribe._automatePanel?.automations;
  }

  // Text extraction is deferred on load, so the headings may not exist yet the first time the empty state renders.
  const textReadyWatched = new WeakSet();
  function watchTextReady() {
    const doc = scribe.doc;
    if (!doc || !doc.textReady || textReadyWatched.has(doc)) return;
    if (!doc.inputData || doc.inputData.pdfType !== 'text') return;
    textReadyWatched.add(doc);
    doc.textReady.then(() => { if (scribe.doc === doc && visible) rebuild(); }).catch(() => {});
  }

  /** Replace the outline with bookmarks built from the document's detected headings. */
  function generateFromHeadings() {
    const headings = detectHeadingBookmarks(scribe.doc);
    if (!headings.length) return;
    const nodes = nestHeadingOutline(headings);
    const prev = scribe.doc.replaceOutline(nodes);
    afterEdit();
    if (scribe._onDestructiveAction) {
      scribe._onDestructiveAction(
        `Added ${headings.length} bookmark${headings.length === 1 ? '' : 's'} from document headings.`,
        () => { scribe.doc.replaceOutline(prev); afterEdit(); },
      );
    }
  }

  /** Re-render after an edit. The doc verbs already recorded it for undo/redo. */
  function afterEdit() { rebuild(); }

  /**
   * After an add, scroll the new row into view and put it straight into rename mode.
   * @param {number} id The new bookmark node's id.
   */
  function focusRename(id) {
    const row = treeElem.querySelector(`.scribe-bm-row[data-id="${id}"]`);
    const label = row && row.querySelector('.scribe-bm-label');
    const ctx = context(id);
    if (!row || !label || !ctx) return;
    row.scrollIntoView({ block: 'nearest' });
    startRename(ctx.node, label);
  }

  // Right-click the tree's empty space to add a top-level bookmark.
  treeElem.addEventListener('contextmenu', (e) => {
    if (!editing() || !hasDoc()) return;
    if (e.target instanceof Element && e.target.closest('.scribe-bm-row')) return;
    e.preventDefault();
    if (phoneMode) return;
    openAddMenu(e.clientX, e.clientY);
  });
  // Capture phase on the document, so a press anywhere outside dismisses the menu even when the press target's own handler stops propagation.
  // The click leg covers keyboard-activated controls.
  /** @param {Event} e */
  const dismissMenu = (e) => {
    if (menuElem.style.display !== 'none' && !menuElem.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  document.addEventListener('pointerdown', dismissMenu, true);
  document.addEventListener('click', dismissMenu, true);
  // Swallowing the press keeps a tap-away from also starting a row press on whatever it landed on.
  /** @param {PointerEvent} e */
  const armedPress = (e) => {
    if (!drag || !drag.armed || drag.ghostElem.contains(/** @type {Node} */ (e.target))) return;
    e.stopPropagation();
    onDragEnd(new PointerEvent('pointerup'));
  };
  document.addEventListener('pointerdown', armedPress, true);
  // preventDefault on the pointer events alone does not stop native scrolling once a lifted row owns the touch, so this listener is non-passive.
  // The listener is on the panel because a drag grabbed from a parked card starts on the ghost, which sits outside the tree.
  panelElem.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

  // Right-edge resize reports the desired width plus a drag phase ('start'/'move'/'end') to the host,
  // which owns the shared clamp/apply so this panel and the rail stay one width.
  let resizeStartX = 0;
  let resizeStartW = 0;
  function onResizeMove(e) {
    if (onResize) onResize(resizeStartW + (e.clientX - resizeStartX), 'move');
  }
  function onResizeEnd(e) {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    window.removeEventListener('pointercancel', onResizeEnd);
    if (onResize) onResize(resizeStartW + (e.clientX - resizeStartX), 'end');
  }
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizeStartX = e.clientX;
    resizeStartW = parseFloat(panelElem.style.width) || panelElem.getBoundingClientRect().width;
    if (onResize) onResize(resizeStartW, 'start');
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
    // The host stays in its drag regime until an 'end' report, so a canceled drag must deliver one too.
    window.addEventListener('pointercancel', onResizeEnd);
  });

  // Drag a row to move it: vertical position picks the slot, horizontal position picks the nesting depth.
  /** @type {?BookmarkDragPress} */
  let dragPress = null;
  /** @type {?BookmarkDrag} */
  let drag = null;
  let dragClickGuard = false;
  const lastTap = { id: null, t: 0 };

  /** Swallow the click that follows a completed drag so the drop does not also navigate. */
  function consumeDragClick() {
    const was = dragClickGuard;
    dragClickGuard = false;
    return was;
  }

  /**
   * The outline flattened to its visible rows (open branches only), excluding `excludeId` and its subtree.
   * @param {number} excludeId
   * @returns {Array<BookmarkDragEntry>}
   */
  function visibleEntries(excludeId) {
    /** @type {Array<BookmarkDragEntry>} */
    const out = [];
    const walk = (nodes, depth, chain) => {
      for (const node of nodes) {
        if (node.id === excludeId) continue;
        const elem = /** @type {?HTMLElement} */ (treeElem.querySelector(`.scribe-bm-row[data-id="${node.id}"]`));
        if (elem) {
          // offsetTop, not a live rect: the drag's gap-opening transforms displace the rows, but hit-testing must run against the pre-drag layout.
          out.push({
            node, depth, chain, elem, top: elem.offsetTop, bottom: elem.offsetTop + elem.offsetHeight,
          });
        }
        if (node.children.length && node.open) walk(node.children, depth + 1, chain.concat(node));
      }
    };
    walk(outline(), 0, []);
    return out;
  }

  /**
   * Resolve the pointer to a drop target: a gap between visible rows, at the depth chosen by x.
   * `atIndex` counts siblings with the dragged node already removed, matching how `moveBookmark` splices out before inserting.
   * @param {BookmarkDrag} dragState - The live drag.
   * @param {{clientX: number, clientY: number}} e - Pointer position (a PointerEvent, or plain coordinates at the hold-lift).
   * @returns {BookmarkDropTarget}
   */
  function computeDrop(dragState, e) {
    const {
      id, entries, srcTop, srcH, ownDepth, pressX,
    } = dragState;
    const treeRect = treeElem.getBoundingClientRect();
    const yContent = e.clientY - treeRect.top + treeElem.scrollTop;
    let gap = 0;
    // Hit-test in collapsed coordinates, with the lifted span removed, so a press anywhere inside that span maps to the row's own slot.
    const cY = yContent < srcTop ? yContent
      : (yContent < srcTop + srcH ? srcTop : yContent - srcH);
    for (const entry of entries) {
      const cTop = entry.top > srcTop ? entry.top - srcH : entry.top;
      if (cTop + (entry.bottom - entry.top) / 2 < cY) gap += 1; else break;
    }
    const above = gap > 0 ? entries[gap - 1] : null;
    const below = gap < entries.length ? entries[gap] : null;
    // Shallower than the row below would detach it from its ancestors, and deeper than one past the row above would skip a level.
    const minDepth = below ? below.depth : 0;
    const maxDepth = above ? above.depth + 1 : 0;
    // Depth is relative to the press point, one level per indent unit of travel.
    // An absolute mapping would read the press x as a deep indent and nest a lift released in place.
    const raw = ownDepth + Math.round((e.clientX - pressX) / INDENT_PX);
    const depth = Math.max(minDepth, Math.min(raw, maxDepth));

    /** @type {?OutlineNode} */
    let parent = null;
    let atIndex = 0;
    if (above) {
      if (depth === above.depth + 1) {
        parent = above.node;
      } else {
        const after = depth === above.depth ? above.node : above.chain[depth];
        parent = depth === 0 ? null : above.chain[depth - 1];
        const siblings = parent ? parent.children : outline();
        for (const sibling of siblings) {
          if (sibling.id === id) continue;
          atIndex += 1;
          if (sibling === after) break;
        }
      }
    }
    const lineTop = below ? below.top : (above ? above.bottom : 8);
    return {
      parent, atIndex, depth, minDepth, maxDepth, lineTop,
    };
  }

  /**
   * Lift the pressed row: build the floating card, depth rails, and drop plate, and capture the pre-drag geometry the hit tests run against.
   * @param {BookmarkDragPress} press
   * @returns {BookmarkDrag}
   */
  function startDrag(press) {
    const {
      id, node, row, x, y,
    } = press;
    const dragState = /** @type {BookmarkDrag} */ ({
      id,
      node,
      entries: visibleEntries(id),
      drop: null,
      srcRow: row,
      adoptNode: null,
      adoptElem: null,
      lastX: x,
      lastY: y,
      armed: false,
    });
    closeMenu();
    panelElem.classList.add('scribe-bm-dragging');
    // Pointermove stops firing while the finger parks in the edge zone, so auto-scroll runs per frame instead.
    dragState.scrollRaf = requestAnimationFrame(dragScrollTick);
    const wrapper = /** @type {HTMLElement} */ (row.parentElement);
    dragState.srcWrapper = wrapper;
    dragState.srcTop = wrapper.offsetTop;
    dragState.srcH = wrapper.offsetHeight;
    dragState.srcRowH = row.offsetHeight;
    dragState.grabDY = y - row.getBoundingClientRect().top;
    dragState.pressX = x;
    // Inverse of renderNode's indent (8 + depth * INDENT_PX).
    dragState.ownDepth = Math.round((parseFloat(row.style.paddingLeft) - 8) / INDENT_PX);
    const lift = document.createElement('div');
    lift.className = 'scribe-bm-lift';
    const clone = /** @type {HTMLElement} */ (row.cloneNode(true));
    clone.classList.remove('active', 'selected');
    clone.style.paddingLeft = '6px';
    const cloneTwisty = clone.querySelector('.scribe-bm-twisty');
    if (cloneTwisty) cloneTwisty.remove();
    const cloneDots = clone.querySelector('.scribe-bm-dots');
    if (cloneDots) cloneDots.remove();
    lift.appendChild(clone);
    dragState.cloneElem = clone;
    const carried = allIds([node]).length;
    if (carried > 1) {
      const badge = document.createElement('span');
      badge.className = 'scribe-bm-lift-count';
      badge.textContent = String(carried);
      lift.appendChild(badge);
    }
    const treeRect = treeElem.getBoundingClientRect();
    const panelRect = panelElem.getBoundingClientRect();
    dragState.treeLeft = treeRect.left - panelRect.left;
    dragState.treeW = treeRect.width;
    // Sized for the deepest reachable level and fixed for the whole drag, so changing depth translates the card instead of resizing it.
    const deepest = dragState.entries.reduce((m, entry) => Math.max(m, entry.depth + 1), 0);
    lift.style.width = `${dragState.treeW - 28 - deepest * INDENT_PX}px`;
    panelElem.appendChild(lift);
    dragState.ghostElem = lift;
    // Absolute children of a scroll container only span its viewport, so the height is set to the full scroll extent explicitly.
    const rails = document.createElement('div');
    rails.className = 'scribe-bm-rails';
    rails.style.height = `${treeElem.scrollHeight}px`;
    treeElem.appendChild(rails);
    dragState.railsElem = rails;
    dragState.railsKey = '';
    // The plate marks the slot the card will settle into.
    const plate = document.createElement('div');
    plate.className = 'scribe-bm-plate';
    plate.style.width = lift.style.width;
    plate.style.height = `${dragState.srcRowH}px`;
    plate.style.top = `${dragState.srcTop}px`;
    plate.style.left = `${22 + dragState.ownDepth * INDENT_PX}px`;
    treeElem.appendChild(plate);
    dragState.plateElem = plate;
    wrapper.classList.add('scribe-bm-lift-src');
    treeElem.classList.add('scribe-bm-sliding');
    return dragState;
  }

  /**
   * Move the drag visuals to the pointer.
   * @param {number} x - Pointer clientX.
   * @param {number} y - Pointer clientY.
   */
  function updateDragVisuals(x, y) {
    if (!drag) return;
    const panelRect = panelElem.getBoundingClientRect();
    drag.drop = computeDrop(drag, { clientX: x, clientY: y });
    drag.ghostElem.style.top = `${y - panelRect.top - drag.grabDY}px`;
    // The 22px base puts the card edge, the rails, and the plate 6px left of each depth's text.
    const desired = drag.treeLeft + 22 + drag.ownDepth * INDENT_PX + (x - drag.pressX);
    const legal = Math.max(
      drag.treeLeft + 22 + drag.drop.minDepth * INDENT_PX,
      Math.min(desired, drag.treeLeft + 22 + drag.drop.maxDepth * INDENT_PX),
    );
    const give = Math.max(-8, Math.min(8, (desired - legal) * 0.3));
    drag.ghostElem.style.left = `${legal + give}px`;
    // The gap's visual top: rows above the source slot keep their place, rows below have slid up.
    const gapVisTop = drag.drop.lineTop > drag.srcTop ? drag.drop.lineTop - drag.srcH : drag.drop.lineTop;
    drag.plateElem.style.top = `${gapVisTop}px`;
    drag.plateElem.style.left = `${22 + drag.drop.depth * INDENT_PX}px`;
    const railsKey = `${drag.drop.minDepth}:${drag.drop.maxDepth}:${drag.drop.depth}`;
    if (railsKey !== drag.railsKey) {
      drag.railsKey = railsKey;
      drag.railsElem.textContent = '';
      for (let d = drag.drop.minDepth; d <= drag.drop.maxDepth; d += 1) {
        const rail = document.createElement('i');
        rail.style.left = `${22 + d * INDENT_PX}px`;
        if (d === drag.drop.depth) rail.classList.add('on');
        drag.railsElem.appendChild(rail);
      }
    }
    const adopt = drag.drop.parent || null;
    if (adopt !== drag.adoptNode) {
      if (drag.adoptElem) drag.adoptElem.classList.remove('scribe-bm-adopt');
      drag.adoptNode = adopt;
      const adoptEntry = adopt ? drag.entries.find((entry) => entry.node === adopt) : null;
      drag.adoptElem = adoptEntry ? adoptEntry.elem : null;
      if (drag.adoptElem) drag.adoptElem.classList.add('scribe-bm-adopt');
    }
    // The card shows a single row even when it carries a subtree, so the gap opened for it is one row tall, not the source's full span.
    const gapY = drag.drop.lineTop;
    const surplus = drag.srcH - drag.srcRowH;
    for (const entry of drag.entries) {
      let shift = 0;
      if (gapY > drag.srcTop) {
        if (entry.top > drag.srcTop && entry.top < gapY) shift = -drag.srcH;
        else if (entry.top >= gapY) shift = -surplus;
      } else if (entry.top >= gapY && entry.top < drag.srcTop) {
        shift = drag.srcRowH;
      } else if (entry.top > drag.srcTop) {
        shift = -surplus;
      }
      entry.elem.style.transform = shift ? `translateY(${shift}px)` : '';
    }
  }

  function onDragMove(e) {
    if (!drag) {
      if (!dragPress) return;
      if (dragPress.holdT) {
        // Still inside the hold: real movement means the finger is scrolling the list, so stand down.
        if (Math.abs(e.clientX - dragPress.x) + Math.abs(e.clientY - dragPress.y) > 10) onDragEnd(e);
        return;
      }
      if (Math.abs(e.clientX - dragPress.x) + Math.abs(e.clientY - dragPress.y) < 5) return;
      drag = startDrag(dragPress);
    }
    e.preventDefault();
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    updateDragVisuals(e.clientX, e.clientY);
  }

  /** Frame-driven edge auto-scroll while a drag is live. */
  function dragScrollTick() {
    if (!drag) return;
    const rect = treeElem.getBoundingClientRect();
    let v = 0;
    if (drag.lastY < rect.top + 24) v = -Math.min(14, (rect.top + 24 - drag.lastY) * 0.5);
    else if (drag.lastY > rect.bottom - 24) v = Math.min(14, (drag.lastY - (rect.bottom - 24)) * 0.5);
    if (v) {
      const before = treeElem.scrollTop;
      treeElem.scrollTop = before + v;
      if (treeElem.scrollTop !== before) updateDragVisuals(drag.lastX, drag.lastY);
    }
    drag.scrollRaf = requestAnimationFrame(dragScrollTick);
  }

  function onDragEnd(e) {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    if (dragPress && dragPress.holdT) clearTimeout(dragPress.holdT);
    dragPress = null;
    if (!drag) return;
    cancelAnimationFrame(drag.scrollRaf);
    if (drag.armed) {
      drag.armed = false;
      drag.ghostElem.classList.remove('scribe-bm-lift-armed');
      treeElem.removeEventListener('scroll', setDownArmed);
    }
    const {
      id, node, drop, srcRow, srcWrapper, ghostElem, cloneElem, railsElem, plateElem, entries, treeLeft, adoptElem,
    } = drag;
    drag = null;
    panelElem.classList.remove('scribe-bm-dragging');
    if (adoptElem) adoptElem.classList.remove('scribe-bm-adopt');
    dragClickGuard = true;
    const ctx = context(id);
    const parentId = drop && drop.parent ? drop.parent.id : null;
    // Dropping back into the row's own slot is not an edit, so it must not record an undo step.
    const commit = !!drop && e.type !== 'pointercancel'
      && !(ctx && parentId === ctx.parentId && drop.atIndex === ctx.index);
    railsElem.remove();
    plateElem.remove();
    let landed;
    let landedWrapper;
    if (commit) {
      const before = new Map();
      for (const rowEl of treeElem.querySelectorAll('.scribe-bm-row')) {
        before.set(String(rowEl.dataset.id), rowEl.getBoundingClientRect().top);
      }
      treeElem.classList.remove('scribe-bm-sliding');
      scribe.doc.moveBookmark(id, parentId, drop.atIndex);
      afterEdit();
      landed = /** @type {HTMLElement} */ (treeElem.querySelector(`.scribe-bm-row[data-id="${id}"]`));
      if (!landed) {
        // The row is missing when it landed inside a collapsed section, so open its ancestors to keep the drop in view.
        const chainOf = (nodes, chain) => {
          for (const n of nodes) {
            if (n.id === id) return chain;
            const got = chainOf(n.children, chain.concat(n));
            if (got) return got;
          }
          return null;
        };
        for (const ancestor of chainOf(outline(), []) || []) ancestor.open = true;
        rebuild();
        landed = /** @type {HTMLElement} */ (treeElem.querySelector(`.scribe-bm-row[data-id="${id}"]`));
      }
      const blockIds = new Set(allIds([node]).map(String));
      treeElem.classList.add('scribe-bm-sliding');
      for (const rowEl of treeElem.querySelectorAll('.scribe-bm-row')) {
        const rid = String(rowEl.dataset.id);
        if (blockIds.has(rid)) continue;
        if (!before.has(rid)) { rowEl.classList.add('scribe-bm-drop-in-child'); continue; }
        const delta = before.get(rid) - rowEl.getBoundingClientRect().top;
        if (Math.abs(delta) < 0.5) continue;
        rowEl.style.transition = 'none';
        rowEl.style.transform = `translateY(${delta}px)`;
        rowEl.getBoundingClientRect();
        rowEl.style.transition = '';
        rowEl.style.transform = '';
      }
      landedWrapper = landed && /** @type {HTMLElement} */ (landed.parentElement);
      if (!landedWrapper) { ghostElem.remove(); return; }
      landedWrapper.classList.add('scribe-bm-lift-src');
    } else {
      for (const entry of entries) entry.elem.style.transform = '';
      landed = srcRow;
      landedWrapper = srcWrapper;
    }
    const plate = document.createElement('div');
    plate.className = 'scribe-bm-plate';
    plate.style.width = ghostElem.style.width;
    plate.style.height = `${landed.offsetHeight}px`;
    plate.style.top = `${landed.getBoundingClientRect().top - treeElem.getBoundingClientRect().top + treeElem.scrollTop}px`;
    plate.style.left = `${parseFloat(landed.style.paddingLeft) + 14}px`;
    treeElem.appendChild(plate);
    cloneElem.style.transition = 'box-shadow 140ms ease, border-radius 140ms ease';
    cloneElem.style.boxShadow = 'none';
    cloneElem.style.borderRadius = '4px';
    ghostElem.style.transition = 'top 140ms ease-out, left 140ms ease-out';
    ghostElem.style.top = `${landed.getBoundingClientRect().top - panelElem.getBoundingClientRect().top}px`;
    ghostElem.style.left = `${treeLeft + parseFloat(landed.style.paddingLeft) + 14}px`;
    const badge = ghostElem.querySelector('.scribe-bm-lift-count');
    if (badge instanceof HTMLElement) {
      badge.style.transition = 'opacity 140ms ease';
      badge.style.opacity = '0';
    }
    setTimeout(() => {
      ghostElem.remove();
      plate.remove();
      treeElem.classList.remove('scribe-bm-sliding');
      landedWrapper.classList.remove('scribe-bm-lift-src');
      landed.classList.add('scribe-bm-drop-in');
      const kids = [...landedWrapper.querySelectorAll('.scribe-bm-row')].filter((r) => r !== landed);
      for (const kid of kids) kid.classList.add('scribe-bm-drop-in-child');
      setTimeout(() => {
        landed.classList.remove('scribe-bm-drop-in');
        for (const el of treeElem.querySelectorAll('.scribe-bm-drop-in-child')) el.classList.remove('scribe-bm-drop-in-child');
      }, 250);
    }, 150);
  }

  /**
   * Arm a possible row drag.
   * @param {PointerEvent} e
   * @param {*} node - The outline node the row renders.
   * @param {HTMLElement} row - The row element (used as the drag source).
   */
  function beginRowDrag(e, node, row) {
    // A drag whose release produced no click leaves the guard armed, so a fresh press clears it.
    dragClickGuard = false;
    if (!editing() || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('.scribe-bm-twisty, .scribe-bm-rename, .scribe-bm-dots')) return;
    // Moving on the phone sheet is reached only through the row menu's Move entry, so no press here lifts a row.
    if (phoneMode && e.pointerType !== 'touch') return;
    dragPress = {
      id: node.id, node, row, x: e.clientX, y: e.clientY, holdT: null, touch: e.pointerType === 'touch',
    };
    if (dragPress.touch) {
      const { pointerId } = e;
      // In a Move session the hold lifts rows directly, so a run of moves costs no menu trips.
      const holdOpensMenu = phoneMode && !moveSession;
      dragPress.holdT = setTimeout(() => {
        if (!dragPress || drag) return;
        if (holdOpensMenu) {
          window.removeEventListener('pointermove', onDragMove);
          window.removeEventListener('pointerup', onDragEnd);
          window.removeEventListener('pointercancel', onDragEnd);
          dragPress = null;
          // The finger is still down, so swallow the click that composes at release.
          dragClickGuard = true;
          openPhoneRowMenu(node, row, 'hold');
          return;
        }
        dragPress.holdT = null;
        // Capturing on the tree keeps the browser routing the held touch to us.
        try { treeElem.setPointerCapture(pointerId); } catch { /* pointer already released or untrusted */ }
        drag = startDrag(dragPress);
        updateDragVisuals(dragPress.x, dragPress.y);
      }, holdOpensMenu ? MENU_HOLD_MS : LIFT_HOLD_MS);
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  /**
   * Raise a row into the drag card, parked over its own slot, so the next press on the card continues into a normal drag.
   * A press elsewhere, or a scroll, sets the card back down without an edit.
   * @param {*} node - Outline node to move.
   */
  function armMove(node) {
    if (drag) return;
    const row = /** @type {?HTMLElement} */ (treeElem.querySelector(`.scribe-bm-row[data-id="${node.id}"]`));
    if (!row) return;
    const rect = row.getBoundingClientRect();
    drag = startDrag({
      id: node.id, node, row, x: rect.left + 120, y: rect.top + rect.height / 2, holdT: null, touch: true,
    });
    updateDragVisuals(rect.left + 120, rect.top + rect.height / 2);
    // No pointer is down while the card is parked, so the grabbing cursor and edge auto-scroll stay off until the grab.
    panelElem.classList.remove('scribe-bm-dragging');
    cancelAnimationFrame(drag.scrollRaf);
    drag.armed = true;
    drag.ghostElem.classList.add('scribe-bm-lift-armed');
    drag.ghostElem.addEventListener('pointerdown', grabArmed);
    treeElem.addEventListener('scroll', setDownArmed);
  }

  /**
   * Continue a parked Move into a normal drag.
   * @param {PointerEvent} e
   */
  function grabArmed(e) {
    if (!drag || !drag.armed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.armed = false;
    drag.ghostElem.classList.remove('scribe-bm-lift-armed');
    treeElem.removeEventListener('scroll', setDownArmed);
    panelElem.classList.add('scribe-bm-dragging');
    drag.grabDY = e.clientY - drag.ghostElem.getBoundingClientRect().top;
    drag.pressX = e.clientX - (drag.drop.depth - drag.ownDepth) * INDENT_PX;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.scrollRaf = requestAnimationFrame(dragScrollTick);
    try { treeElem.setPointerCapture(e.pointerId); } catch { /* pointer already released or untrusted */ }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  /**
   * Set a parked card back down in place.
   * The drop lands in its own slot, so no edit is recorded.
   */
  function setDownArmed() {
    if (!drag || !drag.armed) return;
    onDragEnd(new PointerEvent('pointerup'));
  }

  /**
   * Every node id in the outline, flattened depth-first.
   * @param {Array<Object>} [nodes]
   * @returns {string[]}
   */
  function allIds(nodes = outline()) {
    const ids = [];
    for (const node of nodes) { ids.push(node.id); ids.push(...allIds(node.children)); }
    return ids;
  }

  /** Reflect `selected` on the rendered rows. */
  function applySelection() {
    for (const row of treeElem.querySelectorAll('.scribe-bm-row')) {
      row.classList.toggle('selected', selected.has(row.dataset.id));
    }
  }

  /** Select every bookmark (Ctrl/Cmd+A). */
  function selectAll() {
    selected.clear();
    for (const id of allIds()) selected.add(id);
    applySelection();
  }

  /** Clear the bulk selection. */
  function clearSelection() {
    if (selected.size === 0) return;
    selected.clear();
    applySelection();
  }

  /**
   * Add or remove one bookmark from the bulk selection (Ctrl/Cmd-click).
   * @param {string} id
   */
  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    applySelection();
  }

  /** Remove every selected bookmark (editor only). */
  function deleteSelected() {
    if (!editing() || selected.size === 0) return;
    scribe.doc.removeBookmarks([...selected]);
    selected.clear();
    afterEdit();
  }

  /**
   * Sidebar shortcuts while the bookmarks panel is the open sidebar:
   * Ctrl/Cmd+A selects every bookmark, Delete/Backspace removes the selection (editor only), Escape clears it.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (!visible || (scribe.opt && scribe.opt.keyboardScope === 'off')) return;
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
      return;
    }
    if (e.key === 'Escape') { clearSelection(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      e.preventDefault();
      deleteSelected();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  /**
   * Highlight the first bookmark, top-down, whose destination is visible in the document viewport.
   */
  function applyActive() {
    // Navigation scrolls a destination near the viewport top, so the clicked bookmark becomes the highlight with no click-specific logic.
    const sc = scribe.scrollContainer;
    let best = null;
    if (sc) {
      const zoom = scribe.zoomLevel || 1;
      const viewTop = sc.scrollTop;
      const viewBottom = viewTop + sc.clientHeight;
      let bestY = Infinity;
      const rows = /** @type {NodeListOf<HTMLElement>} */ (treeElem.querySelectorAll('.scribe-bm-row'));
      for (const row of rows) {
        if (row.dataset.page === '') continue;
        const page = Number(row.dataset.page);
        const dims = scribe.getDisplayDims(page);
        const pageTop = scribe.getPageStop(page);
        if (!dims || pageTop == null) continue;
        // Rotation invalidates the parse-time yFrac axis, so score rotated pages at the page top, where goToOutlineDest also lands them.
        const rotated = ((scribe.doc.pageMetrics[page]?.rotation || 0) % 360) !== 0;
        const y = (pageTop + (rotated ? 0 : Number(row.dataset.yfrac)) * dims.height) * zoom;
        if (y >= viewTop && y < viewBottom && y < bestY) { bestY = y; best = row; }
      }
    }
    if (best === activeRow) return;
    if (activeRow) activeRow.classList.remove('active');
    if (best) best.classList.add('active');
    activeRow = best;
  }

  /**
   * Re-highlight for the current scroll position, without a full rebuild.
   * The full rebuild fires on edit/undo instead.
   */
  function setActive() {
    ensureScrollHook();
    applyActive();
  }

  let activeRaf = 0;
  const onDocScroll = () => {
    if (!visible || activeRaf) return;
    activeRaf = requestAnimationFrame(() => { activeRaf = 0; applyActive(); });
  };
  let scrollHookTarget = /** @type {?HTMLElement} */ (null);
  // The viewer builds its scroll container after this panel, so bind the listener on first use rather than at construction.
  function ensureScrollHook() {
    const sc = scribe.scrollContainer;
    if (scrollHookTarget || !sc) return;
    scrollHookTarget = sc;
    sc.addEventListener('scroll', onDocScroll, { passive: true });
  }

  function setVisible(v) {
    visible = v;
    panelElem.style.display = v ? '' : 'none';
    if (v) { ensureScrollHook(); rebuild(); } else { endMoveSession(); clearSelection(); }
  }
  function destroy() {
    endMoveSession();
    closeMenu();
    menuElem.remove();
    panelElem.remove();
    if (activeRaf) cancelAnimationFrame(activeRaf);
    if (scrollHookTarget) scrollHookTarget.removeEventListener('scroll', onDocScroll);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', dismissMenu, true);
    document.removeEventListener('click', dismissMenu, true);
    document.removeEventListener('pointerdown', armedPress, true);
  }

  /**
   * Flag that the panel lives in the phone bottom sheet.
   * @param {boolean} on
   */
  function setPhoneMode(on) {
    if (phoneMode === !!on) return;
    phoneMode = !!on;
    if (!phoneMode) endMoveSession();
    if (visible) rebuild();
  }

  panelElem.style.display = 'none';
  return {
    panelElem,
    toggleElem,
    rebuild,
    setActive,
    setVisible,
    destroy,
    addAtPage: addBookmarkAtPage,
    setPhoneMode,
    endMoveSession,
  };
}
