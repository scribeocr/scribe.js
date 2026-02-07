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

  #queue(action, payload, priorityJob = false) {
    return new Promise((resolve, reject) => {
      const id = `Job-${TessScheduler.#jobCounter++}-${Math.random().toString(16).slice(3, 8)}`;
      const job = {
        id, action, payload, priorityJob,
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

      jobFunction.priorityJob = priorityJob;

      // Priority jobs cut in line - insert before the first non-priority job
      if (priorityJob) {
        let insertIndex = 0;
        for (let i = 0; i < this.#jobQueue.length; i += 1) {
          if (!this.#jobQueue[i].priorityJob) {
            insertIndex = i;
            break;
          }
          insertIndex = i + 1;
        }
        this.#jobQueue.splice(insertIndex, 0, jobFunction);
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

  async addJob(action, payload, priorityJob = false) {
    if (this.getNumWorkers() === 0) {
      throw Error(`[${this.#id}]: You need to have at least one worker before adding jobs`);
    }

    return this.#queue(action, payload, priorityJob);
  }

  async terminate() {
    const terminatePromises = Object.keys(this.#workers)
      .map((wid) => this.#workers[wid].terminate());
    await Promise.all(terminatePromises);
    this.#jobQueue = [];
  }
}
