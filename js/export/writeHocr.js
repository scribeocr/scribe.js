import { opt } from '../containers/app.js';
import {
  layoutDataTables, layoutRegions, pageMetricsArr,
} from '../containers/dataContainer.js';
import { FontCont } from '../containers/fontContainer.js';
import ocr from '../objects/ocrObjects.js';
import { round6 } from '../utils/miscUtils.js';

/**
 *
 * @param {Array<OcrPage>} ocrData
 * @param {number} [minValue]
 * @param {number} [maxValue]
 */
export function writeHocr(ocrData, minValue, maxValue) {
  if (minValue === null || minValue === undefined) minValue = 0;
  if (maxValue === null || maxValue === undefined || maxValue < 0) maxValue = ocrData.length - 1;

  const meta = {
    'font-metrics': FontCont.state.charMetrics,
    'default-font': FontCont.state.defaultFontName,
    'sans-font': FontCont.state.sansDefaultName,
    'serif-font': FontCont.state.serifDefaultName,
    'enable-opt': opt.enableOpt,
    layout: layoutRegions.pages,
    'layout-data-table': layoutDataTables.serialize(),
  };

  let hocrOut = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">`;

  hocrOut += '<head>';
  hocrOut += '\n\t<title></title>';

  // Add <meta> nodes provided by argument
  for (const [key, value] of Object.entries(meta)) {
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : value;
    hocrOut += `\n\t<meta name='${key}' content='${valueStr}'></meta>`;
  }

  hocrOut += '\n\t<meta http-equiv="Content-Type" content="text/html;charset=utf-8"/>';
  hocrOut += '\n\t<meta name=\'ocr-system\' content=\'scribeocr\' />';
  hocrOut += '\n\t<meta name=\'ocr-capabilities\' content=\'ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrp_wconf ocrp_lang ocrp_dir ocrp_font ocrp_fsize\'/>';
  hocrOut += '\n</head>';
  hocrOut += '\n<body>';

  for (let i = minValue; i <= maxValue; i++) {
    const pageObj = ocrData[i];

    // Handle case where ocrPage object does not exist.
    if (!pageObj) {
      hocrOut += `\n\t<div class='ocr_page' title='bbox 0 0 ${pageMetricsArr[i].dims.width} ${pageMetricsArr[i].dims.height}'>`;
      hocrOut += '\n\t</div>';
      continue;
    }

    hocrOut += `\n\t<div class='ocr_page' title='bbox 0 0 ${pageObj.dims.width} ${pageObj.dims.height}'>`;
    for (const lineObj of pageObj.lines) {
      hocrOut += `\n\t\t<span class='ocr_line' title="bbox ${lineObj.bbox.left} ${lineObj.bbox.top} ${lineObj.bbox.right} ${lineObj.bbox.bottom}`;
      hocrOut += `; baseline ${round6(lineObj.baseline[0])} ${Math.round(lineObj.baseline[1])}`;

      // These metrics are specific to ScribeOCR, and are different from the Tesseract HOCR output.
      // Per the HOCR spec, these properties must (1) be prefixed with `x_` and (2) only consist of lowercase letters and numbers (no camel case).
      // The name of a property must only consist of lowercase letters and numbers.
      // Property names must be either from those defined in §4 The properties of hOCR or begin with x_ to denote implementation-specific extensions.
      // https://kba.github.io/hocr-spec/1.2/#definition-property
      if (lineObj.xHeight) hocrOut += `; x_x_height ${lineObj.xHeight}`;
      if (lineObj.ascHeight) hocrOut += `; x_asc_height ${lineObj.ascHeight}`;
      hocrOut += '">';
      for (const wordObj of lineObj.words) {
        hocrOut += `\n\t\t\t<span class='ocrx_word' id='${wordObj.id}' title='`;
        // The HOCR specification requires that the bounding box be rounded to the nearest integer, however the Scribe internal data structure does not.
        hocrOut += `bbox ${Math.round(wordObj.bbox.left)} ${Math.round(wordObj.bbox.top)} ${Math.round(wordObj.bbox.right)} ${Math.round(wordObj.bbox.bottom)}`;
        hocrOut += `;x_wconf ${wordObj.conf}`;

        if (wordObj.style.font && wordObj.style.font !== 'Default') {
          hocrOut += `;x_font ${wordObj.style.font}`;
        }

        if (wordObj.style.size) {
          hocrOut += `;x_fsize ${wordObj.style.size}`;
        }

        hocrOut += "'";

        // Tesseract HOCR specifies default language for a paragraph in the "ocr_par" element,
        // however as ScribeOCR does not currently have a paragarph object, every word must have its language specified.
        if (wordObj.lang) hocrOut += ` lang='${wordObj.lang}'`;

        // TODO: Why are we representing font family and style using the `style` HTML element here?
        // This is not how Tesseract does things, and our own parsing script does not appear to be written to re-import it properly.
        // Add "style" attribute (if applicable)
        if (wordObj.style.bold || wordObj.style.italic || wordObj.style.smallCaps || (wordObj.style.font && wordObj.style.font !== 'Default')) {
          hocrOut += ' style=\'';

          if (wordObj.style.italic) {
            hocrOut += 'font-style:italic;';
          }

          if (wordObj.style.bold) {
            hocrOut += 'font-weight:bold;';
          }

          if (wordObj.style.smallCaps) {
            hocrOut += 'font-variant:small-caps;';
          }

          if (wordObj.style.font && wordObj.style.font !== 'Default') {
            hocrOut += `font-family:${wordObj.style.font}`;
          }

          hocrOut += '\'>';
        } else {
          hocrOut += '>';
        }

        // Add word text, along with any formatting that uses nested elements rather than attributes
        if (wordObj.style.sup) {
          hocrOut += `<sup>${ocr.escapeXml(wordObj.text)}</sup>`;
        } else if (wordObj.style.dropcap) {
          hocrOut += `<span class='ocr_dropcap'>${ocr.escapeXml(wordObj.text)}</span>`;
        } else {
          hocrOut += ocr.escapeXml(wordObj.text);
        }
        hocrOut += '</span>';
      }
      hocrOut += '\n\t\t</span>';
    }
    hocrOut += '\n\t</div>';

    opt.progressHandler({ n: i, type: 'export', info: { } });
  }

  hocrOut += '\n</body>\n</html>';

  return hocrOut;
}
