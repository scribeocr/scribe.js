export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

/**
 * @param {string} key
 * @param {{shift?: boolean}} [mods]
 * @returns {string}
 */
export function shortcutLabel(key, { shift = false } = {}) {
  if (IS_MAC) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
