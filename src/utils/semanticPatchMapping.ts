import type { Manifest, ManifestObject } from '../schemas/manifest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import { propertyCapabilityFor, resolvePatchMode } from './propertyPatchMode';

type PatchLike = DraftPatch | {
  gid?: string;
  prop?: string;
  mode?: string;
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObject['identity'];
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

const PIE_RELATION_ROLES = new Set([
  'pie_slice',
  'pie_label',
  'pie_value_label',
  'legend_marker',
]);

const VECTOR_FIELD_RELATION_BY_ROLE: Record<string, 'quiverId' | 'streamplotId'> = {
  quiver_field: 'quiverId',
  streamplot_field: 'streamplotId',
};

function vectorFieldRelation(object: ManifestObject): {
  field: 'quiverId' | 'streamplotId';
  value: string;
} | null {
  const roleField = VECTOR_FIELD_RELATION_BY_ROLE[String(object.role)];
  const relation = object.identity?.relation;
  const field = roleField
    || (typeof relation?.quiverId === 'string' ? 'quiverId' : undefined)
    || (typeof relation?.streamplotId === 'string' ? 'streamplotId' : undefined);
  const value = field ? relation?.[field] : undefined;
  return field && typeof value === 'string' ? { field, value } : null;
}

function isVectorFieldRelationCompatible(source: ManifestObject, target: ManifestObject): boolean {
  const sourceRelation = vectorFieldRelation(source);
  const targetRelation = vectorFieldRelation(target);
  if (!sourceRelation && !targetRelation) return true;
  return Boolean(
    sourceRelation
    && targetRelation
    && sourceRelation.field === targetRelation.field
    && sourceRelation.value === targetRelation.value,
  );
}

function isPieRelationCompatible(source: ManifestObject, target: ManifestObject): boolean {
  if (!PIE_RELATION_ROLES.has(String(source.role)) || !PIE_RELATION_ROLES.has(String(target.role))) {
    return true;
  }

  const sourceRelation = source.identity?.relation;
  const targetRelation = target.identity?.relation;
  const sourceIsPieSpecific = source.role !== 'legend_marker'
    || Boolean(sourceRelation?.pieId)
    || typeof sourceRelation?.sliceIndex === 'number';
  const targetIsPieSpecific = target.role !== 'legend_marker'
    || Boolean(targetRelation?.pieId)
    || typeof targetRelation?.sliceIndex === 'number';
  if (!sourceIsPieSpecific && !targetIsPieSpecific) return true;
  if (!sourceRelation?.pieId || !targetRelation?.pieId) return false;
  if (typeof sourceRelation.sliceIndex !== 'number' || typeof targetRelation.sliceIndex !== 'number') {
    return false;
  }
  return sourceRelation.pieId === targetRelation.pieId
    && sourceRelation.sliceIndex === targetRelation.sliceIndex;
}

function isExactTargetCompatible(source: ManifestObject, target: ManifestObject): boolean {
  if (source.role && target.role && source.role !== target.role) return false;
  if (source.subplotId && target.subplotId && source.subplotId !== target.subplotId) return false;
  if (source.kind !== target.kind && (!source.role || source.role !== target.role)) return false;
  return isPieRelationCompatible(source, target)
    && isVectorFieldRelationCompatible(source, target);
}

function scoreSemanticMatch(source: ManifestObject, target: ManifestObject, prop: string | undefined): number {
  if (!supportsProp(target, prop)) return -1;
  if (source.role && target.role && source.role !== target.role) return -1;
  if (!isPieRelationCompatible(source, target)) return -1;
  if (!isVectorFieldRelationCompatible(source, target)) return -1;

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

  if (PIE_RELATION_ROLES.has(String(source.role)) && PIE_RELATION_ROLES.has(String(target.role))) {
    const sourceRelation = source.identity?.relation;
    const targetRelation = target.identity?.relation;
    if (sourceRelation?.pieId && sourceRelation.pieId === targetRelation?.pieId) score += 120;
    if (
      typeof sourceRelation?.sliceIndex === 'number'
      && sourceRelation.sliceIndex === targetRelation?.sliceIndex
    ) score += 100;
  }

  const sourceVectorRelation = vectorFieldRelation(source);
  const targetVectorRelation = vectorFieldRelation(target);
  if (
    sourceVectorRelation
    && targetVectorRelation
    && sourceVectorRelation.field === targetVectorRelation.field
    && sourceVectorRelation.value === targetVectorRelation.value
  ) {
    score += 120;
  }

  return score;
}

function mapPatchToObject(
  patch: PatchLike,
  targetManifest: Manifest | null | undefined,
  target: ManifestObject,
): PatchLike {
  const {
    stableKey: _sourceStableKey,
    fingerprint: _sourceFingerprint,
    fingerprintVersion: _sourceFingerprintVersion,
    identity: _sourceIdentity,
    ...patchWithoutSourceIdentity
  } = patch;
  return {
    ...patchWithoutSourceIdentity,
    gid: target.id,
    mode: resolvePatchMode(targetManifest, target, patch.prop || ''),
    ...(target.stableKey ? { stableKey: target.stableKey } : {}),
    ...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
    ...(typeof target.fingerprintVersion === 'number' ? { fingerprintVersion: target.fingerprintVersion } : {}),
    ...(target.identity ? { identity: target.identity } : {}),
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
  const exactTarget = targetObjects.find(object => (
    object.id === patch.gid
    && supportsProp(object, patch.prop)
    && isExactTargetCompatible(sourceObject, object)
  ));
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
