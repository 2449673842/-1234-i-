import { describe, expect, it } from 'vitest';
import type { Binding, Manifest, ManifestObject } from '../schemas/manifest';
import { buildPaletteObjectPatches, buildPaletteUpdatePatches, resolvePaletteColorFallbackTargets, resolvePaletteTargets } from './paletteTargetResolver';

function object(
  id: string,
  prop: string,
  seriesKey: string,
  patchMode: 'local_patch' | 'backend_patch' = 'local_patch',
): ManifestObject {
  return {
    id,
    kind: id.startsWith('patch.') ? 'patch' : 'line',
    label: id,
    editable: [prop],
    currentProps: { [prop]: '#000000' },
    identity: {
      instanceKey: `subplot:${id}`,
      seriesKey,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: { subplotId: 'subplot.0' },
    },
    propertyCapabilities: [{
      prop,
      patchMode,
      scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
      preview: patchMode === 'local_patch' ? 'exact' : 'none',
      replay: 'stable',
    }],
  };
}

function target(gid: string, prop: string, seriesKey: string) {
  return {
    gid,
    prop,
    instanceKey: `subplot:${gid}`,
    seriesKey,
    match: 'label_and_color' as const,
    confidence: 'exact' as const,
  };
}

function binding(paletteId: string, targets: ReturnType<typeof target>[]): Binding {
  return {
    paletteId,
    groupId: `group_${paletteId}`,
    gids: targets.map(item => item.gid),
    props: Array.from(new Set(targets.map(item => item.prop))),
    targetMode: 'exact',
    targets,
  };
}

function manifest(objects: ManifestObject[], bindings: Binding[]): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects,
    bindings,
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
}

describe('palette target resolver', () => {
  it('keeps code persistence and exact object colors in one Python batch', () => {
    const line = object('line.0', 'color', 'weak-series');
    const resolution = resolvePaletteTargets(
      manifest([line], [binding('Weak', [target(line.id, 'color', 'weak-series')])]),
      'Weak',
      true,
    );
    const patches = buildPaletteUpdatePatches(resolution, '#abcdef', 'Weak');

    expect(patches[0]).toEqual({
      type: 'code_patch',
      target_id: 'Weak',
      new_value: '#abcdef',
      gids: ['line.0'],
    });
    expect(patches.slice(1)).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'line.0', prop: 'color', value: '#abcdef',
    }]);
  });

  it('uses code replay without flattening a vector-colored collection', () => {
    const collection = object('collection.0.0', 'facecolor', 'scatter-series');
    collection.currentProps.facecolor = [
      [0.1, 0.2, 0.3, 1],
      [0.8, 0.4, 0.2, 1],
    ];
    const resolution = resolvePaletteTargets(
      manifest([collection], [binding('PROMOTION', [target(collection.id, 'facecolor', 'scatter-series')])]),
      'PROMOTION',
      true,
    );

    expect(resolution.targets[0]?.replayMode).toBe('code_only');
    expect(buildPaletteObjectPatches(resolution, '#abcdef')).toEqual([]);
    expect(buildPaletteUpdatePatches(resolution, '#abcdef', 'PROMOTION')).toEqual([{
      type: 'code_patch',
      target_id: 'PROMOTION',
      new_value: '#abcdef',
      gids: ['collection.0.0'],
    }]);
  });

  it('infers code replay for a legacy vector-color binding', () => {
    const collection = object('collection.0.0', 'facecolor', 'scatter-series');
    collection.currentProps.facecolor = [
      [0.1, 0.2, 0.3, 1],
      [0.8, 0.4, 0.2, 1],
    ];
    const result = resolvePaletteTargets(
      manifest([collection], [binding('PROMOTION', [target(collection.id, 'facecolor', 'scatter-series')])]),
      'PROMOTION',
      false,
    );

    expect(result.strategy).toBe('legacy');
    expect(result.targets[0]?.replayMode).toBe('code_only');
    expect(buildPaletteObjectPatches(result, '#abcdef')).toEqual([]);
  });
  it('keeps same-color Weak and Mixed bindings separate by explicit targets', () => {
    const weak = object('line.0.0', 'color', 'weak-series');
    const mixed = object('line.0.1', 'color', 'mixed-series');
    const figure = manifest([weak, mixed], [
      binding('Weak', [target(weak.id, 'color', 'weak-series')]),
      binding('Mixed', [target(mixed.id, 'color', 'mixed-series')]),
    ]);

    const result = resolvePaletteTargets(figure, 'Weak', true);

    expect(result.strategy).toBe('strict');
    expect(result.targets.map(item => item.objectId)).toEqual(['line.0.0']);
    expect(buildPaletteObjectPatches(result, '#cc0000')).toEqual([{
      op: 'set', mode: 'local_patch', gid: 'line.0.0', prop: 'color', value: '#cc0000',
    }]);
  });

  it('preserves the per-target property instead of applying props[0] to every object', () => {
    const line = object('line.0.0', 'color', 'line-series');
    const patch = object('patch.0.0', 'facecolor', 'patch-series');
    const figure = manifest([line, patch], [binding('SERIES', [
      target(line.id, 'color', 'line-series'),
      target(patch.id, 'facecolor', 'patch-series'),
    ])]);

    const result = resolvePaletteTargets(figure, 'SERIES', true);

    expect(buildPaletteObjectPatches(result, '#118833')).toEqual([
      { op: 'set', mode: 'local_patch', gid: 'line.0.0', prop: 'color', value: '#118833' },
      { op: 'set', mode: 'local_patch', gid: 'patch.0.0', prop: 'facecolor', value: '#118833' },
    ]);
  });

  it('rejects an ambiguous binding without falling back to color matching', () => {
    const line = object('line.0.0', 'color', 'line-series');
    const ambiguous: Binding = {
      paletteId: 'Weak',
      groupId: 'group_Weak',
      gids: [],
      props: [],
      targetMode: 'ambiguous',
      targets: [],
      warnings: ['Duplicate color without semantic identity.'],
    };

    const result = resolvePaletteTargets(manifest([line], [ambiguous]), 'Weak', true);

    expect(result.strategy).toBe('strict');
    expect(result.targets).toEqual([]);
    expect(result.ambiguous[0]?.reason).toBe('ambiguous_binding');
    expect(buildPaletteObjectPatches(result, '#ff0000')).toEqual([]);
  });

  it('preserves renderer ambiguity when the strict resolver flag is disabled', () => {
    const line = object('line.0.0', 'color', 'line-series');
    const ambiguous: Binding = {
      paletteId: 'PROMOTION',
      groupId: 'palette_PROMOTION',
      gids: [],
      props: [],
      targetMode: 'ambiguous',
      targets: [],
      warnings: ['Multiple unbound palettes share this color.'],
    };

    const result = resolvePaletteTargets(manifest([line], [ambiguous]), 'PROMOTION', false);

    expect(result.strategy).toBe('legacy');
    expect(result.targetMode).toBe('ambiguous');
    expect(result.ambiguous[0]?.reason).toBe('ambiguous_binding');
    expect(buildPaletteUpdatePatches(result, '#33aa77', 'PROMOTION')).toEqual([{
      type: 'code_patch', target_id: 'PROMOTION', new_value: '#33aa77', gids: [],
    }]);
  });

  it('falls back to the first legacy binding when target metadata is absent', () => {
    const line = object('line.0.0', 'color', 'line-series');
    const legacy: Binding = {
      paletteId: 'SERIES',
      groupId: 'group_SERIES',
      gids: [line.id],
      props: ['color'],
    };

    const result = resolvePaletteTargets(manifest([line], [legacy]), 'SERIES', true);

    expect(result.strategy).toBe('legacy');
    expect(result.fallbackReason).toBe('missing_binding_protocol');
    expect(result.targets[0]?.objectId).toBe(line.id);
  });

  it('blocks object patches when the candidate requires a complete binding protocol', () => {
    const line = object('line.0.0', 'color', 'line-series');
    const legacy: Binding = {
      paletteId: 'SERIES',
      groupId: 'group_SERIES',
      gids: [line.id],
      props: ['color'],
    };

    const result = resolvePaletteTargets(
      manifest([line], [legacy]),
      'SERIES',
      true,
      undefined,
      true,
    );

    expect(result.strategy).toBe('strict');
    expect(result.fallbackReason).toBe('missing_binding_protocol');
    expect(result.targetMode).toBe('unresolved');
    expect(result.targets).toEqual([]);
    expect(result.ambiguous[0]?.reason).toBe('ambiguous_binding');
    expect(buildPaletteObjectPatches(result, '#abcdef')).toEqual([]);
  });

  it('blocks object patches when target objects lack identity capabilities', () => {
    const line = object('line.0.0', 'color', 'line-series');
    delete line.propertyCapabilities;
    const exact = binding('SERIES', [target(line.id, 'color', 'line-series')]);

    const result = resolvePaletteTargets(
      manifest([line], [exact]),
      'SERIES',
      true,
      undefined,
      true,
    );

    expect(result.strategy).toBe('strict');
    expect(result.fallbackReason).toBe('missing_object_protocol');
    expect(result.targets).toEqual([]);
    expect(buildPaletteObjectPatches(result, '#abcdef')).toEqual([]);
  });

  it('treats unresolved bindings as blocked instead of unused', () => {
    const unresolved: Binding = {
      paletteId: 'SERIES',
      groupId: 'group_SERIES',
      gids: [],
      props: [],
      targetMode: 'unresolved',
      targets: [],
      warnings: ['scale target could not be resolved'],
    };

    const result = resolvePaletteTargets(manifest([], [unresolved]), 'SERIES', true);

    expect(result.targetMode).toBe('unresolved');
    expect(result.targets).toEqual([]);
    expect(result.ambiguous[0]?.reason).toBe('ambiguous_binding');
    expect(buildPaletteObjectPatches(result, '#abcdef')).toEqual([]);
  });

  it('rejects stale series identity instead of patching a reused gid', () => {
    const line = object('line.0.0', 'color', 'new-series');
    const stale = binding('SERIES', [target(line.id, 'color', 'old-series')]);

    const result = resolvePaletteTargets(manifest([line], [stale]), 'SERIES', true);

    expect(result.strategy).toBe('strict');
    expect(result.targets).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('series_mismatch');
  });

  it('limits selected-only edits to explicitly selected binding targets', () => {
    const first = object('line.0.0', 'color', 'series-0');
    const second = object('line.0.1', 'color', 'series-1');
    const figure = manifest([first, second], [binding('SERIES', [
      target(first.id, 'color', 'series-0'),
      target(second.id, 'color', 'series-1'),
    ])]);

    const result = resolvePaletteTargets(figure, 'SERIES', true, [second.id]);

    expect(result.targets.map(item => item.objectId)).toEqual([second.id]);
  });

  it('supports subplot-scoped palette edits without emitting a global code patch', () => {
    const subplotA = object('line.0.0', 'color', 'shared-color-a', 'backend_patch');
    subplotA.subplotId = 'subplot.0';
    subplotA.identity!.relation = { subplotId: 'subplot.0' };
    const subplotB = object('line.1.0', 'color', 'shared-color-b', 'backend_patch');
    subplotB.subplotId = 'subplot.1';
    subplotB.identity!.relation = { subplotId: 'subplot.1' };
    const figure = manifest([subplotA, subplotB], [binding('BLUE', [
      target(subplotA.id, 'color', 'shared-color-a'),
      target(subplotB.id, 'color', 'shared-color-b'),
    ])]);

    const scoped = resolvePaletteTargets(figure, 'BLUE', true, [subplotB.id]);
    const scopedPatches = buildPaletteObjectPatches(scoped, '#0F3CF0');

    expect(scoped.targets.map(item => item.objectId)).toEqual([subplotB.id]);
    expect(scopedPatches).toEqual([{
      op: 'set',
      mode: 'backend_patch',
      gid: subplotB.id,
      prop: 'color',
      value: '#0F3CF0',
    }]);
    expect(scopedPatches.some((patch: any) => patch.type === 'code_patch')).toBe(false);
  });

  it('falls back to scoped rendered-color targets for duplicate colors in combined figures', () => {
    const panelC = object('line.2.0', 'color', 'panel-c-red', 'backend_patch');
    panelC.subplotId = 'subplot.2';
    panelC.identity!.relation = { subplotId: 'subplot.2' };
    panelC.currentProps.color = '#d62728';
    const panelD = object('line.3.0', 'color', 'panel-d-red', 'backend_patch');
    panelD.subplotId = 'subplot.3';
    panelD.identity!.relation = { subplotId: 'subplot.3' };
    panelD.currentProps.color = '#d62728';
    const figure = manifest([panelC, panelD], [{
      paletteId: 'RED',
      groupId: 'palette_RED',
      gids: [],
      props: [],
      targetMode: 'ambiguous',
      targets: [],
      warnings: ['Multiple unbound palettes share this color; color-only matching is disabled.'],
    }]);

    const strict = resolvePaletteTargets(figure, 'RED', true);
    expect(strict.targets).toEqual([]);
    expect(strict.ambiguous).toHaveLength(1);

    const fallback = resolvePaletteColorFallbackTargets(figure, 'RED', '#D62728', [panelC.id]);

    expect(fallback.targets.map(item => item.objectId)).toEqual([panelC.id]);
    expect(buildPaletteObjectPatches(fallback, '#aa0000')).toEqual([{
      op: 'set',
      mode: 'backend_patch',
      gid: panelC.id,
      prop: 'color',
      value: '#aa0000',
    }]);
  });

  it('treats a selected fill_between band as a dedicated rendered-color target', () => {
    const band = object('collection.0.0', 'facecolor', 'confidence-band', 'local_patch');
    band.kind = 'fill_between';
    band.role = 'fill_between_series';
    band.currentProps.facecolor = [[0.2666666667, 0.4666666667, 0.6666666667, 0.45]];
    const points = object('collection.0.1', 'facecolor', 'scatter-series', 'local_patch');
    points.kind = 'collection';
    points.role = 'scatter_series';
    points.currentProps.facecolor = [[0.2666666667, 0.4666666667, 0.6666666667, 1]];
    const figure = manifest([band, points], []);

    const fallback = resolvePaletteColorFallbackTargets(figure, 'BAND', '#4477AA', [band.id]);

    expect(fallback.targets).toEqual([expect.objectContaining({
      objectId: band.id,
      prop: 'facecolor',
      patchMode: 'local_patch',
    })]);
    expect(fallback.targets.some(target => target.objectId === points.id)).toBe(false);
  });

  it('creates a backend color-subset patch for blue entries inside a multi-color collection', () => {
    const collection = object('collection.1.0', 'facecolor', 'panel-b-scatter', 'local_patch');
    collection.kind = 'collection';
    collection.subplotId = 'subplot.1';
    collection.identity!.relation = { subplotId: 'subplot.1' };
    collection.currentProps.facecolor = [
      [0.0588235294, 0.2352941176, 0.9411764706, 1],
      [0.8392156863, 0.1529411765, 0.1568627451, 1],
      [0.0588235294, 0.2352941176, 0.9411764706, 0.7],
    ];
    const figure = manifest([collection], []);

    const fallback = resolvePaletteColorFallbackTargets(figure, 'BLUE', '#0F3CF0', [collection.id]);

    expect(fallback.targets).toEqual([expect.objectContaining({
      objectId: collection.id,
      prop: 'facecolor',
      matchColor: '#0f3cf0',
      patchMode: 'backend_patch',
      replayMode: 'object_patch',
    })]);
    expect(buildPaletteObjectPatches(fallback, '#1188ff')).toEqual([{
      op: 'set',
      mode: 'backend_patch',
      gid: collection.id,
      prop: 'facecolor',
      value: '#1188ff',
      matchColor: '#0f3cf0',
    }]);
  });

  it('does not use parent-owned contour child collections for rendered-color fallback', () => {
    const contourParent = object('contour.0.0', 'cmap', 'contour-series', 'backend_patch');
    contourParent.kind = 'contour' as any;
    contourParent.role = 'contour_series';
    contourParent.children = ['collection.0.20'];
    contourParent.identity!.semanticKey = 'contour_series:subplot.0';
    const contourChild = object('collection.0.20', 'facecolor', 'contour-child', 'local_patch');
    contourChild.kind = 'collection';
    contourChild.role = 'contour_child_collection';
    contourChild.parentId = contourParent.id;
    contourChild.identity!.relation = { subplotId: 'subplot.0', parentId: contourParent.id };
    contourChild.currentProps.facecolor = [[0.2666666667, 0.4666666667, 0.6666666667, 1]];
    const scatter = object('collection.0.21', 'facecolor', 'scatter-series', 'local_patch');
    scatter.kind = 'collection';
    scatter.role = 'scatter_series';
    scatter.currentProps.facecolor = [[0.2666666667, 0.4666666667, 0.6666666667, 1]];
    const figure = manifest([contourParent, contourChild, scatter], []);

    const fallback = resolvePaletteColorFallbackTargets(figure, 'CONTOUR_BLUE', '#4477AA', [
      contourChild.id,
      scatter.id,
    ]);

    expect(fallback.targets.map(item => item.objectId)).toEqual([scatter.id]);
    expect(fallback.targets.some(item => item.objectId === contourChild.id)).toBe(false);
  });
});
