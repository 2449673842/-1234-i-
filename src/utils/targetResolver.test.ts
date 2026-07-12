import { describe, expect, it } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest, ManifestObject, ManifestObjectIdentity } from '../schemas/manifest';
import {
  compileEditingIntentWithControlledResolver,
  compareTargetResolverWithCurrentCompiler,
  resolveEditingTargetsShadow,
} from './targetResolver';

function manifest(
  objects: ManifestObject[],
  generatedBy: Manifest['generatedBy'] = 'introspection',
): Manifest {
  return {
    generatedBy,
    globals: {},
    objects,
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
}

function identity(id: string, subplotId?: string): ManifestObjectIdentity {
  return {
    semanticKey: `${id.split('.')[0]}:${subplotId ?? 'figure'}`,
    instanceKey: `${subplotId ? 'subplot' : 'figure'}:${id}`,
    scope: subplotId ? 'subplot' as const : 'figure' as const,
    coordinateSpace: subplotId ? 'axes' as const : 'container' as const,
    relation: subplotId ? { subplotId } : undefined,
  };
}

function capability(
  prop: string,
  patchMode: 'local_patch' | 'backend_patch' = 'backend_patch',
  scopes: Array<'object' | 'group' | 'subplot' | 'figure' | 'cross_figure'> = [
    'object',
    'group',
    'subplot',
    'figure',
    'cross_figure',
  ],
) {
  return {
    prop,
    patchMode,
    scopes,
    preview: patchMode === 'local_patch' ? 'exact' as const : 'none' as const,
    replay: 'stable' as const,
  };
}

describe('shadow target resolver', () => {
  it('matches the current compiler for explicit axis-label edits', () => {
    const figure = manifest([{
      id: 'ylabel.0',
      kind: 'text',
      label: 'Y label',
      editable: ['color'],
      currentProps: { color: '#000000' },
      subplotId: 'subplot.0',
      identity: identity('ylabel.0', 'subplot.0'),
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'local_patch',
        scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
        preview: 'exact',
        replay: 'stable',
      }],
    }]);
    const intent: EditingIntent = {
      intent: 'style.text.axis_label',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['ylabel.0'],
        targetRole: 'y_axis_label',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'color', value: '#cc0000' },
    };

    const comparison = compareTargetResolverWithCurrentCompiler(figure, intent);

    expect(comparison.equivalent).toBe(true);
    expect(comparison.shadowPatchKeys).toEqual(['ylabel.0:color']);
    expect(comparison.resolution.resolved[0]?.match).toBe('exact');
  });

  it('resolves grouped tick styles to the stable virtual axis object', () => {
    const figure = manifest([
      {
        id: 'xtick.0.0',
        kind: 'xtick',
        label: 'A',
        editable: ['fontsize'],
        currentProps: { fontsize: 9 },
        subplotId: 'subplot.0',
        identity: identity('xtick.0.0', 'subplot.0'),
      },
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['tick_labelsize'],
        currentProps: { tick_labelsize: 9 },
        subplotId: 'subplot.0',
        identity: identity('axis.x.0', 'subplot.0'),
      },
    ]);
    const intent: EditingIntent = {
      intent: 'style.text.tick_label',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole: 'x_tick_label',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'fontsize', value: 12 },
    };

    const comparison = compareTargetResolverWithCurrentCompiler(figure, intent);

    expect(comparison.equivalent).toBe(true);
    expect(comparison.shadowPatchKeys).toEqual(['axis.x.0:tick_labelsize']);
  });

  it('exposes legacy suffix inference when a figure-level legend is scoped as a subplot', () => {
    const figure = manifest([{
      id: 'legend.figure.0',
      kind: 'legend',
      label: 'Shared legend',
      editable: ['fontsize'],
      currentProps: { fontsize: 9 },
      role: 'legend',
      identity: identity('legend.figure.0'),
    }]);
    const intent: EditingIntent = {
      intent: 'style.text.legend',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole: 'legend_container',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'fontsize', value: 11 },
    };

    const comparison = compareTargetResolverWithCurrentCompiler(figure, intent);

    expect(comparison.equivalent).toBe(false);
    expect(comparison.currentOnlyPatchKeys).toEqual(['legend.figure.0:fontsize']);
    expect(comparison.shadowPatchKeys).toEqual([]);
  });

  it('skips duplicate instance identities instead of selecting an arbitrary object', () => {
    const duplicateIdentity = identity('line.shared', 'subplot.0');
    duplicateIdentity.instanceKey = 'subplot:duplicate';
    const figure = manifest(['line.0.0', 'line.0.1'].map((id): ManifestObject => ({
      id,
      kind: 'line',
      label: id,
      editable: ['linewidth'],
      currentProps: { linewidth: 1 },
      subplotId: 'subplot.0',
      identity: duplicateIdentity,
    })));
    const intent: EditingIntent = {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole: 'data_line',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'linewidth', value: 2 },
    };

    const resolution = resolveEditingTargetsShadow(figure, intent);

    expect(resolution.resolved).toEqual([]);
    expect(resolution.ambiguous).toHaveLength(1);
    expect(resolution.ambiguous[0]?.candidates).toEqual(['line.0.0', 'line.0.1']);
  });

  it('resolves one shared colorbar from either owner subplot without duplicating patches', () => {
    const figure = manifest([
      {
        id: 'subplot.0', kind: 'subplot', label: 'Left', editable: [], currentProps: {}, identity: identity('subplot.0', 'subplot.0'),
      },
      {
        id: 'subplot.1', kind: 'subplot', label: 'Right', editable: [], currentProps: {}, identity: identity('subplot.1', 'subplot.1'),
      },
      {
        id: 'colorbar.2',
        kind: 'colorbar',
        label: 'Shared colorbar',
        role: 'colorbar',
        editable: ['tick_fontsize'],
        currentProps: { tick_fontsize: 10 },
        subplotIds: ['subplot.0', 'subplot.1'],
        identity: {
          semanticKey: 'colorbar:subplot.0+subplot.1',
          instanceKey: 'container:colorbar.2',
          scope: 'container',
          coordinateSpace: 'figure',
          relation: { subplotIds: ['subplot.0', 'subplot.1'] },
        },
        propertyCapabilities: [capability('tick_fontsize')],
      },
    ]);
    const intent: EditingIntent = {
      intent: 'style.component',
      scope: {
        selectionMode: 'role_in_subplot',
        targetRole: 'colorbar',
        subplotIds: ['subplot.1'],
      },
      operation: { prop: 'tick_fontsize', value: 13 },
    };

    const result = resolveEditingTargetsShadow(figure, intent);
    const compiled = compileEditingIntentWithControlledResolver(figure, intent, true);
    expect(result.resolved.map(target => target.objectId)).toEqual(['colorbar.2']);
    expect(compiled.patches).toEqual([expect.objectContaining({ gid: 'colorbar.2', prop: 'tick_fontsize', value: 13 })]);
  });
});

describe('controlled strict target compiler', () => {
  it('compiles Python title, axis label, tick, and legend font groups from v1.1 capabilities', () => {
    const figure = manifest([
      {
        id: 'title.0',
        kind: 'text',
        label: 'Title',
        editable: ['fontsize'],
        currentProps: { fontsize: 12 },
        subplotId: 'subplot.0',
        identity: identity('title.0', 'subplot.0'),
        propertyCapabilities: [capability('fontsize')],
      },
      {
        id: 'xlabel.0',
        kind: 'text',
        label: 'X label',
        editable: ['fontfamily'],
        currentProps: { fontfamily: 'Arial' },
        subplotId: 'subplot.0',
        identity: identity('xlabel.0', 'subplot.0'),
        propertyCapabilities: [capability('fontfamily')],
      },
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['tick_labelsize'],
        currentProps: { tick_labelsize: 9 },
        subplotId: 'subplot.0',
        identity: identity('axis.x.0', 'subplot.0'),
        propertyCapabilities: [capability('tick_labelsize')],
      },
      {
        id: 'legend_text.0.0',
        kind: 'text',
        label: 'Series A',
        editable: ['color'],
        currentProps: { color: '#000000' },
        subplotId: 'subplot.0',
        identity: identity('legend_text.0.0', 'subplot.0'),
        propertyCapabilities: [capability('color', 'local_patch')],
      },
    ]);
    const cases: Array<{ intent: EditingIntent; key: string }> = [
      {
        intent: {
          intent: 'style.text.title',
          scope: { selectionMode: 'role_in_figure', objectIds: ['title.0'], targetRole: 'title' },
          operation: { prop: 'fontsize', value: 16 },
        },
        key: 'title.0:fontsize:backend_patch',
      },
      {
        intent: {
          intent: 'style.text.axis_label',
          scope: { selectionMode: 'role_in_figure', objectIds: ['xlabel.0'], targetRole: 'x_axis_label' },
          operation: { prop: 'fontfamily', value: 'Times New Roman' },
        },
        key: 'xlabel.0:fontfamily:backend_patch',
      },
      {
        intent: {
          intent: 'style.text.tick_label',
          scope: { selectionMode: 'role_in_figure', objectIds: ['axis.x.0'], targetRole: 'x_tick_label' },
          operation: { prop: 'fontsize', value: 11 },
        },
        key: 'axis.x.0:tick_labelsize:backend_patch',
      },
      {
        intent: {
          intent: 'style.text.legend',
          scope: { selectionMode: 'role_in_figure', objectIds: ['legend_text.0.0'], targetRole: 'legend_text' },
          operation: { prop: 'color', value: '#cc0000' },
        },
        key: 'legend_text.0.0:color:local_patch',
      },
    ];

    cases.forEach(({ intent, key }) => {
      const result = compileEditingIntentWithControlledResolver(figure, intent, true);
      expect(result.strategy).toBe('strict');
      expect(result.patches).toHaveLength(1);
      const patch = result.patches[0];
      expect('gid' in patch ? `${patch.gid}:${patch.prop}:${patch.mode}` : '').toBe(key);
    });
  });

  it('uses R capability patch modes without a separate frontend target rule', () => {
    const figure = manifest([
      {
        id: 'title.0',
        kind: 'text',
        label: 'R title',
        editable: ['fontweight'],
        currentProps: { fontweight: 'normal' },
        identity: identity('title.0'),
        propertyCapabilities: [capability('fontweight', 'backend_patch')],
      },
      {
        id: 'axis.y.0',
        kind: 'axis_y',
        label: 'Y axis',
        editable: ['tick_labelfamily'],
        currentProps: { tick_labelfamily: 'sans' },
        identity: identity('axis.y.0'),
        propertyCapabilities: [capability('tick_labelfamily', 'backend_patch')],
      },
      {
        id: 'legend_text.0.0',
        kind: 'text',
        label: 'R legend',
        editable: ['fontsize'],
        currentProps: { fontsize: 9 },
        identity: identity('legend_text.0.0'),
        propertyCapabilities: [capability('fontsize', 'backend_patch')],
      },
    ], 'r_svg');

    const title = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.text.title',
      scope: { selectionMode: 'role_in_figure', objectIds: ['title.0'], targetRole: 'title' },
      operation: { prop: 'fontweight', value: 'bold' },
    }, true);
    const tick = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.text.tick_label',
      scope: { selectionMode: 'role_in_figure', objectIds: ['axis.y.0'], targetRole: 'y_tick_label' },
      operation: { prop: 'fontfamily', value: 'serif' },
    }, true);
    const legend = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.text.legend',
      scope: { selectionMode: 'role_in_figure', objectIds: ['legend_text.0.0'], targetRole: 'legend_text' },
      operation: { prop: 'fontsize', value: 10 },
    }, true);

    expect([title, tick, legend].every(result => result.strategy === 'strict')).toBe(true);
    expect([title, tick, legend].flatMap(result => result.patches).every(patch => (
      'mode' in patch && patch.mode === 'backend_patch'
    ))).toBe(true);
    expect(tick.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'axis.y.0', prop: 'tick_labelfamily', value: 'serif',
    }]);
  });

  it('keeps a selected multi-subplot font scope inside the requested subplot', () => {
    const objects = [0, 1].map((index): ManifestObject => ({
      id: `ylabel.${index}`,
      kind: 'text',
      label: `Y ${index}`,
      editable: ['fontsize'],
      currentProps: { fontsize: 10 },
      subplotId: `subplot.${index}`,
      identity: identity(`ylabel.${index}`, `subplot.${index}`),
      propertyCapabilities: [capability('fontsize')],
    }));
    const result = compileEditingIntentWithControlledResolver(manifest(objects), {
      intent: 'style.text.axis_label',
      scope: {
        selectionMode: 'role_in_subplot',
        objectIds: objects.map(object => object.id),
        targetRole: 'y_axis_label',
        subplotIds: ['subplot.1'],
      },
      operation: { prop: 'fontsize', value: 12 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'ylabel.1', prop: 'fontsize', value: 12,
    }]);
  });

  it('falls back to the legacy compiler only when v1.1 protocol fields are absent', () => {
    const legacy = manifest([{
      id: 'title.0',
      kind: 'text',
      label: 'Legacy title',
      editable: ['fontsize'],
      currentProps: { fontsize: 12 },
    }]);
    const result = compileEditingIntentWithControlledResolver(legacy, {
      intent: 'style.text.title',
      scope: { selectionMode: 'role_in_figure', objectIds: ['title.0'], targetRole: 'title' },
      operation: { prop: 'fontsize', value: 14 },
    }, true);

    expect(result.strategy).toBe('legacy');
    expect(result.fallbackReason).toBe('missing_identity');
    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'title.0', prop: 'fontsize', value: 14,
    }]);
  });

  it('rejects duplicate identities instead of falling back to an arbitrary legacy target', () => {
    const duplicate = identity('title.shared', 'subplot.0');
    duplicate.instanceKey = 'subplot:duplicate-title';
    const objects = ['title.0', 'title.1'].map((id): ManifestObject => ({
      id,
      kind: 'text',
      label: id,
      editable: ['fontsize'],
      currentProps: { fontsize: 12 },
      subplotId: 'subplot.0',
      identity: duplicate,
      propertyCapabilities: [capability('fontsize')],
    }));
    const result = compileEditingIntentWithControlledResolver(manifest(objects), {
      intent: 'style.text.title',
      scope: { selectionMode: 'role_in_figure', objectIds: objects.map(object => object.id), targetRole: 'title' },
      operation: { prop: 'fontsize', value: 14 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([]);
    expect(result.resolution?.ambiguous).toHaveLength(1);
  });

  it('does not assign a figure-level legend to subplot.0 through a numeric suffix', () => {
    const figure = manifest([{
      id: 'legend_text.figure.0.0',
      kind: 'text',
      label: 'Shared legend',
      editable: ['fontsize'],
      currentProps: { fontsize: 9 },
      identity: identity('legend_text.figure.0.0'),
      propertyCapabilities: [capability('fontsize')],
    }]);
    const result = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.text.legend',
      scope: {
        selectionMode: 'role_in_subplot',
        objectIds: ['legend_text.figure.0.0'],
        targetRole: 'legend_text',
        subplotIds: ['subplot.0'],
      },
      operation: { prop: 'fontsize', value: 10 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('not_found');
  });

  it('uses the property capability scope intersection instead of editable alone', () => {
    const figure = manifest([{
      id: 'title.0',
      kind: 'text',
      label: 'Title',
      editable: ['fontsize'],
      currentProps: { fontsize: 12 },
      identity: identity('title.0'),
      propertyCapabilities: [capability('fontsize', 'backend_patch', ['object'])],
    }]);
    const result = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.text.title',
      scope: { selectionMode: 'role_in_figure', objectIds: ['title.0'], targetRole: 'title' },
      operation: { prop: 'fontsize', value: 14 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('unsupported_scope');
  });

  it('keeps data lines separate from legend lines even when both ids are requested', () => {
    const figure = manifest([
      {
        id: 'line.0.0',
        kind: 'line',
        label: 'Observed',
        editable: ['linewidth'],
        currentProps: { linewidth: 1 },
        subplotId: 'subplot.0',
        identity: identity('line.0.0', 'subplot.0'),
        propertyCapabilities: [capability('linewidth')],
      },
      {
        id: 'legend_line.0.0',
        kind: 'line',
        label: 'Legend handle',
        editable: ['linewidth'],
        currentProps: { linewidth: 1 },
        role: 'legend_marker',
        subplotId: 'subplot.0',
        identity: identity('legend_line.0.0', 'subplot.0'),
        propertyCapabilities: [capability('linewidth')],
      },
    ]);
    const result = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['line.0.0', 'legend_line.0.0'],
        targetKinds: ['line'],
        targetRole: 'data_line',
      },
      operation: { prop: 'linewidth', value: 2.5 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'line.0.0', prop: 'linewidth', value: 2.5,
    }]);
  });

  it('fans out explicit axis-frame edits without including grids', () => {
    const frames = Array.from({ length: 4 }, (_, index): ManifestObject => ({
      id: `spine_group.${index}`,
      kind: 'spine_group',
      label: `Frame ${index}`,
      editable: ['linewidth'],
      currentProps: { linewidth: 0.8 },
      subplotId: `subplot.${index}`,
      identity: identity(`spine_group.${index}`, `subplot.${index}`),
      propertyCapabilities: [capability('linewidth')],
    }));
    const grid: ManifestObject = {
      id: 'grid.0',
      kind: 'grid',
      label: 'Grid',
      editable: ['linewidth'],
      currentProps: { linewidth: 0.5 },
      subplotId: 'subplot.0',
      identity: identity('grid.0', 'subplot.0'),
      propertyCapabilities: [capability('linewidth')],
    };
    const result = compileEditingIntentWithControlledResolver(manifest([...frames, grid]), {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: [...frames.map(object => object.id), grid.id],
        targetKinds: ['spine_group', 'grid'],
        targetRole: 'axis_frame',
      },
      operation: { prop: 'linewidth', value: 1.5 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toHaveLength(4);
    expect(result.patches.every(patch => 'gid' in patch && patch.gid.startsWith('spine_group.'))).toBe(true);
  });

  it('targets legend markers and grids as distinct component roles', () => {
    const figure = manifest([
      {
        id: 'legend_line.0.0',
        kind: 'line',
        label: 'Legend handle',
        editable: ['color'],
        currentProps: { color: '#000000' },
        role: 'legend_marker',
        subplotId: 'subplot.0',
        identity: identity('legend_line.0.0', 'subplot.0'),
        propertyCapabilities: [capability('color', 'local_patch')],
      },
      {
        id: 'grid.0',
        kind: 'grid',
        label: 'Grid',
        editable: ['color'],
        currentProps: { color: '#cccccc' },
        subplotId: 'subplot.0',
        identity: identity('grid.0', 'subplot.0'),
        propertyCapabilities: [capability('color', 'local_patch')],
      },
    ]);
    const legend = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['legend_line.0.0'],
        targetKinds: ['line'],
        targetRole: 'legend_marker',
      },
      operation: { prop: 'color', value: '#cc0000' },
    }, true);
    const grid = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['grid.0'],
        targetKinds: ['grid'],
        targetRole: 'grid',
      },
      operation: { prop: 'color', value: '#eeeeee' },
    }, true);

    expect(legend.patches).toEqual([{
      op: 'set', mode: 'local_patch', gid: 'legend_line.0.0', prop: 'color', value: '#cc0000',
    }]);
    expect(grid.patches).toEqual([{
      op: 'set', mode: 'local_patch', gid: 'grid.0', prop: 'color', value: '#eeeeee',
    }]);
  });

  it('prefers a bar container over its selected patch children', () => {
    const containerIdentity = identity('container.bar.0.0', 'subplot.0');
    const childIdentity = identity('patch.0.0', 'subplot.0');
    childIdentity.relation = {
      ...childIdentity.relation,
      parentId: 'container.bar.0.0',
    };
    const container: ManifestObject = {
      id: 'container.bar.0.0',
      kind: 'bar_container',
      label: 'Bars',
      editable: ['linewidth'],
      currentProps: { linewidth: 0.8 },
      role: 'bar_series',
      subplotId: 'subplot.0',
      children: ['patch.0.0'],
      identity: containerIdentity,
      propertyCapabilities: [capability('linewidth')],
    };
    const child: ManifestObject = {
      id: 'patch.0.0',
      kind: 'patch',
      label: 'Bar 1',
      editable: ['linewidth'],
      currentProps: { linewidth: 0.8 },
      role: 'bar_series',
      parentId: container.id,
      subplotId: 'subplot.0',
      identity: childIdentity,
      propertyCapabilities: [capability('linewidth')],
    };

    const result = compileEditingIntentWithControlledResolver(manifest([container, child]), {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: [container.id, child.id],
        targetKinds: ['bar_container', 'patch'],
        targetRole: 'data_bar',
      },
      operation: { prop: 'linewidth', value: 1.6 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: container.id, prop: 'linewidth', value: 1.6,
    }]);
  });

  it('keeps errorbar, boxplot, and violin containers in separate roles', () => {
    const specs = [
      { id: 'container.errorbar.0.0', kind: 'errorbar_container' as const, role: 'errorbar_series', targetRole: 'data_errorbar' as const },
      { id: 'container.boxplot.0.0', kind: 'boxplot_container' as const, role: 'boxplot_group', targetRole: 'data_boxplot' as const },
      { id: 'container.violinplot.0.0', kind: 'violinplot_container' as const, role: 'violin_group', targetRole: 'data_violin' as const },
    ];
    const objects = specs.map((spec): ManifestObject => ({
      id: spec.id,
      kind: spec.kind,
      label: spec.role,
      editable: ['linewidth'],
      currentProps: { linewidth: 1 },
      role: spec.role,
      subplotId: 'subplot.0',
      identity: identity(spec.id, 'subplot.0'),
      propertyCapabilities: [capability('linewidth')],
    }));

    specs.forEach((spec) => {
      const result = compileEditingIntentWithControlledResolver(manifest(objects), {
        intent: 'style.component',
        scope: {
          selectionMode: 'explicit_objects',
          objectIds: objects.map(object => object.id),
          targetRole: spec.targetRole,
        },
        operation: { prop: 'linewidth', value: 2 },
      }, true);
      expect(result.patches).toEqual([{
        op: 'set', mode: 'backend_patch', gid: spec.id, prop: 'linewidth', value: 2,
      }]);
    });
  });

  it('prefers a stem container over its line and collection children', () => {
    const stemIdentity = identity('container.stem.0.0', 'subplot.0');
    const childIdentity = identity('line.0.0', 'subplot.0');
    childIdentity.relation = {
      ...childIdentity.relation,
      parentId: 'container.stem.0.0',
    };
    const stem: ManifestObject = {
      id: 'container.stem.0.0',
      kind: 'stem_container',
      label: 'Signal',
      editable: ['stem_linewidth'],
      currentProps: { stem_linewidth: 1.5 },
      role: 'stem_series',
      subplotId: 'subplot.0',
      children: ['line.0.0'],
      identity: stemIdentity,
      propertyCapabilities: [capability('stem_linewidth')],
    };
    const child: ManifestObject = {
      id: 'line.0.0',
      kind: 'line',
      label: 'Stem marker',
      editable: ['linewidth'],
      currentProps: { linewidth: 1.5 },
      role: 'stem_series',
      parentId: stem.id,
      subplotId: 'subplot.0',
      identity: childIdentity,
      propertyCapabilities: [capability('linewidth')],
    };

    const result = compileEditingIntentWithControlledResolver(manifest([stem, child]), {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: [stem.id, child.id],
        targetKinds: ['stem_container', 'line'],
        targetRole: 'data_stem',
      },
      operation: { prop: 'stem_linewidth', value: 2.5 },
    }, true);

    expect(result.strategy).toBe('strict');
    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: stem.id, prop: 'stem_linewidth', value: 2.5,
    }]);
  });

  it('keeps dual heatmap and colorbar targets separated by role and explicit identity', () => {
    const objects: ManifestObject[] = [];
    for (const index of [0, 1]) {
      const subplotId = `subplot.${index}`;
      const heatmapId = `heatmap.image.${index}.0`;
      const colorbarId = `colorbar.${index + 2}`;
      const heatmapIdentity = identity(heatmapId, subplotId);
      heatmapIdentity.relation = {
        ...heatmapIdentity.relation,
        colorbarId,
      };
      const colorbarIdentity = identity(colorbarId, subplotId);
      colorbarIdentity.relation = {
        ...colorbarIdentity.relation,
        mappableId: heatmapId,
      };
      objects.push(
        {
          id: heatmapId,
          kind: 'heatmap',
          label: `Heatmap ${index}`,
          editable: ['cmap'],
          currentProps: { cmap: 'viridis' },
          role: 'heatmap_series',
          subplotId,
          identity: heatmapIdentity,
          propertyCapabilities: [capability('cmap', 'backend_patch', ['object', 'group'])],
        },
        {
          id: colorbarId,
          kind: 'colorbar',
          label: `Colorbar ${index}`,
          editable: ['width'],
          currentProps: { width: 0.04 },
          role: 'colorbar',
          subplotId,
          identity: colorbarIdentity,
          propertyCapabilities: [capability('width', 'backend_patch', ['object', 'group'])],
        },
      );
    }

    const selectedColorbar = compileEditingIntentWithControlledResolver(manifest(objects), {
      intent: 'layout.colorbar',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['colorbar.2'],
        targetRole: 'colorbar',
      },
      operation: { prop: 'width', value: 0.06 },
    }, true);
    expect(selectedColorbar.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'colorbar.2', prop: 'width', value: 0.06,
    }]);

    const selectedHeatmap = compileEditingIntentWithControlledResolver(manifest(objects), {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['heatmap.image.1.0'],
        targetRole: 'heatmap',
      },
      operation: { prop: 'cmap', value: 'magma' },
    }, true);
    expect(selectedHeatmap.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'heatmap.image.1.0', prop: 'cmap', value: 'magma',
    }]);
  });

  it('edits a legend container without absorbing its related child marker', () => {
    const legendIdentity = identity('legend.figure.0');
    const markerIdentity = identity('legend_line.figure.0.0');
    markerIdentity.relation = { legendId: 'legend.figure.0' };
    const figure = manifest([
      {
        id: 'legend.figure.0',
        kind: 'legend',
        label: 'Shared legend',
        editable: ['markerscale'],
        currentProps: { markerscale: 1 },
        role: 'legend',
        identity: legendIdentity,
        propertyCapabilities: [capability('markerscale', 'backend_patch', ['object', 'group'])],
      },
      {
        id: 'legend_line.figure.0.0',
        kind: 'line',
        label: 'Series A',
        editable: ['markersize'],
        currentProps: { markersize: 6 },
        role: 'legend_marker',
        identity: markerIdentity,
        propertyCapabilities: [capability('markersize', 'backend_patch', ['object', 'group'])],
      },
    ]);

    const result = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['legend.figure.0', 'legend_line.figure.0.0'],
        targetRole: 'legend_container',
      },
      operation: { prop: 'markerscale', value: 1.5 },
    }, true);

    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'legend.figure.0', prop: 'markerscale', value: 1.5,
    }]);
  });

  it('keeps annotation arrows separate from ordinary data patches', () => {
    const annotationIdentity = identity('text.0.0', 'subplot.0');
    annotationIdentity.relation = {
      ...annotationIdentity.relation,
      annotationId: 'text.0.0',
      arrowId: 'annotation_arrow.0.0',
    };
    const arrowIdentity = identity('annotation_arrow.0.0', 'subplot.0');
    arrowIdentity.relation = {
      ...arrowIdentity.relation,
      annotationId: 'text.0.0',
      textId: 'text.0.0',
    };
    const figure = manifest([
      {
        id: 'text.0.0',
        kind: 'text',
        label: 'PCoA label',
        editable: ['position'],
        currentProps: { x: 1, y: 2, coord_system: 'data' },
        role: 'annotation_text',
        subplotId: 'subplot.0',
        identity: annotationIdentity,
        propertyCapabilities: [capability('position', 'backend_patch', ['object'])],
      },
      {
        id: 'annotation_arrow.0.0',
        kind: 'patch',
        label: 'PCoA arrow',
        editable: ['edgecolor', 'linewidth'],
        currentProps: { edgecolor: '#000000', linewidth: 1 },
        role: 'annotation_arrow',
        subplotId: 'subplot.0',
        identity: arrowIdentity,
        propertyCapabilities: [capability('edgecolor'), capability('linewidth')],
      },
      {
        id: 'patch.0.0',
        kind: 'patch',
        label: 'Data patch',
        editable: ['edgecolor', 'linewidth'],
        currentProps: { edgecolor: '#000000', linewidth: 1 },
        role: 'bar_series',
        subplotId: 'subplot.0',
        identity: identity('patch.0.0', 'subplot.0'),
        propertyCapabilities: [capability('edgecolor'), capability('linewidth')],
      },
    ]);

    const result = compileEditingIntentWithControlledResolver(figure, {
      intent: 'style.component',
      scope: {
        selectionMode: 'explicit_objects',
        objectIds: ['annotation_arrow.0.0', 'patch.0.0'],
        targetRole: 'annotation_arrow',
      },
      operation: { prop: 'linewidth', value: 2.2 },
    }, true);

    expect(result.patches).toEqual([{
      op: 'set', mode: 'backend_patch', gid: 'annotation_arrow.0.0', prop: 'linewidth', value: 2.2,
    }]);
  });
});
