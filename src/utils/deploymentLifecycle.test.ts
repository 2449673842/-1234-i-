import { describe, expect, it, vi } from 'vitest';
import { AbortableWorkQueue, DeploymentLifecycle } from './deploymentLifecycle';

describe('DeploymentLifecycle', () => {
  it('tracks active jobs and releases each lease once', () => {
    const lifecycle = new DeploymentLifecycle();
    const render = lifecycle.tryStartJob('render');
    const exportJob = lifecycle.tryStartJob('export');

    expect(render.accepted).toBe(true);
    expect(exportJob.accepted).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({
      mode: 'accepting',
      activeJobsTotal: 2,
      activeJobsByKind: { render: 1, export: 1 },
    });

    if (render.accepted) {
      render.finish();
      render.finish();
    }
    if (exportJob.accepted) exportJob.finish();
    expect(lifecycle.snapshot().activeJobsTotal).toBe(0);
  });

  it('rejects new jobs while draining and resumes explicitly', () => {
    const lifecycle = new DeploymentLifecycle();
    lifecycle.setMode('draining', 'deployment');

    expect(lifecycle.tryStartJob('render')).toEqual({ accepted: false });
    expect(lifecycle.snapshot()).toMatchObject({
      mode: 'draining',
      acceptingNewJobs: false,
      drainReason: 'deployment',
      activeJobsTotal: 0,
    });

    lifecycle.setMode('accepting');
    expect(lifecycle.tryStartJob('render').accepted).toBe(true);
  });

  it('waits for existing jobs without waiting for rejected work', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new DeploymentLifecycle();
      const lease = lifecycle.tryStartJob('composition');
      lifecycle.setMode('draining', 'maintenance');
      const idle = lifecycle.waitForIdle(1_000);

      expect(lifecycle.tryStartJob('archive')).toEqual({ accepted: false });
      if (lease.accepted) lease.finish();
      await expect(idle).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when the graceful wait reaches its timeout', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new DeploymentLifecycle();
      lifecycle.tryStartJob('render');
      const idle = lifecycle.waitForIdle(500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(idle).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AbortableWorkQueue', () => {
  it('cancels queued work without starting it', async () => {
    let releaseFirst = () => {};
    let secondStarted = false;
    const queue = new AbortableWorkQueue(() => 1);
    const first = queue.run(() => new Promise<void>(resolve => { releaseFirst = resolve; }));
    const controller = new AbortController();
    const second = queue.run(async () => { secondStarted = true; }, controller.signal);

    await vi.waitFor(() => expect(queue.snapshot()).toMatchObject({ active: 1, queued: 1 }));
    controller.abort();
    await expect(second).rejects.toThrow('aborted while queued');
    expect(secondStarted).toBe(false);
    expect(queue.snapshot()).toMatchObject({ active: 1, queued: 0 });
    releaseFirst();
    await first;
  });

  it('starts the next queued task after the active task finishes', async () => {
    let releaseFirst = () => {};
    const order: string[] = [];
    const queue = new AbortableWorkQueue(() => 1);
    const first = queue.run(() => new Promise<void>(resolve => {
      order.push('first');
      releaseFirst = resolve;
    }));
    const second = queue.run(async () => { order.push('second'); });

    await vi.waitFor(() => expect(queue.snapshot().queued).toBe(1));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(queue.snapshot()).toMatchObject({ active: 0, queued: 0, concurrency: 1 });
  });

  it('cancels every queued task during forced shutdown', async () => {
    let releaseFirst = () => {};
    const queue = new AbortableWorkQueue(() => 1);
    const first = queue.run(() => new Promise<void>(resolve => { releaseFirst = resolve; }));
    const second = queue.run(async () => {});
    const third = queue.run(async () => {});

    await vi.waitFor(() => expect(queue.snapshot().queued).toBe(2));
    queue.cancelQueued('deployment shutdown');
    await expect(second).rejects.toThrow('deployment shutdown');
    await expect(third).rejects.toThrow('deployment shutdown');
    releaseFirst();
    await first;
  });
});
