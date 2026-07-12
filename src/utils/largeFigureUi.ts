import type { ManifestObject } from '../schemas/manifest';

export const MANIFEST_OBJECT_RENDER_LIMIT = 250;
export const TREE_CHILD_RENDER_LIMIT = 220;

export function takeBoundedWithPinned<T>(
  items: T[],
  limit: number,
  pinnedIds: ReadonlySet<string>,
  getId: (item: T) => string,
  containsPinned: (item: T, pinnedIds: ReadonlySet<string>) => boolean,
): T[] {
  if (items.length <= limit) return items;

  const visible = items.slice(0, limit);
  const visibleIds = new Set(visible.map(getId));
  const pinnedOutsideLimit = items
    .slice(limit)
    .filter(item => containsPinned(item, pinnedIds) && !visibleIds.has(getId(item)));

  return [...visible, ...pinnedOutsideLimit];
}

export function filterManifestObjects(
  objects: ManifestObject[],
  query: string,
  kind: string,
): ManifestObject[] {
  const normalizedQuery = query.trim().toLowerCase();
  return objects.filter(object => {
    if (kind && kind !== 'all' && object.kind !== kind) return false;
    if (!normalizedQuery) return true;

    const searchable = [
      object.id,
      object.kind,
      object.role,
      object.label,
      object.currentProps?.text,
      object.identity?.semanticKey,
      object.identity?.instanceKey,
      object.identity?.seriesKey,
    ]
      .filter(value => value !== null && value !== undefined)
      .map(value => String(value).toLowerCase());

    return searchable.some(value => value.includes(normalizedQuery));
  });
}

