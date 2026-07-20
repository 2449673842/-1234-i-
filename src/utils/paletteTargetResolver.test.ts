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

function diagramObject(
  id: string,
  role: string,
  prop: string,
  diagramId: string,
  diagramObjectId: string,
  extraRelation: Record<string, unknown> = {},
): ManifestObject {
  const item = object(id, prop, `diagram:${diagramId}:${role}:${diagramObjectId}`, 'backend_patch');
  item.kind = id.startsWith('line.') ? 'line' : 'patch';
  item.role = role;
  item.identity!.seriesKey = `diagram:${diagramId}:${role}:${diagramObjectId}`;
  item.identity!.semanticKey = `${role}:${diagramId}:${role}:${diagramObjectId}`;
  item.identity!.relation = {
    subplotId: 'subplot.0',
    diagramId,
    diagramType: 'sem',
    diagramObjectId,
    ...extraRelation,
  } as any;
  return item;
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

  it('does not use legacy editable fallback for modern palette objects with omitted capabilities', () => {
    const line = object('line.0.0', 'color', 'line-series');
    line.editable = ['color'];
    line.propertyCapabilities = [];
    const legacy: Binding = {
      paletteId: 'SERIES',
      groupId: 'group_SERIES',
      gids: [line.id],
      props: ['color'],
    };

    const result = resolvePaletteTargets(manifest([line], [legacy]), 'SERIES', true);

    expect(result.strategy).toBe('legacy');
    expect(result.targets).toEqual([]);
    expect(result.skipped[0]).toEqual(expect.objectContaining({
      objectId: line.id,
      reason: 'unsupported_prop',
    }));
    expect(buildPaletteObjectPatches(result, '#118833')).toEqual([]);
  });

  it('does not use legacy palette resolution for a group-only modern color capability', () => {
    const line = object('line.0.0', 'color', 'line-series');
    line.propertyCapabilities = [{
      prop: 'color',
      patchMode: 'backend_patch',
      scopes: ['group'],
      preview: 'none',
      replay: 'stable',
    }];
    const legacy: Binding = {
      paletteId: 'SERIES',
      groupId: 'group_SERIES',
      gids: [line.id],
      props: ['color'],
    };

    const result = resolvePaletteTargets(manifest([line], [legacy]), 'SERIES', false);

    expect(result.targets).toEqual([]);
    expect(result.skipped[0]).toEqual(expect.objectContaining({
      objectId: line.id,
      reason: 'unsupported_prop',
    }));
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

  it('does not emit rendered-color fallback targets for omitted modern color capabilities', () => {
    const line = object('line.0.0', 'color', 'line-series', 'backend_patch');
    line.currentProps.color = '#000000';
    line.currentProps.edgecolor = '#4477aa';

    const fallback = resolvePaletteColorFallbackTargets(manifest([line], []), 'BLUE', '#4477aa', [line.id]);

    expect(fallback.targets).toEqual([]);
    expect(buildPaletteObjectPatches(fallback, '#1188ff')).toEqual([]);
  });

  it('retains rendered-color fallback for legacy manifests without capabilities', () => {
    const line = object('line.0.0', 'color', 'line-series', 'backend_patch');
    delete line.propertyCapabilities;
    line.currentProps.color = '#000000';
    line.currentProps.edgecolor = '#4477aa';

    const fallback = resolvePaletteColorFallbackTargets(manifest([line], []), 'BLUE', '#4477aa', [line.id]);

    expect(fallback.targets).toEqual([expect.objectContaining({
      objectId: line.id,
      prop: 'edgecolor',
    })]);
    expect(buildPaletteObjectPatches(fallback, '#1188ff')).toEqual([{
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'edgecolor',
      value: '#1188ff',
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

  it.each([
    ['quiver', 'quiver_field', 'collection.0.2'],
    ['streamplot', 'streamplot_field', 'container.streamplot.0.0'],
  ])('uses the dedicated %s parent for rendered-color fallback', (kind, role, id) => {
    const parent = object(id, 'color', `${kind}-series`, 'backend_patch');
    parent.kind = kind as ManifestObject['kind'];
    parent.role = role;
    parent.currentProps.color = '#4477aa';
    const child = object('collection.0.9', 'color', `${kind}-child`, 'local_patch');
    child.kind = 'collection';
    child.role = kind === 'streamplot' ? 'streamplot_child_line' : 'scatter_series';
    child.currentProps.color = '#4477aa';
    if (kind === 'streamplot') {
      child.parentId = parent.id;
      child.currentProps.parentOwned = true;
      child.identity!.relation = { subplotId: 'subplot.0', parentId: parent.id };
    }
    const figure = manifest([parent, child], []);

    const fallback = resolvePaletteColorFallbackTargets(
      figure,
      `${kind}-blue`,
      '#4477AA',
      [parent.id],
    );

    expect(fallback.targets.map(item => item.objectId)).toEqual([parent.id]);
    expect(buildPaletteObjectPatches(fallback, '#1188ff')).toEqual([{
      op: 'set',
      mode: 'backend_patch',
      gid: parent.id,
      prop: 'color',
      value: '#1188ff',
    }]);
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

  it('does not use parent-owned histogram bins for rendered-color fallback', () => {
    const histogramChild = object('patch.0.0', 'facecolor', 'histogram-bin', 'local_patch');
    histogramChild.kind = 'patch';
    histogramChild.role = 'histogram_child_patch';
    histogramChild.parentId = 'container.bar.0.0';
    histogramChild.currentProps.facecolor = [0.2666666667, 0.4666666667, 0.6666666667, 1];
    histogramChild.currentProps.parentOwned = true;
    histogramChild.identity!.relation = {
      subplotId: 'subplot.0',
      parentId: histogramChild.parentId,
    };
    const ordinaryPatch = object('patch.0.1', 'facecolor', 'ordinary-patch', 'local_patch');
    ordinaryPatch.kind = 'patch';
    ordinaryPatch.currentProps.facecolor = [0.2666666667, 0.4666666667, 0.6666666667, 1];
    const figure = manifest([histogramChild, ordinaryPatch], []);

    const fallback = resolvePaletteColorFallbackTargets(figure, 'HIST_BLUE', '#4477AA', [
      histogramChild.id,
      ordinaryPatch.id,
    ]);

    expect(fallback.targets.map(item => item.objectId)).toEqual([ordinaryPatch.id]);
  });

  it('limits Python histogram palette bindings to the same semantic series and explicit legend marker relation', () => {
    const histogram = object('histogram.0.0', 'facecolor', 'histogram-series', 'local_patch');
    histogram.kind = 'bar_container' as any;
    histogram.role = 'histogram_series';
    histogram.identity!.semanticKey = 'histogram_series:subplot.0';
    histogram.identity!.relation = {
      subplotId: 'subplot.0',
      legendMarkerIds: ['legend_patch.0.0'],
    };
    const ordinaryBar = object('bar_container.0.0', 'facecolor', 'ordinary-bar-series', 'local_patch');
    ordinaryBar.kind = 'bar_container';
    ordinaryBar.role = 'bar_series';
    const relatedLegendMarker = object('legend_patch.0.0', 'facecolor', 'histogram-series', 'local_patch');
    relatedLegendMarker.kind = 'patch';
    relatedLegendMarker.role = 'legend_marker';
    relatedLegendMarker.identity!.semanticKey = 'legend_marker:histogram-series';
    relatedLegendMarker.identity!.coordinateSpace = 'none';
    relatedLegendMarker.identity!.relation = {
      subplotId: 'subplot.0',
      legendId: 'legend.0',
      parentId: histogram.id,
    };
    const unrelatedLegendMarker = object('legend_line.0.1', 'color', 'unrelated-line-series', 'local_patch');
    unrelatedLegendMarker.kind = 'line';
    unrelatedLegendMarker.role = 'legend_marker';
    unrelatedLegendMarker.identity!.semanticKey = 'legend_marker:unrelated-line-series';
    unrelatedLegendMarker.identity!.coordinateSpace = 'none';
    unrelatedLegendMarker.identity!.relation = {
      subplotId: 'subplot.0',
      legendId: 'legend.0',
    };
    const figure = manifest([
      histogram,
      ordinaryBar,
      relatedLegendMarker,
      unrelatedLegendMarker,
    ], [binding('HIST', [
      target(histogram.id, 'facecolor', 'histogram-series'),
      target(ordinaryBar.id, 'facecolor', 'ordinary-bar-series'),
      target(relatedLegendMarker.id, 'facecolor', 'histogram-series'),
      target(unrelatedLegendMarker.id, 'color', 'unrelated-line-series'),
    ])]);

    const result = resolvePaletteTargets(figure, 'HIST', true);

    expect(result.targets.map(item => item.objectId)).toEqual([
      histogram.id,
      relatedLegendMarker.id,
    ]);
    expect(buildPaletteObjectPatches(result, '#33aa77')).toEqual([
      { op: 'set', mode: 'local_patch', gid: histogram.id, prop: 'facecolor', value: '#33aa77' },
      { op: 'set', mode: 'local_patch', gid: relatedLegendMarker.id, prop: 'facecolor', value: '#33aa77' },
    ]);
  });

  it('limits pie palette bindings to pie slices and their explicit legend markers', () => {
    const pieSlice = object('patch.0.0', 'facecolor', 'pie-a', 'local_patch');
    pieSlice.role = 'pie_slice';
    pieSlice.identity!.relation = {
      subplotId: 'subplot.0',
      legendMarkerIds: ['legend_patch.0.0'],
      pieId: 'pie.0.0',
      sliceIndex: 0,
    } as any;
    const relatedLegend = object('legend_patch.0.0', 'facecolor', 'pie-a', 'local_patch');
    relatedLegend.kind = 'patch';
    relatedLegend.role = 'legend_marker';
    relatedLegend.identity!.relation = {
      subplotId: 'subplot.0', parentId: pieSlice.id, legendId: 'legend.0',
    };
    const ordinaryPatch = object('patch.0.1', 'facecolor', 'ordinary', 'local_patch');
    ordinaryPatch.role = 'bar_series';
    const unrelatedLegend = object('legend_patch.0.1', 'facecolor', 'other', 'local_patch');
    unrelatedLegend.kind = 'patch';
    unrelatedLegend.role = 'legend_marker';
    const figure = manifest([
      pieSlice, relatedLegend, ordinaryPatch, unrelatedLegend,
    ], [binding('PIE_A', [
      target(pieSlice.id, 'facecolor', 'pie-a'),
      target(relatedLegend.id, 'facecolor', 'pie-a'),
      target(ordinaryPatch.id, 'facecolor', 'ordinary'),
      target(unrelatedLegend.id, 'facecolor', 'other'),
    ])]);

    const result = resolvePaletteTargets(figure, 'PIE_A', true);

    expect(result.targets.map(item => item.objectId)).toEqual([pieSlice.id, relatedLegend.id]);
  });

  it('keeps rendered-color fallback inside an explicit pie relation boundary', () => {
    const color = [0.2666666667, 0.4666666667, 0.6666666667, 1];
    const pieSlice = object('patch.0.0', 'facecolor', 'pie-a', 'local_patch');
    pieSlice.role = 'pie_slice';
    pieSlice.currentProps.facecolor = color;
    pieSlice.identity!.relation = {
      subplotId: 'subplot.0', legendMarkerIds: ['legend_patch.0.0'], pieId: 'pie.0.0', sliceIndex: 0,
    } as any;
    const relatedLegend = object('legend_patch.0.0', 'facecolor', 'pie-a', 'local_patch');
    relatedLegend.kind = 'patch';
    relatedLegend.role = 'legend_marker';
    relatedLegend.currentProps.facecolor = color;
    relatedLegend.identity!.relation = { subplotId: 'subplot.0', parentId: pieSlice.id, legendId: 'legend.0' };
    const ordinaryPatch = object('patch.0.1', 'facecolor', 'ordinary', 'local_patch');
    ordinaryPatch.role = 'bar_series';
    ordinaryPatch.currentProps.facecolor = color;
    const unrelatedLegend = object('legend_patch.0.1', 'facecolor', 'other', 'local_patch');
    unrelatedLegend.kind = 'patch';
    unrelatedLegend.role = 'legend_marker';
    unrelatedLegend.currentProps.facecolor = color;
    const figure = manifest([pieSlice, relatedLegend, ordinaryPatch, unrelatedLegend], []);

    const result = resolvePaletteColorFallbackTargets(
      figure,
      'PIE_A',
      '#4477aa',
      [pieSlice.id, relatedLegend.id, ordinaryPatch.id, unrelatedLegend.id],
    );

    expect(result.targets.map(item => item.objectId)).toEqual([pieSlice.id, relatedLegend.id]);
  });

  it('does not emit rendered-color fallback for a pie slice color omitted from modern capabilities', () => {
    const color = [0.2666666667, 0.4666666667, 0.6666666667, 1];
    const pieSlice = object('patch.0.0', 'edgecolor', 'pie-a', 'local_patch');
    pieSlice.role = 'pie_slice';
    pieSlice.currentProps.facecolor = color;
    pieSlice.currentProps.edgecolor = '#000000';
    pieSlice.identity!.relation = {
      subplotId: 'subplot.0', legendMarkerIds: ['legend_patch.0.0'], pieId: 'pie.0.0', sliceIndex: 0,
    } as any;
    const relatedLegend = object('legend_patch.0.0', 'facecolor', 'pie-a', 'local_patch');
    relatedLegend.kind = 'patch';
    relatedLegend.role = 'legend_marker';
    relatedLegend.currentProps.facecolor = color;
    relatedLegend.identity!.relation = { subplotId: 'subplot.0', parentId: pieSlice.id, legendId: 'legend.0' };
    const figure = manifest([pieSlice, relatedLegend], []);

    const result = resolvePaletteColorFallbackTargets(
      figure,
      'PIE_A',
      '#4477aa',
      [pieSlice.id, relatedLegend.id],
    );

    expect(result.targets.map(item => `${item.objectId}:${item.prop}`)).toEqual([`${relatedLegend.id}:facecolor`]);
    expect(result.targets.some(item => item.objectId === pieSlice.id && item.prop === 'facecolor')).toBe(false);
  });

  it('fails closed for unscoped diagram palette bindings that span another diagram object or ordinary artist', () => {
    const latent = diagramObject('patch.0.10', 'diagram_node', 'facecolor', 'sem.demo', 'latent_a');
    const observed = diagramObject('patch.0.11', 'diagram_node', 'facecolor', 'sem.demo', 'observed_b');
    const ordinary = object('patch.0.12', 'facecolor', 'ordinary-node-color', 'backend_patch');
    const figure = manifest([latent, observed, ordinary], [binding('NODE_BLUE', [
      target(latent.id, 'facecolor', latent.identity!.seriesKey!),
      target(observed.id, 'facecolor', observed.identity!.seriesKey!),
      target(ordinary.id, 'facecolor', 'ordinary-node-color'),
    ])]);

    const unscoped = resolvePaletteTargets(figure, 'NODE_BLUE', true);
    expect(unscoped.targets).toEqual([]);
    expect(unscoped.ambiguous[0]?.reason).toBe('ambiguous_binding');

    const selected = resolvePaletteTargets(figure, 'NODE_BLUE', true, [latent.id]);
    expect(selected.targets.map(item => item.objectId)).toEqual([latent.id]);
    expect(buildPaletteObjectPatches(selected, '#118833')).toEqual([{
      op: 'set',
      mode: 'backend_patch',
      gid: latent.id,
      prop: 'facecolor',
      value: '#118833',
    }]);
  });

  it('allows a diagram edge palette to include only the explicitly linked arrow', () => {
    const edge = diagramObject('line.0.10', 'diagram_edge', 'color', 'sem.demo', 'latent_a_to_observed_b', {
      edgeId: 'latent_a_to_observed_b',
      sourceNodeId: 'latent_a',
      targetNodeId: 'observed_b',
    });
    const arrow = diagramObject('patch.0.13', 'diagram_arrow', 'edgecolor', 'sem.demo', 'arrow_a_b', {
      edgeId: 'latent_a_to_observed_b',
      sourceNodeId: 'latent_a',
      targetNodeId: 'observed_b',
    });
    const unrelatedArrow = diagramObject('patch.0.14', 'diagram_arrow', 'edgecolor', 'sem.demo', 'arrow_other', {
      edgeId: 'other_edge',
      sourceNodeId: 'latent_a',
      targetNodeId: 'other_node',
    });
    const ordinary = object('line.0.11', 'color', 'ordinary-edge-color', 'backend_patch');
    const figure = manifest([edge, arrow, unrelatedArrow, ordinary], [binding('EDGE_GRAY', [
      target(edge.id, 'color', edge.identity!.seriesKey!),
      target(arrow.id, 'edgecolor', arrow.identity!.seriesKey!),
      target(unrelatedArrow.id, 'edgecolor', unrelatedArrow.identity!.seriesKey!),
      target(ordinary.id, 'color', 'ordinary-edge-color'),
    ])]);

    const unscoped = resolvePaletteTargets(figure, 'EDGE_GRAY', true);
    expect(unscoped.targets).toEqual([]);
    expect(unscoped.ambiguous[0]?.reason).toBe('ambiguous_binding');

    const linkedOnly = resolvePaletteTargets(figure, 'EDGE_GRAY', true, [edge.id, arrow.id]);
    expect(linkedOnly.targets.map(item => item.objectId)).toEqual([edge.id, arrow.id]);
  });

  it('does not rendered-color fallback from a selected diagram object to same-color ordinary artists', () => {
    const diagramNode = diagramObject('patch.0.20', 'diagram_node', 'facecolor', 'sem.demo', 'latent_a');
    diagramNode.currentProps.facecolor = '#4477aa';
    const ordinary = object('patch.0.21', 'facecolor', 'ordinary-node-color', 'backend_patch');
    ordinary.currentProps.facecolor = '#4477aa';
    const figure = manifest([diagramNode, ordinary], []);

    const fallback = resolvePaletteColorFallbackTargets(figure, 'NODE_BLUE', '#4477aa', [
      diagramNode.id,
      ordinary.id,
    ]);

    expect(fallback.targets).toEqual([]);
    expect(buildPaletteObjectPatches(fallback, '#118833')).toEqual([]);
  });
});
