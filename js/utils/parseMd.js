// The assistant chat renderer imports this on the main thread, so keep it free of heavy imports that would land in the viewer bundle.

export const CODE_FONT_FAMILY = 'Courier';

/**
 * CommonMark specifies the full HTML5 entity set, of which this is the common subset.
 * An unknown name stays literal, which is how the spec treats an invalid entity.
 * @type {Object<string, string>}
 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  shy: '\u00AD',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  micro: 'µ',
  para: '¶',
  sect: '§',
  middot: '·',
  bull: '•',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  plusmn: '±',
  minus: '−',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
};

/** @param {string} label */
const normalizeRefLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * @typedef {Object} MdRefs
 * @property {Map<string, string>} links - Link destinations by normalized reference label.
 * @property {Set<string>} notes - Labels that have a footnote definition.
 */

/**
 * @typedef {Object} MdRun
 * @property {string} text - Literal text, with every markdown syntax character already removed. `'\n'` marks a forced line break.
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} sup
 * @property {string} font
 * @property {?string} link - Target URL when the text came from a link, otherwise `null`.
 * @property {string} [footnoteLabel] - Label of the footnote definition this run references, set only on a marker run.
 */

/**
 * Convert the inline markdown of one block into styled runs.
 * @param {string} text
 * @param {{bold: boolean, italic: boolean, sup: boolean, font: string, link: ?string}} style - Style in effect around `text`.
 * @param {MdRefs} refs
 * @returns {Array<MdRun>}
 */
export function parseInlineMd(text, style, refs) {
  /** @type {Array<MdRun>} */
  const runs = [];
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, ...style });
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (char === '\n') {
      flush();
      runs.push({ ...style, text: '\n' });
      i++;
      continue;
    }

    if (char === '\\' && /[\\`*_{}[\]()#+\-.!>|~=&<]/.test(text[i + 1] || '')) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      let fence = 0;
      while (text[i + fence] === '`') fence++;
      let close = -1;
      for (let j = i + fence; j < text.length;) {
        if (text[j] !== '`') {
          j++;
        } else {
          let run = 0;
          while (text[j + run] === '`') run++;
          if (run === fence) {
            close = j;
            break;
          }
          j += run;
        }
      }
      if (close === -1) {
        buf += '`'.repeat(fence);
        i += fence;
        continue;
      }
      let code = text.slice(i + fence, close);
      // A code span drops one space at each end, which is how a span holds a literal backtick without running into its own fence.
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush();
      runs.push({
        text: code, bold: style.bold, italic: style.italic, sup: style.sup, font: CODE_FONT_FAMILY, link: style.link,
      });
      i = close + fence;
      continue;
    }

    if (char === '[' || (char === '!' && text[i + 1] === '[')) {
      const isImage = char === '!';
      const labelStart = isImage ? i + 1 : i;
      let depth = 0;
      let labelEnd = -1;
      for (let j = labelStart; j < text.length; j++) {
        if (text[j] === '\\') {
          j++;
        } else if (text[j] === '[') {
          depth++;
        } else if (text[j] === ']') {
          depth--;
          if (depth === 0) {
            labelEnd = j;
            break;
          }
        }
      }
      if (labelEnd === -1) {
        buf += char;
        i++;
        continue;
      }
      const label = text.slice(labelStart + 1, labelEnd);
      if (!isImage && label.startsWith('^') && refs.notes.has(label.slice(1))) {
        flush();
        runs.push({
          ...style, text: label.slice(1), sup: true, footnoteLabel: label.slice(1),
        });
        i = labelEnd + 1;
        continue;
      }
      const after = text.slice(labelEnd + 1);
      const destMatch = /^\(\s*(\S*?)(?:\s+"[^"]*")?\s*\)/.exec(after);
      /** @type {?string} */
      let url = null;
      let consumed = 0;
      if (destMatch) {
        url = destMatch[1];
        consumed = destMatch[0].length;
      } else {
        const refMatch = /^\[([^\]]*)\]/.exec(after);
        const key = normalizeRefLabel(refMatch && refMatch[1] ? refMatch[1] : label);
        if (refs.links.has(key)) {
          url = /** @type {string} */ (refs.links.get(key));
          consumed = refMatch ? refMatch[0].length : 0;
        }
      }
      if (url === null) {
        buf += char;
        i++;
        continue;
      }
      flush();
      if (!isImage) {
        const link = /^(https?:|mailto:)/i.test(url) ? url : style.link;
        runs.push(...parseInlineMd(label, { ...style, link }, refs));
      }
      i = labelEnd + 1 + consumed;
      continue;
    }

    if (char === '<') {
      const autolink = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (autolink) {
        flush();
        runs.push({ ...style, text: autolink[1].replace(/^mailto:/i, ''), link: autolink[1] });
        i += autolink[0].length;
        continue;
      }
      const comment = /^<!--[\s\S]*?-->/.exec(text.slice(i));
      if (comment) {
        i += comment[0].length;
        continue;
      }
      const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?\/?>/.exec(text.slice(i));
      if (tag) {
        const name = tag[2].toLowerCase();
        if (name === 'br' && !tag[1]) {
          flush();
          runs.push({ ...style, text: '\n' });
          i += tag[0].length;
          continue;
        }
        const styleProp = {
          sup: 'sup', b: 'bold', strong: 'bold', i: 'italic', em: 'italic',
        }[name];
        if ((styleProp || name === 'a') && !tag[1]) {
          const close = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(i + tag[0].length));
          if (close) {
            flush();
            const inner = text.slice(i + tag[0].length, i + tag[0].length + close.index);
            /** @type {?string} */
            let link = style.link;
            if (name === 'a') {
              const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[3] || '');
              const dest = href ? href[1] || href[2] : '';
              if (/^(https?:|mailto:)/i.test(dest)) link = dest;
            }
            runs.push(...parseInlineMd(inner, {
              ...style, ...(styleProp ? { [styleProp]: true } : {}), link,
            }, refs));
            i += tag[0].length + close.index + close[0].length;
            continue;
          }
        }
        // Any other tag is dropped and its contents flow on as plain text.
        i += tag[0].length;
        continue;
      }
    }

    if (char === '&') {
      const entity = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/.exec(text.slice(i));
      if (entity) {
        /** @type {?string} */
        let decoded = null;
        if (entity[3]) {
          decoded = NAMED_ENTITIES[entity[3]] || null;
        } else {
          const code = entity[1] ? parseInt(entity[1], 10) : parseInt(entity[2], 16);
          decoded = code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : '�';
        }
        if (decoded !== null) {
          buf += decoded;
          i += entity[0].length;
          continue;
        }
      }
      buf += char;
      i++;
      continue;
    }

    if (char === '~' && text[i + 1] === '~' && text[i + 2] !== '~') {
      let close = -1;
      for (let j = i + 2; j < text.length - 1; j++) {
        if (text[j] === '\\') {
          j++;
        } else if (text[j] === '~' && text[j + 1] === '~') {
          close = j;
          break;
        }
      }
      if (close > i + 2) {
        flush();
        // Strikethrough has no style on the word model, so the markers are consumed and the text kept.
        runs.push(...parseInlineMd(text.slice(i + 2, close), style, refs));
        i = close + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      let run = 0;
      while (text[i + run] === char) run++;
      const charBefore = text[i - 1] || '';
      const charAfter = text[i + run] || '';
      // An underscore run only opens or closes at a word boundary, so snake_case identifiers keep their underscores.
      const canOpen = charAfter !== '' && !/\s/.test(charAfter) && (char === '*' || !/[\p{L}\p{N}]/u.test(charBefore));
      const use = Math.min(run, 3);
      let close = -1;
      if (canOpen) {
        for (let j = i + run; j < text.length;) {
          if (text[j] === '\\') {
            j += 2;
          } else if (text[j] !== char) {
            j++;
          } else {
            let closeRun = 0;
            while (text[j + closeRun] === char) closeRun++;
            const closeBefore = text[j - 1] || '';
            const closeAfter = text[j + closeRun] || '';
            if (closeRun >= use && !/\s/.test(closeBefore) && (char === '*' || !/[\p{L}\p{N}]/u.test(closeAfter))) {
              close = j;
              break;
            }
            j += closeRun;
          }
        }
      }
      if (close === -1) {
        buf += char.repeat(run);
        i += run;
        continue;
      }
      flush();
      runs.push(...parseInlineMd(text.slice(i + use, close), {
        ...style, bold: style.bold || use >= 2, italic: style.italic || use === 1 || use === 3,
      }, refs));
      i = close + use;
      continue;
    }

    buf += char;
    i++;
  }

  flush();
  return runs;
}

/**
 * Whether the line forces a break after it.
 * The break is two trailing spaces, or a backslash that is not itself escaped.
 * @param {string} line
 */
const endsHardBreak = (line) => / {2}$/.test(line) || /(?:^|[^\\])(?:\\\\)*\\$/.test(line);

/**
 * The line's text with surrounding whitespace and any trailing hard-break backslash removed.
 * @param {string} line
 */
const trimBlockLine = (line) => {
  let text = line.trim();
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(line)) text = text.slice(0, -1).trimEnd();
  return text;
};

/**
 * Collect the document's reference-link and footnote definitions.
 * They are gathered up front because they may sit anywhere, including after their uses and inside block quotes.
 * @param {Array<string>} lines
 * @returns {MdRefs}
 */
export function collectMdRefs(lines) {
  /** @type {MdRefs} */
  const refs = { links: new Map(), notes: new Set() };
  for (const raw of lines) {
    const stripped = raw.replace(/^ {0,3}(?:>[ \t]?)+/, '');
    const fnDef = /^ {0,3}\[\^([^\]\s]+)\]:/.exec(stripped);
    if (fnDef) {
      refs.notes.add(fnDef[1]);
      continue;
    }
    const refDef = /^ {0,3}\[((?:\\[\s\S]|[^\]\\])+)\]:[ \t]*<?([^\s<>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/.exec(stripped);
    if (refDef) {
      const key = normalizeRefLabel(refDef[1]);
      if (!refs.links.has(key)) refs.links.set(key, refDef[2]);
    }
  }
  return refs;
}

/**
 * One block of parsed markdown, in document terms only.
 * Layout choices (font sizes, indents, style names) belong to the consumer.
 * @typedef {Object} MdBlock
 * @property {'paragraph'|'heading'|'code'|'footnote'} kind
 * @property {Array<MdRun>} runs - Code blocks carry literal lines separated by `'\n'` runs, all in `CODE_FONT_FAMILY`.
 * @property {?number} headingLevel - 1-6 when the block is a heading.
 * @property {?number} listDepth - Nesting depth 0-3 when the block is a list item.
 * @property {?string} marker - List marker as the reader sees it: `'•'`, `'☐'`, `'☑'`, or an ordinal like `'3.'`.
 * @property {boolean} quoted - Set on every block that sits inside a block quote, at any quote depth.
 * @property {string} [footnoteLabel] - Label of the footnote definition this block came from.
 */

/**
 * Parse markdown lines into blocks.
 * @param {Array<string>} blockLines
 * @param {MdRefs} refs
 * @param {string} font - Font family seeded onto non-code runs.
 * @returns {Array<MdBlock>}
 */
export function parseMdBlocks(blockLines, refs, font) {
  /** @type {Array<MdBlock>} */
  const blocks = [];
  /**
   * @type {?{text: string, kind: MdBlock['kind'], headingLevel: ?number, listDepth: ?number, marker: ?string,
   *   bold: boolean, hardBreak: boolean, footnoteLabel?: string}}
   */
  let openBlock = null;
  // Content column of the open list item at each depth. A marker indented to at least its parent's content column opens a nested item.
  /** @type {Array<number>} */
  const listStack = [];

  const closeBlock = () => {
    if (!openBlock) return;
    const runs = parseInlineMd(openBlock.text, {
      bold: openBlock.bold, italic: false, sup: false, font, link: null,
    }, refs);
    if (runs.length > 0) {
      blocks.push({
        kind: openBlock.kind,
        runs,
        headingLevel: openBlock.headingLevel,
        listDepth: openBlock.listDepth,
        marker: openBlock.marker,
        quoted: false,
        footnoteLabel: openBlock.footnoteLabel,
      });
    }
    openBlock = null;
  };

  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];

    // The contents of a fenced code block are imported verbatim, so the fence is matched before any other construct.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      closeBlock();
      listStack.length = 0;
      const closeFence = new RegExp(`^ {0,3}${fenceMatch[1][0]}{${fenceMatch[1].length},}[ \\t]*$`);
      /** @type {Array<MdRun>} */
      const runs = [];
      i++;
      for (; i < blockLines.length && !closeFence.test(blockLines[i]); i++) {
        if (runs.length > 0) {
          runs.push({
            text: '\n', bold: false, italic: false, sup: false, font: CODE_FONT_FAMILY, link: null,
          });
        }
        runs.push({
          text: blockLines[i].replace(/\t/g, '    '), bold: false, italic: false, sup: false, font: CODE_FONT_FAMILY, link: null,
        });
      }
      if (runs.length > 0) {
        blocks.push({
          kind: 'code', runs, headingLevel: null, listDepth: null, marker: null, quoted: false,
        });
      }
      continue;
    }

    if (!line.trim()) {
      closeBlock();
      continue;
    }

    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
    if (headingMatch) {
      closeBlock();
      listStack.length = 0;
      const level = headingMatch[1].length;
      const runs = parseInlineMd((headingMatch[2] || '').trim(), {
        bold: true, italic: false, sup: false, font, link: null,
      }, refs);
      if (runs.length > 0) {
        blocks.push({
          kind: 'heading', runs, headingLevel: level, listDepth: null, marker: null, quoted: false,
        });
      }
      continue;
    }

    // A dashed underline is also a thematic break, so it is claimed as a setext heading before the rule check below sees it.
    const setextMatch = openBlock && openBlock.kind === 'paragraph' && openBlock.listDepth === null ? /^ {0,3}(=+|-+)[ \t]*$/.exec(line) : null;
    if (setextMatch) {
      openBlock.kind = 'heading';
      openBlock.headingLevel = setextMatch[1][0] === '=' ? 1 : 2;
      openBlock.bold = true;
      closeBlock();
      continue;
    }

    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      closeBlock();
      listStack.length = 0;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      closeBlock();
      listStack.length = 0;
      /** @type {Array<string>} */
      const quoteLines = [];
      let j = i;
      for (; j < blockLines.length; j++) {
        if (/^ {0,3}>/.test(blockLines[j])) {
          quoteLines.push(blockLines[j].replace(/^ {0,3}> ?/, ''));
        } else if (blockLines[j].trim()
          && !/^ {0,3}#{1,6}[ \t]/.test(blockLines[j])
          && !/^ {0,3}(?:`{3,}|~{3,})/.test(blockLines[j])
          && !/^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]/.test(blockLines[j])
          && !/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(blockLines[j])
          && !/^ {0,3}(?:=+|-+)[ \t]*$/.test(blockLines[j])
          && !/^ {0,3}\[(?:\^[^\]\s]+|(?:\\[\s\S]|[^\]\\])+)\]:/.test(blockLines[j])) {
          // A plain text line directly after a quote line continues it, which is the lazy continuation CommonMark allows for any paragraph.
          quoteLines.push(blockLines[j]);
        } else {
          break;
        }
      }
      for (const inner of parseMdBlocks(quoteLines, refs, font)) {
        inner.quoted = true;
        blocks.push(inner);
      }
      i = j - 1;
      continue;
    }

    // Indented code is recognized only outside a list and outside an open paragraph, where the same indentation is ordinary content.
    if (!openBlock && listStack.length === 0 && /^(?: {4}|\t)/.test(line) && line.trim()) {
      /** @type {Array<MdRun>} */
      const runs = [];
      let last = i;
      for (let j = i; j < blockLines.length; j++) {
        const codeMatch = /^(?: {4}|\t)([\s\S]*)$/.exec(blockLines[j]);
        if (codeMatch && blockLines[j].trim()) {
          if (runs.length > 0) {
            runs.push({
              text: '\n', bold: false, italic: false, sup: false, font: CODE_FONT_FAMILY, link: null,
            });
          }
          runs.push({
            text: codeMatch[1].replace(/\t/g, '    '), bold: false, italic: false, sup: false, font: CODE_FONT_FAMILY, link: null,
          });
          last = j;
        } else if (blockLines[j].trim()) {
          break;
        }
      }
      blocks.push({
        kind: 'code', runs, headingLevel: null, listDepth: null, marker: null, quoted: false,
      });
      i = last;
      continue;
    }

    const fnDefMatch = !openBlock ? /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line) : null;
    if (fnDefMatch) {
      listStack.length = 0;
      openBlock = {
        text: trimBlockLine(fnDefMatch[2]),
        kind: 'footnote',
        headingLevel: null,
        listDepth: null,
        marker: null,
        bold: false,
        hardBreak: endsHardBreak(fnDefMatch[2]),
        footnoteLabel: fnDefMatch[1],
      };
      continue;
    }

    // A reference-link definition contributes its destination through the pre-pass and no text of its own.
    if (!openBlock && /^ {0,3}\[((?:\\[\s\S]|[^\]\\])+)\]:[ \t]*<?[^\s<>]+>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/.test(line)) {
      listStack.length = 0;
      continue;
    }

    const listMatch = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+(.*)$/.exec(line);
    if (listMatch) {
      closeBlock();
      const indentCols = listMatch[1].replace(/\t/g, '    ').length;
      while (listStack.length > 0 && indentCols < listStack[listStack.length - 1]) listStack.pop();
      const depth = Math.min(listStack.length, 3);
      const marker = listMatch[2] || `${listMatch[3]}${listMatch[4]}`;
      listStack.length = depth;
      listStack.push(indentCols + marker.length + 1);
      let itemText = listMatch[5];
      // The bullet character stands in for the source's `-`/`*`/`+`, which is syntax rather than something the reader sees.
      let visibleMarker = listMatch[2] ? '•' : marker;
      const task = listMatch[2] ? /^\[([ xX])\][ \t]+/.exec(itemText) : null;
      if (task) {
        visibleMarker = task[1] === ' ' ? '☐' : '☑';
        itemText = itemText.slice(task[0].length);
      }
      openBlock = {
        text: trimBlockLine(itemText),
        kind: 'paragraph',
        headingLevel: null,
        listDepth: depth,
        marker: visibleMarker,
        bold: false,
        hardBreak: endsHardBreak(itemText),
      };
      continue;
    }

    if (openBlock) {
      openBlock.text += (openBlock.hardBreak ? '\n' : ' ') + trimBlockLine(line);
      openBlock.hardBreak = endsHardBreak(line);
    } else {
      listStack.length = 0;
      openBlock = {
        text: trimBlockLine(line),
        kind: 'paragraph',
        headingLevel: null,
        listDepth: null,
        marker: null,
        bold: false,
        hardBreak: endsHardBreak(line),
      };
    }
  }
  closeBlock();
  return blocks;
}
