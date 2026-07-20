import type { ManifestObjectRelation } from '../schemas/manifest';

export const SPECIAL_AXES_RELATION_FIELDS = [
  'axesFamily',
  'projection',
  'parentSubplotId',
  'ownerSubplotId',
] as const satisfies readonly (keyof ManifestObjectRelation)[];

const SPECIAL_AXES_KINDS = new Set([
  'polar_subplot',
  'three_d_subplot',
  'inset_subplot',
  'geo_subplot',
  'parasite_subplot',
  'parasite_axis',
  'secondary_xaxis',
  'secondary_yaxis',
  'unsupported_axes',
  'brokenaxes_group',
]);

const SPECIAL_AXES_ROLES = new Set([
  'polar_subplot_panel',
  'three_d_subplot_panel',
  'inset_subplot_panel',
  'geo_subplot_panel',
  'parasite_host_panel',
  'parasite_axis',
  'secondary_x_axis',
  'secondary_y_axis',
  'unsupported_projection_panel',
  'brokenaxes_panel_group',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function relationFromIdentity(identity: unknown): Record<string, unknown> | null {
  if (!isRecord(identity) || !isRecord(identity.relation)) return null;
  return identity.relation;
}

export function hasSpecialAxesMetadata(identity: unknown): boolean {
  const relation = relationFromIdentity(identity);
  return Boolean(relation && SPECIAL_AXES_RELATION_FIELDS.some(field => (
    Object.prototype.hasOwnProperty.call(relation, field)
  )));
}

export function specialAxesRelationSignature(identity: unknown): string | null {
  const relation = relationFromIdentity(identity);
  if (!relation) return null;
  const values = SPECIAL_AXES_RELATION_FIELDS.map(field => relation[field]);
  if (values.some(value => typeof value !== 'string' || value.length === 0)) return null;
  return SPECIAL_AXES_RELATION_FIELDS
    .map((field, index) => `${field}=${String(values[index])}`)
    .join(';');
}

export function hasSpecialAxesRelation(identity: unknown): boolean {
  return specialAxesRelationSignature(identity) !== null;
}

export function requiresSpecialAxesRelationIdentity(object: unknown): boolean {
  if (!isRecord(object)) return false;
  return SPECIAL_AXES_KINDS.has(String(object.kind || ''))
    || SPECIAL_AXES_ROLES.has(String(object.role || ''))
    || hasSpecialAxesMetadata(object.identity);
}
