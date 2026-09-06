import { collectNameTreeNode, walkNameTree } from './parseOutline.js';
import { findRootObjNum } from './parsePdfUtils.js';
import {
  decodePdfName, derefStringToken, extractDict, parseDictEntries, parsePdfDate, resolveDictValue, resolveIntValue, resolveNameValue,
} from './pdfPrimitives.js';

/**
 * @typedef {Object} AttachmentFile
 * @property {string} key - The file's name-tree key, unique within the document and keeping the `<n>` folder prefix.
 *   What `doc.getAttachmentBytes` takes.
 * @property {string} name - Display name (`/UF`, else `/F`, else the key).
 * @property {?number} folderId - The collection folder the key was prefixed with (`<n>name`), null when none.
 * @property {?string} description - `/Desc`.
 * @property {?string} mimeType - The embedded stream's `/Subtype`, as a MIME type.
 * @property {?number} size - Uncompressed byte size from the stream's `/Params`.
 * @property {?string} modDate - ISO-8601, from `/Params`.
 * @property {?string} creationDate - ISO-8601, from `/Params`.
 * @property {number} objNum - Object number of the embedded file stream.
 */

/**
 * @typedef {Object} AttachmentFolder
 * @property {number} id - The `/ID` the folder's files are keyed under (`<id>name`).
 * @property {string} name - `/Name`.
 * @property {number} parentId - The enclosing folder's `/ID`, the root folder's for a top-level folder.
 * @property {string} path - The folder names from the root, joined with `/`.
 */

/**
 * @typedef {Object} AttachmentCollection
 * @property {?string} initial - Key of the file to show first (`/D`, else the first file).
 * @property {Array<AttachmentFolder>} folders - The folder tree (PDF 2.0) flattened parent-first, siblings in the author's order.
 *   Empty when the collection declares no folders.
 */

/**
 * @typedef {Object} Attachments
 * @property {?AttachmentCollection} collection - Null unless the catalog carries a collection dictionary (a portfolio).
 * @property {Array<AttachmentFile>} files - Every embedded file, in name-tree order.
 */

/**
 * Parse a loaded PDF's embedded files, the catalog's `/Names /EmbeddedFiles` name tree.
 * For a portfolio, also the `/Collection` dictionary that presents them (ISO 32000-2 12.3.5, 7.11.4).
 * No stream is decoded here.
 *
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @returns {Attachments}
 */
export function parseAttachments(objCache) {
  /** @type {Attachments} */
  const result = { collection: null, files: [] };
  const catalogObjNum = findRootObjNum(objCache.pdfBytes);
  if (!catalogObjNum) return result;
  const catalogText = objCache.getObjectText(catalogObjNum);
  if (!catalogText) return result;

  /**
   * The `<<...>>` text of a dict-valued token, inline or an indirect reference.
   * @param {?string} token
   * @returns {?string}
   */
  const dictOf = (token) => {
    if (!token) return null;
    const t = token.trim();
    if (t.startsWith('<<')) return t;
    const m = /^(\d+)\s+\d+\s+R$/.exec(t);
    if (!m) return null;
    const text = objCache.getObjectText(Number(m[1]));
    const i = text ? text.indexOf('<<') : -1;
    return i === -1 ? null : extractDict(/** @type {string} */ (text), i);
  };
  /**
   * Top-level entries of a `<<...>>` token, keyed by name.
   * @param {?string} dict
   * @returns {Map<string, string>}
   */
  const entriesOf = (dict) => new Map(dict ? parseDictEntries(dict.slice(2, -2)).map((e) => [e.name, e.valueText]) : []);

  /** @type {Map<string, string>} */
  const tree = new Map();
  const namesText = resolveDictValue(catalogText, 'Names', objCache);
  if (namesText) {
    const rootRef = /\/EmbeddedFiles\s+(\d+)\s+\d+\s+R/.exec(namesText);
    if (rootRef) walkNameTree(Number(rootRef[1]), objCache, tree, new Set());
    else {
      const inlineRoot = resolveDictValue(namesText, 'EmbeddedFiles', objCache);
      if (inlineRoot) collectNameTreeNode(inlineRoot, objCache, tree, new Set());
    }
  }

  const collectionText = resolveDictValue(catalogText, 'Collection', objCache);
  for (const [rawKey, specToken] of tree) {
    const spec = dictOf(specToken);
    if (!spec) continue;
    const ef = resolveDictValue(spec, 'EF', objCache);
    const streamRef = ef ? (/\/UF\s+(\d+)\s+\d+\s+R/.exec(ef) || /\/F\s+(\d+)\s+\d+\s+R/.exec(ef)) : null;
    // A file specification without an embedded stream points outside the PDF, so no bytes could ever be served for it.
    if (!streamRef) continue;
    const objNum = Number(streamRef[1]);
    const stream = dictOf(`${objNum} 0 R`);
    const specEntries = entriesOf(spec);
    const folder = /^<(\d+)>(.*)$/.exec(rawKey);
    const key = rawKey;
    const nameToken = specEntries.get('UF') ?? specEntries.get('F');
    const descToken = specEntries.get('Desc');
    const params = stream ? resolveDictValue(stream, 'Params', objCache) : null;
    const paramEntries = entriesOf(params);
    /** @param {?string} token */
    const dateOf = (token) => (token ? parsePdfDate(derefStringToken(token, objCache)) : null);
    const size = params ? resolveIntValue(params, 'Size', objCache, -1) : -1;
    const subtype = stream ? resolveNameValue(stream, 'Subtype', objCache) : null;
    /** @type {AttachmentFile} */
    const file = {
      key,
      name: nameToken ? derefStringToken(nameToken, objCache) : (folder ? folder[2] : rawKey),
      folderId: folder ? Number(folder[1]) : null,
      description: descToken ? derefStringToken(descToken, objCache) : null,
      mimeType: subtype ? decodePdfName(subtype) : null,
      size: size >= 0 ? size : null,
      modDate: dateOf(paramEntries.get('ModDate')),
      creationDate: dateOf(paramEntries.get('CreationDate')),
      objNum,
    };
    result.files.push(file);
  }

  if (collectionText) {
    const colEntries = entriesOf(collectionText);
    const initialToken = colEntries.get('D');
    const initialRaw = initialToken ? derefStringToken(initialToken, objCache) : null;
    // The root folder holds the unprefixed files and is not itself listed, so the walk starts at its /Child.
    // Folder dictionaries are indirect by the spec, so their object numbers can guard against a cyclic /Child or /Next.
    /** @type {Array<AttachmentFolder>} */
    const folders = [];
    const rootFolder = resolveDictValue(collectionText, 'Folders', objCache);
    if (rootFolder) {
      const seen = new Set();
      /** @param {?string} token @param {number} parentId @param {string} parentPath */
      const walkFolders = (token, parentId, parentPath) => {
        let t = token;
        while (t) {
          const m = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(t);
          if (!m || seen.has(Number(m[1]))) return;
          seen.add(Number(m[1]));
          const dict = dictOf(t);
          if (!dict) return;
          const entries = entriesOf(dict);
          const id = resolveIntValue(dict, 'ID', objCache, -1);
          const nameToken = entries.get('Name');
          const name = nameToken ? derefStringToken(nameToken, objCache) : '';
          const path = parentPath ? `${parentPath}/${name}` : name;
          folders.push({
            id, name, parentId, path,
          });
          walkFolders(entries.get('Child') ?? null, id, path);
          t = entries.get('Next') ?? null;
        }
      };
      walkFolders(entriesOf(rootFolder).get('Child') ?? null, resolveIntValue(rootFolder, 'ID', objCache, 0), '');
    }
    result.collection = {
      // The spec falls back to the first file when /D is absent or names nothing in the tree.
      initial: (initialRaw != null && result.files.some((f) => f.key === initialRaw) ? initialRaw : null) || result.files[0]?.key || null,
      folders,
    };
  }
  return result;
}
