import { round6 } from '../utils/miscUtils.js';
import { hocrLineFingerprint } from '../import/convertPageHocr.js';

/**
 * Write pages as hOCR.
 * A page imported from hOCR is written from its source markup, so every unchanged line and container comes out as uploaded.
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrData
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minValue/maxValue when provided.
 * @param {number} [params.minValue]
 * @param {number} [params.maxValue]
 * @param {Array<PageMetrics>} params.pageMetrics
 * @param {?{head: ?Array<string>, pages: Array<?HocrSourcePage>}} [params.hocrSource=null] - The hOCR source markup of the layer being written, when it was imported from hOCR.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 */
export function writeHocr({
  ocrData, pageArr = null, minValue, maxValue, pageMetrics, hocrSource = null, doc = null,
}) {
  if (!pageArr) {
    if (minValue === null || minValue === undefined) minValue = 0;
    if (maxValue === null || maxValue === undefined || maxValue < 0) maxValue = ocrData.length - 1;
    pageArr = [];
    for (let i = minValue; i <= maxValue; i++) pageArr.push(i);
  }

  // HTML 4 user agents do not know the named apostrophe entity, so an apostrophe is written as a numeric reference, as Tesseract writes it.
  const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const escAttr = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
  const langRe = /\s(?:xml:)?lang\s*=\s*["']([^"']*)["']/;
  const idRe = /\sid\s*=\s*["']([^"']*)["']/;
  let usesFont = false;
  let usedSource = false;

  /**
   * @param {OcrLine} line
   * @param {string} indent
   * @param {?string} parLang - The enclosing paragraph's language, or null for a line outside any paragraph.
   */
  const writeLine = (line, indent, parLang) => {
    let title = `bbox ${Math.round(line.bbox.left)} ${Math.round(line.bbox.top)} ${Math.round(line.bbox.right)} ${Math.round(line.bbox.bottom)}`;
    title += `; baseline ${round6(line.baseline[0])} ${Math.round(line.baseline[1])}`;
    // A line with only an x-height writes `x_ascenders 0`, which the importer reads as that case.
    const desc = Math.max(0, -line.baseline[1]);
    if (line.ascHeight) {
      title += `; x_size ${round6(line.ascHeight + desc)}; x_descenders ${round6(desc)}`;
      if (line.xHeight && line.xHeight < line.ascHeight) title += `; x_ascenders ${round6(line.ascHeight - line.xHeight)}`;
    } else if (line.xHeight) {
      title += `; x_size ${round6(line.xHeight + desc)}; x_descenders ${round6(desc)}; x_ascenders 0`;
    }
    let words = '';
    for (const w of line.words) {
      let wordTitle = `bbox ${Math.round(w.bbox.left)} ${Math.round(w.bbox.top)} ${Math.round(w.bbox.right)} ${Math.round(w.bbox.bottom)}; x_wconf ${Math.round(w.conf)}`;
      if (w.style.font && w.style.font !== 'Default') {
        usesFont = true;
        wordTitle += `; x_font ${/[\s;"]/.test(w.style.font) ? `"${w.style.font.replace(/"/g, '')}"` : w.style.font}`;
      }
      let word = `<span class='ocrx_word' id='${escAttr(w.id)}' title='${escAttr(wordTitle)}'`;
      if (w.lang && (parLang === null || w.lang !== parLang)) word += ` lang='${escAttr(w.lang)}'`;
      const css = [];
      if (w.style.italic) css.push('font-style:italic');
      if (w.style.bold) css.push('font-weight:bold');
      if (w.style.underline) css.push('text-decoration:underline');
      if (w.style.smallCaps) css.push('font-variant:small-caps');
      if (css.length > 0) word += ` style='${css.join(';')}'`;
      let text = esc(w.text);
      if (w.style.sup) text = `<sup>${text}</sup>`;
      else if (w.style.dropcap) text = `<span class='ocr_dropcap'>${text}</span>`;
      words += `\n${indent} ${word}>${text}</span>`;
    }
    return `<span class='ocr_line' id='${escAttr(line.id)}' title="${esc(title)}">${words}\n${indent}</span>`;
  };

  /** @param {Array<OcrLine>} lines */
  const bboxUnion = (lines) => {
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
    for (const ln of lines) {
      l = Math.min(l, ln.bbox.left); t = Math.min(t, ln.bbox.top); r = Math.max(r, ln.bbox.right); b = Math.max(b, ln.bbox.bottom);
    }
    return lines.length > 0 ? `bbox ${Math.round(l)} ${Math.round(t)} ${Math.round(r)} ${Math.round(b)}` : 'bbox 0 0 0 0';
  };

  /** @param {Array<OcrLine>} lines */
  const dominantLang = (lines) => {
    /** @type {Object<string, number>} */
    const counts = {};
    for (const ln of lines) for (const w of ln.words) counts[w.lang || 'eng'] = (counts[w.lang || 'eng'] || 0) + 1;
    let best = 'eng'; let bestN = -1;
    for (const [lang, k] of Object.entries(counts)) if (k > bestN) { best = lang; bestN = k; }
    return best;
  };

  let body = '';
  for (const i of pageArr) {
    const pageObj = ocrData[i];

    // Handle case where ocrPage object does not exist.
    if (!pageObj) {
      body += `\n  <div class='ocr_page' id='page_${i + 1}' title='bbox 0 0 ${pageMetrics[i].dims.width} ${pageMetrics[i].dims.height}'>\n  </div>`;
      continue;
    }

    const src = hocrSource?.pages?.[i] ?? null;
    // Importing another format under the same layer name replaces the page but keeps its source markup.
    const srcApplies = !!src && (pageObj.lines.length === 0 || pageObj.lines.some((l) => src.lines[l.id] && !src.lines[l.id].dropped));

    // Every id already on the page or in the kept markup, pictures and separators included, so generated ids never collide with kept ones.
    /** @type {Set<string>} */
    const usedIds = new Set();
    for (const par of pageObj.pars) usedIds.add(par.id);
    for (const line of pageObj.lines) {
      usedIds.add(line.id);
      for (const w of line.words) usedIds.add(w.id);
    }
    if (src && srcApplies) {
      for (const m of `${src.open}${src.template}`.matchAll(/\sid\s*=\s*["']([^"']*)["']/g)) usedIds.add(m[1]);
      for (const id of Object.keys(src.pars)) usedIds.add(id);
      for (const id of Object.keys(src.lines)) usedIds.add(id);
      for (const c of src.careas) { const id = c.open.match(idRe)?.[1]; if (id) usedIds.add(id); }
    }
    /** @type {Object<string, number>} */
    const counters = {};
    const newId = (/** @type {string} */ prefix) => {
      let k = counters[prefix] || 0;
      let id;
      do { k++; id = `${prefix}_${i + 1}_${k}`; } while (usedIds.has(id));
      counters[prefix] = k;
      usedIds.add(id);
      return id;
    };
    /** @type {Set<string>} */
    const emittedPars = new Set();

    /**
     * @param {Array<OcrLine>} lines
     * @param {string} indent
     */
    const writeGroups = (lines, indent) => {
      let out = '';
      /** @type {Array<Array<OcrLine>>} */
      const groups = [];
      for (const line of lines) {
        const last = groups[groups.length - 1];
        if (last && (last[0].par || null) === (line.par || null)) last.push(line);
        else groups.push([line]);
      }
      for (const group of groups) {
        const par = group[0].par;
        let parId = par ? par.id : newId('par');
        if (emittedPars.has(parId)) parId = newId('par');
        emittedPars.add(parId);
        const lang = dominantLang(group);
        out += `\n${indent}<div class='ocr_carea' id='${escAttr(newId('block'))}' title="${bboxUnion(group)}">`;
        out += `\n${indent} <p class='ocr_par' id='${escAttr(parId)}' lang='${escAttr(lang)}' title="${bboxUnion(group)}">`;
        for (const line of group) out += `\n${indent}  ${writeLine(line, `${indent}  `, lang)}`;
        out += `\n${indent} </p>\n${indent}</div>`;
      }
      return out;
    };

    if (!src || !srcApplies) {
      body += `\n  <div class='ocr_page' id='page_${i + 1}' title='bbox 0 0 ${pageObj.dims.width} ${pageObj.dims.height}'>`;
      body += writeGroups(pageObj.lines, '   ');
      body += '\n  </div>';
      doc?.progressHandler({ n: i, type: 'export', info: { } });
      continue;
    }
    usedSource = true;

    /** @type {Map<string, OcrLine>} */
    const linesById = new Map(pageObj.lines.map((l) => [l.id, l]));
    /** @type {Map<string, OcrPar>} */
    const parsById = new Map(pageObj.pars.map((p) => [p.id, p]));
    // The editor's word deletion removes an emptied line from the page but not from its paragraph.
    const parLines = (/** @type {OcrPar} */ par) => par.lines.filter((l) => linesById.get(l.id) === l);

    /** @type {Map<string, Array<OcrLine>>} */
    const followers = new Map();
    /** @type {Array<OcrLine>} */
    const leading = [];
    /** @type {?OcrLine} */
    let lastKnown = null;
    for (const line of pageObj.lines) {
      if (src.lines[line.id] && !src.lines[line.id].dropped) {
        lastKnown = line;
      } else if (lastKnown) {
        const list = followers.get(lastKnown.id);
        if (list) list.push(line);
        else followers.set(lastKnown.id, [line]);
      } else {
        leading.push(line);
      }
    }

    /** @type {Map<string, boolean>} */
    const lineClean = new Map();
    const isLineClean = (/** @type {OcrLine} */ line) => {
      let clean = lineClean.get(line.id);
      if (clean === undefined) {
        const rec = src.lines[line.id];
        clean = !!rec && !rec.dropped && rec.fp === hocrLineFingerprint(line);
        lineClean.set(line.id, clean);
      }
      return clean;
    };
    // A paragraph the source does not know, such as one a reflowed text export assigned in place, does not move its lines.
    const knownPar = (/** @type {OcrLine} */ line) => (line.par && src.pars[line.par.id] ? line.par : null);

    const pageBbox = src.open.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    const pageId = src.open.match(idRe)?.[1];
    if (pageBbox && Number(pageBbox[3]) === pageObj.dims.width && Number(pageBbox[4]) === pageObj.dims.height) {
      body += `\n${src.open}`;
    } else {
      body += `\n  <div class='ocr_page' id='${escAttr(pageId || `page_${i + 1}`)}' title='bbox 0 0 ${pageObj.dims.width} ${pageObj.dims.height}'>`;
    }

    // eslint-disable-next-line no-control-regex
    const parts = src.template.split(/\u0000([^\u0000]*)\u0000/);
    /** @type {Set<string>} */
    const emitted = new Set();
    const lastIndent = (/** @type {string} */ s) => s.slice(s.lastIndexOf('\n') + 1).match(/^\s*/)?.[0] ?? '';

    /**
     * @param {OcrLine} line
     * @param {string} indent
     * @param {?string} parLang
     * @param {Array<OcrLine>} regionLines
     */
    const emitLine = (line, indent, parLang, regionLines) => {
      const clean = isLineClean(line);
      let out = clean ? src.lines[line.id].raw : writeLine(line, indent, parLang);
      emitted.add(line.id);
      regionLines.push(line);
      let pristine = clean;
      for (const f of followers.get(line.id) || []) {
        if (emitted.has(f.id)) continue;
        out += `\n${indent}${writeLine(f, indent, parLang)}`;
        emitted.add(f.id);
        regionLines.push(f);
        pristine = false;
      }
      return { out, pristine };
    };

    /**
     * Render the template from `parts[k]` up to the placeholder `end`, inside the source paragraph `parHere`.
     * `pristine` says the region's content came out exactly as uploaded, so the container around it can be kept as uploaded too.
     * @param {number} k
     * @param {?string} end
     * @param {?string} parHere
     * @returns {{out: string, next: number, hasLines: boolean, pristine: boolean, lines: Array<OcrLine>}}
     */
    const render = (k, end, parHere) => {
      let out = '';
      let hasLines = false;
      let pristine = true;
      /** @type {Array<OcrLine>} */
      const lines = [];
      for (; k < parts.length; k++) {
        if (k % 2 === 0) {
          out += parts[k];
          continue;
        }
        const ph = parts[k];
        if (ph === end) {
          return {
            out, next: k + 1, hasLines, pristine, lines,
          };
        }
        if (ph[0] === 'L') {
          const id = ph.slice(1);
          const line = linesById.get(id);
          const rec = src.lines[id];
          const linePar = line ? knownPar(line) : null;
          if (line && !emitted.has(id) && (!linePar || linePar.id === parHere)) {
            const parLang = parHere ? (src.pars[parHere].open.match(langRe)?.[1] ?? null) : null;
            const indent = lastIndent(out);
            for (const f of leading) {
              if (emitted.has(f.id)) continue;
              out += `${writeLine(f, indent, parLang)}\n${indent}`;
              emitted.add(f.id);
              lines.push(f);
              pristine = false;
            }
            const written = emitLine(line, indent, parLang, lines);
            out += written.out;
            if (!written.pristine) pristine = false;
            hasLines = true;
          } else if (!line && rec?.dropped) {
            out += rec.raw;
            hasLines = true;
          } else {
            pristine = false;
          }
        } else if (ph[0] === 'P') {
          const id = ph.slice(1);
          const rec = src.pars[id];
          const inner = render(k + 1, `/P${id}`, id);
          k = inner.next - 1;
          let innerOut = inner.out;
          let has = inner.hasLines;
          let parPristine = inner.pristine;
          const indent = lastIndent(innerOut);
          const lang = rec.open.match(langRe)?.[1] ?? dominantLang(inner.lines);
          const par = parsById.get(id);
          if (par) {
            for (const line of parLines(par)) {
              if (emitted.has(line.id)) continue;
              innerOut += `${emitLine(line, `${indent} `, lang, inner.lines).out}\n${indent}`;
              has = true;
              parPristine = false;
            }
          }
          if (!has && rec.lineIds.length > 0) {
            pristine = false;
            continue;
          }
          const open = parPristine ? rec.open : `<p class='ocr_par' id='${escAttr(id)}' lang='${escAttr(lang)}' title="${bboxUnion(inner.lines)}">`;
          out += `${open}${innerOut}${rec.close}`;
          emittedPars.add(id);
          lines.push(...inner.lines);
          hasLines = hasLines || has;
          if (!parPristine) pristine = false;
        } else if (ph[0] === 'C') {
          const idx = Number(ph.slice(1));
          const carea = src.careas[idx];
          const inner = render(k + 1, `/C${idx}`, parHere);
          k = inner.next - 1;
          if (!inner.hasLines && carea.lineIds.length > 0) {
            pristine = false;
            continue;
          }
          let open = carea.open;
          if (!inner.pristine && inner.lines.length > 0) open = `<div class='ocr_carea' id='${escAttr(carea.open.match(idRe)?.[1] ?? newId('block'))}' title="${bboxUnion(inner.lines)}">`;
          out += `${open}${inner.out}${carea.close}`;
          lines.push(...inner.lines);
          hasLines = hasLines || inner.hasLines;
          if (!inner.pristine) pristine = false;
        }
      }
      return {
        out, next: k, hasLines, pristine, lines,
      };
    };

    let out = render(0, null, null).out;
    const leftover = pageObj.lines.filter((l) => !emitted.has(l.id));
    if (leftover.length > 0) out += writeGroups(leftover, '   ');
    body += `${out}${src.close}`;

    doc?.progressHandler({ n: i, type: 'export', info: { } });
  }

  let metas = '';
  const srcHead = usedSource ? hocrSource?.head ?? null : null;
  const hasMeta = (/** @type {string} */ name) => !!srcHead && srcHead.some((tag) => new RegExp(`name\\s*=\\s*["']${name}["']`, 'i').test(tag));
  if (srcHead) {
    for (const tag of srcHead) if (!/name\s*=\s*["']ocr-number-of-pages["']/i.test(tag)) metas += `\n  ${tag}`;
  }
  if (!hasMeta('ocr-system')) metas += "\n  <meta name='ocr-system' content='scribe.js' />";
  if (!hasMeta('ocr-capabilities')) metas += `\n  <meta name='ocr-capabilities' content='ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrp_wconf ocrp_lang${usesFont ? ' ocrp_font' : ''}'/>`;
  metas += `\n  <meta name='ocr-number-of-pages' content='${pageArr.length}'/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
 <head>
  <title></title>
  <meta http-equiv="Content-Type" content="text/html;charset=utf-8"/>${metas}
 </head>
 <body>${body}
 </body>
</html>
`;
}
