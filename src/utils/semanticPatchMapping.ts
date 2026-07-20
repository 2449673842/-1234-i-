import type { Manifest, ManifestObject } from '../schemas/manifest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import { resolvePatchMode, supportsObjectProp } from './propertyPatchMode';
import {
  requiresSpecialAxesRelationIdentity,
  specialAxesRelationSignature,
} from './specialAxesIdentity';
import { EDITING_FEATURE_FLAGS } from './editingFeatureFlags';

export interface CrossFigureMappingOptions {
  identityV2Enabled?: boolean;
  legacyScoreAdapterEnabled?: boolean;
}

interface ResolvedCrossFigureMappingOptions {
  identityV2Enabled: boolean;
  legacyScoreAdapterEnabled: boolean;
}

type IdentityTargetResolution =
  | { status: 'matched'; object: ManifestObject }
  | { status: 'ambiguous' }
  | { status: 'conflict' }
  | { status: 'not_found' };

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
  return supportsObjectProp(object, prop);
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

const DIAGRAM_RELATION_ROLES = new Set([
  'diagram_node',
  'diagram_edge',
  'diagram_arrow',
  'diagram_node_label',
  'diagram_coefficient_label',
  'diagram_fit_annotation',
  'diagram_group',
]);

const DIAGRAM_REQUIRED_RELATION_FIELDS_BY_ROLE: Record<string, Array<keyof NonNullable<ManifestObject['identity']>['relation']>> = {
  diagram_node: ['nodeId'],
  diagram_edge: ['edgeId', 'sourceNodeId', 'targetNodeId'],
  diagram_arrow: ['edgeId', 'sourceNodeId', 'targetNodeId'],
  diagram_node_label: ['nodeId'],
  diagram_coefficient_label: ['edgeId'],
  diagram_fit_annotation: [],
  diagram_group: [],
};

function isDiagramRelationCompatible(source: ManifestObject, target: ManifestObject): boolean {
  const sourceRole = String(source.role || '');
  const targetRole = String(target.role || '');
  const sourceIsDiagram = DIAGRAM_RELATION_ROLES.has(sourceRole);
  const targetIsDiagram = DIAGRAM_RELATION_ROLES.has(targetRole);
  if (!sourceIsDiagram && !targetIsDiagram) return true;
  if (!sourceIsDiagram || !targetIsDiagram || sourceRole !== targetRole) return false;

  const sourceRelation = source.identity?.relation;
  const targetRelation = target.identity?.relation;
  const requiredFields: Array<keyof NonNullable<ManifestObject['identity']>['relation']> = [
    'diagramId',
    'diagramType',
    'diagramObjectId',
    ...(DIAGRAM_REQUIRED_RELATION_FIELDS_BY_ROLE[sourceRole] || []),
  ];
  return requiredFields.every((field) => {
    const sourceValue = sourceRelation?.[field];
    const targetValue = targetRelation?.[field];
    return typeof sourceValue === 'string'
      && sourceValue.length > 0
      && sourceValue === targetValue;
  });
}

function hasUniqueDiagramRelationTarget(
  source: ManifestObject,
  targets: ManifestObject[],
  prop: string | undefined,
): boolean {
  if (!DIAGRAM_RELATION_ROLES.has(String(source.role))) return true;
  return targets.filter(target => (
    supportsProp(target, prop)
    && isDiagramRelationCompatible(source, target)
  )).length === 1;
}

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

function isSpecialAxesRelationCompatible(source: ManifestObject, target: ManifestObject): boolean {
  const sourceRequires = requiresSpecialAxesRelationIdentity(source);
  const targetRequires = requiresSpecialAxesRelationIdentity(target);
  if (!sourceRequires && !targetRequires) return true;
  if (!sourceRequires || !targetRequires) return false;
  const sourceSignature = specialAxesRelationSignature(source.identity);
  const targetSignature = specialAxesRelationSignature(target.identity);
  return sourceSignature !== null && sourceSignature === targetSignature;
}

function isExactTargetCompatible(source: ManifestObject, target: ManifestObject): boolean {
  if (source.role && target.role && source.role !== target.role) return false;
  if (source.subplotId && target.subplotId && source.subplotId !== target.subplotId) return false;
  if (source.kind !== target.kind && (!source.role || source.role !== target.role)) return false;
  return isPieRelationCompatible(source, target)
    && isVectorFieldRelationCompatible(source, target)
    && isDiagramRelationCompatible(source, target)
    && isSpecialAxesRelationCompatible(source, target);
}

function hasAuthoritativeRelationIdentity(object: ManifestObject): boolean {
  const relation = object.identity?.relation;
  const hasPieIdentity = PIE_RELATION_ROLES.has(String(object.role))
    && typeof relation?.pieId === 'string'
    && typeof relation?.sliceIndex === 'number';
  return hasPieIdentity
    || vectorFieldRelation(object) !== null
    || DIAGRAM_RELATION_ROLES.has(String(object.role))
    || (
      requiresSpecialAxesRelationIdentity(object)
      && specialAxesRelationSignature(object.identity) !== null
    );
}

function hasModernIdentity(object: ManifestObject): boolean {
  return object.fingerprintVersion === 2 && Boolean(object.identity);
}

function hasMatchingStableIdentity(source: ManifestObject, target: ManifestObject): boolean {
  const credentials = [
    [source.identity?.instanceKey, target.identity?.instanceKey],
    [source.stableKey, target.stableKey],
    [source.identity?.seriesKey, target.identity?.seriesKey],
    [source.identity?.semanticKey, target.identity?.semanticKey],
  ] as const;
  let matched = false;
  for (const [sourceValue, targetValue] of credentials) {
    if (!sourceValue) continue;
    if (!targetValue || sourceValue !== targetValue) return false;
    matched = true;
  }
  return matched;
}

function hasMatchingRemapIdentity(source: ManifestObject, target: ManifestObject): boolean {
  const stableCredentials = [
    [source.stableKey, target.stableKey],
    [source.identity?.seriesKey, target.identity?.seriesKey],
    [source.identity?.semanticKey, target.identity?.semanticKey],
  ] as const;
  let matched = Boolean(
    source.identity?.instanceKey
    && source.identity.instanceKey === target.identity?.instanceKey,
  );
  for (const [sourceValue, targetValue] of stableCredentials) {
    if (!sourceValue) continue;
    if (!targetValue || sourceValue !== targetValue) return false;
    matched = true;
  }
  return matched;
}

function hasAnyIdentityCredentialMatch(source: ManifestObject, target: ManifestObject): boolean {
  return Boolean(
    (source.identity?.instanceKey && source.identity.instanceKey === target.identity?.instanceKey)
    || (source.stableKey && source.stableKey === target.stableKey)
    || (source.identity?.seriesKey && source.identity.seriesKey === target.identity?.seriesKey)
    || (source.identity?.semanticKey && source.identity.semanticKey === target.identity?.semanticKey),
  );
}

function isModernExactTargetCompatible(source: ManifestObject, target: ManifestObject): boolean {
  if (!hasModernIdentity(source) || !hasModernIdentity(target)) return true;
  if (hasAuthoritativeRelationIdentity(source) || hasAuthoritativeRelationIdentity(target)) {
    return isExactTargetCompatible(source, target);
  }
  return hasMatchingStableIdentity(source, target);
}

function isModernIdentityRemapCompatible(source: ManifestObject, target: ManifestObject): boolean {
  if (!hasModernIdentity(source) || !hasModernIdentity(target)) return true;
  if (hasAuthoritativeRelationIdentity(source) || hasAuthoritativeRelationIdentity(target)) {
    return isExactTargetCompatible(source, target);
  }
  return hasMatchingRemapIdentity(source, target);
}

function resolveCrossFigureMappingOptions(
  options: CrossFigureMappingOptions = {},
): ResolvedCrossFigureMappingOptions {
  return {
    identityV2Enabled: options.identityV2Enabled
      ?? EDITING_FEATURE_FLAGS.crossFigureIdentityV2,
    legacyScoreAdapterEnabled: options.legacyScoreAdapterEnabled
      ?? EDITING_FEATURE_FLAGS.crossFigureLegacyScoreAdapter,
  };
}

function resolveIdentityTarget(
  source: ManifestObject,
  targets: ManifestObject[],
  prop: string | undefined,
): IdentityTargetResolution {
  const relationCompatible = targets.filter(target => (
    supportsProp(target, prop)
    && isExactTargetCompatible(source, target)
  ));
  const conflictingModernTarget = relationCompatible.some(target => (
    hasModernIdentity(source)
    && hasModernIdentity(target)
    && hasAnyIdentityCredentialMatch(source, target)
    && !isModernIdentityRemapCompatible(source, target)
  ));
  const compatible = relationCompatible.filter(target => (
    isModernIdentityRemapCompatible(source, target)
  ));
  if (hasAuthoritativeRelationIdentity(source)) {
    if (compatible.length === 1) return { status: 'matched', object: compatible[0] };
    if (compatible.length > 1) return { status: 'ambiguous' };
  }
  const matchers: Array<(target: ManifestObject) => boolean> = [];

  if (source.identity?.instanceKey) {
    matchers.push(target => target.identity?.instanceKey === source.identity?.instanceKey);
  }
  if (source.stableKey) {
    matchers.push(target => target.stableKey === source.stableKey);
  }
  if (source.identity?.seriesKey) {
    matchers.push(target => target.identity?.seriesKey === source.identity?.seriesKey);
  }
  if (source.identity?.semanticKey) {
    matchers.push(target => target.identity?.semanticKey === source.identity?.semanticKey);
  }

  for (const matches of matchers) {
    const candidates = compatible.filter(matches);
    if (candidates.length === 1) return { status: 'matched', object: candidates[0] };
    if (candidates.length > 1) return { status: 'ambiguous' };
  }
  if (conflictingModernTarget) return { status: 'conflict' };
  return { status: 'not_found' };
}

function scoreSemanticMatch(source: ManifestObject, target: ManifestObject, prop: string | undefined): number {
  if (!supportsProp(target, prop)) return -1;
  if (source.role && target.role && source.role !== target.role) return -1;
  if (!isPieRelationCompatible(source, target)) return -1;
  if (!isVectorFieldRelationCompatible(source, target)) return -1;
  if (!isDiagramRelationCompatible(source, target)) return -1;
  if (!isSpecialAxesRelationCompatible(source, target)) return -1;

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

  if (DIAGRAM_RELATION_ROLES.has(String(source.role))) {
    score += 240;
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
  options: CrossFigureMappingOptions = {},
): PatchLike | null {
  if (patch.type === 'code_patch' || patch.gid === 'code_patch') {
    return null;
  }

  const sourceObject = findSourceObject(sourceManifest, patch.gid);
  if (!sourceObject) return null;

  const targetObjects = objectList(targetManifest);
  if (!hasUniqueDiagramRelationTarget(sourceObject, targetObjects, patch.prop)) return null;
  const resolvedOptions = resolveCrossFigureMappingOptions(options);
  const exactTarget = targetObjects.find(object => (
    object.id === patch.gid
    && supportsProp(object, patch.prop)
    && isExactTargetCompatible(sourceObject, object)
  ));
  if (exactTarget) {
    if (
      resolvedOptions.identityV2Enabled
      && !isModernExactTargetCompatible(sourceObject, exactTarget)
    ) {
      return null;
    }
    return mapPatchToObject(patch, targetManifest, exactTarget);
  }

  if (resolvedOptions.identityV2Enabled) {
    const identityTarget = resolveIdentityTarget(sourceObject, targetObjects, patch.prop);
    if (identityTarget.status === 'matched') {
      return mapPatchToObject(patch, targetManifest, identityTarget.object);
    }
    if (
      identityTarget.status === 'ambiguous'
      || identityTarget.status === 'conflict'
      || !resolvedOptions.legacyScoreAdapterEnabled
    ) {
      return null;
    }
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
  options: CrossFigureMappingOptions = {},
): PatchLike[] {
  if (patch.type === 'code_patch' || patch.gid === 'code_patch') {
    return [];
  }

  const sourceObject = findSourceObject(sourceManifest, patch.gid);
  if (!sourceObject) return [];

  const mapped = mapPatchToTargetFigure(patch, sourceManifest, targetManifest, options);
  return mapped ? [mapped] : [];
}

export function mapPatchesToTargetFigure(
  patches: PatchLike[],
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
  options: CrossFigureMappingOptions = {},
): { patches: PatchLike[]; skipped: PatchLike[] } {
  const mapped: PatchLike[] = [];
  const skipped: PatchLike[] = [];

  for (const patch of patches) {
    const next = mapPatchToTargetFigureMany(patch, sourceManifest, targetManifest, options);
    if (next.length > 0) {
      mapped.push(...next);
    } else {
      skipped.push(patch);
    }
  }

  return { patches: mapped, skipped };
}
