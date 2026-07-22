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

function errorbarObject(
  id: string,
  subplotId: string,
  geom: 'GeomErrorbar' | 'GeomLinerange' | 'GeomPointrange' | 'GeomCrossbar',
  props: Record<string, unknown>,
  editable: string[],
): ManifestObject {
  return {
    id,
    kind: 'errorbar_container',
    label: id,
    role: `ggplot_${geom}`,
    editable,
    currentProps: {
      adapterFamily: 'errorbar',
      ...props,
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

function intent(prop: string, value: unknown, scope: EditingIntent['scope']): EditingIntent {
  return {
    intent: 'style.component',
    scope,
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  };
}

describe('R Errorbar family editing contract', () => {
  it('compiles line and cap edits through the strict backend resolver', () => {
    const errorbar = errorbarObject(
      'r.layer.0',
      'subplot.0',
      'GeomErrorbar',
      { color: '#444444', elinewidth: 0.6, capsize: 0.2, capUnit: 'data' },
      ['color', 'elinewidth', 'capsize', 'linestyle', 'alpha'],
    );
    const scope: EditingIntent['scope'] = {
      selectionMode: 'explicit_objects',
      objectIds: [errorbar.id],
      targetKinds: ['errorbar_container'],
      targetRole: 'data_errorbar',
    };

    expect(compileEditingIntentStrict(manifest([errorbar]), intent('elinewidth', 1.5, scope))).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: errorbar.id, prop: 'elinewidth', value: 1.5, mode: 'backend_patch' }],
    });
    expect(compileEditingIntentStrict(manifest([errorbar]), intent('capsize', 0.35, scope))).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: errorbar.id, prop: 'capsize', value: 0.35, mode: 'backend_patch' }],
    });
  });

  it('keeps role-in-subplot edits inside the selected panel', () => {
    const left = errorbarObject('r.layer.0', 'subplot.0', 'GeomErrorbar', { elinewidth: 0.6 }, ['elinewidth']);
    const right = errorbarObject('r.layer.1', 'subplot.1', 'GeomLinerange', { elinewidth: 0.7 }, ['elinewidth']);
    const result = compileEditingIntentStrict(manifest([left, right]), intent('elinewidth', 1.25, {
      selectionMode: 'role_in_subplot',
      subplotIds: ['subplot.1'],
      targetKinds: ['errorbar_container'],
      targetRole: 'data_errorbar',
    }));

    expect(result.strategy).toBe('strict');
    expect(result.skipped).toEqual([]);
    expect(result.patches).toEqual([
      expect.objectContaining({ gid: right.id, prop: 'elinewidth', value: 1.25 }),
    ]);
  });

  it('targets point controls only on Pointrange and reports unsupported siblings', () => {
    const linerange = errorbarObject('r.layer.0', 'subplot.0', 'GeomLinerange', { elinewidth: 0.7 }, ['elinewidth']);
    const pointrange = errorbarObject(
      'r.layer.1',
      'subplot.0',
      'GeomPointrange',
      { marker: 21, markersize: 2.5 },
      ['elinewidth', 'marker', 'markersize', 'facecolor'],
    );
    const result = compileEditingIntentStrict(manifest([linerange, pointrange]), intent('marker', 24, {
      selectionMode: 'explicit_objects',
      objectIds: [linerange.id, pointrange.id],
      targetKinds: ['errorbar_container'],
      targetRole: 'data_errorbar',
    }));

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([
      expect.objectContaining({ gid: pointrange.id, prop: 'marker', value: 24 }),
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ gid: linerange.id, reason: 'unsupported_prop' }),
    ]);
  });
});
