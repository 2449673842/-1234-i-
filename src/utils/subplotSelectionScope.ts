import type { StandardFigureObject } from '../schemas/standardFigureModel';

type SubplotResolvableObject = Pick<
  StandardFigureObject,
  'id' | 'kind' | 'subplotId' | 'source' | 'identity'
>;

export function getObjectSubplotId(obj: SubplotResolvableObject): string | null {
  if (obj.kind === 'subplot') return obj.id;
  const relation = obj.identity?.relation;
  if (typeof relation?.subplotId === 'string') return relation.subplotId;
  if ((relation?.subplotIds?.length ?? 0) > 1) return null;
  if (relation?.subplotIds?.length === 1) return relation.subplotIds[0];
  if (typeof obj.subplotId === 'string') return obj.subplotId;
  if (obj.kind === 'colorbar' || relation?.colorbarId) {
    return typeof obj.source?.ownerAxesIndex === 'number'
      ? `subplot.${obj.source.ownerAxesIndex}`
      : null;
  }
  if (typeof obj.source?.axesIndex === 'number') return `subplot.${obj.source.axesIndex}`;
  return null;
}

export function resolveSelectionSubplotScope(
  objects: readonly SubplotResolvableObject[],
  selectedGids: readonly string[],
  selectedObject?: string,
): string {
  const selectedIds = selectedGids.length > 0
    ? selectedGids
    : selectedObject && selectedObject !== 'Figure'
      ? [selectedObject]
      : [];
  if (selectedIds.length === 0) return 'all';

  const objectsById = new Map(objects.map(obj => [obj.id, obj]));
  const subplotIds = new Set<string>();
  for (const gid of selectedIds) {
    const object = objectsById.get(gid);
    if (!object) return 'all';
    const subplotId = getObjectSubplotId(object);
    if (!subplotId) return 'all';
    subplotIds.add(subplotId);
    if (subplotIds.size > 1) return 'all';
  }

  return subplotIds.values().next().value || 'all';
}
