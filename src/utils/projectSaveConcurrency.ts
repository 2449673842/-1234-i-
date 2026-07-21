import type { DraftPatch } from '../schemas/draftPatchBatch';
import { draftPatchStorageKey } from '../schemas/draftPatchBatch';
import { stableStringify } from './stableJson';

type DraftBuckets = Record<string, Record<string, DraftPatch>>;

function matchesPersistedDraft(current: DraftPatch | undefined, persisted: DraftPatch): boolean {
  if (!current) return false;
  return current.gid === persisted.gid
    && current.prop === persisted.prop
    && current.mode === persisted.mode
    && current.matchColor === persisted.matchColor
    && current.type === persisted.type
    && current.target_id === persisted.target_id
    && stableStringify(current.value) === stableStringify(persisted.value)
    && stableStringify(current.new_value) === stableStringify(persisted.new_value)
    && stableStringify(current.gids) === stableStringify(persisted.gids);
}

export function removeMatchingPersistedDrafts(
  currentDrafts: DraftBuckets,
  persistedByFigure: Record<string, DraftPatch[]>,
  storageKey: (patch: DraftPatch) => string = draftPatchStorageKey,
): DraftBuckets {
  const next = { ...currentDrafts };
  Object.entries(persistedByFigure).forEach(([figureId, persistedDrafts]) => {
    const bucket = { ...(next[figureId] || {}) };
    persistedDrafts.forEach(persisted => {
      const key = storageKey(persisted);
      if (matchesPersistedDraft(bucket[key], persisted)) {
        delete bucket[key];
      }
    });
    if (Object.keys(bucket).length > 0) {
      next[figureId] = bucket;
    } else {
      delete next[figureId];
    }
  });
  return next;
}
