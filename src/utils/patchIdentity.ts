import type { Manifest, ManifestObjectIdentity, PatchEntry } from '../schemas/manifest';
import type { DraftPatch } from '../schemas/draftPatchBatch';

function cloneIdentity(identity: ManifestObjectIdentity | undefined): ManifestObjectIdentity | undefined {
  if (!identity) return undefined;
  const relation = identity.relation;
  return {
    ...identity,
    relation: relation ? {
      ...relation,
      subplotIds: relation.subplotIds ? [...relation.subplotIds] : undefined,
      layerIds: relation.layerIds ? [...relation.layerIds] : undefined,
      groupIds: relation.groupIds ? [...relation.groupIds] : undefined,
      legendTextIds: relation.legendTextIds ? [...relation.legendTextIds] : undefined,
      legendMarkerIds: relation.legendMarkerIds ? [...relation.legendMarkerIds] : undefined,
      mappableIds: relation.mappableIds ? [...relation.mappableIds] : undefined,
      twinSubplotIds: relation.twinSubplotIds ? [...relation.twinSubplotIds] : undefined,
      sharedXSubplotIds: relation.sharedXSubplotIds ? [...relation.sharedXSubplotIds] : undefined,
      sharedYSubplotIds: relation.sharedYSubplotIds ? [...relation.sharedYSubplotIds] : undefined,
    } : undefined,
  };
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

    return {
      ...patch,
      ...(patch.stableKey === undefined && object.stableKey !== undefined
        ? { stableKey: object.stableKey }
        : {}),
      ...(patch.fingerprint === undefined && object.fingerprintVersion === 2
        ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
        : {}),
      ...(patch.identity === undefined && object.identity
        ? { identity: cloneIdentity(object.identity) }
        : {}),
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
  return {
    ...patch,
    ...(patch.stableKey === undefined && object.stableKey !== undefined
      ? { stableKey: object.stableKey }
      : {}),
    ...(patch.fingerprint === undefined && object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(patch.identity === undefined && object.identity
      ? { identity: cloneIdentity(object.identity) }
      : {}),
  };
}
