import { describe, expect, it } from 'vitest';
import { resolveAuthoritativePatchOutcome } from './patchResponseReconciliation';

describe('resolveAuthoritativePatchOutcome', () => {
  it('uses a server-authoritative local mode even when the client requested backend rendering', () => {
    const outcome = resolveAuthoritativePatchOutcome(
      [{ gid: 'line.0.0', prop: 'color', value: '#336699', mode: 'backend_patch' }],
      [{ gid: 'line.0.0', prop: 'color', value: '#336699', mode: 'local_patch' }],
    );

    expect(outcome.needsBackendRender).toBe(false);
    expect(outcome.runtimeLocalPatches).toEqual([
      { gid: 'line.0.0', prop: 'color', value: '#336699' },
    ]);
  });

  it('does not downgrade a mixed authoritative batch to a local-only update', () => {
    const outcome = resolveAuthoritativePatchOutcome(
      [],
      [
        { gid: 'line.0.0', prop: 'color', value: '#336699', mode: 'local_patch' },
        { gid: 'title.0', prop: 'text', value: 'Updated', mode: 'backend_patch' },
      ],
    );

    expect(outcome.needsBackendRender).toBe(true);
    expect(outcome.runtimeLocalPatches).toEqual([
      { gid: 'line.0.0', prop: 'color', value: '#336699' },
    ]);
  });

  it('falls back to submitted modes for an older response without applied entries', () => {
    const outcome = resolveAuthoritativePatchOutcome(
      [{ gid: 'line.0.0', prop: 'linewidth', value: 2, mode: 'backend_patch' }],
      undefined,
    );

    expect(outcome.needsBackendRender).toBe(true);
    expect(outcome.runtimeLocalPatches).toEqual([]);
  });
});
