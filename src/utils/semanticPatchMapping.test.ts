import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import { mapPatchesToTargetFigure } from './semanticPatchMapping';

const baseManifest = (objects: Manifest['objects']): Manifest => ({
  generatedBy: 'introspection',
  objects,
  globals: {},
  groups: [],
  colorGroups: [],
  palettes: [],
  bindings: [],
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  unsupportedNotes: [],
});

describe('semantic patch mapping', () => {
  it('maps matching semantic axis objects when raw gid differs', () => {
    const source = baseManifest([
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['tick_labelsize'],
        currentProps: {},
        role: 'x_axis',
        subplotId: 'subplot.0',
        stableKey: 'axis:x:subplot.0',
      },
    ]);
    const target = baseManifest([
      {
        id: 'axis.x.3',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['tick_labelsize'],
        currentProps: {},
        role: 'x_axis',
        subplotId: 'subplot.0',
        stableKey: 'axis:x:subplot.0',
      },
    ]);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'axis.x.0', prop: 'tick_labelsize', value: 13, mode: 'backend_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches[0].gid).toBe('axis.x.3');
  });

  it('skips code patches for cross-figure semantic application', () => {
    const manifest = baseManifest([]);
    const result = mapPatchesToTargetFigure(
      [{ gid: 'code_patch', prop: 'LINE_COLOR', value: '#000000', mode: 'backend_patch', type: 'code_patch' }],
      manifest,
      manifest,
    );

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('keeps an explicit single-object style patch scoped to one target object', () => {
    const source = baseManifest([
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'subplot.0',
        editable: ['left'],
        currentProps: {},
      },
      {
        id: 'spine_group.0',
        kind: 'spine_group',
        label: 'Frame',
        editable: ['linewidth', 'color'],
        currentProps: {},
        role: 'spine',
        subplotId: 'subplot.0',
        stableKey: 'spine_group:subplot.0',
      },
    ]);
    const target = baseManifest([
      ...[0, 1, 2, 3].map(index => ({
        id: `subplot.${index}`,
        kind: 'subplot',
        label: `subplot.${index}`,
        editable: ['left'],
        currentProps: {},
      })),
      ...[0, 1, 2, 3].map(index => ({
        id: `spine_group.${index}`,
        kind: 'spine_group',
        label: `Frame ${index}`,
        editable: ['linewidth', 'color'],
        currentProps: {},
        role: 'spine',
        subplotId: `subplot.${index}`,
        stableKey: `spine_group:subplot.${index}`,
      })),
    ] as Manifest['objects']);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'spine_group.0', prop: 'linewidth', value: 1.8, mode: 'backend_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches.map(patch => patch.gid)).toEqual(['spine_group.0']);
  });

  it('does not fan out content patches from a single-panel source to a multi-panel target', () => {
    const source = baseManifest([
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'subplot.0',
        editable: ['left'],
        currentProps: {},
      },
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X axis',
        editable: ['label', 'tick_labelsize'],
        currentProps: {},
        role: 'x_axis',
        subplotId: 'subplot.0',
        stableKey: 'axis:x:subplot.0',
      },
    ]);
    const target = baseManifest([
      ...[0, 1, 2, 3].map(index => ({
        id: `subplot.${index}`,
        kind: 'subplot',
        label: `subplot.${index}`,
        editable: ['left'],
        currentProps: {},
      })),
      ...[0, 1, 2, 3].map(index => ({
        id: `axis.x.${index}`,
        kind: 'axis_x',
        label: 'X axis',
        editable: ['label', 'tick_labelsize'],
        currentProps: {},
        role: 'x_axis',
        subplotId: `subplot.${index}`,
        stableKey: `axis:x:subplot.${index}`,
      })),
    ] as Manifest['objects']);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'axis.x.0', prop: 'label', value: 'New X', mode: 'backend_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches.map(patch => patch.gid)).toEqual(['axis.x.0']);
  });

  it('does not fan out an explicit spine-side patch without an editing intent', () => {
    const source = baseManifest([
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'subplot.0',
        editable: ['left'],
        currentProps: {},
      },
      {
        id: 'spine.left.0',
        kind: 'spine',
        label: 'Left frame',
        editable: ['linewidth', 'color'],
        currentProps: {},
        role: 'spine',
        subplotId: 'subplot.0',
        stableKey: 'spine:left:subplot.0',
      },
    ]);
    const target = baseManifest([
      ...[0, 1, 2, 3].map(index => ({
        id: `subplot.${index}`,
        kind: 'subplot',
        label: `subplot.${index}`,
        editable: ['left'],
        currentProps: {},
      })),
      ...[0, 1, 2, 3].flatMap(index => (
        ['left', 'right', 'top', 'bottom'].map(side => ({
          id: `spine.${side}.${index}`,
          kind: 'spine',
          label: `${side} frame ${index}`,
          editable: ['linewidth', 'color'],
          currentProps: {},
          role: 'spine',
          subplotId: `subplot.${index}`,
          stableKey: `spine:${side}:subplot.${index}`,
        }))
      )),
    ] as Manifest['objects']);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'spine.left.0', prop: 'linewidth', value: 1.8, mode: 'backend_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches.map(patch => patch.gid)).toEqual(['spine.left.0']);
  });

  it('recomputes patch mode from the target object capability', () => {
    const source = baseManifest([{
      id: 'line.0',
      kind: 'line',
      label: 'Series',
      editable: ['color'],
      currentProps: { color: '#123456' },
      stableKey: 'series:one',
    }]);
    const target = baseManifest([{
      id: 'line.7',
      kind: 'line',
      label: 'Series',
      editable: ['color'],
      currentProps: { color: '#123456' },
      stableKey: 'series:one',
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    }]);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'line.0', prop: 'color', value: '#abcdef', mode: 'local_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      { gid: 'line.7', prop: 'color', value: '#abcdef', mode: 'backend_patch', stableKey: 'series:one' },
    ]);
  });

  it('maps a selected pie slice by pie identity instead of a conflicting raw gid', () => {
    const source = baseManifest([{
      id: 'patch.0.8',
      kind: 'patch',
      label: 'Pie A source',
      editable: ['facecolor'],
      currentProps: { facecolor: '#123456' },
      role: 'pie_slice',
      subplotId: 'subplot.0',
      stableKey: 'source-pie-slice',
      fingerprint: 'source-fingerprint',
      fingerprintVersion: 2,
      identity: {
        instanceKey: 'subplot:patch.0.8',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 0 },
      },
    }]);
    const target = baseManifest([
      {
        id: 'patch.0.8',
        kind: 'patch',
        label: 'Unrelated bar',
        editable: ['facecolor'],
        currentProps: { facecolor: '#999999' },
        role: 'bar_series',
        subplotId: 'subplot.0',
      },
      {
        id: 'patch.0.12',
        kind: 'patch',
        label: 'Pie A target',
        editable: ['facecolor'],
        currentProps: { facecolor: '#654321' },
        role: 'pie_slice',
        subplotId: 'subplot.0',
        stableKey: 'target-pie-slice',
        fingerprint: 'target-fingerprint',
        fingerprintVersion: 2,
        identity: {
          instanceKey: 'subplot:patch.0.12',
          scope: 'subplot',
          coordinateSpace: 'data',
          relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 0 },
        },
      },
      {
        id: 'patch.0.13',
        kind: 'patch',
        label: 'Pie B target',
        editable: ['facecolor'],
        currentProps: { facecolor: '#abcdef' },
        role: 'pie_slice',
        subplotId: 'subplot.0',
        identity: {
          instanceKey: 'subplot:patch.0.13',
          scope: 'subplot',
          coordinateSpace: 'data',
          relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 1 },
        },
      },
    ]);

    const result = mapPatchesToTargetFigure(
      [{
        gid: 'patch.0.8',
        prop: 'facecolor',
        value: '#aa3377',
        mode: 'local_patch',
        stableKey: 'source-pie-slice',
        fingerprint: 'source-fingerprint',
        fingerprintVersion: 2,
        identity: source.objects[0].identity,
      }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([
      {
        gid: 'patch.0.12',
        prop: 'facecolor',
        value: '#aa3377',
        mode: 'local_patch',
        stableKey: 'target-pie-slice',
        fingerprint: 'target-fingerprint',
        fingerprintVersion: 2,
        identity: target.objects[1].identity,
      },
    ]);
  });

  it('does not map the same slice index across different pie identities', () => {
    const source = baseManifest([{
      id: 'patch.source',
      kind: 'patch',
      label: 'Shared slice',
      editable: ['facecolor'],
      currentProps: { facecolor: '#123456' },
      role: 'pie_slice',
      identity: {
        instanceKey: 'subplot:patch.source',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 0 },
      },
    }]);
    const target = baseManifest([{
      id: 'patch.target',
      kind: 'patch',
      label: 'Shared slice',
      editable: ['facecolor'],
      currentProps: { facecolor: '#654321' },
      role: 'pie_slice',
      identity: {
        instanceKey: 'subplot:patch.target',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', pieId: 'pie.0.1', sliceIndex: 0 },
      },
    }]);

    const patch = { gid: 'patch.source', prop: 'facecolor', value: '#abcdef', mode: 'local_patch' };
    const result = mapPatchesToTargetFigure([patch], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([patch]);
  });

  it('fails closed when a pie target is missing relation metadata', () => {
    const source = baseManifest([{
      id: 'patch.source',
      kind: 'patch',
      label: 'Shared slice',
      editable: ['facecolor'],
      currentProps: { facecolor: '#123456' },
      role: 'pie_slice',
      identity: {
        instanceKey: 'subplot:patch.source',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 0 },
      },
    }]);
    const target = baseManifest([{
      id: 'patch.target',
      kind: 'patch',
      label: 'Shared slice',
      editable: ['facecolor'],
      currentProps: { facecolor: '#654321' },
      role: 'pie_slice',
      identity: {
        instanceKey: 'subplot:patch.target',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0' },
      },
    }]);

    const patch = { gid: 'patch.source', prop: 'facecolor', value: '#abcdef', mode: 'local_patch' };
    const result = mapPatchesToTargetFigure([patch], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([patch]);
  });

  it('skips duplicate matches within the same pie identity', () => {
    const source = baseManifest([{
      id: 'patch.source',
      kind: 'patch',
      label: 'Shared slice',
      editable: ['facecolor'],
      currentProps: { facecolor: '#123456' },
      role: 'pie_slice',
      identity: {
        instanceKey: 'subplot:patch.source',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 0 },
      },
    }]);
    const duplicateTarget = (id: string) => ({
      id,
      kind: 'patch' as const,
      label: 'Shared slice',
      editable: ['facecolor'],
      currentProps: { facecolor: '#654321' },
      role: 'pie_slice',
      identity: {
        instanceKey: `subplot:${id}`,
        scope: 'subplot' as const,
        coordinateSpace: 'data' as const,
        relation: { subplotId: 'subplot.0', pieId: 'pie.0.0', sliceIndex: 0 },
      },
    });
    const target = baseManifest([
      duplicateTarget('patch.target.a'),
      duplicateTarget('patch.target.b'),
    ]);

    const patch = { gid: 'patch.source', prop: 'facecolor', value: '#abcdef', mode: 'local_patch' };
    const result = mapPatchesToTargetFigure([patch], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([patch]);
  });

  it('skips equal-scoring semantic candidates instead of choosing by array order', () => {
    const source = baseManifest([{
      id: 'line.source',
      kind: 'line',
      label: 'Series',
      editable: ['color'],
      currentProps: { color: '#123456' },
      role: 'data_line',
    }]);
    const target = baseManifest([
      {
        id: 'line.target.a',
        kind: 'line',
        label: 'Series',
        editable: ['color'],
        currentProps: { color: '#123456' },
        role: 'data_line',
      },
      {
        id: 'line.target.b',
        kind: 'line',
        label: 'Series',
        editable: ['color'],
        currentProps: { color: '#123456' },
        role: 'data_line',
      },
    ]);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'line.source', prop: 'color', value: '#abcdef', mode: 'local_patch' }],
      source,
      target,
    );

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it.each([
    ['quiver', 'quiver_field', 'quiverId', 'quiver.0.0'],
    ['streamplot', 'streamplot_field', 'streamplotId', 'container.streamplot.0.0'],
  ] as const)('maps %s fields only through their trusted family relation', (
    kind,
    role,
    relationField,
    relationId,
  ) => {
    const source = baseManifest([{
      id: `${kind}.source`,
      kind,
      label: `${kind} source`,
      editable: ['color'],
      currentProps: { color: '#123456' },
      role,
      stableKey: `source-${kind}`,
      identity: {
        instanceKey: `subplot:${kind}.source`,
        seriesKey: `source-${kind}`,
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', [relationField]: relationId },
      },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    }]);
    const target = baseManifest([{
      id: `${kind}.target`,
      kind,
      label: `${kind} target`,
      editable: ['color'],
      currentProps: { color: '#654321' },
      role,
      stableKey: `target-${kind}`,
      fingerprint: `target-${kind}-fingerprint`,
      fingerprintVersion: 2,
      identity: {
        instanceKey: `subplot:${kind}.target`,
        seriesKey: `target-${kind}`,
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0', [relationField]: relationId },
      },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    }]);

    const result = mapPatchesToTargetFigure(
      [{ gid: `${kind}.source`, prop: 'color', value: '#abcdef', mode: 'local_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([{
      gid: `${kind}.target`,
      prop: 'color',
      value: '#abcdef',
      mode: 'backend_patch',
      stableKey: `target-${kind}`,
      fingerprint: `target-${kind}-fingerprint`,
      fingerprintVersion: 2,
      identity: target.objects[0].identity,
    }]);
  });

  it.each([
    ['quiver', 'quiver_field', 'quiverId', 'quiver.0.0', 'quiver.0.1'],
    ['streamplot', 'streamplot_field', 'streamplotId', 'container.streamplot.0.0', undefined],
  ] as const)('fails closed for incompatible or missing %s relation metadata', (
    kind,
    role,
    relationField,
    sourceRelationId,
    targetRelationId,
  ) => {
    const object = (id: string, relationId: string | undefined): ManifestObject => ({
      id,
      kind,
      label: kind,
      editable: ['color'],
      currentProps: { color: '#123456' },
      role,
      identity: {
        instanceKey: `subplot:${id}`,
        scope: 'subplot' as const,
        coordinateSpace: 'data' as const,
        relation: {
          subplotId: 'subplot.0',
          ...(relationId ? { [relationField]: relationId } : {}),
        },
      },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    });
    const source = baseManifest([object(`${kind}.source`, sourceRelationId)]);
    const target = baseManifest([object(`${kind}.target`, targetRelationId)]);
    const input = { gid: `${kind}.source`, prop: 'color', value: '#abcdef', mode: 'backend_patch' };

    const result = mapPatchesToTargetFigure([input], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([input]);
  });

  it.each([
    ['patch', 'facecolor', 'local_patch', 'quiverId', 'quiver.0.0'],
    ['line', 'color', 'local_patch', 'streamplotId', 'container.streamplot.0.0'],
  ] as const)('maps a %s vector-field legend marker only when its trusted relation matches', (
    kind,
    prop,
    patchMode,
    relationField,
    relationId,
  ) => {
    const marker = (fingerprint: string): ManifestObject => ({
      id: kind === 'patch' ? 'legend_patch.0.0' : 'legend_line.0.0',
      kind,
      label: 'vector legend marker',
      editable: [prop],
      currentProps: { [prop]: '#123456' },
      role: 'legend_marker',
      fingerprint,
      fingerprintVersion: 2,
      identity: {
        instanceKey: `container:${kind}:vector-marker`,
        seriesKey: `${kind}:vector-marker`,
        scope: 'container',
        coordinateSpace: 'container',
        relation: {
          subplotId: 'subplot.0',
          parentId: kind === 'patch' ? 'collection.0.0' : 'container.streamplot.0.0',
          [relationField]: relationId,
        },
      },
      propertyCapabilities: [{
        prop,
        patchMode,
        scopes: ['object', 'cross_figure'],
        preview: 'exact',
        replay: 'stable',
      }],
    });
    const source = baseManifest([marker('source-fingerprint')]);
    const target = baseManifest([marker('target-fingerprint')]);
    const input = { gid: source.objects[0].id, prop, value: '#abcdef', mode: 'backend_patch' };

    const result = mapPatchesToTargetFigure([input], source, target);

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([{
      gid: target.objects[0].id,
      prop,
      value: '#abcdef',
      mode: patchMode,
      fingerprint: 'target-fingerprint',
      fingerprintVersion: 2,
      identity: target.objects[0].identity,
    }]);
  });

  it.each([
    ['patch', 'facecolor', 'quiverId', 'quiver.0.0', 'quiver.0.1'],
    ['line', 'color', 'streamplotId', 'container.streamplot.0.0', undefined],
  ] as const)('fails closed when a %s vector-field legend marker relation differs or is missing', (
    kind,
    prop,
    relationField,
    sourceRelationId,
    targetRelationId,
  ) => {
    const marker = (relationId: string | undefined): ManifestObject => ({
      id: kind === 'patch' ? 'legend_patch.0.0' : 'legend_line.0.0',
      kind,
      label: 'vector legend marker',
      editable: [prop],
      currentProps: { [prop]: '#123456' },
      role: 'legend_marker',
      identity: {
        instanceKey: `container:${kind}:vector-marker`,
        scope: 'container',
        coordinateSpace: 'container',
        relation: {
          subplotId: 'subplot.0',
          parentId: kind === 'patch' ? 'collection.0.0' : 'container.streamplot.0.0',
          ...(relationId ? { [relationField]: relationId } : {}),
        },
      },
      propertyCapabilities: [{
        prop,
        patchMode: 'local_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'exact',
        replay: 'stable',
      }],
    });
    const source = baseManifest([marker(sourceRelationId)]);
    const target = baseManifest([marker(targetRelationId)]);
    const input = { gid: source.objects[0].id, prop, value: '#abcdef', mode: 'local_patch' };

    const result = mapPatchesToTargetFigure([input], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([input]);
  });

  it('maps diagram objects only through the complete trusted semantic relation', () => {
    const diagramObject = (id: string, fingerprint: string): ManifestObject => ({
      id,
      kind: 'line',
      label: 'SEM path',
      editable: ['color'],
      currentProps: { color: '#123456' },
      role: 'diagram_edge',
      stableKey: `stable-${id}`,
      fingerprint,
      fingerprintVersion: 2,
      identity: {
        instanceKey: `subplot:${id}`,
        seriesKey: 'diagram:sem.demo:diagram_edge:path.a.b',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: {
          subplotId: 'subplot.0',
          diagramId: 'sem.demo',
          diagramType: 'sem',
          diagramObjectId: 'path.a.b',
          edgeId: 'path.a.b',
          sourceNodeId: 'node.a',
          targetNodeId: 'node.b',
        },
      },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    });
    const source = baseManifest([diagramObject('line.source', 'source-fingerprint')]);
    const targetObject = diagramObject('line.target', 'target-fingerprint');
    const target = baseManifest([targetObject]);

    const result = mapPatchesToTargetFigure(
      [{ gid: 'line.source', prop: 'color', value: '#abcdef', mode: 'local_patch' }],
      source,
      target,
    );

    expect(result.skipped).toHaveLength(0);
    expect(result.patches).toEqual([{
      gid: 'line.target',
      prop: 'color',
      value: '#abcdef',
      mode: 'backend_patch',
      stableKey: 'stable-line.target',
      fingerprint: 'target-fingerprint',
      fingerprintVersion: 2,
      identity: targetObject.identity,
    }]);
  });

  it.each([
    [{ diagramId: 'sem.other' }, 'different diagram'],
    [{ diagramObjectId: 'path.other' }, 'different object'],
    [{ edgeId: 'path.other' }, 'different edge'],
    [{ sourceNodeId: 'node.other' }, 'different source node'],
    [{ targetNodeId: 'node.other' }, 'different target node'],
    [{ diagramType: undefined }, 'missing diagram type'],
    [{ diagramObjectId: undefined }, 'missing object id'],
  ])('fails closed for a diagram target with %s', (relationOverride, _description) => {
    const relation = {
      subplotId: 'subplot.0',
      diagramId: 'sem.demo',
      diagramType: 'sem',
      diagramObjectId: 'path.a.b',
      edgeId: 'path.a.b',
      sourceNodeId: 'node.a',
      targetNodeId: 'node.b',
    };
    const diagramObject = (id: string, overrides: Record<string, unknown> = {}): ManifestObject => ({
      id,
      kind: 'line',
      label: 'SEM path',
      editable: ['color'],
      currentProps: { color: '#123456' },
      role: 'diagram_edge',
      identity: {
        instanceKey: `subplot:${id}`,
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { ...relation, ...overrides },
      },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    });
    const source = baseManifest([diagramObject('line.source')]);
    const target = baseManifest([diagramObject('line.target', relationOverride)]);
    const input = { gid: 'line.source', prop: 'color', value: '#abcdef', mode: 'backend_patch' };

    const result = mapPatchesToTargetFigure([input], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([input]);
  });

  it('does not map a diagram edge to an ordinary line with matching generic identity', () => {
    const sourceObject: ManifestObject = {
      id: 'line.source',
      kind: 'line',
      label: 'shared label',
      editable: ['color'],
      currentProps: { color: '#123456' },
      role: 'diagram_edge',
      stableKey: 'shared-stable-key',
      identity: {
        semanticKey: 'shared-semantic-key',
        instanceKey: 'shared-instance-key',
        seriesKey: 'shared-series-key',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: {
          subplotId: 'subplot.0',
          diagramId: 'sem.demo',
          diagramType: 'sem',
          diagramObjectId: 'path.a.b',
          edgeId: 'path.a.b',
          sourceNodeId: 'node.a',
          targetNodeId: 'node.b',
        },
      },
      propertyCapabilities: [{
        prop: 'color', patchMode: 'backend_patch', scopes: ['object', 'cross_figure'],
        preview: 'none', replay: 'stable',
      }],
    };
    const targetObject: ManifestObject = {
      ...sourceObject,
      id: 'line.target',
      role: 'line_series',
      identity: { ...sourceObject.identity, relation: { subplotId: 'subplot.0' } },
    };
    const input = { gid: sourceObject.id, prop: 'color', value: '#abcdef', mode: 'backend_patch' };

    const result = mapPatchesToTargetFigure(
      [input],
      baseManifest([sourceObject]),
      baseManifest([targetObject]),
    );

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([input]);
  });

  it('fails closed when an exact diagram gid has a duplicate trusted relation target', () => {
    const relation = {
      subplotId: 'subplot.0',
      diagramId: 'sem.demo',
      diagramType: 'sem',
      diagramObjectId: 'path.a.b',
      edgeId: 'path.a.b',
      sourceNodeId: 'node.a',
      targetNodeId: 'node.b',
    };
    const diagramEdge = (id: string): ManifestObject => ({
      id,
      kind: 'line',
      label: 'SEM path',
      editable: ['color'],
      currentProps: { color: '#123456' },
      role: 'diagram_edge',
      identity: {
        instanceKey: `subplot:${id}`,
        scope: 'subplot',
        coordinateSpace: 'data',
        relation,
      },
      propertyCapabilities: [{
        prop: 'color', patchMode: 'backend_patch', scopes: ['object', 'cross_figure'],
        preview: 'none', replay: 'stable',
      }],
    });
    const source = baseManifest([diagramEdge('line.0.0')]);
    const target = baseManifest([diagramEdge('line.0.0'), diagramEdge('line.0.1')]);
    const input = { gid: 'line.0.0', prop: 'color', value: '#abcdef', mode: 'backend_patch' };

    const result = mapPatchesToTargetFigure([input], source, target);

    expect(result.patches).toHaveLength(0);
    expect(result.skipped).toEqual([input]);
  });
});
