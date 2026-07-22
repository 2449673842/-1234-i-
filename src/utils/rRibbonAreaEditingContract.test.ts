import { describe, expect, it } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest, ManifestObject, ManifestPropertyCapability } from '../schemas/manifest';
import { supportsComponentBatchProp } from '../components/RightSidebar';
import { inferEditingTargetRole } from './editingIntentCompiler';
import { compileEditingIntentStrict } from './targetResolver';

const capability = (prop: string): ManifestPropertyCapability => ({
  prop,
  patchMode: 'backend_patch',
  scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
  preview: 'none',
  replay: 'stable',
});

function bandObject(
  id: string,
  geom: 'GeomRibbon' | 'GeomArea',
  subplotId: string,
): ManifestObject {
  const adapterFamily = geom === 'GeomRibbon' ? 'ribbon' : 'area';
  const editable = ['facecolor', 'edgecolor', 'linewidth', 'alpha'];
  return {
    id,
    kind: 'patch',
    label: id,
    role: `ggplot_${geom}`,
    editable,
    currentProps: {
      adapterFamily,
      facecolor: '#a6cee3',
      edgecolor: '#1f78b4',
      linewidth: 0.7,
      alpha: 0.35,
      componentRoles: ['body', 'boundary_lines'],
    },
    identity: {
      semanticKey: `ggplot_${geom}:layer:${id}`,
      instanceKey: `r:subplot:${id}`,
      seriesKey: `r-series:${id}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: {
        subplotId,
        layerKey: `${geom}:PositionIdentity:${id}`,
      },
    },
    propertyCapabilities: editable.map(capability),
    source: {
      artistClass: geom,
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

function intent(object: ManifestObject, prop: string, value: unknown): EditingIntent {
  return {
    intent: 'style.component',
    scope: {
      selectionMode: 'explicit_objects',
      objectIds: [object.id],
      targetKinds: [object.kind],
      targetRole: 'data_band',
    },
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  };
}

describe('R Ribbon and Area family editing contract', () => {
  it('classifies legacy-kind R Ribbon and Area layers as data bands without changing patch identity', () => {
    const ribbon = bandObject('r.layer.0', 'GeomRibbon', 'subplot.0');
    const area = bandObject('r.layer.1', 'GeomArea', 'subplot.0');

    expect(ribbon.kind).toBe('patch');
    expect(area.kind).toBe('patch');
    expect(inferEditingTargetRole(ribbon)).toBe('data_band');
    expect(inferEditingTargetRole(area)).toBe('data_band');
  });

  it('compiles only truthful whole-band style props through the strict backend resolver', () => {
    const ribbon = bandObject('r.layer.0', 'GeomRibbon', 'subplot.0');
    const model = manifest([ribbon]);

    for (const [prop, value] of [
      ['facecolor', '#b2df8a'],
      ['edgecolor', '#33a02c'],
      ['linewidth', 1.2],
      ['alpha', 0.55],
    ] as const) {
      expect(supportsComponentBatchProp(ribbon, prop, 'r_svg')).toBe(true);
      expect(compileEditingIntentStrict(model, intent(ribbon, prop, value))).toMatchObject({
        strategy: 'strict',
        skipped: [],
        patches: [{ gid: ribbon.id, prop, value, mode: 'backend_patch' }],
      });
    }

    for (const prop of ['ymin', 'ymax', 'baseline', 'owner_series', 'boundary_color']) {
      expect(supportsComponentBatchProp(ribbon, prop, 'r_svg')).toBe(false);
      expect(compileEditingIntentStrict(model, intent(ribbon, prop, 1))).toMatchObject({
        strategy: 'strict',
        patches: [],
        skipped: [expect.objectContaining({ gid: ribbon.id, reason: 'unsupported_prop' })],
      });
    }
  });

  it('does not reinterpret GeomSmooth line ownership as an editable Ribbon band', () => {
    const smooth: ManifestObject = {
      ...bandObject('r.layer.smooth', 'GeomRibbon', 'subplot.0'),
      kind: 'line',
      role: 'ggplot_GeomSmooth',
      editable: ['color', 'linewidth', 'linestyle', 'alpha'],
      currentProps: {
        adapterFamily: 'line',
        smoothLayer: true,
        color: '#6a3d9a',
        linewidth: 1.1,
        linestyle: 'solid',
        alpha: 0.35,
      },
      propertyCapabilities: ['color', 'linewidth', 'linestyle', 'alpha'].map(capability),
      source: { artistClass: 'GeomSmooth', axesIndex: 0 },
    };

    expect(inferEditingTargetRole(smooth)).toBe('data_line');
    expect(supportsComponentBatchProp(smooth, 'facecolor', 'r_svg')).toBe(false);
  });
});
