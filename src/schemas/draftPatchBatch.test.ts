import { describe, expect, it } from 'vitest';
import { draftPatchStorageKey } from './draftPatchBatch';

describe('draft patch storage key', () => {
  it('preserves the legacy key for ordinary drafts', () => {
    expect(draftPatchStorageKey({ gid: 'line.0', prop: 'color' })).toBe('line.0:color');
  });

  it('keeps mixed-color subset drafts independent by normalized source color', () => {
    expect(draftPatchStorageKey({
      gid: 'collection.0',
      prop: 'facecolor',
      matchColor: '#0F3CF0',
    })).toBe('collection.0:facecolor:match:#0f3cf0');
  });
});
