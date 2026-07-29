import type { Manifest, ManifestObject } from '../schemas/manifest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import { propertyCapabilityFor, resolvePatchMode } from './propertyPatchMode';

type PatchLike = DraftPatch | {
  gid?: string;
  prop?: string;
  mode?: string;
  type?: string;
  target_id?: string;
  new_value?: unknown;
  gids?: string[];
  value?: unknown;
};

function objectList(manifest: Manifest | null | undefined): ManifestObject[] {
  return Array.isArray(manifest?.objects) ? manifest.objects : [];
}

function supportsProp(object: ManifestObject, prop: string | undefined): boolean {
  if (!prop) return true;
  const capability = propertyCapabilityFor(object, prop);
  if (capability) return capability.replay !== 'unsupported';
  if (Array.isArray(object.propertyCapabilities)) return false;
  const unsupported = object.currentProps?.unsupportedProps;
  if (Array.isArray(unsupported) && unsupported.map(String).includes(prop)) return false;
  return Array.isArray(object.editable) && object.editable.includes(prop);
}

function findSourceObject(sourceManifest: Manifest | null | undefined, gid: string | undefined) {
  if (!gid) return null;
  return objectList(sourceManifest).find(object => object.id === gid) || null;
}

function scoreSemanticMatch(source: ManifestObject, target: ManifestObject, prop: string | undefined): number {
  if (!supportsProp(target, prop)) return -1;

  let score = 0;
  if (source.identity?.instanceKey && source.identity.instanceKey === target.identity?.instanceKey) score += 140;
  if (source.stableKey && target.stableKey && source.stableKey === target.stableKey) score += 100;
  if (source.identity?.seriesKey && source.identity.seriesKey === target.identity?.seriesKey) score += 80;
  if (source.identity?.semanticKey && source.identity.semanticKey === target.identity?.semanticKey) score += 60;
  if (source.role && target.role && source.role === target.role) score += 40;
  if (source.kind === target.kind) score += 30;
  if (source.subplotId && target.subplotId && source.subplotId === target.subplotId) score += 20;
  if (source.parentId && target.parentId && source.parentId === target.parentId) score += 5;
  if (source.label && target.label && source.label === target.label) score += 3;

  return score;
}

function mapPatchToObject(
  patch: PatchLike,
  targetManifest: Manifest | null | undefined,
  target: ManifestObject,
): PatchLike {
  return {
    ...patch,
    gid: target.id,
    mode: resolvePatchMode(targetManifest, target, patch.prop || ''),
  };
}

export function mapPatchToTargetFigure(
  patch: PatchLike,
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
): PatchLike | null {
  if (patch.type === 'code_patch' || patch.gid === 'code_patch') {
    return null;
  }

  const sourceObject = findSourceObject(sourceManifest, patch.gid);
  if (!sourceObject) return null;

  const targetObjects = objectList(targetManifest);
  const exactTarget = targetObjects.find(object => object.id === patch.gid && supportsProp(object, patch.prop));
  if (exactTarget) {
    return mapPatchToObject(patch, targetManifest, exactTarget);
  }

  const candidates = targetObjects
    .map(object => ({ object, score: scoreSemanticMatch(sourceObject, object, patch.prop) }))
    .filter(candidate => candidate.score >= 50);
  if (candidates.length === 0) return null;
  const bestScore = Math.max(...candidates.map(candidate => candidate.score));
  const best = candidates.filter(candidate => candidate.score === bestScore);
  return best.length === 1
    ? mapPatchToObject(patch, targetManifest, best[0].object)
    : null;
}

export function mapPatchToTargetFigureMany(
  patch: PatchLike,
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
): PatchLike[] {
  if (patch.type === 'code_patch' || patch.gid === 'code_patch') {
    return [];
  }

  const sourceObject = findSourceObject(sourceManifest, patch.gid);
  if (!sourceObject) return [];

  const mapped = mapPatchToTargetFigure(patch, sourceManifest, targetManifest);
  return mapped ? [mapped] : [];
}

export function mapPatchesToTargetFigure(
  patches: PatchLike[],
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
): { patches: PatchLike[]; skipped: PatchLike[] } {
  const mapped: PatchLike[] = [];
  const skipped: PatchLike[] = [];

  for (const patch of patches) {
    const next = mapPatchToTargetFigureMany(patch, sourceManifest, targetManifest);
    if (next.length > 0) {
      mapped.push(...next);
    } else {
      skipped.push(patch);
    }
  }

  return { patches: mapped, skipped };
}
