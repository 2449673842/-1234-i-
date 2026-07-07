import { describe, expect, it } from 'vitest';
import type { Manifest } from '../schemas/manifest';
import { compileEditingIntent, retargetEditingIntentForFigure } from './editingIntentCompiler';

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

describe('editing intent compiler', () => {
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
      },
      operation: { prop: 'color', value: '#118833' },
    };

    const result = compileEditingIntent(targetManifest, retargetEditingIntentForFigure(sourceIntent));

    expect(result.skipped).toHaveLength(0);
    expect(result.patches.map(patch => 'gid' in patch ? patch.gid : '')).toEqual(['ylabel.0', 'ylabel.1']);
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
      { op: 'set', mode: 'local_patch', gid: 'ytick.0.0', prop: 'text', value: 'new A' },
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
});
