// The page raster is rendered from the original PDF bytes, so it keeps showing a field's printed appearance after the value is edited.
// An edited field's value exists only in the overlay, drawn on an opaque cover over that stale appearance.
import { layoutFieldValue } from '../../js/pdf/formFieldLayout.js';

const PX_PER_PT = 300 / 72;

/** @type {WeakMap<object, Set<string>>} */
const dirtyNamesByDoc = new WeakMap();

function dirtyNames(doc) {
  let s = dirtyNamesByDoc.get(doc);
  if (!s) { s = new Set(); dirtyNamesByDoc.set(doc, s); }
  return s;
}

let highlightFieldsOn = true;

export function getHighlightFields() { return highlightFieldsOn; }

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {boolean} on
 */
export function setHighlightFields(viewer, on) {
  highlightFieldsOn = !!on;
  if (viewer.elem) viewer.elem.classList.toggle('scribe-fields-off', !highlightFieldsOn);
}

export function docHasFormFields(doc) {
  return !!doc?.annotations?.pages?.some((rows) => (rows || [])
    .some((a) => a.type === 'field' && !a.hidden && a.fieldType !== 'button' && a.fieldType !== 'signature'));
}

/**
 * Write a new value through `doc.setFormValue` and refresh every page the field appears on.
 * One field can have widgets on several pages, so an edit changes all of them.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationField} row
 * @param {string|null} newValue
 * @returns {boolean} Whether the value changed.
 */
function commitValue(viewer, row, newValue) {
  const norm = newValue === '' ? null : newValue;
  if (norm === (row.value ?? null)) return false;
  viewer.doc.setFormValue(row.name, norm);
  dirtyNames(viewer.doc).add(row.name);
  for (let n = 0; n < viewer.doc.annotations.pages.length; n++) {
    if (!(viewer.doc.annotations.pages[n] || []).some((a) => a.type === 'field' && a.name === row.name)) continue;
    viewer.renderWords(n);
    viewer.renderFormFields(n);
    if (viewer.textSel) {
      viewer.textSel.invalidatePage(n);
      viewer.textSel.renderPage(n);
    }
  }
  if (viewer.onEditCallback) viewer.onEditCallback();
  return true;
}

/**
 * The field's value layout, plus the font size and rect height in page px.
 * It is the same layout the PDF export writes into the field's appearance stream, so the cover matches the exported file.
 * @param {AnnotationField} row
 * @param {string} value
 */
function fieldLayoutPx(row, value) {
  const rectWpt = (row.bbox.right - row.bbox.left) / PX_PER_PT;
  const rectHpt = (row.bbox.bottom - row.bbox.top) / PX_PER_PT;
  const layout = layoutFieldValue(value, rectWpt, rectHpt, {
    multiline: !!row.multiline, comb: !!row.comb, maxLen: row.maxLen ?? null, quadding: row.quadding || 0, da: row.da ?? null,
  });
  return { layout, rectHpx: rectHpt * PX_PER_PT, fontPx: layout.fontSize * PX_PER_PT };
}

/**
 * Render (or re-render) page n's form-field overlay.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderPageFormFields(viewer, n) {
  const group = viewer.getFieldsGroup(n);
  if (!group) return;
  // Displaying a page re-renders its neighbors, so a render can arrive while the user is typing.
  if (group.querySelector('.scribe-field-input') && group.contains(document.activeElement)) return;
  group.replaceChildren();
  if (viewer.elem) viewer.elem.classList.toggle('scribe-fields-off', !highlightFieldsOn);
  const dirty = dirtyNames(viewer.doc);
  const pageRows = viewer.doc.annotations.pages[n] || [];
  const rows = /** @type {AnnotationField[]} */ (pageRows
    .filter((a) => a.type === 'field' && !a.hidden && a.fieldType !== 'button'
      && (a.fieldType !== 'signature' || (!a.signed && !!viewer.onSignatureFieldClick))))
    .sort((a, b) => (a.bbox.top - b.bbox.top) || (a.bbox.left - b.bbox.left));
  for (const row of rows) {
    if (row.fieldType === 'signature') {
      // Signing into a field places an ink or stamp annotation and never sets `signed`, so overlap is the only evidence a signature is already there.
      const covered = pageRows.some((a) => (a.type === 'ink' || a.type === 'stamp')
        && a.bbox.left < row.bbox.right && a.bbox.right > row.bbox.left
        && a.bbox.top < row.bbox.bottom && a.bbox.bottom > row.bbox.top);
      if (covered) continue;
      const el = document.createElement('div');
      el.className = 'scribe-field scribe-field-sig';
      el.dataset.name = row.name;
      el.title = 'Sign here';
      el.style.left = `${row.bbox.left}px`;
      el.style.top = `${row.bbox.top}px`;
      el.style.width = `${row.bbox.right - row.bbox.left}px`;
      el.style.height = `${row.bbox.bottom - row.bbox.top}px`;
      el.tabIndex = 0;
      el.addEventListener('click', () => viewer.onSignatureFieldClick?.(n, row));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          viewer.onSignatureFieldClick?.(n, row);
        }
      });
      group.appendChild(el);
      continue;
    }
    const el = document.createElement('div');
    el.className = `scribe-field scribe-field-${row.fieldType}`;
    el.dataset.name = row.name;
    el.style.left = `${row.bbox.left}px`;
    el.style.top = `${row.bbox.top}px`;
    el.style.width = `${row.bbox.right - row.bbox.left}px`;
    el.style.height = `${row.bbox.bottom - row.bbox.top}px`;
    if (row.readOnly) el.classList.add('scribe-field-ro');
    if (row.required) el.classList.add('scribe-field-req');

    if (dirty.has(row.name)) {
      el.classList.add('scribe-field-dirty');
      const cover = document.createElement('div');
      cover.className = 'scribe-field-cover';
      if (row.fieldType === 'checkbox' || row.fieldType === 'radio') {
        if (row.value != null && row.value === row.onState) {
          if (row.fieldType === 'radio') {
            const dot = document.createElement('div');
            dot.className = 'scribe-field-radio-dot';
            cover.appendChild(dot);
          } else {
            const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            check.setAttribute('viewBox', '0 0 24 24');
            check.setAttribute('class', 'scribe-field-check');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M4.5 13l5 5L19.5 6.5');
            check.appendChild(path);
            cover.appendChild(check);
          }
        }
      } else if (row.value) {
        const { layout, rectHpx, fontPx } = fieldLayoutPx(row, row.value);
        const combCellW = row.comb && row.maxLen ? (row.bbox.right - row.bbox.left) / row.maxLen : 0;
        if (combCellW) {
          // The cover hides the comb separators printed on the page.
          cover.style.backgroundImage = `repeating-linear-gradient(90deg, transparent 0 ${combCellW - 1}px, #6b6b6b ${combCellW - 1}px ${combCellW}px)`;
        }
        for (const ll of layout.lines) {
          const baselineTop = rectHpx - ll.y * PX_PER_PT;
          const spanTop = `${baselineTop - layout.fontSize * 0.8 * PX_PER_PT}px`;
          if (combCellW) {
            for (const wd of ll.words) {
              for (let i = 0; i < wd.text.length; i++) {
                const span = document.createElement('span');
                span.className = 'scribe-field-covertext';
                span.textContent = wd.text[i];
                span.style.left = `${wd.x0 * PX_PER_PT + i * combCellW}px`;
                span.style.width = `${combCellW}px`;
                span.style.textAlign = 'center';
                span.style.top = spanTop;
                span.style.fontSize = `${fontPx}px`;
                cover.appendChild(span);
              }
            }
          } else if (ll.text) {
            const span = document.createElement('span');
            span.className = 'scribe-field-covertext';
            span.textContent = ll.text;
            span.style.left = `${ll.x * PX_PER_PT}px`;
            span.style.top = spanTop;
            span.style.fontSize = `${fontPx}px`;
            cover.appendChild(span);
          }
        }
      }
      el.appendChild(cover);
    }

    group.appendChild(el);
    if (row.readOnly) continue;
    el.tabIndex = 0;
    const isToggle = row.fieldType === 'checkbox' || row.fieldType === 'radio';

    /** @param {?string} seed */
    const activate = (seed) => {
      if (isToggle) {
        if (row.onState == null) return;
        if (row.fieldType === 'radio') commitValue(viewer, row, row.onState);
        else commitValue(viewer, row, row.value === row.onState ? null : row.onState);
        return;
      }

      if (row.fieldType === 'choice' && row.options?.length) {
        if (!viewer.elem || viewer.elem.querySelector('.scribe-field-pop')) return;
        const options = row.options.slice();
        // An editable combo box accepts free text, so its value can be absent from /Opt.
        if (row.value != null && !options.includes(row.value)) options.unshift(row.value);
        const pop = document.createElement('div');
        pop.className = 'scribe-field-pop';
        pop.role = 'listbox';
        let active = Math.max(0, options.indexOf(/** @type {string} */(row.value)));
        /** @type {HTMLDivElement[]} */
        const items = [];
        const closePop = () => {
          document.removeEventListener('keydown', onPopKey, true);
          document.removeEventListener('pointerdown', onPopPress, true);
          pop.remove();
          el.focus({ preventScroll: true });
        };
        const setActive = (i) => {
          items[active]?.classList.remove('active');
          active = Math.max(0, Math.min(options.length - 1, i));
          items[active]?.classList.add('active');
          items[active]?.scrollIntoView({ block: 'nearest' });
        };
        /** @param {KeyboardEvent} e */
        const onPopKey = (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setActive(e.key === 'ArrowDown' ? active + 1 : active - 1);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const opt = options[active];
            closePop();
            commitValue(viewer, row, opt);
          } else if (e.key === 'Escape' || e.key === 'Tab') {
            e.stopPropagation();
            closePop();
          }
        };
        /** @param {PointerEvent} e */
        const onPopPress = (e) => {
          if (e.target instanceof Node && pop.contains(e.target)) return;
          closePop();
        };
        for (const opt of options) {
          const it = document.createElement('div');
          it.className = 'scribe-field-pop-item';
          it.role = 'option';
          it.textContent = opt.trim() === '' ? ' ' : opt;
          if (opt === row.value) it.classList.add('current');
          if (items.length === active) it.classList.add('active');
          // Keeps mousedown from moving focus off the field.
          it.addEventListener('mousedown', (e) => e.preventDefault());
          it.addEventListener('click', () => { closePop(); commitValue(viewer, row, opt); });
          pop.appendChild(it);
          items.push(it);
        }
        document.addEventListener('keydown', onPopKey, true);
        document.addEventListener('pointerdown', onPopPress, true);
        const anchor = el.getBoundingClientRect();
        pop.style.left = `${Math.round(anchor.left)}px`;
        pop.style.minWidth = `${Math.round(anchor.width)}px`;
        viewer.elem.appendChild(pop);
        const popH = pop.getBoundingClientRect().height;
        const below = anchor.bottom + 2;
        pop.style.top = `${Math.round(below + popH <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - 2 - popH))}px`;
        const overflowX = pop.getBoundingClientRect().right - (window.innerWidth - 8);
        if (overflowX > 0) pop.style.left = `${Math.round(anchor.left - overflowX)}px`;
        items[active]?.scrollIntoView({ block: 'nearest' });
        return;
      }

      if (el.querySelector('.scribe-field-input')) return;
      const { fontPx } = fieldLayoutPx(row, row.value || 'X');
      const ed = document.createElement(row.multiline ? 'textarea' : 'input');
      ed.className = 'scribe-field-input';
      ed.value = seed ?? (row.value || '');
      if (row.maxLen) ed.maxLength = row.maxLen;
      ed.style.fontSize = `${fontPx}px`;
      ed.style.padding = row.multiline ? `${2 * PX_PER_PT}px ${2 * PX_PER_PT}px` : `0 ${2 * PX_PER_PT}px`;
      if (row.quadding === 1) ed.style.textAlign = 'center';
      else if (row.quadding === 2) ed.style.textAlign = 'right';
      let closed = false;
      const close = (commit) => {
        if (closed) return;
        closed = true;
        const next = ed.value;
        ed.remove();
        if (commit && commitValue(viewer, row, next)) return; // committing re-renders the overlay, replacing `el`
        el.focus({ preventScroll: true });
      };
      ed.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(false);
        } else if (e.key === 'Enter' && !row.multiline) {
          e.preventDefault();
          close(true);
        }
      });
      ed.addEventListener('blur', () => close(true));
      el.appendChild(ed);
      ed.focus({ preventScroll: true });
      if (seed == null) {
        const end = ed.value.length;
        ed.setSelectionRange(end, end);
      }
    };

    el.addEventListener('click', () => {
      if (el.querySelector('.scribe-field-input')) return;
      el.focus({ preventScroll: true });
      activate(null);
    });
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || (e.key === ' ' && isToggle)) {
        e.preventDefault();
        e.stopPropagation();
        activate(null);
      } else if (!isToggle && row.fieldType !== 'choice' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        activate(e.key);
      }
    });
  }
}
