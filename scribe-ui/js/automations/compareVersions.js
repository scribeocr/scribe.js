// The Changes workspace of the Compare Versions mode, hosted in the Automate panel.
import ocr from '../../../js/objects/ocrObjects.js';

/**
 * Up to two words before and two after a change on one side, from the line it starts on.
 * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {import('../../../js/textDiff.js').TextDiffSide} s
 * @returns {{before: string, after: string}}
 */
function lineContext(doc, s) {
  const none = { before: '', after: '' };
  if (s.pageN == null || !s.wordIds.length) return none;
  const page = doc.ocr.active?.[s.pageN];
  if (!page) return none;
  const ids = new Set(s.wordIds);
  const line = page.lines.find((l) => l.words.some((w) => ids.has(w.id)));
  if (!line) return none;
  const first = line.words.findIndex((w) => ids.has(w.id));
  let last = first;
  while (last + 1 < line.words.length && ids.has(line.words[last + 1].id)) last += 1;
  return {
    before: line.words.slice(Math.max(0, first - 2), first).map((w) => w.text).join(' '),
    after: line.words.slice(last + 1, last + 3).map((w) => w.text).join(' '),
  };
}

/**
 * A row's lines as HTML.
 * @param {import('../../../js/textDiff.js').TextDiffChange} c
 * @param {[import('../../../js/containers/scribeDoc.js').ScribeDoc, import('../../../js/containers/scribeDoc.js').ScribeDoc]} docs
 * @returns {string}
 */
function rowLines(c, docs) {
  const mark = (/** @type {string} */ t) => `<span class="d">${ocr.escapeXml(t)}</span>`;
  if (c.kind === 'page') {
    const side = c.a.pageN != null ? 'a' : 'b';
    return `<span class="${side === 'a' ? 'o' : 'n'}">${mark(c[side].text.split(' ').slice(0, 14).join(' '))}</span>`;
  }
  // A replaced change's two wordings can share words, since the diff folds a lone equal word into the change around it.
  const aw = c.a.text ? c.a.text.split(' ') : []; const bw = c.b.text ? c.b.text.split(' ') : [];
  const ma = new Array(aw.length).fill(true); const mb = new Array(bw.length).fill(true);
  if (aw.length && bw.length) {
    const L = Array.from({ length: aw.length + 1 }, () => new Array(bw.length + 1).fill(0));
    for (let i = aw.length - 1; i >= 0; i--) for (let j = bw.length - 1; j >= 0; j--) L[i][j] = aw[i] === bw[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0; let j = 0;
    while (i < aw.length && j < bw.length) { if (aw[i] === bw[j]) { ma[i] = false; mb[j] = false; i += 1; j += 1; } else if (L[i + 1][j] >= L[i][j + 1]) i += 1; else j += 1; }
  }
  const wording = (/** @type {Array<string>} */ w, /** @type {Array<boolean>} */ mask) => {
    /** @type {Array<{d: boolean, t: Array<string>}>} */ const groups = [];
    w.forEach((word, k) => { const g = groups[groups.length - 1]; if (g && g.d === mask[k]) g.t.push(word); else groups.push({ d: mask[k], t: [word] }); });
    return groups.map((g) => (g.d ? mark(g.t.join(' ')) : ocr.escapeXml(g.t.join(' ')))).join(' ');
  };
  /**
   * @param {string} cls
   * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {import('../../../js/textDiff.js').TextDiffSide} s
   * @param {string} inner
   */
  const line = (cls, doc, s, inner) => {
    const around = lineContext(doc, s);
    return `<span class="${cls}">${around.before ? `${ocr.escapeXml(around.before)} ` : ''}${inner}${around.after ? ` ${ocr.escapeXml(around.after)}` : ''}</span>`;
  };
  return (c.a.wordIds.length ? line('o', docs[0], c.a, wording(aw, ma)) : '') + (c.b.wordIds.length ? line('n', docs[1], c.b, wording(bw, mb)) : '');
}

/**
 * Build the workspace in `container`.
 * @param {HTMLElement} container
 * @param {{diff: import('../../../js/textDiff.js').TextDiff, docs: [import('../../../js/containers/scribeDoc.js').ScribeDoc, import('../../../js/containers/scribeDoc.js').ScribeDoc],
 *   names: [string, string], onGo: (n: number) => void, current: number}} state
 * @returns {{setCurrent: (n: number) => void, setDiff: (diff: import('../../../js/textDiff.js').TextDiff) => void, teardown: () => void}}
 */
export function buildCompareWorkspace(container, state) {
  container.textContent = '';
  const body = document.createElement('div');
  body.className = 'scribe-am-cmp';
  container.appendChild(body);
  let { diff, current } = state;
  /** @type {Map<number, HTMLElement>} */
  const rows = new Map();

  const paint = () => {
    body.textContent = '';
    rows.clear();
    if (!diff.changes.length) {
      const none = document.createElement('div');
      none.className = 'scribe-am-empty';
      none.textContent = `${state.names[0]} and ${state.names[1]} read the same.`;
      body.appendChild(none);
      return;
    }
    const groupKey = (/** @type {import('../../../js/textDiff.js').TextDiffChange} */ x) => (x.kind === 'page' ? `page:${x.a.pageN}:${x.b.pageN}` : `${x.a.pageN ?? x.b.pageN}:${x.b.pageN ?? x.a.pageN}`);
    let lastKey = null;
    for (const c of diff.changes) {
      const key = groupKey(c);
      if (key !== lastKey) {
        lastKey = key;
        const grp = document.createElement('div');
        grp.className = 'scribe-am-cmp-grp';
        const pa = (c.a.pageN ?? c.b.pageN) + 1;
        const pb = (c.b.pageN ?? c.a.pageN) + 1;
        grp.textContent = c.kind === 'page' ? `Page ${pa} · ${c.a.pageN != null ? 'removed' : 'added'}` : pa === pb ? `Page ${pa}` : `Page ${pa} · ${pb}`;
        grp.addEventListener('click', () => state.onGo(c.n));
        body.appendChild(grp);
      }
      const row = document.createElement('div');
      row.className = `scribe-am-cmp-row ${c.kind === 'removed' || (c.kind === 'page' && c.a.pageN != null) ? 'k-removed' : 'k-added'}`;
      row.innerHTML = `<span class="kb"></span><span class="t">${rowLines(c, state.docs)}</span>`;
      row.addEventListener('click', () => state.onGo(c.n));
      body.appendChild(row);
      rows.set(c.n, row);
    }
    mark();
  };
  const mark = () => {
    for (const [n, row] of rows) row.classList.toggle('cur', n === current);
    const row = rows.get(current);
    if (row) {
      const top = row.offsetTop; const h = row.offsetHeight;
      if (top < body.scrollTop || top + h > body.scrollTop + body.clientHeight) body.scrollTop = top - body.clientHeight / 2;
    }
  };
  paint();
  return {
    setCurrent: (n) => { current = n; mark(); },
    setDiff: (next) => { diff = next; paint(); },
    teardown: () => { container.textContent = ''; rows.clear(); },
  };
}
