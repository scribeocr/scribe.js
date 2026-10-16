const BAR = {
  menu: { size: 26, paths: '<path d="M4.5 7H21.5M4.5 13H21.5M4.5 19H21.5"/>' },
  sidebar: { size: 26, paths: '<rect x="4" y="6" width="18" height="14" rx="2.5"/><path d="M10 6V20"/>' },
  undo: { size: 26, paths: '<path d="M8.5 5L4.5 9L8.5 13"/><path d="M4.5 9H15A6 6 0 0 1 15 21H10"/>' },
  redo: { size: 26, paths: '<path d="M17.5 5L21.5 9L17.5 13"/><path d="M21.5 9H11A6 6 0 0 0 11 21H16"/>' },
  automate: { size: 26, paths: '<path d="M6 8L11.5 13L6 18Z"/><path d="M15 8H21M15 13H21M15 18H19"/>' },
  prev: { size: 26, paths: '<path d="M16.25 6.5L9.75 13L16.25 19.5"/>' },
  next: { size: 26, paths: '<path d="M9.75 6.5L16.25 13L9.75 19.5"/>' },
  rotateLeft: { size: 26, paths: '<path d="M6.07 9A8 8 0 1 0 13 5"/><path d="M9.3 5L13 3.1V6.9Z" fill="currentColor" stroke="none"/>' },
  rotateRight: { size: 26, paths: '<path d="M19.93 9A8 8 0 1 1 13 5"/><path d="M16.7 5L13 3.1V6.9Z" fill="currentColor" stroke="none"/>' },
  zoomOut: { size: 26, paths: '<circle cx="13" cy="13" r="7"/><path d="M17.95 17.95L21.49 21.49"/><path d="M10 13H16"/>' },
  zoomIn: { size: 26, paths: '<circle cx="13" cy="13" r="7"/><path d="M17.95 17.95L21.49 21.49"/><path d="M10 13H16M13 10V16"/>' },
  find: { size: 26, paths: '<circle cx="13" cy="13" r="7"/><path d="M17.95 17.95L21.49 21.49"/>' },
  close: { size: 26, paths: '<path d="M6.5 6.5L19.5 19.5M19.5 6.5L6.5 19.5"/>' },
  book: { size: 26, paths: '<path d="M13 6.5C11.3 5.1 8.6 4.5 5 4.5V19.5C8.6 19.3 11.3 19.9 13 21.5C14.7 19.9 17.4 19.3 21 19.5V4.5C17.4 4.5 14.7 5.1 13 6.5Z"/><path d="M13 6.5V21.5"/>' },
  // The tip's class is how the highlight tool fills it with the active swatch color.
  highlighter: {
    size: 26,
    paths: '<path class="scribe-hl-tip" fill="currentColor" stroke="none" d="M8 16V6.3A2.3 2.3 0 0 1 11.3 4.2L16.5 6.6A2.3 2.3 0 0 1 18 8.6V16Z"/>'
      + '<path fill="currentColor" stroke="none" d="M5 22L5.7 19.5A2 2 0 0 1 7.6 18H18.4A2 2 0 0 1 20.3 19.5L21 22Z"/>',
  },
  openInTab: { size: 26, paths: '<path d="M11 7H8.5A2.5 2.5 0 0 0 6 9.5V17.5A2.5 2.5 0 0 0 8.5 20H16.5A2.5 2.5 0 0 0 19 17.5V15"/><path d="M14.5 6H20V11.5M20 6L12 14"/>' },
  stepUp: { size: 22, paths: '<path d="M6.5 13.5L11 9L15.5 13.5"/>' },
  stepDown: { size: 22, paths: '<path d="M6.5 8.5L11 13L15.5 8.5"/>' },
};

const SLOT = {
  search16: { size: 16, paths: '<circle cx="7.5" cy="7.5" r="4"/><path d="M10.33 10.33L12.38 12.38"/>' },
  grid16: {
    size: 16,
    paths: '<rect x="2.5" y="2.5" width="4" height="4" rx="0.5"/>'
      + '<rect x="9.5" y="2.5" width="4" height="4" rx="0.5"/>'
      + '<rect x="2.5" y="9.5" width="4" height="4" rx="0.5"/>'
      + '<rect x="9.5" y="9.5" width="4" height="4" rx="0.5"/>',
  },
  list16: {
    size: 16,
    paths: '<rect x="2.5" y="2.5" width="4" height="4" rx="0.5"/>'
      + '<rect x="2.5" y="9.5" width="4" height="4" rx="0.5"/>'
      + '<path d="M8.5 3.5H13.5M8.5 5.5H12M8.5 10.5H13.5M8.5 12.5H12"/>',
  },
  compact16: { size: 16, paths: '<path d="M2.5 3.5H13.5M2.5 6.5H13.5M2.5 9.5H13.5M2.5 12.5H13.5"/>' },
  sort18: { size: 18, paths: '<path d="M5.5 3.5V14.5M3.25 12.25L5.5 14.5L7.75 12.25M12.5 3.5V14.5M10.25 5.75L12.5 3.5L14.75 5.75"/>' },
  plus18: { size: 18, paths: '<path d="M4.5 9.5H14.5M9.5 4.5V14.5"/>' },
  refresh18: { size: 18, paths: '<path d="M14.5 9.5A5 5 0 1 1 13.5 6.5"/><path d="M13.5 3.5V6.5H10.5"/>' },
  preview22: { size: 22, paths: '<rect x="2.5" y="4.5" width="17" height="13" rx="2"/><path d="M13.5 4.5V17.5"/>' },
  refresh22: { size: 22, paths: '<path d="M18.5 11A7.5 7.5 0 1 1 17.6 7.44L17.5 7.5"/><path d="M17.5 3.5V7.5H13.5"/>' },
  chevron12: { size: 12, paths: '<path d="M3 4.5L6 7.5L9 4.5"/>' },
  moon16: { size: 16, paths: '<path d="M8 2.5A3.9 3.9 0 0 0 13.5 8A5.5 5.5 0 1 1 8 2.5Z"/>' },
};

/**
 * A toolbar button's icon, drawn with a 2px stroke at its own size.
 * @param {keyof BAR} name
 * @returns {string} The SVG markup.
 */
export function barIcon(name) {
  const { size, paths } = BAR[name];
  // The class is how the toolbar's stylesheet scales the glyph up to a touch bar's larger buttons.
  return `<svg class="scribe-bar-glyph" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block" aria-hidden="true">${paths}</svg>`;
}

/**
 * An icon drawn at its native size with a 1px stroke.
 * @param {keyof SLOT} name
 * @param {string} [className] - Class for the svg element.
 * @returns {string} The SVG markup.
 */
export function slotIcon(name, className) {
  const { size, paths } = SLOT[name];
  return `<svg${className ? ` class="${className}"` : ''} viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block" aria-hidden="true">${paths}</svg>`;
}
