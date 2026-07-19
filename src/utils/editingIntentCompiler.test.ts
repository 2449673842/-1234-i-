import { describe, expect, it } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest } from '../schemas/manifest';
import { compileEditingIntent, isExplicitlyDeniedCrossFigure, retargetEditingIntentForFigure } from './editingIntentCompiler';

const baseManifest = (objects: Manifest['objects'], generatedBy: Manifest['generatedBy'] = 'introspection'): Manifest => ({
  generatedBy,
  objects,
  globals: {},
  groups: [],
  colorGroups: [],
  palettes: [],
  bindings: [],
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  unsupportedNotes: [],
});

function pythonSeriesObject(input: {
  id: string;
  kind: string;
  role: string;
  prop: string;
  patchMode?: 'local_patch' | 'backend_patch';
}): Manifest['objects'][number] {
  return {
    id: input.id,
    kind: input.kind as any,
    label: input.id,
    editable: [input.prop],
    currentProps: { [input.prop]: '#000000' },
    role: input.role,
    subplotId: 'subplot.0',
    identity: {
      semanticKey: `${input.role}:subplot.0`,
      instanceKey: `subplot.0:${input.id}`,
      seriesKey: `${input.role}:series.0`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: { subplotId: 'subplot.0' },
    },
    propertyCapabilities: [{
      prop: input.prop,
      patchMode: input.patchMode ?? 'local_patch',
      scopes: ['object', 'figure', 'cross_figure'],
      preview: input.patchMode === 'backend_patch' ? 'none' : 'exact',
      replay: 'stable',
    }],
  };
}

describe('editing intent compiler', () => {
  it('keeps pie slices, manual wedges, labels, and value labels in distinct semantic roles', () => {
    const pieSlice = pythonSeriesObject({
      id: 'patch.0.0', kind: 'patch', role: 'pie_slice', prop: 'facecolor',
    });
    const wedgeSlice = pythonSeriesObject({
      id: 'patch.0.1', kind: 'patch', role: 'wedge_slice', prop: 'facecolor',
    });
    const ordinaryPatch = pythonSeriesObject({
      id: 'patch.0.2', kind: 'patch', role: 'bar_series', prop: 'facecolor',
    });
    const pieLabel = pythonSeriesObject({
      id: 'text.0.0', kind: 'text', role: 'pie_label', prop: 'color',
    });
    const pieValueLabel = pythonSeriesObject({
      id: 'text.0.1', kind: 'text', role: 'pie_value_label', prop: 'color',
    });
    const pieLegendMarker = pythonSeriesObject({
      id: 'legend_patch.0.0', kind: 'patch', role: 'legend_marker', prop: 'facecolor',
    });
    pieLegendMarker.identity!.relation = {
      subplotId: 'subplot.0',
      parentId: pieSlice.id,
      pieSliceId: pieSlice.id,
      pieId: 'pie.0.0',
      sliceIndex: 0,
    };
    const figure = baseManifest([
      pieSlice, wedgeSlice, ordinaryPatch, pieLabel, pieValueLabel, pieLegendMarker,
    ]);

    const compileRole = (targetRole: any, prop: string, value: unknown) => compileEditingIntent(figure, {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole,
        subplotIds: ['subplot.0'],
      },
      operation: { prop, value },
    });

    expect(compileRole('data_pie_slice', 'facecolor', '#8844aa').patches).toEqual([
      expect.objectContaining({ gid: pieSlice.id, prop: 'facecolor' }),
    ]);
    expect(compileRole('data_wedge_slice', 'facecolor', '#447799').patches).toEqual([
      expect.objectContaining({ gid: wedgeSlice.id, prop: 'facecolor' }),
    ]);
    expect(compileRole('pie_label', 'color', '#222222').patches).toEqual([
      expect.objectContaining({ gid: pieLabel.id, prop: 'color' }),
    ]);
    expect(compileRole('pie_value_label', 'color', '#333333').patches).toEqual([
      expect.objectContaining({ gid: pieValueLabel.id, prop: 'color' }),
    ]);
    expect(compileRole('pie_legend_marker', 'facecolor', '#444444').patches).toEqual([
      expect.objectContaining({ gid: pieLegendMarker.id, prop: 'facecolor' }),
    ]);
    expect(compileRole('data_bar', 'facecolor', '#555555').patches).toEqual([
      expect.objectContaining({ gid: ordinaryPatch.id, prop: 'facecolor' }),
    ]);
  });

  it('keeps an explicit cross-figure deny contract observable to callers', () => {
    expect(isExplicitlyDeniedCrossFigure({
      intent: 'style.component',
      scope: { selectionMode: 'explicit_objects', objectIds: ['line.0'], crossFigure: 'deny' },
      operation: { prop: 'color', value: '#123456' },
    })).toBe(true);
    expect(isExplicitlyDeniedCrossFigure({
      intent: 'style.component',
      scope: { selectionMode: 'explicit_objects', objectIds: ['line.0'] },
      operation: { prop: 'color', value: '#123456' },
    })).toBe(false);
  });
  it('routes virtual grid visibility through backend rendering', () => {
    const manifest = baseManifest([{
      id: 'grid.0',
      kind: 'grid',
      label: 'Grid',
      editable: ['visible'],
      currentProps: { visible: false },
      role: 'grid',
      subplotId: 'subplot.0',
    }]);

    const result = compileEditingIntent(manifest, {
      intent: 'visibility.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['grid.0'],
        targetKinds: ['grid'],
        targetRole: 'grid',
      },
      operation: { prop: 'visible', value: true },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'grid.0', prop: 'visible', value: true },
    ]);
  });

  it('does not compile properties omitted or rejected by a modern capability list', () => {
    const omitted = baseManifest([{
      id: 'line.0',
      kind: 'line',
      label: 'Line',
      editable: ['color'],
      currentProps: { color: '#000000' },
      propertyCapabilities: [],
    }]);
    const rejected = baseManifest([{
      id: 'line.1',
      kind: 'line',
      label: 'Line',
      editable: ['color'],
      currentProps: { color: '#000000' },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'unsupported',
      }],
    }]);
    const intent = (gid: string) => ({
      intent: 'style.component' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: [gid],
        targetKinds: ['line' as const],
      },
      operation: { prop: 'color', value: '#118833' },
    });

    expect(compileEditingIntent(omitted, intent('line.0')).patches).toHaveLength(0);
    expect(compileEditingIntent(rejected, intent('line.1')).patches).toHaveLength(0);
  });

  it('keeps y-axis label color separate from y tick label color', () => {
    const manifest = baseManifest([
      {
        id: 'ylabel.0',
        kind: 'text',
        label: 'Y label',
        editable: ['color'],
        currentProps: { color: '#000000' },
        role: 'axis_label',
        subplotId: 'subplot.0',
      },
      {
        id: 'axis.y.0',
        kind: 'axis_y',
        label: 'Y axis',
        editable: ['tick_labelcolor'],
        currentProps: { tick_labelcolor: '#000000' },
        role: 'y_axis',
        subplotId: 'subplot.0',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.text.axis_label',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole: 'y_axis_label',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'color', value: '#cc0000' },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'local_patch', gid: 'ylabel.0', prop: 'color', value: '#cc0000' },
    ]);
  });

  it('compiles grouped x tick font size to the stable x-axis object', () => {
    const manifest = baseManifest([
      {
        id: 'xtick.0.0',
        kind: 'xtick',
        label: 'tick 0',
        editable: ['fontsize'],
        currentProps: { fontsize: 9 },
        subplotId: 'subplot.0',
      },
      {
        id: 'xtick.0.1',
        kind: 'xtick',
        label: 'tick 1',
        editable: ['fontsize'],
        currentProps: { fontsize: 9 },
        subplotId: 'subplot.0',
      },
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['tick_labelsize'],
        currentProps: { tick_labelsize: 9 },
        subplotId: 'subplot.0',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.text.tick_label',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole: 'x_tick_label',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'fontsize', value: 12 },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'axis.x.0', prop: 'tick_labelsize', value: 12 },
    ]);
  });

  it('maps font-center tick groups with explicit source ids to stable axis props', () => {
    const manifest = baseManifest([
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['tick_labelsize'],
        currentProps: { tick_labelsize: 9 },
        subplotId: 'subplot.0',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.text.tick_label',
      scope: {
        selectionMode: 'role_in_figure',
        objectIds: ['axis.x.0'],
        targetRole: 'x_tick_label',
      },
      operation: { prop: 'fontsize', value: 14 },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'axis.x.0', prop: 'tick_labelsize', value: 14 },
    ]);
  });

  it('skips unsupported R facet subplot bounds instead of emitting unsafe patches', () => {
    const manifest = baseManifest([
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'Facet 1',
        editable: ['aspect'],
        currentProps: {
          unsupportedProps: ['left', 'bottom', 'width', 'height'],
          unsupportedReason: 'ggplot facet panels use shared gtable layout.',
        },
        role: 'ggplot_facet_panel',
      },
    ], 'r_svg');

    const result = compileEditingIntent(manifest, {
      intent: 'layout.subplot.axes_box',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['subplot.0'],
        targetRole: 'subplot_axes_box',
      },
      operation: { prop: 'width', value: 0.5 },
    });

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([
      {
        gid: 'subplot.0',
        role: 'subplot_axes_box',
        reason: 'unsupported_prop',
        detail: 'subplot.0 does not support width.',
      },
    ]);
  });

  it('retargets explicit source objects by semantic role for cross-figure apply', () => {
    const targetManifest = baseManifest([
      {
        id: 'ylabel.0',
        kind: 'text',
        label: 'Y label A',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.0',
      },
      {
        id: 'ylabel.1',
        kind: 'text',
        label: 'Y label B',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.1',
      },
      {
        id: 'ytick.0.0',
        kind: 'ytick',
        label: 'tick',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.0',
      },
    ]);
    const sourceIntent = {
      intent: 'style.text.axis_label' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: ['ylabel.0'],
        targetRole: 'y_axis_label' as const,
        subplotIds: ['subplot.0'],
        crossFigure: 'allow' as const,
      },
      operation: { prop: 'color', value: '#118833' },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceIntent));

    expect(result.skipped).toHaveLength(0);
    expect(result.patches.map(patch => 'gid' in patch ? patch.gid : '')).toEqual(['ylabel.0', 'ylabel.1']);
  });

  it('does not expand an explicit style object across figures without authorization', () => {
    const targetManifest = baseManifest([
      {
        id: 'ylabel.0',
        kind: 'text',
        label: 'Y label A',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.0',
      },
      {
        id: 'ylabel.1',
        kind: 'text',
        label: 'Y label B',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.1',
      },
    ]);
    const sourceIntent = {
      intent: 'style.text.axis_label' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: ['ylabel.0'],
        targetRole: 'y_axis_label' as const,
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'color', value: '#118833' },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceIntent));

    expect(result.patches).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('not_found');
  });

  it('does not retarget source-only intents without a semantic role or kind', () => {
    const targetManifest = baseManifest([
      {
        id: 'line.0.0',
        kind: 'line',
        label: 'Line',
        editable: ['linewidth'],
        currentProps: { linewidth: 1 },
      },
    ]);
    const sourceOnlyIntent = {
      intent: 'style.component' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: ['line.0.0'],
      },
      operation: { prop: 'linewidth', value: 2 },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceOnlyIntent));

    expect(result.patches).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('not_found');
  });

  it('compiles explicit text position edits for the current figure', () => {
    const manifest = baseManifest([
      {
        id: 'text.0',
        kind: 'text',
        label: 'Annotation',
        editable: ['position'],
        currentProps: { x: 0.2, y: 0.8, coord_system: 'axes' },
        subplotId: 'subplot.0',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'layout.position.text',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['text.0'],
        targetKinds: ['text'],
        crossFigure: 'deny',
      },
      operation: { prop: 'position', value: { x: 0.3, y: 0.7, coord_system: 'axes' } },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      {
        op: 'set',
        mode: 'backend_patch',
        gid: 'text.0',
        prop: 'position',
        value: { x: 0.3, y: 0.7, coord_system: 'axes' },
      },
    ]);
  });

  it('compiles explicit text content edits without expanding to sibling tick labels', () => {
    const manifest = baseManifest([
      {
        id: 'ytick.0.0',
        kind: 'ytick',
        label: 'old A',
        editable: ['text'],
        currentProps: { text: 'old A' },
        subplotId: 'subplot.0',
      },
      {
        id: 'ytick.0.1',
        kind: 'ytick',
        label: 'old B',
        editable: ['text'],
        currentProps: { text: 'old B' },
        subplotId: 'subplot.0',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'content.text',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['ytick.0.0'],
        targetKinds: ['ytick'],
        targetRole: 'y_tick_label',
        crossFigure: 'deny',
      },
      operation: { prop: 'text', value: 'new A' },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'ytick.0.0', prop: 'text', value: 'new A' },
    ]);
  });

  it('keeps explicit tick color edits on the selected tick object', () => {
    const manifest = baseManifest([
      {
        id: 'ytick.0.0',
        kind: 'ytick',
        label: 'tick A',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.0',
      },
      {
        id: 'axis.y.0',
        kind: 'axis_y',
        label: 'Y axis',
        editable: ['tick_labelcolor'],
        currentProps: { tick_labelcolor: '#000000' },
        subplotId: 'subplot.0',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.text.tick_label',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['ytick.0.0'],
        targetKinds: ['ytick'],
        targetRole: 'y_tick_label',
      },
      operation: { prop: 'color', value: '#2255cc' },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'local_patch', gid: 'ytick.0.0', prop: 'color', value: '#2255cc' },
    ]);
  });

  it('keeps legend title, legend text, and legend marker roles separate', () => {
    const manifest = baseManifest([
      {
        id: 'legend_title.0',
        kind: 'text',
        label: 'Legend title',
        editable: ['fontsize'],
        currentProps: { fontsize: 10 },
      },
      {
        id: 'legend_text.0.0',
        kind: 'text',
        label: 'Legend text',
        editable: ['fontsize'],
        currentProps: { fontsize: 9 },
      },
      {
        id: 'legend_line.0.0',
        kind: 'line',
        label: 'Legend handle',
        editable: ['linewidth'],
        currentProps: { linewidth: 1 },
        role: 'legend_marker',
      },
    ]);

    const titleResult = compileEditingIntent(manifest, {
      intent: 'style.text.legend',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'legend_title',
      },
      operation: { prop: 'fontsize', value: 12 },
    });
    const markerResult = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'legend_marker',
      },
      operation: { prop: 'linewidth', value: 2 },
    });

    expect(titleResult.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'legend_title.0', prop: 'fontsize', value: 12 },
    ]);
    expect(markerResult.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'legend_line.0.0', prop: 'linewidth', value: 2 },
    ]);
  });

  it('compiles explicit spine-group batch edits for every selected subplot frame', () => {
    const manifest = baseManifest(Array.from({ length: 8 }, (_, index) => ({
      id: `spine_group.${index}`,
      kind: 'spine_group',
      label: `Frame ${index + 1}`,
      editable: ['visible', 'color', 'linewidth'],
      currentProps: { linewidth: 0.8, color: '#000000' },
      subplotId: `subplot.${index}`,
    })));

    const result = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: manifest.objects.map(object => object.id),
        targetKinds: ['spine_group'],
        targetRole: 'axis_frame',
      },
      operation: { prop: 'linewidth', value: 1.5 },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toHaveLength(8);
    expect(result.patches).toEqual(
      manifest.objects.map(object => ({
        op: 'set',
        mode: 'backend_patch',
        gid: object.id,
        prop: 'linewidth',
        value: 1.5,
      })),
    );
  });

  it('separates colorbar label and colorbar tick label roles', () => {
    const manifest = baseManifest([
      {
        id: 'colorbar_label.0',
        kind: 'text',
        label: 'Colorbar label',
        editable: ['fontsize'],
        currentProps: { fontsize: 10 },
        role: 'colorbar_label',
      },
      {
        id: 'colorbar_tick.0.0',
        kind: 'text',
        label: '0.5',
        editable: ['fontsize'],
        currentProps: { fontsize: 8 },
        role: 'colorbar_tick_label',
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.text.tick_label',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'colorbar_tick_label',
      },
      operation: { prop: 'fontsize', value: 9 },
    });

    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'colorbar_tick.0.0', prop: 'fontsize', value: 9 },
    ]);
  });

  it('keeps axis_frame compatible with concrete spine objects', () => {
    const manifest = baseManifest([
      {
        id: 'spine.left.0',
        kind: 'spine',
        label: 'Left spine',
        editable: ['linewidth'],
        currentProps: { linewidth: 1 },
      },
      {
        id: 'grid.0',
        kind: 'grid',
        label: 'Grid',
        editable: ['linewidth'],
        currentProps: { linewidth: 0.5 },
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: 'axis_frame',
      },
      operation: { prop: 'linewidth', value: 2 },
    });

    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'spine.left.0', prop: 'linewidth', value: 2 },
    ]);
  });

  it('does not retarget drag position intents across figures', () => {
    const targetManifest = baseManifest([
      {
        id: 'text.1',
        kind: 'text',
        label: 'Target annotation',
        editable: ['position'],
        currentProps: { x: 0.1, y: 0.9, coord_system: 'axes' },
      },
      {
        id: 'legend.0',
        kind: 'legend',
        label: 'Target legend',
        editable: ['position'],
        currentProps: { x: 0.8, y: 0.8, coord_system: 'figure' },
      },
    ]);
    const sourceDragIntent = {
      intent: 'layout.position.text' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: ['text.0'],
        targetKinds: ['text' as const],
        crossFigure: 'deny' as const,
      },
      operation: { prop: 'position', value: { x: 0.4, y: 0.6, coord_system: 'axes' } },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceDragIntent));

    expect(result.patches).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('not_found');
  });

  it('denies content intents across figures by default even when a matching role exists', () => {
    const targetManifest = baseManifest([
      {
        id: 'ylabel.0',
        kind: 'text',
        label: 'Target Y',
        editable: ['text'],
        currentProps: { text: 'Target Y' },
        subplotId: 'subplot.0',
      },
    ]);
    const sourceContentIntent = {
      intent: 'content.text' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: ['ylabel.0'],
        targetRole: 'y_axis_label' as const,
      },
      operation: { prop: 'text', value: 'Source Y' },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceContentIntent));

    expect(result.patches).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('not_found');
  });

  it('denies layout intents across figures by default', () => {
    const targetManifest = baseManifest([
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'Panel',
        editable: ['width'],
        currentProps: { width: 0.5 },
      },
    ]);
    const sourceLayoutIntent = {
      intent: 'layout.subplot.axes_box' as const,
      scope: {
        selectionMode: 'explicit_objects' as const,
        objectIds: ['subplot.0'],
        targetRole: 'subplot_axes_box' as const,
      },
      operation: { prop: 'width', value: 0.7 },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceLayoutIntent));

    expect(result.patches).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('not_found');
  });

  it('forces contour parent style edits through backend patches', () => {
    const manifest = baseManifest([
      {
        id: 'contour.0.0',
        kind: 'contour' as any,
        label: 'Contour',
        editable: ['alpha'],
        currentProps: { alpha: 0.8 },
        role: 'contour_series',
        subplotId: 'subplot.0',
        identity: {
          semanticKey: 'contour_series:subplot.0',
          instanceKey: 'subplot.0:contour.0',
          seriesKey: 'contour:panel-a',
          scope: 'subplot',
          coordinateSpace: 'data',
          relation: { subplotId: 'subplot.0' },
        },
        propertyCapabilities: [{
          prop: 'alpha',
          patchMode: 'local_patch',
          scopes: ['object', 'figure'],
          preview: 'exact',
          replay: 'stable',
        }],
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['contour.0.0'],
        targetKinds: ['contour' as any],
      },
      operation: { prop: 'alpha', value: 0.4 },
    } as EditingIntent);

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'contour.0.0', prop: 'alpha', value: 0.4 },
    ]);
  });

  it.each(['levels', 'X', 'Y', 'Z'])('does not compile contour structural data prop %s', (prop) => {
    const manifest = baseManifest([
      {
        id: 'contour.0.0',
        kind: 'contour' as any,
        label: 'Contour',
        editable: ['alpha', 'levels', 'X', 'Y', 'Z'],
        currentProps: {
          alpha: 0.8,
          levels: [0, 1, 2],
          X: [[0, 1]],
          Y: [[0], [1]],
          Z: [[0, 1], [1, 0]],
        },
        role: 'contour_series',
        subplotId: 'subplot.0',
        identity: {
          semanticKey: 'contour_series:subplot.0',
          instanceKey: 'subplot.0:contour.0',
          seriesKey: 'contour:panel-a',
          scope: 'subplot',
          coordinateSpace: 'data',
          relation: { subplotId: 'subplot.0' },
        },
        propertyCapabilities: ['alpha', 'levels', 'X', 'Y', 'Z'].map(item => ({
          prop: item,
          patchMode: 'backend_patch' as const,
          scopes: ['object' as const, 'figure' as const],
          preview: item === 'alpha' ? 'none' as const : 'none' as const,
          replay: 'stable' as const,
        })),
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['contour.0.0'],
        targetKinds: ['contour' as any],
      },
      operation: { prop, value: [] },
    } as EditingIntent);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([
      {
        gid: 'contour.0.0',
        role: undefined,
        reason: 'unsupported_prop',
        detail: `contour.0.0 does not support ${prop}.`,
      },
    ]);
  });

  it.each([
    ['data_histogram', 'histogram.0.0', 'bar_container', 'histogram_series', 'facecolor'],
    ['data_stairs', 'stairs.0.0', 'patch', 'stairs_series', 'edgecolor'],
    ['data_step', 'step.0.0', 'line', 'step_series', 'color'],
  ])('compiles %s only for its dedicated Python series role', (
    targetRole,
    targetId,
    targetKind,
    seriesRole,
    prop,
  ) => {
    const manifest = baseManifest([
      pythonSeriesObject({ id: targetId, kind: targetKind, role: seriesRole, prop }),
      pythonSeriesObject({ id: 'bar_container.0.0', kind: 'bar_container', role: 'bar_series', prop }),
      pythonSeriesObject({ id: 'patch.0.0', kind: 'patch', role: 'patch', prop }),
      pythonSeriesObject({ id: 'line.0.0', kind: 'line', role: 'line_series', prop }),
      pythonSeriesObject({ id: 'legend_line.0.0', kind: 'line', role: 'legend_marker', prop }),
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_figure',
        targetRole: targetRole as any,
      },
      operation: { prop, value: '#118833' },
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { op: 'set', mode: 'local_patch', gid: targetId, prop, value: '#118833' },
    ]);
  });

  it.each([
    ['histogram.0.0', 'bar_container', 'histogram_series', 'bins'],
    ['histogram.0.0', 'bar_container', 'histogram_series', 'counts'],
    ['histogram.0.0', 'bar_container', 'histogram_series', 'values'],
    ['histogram.0.0', 'bar_container', 'histogram_series', 'edges'],
    ['histogram.0.0', 'bar_container', 'histogram_series', 'histtype'],
    ['stairs.0.0', 'patch', 'stairs_series', 'baseline'],
    ['stairs.0.0', 'patch', 'stairs_series', 'values'],
    ['stairs.0.0', 'patch', 'stairs_series', 'edges'],
    ['step.0.0', 'line', 'step_series', 'x'],
    ['step.0.0', 'line', 'step_series', 'y'],
    ['step.0.0', 'line', 'step_series', 'where'],
  ])('does not compile structural Python series prop %s on %s', (
    id,
    kind,
    role,
    prop,
  ) => {
    const manifest = baseManifest([
      {
        ...pythonSeriesObject({ id, kind, role, prop, patchMode: 'backend_patch' }),
        currentProps: { [prop]: [] },
      },
    ]);

    const result = compileEditingIntent(manifest, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: [id],
        targetKinds: [kind as any],
      },
      operation: { prop, value: [] },
    } as EditingIntent);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([
      {
        gid: id,
        role: undefined,
        reason: 'unsupported_prop',
        detail: `${id} does not support ${prop}.`,
      },
    ]);
  });
});
