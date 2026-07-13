export type DeploymentMode = 'accepting' | 'draining';

export type DeploymentJobKind = 'render' | 'export' | 'archive' | 'composition';

export type DeploymentDrainReason = 'deployment' | 'maintenance' | 'rollback' | 'manual';

export type DeploymentLifecycleSnapshot = {
  mode: DeploymentMode;
  acceptingNewJobs: boolean;
  modeChangedAt: string;
  drainReason: DeploymentDrainReason | null;
  activeJobsTotal: number;
  activeJobsByKind: Record<DeploymentJobKind, number>;
};

export type DeploymentJobLease = {
  accepted: true;
  finish: () => void;
} | {
  accepted: false;
};

const JOB_KINDS: DeploymentJobKind[] = ['render', 'export', 'archive', 'composition'];

function emptyJobCounts(): Record<DeploymentJobKind, number> {
  return {
    render: 0,
    export: 0,
    archive: 0,
    composition: 0,
  };
}

export class DeploymentLifecycle {
  private mode: DeploymentMode = 'accepting';
  private modeChangedAt = new Date().toISOString();
  private drainReason: DeploymentDrainReason | null = null;
  private readonly activeJobs = emptyJobCounts();
  private readonly idleWaiters = new Set<() => void>();

  setMode(mode: DeploymentMode, reason: DeploymentDrainReason = 'manual'): DeploymentLifecycleSnapshot {
    if (this.mode !== mode || (mode === 'draining' && this.drainReason !== reason)) {
      this.mode = mode;
      this.modeChangedAt = new Date().toISOString();
    }
    this.drainReason = mode === 'draining' ? reason : null;
    return this.snapshot();
  }

  tryStartJob(kind: DeploymentJobKind): DeploymentJobLease {
    if (this.mode !== 'accepting') return { accepted: false };
    this.activeJobs[kind] += 1;
    let finished = false;
    return {
      accepted: true,
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeJobs[kind] = Math.max(0, this.activeJobs[kind] - 1);
        if (this.activeJobCount() === 0) {
          for (const resolve of this.idleWaiters) resolve();
          this.idleWaiters.clear();
        }
      },
    };
  }

  snapshot(): DeploymentLifecycleSnapshot {
    return {
      mode: this.mode,
      acceptingNewJobs: this.mode === 'accepting',
      modeChangedAt: this.modeChangedAt,
      drainReason: this.drainReason,
      activeJobsTotal: this.activeJobCount(),
      activeJobsByKind: { ...this.activeJobs },
    };
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.activeJobCount() === 0) return Promise.resolve(true);
    const boundedTimeoutMs = Math.max(1, timeoutMs);
    return new Promise(resolve => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), boundedTimeoutMs);
      this.idleWaiters.add(onIdle);
    });
  }

  private activeJobCount(): number {
    return JOB_KINDS.reduce((total, kind) => total + this.activeJobs[kind], 0);
  }
}

type QueuedWork = {
  start: () => boolean;
  cancel: (reason: string) => void;
};

export class AbortableWorkQueue {
  private active = 0;
  private readonly queued: QueuedWork[] = [];

  constructor(private readonly concurrencyLimit: () => number) {}

  async run<T>(task: (queueMs: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queuedAt = Date.now();
    await this.acquire(signal);
    try {
      return await task(Math.max(0, Date.now() - queuedAt));
    } finally {
      this.release();
    }
  }

  snapshot(): { active: number; queued: number; concurrency: number } {
    return {
      active: this.active,
      queued: this.queued.length,
      concurrency: this.limit(),
    };
  }

  cancelQueued(reason: string): void {
    for (const entry of this.queued.splice(0)) entry.cancel(reason);
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Render request aborted while queued'));
    if (this.active < this.limit()) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const finish = (error?: Error): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        if (error) reject(error);
        else {
          this.active += 1;
          resolve();
        }
        return true;
      };
      const entry: QueuedWork = {
        start: () => finish(signal?.aborted ? new Error('Render request aborted while queued') : undefined),
        cancel: reason => { finish(new Error(reason)); },
      };
      const onAbort = () => {
        const index = this.queued.indexOf(entry);
        if (index >= 0) this.queued.splice(index, 1);
        entry.cancel('Render request aborted while queued');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queued.push(entry);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queued.length > 0) {
      if (this.queued.shift()!.start()) break;
    }
  }

  private limit(): number {
    const value = this.concurrencyLimit();
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  }
}
