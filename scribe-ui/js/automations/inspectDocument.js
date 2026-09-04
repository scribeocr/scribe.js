// Local copy of the toolbar's lineIcon.
// Importing toolbar.js from here would pull the whole viewer into this lazy module.
const lineIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
const CHEVRON_SVG = lineIcon('<path d="M9 6l6 6-6 6"/>');
const PICK_SVG = lineIcon('<circle cx="12" cy="12" r="5.2"/><path d="M12 3.5V7M12 17v3.5M3.5 12H7M17 12h3.5"/>');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAPER_NAMES = {
  '612x792': 'Letter', '595x842': 'A4', '612x1008': 'Legal', '842x1191': 'A3', '420x595': 'A5', '792x1224': 'Tabloid',
};
const FILTER_LABELS = {
  DCTDecode: 'JPEG', JPXDecode: 'JPEG 2000', CCITTFaxDecode: 'CCITT fax', JBIG2Decode: 'JBIG2', FlateDecode: 'Flate', LZWDecode: 'LZW', RunLengthDecode: 'Run-length',
};
const STANDARD_INFO_KEYS = new Set(['Title', 'Author', 'Subject', 'Keywords', 'CreationDate', 'ModDate', 'Creator', 'Producer', 'Trapped']);
const IMAGE_ROW_LIMIT = 8;
const FONT_ROW_LIMIT = 10;
/** Rows one "Show more" adds. */
const ROW_STEP = 20;

/** Decimal units, so the figures agree with the file size operating systems report. */
const fmtBytes = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${Math.round(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * A PDF date ("D:20210128140332-05'00'") as "Jan 28, 2021, 14:03 (UTC-05)"; anything else is returned as written.
 * @param {string} s
 */
function fmtPdfDate(s) {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?([+\-Z])?(\d{2})?'?(\d{2})?/.exec(s || '');
  if (!m) return s || '';
  const [, y, mo, d, hh = '00', mm = '00', , sign, oh, om] = m;
  let out = `${MONTHS[+mo - 1] || mo} ${+d}, ${y}, ${hh}:${mm}`;
  if (sign && sign !== 'Z') out += ` (UTC${sign}${oh}${om && om !== '00' ? `:${om}` : ''})`;
  else if (sign === 'Z') out += ' (UTC)';
  return out;
}

/**
 * @param {number} w - Points.
 * @param {number} h - Points.
 */
function fmtPageSize(w, h) {
  const inches = (v) => (v / 72).toFixed(1).replace(/\.0$/, '');
  const name = PAPER_NAMES[`${w}x${h}`] || PAPER_NAMES[`${h}x${w}`] || null;
  return `${inches(w)} × ${inches(h)} in${name ? ` · ${name}` : ''}`;
}

/**
 * @param {import('../../../js/pdf/resourceInventory.js').InventoryImage} im
 */
function imageFormat(im) {
  const codec = FILTER_LABELS[im.filter || ''] || im.filter || 'Uncompressed';
  const cs = im.colorSpace || '';
  const depth = im.imageMask ? 'stencil' : im.bitsPerComponent === 1 ? '1-bit' : /RGB/.test(cs) ? 'RGB' : /Gray/.test(cs) ? 'gray' : /CMYK/.test(cs) ? 'CMYK' : /Indexed/.test(cs) ? 'indexed' : cs;
  return `${codec} · ${depth}`;
}

/**
 * @param {import('../../../js/pdf/resourceInventory.js').InventoryFont} f
 */
function fontTypeLabel(f) {
  const labels = {
    Type1: 'Type 1', TrueType: 'TrueType', Type0: f.cidSubtype === 'CIDFontType0' ? 'Type 0 (CFF)' : 'Type 0 (TrueType)', Type3: 'Type 3', MMType1: 'Type 1 (MM)',
  };
  const base = labels[f.subtype] || f.subtype || '?';
  return `${base}${f.subset ? ' (subset)' : ''}`;
}

/**
 * 1-based page numbers as ranges: "1–3, 7".
 * @param {number[]} pages - 0-based, ascending.
 * @param {number} pageCount
 */
function pagesLabel(pages, pageCount) {
  if (pages.length === pageCount && pageCount > 1) return 'all';
  if (pages.length > 4) return `${pages.length} pages`;
  const out = [];
  let start = pages[0]; let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    if (pages[i] === prev + 1) { prev = pages[i]; continue; }
    out.push(start === prev ? `${start + 1}` : `${start + 1}–${prev + 1}`);
    start = pages[i]; prev = pages[i];
  }
  return out.join(', ');
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {string} text */
const catHeader = (text) => el('div', 'scribe-am-cat', text);

/**
 * Two-column label/value rows. A null value reads "Not set"; `hideEmpty` drops such rows instead.
 * @param {Array<[string, ?string]>} rows
 * @param {boolean} [hideEmpty]
 */
function kvRows(rows, hideEmpty = false) {
  const grid = el('div', 'scribe-am-ins-rows');
  for (const [label, value] of rows) {
    const empty = value == null || value === '';
    if (empty && hideEmpty) continue;
    const row = el('div', 'scribe-am-ins-kv');
    row.append(el('div', 'scribe-am-ins-k', label));
    const v = el('div', 'scribe-am-ins-v');
    if (empty) v.append(el('span', 'scribe-am-ins-notset', 'Not set'));
    else v.textContent = value;
    row.append(v);
    grid.append(row);
  }
  return grid;
}

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const XMPMETA_NS = 'adobe:ns:meta/';

/**
 * @typedef {Object} XmpProp
 * @property {string} prefix - The namespace prefix as the packet wrote it.
 * @property {string} local
 * @property {string} uri - The schema's namespace URI.
 * @property {'text'|'seq'|'bag'|'alt'|'struct'} kind
 * @property {string} [value]
 * @property {Array<{kind: 'text'|'struct', lang: ?string, value?: string, fields?: XmpProp[]}>} [items]
 * @property {XmpProp[]} [fields]
 */

/**
 * The properties of an XMP packet, in packet order, with the toolkit that wrote it and its root element.
 * @param {string} text
 * @returns {?{props: XmpProp[], blocks: number, tk: ?string, root: Element}} null when the packet is not well-formed XML.
 */
function readXmp(text) {
  const dom = new DOMParser().parseFromString(text, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length) return null;
  const props = [];
  let blocks = 0;
  for (const rdf of dom.getElementsByTagNameNS(RDF_NS, 'RDF')) {
    for (const d of rdf.children) {
      if (d.namespaceURI !== RDF_NS || d.localName !== 'Description') continue;
      blocks += 1;
      props.push(...xmpFields(d));
    }
  }
  const root = dom.getElementsByTagNameNS(XMPMETA_NS, 'xmpmeta')[0] || dom.documentElement;
  const tk = root.getAttributeNS(XMPMETA_NS, 'xmptk');
  return {
    props, blocks, tk: tk ? tk.trim() : null, root,
  };
}

/**
 * The packet as indented XML, under the writer's own element names.
 * @param {Element} root
 * @returns {HTMLElement}
 */
function xmpXml(root) {
  const out = el('div', 'scribe-am-ins-xml');
  const walk = (elem, depth) => {
    const pad = '  '.repeat(depth);
    const kids = [...elem.children];
    const text = kids.length ? '' : (elem.textContent || '').trim();
    const open = el('span', 't');
    open.append(document.createTextNode('<'), el('span', 'n', elem.tagName));
    for (const a of elem.attributes) open.append(document.createTextNode(` ${a.name}="`), el('span', 'a', a.value), document.createTextNode('"'));
    open.append(document.createTextNode(kids.length || text ? '>' : '/>'));
    out.append(document.createTextNode(pad), open);
    if (!kids.length) {
      if (text) out.append(el('span', 'v', text), el('span', 't', `</${elem.tagName}>`));
      out.append(document.createTextNode('\n'));
      return;
    }
    out.append(document.createTextNode('\n'));
    for (const c of kids) walk(c, depth + 1);
    out.append(document.createTextNode(pad), el('span', 't', `</${elem.tagName}>`), document.createTextNode('\n'));
  };
  walk(root, 0);
  return out;
}

/**
 * A description's or structure's properties.
 * XMP lets a property be written as an attribute of its parent instead of a child element, so both forms are read.
 * @param {Element} elem
 * @returns {XmpProp[]}
 */
function xmpFields(elem) {
  const out = [];
  for (const a of elem.attributes) {
    if (a.namespaceURI === RDF_NS || a.namespaceURI === XML_NS || a.namespaceURI === XMLNS_NS) continue;
    out.push({
      prefix: a.prefix || '', local: a.localName, uri: a.namespaceURI || '', kind: 'text', value: a.value,
    });
  }
  for (const c of elem.children) if (c.namespaceURI !== RDF_NS) out.push(xmpProp(c));
  return out;
}

/**
 * @param {Element} elem - A property element.
 * @returns {XmpProp}
 */
function xmpProp(elem) {
  const base = { prefix: elem.prefix || '', local: elem.localName, uri: elem.namespaceURI || '' };
  if (elem.getAttributeNS(RDF_NS, 'parseType') === 'Resource') return { ...base, kind: 'struct', fields: xmpFields(elem) };
  const rdfChild = (name) => [...elem.children].find((c) => c.namespaceURI === RDF_NS && c.localName === name);
  const arr = rdfChild('Seq') || rdfChild('Bag') || rdfChild('Alt');
  if (arr) {
    const items = [...arr.children].filter((li) => li.namespaceURI === RDF_NS && li.localName === 'li').map(xmpItem);
    return { ...base, kind: /** @type {'seq'|'bag'|'alt'} */ (arr.localName.toLowerCase()), items };
  }
  const desc = rdfChild('Description');
  if (desc) return { ...base, kind: 'struct', fields: xmpFields(desc) };
  if (elem.children.length) return { ...base, kind: 'struct', fields: xmpFields(elem) };
  return { ...base, kind: 'text', value: (elem.textContent || '').trim() };
}

/**
 * @param {Element} li - An array entry.
 * @returns {{kind: 'text'|'struct', lang: ?string, value?: string, fields?: XmpProp[]}}
 */
function xmpItem(li) {
  const lang = li.getAttributeNS(XML_NS, 'lang') || null;
  const desc = [...li.children].find((c) => c.namespaceURI === RDF_NS && c.localName === 'Description');
  const attrProps = [...li.attributes].some((a) => a.namespaceURI !== RDF_NS && a.namespaceURI !== XML_NS && a.namespaceURI !== XMLNS_NS);
  if (li.getAttributeNS(RDF_NS, 'parseType') === 'Resource' || li.children.length || attrProps) return { kind: 'struct', lang, fields: xmpFields(desc || li) };
  return { kind: 'text', lang, value: (li.textContent || '').trim() };
}

/**
 * A packet's properties as rows under a header per schema, each named as the packet names it, each value as stored.
 * A structure, or a list of them, opens under its own row.
 * @param {XmpProp[]} props
 * @returns {DocumentFragment}
 */
function xmpRows(props) {
  const out = document.createDocumentFragment();
  const groups = new Map();
  for (const p of props) {
    const key = p.uri || p.prefix;
    if (!groups.has(key)) groups.set(key, { prefix: p.prefix, uri: p.uri, props: [] });
    groups.get(key).props.push(p);
  }
  for (const g of groups.values()) {
    const hd = el('div', 'scribe-am-ins-schema', g.prefix || 'no prefix');
    if (g.uri) hd.append(el('span', '', ` · ${g.uri}`));
    out.append(hd, xmpGrid(g.props));
  }
  return out;
}

/**
 * @param {XmpProp[]} props
 * @returns {HTMLElement}
 */
function xmpGrid(props) {
  const grid = el('div', 'scribe-am-ins-rows');
  for (const p of props) {
    const row = el('div', 'scribe-am-ins-kv scribe-am-ins-tech');
    const k = el('div', 'scribe-am-ins-k');
    k.append(document.createTextNode(`${p.prefix}:`), document.createElement('wbr'), document.createTextNode(p.local));
    const v = el('div', 'scribe-am-ins-v');
    const items = p.kind === 'struct' ? [{ kind: 'struct', lang: null, fields: p.fields }] : (p.items || []);
    if (p.kind === 'struct' || items.some((it) => it.kind === 'struct')) {
      row.classList.add('scribe-am-ins-xrow');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('aria-expanded', 'false');
      const tw = el('span', 'scribe-am-ins-tw');
      tw.innerHTML = CHEVRON_SVG;
      v.append(tw, document.createTextNode(p.kind === 'struct' ? `${items[0].fields.length} field${items[0].fields.length === 1 ? '' : 's'}` : `${items.length} entr${items.length === 1 ? 'y' : 'ies'}`));
      const nest = el('div', 'scribe-am-ins-nest');
      nest.hidden = true;
      items.forEach((it, i) => {
        if (items.length > 1) nest.append(el('div', 'scribe-am-ins-nest-hd', `${p.local} ${i + 1}`));
        nest.append(it.kind === 'text' ? kvRows([['', it.value || null]]) : xmpGrid(it.fields || []));
      });
      const toggle = () => {
        const open = nest.hidden;
        nest.hidden = !open;
        row.classList.toggle('open', open);
        row.setAttribute('aria-expanded', String(open));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      row.append(k, v);
      grid.append(row, nest);
      continue;
    }
    let text = '';
    let lang = null;
    if (p.kind === 'text') text = p.value || '';
    else if (p.kind === 'alt') {
      const it = items.find((x) => x.lang === 'x-default') || items[0];
      if (it) { text = it.value || ''; lang = it.lang; }
    } else text = items.filter((x) => x.kind === 'text' && x.value).map((x) => x.value).join(', ');
    if (text) {
      v.append(document.createTextNode(text));
      if (lang) v.append(el('span', 'scribe-am-ins-lang', ` · ${lang}`));
      if (p.kind === 'alt' && items.length > 1) v.append(el('span', 'scribe-am-ins-lang', ` · +${items.length - 1} more`));
    } else v.append(el('span', 'scribe-am-ins-notset', 'Not set'));
    row.append(k, v);
    grid.append(row);
  }
  return grid;
}

/**
 * Build the workspace into `container`.
 * @param {import('./registry.js').AutomationHost} host
 * @param {HTMLElement} container
 * @returns {{refresh: () => void, teardown: () => void, pageChanged: () => void, selectWord: (n: number, wordId: string) => boolean,
 *   clearPin: () => boolean, hasPin: () => boolean, armedChanged: (on: boolean) => void}}
 */
export function buildInspectWorkspace(host, container) {
  const { viewer } = host;
  container.textContent = '';
  const body = el('div', 'scribe-am-ins');
  container.appendChild(body);

  /** @type {?import('../../../js/pdf/resourceInventory.js').ResourceInventory} */
  let inv = null;
  let invTimer = 0;
  let scope = 'page';
  let curPage = viewer.state.cp.n;
  let shownImages = IMAGE_ROW_LIMIT;
  let shownFonts = FONT_ROW_LIMIT;
  /** @type {?HTMLButtonElement} The Fonts group's "Identify font" control, rebuilt with the group. */
  let pickBtn = null;
  /** Fonts whose detail rows are open, by identity (program object number or name). */
  const openFonts = new Set();
  let xmpOpen = false;
  let xmlOpen = false;
  /** @type {?string} The packet text `xmpParsed` was read from. */
  let xmpSource = null;
  /** @type {?ReturnType<typeof readXmp>} */
  let xmpParsed = null;
  /** @type {?import('../../../js/pdf/resourceInventory.js').InventoryFont} */
  let pinnedFont = null;
  /** @type {?import('../../../js/pdf/resourceInventory.js').InventoryFont} */
  let hoverFont = null;
  /** @type {Array<any>} UI words currently washed. */
  let washed = [];
  const radioName = `scribe-am-ins-scope-${Math.random().toString(36).slice(2, 8)}`;
  const fontKey = (f) => (f.programObjNum != null ? `p${f.programObjNum}` : `n-${f.name}-${f.fontObjNums[0]}`);

  /** Wash the words drawn with `font` in every rendered page; null clears. */
  const applyWash = (font) => {
    for (const kw of washed) kw.fillBox = false;
    washed = [];
    const doc = viewer.doc;
    if (!font || !doc) return;
    for (const kw of viewer.getUiWords()) {
      const page = kw.word?.line?.page;
      if (!page || page.textSource !== 'pdf') continue;
      const entry = doc.nativeText.pages[page.n]?.[kw.word.id];
      if (!entry || entry.fontObjNum == null || !font.fontObjNums.includes(entry.fontObjNum)) continue;
      kw.fillBox = true;
      washed.push(kw);
    }
  };

  /**
   * A line of the words this font drew, in the document's own face once the renderer has rebuilt it; null when no text used it.
   * @param {import('../../../js/pdf/resourceInventory.js').InventoryFont} f
   * @param {(program: ?import('../../../js/pdf/glyphResolve.js').EditFontProgram) => void} onProgram - Called once the program has settled.
   */
  const sampleFor = (f, onProgram) => {
    const doc = viewer.doc;
    if (!doc?.ocr?.active) return null;
    const words = [];
    let firstPage = -1;
    for (const p of f.pages.slice(0, 3)) {
      const page = doc.ocr.active[p];
      if (!page || page.textSource !== 'pdf') continue;
      const nt = doc.nativeText.pages[p] || {};
      for (const line of page.lines) {
        for (const w of line.words) {
          if (nt[w.id]?.fontObjNum == null || !f.fontObjNums.includes(nt[w.id].fontObjNum)) continue;
          words.push(w.text);
          if (firstPage < 0) firstPage = p;
          if (words.join(' ').length > 48) break;
        }
        if (words.join(' ').length > 48) break;
      }
      if (words.length) break;
    }
    if (!words.length) return null;
    const line = el('div', 'scribe-am-ins-sample', words.join(' '));
    const fontObjNum = f.fontObjNums[0];
    Promise.resolve(doc.images.getEditFont(firstPage, fontObjNum)).then((ef) => {
      if (ef?.faceName && line.isConnected) line.style.fontFamily = `'${ef.faceName}'`;
      onProgram(ef?.program || null);
    }).catch(() => onProgram(null));
    return line;
  };

  const documentGroup = () => {
    const doc = viewer.doc;
    const isPdf = !!doc?.images?.pdfData;
    const meta = isPdf ? doc.getMetadata() : null;
    const info = meta?.info || {};
    const name = doc?.inputData?.inputFileNames?.[0] || null;
    const pageCount = doc ? doc.pageMetrics.length : 0;
    /** @type {Array<[string, ?string]>} */
    const rows = [['Name', name]];
    if (isPdf) {
      rows.push(['Kind', `PDF${inv?.version ? ` ${inv.version}` : ''}`]);
      rows.push(['Size', `${fmtBytes(doc.images.pdfData.byteLength)} (${fmtInt(doc.images.pdfData.byteLength)} bytes)`]);
      rows.push(['Pages', String(pageCount)]);
      const stats = doc.inputData.pageStats || [];
      const counts = new Map();
      for (const ps of stats) { if (!ps?.pageSize) continue; const k = `${ps.pageSize[0]}x${ps.pageSize[1]}`; counts.set(k, (counts.get(k) || 0) + 1); }
      const sizes = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => {
        const [w, h] = k.split('x').map(Number);
        return counts.size > 1 ? `${PAPER_NAMES[`${w}x${h}`] || fmtPageSize(w, h)} ×${c}` : fmtPageSize(w, h);
      });
      rows.push(['Page size', sizes.length ? sizes.join(', ') : null]);
      rows.push(['Title', info.Title || null], ['Author', info.Author || null], ['Subject', info.Subject || null], ['Keywords', info.Keywords || null]);
      rows.push(['Created', info.CreationDate ? fmtPdfDate(info.CreationDate) : null], ['Modified', info.ModDate ? fmtPdfDate(info.ModDate) : null]);
      rows.push(['Application', info.Creator || null], ['PDF producer', info.Producer || null]);
      for (const [k, v] of Object.entries(info)) if (!STANDARD_INFO_KEYS.has(k) && typeof v === 'string') rows.push([k, v]);
    } else if (doc) {
      const src = doc.images.nativeSrc?.[0];
      const format = src?.format ? src.format.toUpperCase() : null;
      rows.push(['Kind', format ? `${format} image` : 'Image']);
      // No original file bytes survive an image import; the stored data URL is the same encoding when the file was PNG or JPEG.
      const dataUrl = src?.src;
      const approxBytes = dataUrl ? Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4) : null;
      rows.push(['Size', approxBytes != null ? `${fmtBytes(approxBytes)} (${fmtInt(approxBytes)} bytes)` : null]);
      rows.push(['Pages', String(pageCount)]);
      const dims = doc.pageMetrics[0]?.dims;
      rows.push(['Page size', dims ? `${Math.round(dims.width)} × ${Math.round(dims.height)} px` : null]);
    }
    const frag = document.createDocumentFragment();
    frag.append(catHeader('Document'), kvRows(rows));
    if (isPdf) {
      const encrypted = !!meta?.encrypted;
      const perms = inv?.permissions;
      const allowed = perms ? [perms.print && 'printing', perms.copy && 'copying', perms.modify && 'editing', perms.annotate && 'annotating'].filter(Boolean) : null;
      const permText = !encrypted ? 'All allowed' : allowed ? (allowed.length ? allowed.map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s)).join(', ') : 'None') : null;
      frag.append(catHeader('Security'), kvRows([
        ['Encryption', encrypted ? 'Encrypted' : 'None'],
        ['Permissions', permText],
        ['Signatures', meta?.signatures?.length ? String(meta.signatures.length) : null],
      ]));
    }
    /** @type {Array<[string, ?string]>} */
    const contents = [];
    if (isPdf) {
      const stats = doc.inputData.pageStats;
      const type = doc.inputData.pdfType;
      if (stats) {
        const textPages = stats.filter((p) => p && p.visibleReadableChars >= 100).length;
        const scanPages = stats.filter((p) => p && p.largestImageFrac >= 0.95).length;
        const stampNote = textPages ? ` (${textPages} page${textPages > 1 ? 's' : ''} with stamps only)` : '';
        const textKind = type === 'text' ? `Native text on ${textPages} of ${pageCount} pages` : type === 'ocr' ? `OCR layer on ${pageCount} pages` : `No usable text${stampNote}`;
        contents.push(['Text', textKind]);
        contents.push(['Scanned pages', scanPages ? `${scanPages} of ${pageCount}` : null]);
      }
      const countNodes = (nodes) => nodes.reduce((a, n) => a + 1 + (n.children ? countNodes(n.children) : 0), 0);
      const bookmarks = countNodes(doc.outline || []);
      const annots = (doc.annotations?.pages || []).flat();
      const comments = annots.filter((a) => a.type !== 'field' && a.type !== 'link').length;
      const fields = annots.filter((a) => a.type === 'field').length;
      contents.push(['Bookmarks', bookmarks ? String(bookmarks) : null], ['Comments', comments ? String(comments) : null], ['Form fields', fields ? String(fields) : null]);
      contents.push(['Attachments', meta?.embeddedFiles?.length ? String(meta.embeddedFiles.length) : null]);
      contents.push(['Tagged (accessible)', meta?.structTree ? 'Yes' : 'No']);
      contents.push(['Document ID', meta?.docId ? String(meta.docId).replace(/[<>()]/g, '') : null]);
      contents.push(['Saved versions', meta?.priorRevisions ? `${meta.priorRevisions + 1} (${meta.priorRevisions} prior revision${meta.priorRevisions > 1 ? 's' : ''} kept)` : null]);
    } else if (doc) {
      contents.push(['Text', doc.inputData.ocrApplied ? 'Recognized' : 'None yet — run Recognize Text']);
    }
    const packet = isPdf && meta?.xmp?.catalog && meta.xmp.catalog !== '(unreadable)' ? meta.xmp.catalog : null;
    if (packet && packet !== xmpSource) { xmpSource = packet; xmpParsed = readXmp(packet); }
    const xmp = packet ? xmpParsed : null;
    if (packet && !xmp) contents.splice(contents.findIndex(([l]) => l === 'Document ID'), 0, ['XMP metadata', `${fmtInt(meta.xmp.catalogBytes)} bytes`]);
    const grid = kvRows(contents, true);
    if (xmp) {
      const n = xmp.props.length;
      const row = el('div', 'scribe-am-ins-kv scribe-am-ins-xrow');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('aria-expanded', String(xmpOpen));
      row.classList.toggle('open', xmpOpen);
      const v = el('div', 'scribe-am-ins-v');
      const tw = el('span', 'scribe-am-ins-tw');
      tw.innerHTML = CHEVRON_SVG;
      v.append(tw, document.createTextNode(`${fmtInt(n)} field${n === 1 ? '' : 's'} · ${fmtBytes(meta.xmp.catalogBytes)}`));
      row.append(el('div', 'scribe-am-ins-k', 'XMP metadata'), v);
      const block = el('div', 'scribe-am-ins-xmp');
      block.hidden = !xmpOpen;
      const fill = () => {
        const line = el('div', 'scribe-am-ins-xmlline');
        const tk = xmp.tk ? (/^(Adobe XMP Core \d+(?:\.\d+)?)/.exec(xmp.tk)?.[1] || xmp.tk.split(',')[0].trim()) : null;
        line.append(el('span', '', `${fmtBytes(meta.xmp.catalogBytes)} · ${xmp.blocks} block${xmp.blocks === 1 ? '' : 's'}${tk ? ` · ${tk}` : ''}`));
        const link = el('a', 'scribe-am-ins-more-link', xmlOpen ? 'Hide XML' : 'Show XML');
        link.href = '#';
        let xmlElem = xmlOpen ? xmpXml(xmp.root) : null;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          xmlOpen = !xmlOpen;
          link.textContent = xmlOpen ? 'Hide XML' : 'Show XML';
          if (!xmlOpen) { xmlElem?.remove(); return; }
          if (!xmlElem) xmlElem = xmpXml(xmp.root);
          line.after(xmlElem);
        });
        line.append(link);
        block.append(xmpRows(xmp.props), line);
        if (xmlElem) line.after(xmlElem);
      };
      if (xmpOpen) fill();
      const toggle = () => {
        xmpOpen = !xmpOpen;
        block.hidden = !xmpOpen;
        row.classList.toggle('open', xmpOpen);
        row.setAttribute('aria-expanded', String(xmpOpen));
        if (xmpOpen && !block.firstChild) fill();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      const anchor = [...grid.children].find((r) => /^(Document ID|Saved versions)$/.test(r.firstChild?.textContent || '')) || null;
      grid.insertBefore(row, anchor);
      grid.insertBefore(block, anchor);
    }
    frag.append(catHeader('Contents'), grid);
    return frag;
  };

  /** The scope row, Size group, Images and Fonts, for the current scope. */
  const inventoryGroups = () => {
    const doc = viewer.doc;
    const frag = document.createDocumentFragment();
    if (!doc?.images?.pdfData) {
      frag.append(catHeader('Fonts'), el('div', 'scribe-am-empty scribe-am-ins-empty', 'Images have no fonts.'));
      return frag;
    }
    const opts = el('div', 'scribe-am-opts scribe-am-ins-scope');
    [['page', `This page (${curPage + 1})`], ['doc', 'Whole document']].forEach(([value, label]) => {
      const lab = el('label', 'scribe-am-check');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = radioName; input.value = value; input.checked = scope === value;
      input.addEventListener('change', () => { scope = value; paintInventory(); });
      lab.append(input, document.createTextNode(label));
      opts.append(lab);
    });
    frag.append(opts);
    if (!inv) {
      frag.append(catHeader('Size'), el('div', 'scribe-am-empty scribe-am-ins-empty', 'Measuring…'));
      return frag;
    }
    const pageCount = inv.pageCount;
    const perPage = inv.perPage[curPage] || { images: [], fonts: [], contentBytes: 0 };
    const pageImages = perPage.images.map((i) => inv.images[i]);
    const pageFonts = perPage.fonts.map((i) => inv.fonts[i]);
    const docScope = scope === 'doc';
    // Size: five categories that sum to the file, or the page's share of it.
    const sizeRows = (rows, total) => {
      const wrap = el('div', 'scribe-am-ins-size');
      for (const [label, bytes, count] of rows) {
        const line = el('div', 'scribe-am-ins-cat');
        const l = el('span', 'scribe-am-ins-cat-l', label);
        if (count != null) l.append(el('span', 'scribe-am-ins-cat-n', ` · ${count}`));
        line.append(l, el('span', 'scribe-am-ins-cat-b', fmtBytes(bytes)), el('span', 'scribe-am-ins-cat-p', `${total ? Math.round((bytes / total) * 100) : 0}%`));
        const bar = el('div', 'scribe-am-bar scribe-am-ins-bar');
        const fill = document.createElement('i');
        fill.style.width = `${bytes > 0 && total ? Math.max(1, (bytes / total) * 100).toFixed(1) : 0}%`;
        bar.append(fill);
        wrap.append(line, bar);
      }
      return wrap;
    };
    if (docScope) {
      const k = inv.bytesByKind; const c = inv.countByKind;
      frag.append(catHeader(`Size · ${fmtBytes(inv.fileBytes)}`), sizeRows([['Images', k.images, c.images], ['Embedded fonts', k.fonts, c.fonts], ['Vector drawings', k.drawings, c.drawings], ['Page content', k.content, c.content], ['Structure & other', k.other, null]], inv.fileBytes));
    } else {
      const imageBytes = pageImages.reduce((a, im) => a + im.bytes, 0);
      const fontBytes = pageFonts.reduce((a, f) => a + f.bytes, 0);
      frag.append(catHeader(`Size · page ${curPage + 1}: ${fmtBytes(imageBytes + fontBytes + perPage.contentBytes)} of ${fmtBytes(inv.fileBytes)}`), sizeRows([['Images on this page', imageBytes, pageImages.length], ['Embedded fonts here', fontBytes, pageFonts.filter((f) => f.embedded).length], ['Page content', perPage.contentBytes, null]], inv.fileBytes), el('div', 'scribe-am-ins-note', 'Shares of the whole file. A font counts in full on every page that uses it.'));
    }
    /** Scroll the panel so a group header sits at the top, after a list folds back. */
    const scrollToHeader = (hdr) => {
      const top = hdr.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      body.scrollTop = Math.max(0, top - 2);
    };
    /**
     * A list's footers: "N more · Show 20 more · Show all" while rows are hidden, and "Showing k of N · Show fewer" once it has grown past its limit.
     * The fold-back footer sticks to the panel's bottom edge, so the way back stays on screen however long the list is.
     * @param {number} total
     * @param {number} shown
     * @param {number} base
     * @param {(n: number) => void} setShown
     * @param {HTMLElement} hdr - The group header a fold scrolls back to.
     */
    const listFooters = (total, shown, base, setShown, hdr) => {
      const out = document.createDocumentFragment();
      const linkTo = (text, n, fold) => {
        const a = el('a', 'scribe-am-ins-more-link', text);
        a.href = '#';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          setShown(n);
          paintInventory();
          if (fold) { const next = [...body.querySelectorAll('.scribe-am-cat')].find((c) => c.textContent === hdr.textContent); if (next) scrollToHeader(next); }
        });
        return a;
      };
      if (shown > base) {
        const fewer = el('div', 'scribe-am-ins-fewer');
        fewer.append(el('span', '', `Showing ${fmtInt(Math.min(shown, total))} of ${fmtInt(total)}`), linkTo('Show fewer', base, true));
        out.append(fewer);
      }
      if (shown < total) {
        const more = el('div', 'scribe-am-ins-more', `${fmtInt(total - shown)} more · `);
        more.append(linkTo(`Show ${Math.min(ROW_STEP, total - shown)} more`, shown + ROW_STEP, false), document.createTextNode(' · '), linkTo(`Show all ${fmtInt(total)}`, total, false));
        out.append(more);
      }
      return out;
    };
    const images = docScope ? inv.images : pageImages;
    const imagesHdr = catHeader(`Images${images.length ? ` · ${fmtInt(images.length)}` : ''}`);
    frag.append(imagesHdr);
    if (!images.length) frag.append(el('div', 'scribe-am-empty scribe-am-ins-empty', docScope ? 'No images in this document.' : `No images on page ${curPage + 1}.`));
    else {
      const table = el('table', 'scribe-am-ins-tbl');
      const widths = docScope ? [30, 34, 19, 17] : [32, 44, 24];
      const cols = el('colgroup');
      for (const w of widths) { const col = el('col'); col.style.width = `${w}%`; cols.append(col); }
      const head = el('thead'); const hr = el('tr');
      hr.append(el('th', '', 'Pixels'), el('th', '', 'Format'), el('th', 'num', 'Size'));
      if (docScope) hr.append(el('th', 'num', 'Page'));
      head.append(hr);
      const tbody = el('tbody');
      const shown = images.slice(0, shownImages);
      for (const im of shown) {
        const tr = el('tr');
        tr.append(el('td', '', `${im.width} × ${im.height}`), el('td', '', imageFormat(im)), el('td', 'num', fmtBytes(im.bytes)));
        if (docScope) tr.append(el('td', 'num', pagesLabel(im.pages, pageCount)));
        tbody.append(tr);
      }
      table.append(cols, head, tbody);
      // The list and its sticky footer share a wrapper, so the footer un-sticks where the list ends.
      const list = el('div', 'scribe-am-ins-list');
      list.append(table, listFooters(images.length, shownImages, IMAGE_ROW_LIMIT, (n) => { shownImages = n; }, imagesHdr));
      frag.append(list);
    }
    const fonts = docScope ? inv.fonts : pageFonts;
    const fontsHdr = catHeader(`Fonts${fonts.length ? ` · ${fmtInt(fonts.length)}` : ''}`);
    const fontsHead = el('div', 'scribe-am-ins-cathd');
    fontsHead.append(fontsHdr);
    const tool = host.app?._inspectTool;
    if (tool?.setArmed && fonts.length) {
      pickBtn = el('button', 'scribe-am-ins-pick');
      pickBtn.type = 'button';
      pickBtn.title = 'Identify a font by clicking a word on the page';
      pickBtn.innerHTML = `<span class="scribe-am-ins-pick-ic">${PICK_SVG}</span><span>Identify font</span>`;
      const on = !!tool.isArmed?.();
      pickBtn.classList.toggle('on', on);
      pickBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      pickBtn.addEventListener('click', () => tool.setArmed(!tool.isArmed()));
      fontsHead.append(pickBtn);
    } else pickBtn = null;
    frag.append(fontsHead);
    if (!fonts.length) frag.append(el('div', 'scribe-am-empty scribe-am-ins-empty', docScope ? 'No fonts in this document.' : `No fonts on page ${curPage + 1}.`));
    else {
      const table = el('table', 'scribe-am-ins-tbl scribe-am-ins-fonts');
      const widths = docScope ? [34, 21, 13, 16, 16] : [40, 24, 16, 20];
      const cols = el('colgroup');
      for (const w of widths) { const col = el('col'); col.style.width = `${w}%`; cols.append(col); }
      const head = el('thead'); const hr = el('tr');
      hr.append(el('th', '', 'Name'), el('th', '', 'Type'), el('th', '', 'Emb.'), el('th', 'num', 'Size'));
      if (docScope) hr.append(el('th', 'num', 'Pages'));
      head.append(hr);
      const tbody = el('tbody');
      const shown = fonts.slice(0, shownFonts);
      shown.forEach((f) => {
        const key = fontKey(f);
        const tr = el('tr', 'x');
        tr.dataset.font = key;
        if (openFonts.has(key)) tr.classList.add('open');
        if (pinnedFont === f) tr.classList.add('sel');
        const nameCell = el('td', 'scribe-am-ins-name');
        const tw = el('span', 'scribe-am-ins-tw'); tw.innerHTML = CHEVRON_SVG;
        nameCell.append(tw, document.createTextNode(f.baseName));
        const emb = el('td', `scribe-am-ins-emb ${f.embedded ? 'yes' : 'no'}`, f.embedded ? 'Yes' : 'No');
        tr.append(nameCell, el('td', '', fontTypeLabel(f)), emb, el('td', 'num', f.embedded ? fmtBytes(f.bytes) : '—'));
        if (docScope) tr.append(el('td', 'num', pagesLabel(f.pages, pageCount)));
        const det = el('tr', 'scribe-am-ins-det');
        det.hidden = !openFonts.has(key);
        const cell = el('td'); cell.colSpan = docScope ? 5 : 4;
        det.append(cell);
        // The detail fetches the font's program for its sample, so it is built the first time the row opens.
        const buildDetail = () => {
          /** @type {Array<[string, ?string]>} */
          const rows = [
            ['PostScript name', f.baseName],
            ['Type', fontTypeLabel(f)],
            ['Embedded', f.embedded ? `Yes · ${fmtBytes(f.bytes)}` : 'No · shown with a substitute'],
            ['Encoding', f.encoding],
            ['Unicode mapping', f.toUnicode ? 'Present (ToUnicode)' : 'None — copied text may not match'],
          ];
          if (f.flags != null) {
            const flags = [
              f.flags & 1 && 'Fixed pitch', f.flags & 2 && 'Serif', f.flags & 4 && 'Symbolic',
              f.flags & 64 && `Italic${f.italicAngle ? ` (${f.italicAngle}°)` : ''}`, f.flags & 262144 && 'Bold',
            ].filter(Boolean).join(', ');
            rows.push(['Style flags', flags || 'None']);
          }
          rows.push(['Used on pages', pagesLabel(f.pages, pageCount)]);
          const grid = kvRows(rows);
          // The glyph count comes from the program the sample line is drawn with, so no font is read for a row nobody opened.
          // A rebuilt program holds only the glyphs the document's encoding reaches, which is what its label says.
          const sample = sampleFor(f, (program) => {
            const n = program?.font?.numGlyphs;
            if (typeof n === 'number' && grid.isConnected) grid.insertBefore(kvRows([[program.kind === 'rebuilt' ? 'Glyphs in use' : 'Glyphs', fmtInt(n)]]).firstElementChild, grid.lastElementChild);
          });
          if (sample) cell.append(sample);
          cell.append(grid);
        };
        if (openFonts.has(key)) buildDetail();
        tr.addEventListener('click', () => {
          if (openFonts.has(key)) openFonts.delete(key); else openFonts.add(key);
          tr.classList.toggle('open', openFonts.has(key));
          det.hidden = !openFonts.has(key);
          if (openFonts.has(key) && !cell.firstChild) buildDetail();
        });
        tr.addEventListener('mouseenter', () => { hoverFont = f; if (!pinnedFont) applyWash(f); });
        tr.addEventListener('mouseleave', () => { if (hoverFont === f) hoverFont = null; if (!pinnedFont) applyWash(null); });
        tbody.append(tr, det);
      });
      table.append(cols, head, tbody);
      const list = el('div', 'scribe-am-ins-list');
      list.append(table, listFooters(fonts.length, shownFonts, FONT_ROW_LIMIT, (n) => { shownFonts = n; }, fontsHdr));
      frag.append(list);
    }
    return frag;
  };

  let docPart = null;
  let invPart = null;
  const paintInventory = () => {
    const next = el('div', 'scribe-am-ins-part');
    next.append(inventoryGroups());
    if (invPart) invPart.replaceWith(next); else body.append(next);
    invPart = next;
  };
  const paintDocument = () => {
    const next = el('div', 'scribe-am-ins-part');
    next.append(documentGroup());
    if (docPart) docPart.replaceWith(next); else body.prepend(next);
    docPart = next;
  };
  const paint = () => {
    curPage = viewer.state.cp.n;
    paintDocument();
    paintInventory();
    // The inventory reads the whole file once per document; the document facts paint first so the panel never opens blank.
    if (!inv && viewer.doc?.images?.pdfData && !invTimer) {
      invTimer = setTimeout(() => {
        invTimer = 0;
        if (!viewer.doc) return;
        inv = viewer.doc.getResourceInventory();
        paintDocument();
        paintInventory();
      }, 0);
    }
  };
  paint();

  return {
    /** Rebuild against the (possibly new) active document. */
    refresh: () => {
      inv = null; pinnedFont = null; hoverFont = null; openFonts.clear(); xmpOpen = false; xmlOpen = false; shownImages = IMAGE_ROW_LIMIT; shownFonts = FONT_ROW_LIMIT;
      applyWash(null);
      if (invTimer) { clearTimeout(invTimer); invTimer = 0; }
      paint();
    },
    teardown: () => {
      if (invTimer) { clearTimeout(invTimer); invTimer = 0; }
      pinnedFont = null; hoverFont = null;
      applyWash(null);
    },
    /** The navigation cursor moved, or the window re-rendered: refresh the page-scoped groups and the wash. */
    pageChanged: () => {
      const n = viewer.state.cp.n;
      if (n !== curPage) {
        curPage = n;
        if (invPart) paintInventory();
      }
      if (pinnedFont || hoverFont) applyWash(pinnedFont || hoverFont);
    },
    /**
     * The mode's pick landed on a word: pin the font that drew it, open its row and wash its words.
     * @param {number} n - 0-based page.
     * @param {string} wordId
     * @returns {boolean} Whether the word maps to a font in the inventory.
     */
    selectWord: (n, wordId) => {
      const doc = viewer.doc;
      if (!doc || !inv) return false;
      const page = doc.ocr?.active?.[n];
      const entry = page && page.textSource === 'pdf' ? doc.nativeText.pages[n]?.[wordId] : null;
      if (!entry || entry.fontObjNum == null) return false;
      const font = inv.fonts.find((f) => f.fontObjNums.includes(entry.fontObjNum));
      if (!font) return false;
      if (scope === 'page' && !font.pages.includes(curPage)) scope = 'doc';
      const idx = (scope === 'doc' ? inv.fonts : inv.perPage[curPage].fonts.map((i) => inv.fonts[i])).indexOf(font);
      if (idx >= shownFonts) shownFonts = idx + 1;
      pinnedFont = font;
      openFonts.add(fontKey(font));
      paintInventory();
      const row = body.querySelector(`tr[data-font="${fontKey(font)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
      applyWash(font);
      return true;
    },
    /** Drop the pinned font and its wash; returns whether there was one. */
    clearPin: () => {
      if (!pinnedFont) return false;
      pinnedFont = null;
      body.querySelectorAll('tr.sel').forEach((tr) => tr.classList.remove('sel'));
      applyWash(hoverFont);
      return true;
    },
    hasPin: () => !!pinnedFont,
    /** The mode armed or disarmed its pick: the Fonts group's control shows the same state. */
    armedChanged: (on) => {
      if (!pickBtn) return;
      pickBtn.classList.toggle('on', on);
      pickBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
  };
}
