/**
 * @typedef {Object} TokenizerRules
 * @property {boolean} oneCharTokens - One-character tokens kept, and § ¶ % $ kept as tokens of their own.
 * @property {boolean} hyphenJoin - A line-end hyphenation yields the joined word as well as its two halves.
 * @property {boolean} compat - Compatibility normalization (NFKD), diacritics stripped, ligatures expanded.
 * @property {boolean|'both'} markersUnpositioned - How a transcript line number or a superscript footnote marker is indexed.
 *   When true, it takes no position.
 *   When 'both', it keeps its position and is also listed in the page's `markers`, positions a phrase may step over.
 *   Under 'both', a run of line numbers that labels table cells or counts from 0 is not taken for line numbers.
 *   When false, it is an ordinary token.
 * @property {boolean} apostrophes - Apostrophes (straight and curly) deleted inside a token.
 */

/** @type {TokenizerRules} */
export const TOKENIZER_DEFAULTS = Object.freeze({
  oneCharTokens: true, hyphenJoin: true, compat: true, markersUnpositioned: 'both', apostrophes: true,
});

/** The dictionary term whose postings hold each page's `markers`. */
export const MARKER_TERM = '\u0000marker';

/**
 * One text page as the index takes it.
 * It holds what the tokenizer reads and what the page's view block stores.
 * It is a plain structure the main thread can post to the worker.
 * @typedef {Object} PageInput
 * @property {{width: number, height: number}} dims
 * @property {number} angle
 * @property {?string} textSource
 * @property {Array<{bbox: Box, type: ?string, headingLevel: ?number, parNum: ?number, marker: ?string}>} pars
 * @property {Array<InputLine>} lines - Lines in reading order.
 */
/**
 * @typedef {Object} InputLine
 * @property {?string} role - The paragraph's type ('linenum', 'body', ...).
 * @property {Box} bbox
 * @property {[number, number]} baseline
 * @property {?number} ascHeight
 * @property {?number} xHeight
 * @property {number} orientation
 * @property {?number} lineNum
 * @property {?string} pageNum
 * @property {?number} par - Index into the page's `pars`.
 * @property {Array<InputWord>} words
 */
/**
 * @typedef {Object} InputWord
 * @property {string} t
 * @property {boolean} [sup]
 * @property {Box} bbox
 * @property {?string} id - The word's id, or null when it is the positional id `word_<page>_<line>_<word>`, all counted from 1.
 * @property {?number} size
 * @property {?string} font
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} smallCaps
 * @property {boolean} dropcap
 * @property {boolean} underline
 * @property {?string} color
 * @property {number} opacity
 * @property {?string} lang
 * @property {number} conf
 * @property {boolean} visualCoords
 * @property {?string} footnoteParId
 */
/** @typedef {bbox} Box */

/**
 * A page's token stream.
 * Tokens are in emission order: reading order, a joined hyphenation before its two halves.
 * @typedef {Object} TokenStream
 * @property {string} text - The page's words joined by one space, its lines by one newline.
 * @property {string[]} terms
 * @property {number[]} pos - Each token's position, which a joined word shares with its first half.
 * @property {number[]} span - 1 when the token covers two positions (a joined hyphenation), else 0.
 * @property {number[]} charStart
 * @property {number[]} charEnd
 * @property {number[]} wordIndex - The page-wide index of the word each token came from (the first half for a joined word).
 * @property {number} positions
 * @property {number} unpositioned
 * @property {number[]} markers - When `markersUnpositioned` is 'both', the positions of marker tokens, ascending.
 */

const SYMBOL_TOKENS = new Set(['§', '¶', '%', '$']);
const APOSTROPHES = new Set(["'", '’', '‘', 'ʼ', '′']);
const MARK_RE = /\p{M}+/gu;
const ALNUM_RE = /^[\p{L}\p{N}]$/u;
// A symbol such as ™ is left out, since NFKD would expand it into letters glued to the word.
const NORMALIZABLE_RE = /^[\p{L}\p{N}\p{M}]$/u;
const HYPHEN_END_RE = /[\p{L}][-‐‑­]$/u;
const LOWER_START_RE = /^\p{Ll}/u;
const LINE_NUMBER_RE = /^\d{1,2}$/;
const DIGITS_RE = /^\d+$/;
const LETTER_RE = /\p{L}/u;
const SUP_MARKER_RE = /^(?:.{1,3}|[\d*†‡§¶,.()\-−–]+)$/u;

/**
 * @param {string} raw
 * @param {boolean} compat
 * @returns {{norm: string, rawAt: ?number[], rawEnd: ?number[]}} Per normalized character, the start and the end of its raw character.
 *   Both are null when the mapping is the identity.
 *   One raw character can yield several ("½" gives "1⁄2").
 */
const normalizeWord = (raw, compat) => {
  let ascii = true;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7e) {
      ascii = false;
      break;
    }
  }
  if (ascii || !compat) return { norm: raw.toLowerCase(), rawAt: null, rawEnd: null };
  let norm = '';
  const rawAt = [];
  const rawEnd = [];
  for (let i = 0; i < raw.length; i++) {
    const code = /** @type {number} */ (raw.codePointAt(i));
    const ch = String.fromCodePoint(code);
    const n = NORMALIZABLE_RE.test(ch) ? ch.normalize('NFKD').replace(MARK_RE, '').toLowerCase() : ch;
    const end = i + (code > 0xffff ? 2 : 1);
    for (let j = 0; j < n.length; j++) {
      rawAt.push(i);
      rawEnd.push(end);
    }
    norm += n;
    if (code > 0xffff) i++;
  }
  return { norm, rawAt, rawEnd };
};

/**
 * @param {string} norm
 * @param {TokenizerRules} rules
 * @returns {Array<{term: string, start: number, end: number}>}
 */
const splitWord = (norm, rules) => {
  const out = [];
  let term = '';
  let start = -1;
  const flush = (end) => {
    if (term && (rules.oneCharTokens || term.length >= 2)) out.push({ term, start, end });
    term = '';
    start = -1;
  };
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    const code = norm.charCodeAt(i);
    const alnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code > 0x7e && ALNUM_RE.test(ch));
    if (alnum) {
      if (start < 0) start = i;
      term += ch;
    } else if (APOSTROPHES.has(ch) && rules.apostrophes) {
      if (start < 0) start = i;
    } else {
      flush(i);
      if (SYMBOL_TOKENS.has(ch) && rules.oneCharTokens) out.push({ term: ch, start: i, end: i + 1 });
    }
  }
  flush(norm.length);
  return out;
};

/**
 * @param {?PageInput} page
 * @param {TokenizerRules} [rules]
 * @returns {TokenStream}
 */
export const tokenizePage = (page, rules = TOKENIZER_DEFAULTS) => {
  /** @type {TokenStream} */
  const out = {
    text: '', terms: [], pos: [], span: [], charStart: [], charEnd: [], wordIndex: [], positions: 0, unpositioned: 0, markers: [],
  };
  if (!page || !page.lines.length) return out;
  const lines = page.lines;
  const both = rules.markersUnpositioned === 'both';
  const lineNumberLines = new Set();
  const tableLines = new Set();
  if (rules.markersUnpositioned) {
    const numbered = [];
    for (let li = 0; li < lines.length; li++) {
      const w = lines[li].words[0];
      if (w && LINE_NUMBER_RE.test(w.t)) numbered.push({ li, n: Number(w.t) });
    }
    for (let a = 0; a < numbered.length;) {
      let b = a + 1;
      while (b < numbered.length && numbered[b].n === numbered[b - 1].n + 1) b++;
      if (b - a >= 2) {
        let table = false;
        if (both) {
          const labeled = new Map();
          for (let k = a; k < b; k++) {
            const { li } = numbered[k];
            let at = lines[li].words.length > 1 ? li : -1;
            for (let j = li + 1; at < 0 && j < lines.length; j++) {
              const l = lines[j];
              if (l.role !== 'linenum' && !(l.words.length && l.words.every((w) => DIGITS_RE.test(w.t)))) at = j;
            }
            if (at < 0 || labeled.has(at)) continue;
            const cell = lines[at].words.slice(at === li ? 1 : 0).map((w) => w.t).join('');
            labeled.set(at, !LETTER_RE.test(cell) && cell.replace(/\D/g, '').length >= 2);
          }
          let cells = 0;
          for (const isCell of labeled.values()) if (isCell) cells++;
          // Line numbers start at 1, so a run from a bare 0 is taken for an axis or a timeline.
          // A 0 that follows a bare 1 or 9 is instead the text layer's split of a two-digit line number ("1" then "0" for 10).
          const start = numbered[a];
          const zero = start.n === 0 && lines[start.li].words.length === 1
            && !lines.slice(Math.max(0, start.li - 2), start.li).some((l) => l.words.length === 1 && (l.words[0].t === '1' || l.words[0].t === '9'));
          table = zero || (cells >= 2 && cells * 2 > labeled.size);
        }
        for (let k = a; k < b; k++) (table ? tableLines : lineNumberLines).add(numbered[k].li);
      }
      a = b;
    }
  }
  let text = '';
  let wordCounter = 0;
  let pendingJoin = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (li > 0) text += '\n';
    const lineIsNumber = rules.markersUnpositioned && line.role === 'linenum' && !tableLines.has(li);
    let firstInLine = true;
    for (let wi = 0; wi < line.words.length; wi++) {
      const word = line.words[wi];
      const raw = word.t;
      if (wi > 0) text += ' ';
      const rawStart = text.length;
      text += raw;
      const index = wordCounter++;
      const marker = lineIsNumber
        || (rules.markersUnpositioned && wi === 0 && lineNumberLines.has(li))
        || (rules.markersUnpositioned && !!word.sup && SUP_MARKER_RE.test(raw));
      const { norm, rawAt, rawEnd } = normalizeWord(raw, rules.compat);
      const tokens = splitWord(norm, rules);
      if (!tokens.length) continue;
      // Under 'both' a marker keeps its position, except right after a line-end hyphenation, where it takes none so the halves can still join.
      if (marker && (!both || (pendingJoin && firstInLine))) {
        out.unpositioned += tokens.length;
        continue;
      }
      const startOf = (i) => rawStart + (rawAt ? rawAt[i] : i);
      const endOf = (i) => rawStart + (rawEnd ? rawEnd[i - 1] : i);
      let first = 0;
      if (pendingJoin && firstInLine && LOWER_START_RE.test(raw) && /^[\p{L}]/u.test(tokens[0].term)) {
        const j = pendingJoin;
        out.terms.push(j.term + tokens[0].term);
        out.pos.push(j.pos);
        out.span.push(1);
        out.charStart.push(j.charStart);
        out.charEnd.push(endOf(tokens[0].end));
        out.wordIndex.push(j.wordIndex);
        out.terms.push(j.term);
        out.pos.push(j.pos);
        out.span.push(0);
        out.charStart.push(j.charStart);
        out.charEnd.push(j.charEnd);
        out.wordIndex.push(j.wordIndex);
        out.positions = j.pos + 1;
        out.terms.push(tokens[0].term);
        out.pos.push(out.positions++);
        out.span.push(0);
        out.charStart.push(startOf(tokens[0].start));
        out.charEnd.push(endOf(tokens[0].end));
        out.wordIndex.push(index);
        first = 1;
      } else if (pendingJoin) {
        const j = pendingJoin;
        out.terms.push(j.term);
        out.pos.push(j.pos);
        out.span.push(0);
        out.charStart.push(j.charStart);
        out.charEnd.push(j.charEnd);
        out.wordIndex.push(j.wordIndex);
        out.positions = j.pos + 1;
      }
      pendingJoin = null;
      firstInLine = false;
      const last = tokens.length - 1;
      const holdsJoin = !marker && rules.hyphenJoin && wi === line.words.length - 1 && HYPHEN_END_RE.test(raw) && /^[\p{L}]/u.test(tokens[last].term) && last >= first;
      for (let k = first; k <= last; k++) {
        const t = tokens[k];
        if (holdsJoin && k === last) {
          pendingJoin = {
            term: t.term, pos: out.positions, charStart: startOf(t.start), charEnd: endOf(t.end), wordIndex: index,
          };
          break;
        }
        if (marker) out.markers.push(out.positions);
        out.terms.push(t.term);
        out.pos.push(out.positions++);
        out.span.push(0);
        out.charStart.push(startOf(t.start));
        out.charEnd.push(endOf(t.end));
        out.wordIndex.push(index);
      }
    }
  }
  if (pendingJoin) {
    const j = pendingJoin;
    out.terms.push(j.term);
    out.pos.push(j.pos);
    out.span.push(0);
    out.charStart.push(j.charStart);
    out.charEnd.push(j.charEnd);
    out.wordIndex.push(j.wordIndex);
    out.positions = j.pos + 1;
  }
  out.text = text;
  return out;
};

/**
 * @param {string} query
 * @param {TokenizerRules} [rules] - The rules the index was built under.
 * @returns {string[]}
 */
export const tokenizeQuery = (query, rules = TOKENIZER_DEFAULTS) => {
  const terms = [];
  for (const raw of query.split(/\s+/)) {
    if (!raw) continue;
    for (const t of splitWord(normalizeWord(raw, rules.compat).norm, rules)) terms.push(t.term);
  }
  return terms;
};

/**
 * @param {import('./searchPageRecords.js').PageRecord} rec
 * @param {number} k - The token's index in the record.
 * @param {TokenizerRules} rules - The rules the page was tokenized under.
 * @returns {string}
 */
export const recordTokenTerm = (rec, k, rules) => {
  if (rec.span[k]) return recordTokenTerm(rec, k + 1, rules) + recordTokenTerm(rec, k + 2, rules);
  const { text } = rec;
  const start = rec.charStart[k];
  const end = rec.charEnd[k];
  // The word around the token, since a token can share a raw character with its neighbor ("2½" gives "21" and "2").
  let from = start;
  while (from > 0 && text[from - 1] !== ' ' && text[from - 1] !== '\n') from--;
  let to = end;
  while (to < text.length && text[to] !== ' ' && text[to] !== '\n') to++;
  const { norm, rawAt, rawEnd } = normalizeWord(text.slice(from, to), rules.compat);
  // Tokens share a range only when one raw character yields them all ("½" alone gives "1" and "2").
  // The record holds such tokens in the order the word yields them.
  let nth = 0;
  for (let j = k - 1; j >= 0 && rec.charStart[j] === start; j--) if (!rec.span[j] && rec.charEnd[j] === end) nth++;
  for (const t of splitWord(norm, rules)) {
    if (from + (rawAt ? rawAt[t.start] : t.start) !== start || from + (rawEnd ? rawEnd[t.end - 1] : t.end) !== end) continue;
    if (nth === 0) return t.term;
    nth--;
  }
  return '';
};

/**
 * @param {?import('../../../js/objects/ocrObjects.js').OcrPage} page
 * @returns {?PageInput}
 */
export const pageInputOf = (page) => {
  if (!page || !page.lines.length) return null;
  /** @type {Map<Object, number>} */
  const parIndex = new Map();
  const pars = [];
  for (const line of page.lines) {
    if (line.par && !parIndex.has(line.par)) {
      parIndex.set(line.par, pars.length);
      pars.push({
        bbox: line.par.bbox, type: line.par.type ?? null, headingLevel: line.par.headingLevel ?? null, parNum: line.par.parNum ?? null, marker: line.par.marker ?? null,
      });
    }
  }
  return {
    dims: page.dims,
    angle: page.angle || 0,
    textSource: page.textSource ?? null,
    pars,
    lines: page.lines.map((line, li) => ({
      role: line.par ? line.par.type : null,
      bbox: line.bbox,
      baseline: [line.baseline?.[0] || 0, line.baseline?.[1] || 0],
      ascHeight: line.ascHeight ?? null,
      xHeight: line.xHeight ?? null,
      orientation: line.orientation || 0,
      lineNum: line.lineNum ?? null,
      pageNum: line.pageNum ?? null,
      par: line.par ? /** @type {number} */ (parIndex.get(line.par)) : null,
      words: line.words.map((w, wi) => ({
        t: w.text,
        ...(w.style && w.style.sup ? { sup: true } : {}),
        bbox: w.bbox,
        id: w.id === `word_${page.n + 1}_${li + 1}_${wi + 1}` ? null : w.id,
        size: w.style?.size ?? null,
        font: w.style?.font ?? null,
        bold: !!w.style?.bold,
        italic: !!w.style?.italic,
        smallCaps: !!w.style?.smallCaps,
        dropcap: !!w.style?.dropcap,
        underline: !!w.style?.underline,
        color: w.style?.color ?? null,
        opacity: w.style?.opacity ?? 1,
        lang: w.lang ?? null,
        conf: w.conf ?? 0,
        visualCoords: w.visualCoords !== false,
        footnoteParId: w.footnoteParId ?? null,
      })),
    })),
  };
};
