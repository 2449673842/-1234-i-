import { describe, expect, it } from 'vitest';
import type { Binding, Manifest, ManifestObject } from '../schemas/manifest';
import { buildPaletteObjectPatches, buildPaletteUpdatePatches, resolvePaletteTargets } from './paletteTargetResolver';

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
});
