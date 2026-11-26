/**
 * Own property names on pages, lines, words, or chars beyond those OcrPage, OcrLine, OcrWord, and OcrChar declare.
 * Undeclared properties on those objects serialize into every `.scribe` export.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} d
 */
export const strayFields = (d) => {
  const pageFields = ['angle', 'dims', 'lines', 'n', 'pars', 'graphicLines', 'tableBoxes', 'textSource'];
  const lineFields = ['ascHeight', 'baseline', 'bbox', 'debug', 'id', 'lineNum', 'orientation', 'page', 'pageNum', 'par', 'words', 'xHeight'];
  const wordFields = ['bbox', 'chars', 'compTruth', 'conf', 'debug', 'footnoteParId', 'id', 'lang', 'line',
    'matchTruth', 'readings', 'style', 'styleRuns', 'text', 'visualCoords'];
  const charFields = ['bbox', 'text'];
  const page = new Set();
  const lineSet = new Set();
  const word = new Set();
  const char = new Set();
  for (let n = 0; n < d.pageCount; n++) {
    const p = d.getPage(n, { detail: true });
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
