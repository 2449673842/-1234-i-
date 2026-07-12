import type { StandardFigureObject } from '../schemas/standardFigureModel';

export type ExplicitColorbarOwnerResolution =
  | {
      status: 'resolved';
      subplotId: string;
      subplotIds: string[];
      source: 'colorbar_relation' | 'mappable_relation';
    }
  | {
      status: 'resolved_shared';
      subplotIds: string[];
      source: 'colorbar_relation';
    }
  | {
      status: 'absent';
    }
  | {
      status: 'invalid';
      reason: string;
    };

function uniqueObjectById(
  objects: StandardFigureObject[],
  objectId: string,
): StandardFigureObject | null {
  const matches = objects.filter(object => object.id === objectId);
  return matches.length === 1 ? matches[0] : null;
}

function validSubplotId(objects: StandardFigureObject[], subplotId: string): boolean {
  return objects.some(object => object.id === subplotId && object.kind === 'subplot');
}

export function resolveExplicitColorbarOwner(
  colorbar: StandardFigureObject,
  objects: StandardFigureObject[],
): ExplicitColorbarOwnerResolution {
  const relation = colorbar.identity?.relation;
  const directSubplotId = relation?.subplotId;
  const directSubplotIds = relation?.subplotIds;
  const mappableId = relation?.mappableId;
  const mappableIds = relation?.mappableIds;
  let mappableSubplotId: string | undefined;
  const mappableSubplotIds = new Set<string>();

  if (mappableIds !== undefined) {
    if (!Array.isArray(mappableIds) || mappableIds.length === 0) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} declares an empty mappable relationship.`,
      };
    }
    if (new Set(mappableIds).size !== mappableIds.length) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} declares duplicate mappable relationships.`,
      };
    }
    if (mappableId && !mappableIds.includes(mappableId)) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} omits its primary mappable from mappableIds.`,
      };
    }
    for (const candidateId of mappableIds) {
      const candidate = uniqueObjectById(objects, candidateId);
      if (!candidate) {
        return {
          status: 'invalid',
          reason: `Colorbar ${colorbar.id} references a missing or duplicate mappable ${candidateId}.`,
        };
      }
      const candidateSubplotId = candidate.identity?.relation?.subplotId ?? candidate.subplotId;
      if (candidateSubplotId) mappableSubplotIds.add(candidateSubplotId);
      const reciprocalColorbarId = candidate.identity?.relation?.colorbarId;
      if (reciprocalColorbarId && reciprocalColorbarId !== colorbar.id) {
        return {
          status: 'invalid',
          reason: `Colorbar ${colorbar.id} conflicts with reciprocal relation ${reciprocalColorbarId}.`,
        };
      }
    }
  }

  if (mappableId) {
    const mappable = uniqueObjectById(objects, mappableId);
    if (!mappable) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} references a missing or duplicate mappable ${mappableId}.`,
      };
    }
    mappableSubplotId = mappable.identity?.relation?.subplotId ?? mappable.subplotId;
    if (mappableSubplotId) mappableSubplotIds.add(mappableSubplotId);
    const reciprocalColorbarId = mappable.identity?.relation?.colorbarId;
    if (reciprocalColorbarId && reciprocalColorbarId !== colorbar.id) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} conflicts with reciprocal relation ${reciprocalColorbarId}.`,
      };
    }
  }

  if (directSubplotId && Array.from(mappableSubplotIds).some(subplotId => subplotId !== directSubplotId)) {
    return {
      status: 'invalid',
      reason: `Colorbar ${colorbar.id} has conflicting subplot relationships.`,
    };
  }

  if (directSubplotIds !== undefined) {
    if (!Array.isArray(directSubplotIds) || directSubplotIds.length === 0) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} declares an empty shared subplot relationship.`,
      };
    }
    const uniqueSubplotIds = Array.from(new Set(directSubplotIds));
    if (uniqueSubplotIds.length !== directSubplotIds.length) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} declares duplicate shared subplot relationships.`,
      };
    }
    if (
      (directSubplotId && !uniqueSubplotIds.includes(directSubplotId))
      || Array.from(mappableSubplotIds).some(subplotId => !uniqueSubplotIds.includes(subplotId))
    ) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} has conflicting shared subplot relationships.`,
      };
    }
    const missingSubplotId = uniqueSubplotIds.find(subplotId => !validSubplotId(objects, subplotId));
    if (missingSubplotId) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} references missing subplot ${missingSubplotId}.`,
      };
    }
    if (uniqueSubplotIds.length > 1) {
      return {
        status: 'resolved_shared',
        subplotIds: uniqueSubplotIds,
        source: 'colorbar_relation',
      };
    }
  }

  const subplotId = directSubplotId ?? directSubplotIds?.[0] ?? mappableSubplotId;
  if (subplotId) {
    if (!validSubplotId(objects, subplotId)) {
      return {
        status: 'invalid',
        reason: `Colorbar ${colorbar.id} references missing subplot ${subplotId}.`,
      };
    }
    return {
      status: 'resolved',
      subplotId,
      subplotIds: [subplotId],
      source: directSubplotId || directSubplotIds?.length ? 'colorbar_relation' : 'mappable_relation',
    };
  }

  return { status: 'absent' };
}
