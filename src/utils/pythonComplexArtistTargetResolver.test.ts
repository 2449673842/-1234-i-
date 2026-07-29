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
});
