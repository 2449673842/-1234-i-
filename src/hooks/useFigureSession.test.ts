import { describe, expect, it } from 'vitest';
import type { EditEntry, FigureSession, Manifest, PatchResponse } from '../schemas/manifest';
import {
  reconcileLocalPatchSuccess,
  responsePromotesLocalPatchToBackend,
} from './useFigureSession';

function makeManifest(color: string): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects: [{
      id: 'line.0',
      kind: 'line',
      label: 'Line',
      editable: ['color'],
      currentProps: { color },
    }],
    capabilities: {
      localPatch: true,
      backendPatch: true,
      codePatch: true,
    },
  };
}

function makeSession(overrides: Partial<FigureSession> = {}): FigureSession {
  return {
    sessionId: 'session-1',
    script: 'print("figure")',
    language: 'python',
    dataPayload: null,
    editLog: [],
    revision: 4,
    manifest: makeManifest('#111111'),
    svg: '<svg><path id="line.0" stroke="#111111"/></svg>',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function edit(mode: EditEntry['mode'], value: string): EditEntry {
  return {
    gid: 'line.0',
    prop: 'color',
    value,
    mode,
    timestamp: 2000,
  };
}

describe('standalone local patch reconciliation', () => {
  it('adopts server svg and manifest when a submitted local patch is promoted to backend_patch', () => {
    const optimisticSession = makeSession({
      manifest: makeManifest('#ff0000'),
      svg: '<svg><path id="line.0" stroke="#ff0000"/></svg>',
      revision: 5,
    });
    const authoritativeEditLog = [edit('backend_patch', '#00aa00')];
    const data: PatchResponse = {
      status: 'success',
      sessionId: 'session-1',
      applied: [{
        op: 'set',
        mode: 'backend_patch',
        gid: 'line.0',
        prop: 'color',
        value: '#00aa00',
      }],
      editLog: authoritativeEditLog,
      revision: 6,
      manifest: makeManifest('#00aa00'),
      svg: '<svg><path id="line.0" stroke="#00aa00"/></svg>',
    };

    const next = reconcileLocalPatchSuccess(optimisticSession, data, authoritativeEditLog, 1);

    expect(next.editLog).toBe(authoritativeEditLog);
    expect(next.revision).toBe(6);
    expect(next.svg).toBe(data.svg);
    expect(next.manifest).toBe(data.manifest);
  });

  it('keeps the optimistic svg and manifest for a fully-local acknowledgement', () => {
    const optimisticManifest = makeManifest('#ff0000');
    const optimisticSession = makeSession({
      manifest: optimisticManifest,
      svg: '<svg><path id="line.0" stroke="#ff0000"/></svg>',
      revision: 5,
    });
    const authoritativeEditLog = [edit('local_patch', '#ff0000')];
    const data: PatchResponse = {
      status: 'success',
      sessionId: 'session-1',
      applied: [{
        op: 'set',
        mode: 'local_patch',
        gid: 'line.0',
        prop: 'color',
        value: '#ff0000',
      }],
      editLog: authoritativeEditLog,
      revision: 6,
      manifest: makeManifest('#00aa00'),
      svg: '<svg><path id="line.0" stroke="#00aa00"/></svg>',
    };

    const next = reconcileLocalPatchSuccess(optimisticSession, data, authoritativeEditLog, 1);

    expect(next.editLog).toBe(authoritativeEditLog);
    expect(next.revision).toBe(6);
    expect(next.svg).toBe(optimisticSession.svg);
    expect(next.manifest).toBe(optimisticManifest);
  });

  it('detects backend promotion from the returned edit-log tail when applied is unavailable', () => {
    const data: PatchResponse = {
      status: 'success',
      sessionId: 'session-1',
      applied: [],
      editLog: [
        edit('local_patch', '#111111'),
        edit('backend_patch', '#00aa00'),
      ],
    };

    expect(responsePromotesLocalPatchToBackend(data, 1)).toBe(true);
  });
});
