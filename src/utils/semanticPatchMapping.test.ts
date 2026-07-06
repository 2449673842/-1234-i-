import { describe, expect, it } from 'vitest';
import type { Manifest } from '../schemas/manifest';
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

  it('fans out single-panel style patches to every matching subplot in a multi-panel target', () => {
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
    expect(result.patches.map(patch => patch.gid)).toEqual([
      'spine_group.0',
      'spine_group.1',
      'spine_group.2',
      'spine_group.3',
    ]);
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

  it('fans out single spine side style patches to the same side in every target subplot', () => {
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
    expect(result.patches.map(patch => patch.gid)).toEqual([
      'spine.left.0',
      'spine.left.1',
      'spine.left.2',
      'spine.left.3',
    ]);
  });
});
