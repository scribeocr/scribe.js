// One list of the folders and files opened recently, for every surface that shows, reopens, removes or clears them.
// Folders come from the library, which alone holds the handles that reopen them.
// Files come from a desktop shell, which alone can read a path, so the renderer never sees one.

/**
 * One row of the list.
 * @typedef {Object} RecentEntry
 * @property {'folder'|'file'} kind
 * @property {string} label - The folder or file name.
 * @property {string} dir - Where it is, or '' while unknown.
 * @property {() => void} open
 * @property {() => void} remove - Drops the entry from its store, after which the list changes.
 */

/**
 * @returns {{
 *   setFolders: (entries: RecentEntry[], onClear?: () => void) => void,
 *   setFiles: (entries: RecentEntry[], onClear?: () => void) => void,
 *   list: () => RecentEntry[],
 *   clear: () => void,
 *   onChange: (listener: () => void) => () => void,
 * }}
 */
export function createRecents() {
  /** @type {RecentEntry[]} */
  let folders = [];
  /** @type {RecentEntry[]} */
  let files = [];
  /** @type {?(() => void)} */
  let clearFolders = null;
  /** @type {?(() => void)} */
  let clearFiles = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    setFolders(entries, onClear) {
      folders = entries;
      clearFolders = onClear ?? null;
      notify();
    },
    setFiles(entries, onClear) {
      files = entries;
      clearFiles = onClear ?? null;
      notify();
    },
    list: () => [...folders, ...files],
    clear() {
      clearFolders?.();
      clearFiles?.();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
