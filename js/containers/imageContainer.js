import {
  PageMetrics,
} from '../objects/pageMetricsObjects.js';
import { reassignOutlineIds } from '../objects/outlineObjects.js';

import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import { range } from '../utils/miscUtils.js';
import { opt } from './app.js';

import { initPdfScheduler, PdfScheduler } from '../pdfWorkerMain.js';
import {
  acquireWorkers, releaseWorkers, retireWorkers, setRoomMaker,
} from '../pdfWorkerPool.js';
import { scribeDocDefaults } from './scribeDocDefaults.js';
import { SKIPPED, laneOf, LANE_RANK } from '../../tess/TessScheduler.js';
import { ca } from '../canvasAdapter.js';

/** @typedef {import('./scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * A raster of a page that is on its way to a viewer, which the page's thumbnail can be cut from.
 * @typedef {Object} ViewerRaster
 * @property {?import('../../tess/TessScheduler.js').Lane} lane - The lane of the render it comes from, or null when no render stands behind it.
 * @property {PageMetrics} pm - The page it pictures.
 * @property {number} invalidations - How often the page's renders had been invalidated when the raster was asked for.
 * @property {number} rendersLanded - How many renders of the page had landed when the raster was asked for.
 * @property {boolean} wanted - Whether a thumbnail request waits for it.
 * @property {number} persistAs - The source page under which a thumbnail cut from the raster is stored in the host's thumbnail store, or -1 when it is not stored there.
 * @property {Promise<?Blob>} thumbnail - The thumbnail cut from the raster once it lands, or null when none was.
 * @property {(thumbnail: ?Promise<?Blob>) => void} settle - Settles `thumbnail`.
 */

/**
 * A store of page thumbnails that outlives the document.
 * @typedef {Object} PageThumbCache
 * @property {(sourcePageN: number) => boolean} has
 * @property {(sourcePageN: number) => Promise<?Blob>} get - The stored thumbnail, or null when it cannot be read.
 * @property {(sourcePageN: number, blob: Blob) => void} put
 */

// Background renders can fail when they reuse a viewer render that is then dropped (skipped).
// The background render retries when this happens.
// This cap is an arbitrarily high number, and hitting indicates a logic error.
const MAX_SKIPPED_RETRY = 32;

// Above the largest size any surface displays a thumbnail at, so CSS only ever downscales and cells stay crisp on high-DPI screens.
const THUMBNAIL_W = 300;

/** @type {?boolean} */
let _sabCapability = null;
/**
 * Check whether `SharedArrayBuffer` can actually be allocated and shared
 * across workers in the current runtime. In Node (worker_threads) this is
 * unconditional; in browsers it requires COOP/COEP / `crossOriginIsolated`.
 * Probe result is memoized — capabilities don't change at runtime.
 */
function canUseSharedArrayBuffer() {
  if (_sabCapability !== null) return _sabCapability;
  try {
    if (typeof SharedArrayBuffer === 'undefined') return (_sabCapability = false);
    if (typeof process !== 'undefined') {
      // eslint-disable-next-line no-new
      new SharedArrayBuffer(1);
      return (_sabCapability = true);
    }
    if (globalThis.crossOriginIsolated !== true) return (_sabCapability = false);
    // eslint-disable-next-line no-new
    new SharedArrayBuffer(1);
    return (_sabCapability = true);
  } catch {
    return (_sabCapability = false);
  }
}

/**
 * @param {import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess} scheduler
 */
function poolCanShare(scheduler) {
  return scheduler instanceof PdfScheduler && scheduler.workers.length > 0 && canUseSharedArrayBuffer();
}

/**
 * The bytes to hand a scheduler's `loadPdfInAllWorkers`.
 * @param {ArrayBuffer | Uint8Array} pdfData
 * @param {boolean} usePdfSharedBuffer
 * @param {import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess} scheduler
 * @returns {Uint8Array}
 */
function pdfBytesForScheduler(pdfData, usePdfSharedBuffer, scheduler) {
  const bytes = pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
  if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) return bytes;
  if (usePdfSharedBuffer && poolCanShare(scheduler)) {
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
    shared.set(bytes);
    return shared;
  }
  return bytes;
}

/**
 * @typedef {Object} ImageProperties
 * @property {boolean} [rotated]
 * @property {boolean} [upscaled]
 * @property {('color'|'gray'|'binary')} [colorMode]
 * @property {number} n
 */

/**
 * @typedef {Object} ImagePropertiesRequest
 * @property {?boolean} [rotated]
 * @property {?boolean} [upscaled]
 * @property {?('color'|'gray'|'binary')} [colorMode]
 */

let renderSourceIdCounter = 0;

/** The renderer's decoded-image cache budget for a lease above one worker, the document the reader is moving around in. */
const ACTIVE_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;

/** The budget for a single-worker lease, which renders one screen at a time. */
const WARM_IMAGE_CACHE_BYTES = 16 * 1024 * 1024;

/** @type {Set<RenderSource>} Sources with a live scheduler, for the pool's room-making. */
const liveSources = new Set();

setRoomMaker(async (shortfall) => {
  let freed = 0;
  const idle = [...liveSources]
    .filter((src) => src.scheduler instanceof PdfScheduler && !src.pinned && !src.scheduler.busy && !(src.isExtracting && src.isExtracting()))
    .sort((a, b) => a.lastUse - b.lastUse);
  for (const src of idle) {
    if (freed >= shortfall) break;
    const n = src.scheduler instanceof PdfScheduler ? src.scheduler.workers.length : 0;
    if (n > 1) {
      await src.setWorkerTarget(1);
      freed += n - 1;
    } else {
      await src.suspend();
      freed += n;
    }
  }
});

/**
 * One render origin: a PDF's worker pool and its bytes.
 * Its `id` space is separate from `ScribeDoc.id`.
 * Sources are shared by reference and refcounted,
 * so a page copied between documents keeps rendering from its origin without reloading bytes or spawning workers.
 */
export class RenderSource {
  /** @type {number} Process-unique source id. */
  id;

  /** @type {'pdf'} Kind of origin. Image-input pages are self-contained (their blob rides in `nativeSrc`) and never use a source. */
  kind = 'pdf';

  /**
   * Original PDF bytes.
   * It can alias the worker pool's shared memory, so it must never be written to.
   * @type {?(ArrayBuffer | Uint8Array)}
   */
  pdfData = null;

  /**
   * Page count of `pdfData`.
   * Page deletions shrink the document's live page counts but never this.
   * @type {number}
   */
  sourcePageCount = 0;

  /** @type {?(import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess)} */
  scheduler = null;

  /** @type {?Promise<import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess>} */
  #schedulerReady = null;

  /** @type {boolean} */
  #reloadOnWake = false;

  /** @type {number} Live documents referencing this source; the pool is terminated only when this returns to 0. */
  refCount = 0;

  /** @type {?number} Fixed worker-pool size for this source. Null uses the global sizing. */
  workerN = null;

  /** @type {boolean} Set by a host for the source of the document on screen, which the pool's room-making leaves alone. */
  pinned = false;

  /** @type {number} When this source last took a job, for the pool's room-making. */
  lastUse = 0;

  /** @type {?() => boolean} Whether the owning document is still extracting text, which a shrink or a suspend would cut short. */
  isExtracting = null;

  /** @type {boolean} Whether a host has asked for this source to sleep once its running job settles. */
  sleepWhenIdle = false;

  /**
   * The source document's optimized substitute fonts, carried for overlay fidelity of pages copied out of it.
   * Placeholder in v1 (the basic editor is invisible-text-only), populated when font fidelity lands.
   * @type {?Object}
   */
  optFonts = null;

  /** @type {?Object} The source document's user-uploaded fonts, carried the same way. Placeholder in v1. */
  uploadedFonts = null;

  /** @param {number} id */
  constructor(id) { this.id = id; }

  /**
   * Get or lazily initialize this source's dedicated PDF worker pool (or the in-process equivalent when `opt.inProcess` is set).
   * @returns {Promise<import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess>}
   */
  getScheduler = async () => {
    this.lastUse = performance.now();
    if (this.scheduler) return this.scheduler;
    if (!this.#schedulerReady) {
      const spawn = initPdfScheduler(this.workerN ?? undefined).then(async (s) => {
        if (this.#reloadOnWake && this.pdfData) {
          await s.loadPdfInAllWorkers(pdfBytesForScheduler(this.pdfData, opt.usePdfSharedBuffer, s));
          this.#reloadOnWake = false;
        }
        this.scheduler = s;
        liveSources.add(this);
        return s;
      });
      // A failed spawn must not poison the source for the session, so the next call retries.
      spawn.catch(() => {
        if (this.#schedulerReady === spawn) this.#schedulerReady = null;
      });
      this.#schedulerReady = spawn;
    }
    return this.#schedulerReady;
  };

  /**
   * Release this source's worker pool while keeping the source reopenable.
   * The retained `pdfData` is reloaded into a fresh pool by the next `getScheduler` call.
   * No-op while the pool is already down.
   * Do not call with jobs in flight (e.g. deferred text extraction), because pool teardown kills them.
   */
  suspend = async () => {
    // A pool mid-spawn has no `scheduler` yet, so returning here would leak the finished pool unreachable.
    if (!this.scheduler && this.#schedulerReady) await this.#schedulerReady.catch(() => {});
    if (!this.scheduler) return;
    const s = this.scheduler;
    this.scheduler = null;
    this.#schedulerReady = null;
    this.#reloadOnWake = this.pdfData != null;
    liveSources.delete(this);
    await s.terminate();
  };

  terminate = async () => {
    if (!this.scheduler && this.#schedulerReady) await this.#schedulerReady.catch(() => {});
    liveSources.delete(this);
    if (this.scheduler) {
      await this.scheduler.terminate();
      this.scheduler = null;
      this.#schedulerReady = null;
    }
  };

  /**
   * Grow or shrink this source's lease to `n` workers in place. New workers load the document and join the live scheduler, and surplus ones leave after their running job.
   * A source with no pool yet records `n` as the size of its next spawn.
   * @param {number} n
   */
  setWorkerTarget = async (n) => {
    this.workerN = n;
    const s = await this.getScheduler();
    if (!(s instanceof PdfScheduler) || this.scheduler !== s) return;
    const have = s.workers.length;
    if (n > have) {
      const fresh = await acquireWorkers(n - have);
      // The source may have suspended or been asked for another size while the workers were coming.
      if (this.scheduler !== s || this.workerN !== n || !this.pdfData) {
        await releaseWorkers(fresh);
        return;
      }
      const bytes = pdfBytesForScheduler(this.pdfData, opt.usePdfSharedBuffer, s);
      await Promise.all(fresh.map((w) => w.loadPdfForParsing({ pdfBytes: bytes })));
      if (this.scheduler !== s || this.workerN !== n) {
        await releaseWorkers(fresh);
        return;
      }
      s.addWorkers(fresh);
    } else if (n < have) {
      retireWorkers(s.removeWorkers(have - n));
    }
    await s.setImageCacheBudget(n > 1 ? ACTIVE_IMAGE_CACHE_BYTES : WARM_IMAGE_CACHE_BYTES);
  };
}

/**
 * Per-document image cache and registry of `RenderSource`s.
 * Each page resolves its raster through `pageMetrics[n].sourceId`, so a page copied from another document renders from its origin.
 */
export class ImageStore {
  /**
   * Calibrated on a 464-document corpus: warm draw times cluster below ~120ms and only sparsely fill the 120-500ms band,
   * so a page above this threshold is a genuine outlier.
   */
  static EXPENSIVE_DRAW_MS = 450;

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  nativeSrc = [];

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  native = [];

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  binary = [];

  // These arrays store the properties of the images.
  // While they are redundant with the properties stored in the ImageWrapper objects,
  // they still need to exist to determine whether the image needs to be re-rendered.
  // The imagewrappers are stored as promises, and needing to await them would break things without further changes.
  // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#control_flow_effects_of_await
  /** @type {Array<ImageProperties>} */
  nativeProps = [];

  /** @type {Array<ImageProperties>} */
  binaryProps = [];

  /**
   * Small low-resolution JPEG page previews (one Blob promise per page), rendered on demand by `renderThumbnail`.
   * Fresh per document (a new doc gets a new `ImageStore`), so it never needs manual clearing.
   * @type {Array<Promise<?Blob> | undefined>}
   */
  thumbnails = [];

  /**
   * Keyed by the Blob rather than the page index because reordering pages permutes `thumbnails`, leaving an index-keyed URL pointing at another page's image.
   * @type {Map<Blob, string>}
   */
  thumbnailUrls = new Map();

  /**
   * Object URLs of thumbnails a page has replaced, per page index.
   * Revoked once the page's next thumbnail URL is handed out, or on `clear`.
   * @type {Array<Array<string> | undefined>}
   */
  retiredThumbnailUrls = [];

  /**
   * Estimated cost of re-rendering each display slot (ms), from its last render with one-time work excluded.
   * @type {Array<number|undefined>}
   */
  renderDrawMs = [];

  /**
   * Whether page `n` measured as expensive to render (see `EXPENSIVE_DRAW_MS`).
   * An unmeasured page reports `false`, taking the cheap-page policy until its first render supplies a measurement.
   * @param {number} n - Page number
   */
  isRenderExpensive = (n) => (this.renderDrawMs[n] ?? 0) > ImageStore.EXPENSIVE_DRAW_MS;

  /**
   * Record the render-cost measurement for slot `n` from a render result's `perf`, if present.
   * @param {number} n - Page number
   * @param {{prepMs: number, drawMs: number, decodeMs: number, flushMs: number}} [perf]
   */
  #recordRenderCost(n, perf) {
    if (!perf || typeof perf.drawMs !== 'number') return;
    this.renderDrawMs[n] = Math.max(0, perf.drawMs - perf.decodeMs);
  }

  /**
   * This document's render sources, keyed by source id: its own primary source plus any copied in from other documents.
   * Image-input pages are self-contained (their raster is in `nativeSrc`) and are not in this map.
   * @type {Map<number, RenderSource>}
   */
  sources = new Map();

  /** @type {?number} Id of this document's own source in `sources` (the one `openMainPDF` loads into). */
  primarySourceId = null;

  /**
   * The owning document.
   * @type {ScribeDoc}
   */
  #doc;

  /**
   * @param {ScribeDoc} doc - The owning document.
   */
  constructor(doc) {
    this.#doc = doc;
  }

  /** Owning document's page metrics array (held by reference, mutated in place by the doc). */
  get #pageMetrics() { return this.#doc.pageMetrics; }

  /**
   * @param {ImagePropertiesRequest} props
   * @param {ImageWrapper} inputImage
   * @param {number} n - Page number
   * @param {boolean} [binary=false]
   * @returns {ImageProperties}
   */
  fillPropsDefault = (props, inputImage, n, binary = false) => {
    /** @type {"binary" | "color" | "gray"} */
    let colorMode = 'binary';
    if (!binary) {
      const color = props?.colorMode === 'color' || !props?.colorMode && scribeDocDefaults.colorMode === 'color';
      colorMode = color ? 'color' : 'gray';
    }

    let pageAngle = this.#pageMetrics[n].angle || 0;
    if (Math.abs(pageAngle) < 0.05) pageAngle = 0;

    // If no preference is specified for rotation, default to true.
    const rotate = props?.rotated !== false && inputImage.rotated === false;
    const angleArg = rotate ? pageAngle * (Math.PI / 180) * -1 : 0;

    // If no preference is specified for upscaling, default to false.
    const upscaleArg = props?.upscaled || false;

    const isRotated = Boolean(angleArg) || inputImage.rotated;
    const isUpscaled = upscaleArg || inputImage.upscaled;

    return {
      rotated: isRotated, upscaled: isUpscaled, colorMode, n,
    };
  };

  /**
   * The records the viewer's renders of a display slot apply in place of the document's while a line is open in the editor.
   * They are the document's records with that line's operators deleted.
   * Renders for OCR and export keep the document's records.
   * @type {Map<number, Array<ContentEdit>>}
   */
  #ephemeralRecords = new Map();

  /**
   * Set the records the viewer's renders of display slot `n` apply while a line is open, or clear them with null.
   * The records apply from the page raster's next render.
   * @param {number} n - Page number
   * @param {?Array<ContentEdit>} records
   */
  setEphemeralRecords = (n, records) => {
    if (records) this.#ephemeralRecords.set(n, records);
    else this.#ephemeralRecords.delete(n);
  };

  /**
   * Content-edit payload for display slot `n`'s render jobs.
   * @param {number} n - Page number
   * @param {boolean} forViewer - Whether the render serves the on-screen viewer, which shows the open line's ephemeral records.
   * @returns {?RenderEdits}
   */
  #editsForPage = (n, forViewer) => {
    const records = (forViewer && this.#ephemeralRecords.get(n)) || this.#doc.contentEdits?.pages?.[n] || [];
    const dims = this.#pageMetrics[n]?.dims;
    if (records.length === 0 || !dims) return null;
    return { records, dims: { width: dims.width, height: dims.height } };
  };

  /**
   * The raster on its way to a viewer for each display slot.
   * A thumbnail asked for in the meantime is cut from it instead of rendering the page a second time.
   * @type {Map<number, ViewerRaster>}
   */
  #viewerRasters = new Map();

  /**
   * How many times each page's renders have been invalidated.
   * Keyed by page rather than slot, since a page edit moves pages between slots.
   * @type {WeakMap<PageMetrics, number>}
   */
  #invalidations = new WeakMap();

  /**
   * The number of this store's renders of each page that have landed.
   * @type {WeakMap<PageMetrics, number>}
   */
  #rendersLanded = new WeakMap();

  /**
   * The thumbnails cut from a raster this store did not render, each with the promise that tells its holders it has been replaced.
   * Such a thumbnail stands only until this store's own render of its page lands.
   * @type {WeakMap<Promise<?Blob>, {replaced: Promise<void>, announce: () => void}>}
   */
  #interimThumbs = new WeakMap();

  /** @type {?PageThumbCache} */
  #thumbCache = null;

  /**
   * Give the document a store of page thumbnails that outlives it.
   * The store must hold thumbnails of this document's own PDF alone, since a thumbnail is filed by its page's index in that file.
   * @param {?PageThumbCache} cache
   */
  setThumbCache = (cache) => {
    this.#thumbCache = cache;
  };

  /**
   * The source page under which display slot `n`'s thumbnail is filed in the host's thumbnail store, or -1 when it is not kept there.
   * @param {number} n - Page number
   * @param {?RenderEdits} edits
   * @returns {number}
   */
  #thumbCachePage = (n, edits) => {
    const pm = this.#pageMetrics[n];
    const sourcePageN = pm?.sourcePageN ?? n;
    const ownPage = (pm?.sourceId ?? this.primarySourceId) === this.primarySourceId && sourcePageN >= 0;
    const kept = this.#thumbCache && this.inputModes.pdf && this.pdfDims300[n] && ownPage && edits === null && !this.#ephemeralRecords.has(n);
    return kept ? sourcePageN : -1;
  };

  /**
   * Record that a raster of page `n` is on its way to a viewer.
   * @param {number} n - Page number
   * @param {?import('../../tess/TessScheduler.js').Lane} lane - The lane of the render it comes from, or null when no render stands behind it.
   * @param {number} [persistAs=-1] - The source page under which a thumbnail cut from the raster is stored in the host's thumbnail store.
   * @returns {ViewerRaster}
   */
  #expectRaster = (n, lane, persistAs = -1) => {
    const pm = this.#pageMetrics[n];
    /** @type {(thumbnail: ?Promise<?Blob>) => void} */
    let settle = () => {};
    /** @type {Promise<?Blob>} */
    const thumbnail = new Promise((resolve) => { settle = resolve; });
    const coming = {
      lane, pm, invalidations: this.#invalidations.get(pm) || 0, rendersLanded: this.#rendersLanded.get(pm) || 0, wanted: false, persistAs, thumbnail, settle,
    };
    this.#viewerRasters.set(n, coming);
    return coming;
  };

  /**
   * End the wait for a raster of page `n`, and cut the page's thumbnail from it when one is called for.
   * The caller may close `raster` once this returns.
   * @param {number} n - The slot the raster was asked for.
   * @param {ViewerRaster} coming
   * @param {?ImageBitmap} raster - Null when none came.
   * @param {boolean} rendered - Whether this store rendered it.
   */
  #rasterLanded = (n, coming, raster, rendered) => {
    if (this.#viewerRasters.get(n) === coming) this.#viewerRasters.delete(n);
    /** @type {?Promise<?Blob>} */
    let cut = null;
    try {
      if (rendered && raster && coming.pm) this.#rendersLanded.set(coming.pm, (this.#rendersLanded.get(coming.pm) || 0) + 1);
      // A page edit can have moved the page since the raster was asked for, and the page's thumbnail has moved with it.
      const slot = this.#pageMetrics.indexOf(coming.pm);
      const held = slot >= 0 ? this.thumbnails[slot] : null;
      const replaces = rendered && !!held && this.#interimThumbs.has(held);
      const called = coming.wanted || held === undefined || replaces;
      if (!raster || !called || (this.#invalidations.get(coming.pm) || 0) !== coming.invalidations) return;
      // A thumbnail cut from a raster from elsewhere stands only until a render of its page replaces it.
      // So none is cut for a page the document no longer holds, or once a render of the page has landed since the raster was asked for, because that render is the newer picture.
      if (!rendered && (slot < 0 || (this.#rendersLanded.get(coming.pm) || 0) !== coming.rendersLanded)) return;
      const storedAs = rendered ? -1 : this.#thumbCachePage(slot, this.#editsForPage(slot, false));
      if (storedAs >= 0 && this.#thumbCache?.has(storedAs)) return;
      // This runs before the cut checks so the interim thumbnail is dropped even when this render cannot be cut into its replacement.
      if (replaces) this.#retireThumbnail(slot);
      if (raster.width < THUMBNAIL_W || typeof OffscreenCanvas === 'undefined') return;
      const canvas = ca.makeCanvas(THUMBNAIL_W, Math.max(1, Math.round(THUMBNAIL_W * (raster.height / raster.width))));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(raster, 0, 0, canvas.width, canvas.height);
      const p = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 }).then((blob) => {
        ca.closeDrawable(canvas);
        return blob;
      }).catch(() => {
        ca.closeDrawable(canvas);
        return null;
      });
      // Whether the cut is stored was decided from what the render was asked to draw, since the page may have been edited while it ran.
      if (rendered && coming.persistAs >= 0) p.then((blob) => { if (blob) this.#thumbCache?.put(coming.persistAs, blob); });
      // The page's thumbnail is this cut, or else the request that has been waiting for it.
      const standing = held === undefined || replaces ? p : held;
      if (standing === p) {
        this.thumbnails[slot] = p;
        p.then((r) => {
          const at = r === null ? this.thumbnails.indexOf(p) : -1;
          if (at >= 0) this.thumbnails[at] = undefined;
        });
      }
      if (!rendered && standing) {
        let announce = () => {};
        /** @type {Promise<void>} */
        const replaced = new Promise((resolve) => { announce = resolve; });
        this.#interimThumbs.set(standing, { replaced, announce });
      }
      cut = p;
    } finally {
      coming.settle(cut);
    }
  };

  /**
   * Announce that a raster of page `n` is on its way to a viewer.
   * A thumbnail asked for in the meantime is cut from that raster instead of rendering the page again.
   * `renderViewerRaster` does this for its own renders.
   * A viewer calls it for a raster it has from elsewhere, and for a render it will ask for only when the page's turn comes.
   * @param {number} n - Page number
   * @param {?import('../../tess/TessScheduler.js').Lane} [lane=null] - The lane of the render the raster will come from, which a thumbnail asked for in a lane served ahead of it does not wait for.
   *   Null for a raster no render stands behind, which every thumbnail waits for.
   * @returns {(raster?: ?ImageBitmap) => void} Ends the wait.
   *   The viewer calls it once the raster has landed, the page's render has been asked for, or neither will happen.
   *   A raster passed to it must be at the page's own orientation, and supplies the thumbnail only when it is at least thumbnail width.
   */
  expectViewerRaster = (n, lane = null) => {
    const coming = this.#expectRaster(n, lane);
    return (raster = null) => this.#rasterLanded(n, coming, raster, false);
  };

  /** @type {Map<string, Promise<?{ program: ?import('../pdf/glyphResolve.js').EditFontProgram, faceName: ?string, bytes: ?ArrayBuffer }>>} */
  #editFontCache = new Map();

  /** @type {Map<string, { program: ?import('../pdf/glyphResolve.js').EditFontProgram, faceName: ?string, bytes: ?ArrayBuffer }>} */
  #editFontResolved = new Map();

  /**
   * Fetch the font program for `fontObjNum` from display slot `n`'s source document.
   * In a browser the program is also registered as a FontFace under the returned `faceName`, so the line editor can draw with the exact outlines the raster uses.
   * @param {number} n - Page number
   * @param {number} fontObjNum
   */
  getEditFont = (n, fontObjNum) => {
    const pm = this.#pageMetrics[n];
    const key = `${pm?.sourceId ?? 'p'}_${fontObjNum}`;
    let entry = this.#editFontCache.get(key);
    if (!entry) {
      entry = (async () => {
        const scheduler = await this.resolveSource(pm).getScheduler();
        // The source page index lets a pool worker that never parsed that page resolve the font.
        const payload = await scheduler.getPdfFontBytes({ fontObjNum, pageIndex: pm?.sourcePageN ?? n });
        // A null payload is a failed lookup, not a font without a program.
        // Caching it would lock the editor to a substitute face for the session.
        if (!payload) this.#editFontCache.delete(key);
        const { parseEditFontPayload } = await import('../pdf/glyphResolve.js');
        const program = parseEditFontPayload(payload);
        let faceName = null;
        if (program?.font && payload?.bytes && typeof FontFace !== 'undefined') {
          faceName = `_edit_d${this.#doc.id}_${key}`;
          const { loadFontFace } = await import('./fontContainer.js');
          const face = loadFontFace(faceName, 'normal', 'normal', payload.bytes);
          await face.loaded;
        }
        const result = { program, faceName, bytes: payload?.bytes ?? null };
        // Unlike the promise cache above, this keeps failures too, so a render-time consumer never re-fires a lookup that already answered.
        this.#editFontResolved.set(key, result);
        return result;
      })();
      this.#editFontCache.set(key, entry);
      entry.catch(() => this.#editFontCache.delete(key));
    }
    return entry;
  };

  /**
   * The resolution display slot `n`'s words were parsed at, or 0 when the slot is not backed by a PDF.
   * @param {number} n - Page number
   */
  #parseDpi = (n) => {
    const width300 = this.pdfDims300[n]?.width;
    return width300 > 0 ? 300 * Math.min(width300, 3500) / width300 : 0;
  };

  /**
   * The glyphs of the given words as display slot `n`'s source page draws them.
   * @param {number} n - Page number
   * @param {Array<TextEditWordSpec>} words
   * @returns {Promise<?LineState>} Null when the page is not backed by a PDF.
   */
  getLineState = async (n, words) => {
    const dpi = this.#parseDpi(n);
    if (!dpi) return null;
    const pm = this.#pageMetrics[n];
    const scheduler = await this.resolveSource(pm).getScheduler();
    return scheduler.getPdfLineState({
      pageIndex: pm?.sourcePageN ?? n, dpi, records: this.#doc.contentEdits?.pages?.[n] || [], words,
    });
  };

  /**
   * The glyphs of a line of display slot `n` as a replacement would draw them, for the editor's preview.
   * @param {number} n - Page number
   * @param {import('../pdf/textPatch.js').TextEditRequest} req
   * @returns {Promise<TextEditPreview>}
   */
  previewTextEdit = async (n, req) => {
    const dpi = this.#parseDpi(n);
    if (!dpi) return { refused: 'The page is not backed by a PDF.' };
    const pm = this.#pageMetrics[n];
    const scheduler = await this.resolveSource(pm).getScheduler();
    return scheduler.previewPdfTextEdit({
      pageIndex: pm?.sourcePageN ?? n, dpi, records: this.#doc.contentEdits?.pages?.[n] || [], req,
    });
  };

  /**
   * Ask the worker to turn an edit of display slot `n`'s words into patch records.
   * The records are verified against a re-parse of the patched page.
   * @param {number} n - Page number
   * @param {import('../pdf/textPatch.js').TextEditRequest} req
   * @param {string} [groupId]
   * @returns {Promise<TextEditResult>}
   */
  applyTextEdit = async (n, req, groupId) => {
    const dpi = this.#parseDpi(n);
    if (!dpi) return { refused: 'The page is not backed by a PDF.' };
    const pm = this.#pageMetrics[n];
    const scheduler = await this.resolveSource(pm).getScheduler();
    return scheduler.applyPdfTextEdit({
      pageIndex: pm?.sourcePageN ?? n, dpi, records: this.#doc.contentEdits?.pages?.[n] || [], req, groupId,
    });
  };

  /**
   * The settled `getEditFont` result for `fontObjNum` on display slot `n`, or `undefined` when no lookup has settled.
   * A settled entry with a null `faceName` means no usable face, so fall back rather than retry.
   * @param {number} n - Page number
   * @param {number} fontObjNum
   */
  getEditFontSync = (n, fontObjNum) => this.#editFontResolved.get(`${this.#pageMetrics[n]?.sourceId ?? 'p'}_${fontObjNum}`);

  /** @type {Map<string, Promise<Type3GlyphHashes>>} */
  #type3HashCache = new Map();

  /** @type {Map<string, Type3GlyphHashes>} */
  #type3HashResolved = new Map();

  /**
   * The outline hash of every Type 3 glyph in display slot `n`'s source document, keyed by font object number and character code.
   * Requested once per source and kept for the document's life.
   * @param {number} n - Page number
   * @returns {Promise<Type3GlyphHashes>}
   */
  getType3GlyphHashes = (n) => {
    const pm = this.#pageMetrics[n];
    const key = pm?.sourceId ?? 'p';
    let entry = this.#type3HashCache.get(key);
    if (!entry) {
      entry = (async () => {
        const scheduler = await this.resolveSource(pm).getScheduler();
        const res = await scheduler.getPdfType3GlyphHashes({});
        /** @type {Type3GlyphHashes} */
        const table = { fonts: new Map(), byHash: new Map() };
        for (const f of res.fonts) {
          const byCode = new Map();
          for (let i = 0; i < f.codes.length; i++) {
            byCode.set(f.codes[i], { hash: f.hashes[i], blank: f.blank[i] });
            if (!f.hashes[i]) continue;
            if (!table.byHash.has(f.hashes[i])) table.byHash.set(f.hashes[i], []);
            table.byHash.get(f.hashes[i]).push([f.objNum, f.codes[i]]);
          }
          table.fonts.set(f.objNum, { byCode });
        }
        this.#type3HashResolved.set(key, table);
        return table;
      })();
      this.#type3HashCache.set(key, entry);
      entry.catch(() => this.#type3HashCache.delete(key));
    }
    return entry;
  };

  /**
   * The settled `getType3GlyphHashes` answer for display slot `n`'s source, or `undefined` when no request has settled.
   * @param {number} n - Page number
   */
  getType3GlyphHashesSync = (n) => this.#type3HashResolved.get(this.#pageMetrics[n]?.sourceId ?? 'p');

  /**
   * Drop every cached raster of display slot `n`.
   * The viewer separately drops its own display-width raster and canvas for the page.
   * @param {number} n - Page number
   */
  invalidatePageRender = (n) => {
    this.native[n] = undefined;
    this.binary[n] = undefined;
    this.nativeProps[n] = undefined;
    this.binaryProps[n] = undefined;
    const pm = this.#pageMetrics[n];
    if (pm) this.#invalidations.set(pm, (this.#invalidations.get(pm) || 0) + 1);
    this.#viewerRasters.delete(n);
    this.#retireThumbnail(n);
  };

  /**
   * How many times page `n`'s renders have been invalidated.
   * @param {number} n - Page number
   * @returns {number}
   */
  renderInvalidations = (n) => this.#invalidations.get(this.#pageMetrics[n]) || 0;

  /**
   * Drop display slot `n`'s thumbnail.
   * A thumbnail rail keeps showing the old picture until the next one is in, so its URL is retired instead of revoked.
   * @param {number} n - Page number
   */
  #retireThumbnail = (n) => {
    const oldThumb = this.thumbnails[n];
    this.thumbnails[n] = undefined;
    if (!oldThumb) return;
    this.#interimThumbs.get(oldThumb)?.announce();
    Promise.resolve(oldThumb).then((blob) => {
      if (!blob) return;
      const url = this.thumbnailUrls.get(blob);
      if (url) {
        this.thumbnailUrls.delete(blob);
        (this.retiredThumbnailUrls[n] ||= []).push(url);
      }
    }).catch(() => {});
  };

  /** This document's own (primary) render source, or `null` before one is created. @returns {?RenderSource} */
  get #primarySource() {
    return this.primarySourceId != null ? this.sources.get(this.primarySourceId) ?? null : null;
  }

  /** Get (creating if needed) this document's own render source. @returns {RenderSource} */
  #ensurePrimarySource = () => {
    let src = this.#primarySource;
    if (!src) {
      src = new RenderSource(++renderSourceIdCounter);
      src.refCount = 1;
      src.isExtracting = () => this.#doc._extracting;
      this.sources.set(src.id, src);
      this.primarySourceId = src.id;
    }
    return src;
  };

  /**
   * Resolve the render source for a page.
   * `sourceId` is `null` for this document's own pages (the primary source) and a concrete id for pages copied in from another document.
   * @param {import('../objects/pageMetricsObjects.js').PageMetrics} [pm]
   * @returns {RenderSource}
   */
  resolveSource = (pm) => {
    const id = pm?.sourceId ?? this.primarySourceId;
    return (id != null && this.sources.get(id)) || this.#ensurePrimarySource();
  };

  /**
   * Loaded PDF bytes for this document's own source.
   * @type {?ArrayBuffer}
   */
  get pdfData() { return this.#primarySource?.pdfData ?? null; }

  set pdfData(v) { this.#ensurePrimarySource().pdfData = v; }

  /**
   * The primary source's worker pool once initialized (else `null`). Accessor over the primary `RenderSource`.
   * @type {?(import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess)}
   */
  get pdfScheduler() { return this.#primarySource?.scheduler ?? null; }

  /**
   * Get or lazily initialize this document's own PDF worker pool (or the in-process equivalent when `opt.inProcess` is set).
   * Delegates to the primary `RenderSource`.
   * @returns {Promise<import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess>}
   */
  getPdfScheduler = async () => this.#ensurePrimarySource().getScheduler();

  /** @type {Map<object, Set<number>>} The pages each viewer of this document still wants rendered, for the focus move's keep set. */
  #keepByViewer = new Map();

  /**
   * Set the page the viewer is on and the pages it still wants, so this document's staged display renders rank by distance to the page and the rest are dropped.
   * Several viewers can show one document, so the dropped set is what no viewer wants.
   * @param {?number} n - Page number
   * @param {?Set<number>} [keep] - The pages the viewer still wants; null leaves the staged renders alone.
   * @param {object} [viewer] - The viewer asking, which owns its own keep set.
   */
  setViewerFocus = (n, keep = null, viewer = this) => {
    let union = null;
    if (keep) {
      this.#keepByViewer.set(viewer, keep);
      union = new Set();
      for (const pages of this.#keepByViewer.values()) for (const p of pages) union.add(p);
    }
    this.#primarySource?.scheduler?.setViewerFocus(n, union);
  };

  /**
   * Set the page at the center of the thumbnail rail, so this document's staged preview renders rank by distance to it.
   * @param {?number} n - Page number
   */
  setThumbFocus = (n) => {
    this.#primarySource?.scheduler?.setThumbFocus(n);
  };

  /**
   * Grow or shrink this document's own lease to `n` workers in place.
   * @param {number} n
   */
  setWorkerTarget = (n) => this.#ensurePrimarySource().setWorkerTarget(n);

  /**
   * Mark this document's own source as the one on screen, which the pool's room-making leaves alone.
   * @param {boolean} pinned
   */
  setPinned = (pinned) => {
    this.#ensurePrimarySource().pinned = pinned;
  };

  loadCount = 0;

  pageCount = 0;

  /**
   * The dimensions that each page would be, if it was rendered at 300 DPI.
   * @type {Array<dims>}
   */
  pdfDims300 = [];

  inputModes = {
    pdf: false,
    image: false,
  };

  colorModeDefault = 'gray';

  /**
   * Render page `n` from its source and return it as an `ImageWrapper`.
   * @param {number} n - Page number
   * @param {boolean} [color=false]
   * @param {boolean} [forViewer=false]
   * @param {boolean} [wantBitmap=false] - Take the render as a transferable ImageBitmap (viewer display path) rather than a PNG data URL.
   *   Ignored outside a browser.
   * @returns {Promise<ImageWrapper | typeof SKIPPED>}
   */
  #renderImage = async (n, color = false, forViewer = false, wantBitmap = false) => {
    if (this.inputModes.image) {
      return this.nativeSrc[n];
    } if (this.inputModes.pdf) {
      const colorMode = color ? 'color' : 'gray';
      const pm = this.#pageMetrics[n];
      // Display slot `n` may hold a page copied from another document. Render it from its own source, not this doc's.
      const pdfScheduler = await this.resolveSource(pm).getScheduler();
      const targetWidth = pm.dims.width;
      const dpi = 300 * (targetWidth / this.pdfDims300[n].width);
      // Display slot `n` may have been reordered. Raster its source page, not its position.
      const sourcePageN = pm.sourcePageN ?? n;
      // The viewer's display path takes the rendered pixels as a transferable ImageBitmap, skipping the PNG encode/decode round-trip.
      // Bitmap output needs OffscreenCanvas, so it is browser-only and Node always renders to PNG.
      const outputFormat = wantBitmap && typeof OffscreenCanvas !== 'undefined' ? 'bitmap' : 'png';
      const result = await pdfScheduler.renderPdfPage({
        pageIndex: sourcePageN, colorMode, dpi, outputFormat, edits: this.#editsForPage(n, forViewer),
      }, forViewer);
      // The render was dropped from the queue (e.g. evicted to keep the viewer lane bounded).
      if (result === SKIPPED) return SKIPPED;
      this.#recordRenderCost(n, result.perf);
      // A failed render always returns a `dataUrl`, even when a bitmap was requested.
      if (result.bitmap) return ImageWrapper.fromBitmap(n, result.bitmap, result.colorMode);
      return new ImageWrapper(n, result.dataUrl, result.colorMode);
    }
    throw new Error('Attempted to render image without image input provided.');
  };

  /**
   * Render page `n` for viewer display at exactly `targetWidth` pixels wide.
   * The result is not cached in `native[n]`, so `getNative` consumers (OCR, export, coordinates) still get the full-resolution render.
   * @param {number} n - Page number
   * @param {number} targetWidth - Raster width in pixels; `pageMetrics[n].dims.width` renders the same pixels `getNative` would.
   * @param {import('../../tess/TessScheduler.js').Lane|boolean} [lane='display'] - The lane the render is served in; `true` is display and `false` background.
   *   A display render, or a prefetch render of a page beyond the screen, serves the viewer's canvas and may be dropped to `SKIPPED` when the viewer moves on; a background render always completes.
   * @returns {Promise<ImageWrapper | typeof SKIPPED>}
   */
  renderViewerRaster = async (n, targetWidth, lane = 'display') => {
    if (!this.inputModes.pdf) throw new Error('renderViewerRaster requires PDF input.');
    const viewerLane = laneOf(lane);
    const forViewer = viewerLane === 'display' || viewerLane === 'prefetch';
    const edits = this.#editsForPage(n, forViewer);
    const color = scribeDocDefaults.colorMode === 'color';
    const pm = this.#pageMetrics[n];
    // Recorded before the first await, so the rail's request for the same page, staged in the same task, finds the render coming.
    // A render that hides the line open in the editor does not picture the page as the document has it, so no thumbnail is cut from it.
    // The host's thumbnail store holds color pictures, so a cut from a gray render is not stored there.
    const coming = forViewer && !this.#ephemeralRecords.has(n) ? this.#expectRaster(n, viewerLane, color ? this.#thumbCachePage(n, edits) : -1) : null;
    /** @type {Awaited<ReturnType<PdfScheduler['renderPdfPage']>>} */
    let result;
    /** @type {?ImageBitmap} */
    let bitmap = null;
    try {
      // Display slot `n` may hold a page copied from another document. Render it from its own source, not this doc's.
      const pdfScheduler = await this.resolveSource(pm).getScheduler();
      // Display slot `n` may have been reordered. Raster its source page, not its position.
      const sourcePageN = pm.sourcePageN ?? n;
      result = await pdfScheduler.renderPdfPage({
        pageIndex: sourcePageN, colorMode: color ? 'color' : 'gray', targetWidth, outputFormat: 'bitmap', edits,
      }, lane);
      if (result !== SKIPPED && result.bitmap) bitmap = result.bitmap;
    } finally {
      if (coming) this.#rasterLanded(n, coming, bitmap, true);
    }
    if (result === SKIPPED) return SKIPPED;
    this.#recordRenderCost(n, result.perf);
    if (result.bitmap) return ImageWrapper.fromBitmap(n, result.bitmap, result.colorMode);
    // Failure placeholder (`ok: false`): a blank PNG so the page is still present.
    return new ImageWrapper(n, result.dataUrl, result.colorMode);
  };

  /**
   * Free the decoded bitmap(s) for page `n` to bound viewer memory (called for pages outside the viewer's retention window).
   * @param {number} n - Page number
   */
  releaseBitmapCache = (n) => {
    this.#releaseBitmap(this.native, n);
    this.#releaseBitmap(this.binary, n);
  };

  /**
   * Free the decoded bitmap for page `n` in one image store.
   * @param {Array<?Promise<ImageWrapper|typeof SKIPPED>|?ImageWrapper>} store
   * @param {number} n - Page number
   */
  // eslint-disable-next-line class-methods-use-this
  #releaseBitmap(store, n) {
    const entry = store[n];
    if (!entry) return;
    Promise.resolve(entry).then((img) => {
      if (!img || img === SKIPPED) return;
      // A src==null wrapper has no `src` to re-decode from, so freeing its bitmap would lose the image; the viewer's eviction-compression owns it.
      if (img.src == null) return;
      // String-backed wrapper: free only the decoded bitmap so the page can re-decode from `src` on revisit.
      if (img.imageBitmap) img.imageBitmap = null;
    }).catch(() => {});
  }

  /**
   * @param {ImageWrapper} inputImage
   * @param {number} n - Page number
   * @param {ImagePropertiesRequest} [props] - Image properties needed.
   *  Image properties should only be defined if needed, as they can require the image to be re-rendered.
   * @param {boolean} [saveNativeImage=true] - Whether the native image should be saved.
   */
  transformImage = async (inputImage, n, props, saveNativeImage = true) => {
    let pageAngle = this.#pageMetrics[n].angle || 0;
    if (Math.abs(pageAngle) < 0.05) pageAngle = 0;

    // If no preference is specified for rotation, default to true.
    const rotate = props?.rotated !== false && inputImage.rotated === false;
    const angleArg = rotate ? pageAngle * (Math.PI / 180) * -1 : 0;

    // If no preference is specified for upscaling, default to false.
    const upscaleArg = props?.upscaled || false;

    await gs.getGeneralScheduler();

    // Materialize `src` in case the input is a viewer-rendered bitmap-backed wrapper (no-op otherwise).
    const inputSrc = inputImage.ensureSrc();

    const resPromise = (async () => {
      // Wait for non-rotated version before replacing with promise
      await gs.initTesseract({ anyOk: true });
      return gs.recognize({
        image: inputSrc,
        options: { rotateRadians: angleArg, upscale: upscaleArg },
        output: {
          imageBinary: true, imageColor: saveNativeImage, debug: true, text: false, hocr: false, tsv: false, blocks: false,
        },
      });
    })();

    const isRotated = Boolean(angleArg) || inputImage.rotated;

    /** @type {?Promise<ImageWrapper>} */
    let native = null;
    if (saveNativeImage) {
      native = resPromise.then(async (res) => new ImageWrapper(n, /** @type {string} */(/** @type {unknown} */(res.imageColor)), inputImage.colorMode, isRotated, upscaleArg));
    }

    const binary = resPromise.then(async (res) => new ImageWrapper(n, /** @type {string} */(/** @type {unknown} */(res.imageBinary)), 'binary', isRotated, upscaleArg));

    return { native, binary };
  };

  /**
   * @param {number} n - Page number
   * @param {ImagePropertiesRequest} [props] - Image properties needed.
   *  Image properties should only be defined if needed, as they can require the image to be re-rendered.
   * @param {boolean} [nativeOnly=true]
   * @param {boolean} [forViewer=false] - Whether this render serves the on-screen viewer.
   *    Viewer renders are served ahead of background work, newest-first, and may be dropped (resolving to SKIPPED) when superseded.
   */
  getImages = (n, props, nativeOnly = true, forViewer = false) => {
    if (!this.inputModes.image && !this.inputModes.pdf) {
      return { native: undefined, binary: undefined };
    }

    const significantRotation = Math.abs(this.#pageMetrics[n].angle || 0) > 0.05;

    const nativeMissing = !this.native[n] || !imageUtils.compatible(this.nativeProps[n], props, significantRotation);
    const newBinary = !nativeOnly && (!this.binary[n] || !imageUtils.compatible(this.binaryProps[n], props, significantRotation));
    // Recognition releases each page's native raster as it finishes, so a binary read served from cache must not re-render it as a side effect.
    // A native render is left to native consumers, or to a fresh binary that needs one as its derivation input.
    const newNative = nativeMissing && (nativeOnly || newBinary);

    if (newNative || newBinary) {
      const renderRaw = !this.native[n] || imageUtils.requiresUndo(this.nativeProps[n], props);
      const propsRaw = {
        colorMode: scribeDocDefaults.colorMode, rotated: false, upscaled: false, n,
      };
      const renderTransform = newBinary || !imageUtils.compatible(propsRaw, props, significantRotation);

      const propsNew = renderRaw ? propsRaw : JSON.parse(JSON.stringify(this.nativeProps[n]));
      propsNew.colorMode = props?.colorMode || propsNew.colorMode;
      propsNew.rotated = props?.rotated ?? propsNew.rotated;
      propsNew.upscaled = props?.upscaled ?? propsNew.upscaled;
      const propsNewBinary = JSON.parse(JSON.stringify(propsNew));
      propsNewBinary.colorMode = 'binary';

      const inputNative = this.native[n];
      if (newNative) this.nativeProps[n] = propsNew;
      if (newBinary) this.binaryProps[n] = propsNewBinary;
      const res = (async () => {
        /** @type {?ImageWrapper} */
        let img1;
        if (renderRaw) {
          const color = props?.colorMode === 'color' || !props?.colorMode && scribeDocDefaults.colorMode === 'color';
          // Take the fast ImageBitmap path only when this render feeds the viewer directly with no follow-on transform.
          img1 = await this.#renderImage(n, color, forViewer, forViewer && !renderTransform);
        } else {
          img1 = await inputNative;
        }
        // Render dropped from the queue: propagate the sentinel so callers leave a placeholder.
        // The cache slot is cleared below so a later request for this page re-renders.
        if (img1 === SKIPPED) return { native: SKIPPED, binary: SKIPPED };
        if (renderTransform) {
          return this.transformImage(img1, n, props, true);
        }
        return { native: img1, binary: null };
      })();

      if (newNative) {
        const nativeP = res.then((r) => r.native);
        this.native[n] = nativeP;
        nativeP.then((img) => {
          if (img === SKIPPED && this.native[n] === nativeP) {
            this.native[n] = undefined;
            this.nativeProps[n] = undefined;
          }
        }).catch(() => {});
      }
      if (newBinary) {
        const binaryP = res.then((r) => r.binary);
        this.binary[n] = binaryP;
        binaryP.then((img) => {
          if (img === SKIPPED && this.binary[n] === binaryP) {
            this.binary[n] = undefined;
            this.binaryProps[n] = undefined;
          }
        }).catch(() => {});
      }
    }

    return { native: this.native[n], binary: this.binary[n] };
  };

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [forViewer=false] - Whether this render serves the on-screen viewer.
   *    Viewer renders are served ahead of background work, newest-first, and may be dropped (resolving to SKIPPED) when superseded.
   */
  getNative = async (n, props, forViewer) => {
    // Viewer callers want SKIPPED so they can leave a placeholder; pass it through.
    if (forViewer) return this.getImages(n, props, true, true).native;
    // Background (non-viewer) callers (OCR, export, coordinates, ...) cannot handle SKIPPED.
    // A reused, then dropped, viewer render clears its own cache slot before we observe SKIPPED,
    // so re-requesting renders fresh on the undroppable FIFO.
    for (let i = 0; i < MAX_SKIPPED_RETRY; i++) {
      const native = await this.getImages(n, props, true, false).native;
      if (native !== SKIPPED) return native;
    }
    throw new Error(`getNative: render for page ${n} repeatedly dropped (SKIPPED).`);
  };

  /**
   * Render (or return from cache) a small low-resolution preview of page `n`.
   *
   * For PDF input the page is drawn directly at thumbnail resolution and encoded in one pass by the renderer,
   * so it never populates the full-resolution `native[]` cache and the few-KB Blob stays cheap to keep resident across a large document.
   * The render uses the background lane (`forViewer = false`) so it can never delay an on-screen viewer render.
   * For image input the full-resolution page image is already in memory, so it is drawn onto a small canvas and encoded the same way.
   * @param {number} n - Page index.
   * @param {number} [widthPx=150] - Target preview width in CSS px.
   * @param {number} [quality=0.6] - JPEG/WebP quality (0-1). WebP quality 1.0 encodes losslessly in Chromium.
   * @param {boolean} [fresh=false] - Render at exactly `widthPx`, bypassing the thumbnail cache: no cached Blob is returned (first-requested width otherwise wins) and the result is not cached.
   * @param {'jpeg'|'webp'} [format='jpeg'] - Output encoding. The cache is format-blind, so a non-default format should pass `fresh`.
   *   JPEG stays the default because Safari cannot encode WebP (an unsupported type falls back to PNG).
   * @param {import('../../tess/TessScheduler.js').Lane} [lane] - The lane the render is served in: preview for a cached thumbnail, store for a fresh one.
   *   A preview render may be dropped, which resolves null, and the cleared slot is rendered again on the next ask.
   * @returns {Promise<?Blob>} An encoded image Blob, or `null` if the page cannot be rendered.
   */
  renderThumbnail = (n, widthPx = 150, quality = 0.6, fresh = false, format = 'jpeg', lane = fresh ? 'store' : 'preview') => {
    const held = fresh ? undefined : this.thumbnails[n];
    if (held && !this.#interimThumbs.has(held)) return held;
    // The host's thumbnail store keeps the one thumbnail every display surface asks for, so a request with other parameters neither reads nor fills it.
    const storable = !fresh && widthPx === THUMBNAIL_W && format === 'jpeg' && quality === 0.6;
    const storedAs = storable ? this.#thumbCachePage(n, this.#editsForPage(n, false)) : -1;
    const storedIn = storedAs >= 0 && this.#thumbCache?.has(storedAs) ? this.#thumbCache : null;
    if (held) {
      if (!storedIn) return held;
      this.#retireThumbnail(n);
    }
    if (!this.inputModes.image && !this.inputModes.pdf) return Promise.resolve(null);

    // A page edit made while the request waits moves the page to another slot, and the request with it, so the page's slot is found again after each wait.
    const pm = this.#pageMetrics[n];
    const p = (async () => {
      let slot = n;
      if (storedIn) {
        const stored = await storedIn.get(storedAs);
        if (stored) return stored;
        if (pm) slot = this.#pageMetrics.indexOf(pm);
      }
      if (!fresh) {
        // A raster of the page on its way to a viewer supplies the thumbnail.
        // One in a lane served after this request's is not waited for, so a rail row on screen never waits for a page beyond the screen.
        // A raster that lands without supplying it can have started the page's render, so the loop checks that one too.
        for (let coming = this.#viewerRasters.get(slot);
          coming && coming.pm === pm && (coming.lane === null || LANE_RANK[coming.lane] <= LANE_RANK[lane]);
          coming = this.#viewerRasters.get(slot)) {
          coming.wanted = true;
          const cut = await coming.thumbnail;
          if (cut) return cut;
          if (pm) slot = this.#pageMetrics.indexOf(pm);
        }
      }
      if (this.inputModes.pdf) {
        if (!this.pdfDims300[slot]) return null;
        // The page may have been copied from another document, so it is rendered from its own source, not this doc's.
        const pdfScheduler = await this.resolveSource(pm).getScheduler();
        // The page's size and edits are read after the last wait, from the slot the page then holds.
        if (pm) slot = this.#pageMetrics.indexOf(pm);
        const dims300 = this.pdfDims300[slot];
        if (!dims300) return null;
        const dpi = 300 * (widthPx / dims300.width);
        // The page may have been reordered, so its source page is rastered, not its position.
        const sourcePageN = pm?.sourcePageN ?? slot;
        const edits = this.#editsForPage(slot, false);
        // Whether the render is stored is decided here, from what it is asked to draw, since the page may be edited while it runs.
        const persistAs = storable ? this.#thumbCachePage(slot, edits) : -1;
        const result = await pdfScheduler.renderPdfPage({
          pageIndex: sourcePageN, colorMode: 'color', dpi, outputFormat: format, quality, edits,
        }, lane);
        const blob = result && result !== SKIPPED ? result.blob ?? null : null;
        if (blob && persistAs >= 0) this.#thumbCache?.put(persistAs, blob);
        return blob;
      }
      if (slot < 0) return null;
      const native = await this.getNative(slot);
      if (!native) return null;
      const bitmap = await ca.getImageBitmap(native.src);
      const canvas = ca.makeCanvas(widthPx, Math.max(1, Math.round(widthPx * (bitmap.height / bitmap.width))));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      ca.closeDrawable(bitmap);
      // `type` for browsers, `mime` for the Node canvas fork: both are needed to get the requested (not PNG) encoding.
      const mime = `image/${format}`;
      const blob = await canvas.convertToBlob({ type: mime, mime, quality });
      ca.closeDrawable(canvas);
      return blob;
    })();

    // Whole-document render passes come through here, so caching fresh renders would hold an entire book of Blobs until close.
    if (!fresh) {
      this.thumbnails[n] = p;
      // Clear the cache slot if the render failed, so a later call can retry.
      // The request is found where it stands, since a page edit can have moved it with its page.
      p.then((r) => r === null, () => true).then((failed) => {
        const at = failed ? this.thumbnails.indexOf(p) : -1;
        if (at >= 0) this.thumbnails[at] = undefined;
      });
    }
    return p;
  };

  /**
   * A single object URL for page `n`'s thumbnail, created once and reused by every display surface.
   * The URL is always of the thumbnail the page has when this resolves.
   * @param {number} n
   * @param {import('../../tess/TessScheduler.js').Lane} [lane='preview'] - preview for a row on screen, prefetch for one mounted beyond it.
   * @param {?() => void} [onReplaced=null] - Called once when the thumbnail handed out has been replaced or dropped, if it was cut from a raster this store did not render.
   *   The caller then asks again. It is never called before the URL is handed out.
   * @returns {Promise<?string>} The URL, or null if the page cannot be rendered.
   */
  thumbnailUrl = async (n, lane = 'preview', onReplaced = null) => {
    const pm = this.#pageMetrics[n];
    const requested = this.renderThumbnail(n, THUMBNAIL_W, 0.6, false, 'jpeg', lane);
    const blob = await requested;
    if (!blob) return null;
    const slot = pm ? this.#pageMetrics.indexOf(pm) : -1;
    if (slot >= 0 && this.thumbnails[slot] !== requested) return this.thumbnailUrl(slot, lane, onReplaced);
    if (onReplaced) this.#interimThumbs.get(requested)?.replaced.then(onReplaced);
    // Two `<img>` elements pointing at one URL share a single decode.
    let url = this.thumbnailUrls.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      this.thumbnailUrls.set(blob, url);
    }
    // Revoked a task later, once the caller has swapped its image over to the fresh URL.
    const retired = this.retiredThumbnailUrls[n];
    if (retired && retired.length > 0) {
      this.retiredThumbnailUrls[n] = undefined;
      setTimeout(() => { for (const old of retired) URL.revokeObjectURL(old); }, 0);
    }
    return url;
  };

  /**
   * Render a PDF-backed page to a standalone image at a chosen resolution and encoding.
   *
   * The render does not populate the full-resolution `native[]` cache.
   * It runs on the background lane, so it never delays an on-screen viewer render.
   * @param {number} n - Page index.
   * @param {Object} [options]
   * @param {number} [options.dpi=300] - Render resolution in dots per inch (72 renders at the PDF's point size).
   * @param {'png'|'jpeg'|'webp'|'bitmap'} [options.format='png'] - Output encoding.
   * @param {number} [options.quality=0.6] - JPEG/WebP quality (0-1); ignored for 'png' and 'bitmap'.
   * @param {'color'|'gray'} [options.colorMode='color'] - Output color mode.
   * @returns {Promise<{dataUrl?: string, blob?: Blob, bitmap?: ImageBitmap, colorMode: string, ok: boolean, failReason?: string, failDetail?: string}>}
   *   The image in `dataUrl` ('png'), `blob` ('jpeg'/'webp'), or `bitmap` ('bitmap').
   *   `colorMode` is the mode actually used, which downgrades to 'gray' on a page with no color.
   *   On failure `ok` is false and the image is a blank PNG `dataUrl`, whatever format was requested.
   */
  renderPageImage = async (n, options = {}) => {
    if (!this.pdfDims300[n]) throw new Error(`renderPageImage requires a PDF-backed page; page ${n} is not backed by a PDF.`);
    const pm = this.#pageMetrics[n];
    // Display slot `n` may hold a page copied from another document, so render it from its own source, not this doc's.
    const pdfScheduler = await this.resolveSource(pm).getScheduler();
    // Display slot `n` may have been reordered, so raster its source page, not its position.
    const sourcePageN = pm?.sourcePageN ?? n;
    const result = await pdfScheduler.renderPdfPage({
      pageIndex: sourcePageN,
      colorMode: options.colorMode ?? 'color',
      dpi: options.dpi ?? 300,
      outputFormat: options.format ?? 'png',
      quality: options.quality ?? 0.6,
      edits: this.#editsForPage(n, false),
    }, false);
    // Background-lane renders are never superseded, so a drop here means the scheduler is misbehaving.
    if (!result || result === SKIPPED) throw new Error(`renderPageImage: render for page ${n} was dropped.`);
    return result;
  };

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [forViewer=false] - Whether this render serves the on-screen viewer.
   *    Viewer renders are served ahead of background work, newest-first, and may be dropped (resolving to SKIPPED) when superseded.
   */
  getBinary = async (n, props, forViewer) => {
    if (forViewer) return this.getImages(n, props, false, true).binary;
    for (let i = 0; i < MAX_SKIPPED_RETRY; i++) {
      const binary = await this.getImages(n, props, false, false).binary;
      if (binary !== SKIPPED) return binary;
    }
    throw new Error(`getBinary: render for page ${n} repeatedly dropped (SKIPPED).`);
  };

  /**
   * Pre-render pages.
   * This is generally not required, as individual images are rendered as needed.
   * The primary use case is reducing latency in the UI by rendering images in advance.
   *
   * @param {Object} params
   * @param {boolean} params.binary - Whether to render binary images.
   * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to render. Overrides min/max when provided.
   * @param {number} [params.min=0] - Min page to render (used when pageArr is not provided).
   * @param {number} [params.max=0] - Max page to render (used when pageArr is not provided).
   * @param {ImagePropertiesRequest} [params.props]
   */
  preRenderRange = async ({
    binary, pageArr = null, min = 0, max = 0, props,
  }) => {
    const pagesArr = pageArr || range(min, max);
    if (binary) {
      await Promise.all(pagesArr.map((n) => this.getBinary(n, props).then(() => {
        this.#doc.progressHandler({ n, type: 'render', info: { } });
      })));
    } else {
      await Promise.all(pagesArr.map((n) => this.getNative(n, props).then(() => {
        this.#doc.progressHandler({ n, type: 'render', info: { } });
      })));
    }
  };

  clear = () => {
    for (const url of this.thumbnailUrls.values()) URL.revokeObjectURL(url);
    this.thumbnailUrls.clear();
    for (const retired of this.retiredThumbnailUrls) if (retired) for (const url of retired) URL.revokeObjectURL(url);
    this.retiredThumbnailUrls = [];
    this.nativeSrc = [];
    this.native = [];
    this.binary = [];
    this.inputModes.image = false;
    this.inputModes.pdf = false;
    this.pageCount = 0;
    this.pdfDims300.length = 0;
    this.loadCount = 0;
    this.nativeProps.length = 0;
    this.binaryProps.length = 0;
    this.renderDrawMs.length = 0;
    this.#editFontCache.clear();
    this.#editFontResolved.clear();
    this.#type3HashCache.clear();
    this.#type3HashResolved.clear();
    this.#keepByViewer.clear();
    this.#viewerRasters.clear();
    this.#thumbCache = null;
    if (typeof FontFace !== 'undefined') {
      // `doc.clear()` reissues the id right after this call.
      const prefix = `_edit_d${this.#doc.id}_`;
      import('./fontContainer.js').then(({ unregisterFontFacesMatching }) => {
        unregisterFontFacesMatching((family) => family.startsWith(prefix));
      }).catch(() => {});
    }
  };

  terminate = async () => {
    this.clear();
    // Release this document's refcount on each source, terminating only sources no other document still holds.
    const orphaned = [];
    for (const src of this.sources.values()) {
      src.refCount -= 1;
      if (src.refCount <= 0) orphaned.push(src);
    }
    this.sources.clear();
    this.primarySourceId = null;
    await Promise.all(orphaned.map((s) => s.terminate()));
  };

  /**
   * @param {ArrayBuffer | Uint8Array | Blob | import('../import/nodeAdapter.js').FileNode} fileData
   * @param {Object} [options]
   * @param {boolean} [options.usePdfSharedBuffer] - Share the loaded PDF across PDF workers via
   *    SharedArrayBuffer instead of cloning per worker. Defaults to `opt.usePdfSharedBuffer`.
   * @param {number} [options.pdfWorkerN] - Fixed worker-pool size for this document's source.
   */
  openMainPDF = async (fileData, options = {}) => {
    const usePdfSharedBuffer = options.usePdfSharedBuffer ?? opt.usePdfSharedBuffer;
    if (options.pdfWorkerN) this.#ensurePrimarySource().workerN = options.pdfWorkerN;

    const pdfScheduler = await this.getPdfScheduler();

    /** @type {ArrayBuffer | Uint8Array} */
    let pdfData;
    if (usePdfSharedBuffer && poolCanShare(pdfScheduler) && 'sharedBytes' in fileData && typeof fileData.sharedBytes === 'function') {
      pdfData = await fileData.sharedBytes();
    } else if (fileData instanceof ArrayBuffer) {
      pdfData = fileData;
    } else if (typeof fileData.arrayBuffer === 'function') {
      pdfData = await fileData.arrayBuffer();
    } else {
      pdfData = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
    }
    this.pdfData = pdfData;

    const {
      pageCount, pages, outline, attachments,
    } = await pdfScheduler.loadPdfInAllWorkers(pdfBytesForScheduler(pdfData, usePdfSharedBuffer, pdfScheduler));

    this.pageCount = pageCount;
    this.#ensurePrimarySource().sourcePageCount = pageCount;
    // The outline was parsed in the worker, so renumber its ids from the main-thread counter to keep subsequent edits from colliding.
    this.#doc.outline = reassignOutlineIds(outline || []);
    // Embedded files and the portfolio collection, parsed in the worker beside the outline.
    this.#doc.attachments.collection = attachments?.collection ?? null;
    this.#doc.attachments.files = attachments?.files ?? [];

    this.pdfDims300.length = 0;
    for (const page of pages) {
      const widthPts = Math.abs(page.mediaBox[2] - page.mediaBox[0]);
      const heightPts = Math.abs(page.mediaBox[3] - page.mediaBox[1]);
      // /Rotate swaps the visual page dimensions for 90°/270°.
      // The renderer and parser (parsePdfDoc.js) both operate in the
      // post-rotation coordinate space, so pdfDims300 must match.
      const rotated = page.rotate === 90 || page.rotate === 270;
      const visualWidthPts = rotated ? heightPts : widthPts;
      const visualHeightPts = rotated ? widthPts : heightPts;
      const width = Math.round(visualWidthPts * 300 / 72);
      const height = Math.round(visualHeightPts * 300 / 72);
      this.pdfDims300.push({ width, height });
    }

    this.inputModes.pdf = true;

    // Set page metrics based on PDF dimensions.
    // This is always run, even though it is overwritten almost immediately by OCR data when it is uploaded.
    // This is done to ensure that the page metrics are always set (which is necessary to prevent a crash),
    // even if (due to some edge case) metrics cannot be parsed from the OCR data for all pages.
    // For example, this was encountered using Archive.org data where the page counts of the PDFs and OCR data did not match perfectly.

    // For reasons that are unclear, a small number of pages have been rendered into massive files
    // so a hard-cap on resolution must be imposed.
    const pageDPI = this.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);

    this.pdfDims300.forEach((x, i) => {
      const pageDims = { width: Math.round(x.width * pageDPI[i] / 300), height: Math.round(x.height * pageDPI[i] / 300) };
      this.#pageMetrics[i] = new PageMetrics(pageDims);
    });
  };
}
