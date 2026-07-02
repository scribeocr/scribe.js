// TODO: At present, `pageMetrics` objects are created when (1) OCR data is imported or (2) a PDF is imported.
// It is not created when only images are imported.  Presumably this should happen.
// If this is implemented it would likely allow for simplifying other code, as this case would not need to be handled separately.

/**
 * Object containing metrics about a page in the document.
 *
 * @param {dims} dims
 * @property {?number} angle - Angle of page in degrees.  `null` if angle is unknown.
 * @property {dims} dims
 * @property {?number} left -
 * @property {number} manAdj
 * @property {number} rotation - User-applied page rotation in degrees (0, 90, 180, or 270), composed with the input PDF's `/Rotate` only at export.
 *   Distinct from `angle` (deskew) and from the input `/Rotate`, which is already baked into the rendered raster and the stored `dims`.
 * @property {?number} sourcePageN - Which original (immutable worker) page to raster for this display slot, set once the page order is edited (delete/reorder).
 *   `null` means "identity" (raster the page's own current index), the state of every page until the first structural edit.
 *   Lets the display order diverge from the source PDF without mutating the worker.
 * @property {?number} sourceId - Which render source (see `RenderSource`) the `sourcePageN` index belongs to.
 *   `null` means this document's own (primary) source — the state of every page until one is copied in from another document.
 *   Set to a concrete source id when a foreign page is inserted, so its raster (and, on export, its bytes) come from its true origin.
 * @description The `pageMetrics` object contains the "official" metrics for each page of the source document, and exists independent from the OCR data.
 * For general tasks (not specifically analyzing OCR data), `pageMetrics` metrics should be used for information about a page.
 * For example, both `ocrPage` and `pageMetrics` have an `angle` property.  However, the `angle` property of `ocrPage`
 * is based on the median line slope for that particular OCR data, whereas the `angle` property of `pageMetrics` should
 * represent the true page angle of the underlying page.
 */
export function PageMetrics(dims) {
  /** @type {?number} */
  this.angle = null;
  /** @type {dims} */
  this.dims = { ...dims };
  /** @type {?number} */
  this.left = null;
  /** @type {number} */
  this.manAdj = 0;
  /** @type {number} */
  this.rotation = 0;
  /** @type {?number} */
  this.sourcePageN = null;
  /** @type {?number} */
  this.sourceId = null;
}
