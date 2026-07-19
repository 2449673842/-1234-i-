import type {
  Manifest,
  ManifestObject,
  ManifestPropertyCapability,
} from '../schemas/manifest';

export type ManifestIdentityIssueCode =
  | 'duplicate_instance_key'
  | 'capability_prop_not_editable'
  | 'duplicate_capability_prop'
  | 'subplot_relation_conflict'
  | 'unknown_relation_target';

export interface ManifestIdentityIssue {
  level: 'warning' | 'error';
  code: ManifestIdentityIssueCode;
  objectId: string;
  detail: string;
}

export interface ManifestIdentityValidationReport {
  objectCount: number;
  objectsWithIdentity: number;
  objectsWithCapabilities: number;
  identityCoverage: number;
  capabilityCoverage: number;
  duplicateInstanceKeys: string[];
  issues: ManifestIdentityIssue[];
  shadowReady: boolean;
}

export interface ManifestIdentityComparison {
  previousCount: number;
  nextCount: number;
  retainedInstanceKeys: string[];
  missingInstanceKeys: string[];
  addedInstanceKeys: string[];
  retentionRate: number;
}

function uniqueCapabilities(capabilities: ManifestPropertyCapability[] | undefined): string[] {
  if (!Array.isArray(capabilities)) return [];
  return capabilities.map(capability => capability.prop).filter(Boolean);
}

function relationTargetIds(object: ManifestObject): string[] {
  const relation = object.identity?.relation;
  if (!relation) return [];
  return [
    relation.parentId,
    relation.subplotId,
    ...(relation.subplotIds ?? []),
    relation.layerId,
    ...(relation.layerIds ?? []),
    ...(relation.groupIds ?? []),
    relation.guideId,
    relation.legendId,
    relation.legendTitleId,
    relation.legendTextId,
    ...(relation.legendTextIds ?? []),
    ...(relation.legendMarkerIds ?? []),
    relation.colorbarId,
    relation.mappableId,
    ...(relation.mappableIds ?? []),
    relation.annotationId,
    relation.arrowId,
    relation.textId,
    relation.pieSliceId,
    relation.pieLabelId,
    relation.pieValueLabelId,
    relation.lineCollectionId,
    ...(relation.arrowPatchIds ?? []),
    relation.streamplotId,
    ...(relation.twinSubplotIds ?? []),
    ...(relation.sharedXSubplotIds ?? []),
    ...(relation.sharedYSubplotIds ?? []),
  ].filter((value): value is string => Boolean(value));
}

export function validateManifestIdentity(manifest: Manifest): ManifestIdentityValidationReport {
  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  const objectIds = new Set(objects.map(object => object.id));
  const instanceOwners = new Map<string, string[]>();
  const issues: ManifestIdentityIssue[] = [];
  let objectsWithIdentity = 0;
  let objectsWithCapabilities = 0;

  objects.forEach((object) => {
    const identity = object.identity;
    if (identity?.instanceKey) {
      objectsWithIdentity += 1;
      const owners = instanceOwners.get(identity.instanceKey) ?? [];
      owners.push(object.id);
      instanceOwners.set(identity.instanceKey, owners);
    }

    const capabilityProps = uniqueCapabilities(object.propertyCapabilities);
    if (capabilityProps.length > 0) {
      objectsWithCapabilities += 1;
      const seen = new Set<string>();
      capabilityProps.forEach((prop) => {
        if (seen.has(prop)) {
          issues.push({
            level: 'error',
            code: 'duplicate_capability_prop',
            objectId: object.id,
            detail: `${object.id} declares ${prop} more than once.`,
          });
        }
        seen.add(prop);
        if (!object.editable.includes(prop)) {
          issues.push({
            level: 'warning',
            code: 'capability_prop_not_editable',
            objectId: object.id,
            detail: `${object.id}.${prop} is declared as a capability but is absent from editable.`,
          });
        }
      });
    }

    const relationSubplotId = identity?.relation?.subplotId;
    const relationSubplotIds = identity?.relation?.subplotIds ?? [];
    if (relationSubplotId && object.subplotId && relationSubplotId !== object.subplotId) {
      issues.push({
        level: 'error',
        code: 'subplot_relation_conflict',
        objectId: object.id,
        detail: `${object.id} declares subplot ${object.subplotId} but identity relation points to ${relationSubplotId}.`,
      });
    }
    if (relationSubplotIds.length > 0) {
      const uniqueSubplotIds = new Set(relationSubplotIds);
      const declaredObjectSubplots = object.subplotIds ?? [];
      if (
        uniqueSubplotIds.size !== relationSubplotIds.length
        || (relationSubplotId && !uniqueSubplotIds.has(relationSubplotId))
        || (object.subplotId && !uniqueSubplotIds.has(object.subplotId))
        || (declaredObjectSubplots.length > 0
          && (declaredObjectSubplots.length !== uniqueSubplotIds.size
            || declaredObjectSubplots.some(subplotId => !uniqueSubplotIds.has(subplotId))))
      ) {
        issues.push({
          level: 'error',
          code: 'subplot_relation_conflict',
          objectId: object.id,
          detail: `${object.id} declares inconsistent shared subplot relationships.`,
        });
      }
    }

    relationTargetIds(object).forEach((targetId) => {
      if (targetId === object.id || objectIds.has(targetId)) return;
      issues.push({
        level: 'warning',
        code: 'unknown_relation_target',
        objectId: object.id,
        detail: `${object.id} references missing relation target ${targetId}.`,
      });
    });
  });

  const duplicateInstanceKeys = Array.from(instanceOwners.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([instanceKey, owners]) => {
      owners.forEach((objectId) => issues.push({
        level: 'error',
        code: 'duplicate_instance_key',
        objectId,
        detail: `${instanceKey} is shared by ${owners.join(', ')}.`,
      }));
      return instanceKey;
    });

  const objectCount = objects.length;
  const identityCoverage = objectCount > 0 ? objectsWithIdentity / objectCount : 1;
  const capabilityCoverage = objectCount > 0 ? objectsWithCapabilities / objectCount : 1;

  return {
    objectCount,
    objectsWithIdentity,
    objectsWithCapabilities,
    identityCoverage,
    capabilityCoverage,
    duplicateInstanceKeys,
    issues,
    shadowReady: objectCount > 0
      && identityCoverage === 1
      && duplicateInstanceKeys.length === 0
      && !issues.some(issue => issue.level === 'error'),
  };
}

function instanceKeySet(manifest: Manifest): Set<string> {
  return new Set(
    (manifest.objects ?? [])
      .map(object => object.identity?.instanceKey)
      .filter((value): value is string => Boolean(value)),
  );
}

export function compareManifestIdentity(
  previousManifest: Manifest,
  nextManifest: Manifest,
): ManifestIdentityComparison {
  const previous = instanceKeySet(previousManifest);
  const next = instanceKeySet(nextManifest);
  const retainedInstanceKeys = Array.from(previous).filter(key => next.has(key)).sort();
  const missingInstanceKeys = Array.from(previous).filter(key => !next.has(key)).sort();
  const addedInstanceKeys = Array.from(next).filter(key => !previous.has(key)).sort();

  return {
    previousCount: previous.size,
    nextCount: next.size,
    retainedInstanceKeys,
    missingInstanceKeys,
    addedInstanceKeys,
    retentionRate: previous.size > 0 ? retainedInstanceKeys.length / previous.size : 1,
  };
}
