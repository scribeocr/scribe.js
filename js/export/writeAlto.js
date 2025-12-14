import { opt } from '../containers/app.js';
import { pageMetricsAll } from '../containers/dataContainer.js';
import ocr from '../objects/ocrObjects.js';

/**
 * Converts Tesseract language codes to ISO 639-2 codes for ALTO XML
 * @param {string} tesseractLang
 */
function tesseractToISO6392(tesseractLang) {
  const langMap = {
    eng: 'en-US',
    fra: 'fr-FR',
    deu: 'de-DE',
    spa: 'es-ES',
    ita: 'it-IT',
    por: 'pt-PT',
    nld: 'nl-NL',
    rus: 'ru-RU',
    pol: 'pl-PL',
    ces: 'cs-CZ',
    slk: 'sk-SK',
    ukr: 'uk-UA',
    hun: 'hu-HU',
    ron: 'ro-RO',
    hrv: 'hr-HR',
    srp: 'sr-RS',
    bul: 'bg-BG',
    slv: 'sl-SI',
    cat: 'ca-ES',
    dan: 'da-DK',
    fin: 'fi-FI',
    nor: 'no-NO',
    swe: 'sv-SE',
    tur: 'tr-TR',
    ell: 'el-GR',
    ara: 'ar-SA',
    heb: 'he-IL',
    hin: 'hi-IN',
    jpn: 'ja-JP',
    kor: 'ko-KR',
    chi_sim: 'zh-CN',
    chi_tra: 'zh-TW',
    tha: 'th-TH',
    vie: 'vi-VN',
  };
  return langMap[tesseractLang] || tesseractLang;
}

/**
 * Exports OCR data to ALTO XML format (v2.0)
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrData - OCR data to export
 * @param {number} [params.minValue] - First page to export (inclusive)
 * @param {number} [params.maxValue] - Last page to export (inclusive)
 * @returns {string} ALTO XML formatted string
 */
export function writeAlto({ ocrData, minValue, maxValue }) {
  if (minValue === null || minValue === undefined) minValue = 0;
  if (maxValue === null || maxValue === undefined || maxValue < 0) maxValue = ocrData.length - 1;

  const stylesMap = new Map();
  let styleIdCounter = 0;

  /**
   * Get or create a style ID for a given font family and size
   * @param {string} fontFamily
   * @param {number} fontSize
   * @returns {string}
   */
  function getStyleId(fontFamily, fontSize) {
    const key = `${fontFamily || 'Default'}_${fontSize || 10}`;
    if (!stylesMap.has(key)) {
      const styleId = `font${styleIdCounter++}`;
      stylesMap.set(key, { id: styleId, fontFamily: fontFamily || 'Default', fontSize: fontSize || 10 });
    }
    return stylesMap.get(key).id;
  }

  for (let i = minValue; i <= maxValue; i++) {
    const pageObj = ocrData[i];
    if (!pageObj) continue;

    for (const lineObj of pageObj.lines) {
      for (const wordObj of lineObj.words) {
        if (wordObj.style.font || wordObj.style.size) {
          getStyleId(wordObj.style.font, wordObj.style.size);
        }
      }
    }
  }

  let altoOut = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  altoOut += '<alto xmlns="http://www.loc.gov/standards/alto/ns-v2#" ';
  altoOut += 'xmlns:xlink="http://www.w3.org/1999/xlink" ';
  altoOut += 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ';
  altoOut += 'xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v2# http://www.loc.gov/standards/alto/alto-v2.0.xsd">\n';

  altoOut += '<Description>\n';
  altoOut += '<MeasurementUnit>pixel</MeasurementUnit>\n';
  altoOut += '<OCRProcessing ID="IdOcr"><ocrProcessingStep>';
  const today = new Date().toISOString().split('T')[0];
  altoOut += `<processingDateTime>${today}</processingDateTime>`;
  altoOut += '<processingSoftware>';
  altoOut += '<softwareCreator>scribeocr</softwareCreator>';
  altoOut += '<softwareName>scribe.js</softwareName>';
  altoOut += '</processingSoftware>';
  altoOut += '</ocrProcessingStep></OCRProcessing>\n';
  altoOut += '</Description>\n';

  if (stylesMap.size > 0) {
    altoOut += '<Styles>';
    for (const [, style] of stylesMap) {
      altoOut += `<TextStyle ID="${style.id}" FONTFAMILY="${ocr.escapeXml(style.fontFamily)}" FONTSIZE="${style.fontSize}"/>`;
    }
    altoOut += '\n</Styles>\n';
  }

  altoOut += '<Layout>\n';

  for (let pageIndex = minValue; pageIndex <= maxValue; pageIndex++) {
    const pageObj = ocrData[pageIndex];

    let pageHeight = 0;
    let pageWidth = 0;
    if (pageObj) {
      pageHeight = pageObj.dims.height;
      pageWidth = pageObj.dims.width;
    } else if (pageMetricsAll[pageIndex]) {
      pageHeight = pageMetricsAll[pageIndex].dims.height;
      pageWidth = pageMetricsAll[pageIndex].dims.width;
    }

    altoOut += `<Page ID="Page${pageIndex + 1}" PHYSICAL_IMG_NR="${pageIndex + 1}" HEIGHT="${pageHeight}" WIDTH="${pageWidth}">\n`;

    if (!pageObj || pageObj.lines.length === 0) {
      altoOut += '</Page>\n';
      continue;
    }

    altoOut += `<PrintSpace HEIGHT="${pageHeight}" WIDTH="${pageWidth}" VPOS="0" HPOS="0">\n`;

    let parCurrent = null;
    let blockIndex = 0;
    let blockStyleRef = null;
    let blockLang = null;

    for (let lineIndex = 0; lineIndex < pageObj.lines.length; lineIndex++) {
      const lineObj = pageObj.lines[lineIndex];

      if (lineObj.words.length === 0) continue;

      if (blockIndex === 0 || lineObj.par !== parCurrent) {
        if (blockIndex > 0) {
          altoOut += '</TextBlock>\n';
        }

        parCurrent = lineObj.par;

        let blockLeft = Math.round(lineObj.bbox.left);
        let blockTop = Math.round(lineObj.bbox.top);
        let blockRight = Math.round(lineObj.bbox.right);
        let blockBottom = Math.round(lineObj.bbox.bottom);

        const blockStyleCounts = new Map();
        const blockLangCounts = new Map();
        for (let j = lineIndex; j < pageObj.lines.length; j++) {
          const nextLine = pageObj.lines[j];
          if (nextLine.words.length === 0) continue;
          if (j > lineIndex && nextLine.par !== parCurrent) break;

          if (j > lineIndex) {
            blockLeft = Math.min(blockLeft, Math.round(nextLine.bbox.left));
            blockTop = Math.min(blockTop, Math.round(nextLine.bbox.top));
            blockRight = Math.max(blockRight, Math.round(nextLine.bbox.right));
            blockBottom = Math.max(blockBottom, Math.round(nextLine.bbox.bottom));
          }

          for (const word of nextLine.words) {
            if (word.style.font || word.style.size) {
              const styleId = getStyleId(word.style.font || '', word.style.size || 0);
              blockStyleCounts.set(styleId, (blockStyleCounts.get(styleId) || 0) + 1);
            }
            if (word.lang) {
              blockLangCounts.set(word.lang, (blockLangCounts.get(word.lang) || 0) + 1);
            }
          }
        }

        blockStyleRef = null;
        let maxCount = 0;
        for (const [styleId, count] of blockStyleCounts) {
          if (count > maxCount) {
            maxCount = count;
            blockStyleRef = styleId;
          }
        }

        blockLang = null;
        let maxLangCount = 0;
        for (const [lang, count] of blockLangCounts) {
          if (count > maxLangCount) {
            maxLangCount = count;
            blockLang = lang;
          }
        }

        const blockWidth = blockRight - blockLeft;
        const blockHeight = blockBottom - blockTop;

        altoOut += `<TextBlock ID="Page${pageIndex + 1}_Block${blockIndex + 1}" `;
        altoOut += `HEIGHT="${blockHeight}" WIDTH="${blockWidth}" `;
        altoOut += `VPOS="${blockTop}" HPOS="${blockLeft}"`;
        if (blockLang) {
          altoOut += ` language="${tesseractToISO6392(blockLang)}"`;
        }
        if (blockStyleRef) {
          altoOut += ` STYLEREFS="${blockStyleRef}"`;
        }
        altoOut += '>\n';

        blockIndex++;
      }

      const lineLeft = Math.round(lineObj.bbox.left);
      const lineTop = Math.round(lineObj.bbox.top);
      const lineRight = Math.round(lineObj.bbox.right);
      const lineBottom = Math.round(lineObj.bbox.bottom);
      const lineWidth = lineRight - lineLeft;
      const lineHeight = lineBottom - lineTop;

      altoOut += `<TextLine HEIGHT="${lineHeight}" WIDTH="${lineWidth}" `;
      altoOut += `VPOS="${lineTop}" HPOS="${lineLeft}">`;

      for (let wordIndex = 0; wordIndex < lineObj.words.length; wordIndex++) {
        const wordObj = lineObj.words[wordIndex];

        const wordLeft = Math.round(wordObj.bbox.left);
        const wordTop = Math.round(wordObj.bbox.top);
        const wordRight = Math.round(wordObj.bbox.right);
        const wordBottom = Math.round(wordObj.bbox.bottom);
        const wordWidth = wordRight - wordLeft;
        const wordHeight = wordBottom - wordTop;

        let styleAttr = '';
        const styleAttrs = [];
        if (wordObj.style.bold) styleAttrs.push('bold');
        if (wordObj.style.italic) styleAttrs.push('italic');
        if (wordObj.style.underline) styleAttrs.push('underline');
        if (wordObj.style.sup) styleAttrs.push('superscript');
        if (wordObj.style.smallCaps) styleAttrs.push('smallCaps');

        if (styleAttrs.length > 0) {
          styleAttr = ` STYLE="${styleAttrs.join(' ')}"`;
        }

        let styleRefsAttr = '';
        if (wordObj.style.font || wordObj.style.size) {
          const styleId = getStyleId(wordObj.style.font || '', wordObj.style.size || 0);
          // Only add STYLEREFS if it differs from the block-level style
          if (styleId !== blockStyleRef) {
            styleRefsAttr = ` STYLEREFS="${styleId}"`;
          }
        }

        let langAttr = '';
        if (wordObj.lang) {
          // Only add language if it differs from the block-level language
          if (wordObj.lang !== blockLang) {
            langAttr = ` language="${tesseractToISO6392(wordObj.lang)}"`;
          }
        }

        let wcAttr = '';
        if (wordObj.conf !== undefined && wordObj.conf !== null) {
          const confNormalized = wordObj.conf / 100;
          wcAttr = ` WC="${confNormalized.toFixed(2)}"`;
        }

        altoOut += `<String${styleAttr}${langAttr}${wcAttr}${styleRefsAttr} `;
        altoOut += `CONTENT="${ocr.escapeXml(wordObj.text)}" `;
        altoOut += `HEIGHT="${wordHeight}" WIDTH="${wordWidth}" `;
        altoOut += `VPOS="${wordTop}" HPOS="${wordLeft}"/>`;

        // The ALTO XML format uses explicit SP elements to denote spaces between words.
        // While this seems redundant if we understand each <string> element to represent a word,
        // it is encouraged by Library of Congress standards.
        // "The use of SP and HYP are encouraged"
        // https://www.loc.gov/ndnp/guidelines/NDNP_202628TechNotes.pdf
        if (wordIndex < lineObj.words.length - 1) {
          const nextWord = lineObj.words[wordIndex + 1];
          const spaceWidth = Math.round(nextWord.bbox.left) - wordRight - 2;
          if (spaceWidth > 0) {
            altoOut += `<SP WIDTH="${spaceWidth}" VPOS="${wordTop}" HPOS="${wordRight + 1}"/>`;
          }
        }
      }

      altoOut += '</TextLine>\n';
    }

    altoOut += '</TextBlock>\n';

    altoOut += '</PrintSpace>\n';
    altoOut += '</Page>\n';

    opt.progressHandler({ n: pageIndex, type: 'export', info: {} });
  }

  altoOut += '</Layout>\n';
  altoOut += '</alto>\n';

  return altoOut;
}
