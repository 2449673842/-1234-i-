import { describe, expect, it } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest, ManifestObject, ManifestPropertyCapability } from '../schemas/manifest';
import { compileEditingIntentStrict } from './targetResolver';

const capability = (prop: string): ManifestPropertyCapability => ({
  prop,
  patchMode: 'backend_patch',
  scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
  preview: 'none',
  replay: 'stable',
});

function pointObject(
  id: string,
  subplotId: string,
  props: Record<string, unknown>,
  editable: string[],
): ManifestObject {
  return {
    id,
    kind: 'collection',
    label: id,
    role: 'ggplot_GeomPoint',
    editable,
    currentProps: {
      adapterFamily: 'point',
      ...props,
    },
    identity: {
      semanticKey: `ggplot_GeomPoint:layer:${id}`,
      instanceKey: `r:figure:${id}`,
      seriesKey: `r-series:${id}`,
      scope: 'figure',
      coordinateSpace: 'data',
      relation: {
        subplotId,
        layerKey: `GeomPoint:PositionIdentity:${id}`,
      },
    },
    propertyCapabilities: editable.map(capability),
    source: {
      artistClass: 'GeomPoint',
      axesIndex: Number(subplotId.split('.')[1] || 0),
    },
  };
}

function manifest(objects: ManifestObject[]): Manifest {
  return {
    generatedBy: 'r_svg',
    objects,
    globals: {},
    groups: [],
    colorGroups: [],
    palettes: [],
    bindings: [],
    capabilities: { localPatch: false, backendPatch: true, codePatch: false },
    unsupportedNotes: [],
  };
}

function intent(
  prop: string,
  value: unknown,
  scope: EditingIntent['scope'],
): EditingIntent {
  return {
    intent: 'style.component',
    scope,
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  };
}

describe('R Point/Jitter editing contract', () => {
  it('compiles marker and proportional size edits through the strict backend resolver', () => {
    const point = pointObject(
      'r.layer.0',
      'subplot.0',
      { marker: 21, size: 4, size_scale: 1 },
      ['marker', 'size', 'size_scale'],
    );
    const figure = manifest([point]);
    const scope: EditingIntent['scope'] = {
      selectionMode: 'explicit_objects',
      objectIds: [point.id],
      targetKinds: ['collection'],
      targetRole: 'data_point',
    };

    expect(compileEditingIntentStrict(figure, intent('marker', 24, scope))).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: point.id, prop: 'marker', value: 24, mode: 'backend_patch' }],
    });
    expect(compileEditingIntentStrict(figure, intent('size_scale', 1.8, scope))).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: point.id, prop: 'size_scale', value: 1.8, mode: 'backend_patch' }],
    });
  });

  it('keeps role-in-subplot point edits inside the selected subplot', () => {
    const left = pointObject('r.layer.0', 'subplot.0', { size_scale: 1 }, ['size_scale']);
    const right = pointObject('r.layer.1', 'subplot.1', { size_scale: 1 }, ['size_scale']);
    const result = compileEditingIntentStrict(manifest([left, right]), intent('size_scale', 1.5, {
      selectionMode: 'role_in_subplot',
      subplotIds: ['subplot.1'],
      targetKinds: ['collection'],
      targetRole: 'data_point',
    }));

    expect(result.strategy).toBe('strict');
    expect(result.skipped).toEqual([]);
    expect(result.patches).toEqual([
      expect.objectContaining({ gid: right.id, prop: 'size_scale', value: 1.5 }),
    ]);
  });

  it('edits fill only on fillable shapes and reports the solid-shape skip', () => {
    const solid = pointObject('r.layer.0', 'subplot.0', { marker: 19, color: '#1F78B4' }, ['marker', 'color']);
    const fillable = pointObject(
      'r.layer.1',
      'subplot.0',
      { marker: 21, facecolor: '#A6CEE3', edgecolor: '#D62728' },
      ['marker', 'color', 'facecolor', 'edgecolor', 'linewidth'],
    );
    const result = compileEditingIntentStrict(manifest([solid, fillable]), intent('facecolor', '#FB9A99', {
      selectionMode: 'explicit_objects',
      objectIds: [solid.id, fillable.id],
      targetKinds: ['collection'],
      targetRole: 'data_point',
    }));

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([
      expect.objectContaining({ gid: fillable.id, prop: 'facecolor', value: '#FB9A99' }),
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ gid: solid.id, reason: 'unsupported_prop' }),
    ]);
  });
});
