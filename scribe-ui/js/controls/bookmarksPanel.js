// Bookmarks (document outline) side panel, a sibling of the page-thumbnails rail.
// Renders scribe.doc.outline as a navigable tree: clicking a bookmark jumps to its destination.
// Rows are text-first, like a book's table of contents: hierarchy comes from indentation and type (top-level entries semibold, title-only parents as section labels), not per-row icons.
import { makeIconButton } from './toolbar.js';

// A bookmark-ribbon glyph for the toolbar toggle.
const BOOKMARK_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><path d="M4 2a1 1 0 0 0-1 1v11l5-3 5 3V3a1 1 0 0 0-1-1H4z"/></svg>';
// Disclosure chevron for expandable rows, stroked to match the toolbar's icon language.
// Points right when collapsed.
// The `.open` class rotates it to point down.
const TWISTY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
// Plus glyph for the header's persistent add button.
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';

/**
 * Create the bookmarks (document outline) side panel.
 * @param {*} scribe - The ScribeViewer instance.
 * @param {{ onNavigate: (dest: { pageIndex: number, yFrac?: number }) => void, onResize?: (width: number, phase: 'start'|'move'|'end') => void }} handlers
 *   `onNavigate` receives the clicked bookmark's whole destination, so the host can honor its within-page position (`yFrac`), not just the page.
 *   `onResize` fires as the right-edge handle is dragged, with the desired width and the drag phase: `start` (pointerdown), `move` (each pointermove), and `end` (release).
 * @returns {{ panelElem: HTMLDivElement, toggleElem: HTMLSpanElement, rebuild: () => void,
 * setActive: (pageIndex: number) => void, setVisible: (v: boolean) => void, destroy: () => void, addAtPage: (pageIndex?: number) => void }}
 */
export function createBookmarksPanel(scribe, { onNavigate, onResize }) {
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

  let activePage = -1;
  let visible = false;
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
   * @param {string} id
   * @returns {{ node: Object, parentId: (string|null), index: number, siblings: Array<Object>, grandparentId: (string|null) }|null}
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

  function closeMenu() { menuElem.style.display = 'none'; menuElem.textContent = ''; }

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
    if (!scribe.doc) return;
    const id = scribe.doc.addBookmark({ title: 'New bookmark', pageIndex });
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
    showMenuAt(x, y);
  }

  /** Begin inline rename of a bookmark row, committing to doc.renameBookmark on Enter/blur. */
  function startRename(node, labelElem) {
    const input = document.createElement('input');
    input.className = 'scribe-bm-rename';
    input.value = node.title;
    labelElem.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
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
    add('Delete', true, () => { scribe.doc.removeBookmarks([node.id]); afterEdit(); });

    showMenuAt(x, y);
  }

  /**
   * Render one outline node (and, when open, its children) as indented rows.
   * @param {{id: string, title: string, dest: {pageIndex: number}|null, children: any[], open: boolean}} node - Outline node to render.
   * @param {number} depth - Nesting depth, used to indent the row.
   * @returns {HTMLDivElement} Wrapper element holding the node's row and, when open, its rendered children.
   */
  function renderNode(node, depth) {
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'scribe-bm-row';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.page = node.dest ? String(node.dest.pageIndex) : '';
    row.dataset.id = node.id;
    if (node.dest && node.dest.pageIndex === activePage) row.classList.add('active');
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

    // Quiet right-aligned page number, 1-indexed to match the thumbnail rail and page-nav control.
    if (node.dest) {
      const pageBadge = document.createElement('span');
      pageBadge.className = 'scribe-bm-page';
      pageBadge.textContent = String(node.dest.pageIndex + 1);
      row.appendChild(pageBadge);
    }

    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { toggleSelect(node.id); return; }
      clearSelection();
      if (node.dest) onNavigate(node.dest);
      else if (node.children.length) { node.open = !node.open; rebuild(); }
    });
    row.addEventListener('dblclick', () => {
      if (node.dest) onNavigate(node.dest);
      if (node.children.length && !node.open) { node.open = true; rebuild(); }
    });
    // The right-click menu is the only way to rename an existing bookmark.
    if (editing()) {
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(node, e.clientX, e.clientY, label); });
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
    const nodes = outline();
    if (nodes.length === 0) {
      // No document loaded -> nothing to bookmark, so leave the panel blank (not even "No bookmarks yet"), matching the thumbnail rail, which is also empty before a document is open.
      if (!hasDoc()) return;
      const empty = document.createElement('div');
      empty.className = 'scribe-bm-empty';
      empty.textContent = editing() ? 'No bookmarks yet.' : 'No bookmarks.';
      treeElem.appendChild(empty);
      return;
    }
    for (const node of nodes) treeElem.appendChild(renderNode(node, 0));
  }

  /** Re-render after an edit. The doc verbs already recorded it for undo/redo. */
  function afterEdit() { rebuild(); }

  /**
   * After an add, put the new row straight into rename mode.
   * @param {number} id The new bookmark node's id.
   */
  function focusRename(id) {
    const rows = treeElem.querySelectorAll('.scribe-bm-row');
    for (const row of rows) {
      const label = row.querySelector('.scribe-bm-label');
      if (label && context(id) && label.textContent === 'New bookmark') { startRename(context(id).node, label); break; }
    }
  }

  // Right-click the tree's empty space to add a top-level bookmark.
  treeElem.addEventListener('contextmenu', (e) => {
    if (!editing()) return;
    if (e.target instanceof Element && e.target.closest('.scribe-bm-row')) return;
    e.preventDefault();
    openAddMenu(e.clientX, e.clientY);
  });
  (scribe.outerElem || document).addEventListener('click', (e) => { if (!menuElem.contains(e.target)) closeMenu(); });

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
   * Cheap re-highlight of the current page's bookmark(s), without a full rebuild (which fires on edit/undo instead).
   * @param {number} pageIndex
   */
  function setActive(pageIndex) {
    activePage = pageIndex;
    for (const row of treeElem.querySelectorAll('.scribe-bm-row')) {
      row.classList.toggle('active', row.dataset.page !== '' && Number(row.dataset.page) === activePage);
    }
  }

  function setVisible(v) { visible = v; panelElem.style.display = v ? '' : 'none'; if (v) rebuild(); else clearSelection(); }
  function destroy() { closeMenu(); menuElem.remove(); panelElem.remove(); document.removeEventListener('keydown', onKeyDown); }

  panelElem.style.display = 'none';
  return {
    panelElem, toggleElem, rebuild, setActive, setVisible, destroy, addAtPage: addBookmarkAtPage,
  };
}
