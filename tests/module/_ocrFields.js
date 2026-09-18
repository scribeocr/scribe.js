/**
 * Field names an import or edit wrote onto pages, lines, words, or chars beyond those OcrPage, OcrLine, OcrWord, and OcrChar declare.
 * The PDF parser and the text-edit verbs once kept their own data there: /Artifact flags, marked-content and structure ids, bookmark anchors, edit-eligibility stamps, glyph pen origins.
 * Nothing removed them again, so every one reached the user's saved .scribe file — including standard-format exports written for non-app consumers.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} d
 */
export const strayFields = (d) => {
  const pageFields = ['angle', 'dims', 'lines', 'n', 'pars', 'rules', 'tableBoxes', 'textSource'];
  const lineFields = ['ascHeight', 'baseline', 'bbox', 'debug', 'id', 'lineNum', 'orientation', 'page', 'pageNum', 'par', 'words', 'xHeight'];
  const wordFields = ['alt', 'bbox', 'chars', 'compTruth', 'conf', 'debug', 'footnoteParId', 'id', 'lang', 'line',
    'matchTruth', 'style', 'styleRuns', 'text', 'visualCoords'];
  const charFields = ['bbox', 'text'];
  const page = new Set();
  const lineSet = new Set();
  const word = new Set();
  const char = new Set();
  for (const p of d.ocr.active) {
    Object.keys(p).filter((k) => !pageFields.includes(k)).forEach((k) => page.add(k));
    for (const line of p.lines) {
      Object.keys(line).filter((k) => !lineFields.includes(k)).forEach((k) => lineSet.add(k));
      for (const w of line.words) {
        Object.keys(w).filter((k) => !wordFields.includes(k)).forEach((k) => word.add(k));
        for (const c of w.chars || []) Object.keys(c).filter((k) => !charFields.includes(k)).forEach((k) => char.add(k));
      }
    }
  }
  return {
    page: [...page], line: [...lineSet], word: [...word], char: [...char],
  };
};
