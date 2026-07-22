import { describe, expect, it } from 'vitest';
import type { EditingIntent, SemanticTargetRole } from '../schemas/editingIntent';
import type { Manifest, ManifestObject, ManifestPropertyCapability } from '../schemas/manifest';
import { isHiddenLegacyRProp, supportsComponentBatchProp } from '../components/RightSidebar';
import { compileEditingIntentStrict } from './targetResolver';

const capability = (prop: string): ManifestPropertyCapability => ({
  prop,
  patchMode: 'backend_patch',
  scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
  preview: 'none',
  replay: 'stable',
});

function rContainerObject(
  id: string,
  kind: 'boxplot_container' | 'violinplot_container',
  role: 'boxplot_group' | 'violin_group',
  subplotId: string,
  props: Record<string, unknown>,
  editable: string[],
): ManifestObject {
  return {
    id,
    kind,
    label: id,
    role,
    editable,
    currentProps: props,
    identity: {
      semanticKey: `${role}:layer:${id}`,
      instanceKey: `r:subplot:${id}`,
      seriesKey: `r-series:${id}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: {
        subplotId,
        layerKey: `${role}:PositionIdentity:${id}`,
      },
    },
    propertyCapabilities: editable.map(capability),
    source: {
      artistClass: role === 'boxplot_group' ? 'GeomBoxplot' : 'GeomViolin',
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
  role: SemanticTargetRole,
  kind: ManifestObject['kind'],
  objectId: string,
  prop: string,
  value: unknown,
): EditingIntent {
  return {
    intent: 'style.component',
    scope: {
      selectionMode: 'explicit_objects',
      objectIds: [objectId],
      targetKinds: [kind],
      targetRole: role,
    },
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  };
}

describe('R Boxplot and Violin family editing contract', () => {
  it('does not expose legacy median_color as an independent modern Boxplot UI control', () => {
    const boxplot = rContainerObject(
      'r.layer.boxplot.0',
      'boxplot_container',
      'boxplot_group',
      'subplot.0',
      {
        color: '#222222',
        box_color: '#9ecae1',
        median_color: '#d62728',
      },
      ['color', 'linewidth', 'alpha', 'box_color'],
    );

    expect(supportsComponentBatchProp(boxplot, 'box_color', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(boxplot, 'color', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(boxplot, 'median_color', 'r_svg')).toBe(false);

    const result = compileEditingIntentStrict(
      manifest([boxplot]),
      intent('data_boxplot', 'boxplot_container', boxplot.id, 'median_color', '#000000'),
    );

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ gid: boxplot.id, reason: 'unsupported_prop' }),
    ]);
  });

  it('hides median_color for legacy R manifests while leaving renderer replay compatibility intact', () => {
    const legacyBoxplot = rContainerObject(
      'r.layer.boxplot.legacy',
      'boxplot_container',
      'boxplot_group',
      'subplot.0',
      { color: '#222222', box_color: '#9ecae1', median_color: '#d62728' },
      ['color', 'linewidth', 'alpha', 'box_color', 'median_color'],
    );
    delete legacyBoxplot.propertyCapabilities;

    expect(legacyBoxplot.editable).toContain('median_color');
    expect(supportsComponentBatchProp(legacyBoxplot, 'median_color', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(legacyBoxplot, 'color', 'r_svg')).toBe(true);
  });

  it('keeps Boxplot fill and outline as separate backend patch properties', () => {
    const boxplot = rContainerObject(
      'r.layer.boxplot.1',
      'boxplot_container',
      'boxplot_group',
      'subplot.0',
      { color: '#222222', box_color: '#9ecae1', linewidth: 0.5, alpha: 0.8 },
      ['color', 'linewidth', 'alpha', 'box_color'],
    );
    const model = manifest([boxplot]);

    expect(compileEditingIntentStrict(
      model,
      intent('data_boxplot', 'boxplot_container', boxplot.id, 'box_color', '#fdae6b'),
    )).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: boxplot.id, prop: 'box_color', value: '#fdae6b', mode: 'backend_patch' }],
    });

    expect(compileEditingIntentStrict(
      model,
      intent('data_boxplot', 'boxplot_container', boxplot.id, 'color', '#111111'),
    )).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: boxplot.id, prop: 'color', value: '#111111', mode: 'backend_patch' }],
    });
  });

  it('allows stable Boxplot outlier styling props through the modern patch contract', () => {
    const boxplot = rContainerObject(
      'r.layer.boxplot.2',
      'boxplot_container',
      'boxplot_group',
      'subplot.0',
      {
        color: '#222222',
        box_color: '#9ecae1',
        outlier_color: '#636363',
        outlier_fill: '#ffffff',
        outlier_shape: 21,
        outlier_size: 1.8,
        outlier_stroke: 0.4,
        outlier_alpha: 0.9,
      },
      [
        'color',
        'linewidth',
        'alpha',
        'box_color',
        'outlier_color',
        'outlier_fill',
        'outlier_shape',
        'outlier_size',
        'outlier_stroke',
        'outlier_alpha',
      ],
    );
    const model = manifest([boxplot]);

    [
      ['outlier_color', '#de2d26'],
      ['outlier_fill', '#fee0d2'],
      ['outlier_shape', 24],
      ['outlier_size', 2.6],
      ['outlier_stroke', 0.8],
      ['outlier_alpha', 0.65],
    ].forEach(([prop, value]) => {
      expect(supportsComponentBatchProp(boxplot, String(prop), 'r_svg')).toBe(true);
      expect(compileEditingIntentStrict(
        model,
        intent('data_boxplot', 'boxplot_container', boxplot.id, String(prop), value),
      )).toMatchObject({
        strategy: 'strict',
        skipped: [],
        patches: [{ gid: boxplot.id, prop, value, mode: 'backend_patch' }],
      });
    });
  });

  it('does not expose outlier_fill for a non-fillable Boxplot outlier shape', () => {
    const boxplot = rContainerObject(
      'r.layer.boxplot.shape19',
      'boxplot_container',
      'boxplot_group',
      'subplot.0',
      {
        color: '#222222',
        box_color: '#9ecae1',
        outlier_color: '#636363',
        outlier_shape: 19,
        outlier_size: 1.5,
        outlier_stroke: 0.5,
        outlier_alpha: 1,
        outlierFillSupported: false,
      },
      [
        'color',
        'linewidth',
        'alpha',
        'box_color',
        'outlier_color',
        'outlier_shape',
        'outlier_size',
        'outlier_stroke',
        'outlier_alpha',
      ],
    );

    expect(supportsComponentBatchProp(boxplot, 'outlier_fill', 'r_svg')).toBe(false);
    expect(compileEditingIntentStrict(
      manifest([boxplot]),
      intent('data_boxplot', 'boxplot_container', boxplot.id, 'outlier_fill', '#fee0d2'),
    )).toMatchObject({
      strategy: 'strict',
      patches: [],
      skipped: [expect.objectContaining({ gid: boxplot.id, reason: 'unsupported_prop' })],
    });
  });

  it('does not expose independent Violin quantile setters unless the renderer proves them stable', () => {
    const violin = rContainerObject(
      'r.layer.violin.0',
      'violinplot_container',
      'violin_group',
      'subplot.0',
      {
        facecolor: '#c7e9c0',
        edgecolor: '#238b45',
        quantile_color: '#d62728',
        quantile_linewidth: 0.7,
      },
      ['facecolor', 'edgecolor', 'linewidth', 'alpha'],
    );

    expect(supportsComponentBatchProp(violin, 'facecolor', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(violin, 'edgecolor', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(violin, 'color', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(violin, 'quantile_color', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(violin, 'quantile_linewidth', 'r_svg')).toBe(false);

    const result = compileEditingIntentStrict(
      manifest([violin]),
      intent('data_violin', 'violinplot_container', violin.id, 'quantile_color', '#000000'),
    );

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ gid: violin.id, reason: 'unsupported_prop' }),
    ]);
  });

  it('hides the duplicate Violin color control for legacy R manifests', () => {
    const legacyViolin = rContainerObject(
      'r.layer.violin.legacy',
      'violinplot_container',
      'violin_group',
      'subplot.0',
      { color: '#222222', facecolor: '#c7e9c0', edgecolor: '#222222' },
      ['color', 'facecolor', 'edgecolor', 'linewidth', 'alpha'],
    );
    delete legacyViolin.propertyCapabilities;

    expect(isHiddenLegacyRProp(legacyViolin, 'color', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(legacyViolin, 'color', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(legacyViolin, 'edgecolor', 'r_svg')).toBe(true);
  });
});
