import { describe, expect, it } from 'vitest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import { removeMatchingPersistedDrafts } from './projectSaveConcurrency';

function draft(value: string): DraftPatch {
  return {
    gid: 'line.0.0',
    prop: 'color',
    value,
    mode: 'local_patch',
  };
}

describe('project save concurrency', () => {
  it('keeps a newer draft created while an older value is being saved', () => {
    const current = { fig_1: { 'line.0.0:color': draft('#2255cc') } };
    const persisted = { fig_1: [draft('#aa3377')] };

    expect(removeMatchingPersistedDrafts(current, persisted)).toEqual(current);
  });

  it('removes only the exact draft value confirmed by the server', () => {
    const current = {
      fig_1: {
        'line.0.0:color': draft('#aa3377'),
        'line.0.1:color': { ...draft('#119966'), gid: 'line.0.1' },
      },
    };
    const persisted = { fig_1: [draft('#aa3377')] };

    expect(removeMatchingPersistedDrafts(current, persisted)).toEqual({
      fig_1: {
        'line.0.1:color': { ...draft('#119966'), gid: 'line.0.1' },
      },
    });
  });

  it('uses the supplied storage key so color-subset drafts do not collide', () => {
    const first = { ...draft('#aa3377'), matchColor: '#112233' };
    const second = { ...draft('#2255cc'), matchColor: '#445566' };
    const storageKey = (patch: DraftPatch) => (
      `${patch.gid}:${patch.prop}:match:${String(patch.matchColor).toLowerCase()}`
    );
    const current = {
      fig_1: {
        [storageKey(first)]: first,
        [storageKey(second)]: second,
      },
    };

    expect(removeMatchingPersistedDrafts(current, { fig_1: [first] }, storageKey)).toEqual({
      fig_1: {
        [storageKey(second)]: second,
      },
    });
  });
});
