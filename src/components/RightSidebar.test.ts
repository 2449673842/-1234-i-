import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import {
  buildSupportedSidebarPatchEntry,
  buildSupportedObjectPatchEntries,
  buildContinuousPaletteCenterGroups,
  buildDiagramComponentGroups,
  buildFontCenterGroups,
  buildRadarComponentGroups,
  colormapOptionsFor,
  componentColorTargets,
  isDedicatedDiagramComponentObject,
  isRadarSemanticObject,
  radarComponentTargetRole,
  supportsComponentBatchProp,
  supportsIndependentSubplotLayout,
  supportsSubplotBoundProp,
} from './RightSidebar';

function continuousObject(
  id: string,
  kind: ManifestObject['kind'],
  scaleId: string,
  subplotIds: string[],
  editable: string[] = ['cmap', 'vmin', 'vmax'],
): ManifestObject {
  return {
    id,
    kind,
    label: id,
    editable,
    currentProps: { cmap: 'viridis', vmin: 0, vmax: 1 },
    identity: {
      relation: {
        scaleId,
        aesthetic: 'fill',
        subplotIds,
      },
    },
  } as ManifestObject;
}

describe('RightSidebar colormap controls', () => {
  it('preserves the rendered colormap even when it is outside the curated list', () => {
    expect(colormapOptionsFor('custom_lab_map')[0]).toBe('custom_lab_map');
    expect(colormapOptionsFor('custom_lab_map')).toContain('viridis');
  });

  it('offers common scientific diverging colormaps without duplicating the current value', () => {
    const options = colormapOptionsFor('RdBu_r');
    expect(options).toContain('RdBu_r');
    expect(options).toContain('Spectral_r');
    expect(options.filter(value => value === 'RdBu_r')).toHaveLength(1);
  });

  it('deduplicates continuous heatmap and contour authorities by scale identity', () => {
    const groups = buildContinuousPaletteCenterGroups([
      continuousObject('r.heatmap.fill.0', 'heatmap', 'r.scale.fill.continuous.0', ['subplot.0']),
      continuousObject('r.layer.0', 'contourf', 'r.scale.fill.continuous.0', ['subplot.0']),
      continuousObject('r.layer.1', 'contour', 'r.scale.color.continuous.1', ['subplot.1']),
      continuousObject('r.colorbar.fill.0', 'colorbar', 'r.scale.fill.continuous.0', ['subplot.0'], ['visible']),
    ], 'all', 'r_svg');

    expect(groups.map(group => group.scaleId)).toEqual([
      'r.scale.fill.continuous.0',
      'r.scale.color.continuous.1',
    ]);
    expect(groups[0].objects.map(object => object.id)).toEqual([
      'r.heatmap.fill.0',
      'r.layer.0',
    ]);
    expect(groups.flatMap(group => group.objects.map(object => object.kind))).not.toContain('colorbar');
  });

  it('respects subplot scope and withholds cross-subplot shared scales', () => {
    const objects = [
      continuousObject('heatmap.0', 'heatmap', 'scale.0', ['subplot.0']),
      continuousObject('heatmap.1', 'heatmap', 'scale.1', ['subplot.1']),
      continuousObject('heatmap.shared', 'heatmap', 'scale.shared', ['subplot.0', 'subplot.1']),
    ];

    expect(buildContinuousPaletteCenterGroups(objects, 'subplot.0').map(group => group.scaleId)).toEqual(['scale.0']);
    expect(buildContinuousPaletteCenterGroups(objects, 'subplot.1').map(group => group.scaleId)).toEqual(['scale.1']);
    expect(buildContinuousPaletteCenterGroups(objects, 'all').find(group => group.scaleId === 'scale.shared'))
      .toMatchObject({ sharedAcrossSubplots: true, subplotIds: ['subplot.0', 'subplot.1'] });
  });

  it('does not expose a v2 R object whose renderer declares no continuous-scale capability', () => {
    const unsupported = continuousObject('heatmap.readonly', 'heatmap', 'scale.readonly', ['subplot.0'], []);
    unsupported.fingerprintVersion = 2;
    unsupported.propertyCapabilities = [];

    expect(buildContinuousPaletteCenterGroups([unsupported], 'all', 'r_svg')).toEqual([]);
  });
});

describe('RightSidebar component color controls', () => {
  it('does not render a layer fill control when R fill is owned by a discrete scale', () => {
    const mappedRibbon = {
      id: 'r.layer.2',
      kind: 'patch',
      label: 'ggplot ribbon layer 3',
      editable: ['facecolor', 'edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        adapterFamily: 'ribbon',
        facecolor: '#92C5DE',
        edgecolor: '#2166AC',
        fillMapped: true,
      },
      propertyCapabilities: ['facecolor', 'edgecolor', 'linewidth', 'alpha'].map(prop => ({
        prop,
        patchMode: 'backend_patch' as const,
        scopes: ['object' as const],
        preview: 'none' as const,
        replay: 'stable' as const,
      })),
    } as ManifestObject;

    expect(componentColorTargets([mappedRibbon], 'facecolor', 'r_svg')).toEqual([]);
    expect(componentColorTargets([mappedRibbon], 'edgecolor', 'r_svg')).toEqual([mappedRibbon]);
  });
});

describe('RightSidebar radar semantic ownership', () => {
  it('keeps every radar semantic role out of generic line and patch controls', () => {
    expect(isRadarSemanticObject({ currentProps: { radarSemanticRole: 'series' } })).toBe(true);
    expect(isRadarSemanticObject({ currentProps: { radarSemanticRole: 'fill_layer' } })).toBe(true);
    expect(isRadarSemanticObject({ currentProps: { radarSemanticRole: 'dimension_label' } })).toBe(true);
    expect(isRadarSemanticObject({ currentProps: {} })).toBe(false);
  });

  it('keeps R scale-backed radar series editable and isolated to the selected subplot', () => {
    const radarObject = (
      id: string,
      kind: 'line' | 'patch',
      role: 'series' | 'fill',
      subplotId: string,
    ): ManifestObject => ({
      id,
      kind,
      label: id,
      editable: [role === 'series' ? 'color' : 'facecolor'],
      currentProps: {
        radarSemanticRole: role,
        radarId: `radar.${subplotId}`,
        radarSeriesId: `radar.${subplotId}.series.Control`,
        ...(role === 'series' ? { color: '#006D5B' } : { facecolor: '#6FCF97' }),
      },
      role: role === 'series' ? 'ggplot_scale_color' : 'ggplot_scale_fill',
      identity: {
        relation: {
          subplotId,
          subplotIds: [subplotId],
          legendId: 'legend.0',
          scaleId: role === 'series' ? 'r.scale.color.0' : 'r.scale.fill.0',
          radarSemanticRole: role,
        },
      },
      propertyCapabilities: [{
        prop: role === 'series' ? 'color' : 'facecolor',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject);

    const panel0Line = radarObject('r.group.color.0.0', 'line', 'series', 'subplot.0');
    const panel0Fill = radarObject('r.group.fill.0.0', 'patch', 'fill', 'subplot.0');
    const panel1Line = radarObject('r.group.color.1.0', 'line', 'series', 'subplot.1');
    const panel1Fill = radarObject('r.group.fill.1.0', 'patch', 'fill', 'subplot.1');

    const panel0Groups = buildRadarComponentGroups(
      [panel0Line, panel0Fill, panel1Line, panel1Fill],
      'subplot.0',
    );

    expect(panel0Groups.map(group => ({
      id: group.id,
      objectIds: group.objects.map(object => object.id),
    }))).toEqual([
      { id: 'radarLines', objectIds: [panel0Line.id] },
      { id: 'radarFills', objectIds: [panel0Fill.id] },
    ]);
    expect(panel0Groups.flatMap(group => group.objects)).not.toContain(panel1Line);
    expect(panel0Groups.flatMap(group => group.objects)).not.toContain(panel1Fill);
    expect(radarComponentTargetRole([panel0Line])).toBe('data_line');
    expect(radarComponentTargetRole([panel0Fill])).toBe('data_patch');
  });
});

function manifestObject(id: string, kind: ManifestObject['kind'], role?: string): ManifestObject {
  return {
    id,
    kind,
    label: id,
    editable: ['color', 'facecolor', 'edgecolor', 'linewidth', 'fontsize'],
    currentProps: {},
    ...(role ? { role } : {}),
    identity: {
      relation: {
        diagramId: 'sem.demo',
        diagramType: 'sem',
        diagramObjectId: id,
      } as ManifestObject['identity']['relation'],
    },
  };
}

function fontObject(
  id: string,
  kind: ManifestObject['kind'],
  role?: string,
  subplotId?: string,
): ManifestObject {
  return {
    id,
    kind,
    label: id,
    editable: ['fontsize', 'fontfamily', 'fontweight', 'fontstyle', 'color'],
    currentProps: { fontsize: 9, fontfamily: 'Arial', fontweight: 'normal', fontstyle: 'normal', color: '#000000' },
    ...(role ? { role } : {}),
    identity: {
      relation: {
        ...(subplotId ? { subplotId } : {}),
      },
    },
  } as ManifestObject;
}

describe('RightSidebar font center legend classification', () => {
  it('keeps legend containers out of text groups and separates legend titles from legend text', () => {
    const groups = buildFontCenterGroups([
      fontObject('legend.0', 'legend', 'legend'),
      fontObject('legend.0.extra.0', 'legend', 'legend'),
      fontObject('legend_title.0', 'text', 'legend_text'),
      fontObject('legend_title.0.extra.0', 'text', 'legend_text'),
      fontObject('legend_text.0.0', 'text', 'legend_text'),
      fontObject('legend_text.0.1', 'text', 'legend_text'),
      fontObject('legend_text.0.2', 'text', 'legend_text'),
      fontObject('legend_text.0.extra.0.0', 'text', 'legend_text'),
      fontObject('legend_text.0.extra.0.1', 'text', 'legend_text'),
    ]);

    const byId = new Map(groups.map(group => [group.id, group]));

    expect(byId.get('legend_title')?.label).toBe('图例标题');
    expect(byId.get('legend_title')?.objects.map(object => object.id)).toEqual([
      'legend_title.0',
      'legend_title.0.extra.0',
    ]);
    expect(byId.get('legend_text')?.label).toBe('图例文字');
    expect(byId.get('legend_text')?.objects.map(object => object.id)).toEqual([
      'legend_text.0.0',
      'legend_text.0.1',
      'legend_text.0.2',
      'legend_text.0.extra.0.0',
      'legend_text.0.extra.0.1',
    ]);
    expect(groups.flatMap(group => group.objects.map(object => object.id))).not.toContain('legend.0');
    expect(groups.flatMap(group => group.objects.map(object => object.id))).not.toContain('legend.0.extra.0');
  });

  it('preserves subplot scope when selecting legend title and legend text groups', () => {
    const groups = buildFontCenterGroups([
      fontObject('legend_title.0', 'text', 'legend_text', 'subplot.0'),
      fontObject('legend_text.0.0', 'text', 'legend_text', 'subplot.0'),
      fontObject('legend_title.1', 'text', 'legend_text', 'subplot.1'),
      fontObject('legend_text.1.0', 'text', 'legend_text', 'subplot.1'),
      fontObject('legend.0', 'legend', 'legend', 'subplot.0'),
      fontObject('legend.1', 'legend', 'legend', 'subplot.1'),
    ], 'subplot.0');

    expect(groups.map(group => ({
      id: group.id,
      objectIds: group.objects.map(object => object.id),
    }))).toEqual([
      { id: 'legend_title', objectIds: ['legend_title.0'] },
      { id: 'legend_text', objectIds: ['legend_text.0.0'] },
    ]);
  });
});

describe('RightSidebar diagram component center groups', () => {
  it('creates distinct Chinese-labeled groups for diagram semantic roles', () => {
    const groups = buildDiagramComponentGroups([
      manifestObject('diagram.group.0', 'container', 'diagram_group'),
      manifestObject('patch.node.0', 'patch', 'diagram_node'),
      manifestObject('line.edge.0', 'line', 'diagram_edge'),
      manifestObject('patch.arrow.0', 'patch', 'diagram_arrow'),
      manifestObject('text.node.0', 'text', 'diagram_node_label'),
      manifestObject('text.coefficient.0', 'text', 'diagram_coefficient_label'),
      manifestObject('text.fit.0', 'text', 'diagram_fit_annotation'),
    ]);

    expect(groups.map(group => ({
      id: group.id,
      label: group.label,
      objectIds: group.objects.map(object => object.id),
    }))).toEqual([
      { id: 'diagramGroups', label: '图示 / SEM 整体组', objectIds: ['diagram.group.0'] },
      { id: 'diagramNodes', label: '图示节点', objectIds: ['patch.node.0'] },
      { id: 'diagramEdges', label: '图示连线 / 路径', objectIds: ['line.edge.0'] },
      { id: 'diagramArrows', label: '图示箭头', objectIds: ['patch.arrow.0'] },
      { id: 'diagramNodeLabels', label: '图示节点标签', objectIds: ['text.node.0'] },
      { id: 'diagramCoefficientLabels', label: '路径系数标签', objectIds: ['text.coefficient.0'] },
      { id: 'diagramFitAnnotations', label: '模型拟合注释', objectIds: ['text.fit.0'] },
    ]);
  });

  it('marks diagram semantic objects as dedicated instead of generic component objects', () => {
    const dedicated = [
      manifestObject('patch.node.0', 'patch', 'diagram_node'),
      manifestObject('line.edge.0', 'line', 'diagram_edge'),
      manifestObject('patch.arrow.0', 'patch', 'diagram_arrow'),
      manifestObject('text.node.0', 'text', 'diagram_node_label'),
      manifestObject('text.coefficient.0', 'text', 'diagram_coefficient_label'),
      manifestObject('text.fit.0', 'text', 'diagram_fit_annotation'),
      manifestObject('diagram.group.0', 'container', 'diagram_group'),
    ];

    expect(dedicated.every(isDedicatedDiagramComponentObject)).toBe(true);
    expect(isDedicatedDiagramComponentObject(manifestObject('text.ordinary', 'text'))).toBe(false);
    expect(isDedicatedDiagramComponentObject(manifestObject('line.ordinary', 'line'))).toBe(false);
    expect(isDedicatedDiagramComponentObject(manifestObject('patch.ordinary', 'patch'))).toBe(false);
    expect(isDedicatedDiagramComponentObject(manifestObject('collection.ordinary', 'collection'))).toBe(false);
  });

  it('keeps diagram groups behind the component target resolver v2 gate', () => {
    const groups = buildDiagramComponentGroups([
      manifestObject('patch.node.0', 'patch', 'diagram_node'),
    ], false);

    expect(groups).toEqual([]);
  });
});

describe('RightSidebar subplot bound capability gates', () => {
  it('uses propertyCapabilities as the modern per-bound authority', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'subplot.0',
      editable: ['left', 'bottom', 'width', 'height'],
      currentProps: { left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    expect(supportsSubplotBoundProp(subplot, 'width')).toBe(true);
    expect(supportsSubplotBoundProp(subplot, 'left')).toBe(false);
    expect(supportsSubplotBoundProp(subplot, 'bottom')).toBe(false);
    expect(supportsSubplotBoundProp(subplot, 'height')).toBe(false);
  });

  it('keeps legacy subplot bound fallback when capability metadata is absent', () => {
    const legacySubplot = {
      id: 'subplot.legacy',
      kind: 'subplot',
      label: 'subplot.legacy',
      editable: ['left', 'height'],
      currentProps: { left: 0.1, height: 0.8 },
    } as ManifestObject;

    expect(supportsSubplotBoundProp(legacySubplot, 'left')).toBe(true);
    expect(supportsSubplotBoundProp(legacySubplot, 'height')).toBe(true);
    expect(supportsSubplotBoundProp(legacySubplot, 'width')).toBe(false);
  });
});

describe('RightSidebar component center capability gates', () => {
  it('keeps declared global fields editable while rejecting unknown globals', () => {
    const manifest: Manifest = {
      generatedBy: 'introspection',
      globals: {
        'figure.width_in': { type: 'number', value: 6, min: 1, max: 20, step: 0.1 },
      },
      objects: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, 'global', 'figure.width_in', 7)).toEqual({
      op: 'set',
      gid: 'global',
      prop: 'figure.width_in',
      value: 7,
      mode: 'backend_patch',
    });
    expect(buildSupportedSidebarPatchEntry(manifest, 'global', 'figure.unknown', 7)).toBeNull();
  });

  it('accepts a layout patch only through the renderer-declared figure scope', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'R plot panel',
      editable: ['aspect'],
      currentProps: { aspect: 'auto' },
      propertyCapabilities: [{
        prop: 'aspect',
        patchMode: 'backend_patch',
        scopes: ['figure'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const manifest: Manifest = {
      generatedBy: 'r_svg',
      globals: {},
      objects: [subplot],
      capabilities: { localPatch: false, backendPatch: true, codePatch: false },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, subplot.id, 'aspect', 'equal')).toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, subplot.id, 'aspect', 'equal', 'figure')).toEqual({
      op: 'set',
      gid: subplot.id,
      prop: 'aspect',
      value: 'equal',
      mode: 'backend_patch',
    });
  });

  it('blocks direct and immediate object patches omitted from modern capabilities', () => {
    const line = {
      id: 'line.0',
      kind: 'line',
      label: 'line.0',
      editable: ['color', 'linewidth'],
      currentProps: { color: '#000000', linewidth: 1 },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const manifest: Manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [line],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, line.id, 'color', '#ff0000')).toMatchObject({
      gid: line.id,
      prop: 'color',
      mode: 'backend_patch',
    });
    expect(buildSupportedSidebarPatchEntry(manifest, line.id, 'linewidth', 2)).toBeNull();
  });

  it('filters axis and spine preset properties through the same target gate', () => {
    const axis = {
      id: 'axis.x.0',
      kind: 'axis_x',
      label: 'axis.x.0',
      editable: ['tick_direction', 'tick_length'],
      currentProps: {},
      propertyCapabilities: [{
        prop: 'tick_direction',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const spine = {
      id: 'spine_group.0',
      kind: 'spine_group',
      label: 'spine_group.0',
      editable: ['color', 'linewidth'],
      currentProps: {},
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const manifest: Manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [axis, spine],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, axis.id, 'tick_direction', 'in')).not.toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, axis.id, 'tick_length', 5)).toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, spine.id, 'color', '#112233')).not.toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, spine.id, 'linewidth', 2)).toBeNull();
  });

  it('filters batch patch candidates through modern property capabilities', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'subplot.0',
      editable: ['left', 'width'],
      currentProps: { left: 0.1, width: 0.8 },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    const patches = buildSupportedObjectPatchEntries({
      generatedBy: 'introspection',
      globals: {},
      objects: [subplot],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    }, subplot, [
      { prop: 'left', value: 0.2 },
      { prop: 'width', value: 0.7 },
    ]);

    expect(patches).toEqual([{
      op: 'set',
      gid: subplot.id,
      prop: 'width',
      value: 0.7,
      mode: 'backend_patch',
    }]);
  });

  it('uses propertyCapabilities as the modern per-prop authority for subplot batch controls', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'subplot.0',
      editable: ['left', 'bottom', 'width', 'height', 'aspect'],
      currentProps: {
        left: 0.1,
        bottom: 0.1,
        width: 0.8,
        height: 0.8,
        aspect: 'auto',
      },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    expect(supportsComponentBatchProp(subplot, 'width')).toBe(true);
    expect(supportsComponentBatchProp(subplot, 'left')).toBe(false);
    expect(supportsComponentBatchProp(subplot, 'bottom')).toBe(false);
    expect(supportsComponentBatchProp(subplot, 'height')).toBe(false);
    expect(supportsComponentBatchProp(subplot, 'aspect')).toBe(false);
  });

  it('keeps legacy component center subplot bounds editable without propertyCapabilities', () => {
    const legacySubplot = {
      id: 'subplot.legacy',
      kind: 'subplot',
      label: 'subplot.legacy',
      editable: ['left'],
      currentProps: { left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 },
    } as ManifestObject;

    expect(supportsComponentBatchProp(legacySubplot, 'left')).toBe(true);
    expect(supportsComponentBatchProp(legacySubplot, 'bottom')).toBe(true);
    expect(supportsComponentBatchProp(legacySubplot, 'width')).toBe(true);
    expect(supportsComponentBatchProp(legacySubplot, 'height')).toBe(true);
  });

  it('only exposes whole-layout rearrangement when every subplot has authoritative physical bounds', () => {
    const capableSubplot = (id: string) => ({
      id,
      kind: 'subplot',
      label: id,
      editable: ['left', 'bottom', 'width', 'height'],
      currentProps: { left: 0.1, bottom: 0.1, width: 0.35, height: 0.35 },
      propertyCapabilities: ['left', 'bottom', 'width', 'height'].map(prop => ({
        prop,
        patchMode: 'backend_patch' as const,
        scopes: ['object' as const],
        preview: 'none' as const,
        replay: 'stable' as const,
      })),
    } as ManifestObject);
    const facetSubplot = {
      id: 'subplot.facet',
      kind: 'subplot',
      label: 'facet panel',
      editable: [],
      currentProps: {
        unsupportedProps: ['left', 'bottom', 'width', 'height'],
        unsupportedReason: 'ggplot facet panels share one gtable layout.',
      },
      propertyCapabilities: [],
      role: 'ggplot_facet_panel',
    } as ManifestObject;

    expect(supportsIndependentSubplotLayout([
      capableSubplot('subplot.0'),
      capableSubplot('subplot.1'),
    ])).toBe(true);
    expect(supportsIndependentSubplotLayout([
      capableSubplot('subplot.0'),
      facetSubplot,
    ])).toBe(false);
    expect(supportsIndependentSubplotLayout([facetSubplot])).toBe(false);
  });

  it('does not expose modern legend layout props omitted from capabilities', () => {
    const legend = {
      id: 'legend.0',
      kind: 'legend',
      label: 'legend.0',
      editable: ['handlelength', 'handleheight'],
      currentProps: { handlelength: 2, handleheight: 0.7 },
      propertyCapabilities: [{
        prop: 'handlelength',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    expect(supportsComponentBatchProp(legend, 'handlelength')).toBe(true);
    expect(supportsComponentBatchProp(legend, 'handleheight')).toBe(false);
  });
});
