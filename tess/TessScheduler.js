/** Jobs resolve to this value when dropped from the queue rather than run. */
export const SKIPPED = Symbol('scribe.skippedJob');

/** Backstop on the staged display lane; the focus move's keep set is what normally bounds it. */
export const MAX_STAGED_VIEWER_JOBS = 16;

export const MAX_STAGED_THUMB_JOBS = 32;

/** Backstop on the staged prefetch lane; the focus move's keep set is what normally bounds it. */
export const MAX_STAGED_PREFETCH_JOBS = 32;

/**
 * How long after interactive work the pumps keep off the last free worker.
 * Longer than the gap between a landing page's request and the rail's, shorter than a parse the reader would notice.
 */
export const QUIET_MS = 150;

/**
 * Enable to print debugging messages with dispatch timings.
 */
export const DEBUG_RENDER_SCHED = false;

/**
 * @typedef {'display'|'preview'|'prefetch'|'store'|'background'} Lane
 * display: a page canvas for a page on screen, served first, ranked nearest the focus page, dropped when the focus leaves it.
 * preview: a rail row on screen, a grid cell or a scroll preview, served next, ranked nearest the rail's focus, capped.
 * prefetch: a page canvas or a rail row beyond the screen, rendered ahead of the reader's move, served once the screen has its renders, ranked nearest the focus page, dropped when the focus leaves it.
 * store: a stored raster, a results-row thumbnail, a cover or an ingest thumbnail, in arrival order.
 * background: parse, recognition, export and every consumer that cannot handle a drop, in arrival order, never dropped.
 */

const LANE_RANK = {
  display: 0, preview: 1, prefetch: 2, store: 3, background: 4,
};

/**
 * The lane a caller named, with the old boolean accepted: `true` was the viewer lane and `false` the background lane.
 * @param {Lane|boolean|undefined} v
 * @returns {Lane}
 */
export const laneOf = (v) => {
  if (typeof v === 'string' && v in LANE_RANK) return /** @type {Lane} */ (v);
  return v ? 'display' : 'background';
};

export class TessScheduler {
  static #schedulerCounter = 0;

  static #jobCounter = 0;

  #id;

  #workers = {};

  #runningWorkers = {};

  /** @type {Array<any>} Staged jobs. Display jobs sit at the front, newest first; every other lane appends in arrival order. */
  #jobQueue = [];

  #terminated = false;

  /**
   * Page index the main viewer is on (the current page), or `null` when unset.
   * When set, staged display jobs dispatch closest-to-focus first and lane eviction drops the farthest job.
   * @type {?number}
   */
  #viewerFocus = null;

  /**
   * Page index at the centre of the thumbnail rail, or `null` when the rail is hidden/idle.
   * When set, staged preview jobs dispatch closest-to-focus first and the preview cap drops the farthest.
   * Separate from `#viewerFocus` because the rail can be scrolled to a different page than the main viewer.
   * @type {?number}
   */
  #thumbFocus = null;

  /** When the last interactive job was staged, for the quiet window. */
  #lastInteractiveAt = -Infinity;

  #quietMs;

  /** @type {?ReturnType<typeof setTimeout>} Re-dispatch once the quiet window has passed. */
  #quietTimer = null;

  /** @type {Array<() => void>} One-shot callbacks for the next moment with nothing staged and nothing running. */
  #idleCallbacks = [];

  /** @type {Record<string, number>} The page each worker last handled, for affinity in dispatch. */
  #lastPage = {};

  /** @type {Map<string, (w: any) => void>} Workers leaving the pool once their running job settles, by id, with the caller waiting for each. */
  #retiring = new Map();

  /**
   * @param {{quietMs?: number}} [options] - `quietMs` is the window after interactive work during which background and store work may not take the last free worker.
   */
  constructor({ quietMs = QUIET_MS } = {}) {
    this.#id = `Scheduler-${TessScheduler.#schedulerCounter}-${Math.random().toString(16).slice(3, 8)}`;
    TessScheduler.#schedulerCounter += 1;
    this.#quietMs = quietMs;
  }

  /**
   * Set the page the main viewer is on, used to rank staged display and prefetch jobs.
   * With `keep`, every staged display or prefetch job for a page outside it settles as skipped at once, so a window the reader has left never renders.
   * @param {?number} n
   * @param {?Set<number>} [keep] - The pages the viewer still wants rendered.
   */
  setViewerFocus(n, keep = null) {
    this.#viewerFocus = n;
    if (!keep) return;
    const dropped = [];
    this.#jobQueue = this.#jobQueue.filter((job) => {
      if ((job.lane !== 'display' && job.lane !== 'prefetch') || typeof job.pageIndex !== 'number' || keep.has(job.pageIndex)) return true;
      dropped.push(job);
      return false;
    });
    for (const job of dropped) job.drop();
  }

  /**
   * Set the page at the center of the thumbnail rail, used to rank staged preview jobs.
   * @param {?number} n
   */
  setThumbFocus(n) {
    if (DEBUG_RENDER_SCHED && n !== this.#thumbFocus) {
      console.log(`[render-sched] thumb focus -> ${n} (was ${this.#thumbFocus})`);
    }
    this.#thumbFocus = n;
  }

  /**
   * Call `cb` once, the next time nothing is staged and nothing runs. Fires on a microtask when that is already so.
   * @param {() => void} cb
   */
  onIdle(cb) {
    if (this.getQueueLen() === 0 && this.getRunningLen() === 0) {
      Promise.resolve().then(cb);
      return;
    }
    this.#idleCallbacks.push(cb);
  }

  get id() {
    return this.#id;
  }

  /**
   * Take a worker out of the scheduler. An idle worker is handed back at once; a busy one takes no new job and is handed back when its running job settles.
   * @param {string} id
   * @returns {Promise<?object>} The worker, or null when the scheduler does not hold it.
   */
  removeWorker(id) {
    const w = this.#workers[id];
    if (!w) return Promise.resolve(null);
    if (this.#retiring.has(id)) return Promise.resolve(null);
    if (typeof this.#runningWorkers[id] === 'undefined') {
      delete this.#workers[id];
      delete this.#lastPage[id];
      this.#fireIdle();
      return Promise.resolve(w);
    }
    return new Promise((resolve) => { this.#retiring.set(id, resolve); });
  }

  /**
   * Whether worker `id` is running a job.
   * @param {string} id
   */
  isRunning(id) {
    return typeof this.#runningWorkers[id] !== 'undefined';
  }

  /** Whether any job is staged or running. */
  get busy() {
    return this.getQueueLen() > 0 || this.getRunningLen() > 0;
  }

  getQueueLen() {
    return this.#jobQueue.length;
  }

  getRunningLen() {
    return Object.keys(this.#runningWorkers).length;
  }

  /** Workers that can take a job: those held and not retiring. */
  getNumWorkers() {
    return Object.keys(this.#workers).filter((id) => !this.#retiring.has(id)).length;
  }

  #interactiveStaged() {
    return this.#jobQueue.some((job) => job.lane === 'display' || job.lane === 'preview' || job.lane === 'prefetch');
  }

  /**
   * Whether a store or background job may take a free worker now.
   * While interactive work is staged, or was staged within the quiet window, one worker stays free for the screen.
   */
  #backgroundAllowed() {
    const n = this.getNumWorkers();
    let runningBg = 0;
    for (const job of Object.values(this.#runningWorkers)) if (job.lane === 'store' || job.lane === 'background') runningBg += 1;
    const recent = this.#interactiveStaged() || performance.now() - this.#lastInteractiveAt < this.#quietMs;
    return runningBg < (recent ? n - 1 : n);
  }

  /**
   * Selects the next staged job to dispatch, or -1 when the only staged work is store or background work that must wait.
   * Lanes dispatch in rank order. Within display and prefetch, the job nearest `#viewerFocus` (the newest display job, the oldest prefetch job, when no focus is set).
   * Within preview, the job nearest `#thumbFocus` (the oldest when no focus is set). Store and background run in arrival order.
   * @returns {number} Queue index of the selected job.
   */
  #pickNextJobIndex() {
    let bestLane = Infinity;
    for (const job of this.#jobQueue) bestLane = Math.min(bestLane, LANE_RANK[job.lane]);
    if (bestLane === Infinity) return -1;
    if (bestLane >= LANE_RANK.store && !this.#backgroundAllowed()) return -1;
    let focus = null;
    if (bestLane === LANE_RANK.display || bestLane === LANE_RANK.prefetch) focus = this.#viewerFocus;
    else if (bestLane === LANE_RANK.preview) focus = this.#thumbFocus;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.#jobQueue.length; i += 1) {
      const job = this.#jobQueue[i];
      if (LANE_RANK[job.lane] !== bestLane) continue;
      if (focus === null) return i;
      const dist = typeof job.pageIndex === 'number' ? Math.abs(job.pageIndex - focus) : Infinity;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  #armQuietTimer() {
    if (this.#quietTimer !== null || this.#terminated) return;
    const wait = Math.max(0, this.#lastInteractiveAt + this.#quietMs - performance.now());
    this.#quietTimer = setTimeout(() => {
      this.#quietTimer = null;
      this.#dequeue();
    }, wait);
    // A pending re-dispatch must not keep a finished Node script alive.
    if (typeof this.#quietTimer === 'object' && 'unref' in this.#quietTimer) this.#quietTimer.unref();
  }

  #fireIdle() {
    if (this.getQueueLen() > 0 || this.getRunningLen() > 0 || this.#idleCallbacks.length === 0) return;
    const cbs = this.#idleCallbacks;
    this.#idleCallbacks = [];
    for (const cb of cbs) cb();
  }

  #dequeue() {
    const free = Object.keys(this.#workers).filter((id) => typeof this.#runningWorkers[id] === 'undefined' && !this.#retiring.has(id));
    if (free.length === 0 || this.#jobQueue.length === 0) {
      this.#fireIdle();
      return;
    }
    const idx = this.#pickNextJobIndex();
    if (idx < 0) {
      // Store or background work waits out the quiet window.
      if (this.#jobQueue.length > 0) this.#armQuietTimer();
      return;
    }
    const [job] = this.#jobQueue.splice(idx, 1);
    // The worker that last handled the page holds its decoded images and fonts, so the same page's next job goes there.
    const affine = typeof job.pageIndex === 'number' ? free.find((id) => this.#lastPage[id] === job.pageIndex) : undefined;
    const wId = affine ?? free[0];
    if (typeof job.pageIndex === 'number') this.#lastPage[wId] = job.pageIndex;
    job.run(this.#workers[wId]);
    if (free.length > 1) this.#dequeue();
  }

  /**
   * @param {string} action
   * @param {*} payload
   * @param {Lane} lane
   * @param {?AbortSignal} signal
   */
  #queue(action, payload, lane, signal = null) {
    return new Promise((resolve, reject) => {
      const id = `Job-${TessScheduler.#jobCounter++}-${Math.random().toString(16).slice(3, 8)}`;
      const job = {
        id, action, payload, lane, pageIndex: payload?.pageIndex, queuedAt: 0, dispatchedAt: 0,
      };
      // Lets teardown settle this job while it is running on a worker that is about to be killed.
      job.settleSkipped = () => resolve(SKIPPED);
      if (DEBUG_RENDER_SCHED && action === 'renderPdfPage') {
        job.queuedAt = performance.now();
        console.log(`[render-sched] queued ${lane} ${payload?.pageIndex} (${this.#jobQueue.length} already staged)`);
      }
      // `#dequeue` removes the job from the queue before invoking it.
      job.run = async (w) => {
        // A job whose run was canceled while it was staged never reaches the worker, which takes the next staged job instead.
        if (signal && signal.aborted) {
          reject(signal.reason);
          this.#dequeue();
          return;
        }
        this.#runningWorkers[w.id] = job;
        if (DEBUG_RENDER_SCHED && job.action === 'renderPdfPage') {
          job.dispatchedAt = performance.now();
          console.log(`[render-sched] dispatch ${lane} ${job.payload?.pageIndex} -> worker ${w.id} (staged ${(job.dispatchedAt - job.queuedAt).toFixed(0)}ms)`);
        }
        try {
          const res1 = await w[action](payload, job.id);
          resolve(res1);
          // If an array of promises is returned, wait for all promises to resolve before dequeuing.
          // If this did not happen, then every job could be assigned to the same worker.
          if (Array.isArray(res1)) await Promise.allSettled(res1);
          if (DEBUG_RENDER_SCHED && job.action === 'renderPdfPage') {
            console.log(`[render-sched] completed ${lane} ${job.payload?.pageIndex} on worker ${w.id} (ran ${(performance.now() - job.dispatchedAt).toFixed(0)}ms)`);
          }
        } catch (err) {
          // A dead worker rejects every call instantly, so leaving it in the pool would feed it the entire staged queue.
          if (err instanceof Error && (err.name === 'WorkerCrashError' || err.name === 'WorkerTerminatedError')) {
            delete this.#workers[w.id];
            if (this.getNumWorkers() === 0) {
              const staged = this.#jobQueue;
              this.#jobQueue = [];
              for (const stagedJob of staged) stagedJob.fail(err);
            }
          }
          reject(err);
        } finally {
          delete this.#runningWorkers[w.id];
          const retire = this.#retiring.get(w.id);
          if (retire) {
            this.#retiring.delete(w.id);
            delete this.#workers[w.id];
            delete this.#lastPage[w.id];
            retire(w);
          }
          this.#dequeue();
        }
      };

      // Rejects a staged job that can never run because every worker in the pool has died.
      job.fail = (failErr) => reject(failErr);
      job.drop = () => {
        if (DEBUG_RENDER_SCHED && action === 'renderPdfPage') {
          console.log(`[render-sched] dropped ${lane} ${payload?.pageIndex} (never dispatched)`);
        }
        resolve(SKIPPED);
      };

      if (lane === 'display' || lane === 'preview' || lane === 'prefetch') this.#lastInteractiveAt = performance.now();
      if (lane === 'display' || lane === 'prefetch') {
        // Display jobs are served newest-first and always ahead of every other lane.
        if (lane === 'display') this.#jobQueue.unshift(job); else this.#jobQueue.push(job);
        // With a focus set, evict the staged job farthest from it (ties -> oldest). Otherwise, evict the oldest.
        const staged = this.#jobQueue.filter((j) => j.lane === lane);
        if (staged.length > (lane === 'display' ? MAX_STAGED_VIEWER_JOBS : MAX_STAGED_PREFETCH_JOBS)) {
          let evict = lane === 'display' ? staged[staged.length - 1] : staged[0];
          if (this.#viewerFocus !== null) {
            let worstDist = -1;
            for (const j of staged) {
              const dist = typeof j.pageIndex === 'number' ? Math.abs(j.pageIndex - this.#viewerFocus) : -1;
              if (dist >= worstDist) {
                worstDist = dist;
                evict = j;
              }
            }
          }
          this.#jobQueue.splice(this.#jobQueue.indexOf(evict), 1);
          evict.drop();
        }
      } else {
        this.#jobQueue.push(job);
        if (lane === 'preview') {
          // Over the cap, drop the staged preview farthest from the rail focus, so the on-screen rows stay.
          const staged = this.#jobQueue.filter((j) => j.lane === 'preview');
          if (staged.length > MAX_STAGED_THUMB_JOBS) {
            let evict = staged[0];
            let worstDist = -1;
            for (const j of staged) {
              const dist = this.#thumbFocus === null || typeof j.pageIndex !== 'number' ? Infinity : Math.abs(j.pageIndex - this.#thumbFocus);
              if (dist > worstDist) {
                worstDist = dist;
                evict = j;
              }
            }
            this.#jobQueue.splice(this.#jobQueue.indexOf(evict), 1);
            evict.drop();
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

  /**
   * Stage a job for the next free worker.
   * @param {string} action
   * @param {*} payload
   * @param {Lane|boolean} [lane='background'] - The lane the job is served in; `true` means display and `false` background.
   * @param {?AbortSignal} [signal=null] - Rejects the job with the signal's reason if it fires before the job is dispatched.
   */
  async addJob(action, payload, lane = 'background', signal = null) {
    if (this.#terminated) return SKIPPED;
    if (this.getNumWorkers() === 0) {
      throw Error(`[${this.#id}]: You need to have at least one worker before adding jobs`);
    }

    return this.#queue(action, payload, laneOf(lane), signal);
  }

  /**
   * Settle every staged job of the given lanes as skipped.
   * @param {Array<Lane>} lanes
   */
  dropLanes(lanes) {
    const dropped = [];
    this.#jobQueue = this.#jobQueue.filter((job) => {
      if (!lanes.includes(job.lane)) return true;
      dropped.push(job);
      return false;
    });
    for (const job of dropped) job.drop();
    this.#fireIdle();
  }

  /**
   * Tear the pool down.
   * Staged and in-flight jobs settle to SKIPPED, the codebase's "dropped, ask again" contract, so no caller waits forever.
   * @param {boolean} [keepWorkers] - Settle the jobs but leave the workers running, for a caller that leases them from a shared pool and returns them itself.
   */
  async terminate(keepWorkers = false) {
    this.#terminated = true;
    if (this.#quietTimer !== null) {
      clearTimeout(this.#quietTimer);
      this.#quietTimer = null;
    }
    const staged = this.#jobQueue;
    this.#jobQueue = [];
    for (const job of staged) job.drop();
    for (const job of Object.values(this.#runningWorkers)) job.settleSkipped();
    const workers = Object.values(this.#workers);
    // A caller waiting for a retiring worker gets it back now, since the pool teardown that follows owns the workers.
    for (const [id, retire] of this.#retiring) retire(this.#workers[id] ?? null);
    this.#retiring.clear();
    this.#workers = {};
    this.#runningWorkers = {};
    this.#idleCallbacks = [];
    if (keepWorkers) return;
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
