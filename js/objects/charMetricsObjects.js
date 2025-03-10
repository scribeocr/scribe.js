/**
 * Object containing font metrics for individual font.
 * @property {Object.<string, number>} width - Width of glyph as proportion of x-height
 * @property {Object.<string, number>} height - height of glyph as proportion of x-height
 * @property {Object.<string, number>} kerning -
 * @property {Object.<string, boolean>} variants -
 * @property {OcrPage} heightCaps -
 * @property {?number} obs - Number of observations used to calculate statistics
 * @property {?number} obsCaps - Number of observations used to calculate heightCaps
 *
 * Note: The "x-height" metric referred to above is actually closer to the height of the "o" character.
 * This is because most characters used for this calculation are slightly larger than "x",
 * and Tesseract does not take this into account when performing this calculation.
 */
export function CharMetricsFont() {
  /** @type {Object.<string, number>} */
  this.width = {};
  /** @type {Object.<string, number>} */
  this.height = {};
  // /** @type {Object.<string, number>} */
  // this.desc = {};
  // /** @type {Object.<string, number>} */
  // this.advance = {};
  /** @type {Object.<string, number>} */
  this.kerning = {};
  /** @type {Object.<string, number>} */
  this.kerning2 = {};
  /** @type {Object.<string, boolean>} */
  this.variants = {};
  /** @type {number} */
  this.heightCaps = 1.3;
  /** @type {number} */
  this.obs = 0;
  /** @type {number} */
  this.obsCaps = 0;
}

export function CharMetricsFamily() {
  this.normal = new CharMetricsFont();
  this.italic = new CharMetricsFont();
  this.smallCaps = new CharMetricsFont();
  this.bold = new CharMetricsFont();
  this.obs = 0;
}

/**
 * Object containing individual observations of various character metrics.
 */
export function CharMetricsRawFont() {
  /** @type {Object.<string, Array.<number>>} */
  this.width = {};
  /** @type {Object.<string, Array.<number>>} */
  this.height = {};
  // /** @type {Object.<string, Array.<number>>} */
  // this.desc = {};
  // /** @type {Object.<string, Array.<number>>} */
  // this.advance = {};
  /** @type {Object.<string, Array.<number>>} */
  this.kerning = {};
  /** @type {Object.<string, Array.<number>>} */
  this.kerning2 = {};
  /** @type {number} */
  this.obs = 0;
}

export function CharMetricsRawFamily() {
  this.normal = new CharMetricsRawFont();
  this.italic = new CharMetricsRawFont();
  this.smallCaps = new CharMetricsRawFont();
  this.bold = new CharMetricsRawFont();
}
