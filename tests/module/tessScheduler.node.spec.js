import {
  describe, test, expect, vi, afterEach,
} from 'vitest';
import {
  TessScheduler, SKIPPED, MAX_STAGED_VIEWER_JOBS, QUIET_MS,
} from '../../tess/TessScheduler.js';

const tick = () => new Promise((r) => { setTimeout(r, 0); });

/**
 * Build a scheduler with `numWorkers` fake workers whose 'render' jobs stay pending until `releaseOne`.
 */
function harness(numWorkers) {
  // The queue-discipline tests are about order, so the quiet window stays out of their way.
  const sched = new TessScheduler({ quietMs: 0 });
  /** @type {string[]} */
  const started = [];
  /** @type {Array<() => void>} */
  const pending = [];
  for (let i = 0; i < numWorkers; i++) {
    sched.addWorker({
      id: `w${i}`,
      render: (payload) => new Promise((resolve) => {
        started.push(payload.tag);
        pending.push(() => resolve(`done:${payload.tag}`));
      }),
      terminate: async () => {},
    });
  }
  const releaseOne = async () => {
    const f = pending.shift();
    if (f) f();
    await tick();
  };
  const enqueue = (tag, forViewer) => sched.addJob('render', { tag }, forViewer);
  return {
    sched, started, releaseOne, enqueue,
  };
}

describe('TessScheduler queue discipline', () => {
  test('viewer jobs run last-in-first-out', async () => {
    const h = harness(1);
    h.enqueue('J0', true);
    await tick();
    h.enqueue('A', true);
    h.enqueue('B', true);
    h.enqueue('C', true);
    await tick();
    expect(h.started).toEqual(['J0']);
    await h.releaseOne();
    await h.releaseOne();
    await h.releaseOne();
    expect(h.started).toEqual(['J0', 'C', 'B', 'A']);
  });

  test('background jobs run first-in-first-out', async () => {
    const h = harness(1);
    h.enqueue('J0', false);
    await tick();
    h.enqueue('X', false);
    h.enqueue('Y', false);
    h.enqueue('Z', false);
    await h.releaseOne();
    await h.releaseOne();
    await h.releaseOne();
    expect(h.started).toEqual(['J0', 'X', 'Y', 'Z']);
  });

  test('viewer jobs are served before queued background jobs', async () => {
    const h = harness(1);
    h.enqueue('J0', false);
    await tick();
    h.enqueue('N1', false);
    h.enqueue('V1', true);
    await h.releaseOne();
    await h.releaseOne();
    expect(h.started).toEqual(['J0', 'V1', 'N1']);
  });

  test('staged viewer lane is bounded; the oldest is evicted and resolves SKIPPED', async () => {
    const h = harness(1);
    h.enqueue('J0', true);
    await tick();
    const staged = [];
    for (let i = 0; i < MAX_STAGED_VIEWER_JOBS; i++) staged.push(h.enqueue(`S${i}`, true));
    await tick();
    expect(h.sched.getQueueLen()).toBe(MAX_STAGED_VIEWER_JOBS);
    const ofP = h.enqueue('OF', true);
    await tick();
    expect(h.sched.getQueueLen()).toBe(MAX_STAGED_VIEWER_JOBS);
    await expect(staged[0]).resolves.toBe(SKIPPED);
    await h.releaseOne();
    await h.releaseOne();
    expect(h.started).toEqual(['J0', 'OF', `S${MAX_STAGED_VIEWER_JOBS - 1}`]);
    await expect(ofP).resolves.toBe('done:OF');
  });

  test('the background lane is not bounded by the viewer-lane cap', async () => {
    const h = harness(1);
    h.enqueue('J0', false);
    await tick();
    const overflow = MAX_STAGED_VIEWER_JOBS + 3;
    for (let i = 0; i < overflow; i++) h.enqueue(`N${i}`, false);
    await tick();
    expect(h.sched.getQueueLen()).toBe(overflow);
    await h.releaseOne();
    expect(h.started).toEqual(['J0', 'N0']);
  });

  // Regression: consumers cache these promises for page and thumbnail slots, so a teardown that abandons them hangs those slots forever.
  test('terminate() settles staged and in-flight jobs to SKIPPED', async () => {
    const h = harness(1);
    const running = h.enqueue('J0', false);
    await tick();
    const stagedA = h.enqueue('A', false);
    const stagedB = h.enqueue('B', true);
    await tick();
    expect(h.started).toEqual(['J0']);
    await h.sched.terminate();
    const state = (p) => Promise.race([p, new Promise((r) => { setTimeout(() => r('PENDING'), 200); })]);
    expect(await state(running), 'the in-flight job settles to SKIPPED on pool teardown').toBe(SKIPPED);
    expect(await state(stagedA), 'a staged background job settles to SKIPPED on pool teardown').toBe(SKIPPED);
    expect(await state(stagedB), 'a staged viewer job settles to SKIPPED on pool teardown').toBe(SKIPPED);
  });

  test('addJob after terminate() resolves SKIPPED instead of dispatching into a dead pool', async () => {
    const h = harness(1);
    h.enqueue('J0', false);
    await tick();
    await h.sched.terminate();
    const post = h.enqueue('post', false);
    const state = await Promise.race([post, new Promise((r) => { setTimeout(() => r('PENDING'), 200); })]);
    expect(state, 'a job added after teardown settles to SKIPPED rather than queueing forever').toBe(SKIPPED);
    expect(h.started, 'no job dispatches after teardown').toEqual(['J0']);
  });
});

describe('TessScheduler worker crash discipline', () => {
  /**
   * Build a scheduler whose fake workers can be crashed mid-job.
   * A crashed worker rejects every later call, matching a real PDF worker whose thread has died.
   */
  function crashableHarness(numWorkers) {
    const sched = new TessScheduler({ quietMs: 0 });
    /** @type {string[]} */
    const started = [];
    /** @type {Map<string, {resolve: () => void, reject: (err: Error) => void}>} */
    const inFlight = new Map();
    const crashErr = new Error('worker crashed');
    crashErr.name = 'WorkerCrashError';
    const crashedIds = new Set();
    for (let i = 0; i < numWorkers; i++) {
      const id = `w${i}`;
      sched.addWorker({
        id,
        render: (payload) => {
          if (crashedIds.has(id)) return Promise.reject(crashErr);
          return new Promise((resolve, reject) => {
            started.push(`${id}:${payload.tag}`);
            inFlight.set(id, { resolve: () => resolve(`done:${payload.tag}`), reject });
          });
        },
        terminate: async () => {},
      });
    }
    const crash = (id) => {
      crashedIds.add(id);
      const cur = inFlight.get(id);
      inFlight.delete(id);
      if (cur) cur.reject(crashErr);
    };
    const finish = async (id) => {
      const cur = inFlight.get(id);
      inFlight.delete(id);
      if (cur) cur.resolve();
      await tick();
    };
    const enqueue = (tag) => sched.addJob('render', { tag }, false);
    return {
      sched, started, crash, finish, enqueue,
    };
  }

  // Regression: a dead worker left in the pool absorbed the entire staged queue, because every call on it rejects instantly.
  test('a crashed worker is dropped from the pool and staged jobs complete on the survivors', async () => {
    const h = crashableHarness(2);
    const j0 = h.enqueue('J0');
    const j1 = h.enqueue('J1');
    await tick();
    const staged = ['A', 'B', 'C'].map((t) => h.enqueue(t));
    await tick();
    // The rejection handler must attach before the crash, or the rejection is unhandled during the tick.
    const j0Rejects = expect(j0, 'the in-flight job on the crashed worker rejects').rejects.toThrow('worker crashed');
    h.crash('w0');
    await tick();
    await j0Rejects;
    await h.finish('w1');
    await h.finish('w1');
    await h.finish('w1');
    await h.finish('w1');
    expect(await Promise.all(staged), 'jobs staged behind a crashed worker complete on the surviving workers').toEqual(['done:A', 'done:B', 'done:C']);
    expect(h.started, 'no job dispatches to the dead worker').toEqual(['w0:J0', 'w1:J1', 'w1:A', 'w1:B', 'w1:C']);
    await expect(j1, 'the survivor\'s own in-flight job is unaffected by the crash').resolves.toBe('done:J1');
  });

  test('staged jobs reject rather than hang when every worker has died', async () => {
    const h = crashableHarness(1);
    const j0 = h.enqueue('J0');
    await tick();
    const stagedA = h.enqueue('A');
    h.crash('w0');
    await expect(j0, 'the in-flight job on the dead worker rejects').rejects.toThrow('worker crashed');
    const state = await Promise.race([
      stagedA.then(() => 'settled', () => 'settled'),
      new Promise((r) => { setTimeout(() => r('PENDING'), 200); }),
    ]);
    expect(state, 'a staged job does not hang forever when the whole pool is dead').toBe('settled');
    await expect(stagedA, 'a staged job rejects when no worker survives to run it').rejects.toThrow('worker crashed');
  });
});

describe('TessScheduler lanes', () => {
  afterEach(() => { vi.useRealTimers(); });

  /**
   * Build a scheduler whose fake workers record which worker started which job and hold every job until released.
   * `quietMs` is the window after interactive work during which background work may not take the last free worker.
   */
  function laneHarness(numWorkers, { quietMs } = {}) {
    const sched = new TessScheduler(quietMs === undefined ? undefined : { quietMs });
    /** @type {string[]} */
    const started = [];
    /** @type {Array<() => void>} */
    const pending = [];
    for (let i = 0; i < numWorkers; i++) {
      const id = `w${i}`;
      sched.addWorker({
        id,
        render: (payload) => new Promise((resolve) => {
          started.push(`${id}:${payload.tag}`);
          pending.push(() => resolve(`done:${payload.tag}`));
        }),
        terminate: async () => {},
      });
    }
    // Microtasks, so the fake-timer tests below can release jobs without advancing the clock.
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const releaseOne = async () => {
      const f = pending.shift();
      if (f) f();
      await flush();
    };
    /** @param {string} tag @param {'display'|'preview'|'prefetch'|'store'|'background'} lane @param {number} [pageIndex] */
    const enqueue = (tag, lane, pageIndex) => sched.addJob('render', { tag, pageIndex }, lane);
    return {
      sched, started, releaseOne, enqueue,
    };
  }

  test('staged jobs dispatch by lane: display, then preview, then prefetch, then store, then background', async () => {
    const h = laneHarness(1, { quietMs: 0 });
    h.enqueue('J0', 'background');
    await tick();
    h.enqueue('F', 'prefetch', 4);
    h.enqueue('D', 'display', 3);
    h.enqueue('P', 'preview', 3);
    h.enqueue('S', 'store', 3);
    h.enqueue('B', 'background', 3);
    await tick();
    for (let i = 0; i < 5; i++) await h.releaseOne();
    expect(h.started, 'the five lanes dispatch in priority order whatever their arrival order').toEqual(['w0:J0', 'w0:D', 'w0:P', 'w0:F', 'w0:S', 'w0:B']);
  });

  test('a true third argument still means the display lane and false the background lane', async () => {
    const h = laneHarness(1, { quietMs: 0 });
    h.sched.addJob('render', { tag: 'J0' }, false);
    await tick();
    h.sched.addJob('render', { tag: 'B' }, false);
    h.sched.addJob('render', { tag: 'V' }, true);
    await h.releaseOne();
    await h.releaseOne();
    expect(h.started, 'boolean callers keep their lanes').toEqual(['w0:J0', 'w0:V', 'w0:B']);
  });

  test('moving the focus drops the staged display jobs outside the pages the viewer still wants', async () => {
    const h = laneHarness(1, { quietMs: 0 });
    h.enqueue('J0', 'display', 100);
    await tick();
    const near = h.enqueue('N', 'display', 101);
    const far1 = h.enqueue('F1', 'display', 10);
    const far2 = h.enqueue('F2', 'display', 11);
    const farAhead = h.enqueue('FA', 'prefetch', 12);
    const bg = h.enqueue('B', 'background', 10);
    await tick();
    h.sched.setViewerFocus(100, new Set([100, 101, 102]));
    await expect(far1, 'a staged display job for a page the viewer left settles as skipped').resolves.toBe(SKIPPED);
    await expect(far2, 'every staged display job outside the keep set is dropped').resolves.toBe(SKIPPED);
    await expect(farAhead, 'a staged prefetch job outside the keep set is dropped with the display jobs').resolves.toBe(SKIPPED);
    expect(h.sched.getQueueLen(), 'the kept display job and the background job stay staged').toBe(2);
    await h.releaseOne();
    await h.releaseOne();
    await h.releaseOne();
    expect(h.started, 'the kept page renders and the background job is untouched by the focus move').toEqual(['w0:J0', 'w0:N', 'w0:B']);
    await expect(near, 'a staged display job inside the keep set survives the focus move').resolves.toBe('done:N');
    await expect(bg, 'a background job survives the focus move').resolves.toBe('done:B');
  });

  test('on several workers, background work leaves one worker free while interactive work is recent', async () => {
    vi.useFakeTimers();
    const h = laneHarness(3);
    h.enqueue('D0', 'display', 1);
    await vi.advanceTimersByTimeAsync(0);
    h.enqueue('B1', 'background');
    h.enqueue('B2', 'background');
    h.enqueue('B3', 'background');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started, 'two of three workers may run background work beside a display job').toEqual(['w0:D0', 'w1:B1', 'w2:B2']);
    await h.releaseOne();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started, 'the worker the display job freed stays free for the screen within the quiet window').toEqual(['w0:D0', 'w1:B1', 'w2:B2']);
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.started, 'once the quiet window passes, background work takes the last worker too').toEqual(['w0:D0', 'w1:B1', 'w2:B2', 'w0:B3']);
  });

  test('on one worker, background work waits out the quiet window after interactive work', async () => {
    vi.useFakeTimers();
    const h = laneHarness(1);
    h.enqueue('D0', 'display', 1);
    await vi.advanceTimersByTimeAsync(0);
    h.enqueue('B1', 'background');
    await h.releaseOne();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started, 'a background job does not slip into the gap right after a display job').toEqual(['w0:D0']);
    h.enqueue('D1', 'display', 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started, 'a display job staged in the gap dispatches at once').toEqual(['w0:D0', 'w0:D1']);
    await h.releaseOne();
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.started, 'the background job runs once the quiet window has passed').toEqual(['w0:D0', 'w0:D1', 'w0:B1']);
  });

  test('a free worker that last drew the page is preferred for that page', async () => {
    const h = laneHarness(2, { quietMs: 0 });
    h.enqueue('A5', 'display', 5);
    h.enqueue('A6', 'display', 6);
    await tick();
    expect(h.started, 'two free workers take two staged jobs').toEqual(['w0:A5', 'w1:A6']);
    await h.releaseOne();
    await h.releaseOne();
    h.enqueue('T6', 'preview', 6);
    await tick();
    expect(h.started, 'the job for page 6 goes to the worker that holds page 6, not the first free one').toEqual(['w0:A5', 'w1:A6', 'w1:T6']);
  });

  test('onIdle fires once the queue is empty and no job runs', async () => {
    const h = laneHarness(1, { quietMs: 0 });
    h.enqueue('J0', 'background');
    h.enqueue('J1', 'background');
    await tick();
    let fired = 0;
    h.sched.onIdle(() => { fired += 1; });
    await h.releaseOne();
    expect(fired, 'the callback waits while a job is still staged or running').toBe(0);
    await h.releaseOne();
    expect(fired, 'the callback fires when the last job settles').toBe(1);
    h.enqueue('J2', 'background');
    await h.releaseOne();
    expect(fired, 'the callback is one-shot').toBe(1);
  });
});

describe('TessScheduler worker retirement', () => {
  function retireHarness(numWorkers) {
    const sched = new TessScheduler({ quietMs: 0 });
    /** @type {string[]} */
    const started = [];
    /** @type {Map<string, () => void>} */
    const pending = new Map();
    for (let i = 0; i < numWorkers; i++) {
      const id = `w${i}`;
      sched.addWorker({
        id,
        render: (payload) => new Promise((resolve) => {
          started.push(`${id}:${payload.tag}`);
          pending.set(id, () => resolve(`done:${payload.tag}`));
        }),
        terminate: async () => {},
      });
    }
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const finish = async (id) => {
      const f = pending.get(id);
      pending.delete(id);
      if (f) f();
      await flush();
    };
    return {
      sched, started, finish, flush, enqueue: (tag) => sched.addJob('render', { tag }, 'background'),
    };
  }

  test('an idle worker leaves at once, and a busy one after its running job, taking no new job meanwhile', async () => {
    // Three workers, so a worker stays once two have left and a job can still be staged behind the retiring one.
    const h = retireHarness(3);
    h.enqueue('A');
    h.enqueue('B');
    h.enqueue('C');
    await h.flush();
    expect(h.started, 'every worker starts a job').toEqual(['w0:A', 'w1:B', 'w2:C']);
    await h.finish('w1');
    const idle = await h.sched.removeWorker('w1');
    expect(idle?.id, 'an idle worker is handed back at once').toBe('w1');
    expect(h.sched.getNumWorkers(), 'the scheduler forgets a removed worker').toBe(2);
    const busyP = h.sched.removeWorker('w0');
    expect(h.sched.getNumWorkers(), 'a retiring worker no longer counts').toBe(1);
    const d = h.enqueue('D');
    await h.flush();
    expect(h.started, 'a retiring worker takes no new job while its running job finishes').toEqual(['w0:A', 'w1:B', 'w2:C']);
    await h.finish('w0');
    const busy = await busyP;
    expect(busy?.id, 'a busy worker is handed back once its running job settles').toBe('w0');
    expect(h.started, 'the job staged behind the retiring worker did not run on it').toEqual(['w0:A', 'w1:B', 'w2:C']);
    expect(h.sched.getNumWorkers(), 'the retired worker is gone from the scheduler').toBe(1);
    await h.finish('w2');
    expect(h.started, 'the staged job runs on the worker that stayed').toEqual(['w0:A', 'w1:B', 'w2:C', 'w2:D']);
    await h.finish('w2');
    await expect(d, 'the staged job completes').resolves.toBe('done:D');
  });
});
