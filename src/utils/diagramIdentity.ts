import type { ManifestObjectIdentity, ManifestObjectRelation } from '../schemas/manifest';

export const DIAGRAM_RELATION_FIELDS = [
  'diagramId',
  'diagramType',
  'diagramObjectId',
  'nodeId',
  'edgeId',
  'sourceNodeId',
  'targetNodeId',
] as const satisfies readonly (keyof ManifestObjectRelation)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function relationFromIdentity(identity: unknown): Record<string, unknown> | null {
  if (!isRecord(identity) || !isRecord(identity.relation)) return null;
  return identity.relation;
}

export function hasDiagramRelation(identity: unknown): boolean {
  const relation = relationFromIdentity(identity);
  return Boolean(relation && DIAGRAM_RELATION_FIELDS.some(field => (
    Object.prototype.hasOwnProperty.call(relation, field)
  )));
}

/**
 * Canonical identity for the scientific relationship represented by a diagram
 * object. Fixed field order makes this safe to compare in both browser and
 * server code without changing the existing seriesKey compatibility contract.
 */
export function diagramRelationSignature(identity: unknown): string | null {
  const relation = relationFromIdentity(identity);
  if (!relation || !hasDiagramRelation(identity)) return null;

  return JSON.stringify(DIAGRAM_RELATION_FIELDS.map((field) => {
    if (!Object.prototype.hasOwnProperty.call(relation, field)) return null;
    const value = relation[field];
    return typeof value === 'string' && value.length > 0
      ? value
      : { invalid: true };
  }));
}

export function requiresDiagramRelationIdentity(object: unknown): boolean {
  if (!isRecord(object)) return false;
  return String(object.role || '').startsWith('diagram_')
    || hasDiagramRelation(object.identity);
}

export function cloneManifestIdentity(
  identity: ManifestObjectIdentity | undefined,
): ManifestObjectIdentity | undefined {
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
      arrowPatchIds: relation.arrowPatchIds ? [...relation.arrowPatchIds] : undefined,
    } : undefined,
  };
}
