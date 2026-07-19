import type { Manifest, ManifestObjectIdentity, PatchEntry } from '../schemas/manifest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import { cloneManifestIdentity } from './diagramIdentity';

function mergeCapturedIdentity(
  captured: ManifestObjectIdentity | undefined,
  current: ManifestObjectIdentity | undefined,
): ManifestObjectIdentity | undefined {
  // Existing identity is evidence captured with the draft. Backfilling it
  // from a newer manifest could hide structural or diagram-topology drift.
  return cloneManifestIdentity(captured ?? current);
}

function isOrdinaryObjectPatch(patch: PatchEntry): patch is Extract<PatchEntry, { op: 'set' }> {
  return !('type' in patch) && patch.gid !== 'global';
}

export function enrichPatchEntriesWithIdentity(
  patches: PatchEntry[],
  manifest: Manifest | null | undefined,
): PatchEntry[] {
  const objectsById = new Map((manifest?.objects ?? []).map(object => [object.id, object]));

  return patches.map((patch) => {
    if (!isOrdinaryObjectPatch(patch)) return patch;

    const object = objectsById.get(patch.gid);
    if (!object) return patch;
    const identity = mergeCapturedIdentity(patch.identity, object.identity);

    return {
      ...patch,
      ...(patch.stableKey === undefined && object.stableKey !== undefined
        ? { stableKey: object.stableKey }
        : {}),
      ...(patch.fingerprint === undefined && object.fingerprintVersion === 2
        ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
        : {}),
      ...(identity ? { identity } : {}),
    };
  });
}

export function enrichDraftPatchWithIdentity(
  patch: DraftPatch,
  manifest: Manifest | null | undefined,
): DraftPatch {
  if (patch.type === 'code_patch' || patch.gid === 'global') return patch;
  const object = manifest?.objects?.find(candidate => candidate.id === patch.gid);
  if (!object) return patch;
  const identity = mergeCapturedIdentity(patch.identity, object.identity);
  return {
    ...patch,
    ...(patch.stableKey === undefined && object.stableKey !== undefined
      ? { stableKey: object.stableKey }
      : {}),
    ...(patch.fingerprint === undefined && object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(identity ? { identity } : {}),
  };
}
