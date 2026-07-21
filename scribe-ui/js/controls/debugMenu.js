// Debug menu: developer-only tools, installed only when `DEBUG_MENU` in scribe-ui/devFlags.js is on and stripped from public builds.
import { UiText } from '../viewerWordObjects.js';
import { makeOutlineNode } from '../../../js/objects/outlineObjects.js';

/** Bug glyph for the Debug section's rows. */
const BUG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="8" y="8" width="8" height="11" rx="4"/>'
  + '<path d="M9 8a3 3 0 0 1 6 0M12 11v8M5.5 12h13M6 8.5 4 7M18 8.5 20 7M5 16l-2 1.5M19 16l2 1.5"/></svg>';

const DOC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>'
  + '<path d="M14 3v5h5M8 13h8M8 17h5"/></svg>';

/**
 * Append a "Debug" section to the app menu: a header row plus dev-only tools.
 * @param {ReturnType<import('./toolbar.js').createAppMenu>} appMenu - The app menu built in pdf-viewer.js.
 * @param {import('../../viewer.js').ScribeViewer} viewer - The viewer whose overlay the tools act on.
 * @param {(files: File[]) => Promise<void>} openFiles - Opens the given files in the viewer.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} host - The viewer host, for the sidebar panels the seeding tools reveal.
 */
export function installDebugMenu(appMenu, viewer, openFiles, host) {
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

  appMenu.addAction('Load sample PDF', DOC_SVG, async () => {
    try {
      const res = await fetch(new URL('../../../tests/test-assets/ashcroft-v-iqbal.pdf', import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = new File([await res.arrayBuffer()], 'ashcroft-v-iqbal.pdf', { type: 'application/pdf' });
      await openFiles([file]);
    } catch (err) {
      console.error('Failed to load the sample PDF:', err);
    }
  });

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

  appMenu.addToggle(
    'Outline paragraphs',
    BUG_SVG,
    () => viewer.opt.outlinePars,
    () => {
      viewer.opt.outlinePars = !viewer.opt.outlinePars;
      viewer.destroyText(false);
      viewer.displayPage(viewer.state.cp.n, false, true);
    },
  );

  appMenu.addAction('Generate sample comments', BUG_SVG, async () => {
    const doc = viewer.doc;
    if (!doc || !doc.ocr.active.length) {
      console.warn('Generate sample comments: open a document with text first.');
      return;
    }

    /** @param {number} daysAgo */
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

    const recipes = [
      {
        span: 2,
        comment: 'The venue allegations here rest entirely on the exhibits, and none of them are attached to this filing. We should either attach them or scope the claim down before service.',
        author: 'M. Twain',
        daysAgo: 2,
        replies: [
          { text: 'Exhibit 4 has the venue facts.', author: 'E. Dickinson', createdAt: iso(1) },
          { text: 'Scoped the claim to Exhibit 4.', author: 'M. Twain', createdAt: iso(1) },
          { text: 'Confirmed against the docket.', author: 'W. Whitman', createdAt: iso(0) },
        ],
      },
      {
        markup: 'strikeout',
        color: '#ef4444',
        comment: 'Cut.',
        author: 'E. Dickinson',
        daysAgo: 430,
        replies: [{ text: 'Agreed, redundant with the paragraph above.', author: 'J. Austen', createdAt: iso(429) }],
      },
      {
        markup: 'underline', color: '#3b82f6', comment: 'Check this citation against the reporter.', daysAgo: 9,
      },
      { color: '#7ee0a1' },
      {
        color: '#f0a5d8',
        comment: 'Four participants, to exercise the avatar tint cycle.',
        author: 'J. Austen',
        daysAgo: 21,
        replies: [
          { text: 'Reading it the same way.', author: 'M. Twain', createdAt: iso(20) },
          { text: 'The 2019 order says otherwise.', author: 'E. Dickinson', createdAt: iso(18) },
          { text: 'Pulled the order, it is distinguishable.', author: 'W. Whitman', createdAt: iso(17) },
          { text: 'Unsigned follow-up.', createdAt: iso(16) },
        ],
      },
      {
        markup: 'underline', color: '#f59e0b', comment: 'Defined term is introduced later than its first use.', author: 'W. Whitman', daysAgo: 64,
      },
      { markup: 'strikeout', color: '#a78bfa' },
      {
        span: 3, color: '#ffe93b', comment: 'Long quote.', author: 'M. Twain', daysAgo: 200, replies: [{ text: 'Trim to the operative sentence.', author: 'E. Dickinson', createdAt: iso(199) }],
      },
      {
        color: '#22d3ee', opacity: 0.7, comment: 'Second-most-recent thread, one reply.', author: 'E. Dickinson', daysAgo: 5, replies: [{ text: 'Done.', author: 'M. Twain', createdAt: iso(4) }],
      },
      {
        color: '#fb7185', comment: 'Oldest authored comment in the set.', author: 'J. Austen', daysAgo: 800,
      },
    ];

    // Slots are spaced 4 lines apart so multi-line spans do not overlap.
    // The per-page cap spreads the set across pages, so the panel gets several page groups.
    /** @type {Array<{page: number, line: number}>} */
    const slots = [];
    for (let n = 0; n < doc.ocr.active.length && slots.length < recipes.length; n++) {
      const pageObj = doc.ocr.active[n];
      if (!pageObj || pageObj.lines.length < 2) continue;
      for (let k = 0; k < 3 && 1 + k * 4 < pageObj.lines.length && slots.length < recipes.length; k++) slots.push({ page: n, line: 1 + k * 4 });
    }

    recipes.forEach((recipe, i) => {
      const slot = slots[i];
      if (!slot) return;
      const markup = recipe.markup || 'highlight';
      const { groups } = doc.addHighlights([{
        page: slot.page,
        startLine: slot.line,
        endLine: slot.line + ((recipe.span || 1) - 1),
        markup,
        color: recipe.color,
        opacity: recipe.opacity,
        comment: recipe.comment,
      }]);
      if (!groups.length) return;
      // Every call restarts its group numbering at zero, so rename this group before the next call reuses the id.
      // The thread is stamped on all members because consumers read it off whichever one they match first.
      for (const annot of doc.annotations.pages[slot.page]) {
        if (annot.type !== 'highlight' && annot.type !== 'underline' && annot.type !== 'strikeout') continue;
        if (annot.groupId !== groups[0].groupId) continue;
        annot.groupId = `dbg-hl-${i}`;
        if (recipe.author) annot.author = recipe.author;
        annot.createdAt = iso(recipe.daysAgo ?? 0);
        if (recipe.replies) annot.replies = recipe.replies.map((r) => ({ ...r }));
      }
    });

    /** @param {number} i */
    const notePage = (i) => Math.min(i, doc.pageMetrics.length - 1);
    doc.addTextAnnots([
      {
        page: notePage(0),
        x: doc.pageMetrics[notePage(0)].dims.width - 90,
        y: 120,
        comment: 'Open-by-default note with a thread.',
        author: 'M. Twain',
        createdAt: iso(3),
        open: true,
        replies: [{ text: 'Noted.', author: 'W. Whitman', createdAt: iso(2) }],
      },
      {
        page: notePage(0),
        x: doc.pageMetrics[notePage(0)].dims.width - 90,
        y: 300,
        comment: 'A longer unauthored note, kept wordy so the panel has to clamp the collapsed body to two lines and the card has something to expand into.',
        color: '#3b82f6',
      },
      {
        page: notePage(1),
        x: doc.pageMetrics[notePage(1)].dims.width - 90,
        y: 180,
        comment: 'Prior-year note.',
        author: 'J. Austen',
        color: '#22c55e',
        createdAt: iso(500),
      },
      {
        page: notePage(2), x: 60, y: 60, comment: 'Left-margin note, no author or color.',
      },
    ]);

    // The word objects snapshot highlight state when they are built, so the bands only appear after a forced rebuild.
    await viewer.displayPage(viewer.state.cp.n, false, true);
    if (host && host._commentsPanel) host._commentsPanel.toggleElem.style.display = '';
    if (viewer._rebuildCommentsPanel) viewer._rebuildCommentsPanel();
  });

  appMenu.addAction('Generate sample bookmarks', BUG_SVG, () => {
    const doc = viewer.doc;
    if (!doc || !doc.pageMetrics.length) {
      console.warn('Generate sample bookmarks: open a document first.');
      return;
    }

    const last = doc.pageMetrics.length - 1;
    /** @param {number} i @param {Array<string|number|null>} view @param {number} [yFrac] */
    const dest = (i, view, yFrac) => ({ pageIndex: Math.min(i, last), view, yFrac });

    // Four levels deep, mixing varied `view` destination forms, a structural node with no target, a URI action node, and subtrees that start collapsed.
    doc.replaceOutline([
      makeOutlineNode({ title: 'Cover', dest: dest(0, ['Fit']) }),
      makeOutlineNode({
        title: 'I. Statement of the Case',
        dest: dest(1, ['XYZ', -4, 796, 0], 0.06),
        children: [
          makeOutlineNode({
            title: 'A. Procedural History',
            dest: dest(2, ['FitH', 640], 0.2),
            children: [
              makeOutlineNode({
                title: '1. Proceedings Below',
                dest: dest(3, ['XYZ', 72, 520, null], 0.34),
                children: [
                  makeOutlineNode({ title: 'a. The Magistrate’s Report', dest: dest(4, ['FitBH', 400], 0.5) }),
                  makeOutlineNode({ title: 'b. Objections and Adoption', dest: dest(4, ['Fit']) }),
                ],
              }),
              makeOutlineNode({ title: '2. The Order on Appeal', dest: dest(5, ['FitR', 40, 60, 560, 700]) }),
            ],
          }),
          makeOutlineNode({
            title: 'B. A deliberately long heading that runs past the panel’s width so the row has to truncate it',
            dest: dest(6, ['FitV', 80]),
            open: false,
            children: [
              makeOutlineNode({ title: 'Collapsed child (parent starts closed)', dest: dest(7, ['Fit']) }),
            ],
          }),
        ],
      }),
      // No dest and no action: the panel renders this as a section label rather than a link.
      makeOutlineNode({
        title: 'II. Argument',
        children: [
          makeOutlineNode({ title: 'A. Standard of Review', dest: dest(8, ['FitB']) }),
          makeOutlineNode({ title: 'External authority (scribeocr.com)', action: '<</S/URI/URI(https://scribeocr.com)>>' }),
        ],
      }),
      makeOutlineNode({ title: 'III. Conclusion', dest: dest(9, ['Fit']) }),
    ]);

    if (host && host._bookmarksPanel) host._bookmarksPanel.toggleElem.style.display = '';
    if (viewer.onPageEditCallback) viewer.onPageEditCallback();
  });
}
