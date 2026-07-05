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
 * Kept but off: with the paired gate in viewer.js, turn on to trace render-dispatch order when diagnosing regressions.
 */
const DEBUG_RENDER_SCHED = false;

export class TessScheduler {
  static #schedulerCounter = 0;

  static #jobCounter = 0;

  #id;

  #workers = {};

  #runningWorkers = {};

  #jobQueue = [];

  /**
   * Index the viewer is currently focused on (the current page), or `null` when unset.
   * When set, staged viewer jobs dispatch closest-to-focus first instead of newest-first, and lane eviction drops the farthest job instead of the oldest.
   * @type {?number}
   */
  #focus = null;

  constructor() {
    this.#id = `Scheduler-${TessScheduler.#schedulerCounter}-${Math.random().toString(16).slice(3, 8)}`;
    TessScheduler.#schedulerCounter += 1;
  }

  /**
   * Set the focus index used to rank staged viewer jobs (see `#focus`).
   * @param {?number} n
   */
  setFocus(n) {
    this.#focus = n;
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
   * @returns {number} Queue index of the selected job: the viewer job closest to the focus when one is set, else the queue front (newest viewer job, or oldest background job).
   */
  #pickNextJobIndex() {
    if (this.#focus === null) return 0;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.#jobQueue.length && this.#jobQueue[i].forViewer; i += 1) {
      const p = this.#jobQueue[i].pageIndex;
      if (typeof p !== 'number') continue;
      const dist = Math.abs(p - this.#focus);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
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
        id, action, payload, forViewer,
      };
      if (DEBUG_RENDER_SCHED && action === 'renderPdfPage') {
        job.queuedAt = performance.now();
        // Thumbnail renders (outputFormat 'jpeg') are logged only at dispatch, not at queue time.
        if (payload?.outputFormat !== 'jpeg') {
          console.log(`[render-sched] queued page ${payload?.pageIndex} (${forViewer ? 'viewer' : 'background'} lane, ${this.#jobQueue.length} already staged)`);
        }
      }
      // `#dequeue` removes the job from the queue before invoking it.
      const jobFunction = async (w) => {
        this.#runningWorkers[w.id] = job;
        if (DEBUG_RENDER_SCHED && job.action === 'renderPdfPage') {
          const kind = job.payload?.outputFormat === 'jpeg' ? 'thumbnail' : 'page';
          console.log(`[render-sched] dispatch ${kind} ${job.payload?.pageIndex} -> worker ${w.id} (staged ${(performance.now() - job.queuedAt).toFixed(0)}ms)`);
        }
        try {
          const res1 = await w[action](payload, job.id);
          resolve(res1);
          // If an array of promises is returned, wait for all promises to resolve before dequeuing.
          // If this did not happen, then every job could be assigned to the same worker.
          if (Array.isArray(res1)) await Promise.allSettled(res1);
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
      // Lets the bounded-lane eviction below settle a dropped (never-run) job.
      jobFunction.drop = () => {
        if (DEBUG_RENDER_SCHED && action === 'renderPdfPage') {
          console.log(`[render-sched] dropped page ${payload?.pageIndex} (staged viewer lane over capacity; never dispatched)`);
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
          if (this.#focus !== null) {
            let worstDist = -1;
            for (let i = 0; i < viewerCount; i += 1) {
              const p = this.#jobQueue[i].pageIndex;
              const dist = typeof p === 'number' ? Math.abs(p - this.#focus) : -1;
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
