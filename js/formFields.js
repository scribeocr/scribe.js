import ocr from './objects/ocrObjects.js';
import { layoutFieldValue } from './pdf/formFieldLayout.js';
import { calcLang, round3 } from './utils/miscUtils.js';

const PX_PER_PT = 300 / 72;

/**
 * Sets a form field's value by fully-qualified name.
 * The field's lifted words in the page text are regenerated so extracted text and exports stay in sync.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {string} name
 * @param {string|null} value - New value; '' or null clears. For checkboxes/radios, the on-state name or 'Off'.
 * @returns {number} Number of widget rows updated.
 */
export function setFormValue(doc, name, value) {
  let updated = 0;
  for (let n = 0; n < doc.annotations.pages.length; n++) {
    const rows = doc.annotations.pages[n] || [];
    for (const row of rows) {
      if (row.type !== 'field' || row.name !== name) continue;
      const isToggle = row.fieldType === 'checkbox' || row.fieldType === 'radio';
      row.value = value === '' || (isToggle && value === 'Off') ? null : value;
      updated++;

      const pageObj = doc.ocr.active?.[n];
      if (!pageObj) continue;

      // The lifted-word id prefix is shared by every field, so the bbox test is what scopes removal to this widget.
      const pad = 2;
      pageObj.lines = pageObj.lines.filter((line) => {
        const lifted = line.words.length > 0 && line.words.every((w) => /^word_\d+_f/.test(w.id));
        if (!lifted) return true;
        const inside = line.bbox.left >= row.bbox.left - pad && line.bbox.right <= row.bbox.right + pad
          && line.bbox.top >= row.bbox.top - pad && line.bbox.bottom <= row.bbox.bottom + pad;
        return !inside;
      });

      if (row.hidden || !(row.fieldType === 'text' || row.fieldType === 'choice')) continue;
      if (!row.value || row.value.trim().length === 0) continue;

      const rectW = (row.bbox.right - row.bbox.left) / PX_PER_PT;
      const rectH = (row.bbox.bottom - row.bbox.top) / PX_PER_PT;
      if (rectW <= 0 || rectH <= 0) continue;
      const layout = layoutFieldValue(row.value, rectW, rectH, {
        multiline: !!row.multiline, comb: !!row.comb, maxLen: row.maxLen ?? null, quadding: row.quadding || 0, da: row.da ?? null,
      });
      const asc = layout.fontSize * 0.8;
      const desc = layout.fontSize * 0.2;
      let liftLineIdx = 0;
      for (const ll of layout.lines) {
        if (ll.words.length === 0) continue;
        liftLineIdx++;
        const baselineY = row.bbox.bottom - ll.y * PX_PER_PT;
        const wordSpecs = ll.words.map((lw) => ({
          text: lw.text,
          bbox: {
            left: Math.round(row.bbox.left + lw.x0 * PX_PER_PT),
            top: Math.round(baselineY - asc * PX_PER_PT),
            right: Math.round(row.bbox.left + lw.x1 * PX_PER_PT),
            bottom: Math.round(baselineY + desc * PX_PER_PT),
          },
        }));
        const lineBbox = {
          left: Math.min(...wordSpecs.map((s) => s.bbox.left)),
          top: Math.min(...wordSpecs.map((s) => s.bbox.top)),
          right: Math.max(...wordSpecs.map((s) => s.bbox.right)),
          bottom: Math.max(...wordSpecs.map((s) => s.bbox.bottom)),
        };
        const lineObj = new ocr.OcrLine(pageObj, lineBbox, [0, Math.round(baselineY) - lineBbox.bottom], asc * PX_PER_PT, null);
        for (let wi = 0; wi < wordSpecs.length; wi++) {
          const wordID = `word_${n + 1}_f${row.srcRef ?? 'x'}e${liftLineIdx}_${wi + 1}`;
          const wordObj = new ocr.OcrWord(lineObj, wordID, wordSpecs[wi].text, wordSpecs[wi].bbox);
          wordObj.conf = 100;
          wordObj.visualCoords = false;
          wordObj.lang = calcLang(wordSpecs[wi].text);
          wordObj.style.font = 'Helvetica';
          wordObj.style.size = round3(layout.fontSize * PX_PER_PT);
          lineObj.words.push(wordObj);
        }
        const insertAt = pageObj.lines.findIndex((l) => l.bbox.top > lineBbox.top);
        if (insertAt === -1) pageObj.lines.push(lineObj);
        else pageObj.lines.splice(insertAt, 0, lineObj);
      }
    }
  }
  return updated;
}
