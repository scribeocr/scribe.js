/** Jobs resolve to this value when dropped from the queue rather than run. */
export const SKIPPED = Symbol('scribe.skippedJob');

/**
 * Cap on the number of *staged* (not-yet-running) viewer jobs.
 * When a newer viewer job would push the staged lane past this,
 * the oldest staged job is dropped (resolved to SKIPPED) so the
 * viewer lane cannot grow without bound during rapid navigation.
 * Running jobs are never dropped.
 */
export const MAX_STAGED_VIEWER_JOBS = 16;

/**
 * Cap on the number of *staged* (not-yet-running) thumbnail jobs.
 * When a rapid scroll requests many previews and pushes the staged lane over this cap,
 * the staged thumbnail farthest from the rail focus is dropped (resolved to SKIPPED) so the background lane cannot pile up a large backlog.
 * The rail re-requests a dropped thumbnail if its row is still shown.
 * Sits above the largest realistic mounted rail window (~30 cells) so on-screen previews are never dropped.
 */
export const MAX_STAGED_THUMB_JOBS = 32;

/**
 * Enable to print debugging messages with dispatch timings.
 */
export const DEBUG_RENDER_SCHED = false;

export class TessScheduler {
  static #schedulerCounter = 0;

  static #jobCounter = 0;

  #id;

  #workers = {};

  #runningWorkers = {};

  #jobQueue = [];

  /**
   * Page index the main viewer is on (the current page), or `null` when unset.
   * When set, staged viewer jobs dispatch closest-to-focus first and lane eviction drops the farthest job.
   * @type {?number}
   */
  #viewerFocus = null;

  /**
   * Page index at the centre of the thumbnail rail, or `null` when the rail is hidden/idle.
   * When set, staged thumbnail jobs dispatch closest-to-focus first and the thumbnail cap drops the farthest.
   * Separate from `#viewerFocus` because the rail can be scrolled to a different page than the main viewer.
   * @type {?number}
   */
  #thumbFocus = null;

  constructor() {
    this.#id = `Scheduler-${TessScheduler.#schedulerCounter}-${Math.random().toString(16).slice(3, 8)}`;
    TessScheduler.#schedulerCounter += 1;
  }

  /**
   * Set the page the main viewer is on, used to rank staged viewer jobs (see `#viewerFocus`).
   * @param {?number} n
   */
  setViewerFocus(n) {
    this.#viewerFocus = n;
  }

  /**
   * Set the page at the centre of the thumbnail rail, used to rank staged thumbnail jobs (see `#thumbFocus`).
   * @param {?number} n
   */
  setThumbFocus(n) {
    if (DEBUG_RENDER_SCHED && n !== this.#thumbFocus) {
      console.log(`[render-sched] thumb focus -> ${n} (was ${this.#thumbFocus})`);
    }
    this.#thumbFocus = n;
  }

  get id() {
    return this.#id;
  }

  getQueueLen() {
    return this.#jobQueue.length;
  }

  getNumWorkers() {
    return Object.keys(this.#workers).length;
  }

  /**
   * Selects the next staged job to dispatch.
   *
   * Two tiers: viewer (on-screen page) renders always dispatch before any background job.
   * - Within the viewer tier, pick the job nearest `#viewerFocus` (the current page).
   * - Within the background tier, thumbnails dispatch nearest `#thumbFocus` (the rail centre) first, while every other background job (parse / OCR / export) keeps FIFO order.
   * The two groups interleave by the age of each group's oldest job, so a thumbnail flurry cannot delay an older background job beyond the thumbnail cap.
   * @returns {number} Queue index of the selected job.
   */
  #pickNextJobIndex() {
    // Viewer jobs are unshifted to the front, so if any are staged the queue head is one of them.
    if (this.#jobQueue.length && this.#jobQueue[0].forViewer) {
      if (this.#viewerFocus === null) return 0;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < this.#jobQueue.length && this.#jobQueue[i].forViewer; i += 1) {
        const p = this.#jobQueue[i].pageIndex;
        if (typeof p !== 'number') continue;
        const dist = Math.abs(p - this.#viewerFocus);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    }

    // Background tier only.
    // Background jobs are pushed to the back in insertion order, so a lower index is older.
    // Find the oldest non-thumbnail job, the oldest thumbnail, and the thumbnail nearest the rail focus.
    let firstNonThumb = -1;
    let firstThumb = -1;
    let bestThumb = -1;
    let bestThumbDist = Infinity;
    for (let i = 0; i < this.#jobQueue.length; i += 1) {
      const job = this.#jobQueue[i];
      if (job.isThumb) {
        if (firstThumb === -1) firstThumb = i;
        const p = job.pageIndex;
        const dist = this.#thumbFocus === null || typeof p !== 'number' ? Infinity : Math.abs(p - this.#thumbFocus);
        if (dist < bestThumbDist) {
          bestThumbDist = dist;
          bestThumb = i;
        }
      } else if (firstNonThumb === -1) {
        firstNonThumb = i;
      }
    }
    if (firstThumb === -1) return 0;
    // A non-thumbnail job queued before any staged thumbnail runs first (FIFO fairness across groups).
    if (firstNonThumb !== -1 && firstNonThumb < firstThumb) return firstNonThumb;
    // The thumbnail group's turn: dispatch the one nearest the rail focus (oldest when no focus is set).
    return bestThumb === -1 ? firstThumb : bestThumb;
  }

  #dequeue() {
    if (this.#jobQueue.length !== 0) {
      const wIds = Object.keys(this.#workers);
      for (let i = 0; i < wIds.length; i += 1) {
        if (typeof this.#runningWorkers[wIds[i]] === 'undefined') {
          const jobFunction = this.#jobQueue.splice(this.#pickNextJobIndex(), 1)[0];
          jobFunction(this.#workers[wIds[i]]);
          break;
        }
      }
    }
  }

  #queue(action, payload, forViewer = false) {
    return new Promise((resolve, reject) => {
      const id = `Job-${TessScheduler.#jobCounter++}-${Math.random().toString(16).slice(3, 8)}`;
      const job = {
        id, action, payload, forViewer, queuedAt: 0, dispatchedAt: 0,
      };
      if (DEBUG_RENDER_SCHED && action === 'renderPdfPage') {
        job.queuedAt = performance.now();
        const kind = payload?.outputFormat === 'jpeg' ? 'thumbnail' : 'page';
        console.log(`[render-sched] queued ${kind} ${payload?.pageIndex} (${forViewer ? 'viewer' : 'background'} lane, ${this.#jobQueue.length} already staged)`);
      }
      // `#dequeue` removes the job from the queue before invoking it.
      const jobFunction = async (w) => {
        this.#runningWorkers[w.id] = job;
        if (DEBUG_RENDER_SCHED && job.action === 'renderPdfPage') {
          job.dispatchedAt = performance.now();
          const kind = job.payload?.outputFormat === 'jpeg' ? 'thumbnail' : 'page';
          console.log(`[render-sched] dispatch ${kind} ${job.payload?.pageIndex} -> worker ${w.id} (staged ${(job.dispatchedAt - job.queuedAt).toFixed(0)}ms)`);
        }
        try {
          const res1 = await w[action](payload, job.id);
          resolve(res1);
          // If an array of promises is returned, wait for all promises to resolve before dequeuing.
          // If this did not happen, then every job could be assigned to the same worker.
          if (Array.isArray(res1)) await Promise.allSettled(res1);
          if (DEBUG_RENDER_SCHED && job.action === 'renderPdfPage') {
            const kind = job.payload?.outputFormat === 'jpeg' ? 'thumbnail' : 'page';
            console.log(`[render-sched] completed ${kind} ${job.payload?.pageIndex} on worker ${w.id} (ran ${(performance.now() - job.dispatchedAt).toFixed(0)}ms)`);
          }
        } catch (err) {
          reject(err);
        } finally {
          delete this.#runningWorkers[w.id];
          this.#dequeue();
        }
      };

      jobFunction.forViewer = forViewer;
      // Rank key for focus-based dispatch and eviction (undefined for jobs without a page).
      jobFunction.pageIndex = payload?.pageIndex;
      // Thumbnail renders are the only 'jpeg' output.
      jobFunction.isThumb = action === 'renderPdfPage' && payload?.outputFormat === 'jpeg';
      // Lets the bounded-lane eviction below settle a dropped (never-run) job.
      jobFunction.drop = () => {
        if (DEBUG_RENDER_SCHED && action === 'renderPdfPage') {
          const kind = payload?.outputFormat === 'jpeg' ? 'thumbnail' : 'page';
          console.log(`[render-sched] dropped ${kind} ${payload?.pageIndex} (staged lane over capacity; never dispatched)`);
        }
        resolve(SKIPPED);
      };

      if (forViewer) {
        // Viewer jobs are served newest-first (LIFO) and always ahead of background (non-viewer) jobs.
        this.#jobQueue.unshift(jobFunction);
        // Bound the staged viewer lane.
        // Viewer jobs occupy a contiguous prefix of the queue (unshift to front, background jobs push to back),
        // so the oldest staged viewer job is the last one in that prefix; drop it when over capacity.
        // Running jobs are already off-queue.
        let viewerCount = 0;
        while (viewerCount < this.#jobQueue.length && this.#jobQueue[viewerCount].forViewer) {
          viewerCount += 1;
        }
        if (viewerCount > MAX_STAGED_VIEWER_JOBS) {
          // With a focus set, evict the staged job farthest from it (ties -> oldest).
          // Otherwise, evict the oldest staged viewer job (the last one in the prefix).
          let evictIdx = viewerCount - 1;
          if (this.#viewerFocus !== null) {
            let worstDist = -1;
            for (let i = 0; i < viewerCount; i += 1) {
              const p = this.#jobQueue[i].pageIndex;
              const dist = typeof p === 'number' ? Math.abs(p - this.#viewerFocus) : -1;
              if (dist >= worstDist) {
                worstDist = dist;
                evictIdx = i;
              }
            }
          }
          const [evicted] = this.#jobQueue.splice(evictIdx, 1);
          evicted.drop();
        }
      } else {
        this.#jobQueue.push(jobFunction);
        if (jobFunction.isThumb) {
          // Bound the staged thumbnail jobs.
          // Over the cap, drop the staged thumbnail farthest from the rail focus (ties -> oldest; oldest overall when no focus is set), keeping the on-screen previews.
          let thumbCount = 0;
          for (let i = 0; i < this.#jobQueue.length; i += 1) {
            if (this.#jobQueue[i].isThumb) thumbCount += 1;
          }
          if (thumbCount > MAX_STAGED_THUMB_JOBS) {
            let evictIdx = -1;
            let worstDist = -1;
            for (let i = 0; i < this.#jobQueue.length; i += 1) {
              const j = this.#jobQueue[i];
              if (!j.isThumb) continue;
              const p = j.pageIndex;
              const dist = this.#thumbFocus === null || typeof p !== 'number' ? Infinity : Math.abs(p - this.#thumbFocus);
              if (dist > worstDist) {
                worstDist = dist;
                evictIdx = i;
              }
            }
            if (evictIdx !== -1) {
              const [evicted] = this.#jobQueue.splice(evictIdx, 1);
              evicted.drop();
            }
          }
        }
      }

      this.#dequeue();
    });
  }

  addWorker(w) {
    this.#workers[w.id] = w;
    this.#dequeue();
    return w.id;
  }

  async addJob(action, payload, forViewer = false) {
    if (this.getNumWorkers() === 0) {
      throw Error(`[${this.#id}]: You need to have at least one worker before adding jobs`);
    }

    return this.#queue(action, payload, forViewer);
  }

  async terminate() {
    const terminatePromises = Object.keys(this.#workers)
      .map((wid) => this.#workers[wid].terminate());
    await Promise.all(terminatePromises);
    this.#jobQueue = [];
  }
}
