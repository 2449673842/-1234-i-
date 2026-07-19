import { describe, expect, it } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import { inferEditingTargetRole } from './editingIntentCompiler';
import { compileEditingIntentStrict } from './targetResolver';

function complexObject(input: {
  id: string;
  kind: string;
  role: string;
  prop: string;
}): ManifestObject {
  return {
    id: input.id,
    kind: input.kind,
    role: input.role,
    label: input.id,
    editable: [input.prop],
    currentProps: { [input.prop]: 0.5 },
    stableKey: `ax0.${input.kind}.label.${input.id}`,
    fingerprint: `fingerprint-${input.id}`,
    fingerprintVersion: 2,
    identity: {
      semanticKey: `${input.role}:subplot.0`,
      instanceKey: `subplot:${input.id}`,
      seriesKey: `${input.kind}:${input.id}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: { subplotId: 'subplot.0' },
    },
    propertyCapabilities: [{
      prop: input.prop,
      patchMode: 'local_patch',
      scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
      preview: 'exact',
      replay: 'stable',
    }],
  } as ManifestObject;
}

function manifestWith(objects: ManifestObject[]): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects,
    colorGroups: [],
    palettes: [],
    groups: [],
    bindings: [],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  } as Manifest;
}

function styleIntentFor(targetRole: string, prop: string, value: unknown): EditingIntent {
  return {
    intent: 'style.component',
    scope: {
      selectionMode: 'role_in_figure',
      targetRole,
    },
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  } as unknown as EditingIntent;
}

describe('Python complex artist target roles', () => {
  it('keeps fill_between separate from generic collection targets', () => {
    const band = complexObject({
      id: 'fill_between.0.0',
      kind: 'fill_between',
      role: 'fill_between_series',
      prop: 'alpha',
    });
    const points = complexObject({
      id: 'collection.0.1',
      kind: 'collection',
      role: 'scatter_series',
      prop: 'alpha',
    });
    const manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [band, points],
      colorGroups: [],
      palettes: [],
      groups: [],
      bindings: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    } as Manifest;
    const intent = {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'data_band',
      },
      operation: { prop: 'alpha', value: 0.25 },
      commit: { mode: 'draft', applyAsOneHistoryStep: true },
      fallback: { onUnsupported: 'skip_with_warning' },
    } satisfies EditingIntent;

    expect(inferEditingTargetRole(band)).toBe('data_band');
    expect(inferEditingTargetRole(points)).toBe('data_point');
    const result = compileEditingIntentStrict(manifest, intent);
    expect(result.patches.map(patch => ('gid' in patch ? patch.gid : 'code'))).toEqual([
      'fill_between.0.0',
    ]);
  });

  it('routes contour parents through dedicated contour targets without selecting collections', () => {
    const contour = complexObject({
      id: 'contour.0.0',
      kind: 'contour',
      role: 'contour_series',
      prop: 'cmap',
    });
    contour.propertyCapabilities![0]!.patchMode = 'backend_patch';
    contour.propertyCapabilities![0]!.preview = 'none';
    const childCollection = complexObject({
      id: 'collection.0.10',
      kind: 'collection',
      role: 'contour_child_collection',
      prop: 'cmap',
    });
    childCollection.parentId = contour.id;
    childCollection.identity!.relation = { subplotId: 'subplot.0', parentId: contour.id };
    const scatter = complexObject({
      id: 'collection.0.11',
      kind: 'collection',
      role: 'scatter_series',
      prop: 'cmap',
    });
    const manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [contour, childCollection, scatter],
      colorGroups: [],
      palettes: [],
      groups: [],
      bindings: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    } as Manifest;
    const intent = {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'data_contour',
      },
      operation: { prop: 'cmap', value: 'viridis' },
      commit: { mode: 'draft', applyAsOneHistoryStep: true },
      fallback: { onUnsupported: 'skip_with_warning' },
    } as EditingIntent;

    expect(inferEditingTargetRole(contour)).toBe('data_contour');
    expect(inferEditingTargetRole(childCollection)).toBe('component');
    expect(inferEditingTargetRole(scatter)).toBe('data_point');
    const result = compileEditingIntentStrict(manifest, intent);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: contour.id, prop: 'cmap', value: 'viridis' },
    ]);
  });

  it('routes contourf parents through dedicated filled-contour targets', () => {
    const contourf = complexObject({
      id: 'contourf.0.0',
      kind: 'contourf',
      role: 'contourf_series',
      prop: 'alpha',
    });
    contourf.propertyCapabilities![0]!.patchMode = 'backend_patch';
    contourf.propertyCapabilities![0]!.preview = 'none';
    const manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [contourf],
      colorGroups: [],
      palettes: [],
      groups: [],
      bindings: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    } as Manifest;
    const intent = {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'data_contourf',
      },
      operation: { prop: 'alpha', value: 0.5 },
      commit: { mode: 'draft', applyAsOneHistoryStep: true },
      fallback: { onUnsupported: 'skip_with_warning' },
    } as EditingIntent;

    expect(inferEditingTargetRole(contourf)).toBe('data_contourf');
    const result = compileEditingIntentStrict(manifest, intent);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: contourf.id, prop: 'alpha', value: 0.5 },
    ]);
  });

  it.each([
    ['data_histogram', 'histogram.0.0', 'bar_container', 'histogram_series', 'facecolor'],
    ['data_stairs', 'stairs.0.0', 'patch', 'stairs_series', 'edgecolor'],
    ['data_step', 'step.0.0', 'line', 'step_series', 'color'],
  ])('routes %s only to its dedicated Python series role', (
    targetRole,
    targetId,
    targetKind,
    seriesRole,
    prop,
  ) => {
    const dedicatedSeries = complexObject({
      id: targetId,
      kind: targetKind,
      role: seriesRole,
      prop,
    });
    const ordinaryBar = complexObject({
      id: 'bar_container.0.0',
      kind: 'bar_container',
      role: 'bar_series',
      prop,
    });
    const ordinaryPatch = complexObject({
      id: 'patch.0.0',
      kind: 'patch',
      role: 'patch',
      prop,
    });
    const ordinaryLine = complexObject({
      id: 'line.0.0',
      kind: 'line',
      role: 'line_series',
      prop,
    });
    const legendMarker = complexObject({
      id: 'legend_line.0.0',
      kind: 'line',
      role: 'legend_marker',
      prop,
    });
    const manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [dedicatedSeries, ordinaryBar, ordinaryPatch, ordinaryLine, legendMarker],
      colorGroups: [],
      palettes: [],
      groups: [],
      bindings: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    } as Manifest;
    const intent = {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole,
      },
      operation: { prop, value: '#118833' },
      commit: { mode: 'draft', applyAsOneHistoryStep: true },
      fallback: { onUnsupported: 'skip_with_warning' },
    } as EditingIntent;

    expect(inferEditingTargetRole(dedicatedSeries)).toBe(targetRole);
    expect(compileEditingIntentStrict(manifest, intent).patches).toEqual([
      { op: 'set', mode: 'local_patch', gid: targetId, prop, value: '#118833' },
    ]);
  });

  it('routes data_quiver only to dedicated quiver fields', () => {
    const quiver = complexObject({
      id: 'collection.0.2',
      kind: 'quiver',
      role: 'quiver_field',
      prop: 'color',
    });
    quiver.propertyCapabilities![0]!.patchMode = 'backend_patch';
    quiver.propertyCapabilities![0]!.preview = 'none';
    const scatter = complexObject({
      id: 'collection.0.3',
      kind: 'collection',
      role: 'scatter_series',
      prop: 'color',
    });
    const genericCollection = complexObject({
      id: 'collection.0.4',
      kind: 'collection',
      role: 'collection',
      prop: 'color',
    });
    const manifest = manifestWith([quiver, scatter, genericCollection]);
    const intent = styleIntentFor('data_quiver', 'color', '#118833');

    expect(inferEditingTargetRole(quiver)).toBe('data_quiver');
    expect(inferEditingTargetRole(scatter)).toBe('data_point');
    expect(inferEditingTargetRole(genericCollection)).toBe('data_point');
    expect(compileEditingIntentStrict(manifest, intent).patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: quiver.id, prop: 'color', value: '#118833' },
    ]);
  });

  it('routes data_streamplot only to dedicated streamplot parents', () => {
    const streamplot = complexObject({
      id: 'container.streamplot.0.0',
      kind: 'streamplot',
      role: 'streamplot_field',
      prop: 'color',
    });
    streamplot.propertyCapabilities![0]!.patchMode = 'backend_patch';
    streamplot.propertyCapabilities![0]!.preview = 'none';
    const lineChild = complexObject({
      id: 'collection.0.2',
      kind: 'collection',
      role: 'streamplot_child_line',
      prop: 'color',
    });
    lineChild.parentId = streamplot.id;
    lineChild.editable = [];
    lineChild.propertyCapabilities = [];
    lineChild.identity!.relation = { subplotId: 'subplot.0', parentId: streamplot.id };
    const arrowChild = complexObject({
      id: 'patch.0.3',
      kind: 'patch',
      role: 'streamplot_child_arrow',
      prop: 'color',
    });
    arrowChild.parentId = streamplot.id;
    arrowChild.editable = [];
    arrowChild.propertyCapabilities = [];
    arrowChild.identity!.relation = { subplotId: 'subplot.0', parentId: streamplot.id };
    const ordinaryCollection = complexObject({
      id: 'collection.0.4',
      kind: 'collection',
      role: 'collection',
      prop: 'color',
    });
    const ordinaryPatch = complexObject({
      id: 'patch.0.5',
      kind: 'patch',
      role: 'patch',
      prop: 'color',
    });
    const manifest = manifestWith([
      streamplot,
      lineChild,
      arrowChild,
      ordinaryCollection,
      ordinaryPatch,
    ]);
    const intent = styleIntentFor('data_streamplot', 'color', '#118833');

    expect(inferEditingTargetRole(streamplot)).toBe('data_streamplot');
    expect(inferEditingTargetRole(lineChild)).toBe('component');
    expect(inferEditingTargetRole(arrowChild)).toBe('component');
    expect(inferEditingTargetRole(ordinaryCollection)).toBe('data_point');
    expect(inferEditingTargetRole(ordinaryPatch)).toBe('data_patch');
    expect(compileEditingIntentStrict(manifest, intent).patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: streamplot.id, prop: 'color', value: '#118833' },
    ]);
  });

  it.each([
    ['diagram_node', 'patch.0.0', 'patch', 'facecolor'],
    ['diagram_edge', 'line.0.0', 'line', 'color'],
    ['diagram_arrow', 'patch.0.1', 'patch', 'edgecolor'],
    ['diagram_node_label', 'text.0.0', 'text', 'fontsize'],
    ['diagram_coefficient_label', 'text.0.1', 'text', 'color'],
    ['diagram_fit_annotation', 'text.0.2', 'text', 'fontweight'],
    ['diagram_group', 'patch.0.2', 'patch', 'alpha'],
  ])('routes %s only to its explicitly declared diagram role', (
    targetRole,
    targetId,
    targetKind,
    prop,
  ) => {
    const dedicated = complexObject({
      id: targetId,
      kind: targetKind,
      role: targetRole,
      prop,
    });
    dedicated.propertyCapabilities![0]!.patchMode = 'backend_patch';
    dedicated.propertyCapabilities![0]!.preview = 'none';
    dedicated.identity!.relation = {
      subplotId: 'subplot.0',
      diagramId: 'sem.demo',
      diagramType: 'sem',
      diagramObjectId: targetId,
    };
    const ordinary = complexObject({
      id: `${targetKind}.0.9`,
      kind: targetKind,
      role: targetKind === 'text' ? 'annotation_text' : `${targetKind}_series`,
      prop,
    });
    const manifest = manifestWith([dedicated, ordinary]);
    const intent = styleIntentFor(targetRole, prop, '#118833');

    expect(inferEditingTargetRole(dedicated)).toBe(targetRole);
    expect(inferEditingTargetRole(ordinary)).not.toBe(targetRole);
    expect(compileEditingIntentStrict(manifest, intent).patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: targetId, prop, value: '#118833' },
    ]);
  });
});
