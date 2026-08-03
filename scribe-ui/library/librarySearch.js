// Full-text index for the document library.
// Documents are keyed by content hash, so renames and moves never touch the index.

/** @param {string} text @returns {string[]} */
export const tokenize = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);

export class LibraryIndex {
  constructor() {
    /** @type {Array<?string>} Doc hash per index slot; null = removed. */
    this.docs = [];
    /** @type {Map<string, number>} */
    this.docSlots = new Map();
    /** @type {Map<string, Array<[number, number]>>} token -> [docIdx, pageN] pairs. */
    this.vocab = new Map();
  }

  /**
   * Add or replace a document's postings.
   * @param {string} hash
   * @param {string[]} pagesText - Plain text per page.
   */
  addDoc(hash, pagesText) {
    this.removeDoc(hash);
    const idx = this.docs.length;
    this.docs.push(hash);
    this.docSlots.set(hash, idx);
    for (let pageN = 0; pageN < pagesText.length; pageN++) {
      // One posting per distinct token per page keeps postings proportional to vocabulary, not word count.
      const seen = new Set(tokenize(pagesText[pageN]));
      for (const token of seen) {
        let postings = this.vocab.get(token);
        if (!postings) {
          postings = [];
          this.vocab.set(token, postings);
        }
        postings.push([idx, pageN]);
      }
    }
  }

  /** @param {string} hash */
  removeDoc(hash) {
    const idx = this.docSlots.get(hash);
    if (idx === undefined) return;
    this.docs[idx] = null;
    this.docSlots.delete(hash);
  }

  /**
   * Pages containing every token of the query, grouped per document and ranked by matching-page count.
   * @param {string} query
   * @returns {Array<{hash: string, pages: number[]}>}
   */
  query(query) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    /** @type {?Map<string, Set<number>>} doc hash -> pages, intersected across tokens. */
    let perDoc = null;
    for (const token of tokens) {
      const postings = this.vocab.get(token) || [];
      const tokenDocs = new Map();
      for (const [idx, pageN] of postings) {
        const hash = this.docs[idx];
        if (hash === null) continue;
        let pages = tokenDocs.get(hash);
        if (!pages) {
          pages = new Set();
          tokenDocs.set(hash, pages);
        }
        pages.add(pageN);
      }
      if (perDoc === null) {
        perDoc = tokenDocs;
      } else {
        for (const [hash, pages] of perDoc) {
          const other = tokenDocs.get(hash);
          if (!other) {
            perDoc.delete(hash);
          } else {
            const kept = new Set();
            for (const p of pages) if (other.has(p)) kept.add(p);
            if (kept.size) perDoc.set(hash, kept);
            else perDoc.delete(hash);
          }
        }
      }
      if (!perDoc.size) return [];
    }
    const results = [];
    for (const [hash, pages] of /** @type {Map<string, Set<number>>} */ (perDoc)) {
      results.push({ hash, pages: [...pages].sort((a, b) => a - b) });
    }
    results.sort((a, b) => b.pages.length - a.pages.length);
    return results;
  }

  /** Compact, JSON-serializable form with tombstoned slots dropped and the remaining doc indexes renumbered. */
  serialize() {
    /** @type {string[]} */
    const docs = [];
    /** @type {Map<number, number>} */
    const remap = new Map();
    for (let i = 0; i < this.docs.length; i++) {
      const hash = this.docs[i];
      if (hash === null) continue;
      remap.set(i, docs.length);
      docs.push(hash);
    }
    /** @type {Object<string, Array<[number, number]>>} */
    const vocab = {};
    for (const [token, postings] of this.vocab) {
      const kept = [];
      for (const [idx, pageN] of postings) {
        const newIdx = remap.get(idx);
        if (newIdx !== undefined) kept.push([newIdx, pageN]);
      }
      if (kept.length) vocab[token] = kept;
    }
    return { version: 1, docs, vocab };
  }

  /**
   * @param {?Object} data - Output of serialize(); tolerates null/corrupt input by returning an empty index.
   * @returns {LibraryIndex}
   */
  static deserialize(data) {
    const index = new LibraryIndex();
    if (!data || data.version !== 1 || !Array.isArray(data.docs) || !data.vocab) return index;
    index.docs = data.docs.slice();
    for (let i = 0; i < index.docs.length; i++) index.docSlots.set(/** @type {string} */ (index.docs[i]), i);
    for (const [token, postings] of Object.entries(data.vocab)) index.vocab.set(token, postings);
    return index;
  }
}
