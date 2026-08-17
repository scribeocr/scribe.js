import {
  describe, test, expect,
} from 'vitest';
import { TessScheduler, SKIPPED, MAX_STAGED_VIEWER_JOBS } from '../../tess/TessScheduler.js';

const tick = () => new Promise((r) => { setTimeout(r, 0); });

/**
 * Build a scheduler with `numWorkers` fake workers whose 'render' jobs stay pending until `releaseOne`.
 */
function harness(numWorkers) {
  const sched = new TessScheduler();
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
    const sched = new TessScheduler();
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
