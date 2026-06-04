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

export class TessScheduler {
  static #schedulerCounter = 0;

  static #jobCounter = 0;

  #id;

  #workers = {};

  #runningWorkers = {};

  #jobQueue = [];

  constructor() {
    this.#id = `Scheduler-${TessScheduler.#schedulerCounter}-${Math.random().toString(16).slice(3, 8)}`;
    TessScheduler.#schedulerCounter += 1;
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

  #dequeue() {
    if (this.#jobQueue.length !== 0) {
      const wIds = Object.keys(this.#workers);
      for (let i = 0; i < wIds.length; i += 1) {
        if (typeof this.#runningWorkers[wIds[i]] === 'undefined') {
          this.#jobQueue[0](this.#workers[wIds[i]]);
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
      const jobFunction = async (w) => {
        this.#jobQueue.shift();
        this.#runningWorkers[w.id] = job;
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
      // Lets the bounded-lane eviction below settle a dropped (never-run) job.
      jobFunction.drop = () => resolve(SKIPPED);

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
          const [evicted] = this.#jobQueue.splice(viewerCount - 1, 1);
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
