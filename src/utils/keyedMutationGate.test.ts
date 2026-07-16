import { describe, expect, it } from 'vitest';
import { KeyedMutationGate } from './keyedMutationGate';

describe('KeyedMutationGate', () => {
  it('waits until the active mutation is released', async () => {
    const gate = new KeyedMutationGate();
    const release = gate.begin('figure-1');
    let settled = false;
    const waiting = gate.waitForIdle('figure-1', 1000).then(value => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await waiting).toBe(true);
    expect(gate.activeCount('figure-1')).toBe(0);
  });

  it('waits for every overlapping mutation and ignores duplicate release', async () => {
    const gate = new KeyedMutationGate();
    const releaseFirst = gate.begin('figure-1');
    const releaseSecond = gate.begin('figure-1');
    const waiting = gate.waitForIdle('figure-1', 1000);

    releaseFirst();
    releaseFirst();
    expect(gate.activeCount('figure-1')).toBe(1);
    releaseSecond();
    expect(await waiting).toBe(true);
  });

  it('times out without mutating the active count', async () => {
    const gate = new KeyedMutationGate();
    const release = gate.begin('figure-1');
    expect(await gate.waitForIdle('figure-1', 5)).toBe(false);
    expect(gate.activeCount('figure-1')).toBe(1);
    release();
  });

  it('blocks new mutations while existing work drains', async () => {
    const gate = new KeyedMutationGate();
    const releaseActive = gate.tryBegin('project-1');
    expect(releaseActive).not.toBeNull();
    const unblock = gate.tryBlock('project-1');
    expect(unblock).not.toBeNull();
    expect(gate.isBlocked('project-1')).toBe(true);
    expect(gate.tryBegin('project-1')).toBeNull();

    const waiting = gate.waitForIdle('project-1', 1000);
    releaseActive?.();
    expect(await waiting).toBe(true);
    expect(gate.tryBegin('project-1')).toBeNull();

    unblock?.();
    const releaseNext = gate.tryBegin('project-1');
    expect(releaseNext).not.toBeNull();
    releaseNext?.();
  });
});
