import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import {
  filterManifestObjects,
  takeBoundedWithPinned,
} from './largeFigureUi';

interface TestNode {
  id: string;
  children?: TestNode[];
}

function containsPinned(node: TestNode, pinnedIds: ReadonlySet<string>): boolean {
  if (pinnedIds.has(node.id)) return true;
  return Boolean(node.children?.some(child => containsPinned(child, pinnedIds)));
}

function makeObject(id: string, kind: ManifestObject['kind'], text = ''): ManifestObject {
  return {
    id,
    kind,
    label: id,
    editable: [],
    currentProps: { text },
  };
}

describe('takeBoundedWithPinned', () => {
  it('keeps the DOM window bounded while preserving selected items outside the window', () => {
    const nodes = Array.from({ length: 300 }, (_, index) => ({ id: `node.${index}` }));
    const result = takeBoundedWithPinned(
      nodes,
      220,
      new Set(['node.299']),
      node => node.id,
      containsPinned,
    );

    expect(result).toHaveLength(221);
    expect(result[0].id).toBe('node.0');
    expect(result[219].id).toBe('node.219');
    expect(result[220].id).toBe('node.299');
  });

  it('preserves a parent branch when a selected descendant is outside the window', () => {
    const nodes = Array.from({ length: 230 }, (_, index) => ({
      id: `group.${index}`,
      children: [{ id: `child.${index}` }],
    }));
    const result = takeBoundedWithPinned(
      nodes,
      220,
      new Set(['child.229']),
      node => node.id,
      containsPinned,
    );

    expect(result.at(-1)?.id).toBe('group.229');
  });
});

describe('filterManifestObjects', () => {
  const objects = [
    makeObject('text.0', 'text', 'Alpha annotation'),
    { ...makeObject('line.0', 'line'), role: 'data_line', identity: { seriesKey: 'Weak response' } },
    makeObject('line.1', 'line'),
  ];

  it('searches stable identity and visible text without mutating the manifest list', () => {
    expect(filterManifestObjects(objects, 'weak response', 'all').map(item => item.id)).toEqual(['line.0']);
    expect(filterManifestObjects(objects, 'alpha', 'all').map(item => item.id)).toEqual(['text.0']);
    expect(objects).toHaveLength(3);
  });

  it('combines kind and text filters exactly', () => {
    expect(filterManifestObjects(objects, '', 'line').map(item => item.id)).toEqual(['line.0', 'line.1']);
    expect(filterManifestObjects(objects, 'alpha', 'line')).toEqual([]);
  });
});

