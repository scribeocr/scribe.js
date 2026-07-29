/**
 * Field names an import or edit wrote onto pages, words, or chars beyond those OcrPage, OcrWord, and OcrChar declare.
 * The PDF parser and the text-edit verbs once kept their own data there: /Artifact flags, marked-content and structure ids, bookmark anchors, edit-eligibility stamps, glyph pen origins.
 * Nothing removed them again, so every one reached the user's saved .scribe file — including standard-format exports written for non-app consumers.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} d
 */
export const strayFields = (d) => {
  const pageFields = ['angle', 'dims', 'lines', 'n', 'pars', 'rules', 'tableBoxes', 'textSource'];
  const wordFields = ['bbox', 'chars', 'compTruth', 'conf', 'debug', 'footnoteParId', 'id', 'lang', 'line',
    'lineNum', 'matchTruth', 'style', 'styleRuns', 'text', 'textAlt', 'visualCoords'];
  const charFields = ['bbox', 'text'];
  const page = new Set();
  const word = new Set();
  const char = new Set();
  for (const p of d.ocr.active) {
    Object.keys(p).filter((k) => !pageFields.includes(k)).forEach((k) => page.add(k));
    for (const line of p.lines) {
      for (const w of line.words) {
        Object.keys(w).filter((k) => !wordFields.includes(k)).forEach((k) => word.add(k));
        for (const c of w.chars || []) Object.keys(c).filter((k) => !charFields.includes(k)).forEach((k) => char.add(k));
      }
    }
  }
  return { page: [...page], word: [...word], char: [...char] };
};
