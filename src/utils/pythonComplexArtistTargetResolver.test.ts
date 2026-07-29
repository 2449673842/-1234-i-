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
});
