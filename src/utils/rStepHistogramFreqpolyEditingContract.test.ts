import { describe, expect, it } from 'vitest';
import type { EditingIntent, SemanticTargetRole } from '../schemas/editingIntent';
import type {
  KnownRLayerAdapterClass,
  Manifest,
  ManifestObject,
  ManifestPropertyCapability,
} from '../schemas/manifest';
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

function familyObject(
  id: string,
  kind: 'line' | 'patch',
  role: 'ggplot_GeomStep' | 'ggplot_GeomBar' | 'ggplot_GeomPath',
  adapterClass: KnownRLayerAdapterClass,
  adapterFamily: 'step' | 'histogram' | 'freqpoly',
  editable: string[],
): ManifestObject {
  return {
    id,
    kind,
    label: id,
    role,
    editable,
    currentProps: {
      adapterFamily,
      color: '#1f78b4',
      facecolor: '#a6cee3',
      edgecolor: '#333333',
      linewidth: 0.7,
      linestyle: 'solid',
      alpha: 0.7,
      stepDirection: adapterFamily === 'step' ? 'vh' : undefined,
      binwidth: adapterFamily === 'histogram' ? 1 : undefined,
      bins: adapterFamily === 'freqpoly' ? 4 : undefined,
      breaks: adapterFamily === 'step' ? undefined : [1, 2, 3, 4],
      counts: adapterFamily === 'step' ? undefined : [2, 3, 3],
      density: adapterFamily === 'step' ? undefined : [0.25, 0.375, 0.375],
      structureReadonly: true,
    },
    identity: {
      semanticKey: `${role}:layer:${id}`,
      instanceKey: `r:subplot:${id}`,
      seriesKey: `r-series:${id}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: {
        subplotId: 'subplot.0',
        layerKey: `${role}:StatBin:${id}`,
      },
    },
    propertyCapabilities: editable.map(capability),
    source: {
      artistClass: role.replace('ggplot_', ''),
      adapterClass,
      axesIndex: 0,
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
  object: ManifestObject,
  role: SemanticTargetRole,
  prop: string,
  value: unknown,
): EditingIntent {
  return {
    intent: 'style.component',
    scope: {
      selectionMode: 'explicit_objects',
      objectIds: [object.id],
      targetKinds: [object.kind],
      targetRole: role,
    },
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  };
}

describe('R Step, Histogram, and Freqpoly editing contract', () => {
  const step = familyObject(
    'r.layer.0',
    'line',
    'ggplot_GeomStep',
    'GeomStep',
    'step',
    ['color', 'linewidth', 'linestyle', 'alpha'],
  );
  const histogram = familyObject(
    'r.layer.1',
    'patch',
    'ggplot_GeomBar',
    'GeomHistogram',
    'histogram',
    ['facecolor', 'edgecolor', 'linewidth', 'alpha'],
  );
  const freqpoly = familyObject(
    'r.layer.2',
    'line',
    'ggplot_GeomPath',
    'GeomFreqpoly',
    'freqpoly',
    ['color', 'linewidth', 'linestyle', 'alpha'],
  );

  it('keeps legacy R roles while routing through generic line and patch semantics', () => {
    expect(histogram.role).toBe('ggplot_GeomBar');
    expect(freqpoly.role).toBe('ggplot_GeomPath');
    expect(inferEditingTargetRole(step)).toBe('data_line');
    expect(inferEditingTargetRole(histogram)).toBe('data_patch');
    expect(inferEditingTargetRole(freqpoly)).toBe('data_line');
  });

  it('compiles only advertised visual styles as authoritative backend patches', () => {
    const model = manifest([step, histogram, freqpoly]);
    const cases = [
      [step, 'data_line', 'color', '#d62728'],
      [step, 'data_line', 'linewidth', 1.8],
      [histogram, 'data_patch', 'facecolor', '#cab2d6'],
      [histogram, 'data_patch', 'edgecolor', '#111111'],
      [freqpoly, 'data_line', 'linestyle', 'dashed'],
      [freqpoly, 'data_line', 'alpha', 0.45],
    ] as const;

    for (const [object, role, prop, value] of cases) {
      expect(supportsComponentBatchProp(object, prop, 'r_svg')).toBe(true);
      expect(compileEditingIntentStrict(model, intent(object, role, prop, value))).toMatchObject({
        strategy: 'strict',
        skipped: [],
        patches: [{ gid: object.id, prop, value, mode: 'backend_patch' }],
      });
    }
  });

  it('keeps step direction and bin/statistical structure readonly', () => {
    const model = manifest([step, histogram, freqpoly]);
    const cases = [
      [step, 'data_line', 'stepDirection'],
      [step, 'data_line', 'direction'],
      [histogram, 'data_patch', 'binwidth'],
      [histogram, 'data_patch', 'breaks'],
      [histogram, 'data_patch', 'counts'],
      [freqpoly, 'data_line', 'bins'],
      [freqpoly, 'data_line', 'density'],
      [freqpoly, 'data_line', 'yStat'],
    ] as const;

    for (const [object, role, prop] of cases) {
      expect(supportsComponentBatchProp(object, prop, 'r_svg')).toBe(false);
      expect(compileEditingIntentStrict(model, intent(object, role, prop, 2))).toMatchObject({
        strategy: 'strict',
        patches: [],
        skipped: [expect.objectContaining({ gid: object.id, reason: 'unsupported_prop' })],
      });
    }
  });
});
