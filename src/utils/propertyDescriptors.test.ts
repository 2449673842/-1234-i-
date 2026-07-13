import { describe, expect, it } from 'vitest';
import type { ManifestObject, ManifestPropertyCapability } from '../schemas/manifest';
import {
  getPropertyDescriptorsForCenter,
  projectPropertyDescriptors,
  resolveCanonicalPropertyAlias,
} from './propertyDescriptors';

function capability(
  prop: string,
  replay: ManifestPropertyCapability['replay'] = 'stable',
  unsupportedReason?: string,
  coordinateSpace?: ManifestPropertyCapability['coordinateSpace'],
): ManifestPropertyCapability {
  return {
    prop,
    patchMode: 'backend_patch',
    scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
    preview: 'none',
    replay,
    unsupportedReason,
    coordinateSpace,
  };
}

function object(overrides: Partial<ManifestObject>): ManifestObject {
  return {
    id: 'obj.0',
    kind: 'text',
    label: 'Object',
    editable: [],
    currentProps: {},
    ...overrides,
  } as ManifestObject;
}

function byKey(result: ReturnType<typeof projectPropertyDescriptors>, key: string) {
  const descriptor = result.find(item => item.key === key);
  expect(descriptor).toBeDefined();
  return descriptor!;
}

describe('property descriptor projection', () => {
  it('resolves text style aliases to virtual tick properties by semantic role', () => {
    const axis = object({
      id: 'axis.x.0',
      kind: 'axis_x',
      editable: ['tick_labelsize'],
      currentProps: { tick_labelsize: 9 },
      propertyCapabilities: [capability('tick_labelsize')],
    });

    expect(resolveCanonicalPropertyAlias('fontsize', axis, 'x_tick_label')).toBe('tick_labelsize');

    const projected = byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [axis],
      semanticRole: 'x_tick_label',
      scope: 'group',
    }), 'fontsize');
    expect(projected.state).toBe('editable');
    expect(projected.propByObjectId).toEqual({ 'axis.x.0': 'tick_labelsize' });
    expect(projected.value).toBe(9);
  });

  it('marks an editable property as mixed when selected values differ', () => {
    const title = object({
      id: 'title.0',
      editable: ['fontsize'],
      currentProps: { fontsize: 12 },
      propertyCapabilities: [capability('fontsize')],
    });
    const label = object({
      id: 'xlabel.0',
      editable: ['fontsize'],
      currentProps: { fontsize: 14 },
      propertyCapabilities: [capability('fontsize')],
    });

    const projected = byKey(projectPropertyDescriptors({ center: 'fonts', objects: [title, label], scope: 'object' }), 'fontsize');

    expect(projected.state).toBe('mixed');
    expect(projected.counts).toEqual({
      total: 2, editable: 2, readonly: 0, unsupported: 0, conditional: 0, legacyFallback: 0,
    });
    expect(projected.value).toBeUndefined();
  });

  it('marks partial support when only some selected objects can edit the property', () => {
    const editableText = object({
      id: 'title.0',
      editable: ['fontfamily'],
      currentProps: { fontfamily: 'Arial' },
      propertyCapabilities: [capability('fontfamily')],
    });
    const line = object({
      id: 'line.0',
      kind: 'line',
      editable: ['linewidth'],
      currentProps: { linewidth: 2 },
      propertyCapabilities: [capability('linewidth')],
    });

    const projected = byKey(projectPropertyDescriptors({ center: 'fonts', objects: [editableText, line], scope: 'object' }), 'fontfamily');

    expect(projected.state).toBe('partial');
    expect(projected.stateByObjectId).toEqual({
      'title.0': 'editable',
      'line.0': 'unsupported',
    });
    expect(projected.counts).toEqual({
      total: 2, editable: 1, readonly: 0, unsupported: 1, conditional: 0, legacyFallback: 0,
    });
  });

  it('honors unsupported property capabilities over editable fallback', () => {
    const title = object({
      id: 'title.0',
      editable: ['fontsize'],
      currentProps: { fontsize: 12 },
      propertyCapabilities: [capability('fontsize', 'unsupported', 'backend cannot replay font size')],
    });

    const projected = byKey(projectPropertyDescriptors({ center: 'fonts', objects: [title], scope: 'object' }), 'fontsize');

    expect(projected.state).toBe('unsupported');
    expect(projected.counts).toEqual({
      total: 1, editable: 0, readonly: 0, unsupported: 1, conditional: 0, legacyFallback: 0,
    });
    expect(projected.unsupportedReasons).toEqual({
      'title.0': 'backend cannot replay font size',
    });
  });

  it('does not mutate manifest objects while projecting legacy fallback support', () => {
    const legacy = object({
      id: 'r.text.0',
      editable: ['color'],
      currentProps: { color: '#333333', unsupportedProps: ['alpha'] },
    });
    const before = JSON.stringify(legacy);

    const projected = projectPropertyDescriptors({ center: 'properties', objects: [legacy] });

    expect(JSON.stringify(legacy)).toBe(before);
    expect(byKey(projected, 'color').state).toBe('editable');
    expect(byKey(projected, 'alpha').state).toBe('unsupported');
    expect(byKey(projected, 'color').counts.legacyFallback).toBe(1);
  });

  it('projects legacy editable fields as readonly when strict fallback is disabled', () => {
    const legacy = object({
      id: 'title.legacy',
      editable: ['fontsize'],
      currentProps: { fontsize: 12 },
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [legacy],
      scope: 'object',
      allowLegacyFallback: false,
    }), 'fontsize');

    expect(projected.state).toBe('readonly');
    expect(projected.stateByObjectId['title.legacy']).toBe('readonly');
    expect(projected.counts).toEqual({
      total: 1, editable: 0, readonly: 1, unsupported: 0, conditional: 0, legacyFallback: 1,
    });
    expect(projected.unsupportedReasons['title.legacy']).toContain('严格目标解析已阻止写回');
  });

  it('treats property capabilities as authoritative even when editable is absent', () => {
    const title = object({
      id: 'title.0',
      editable: [],
      currentProps: { rotation: 15 },
      propertyCapabilities: [capability('rotation')],
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [title],
      scope: 'object',
    }), 'rotation');

    expect(projected.state).toBe('editable');
    expect(projected.value).toBe(15);
  });

  it('exposes visibility and opacity in the font center when figure-scope replay is supported', () => {
    const title = object({
      id: 'title.0',
      currentProps: { visible: true, alpha: 0.8 },
      propertyCapabilities: [capability('visible'), capability('alpha')],
    });

    const projected = projectPropertyDescriptors({
      center: 'fonts',
      objects: [title],
      scope: 'figure',
    });

    expect(byKey(projected, 'visible').state).toBe('editable');
    expect(byKey(projected, 'alpha').state).toBe('editable');
  });

  it('does not advertise a font group property that cannot replay at figure scope', () => {
    const title = object({
      id: 'title.0',
      currentProps: { fontsize: 12 },
      propertyCapabilities: [{
        ...capability('fontsize'),
        scopes: ['group'],
      }],
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [title],
      scope: 'figure',
    }), 'fontsize');

    expect(projected.state).toBe('readonly');
    expect(projected.unsupportedReasons['title.0']).toContain('figure');
  });

  it('does not alias tick-line color to canonical text color', () => {
    const axis = object({
      id: 'axis.x.0',
      kind: 'axis_x',
      editable: ['tick_color'],
      currentProps: { tick_color: '#111111' },
      propertyCapabilities: [capability('tick_color')],
    });

    expect(resolveCanonicalPropertyAlias('color', axis, 'x_tick_label')).toBeUndefined();
    expect(byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [axis],
      semanticRole: 'x_tick_label',
      scope: 'group',
    }), 'color').state).toBe('unsupported');
  });

  it('filters descriptors by editing center', () => {
    const line = object({
      id: 'line.0',
      kind: 'line',
      editable: ['linewidth'],
      currentProps: { linewidth: 1 },
    });

    const fontKeys = projectPropertyDescriptors({ center: 'fonts', objects: [line] }).map(item => item.key);
    const componentKeys = projectPropertyDescriptors({ center: 'components', objects: [line] }).map(item => item.key);

    expect(fontKeys).not.toContain('linewidth');
    expect(componentKeys).toContain('linewidth');
  });

  it('projects capability-backed component controls without a kind property whitelist', () => {
    const line = object({
      id: 'line.0',
      kind: 'line',
      editable: [],
      currentProps: {
        color: '#225577',
        linewidth: 1.5,
        alpha: 0.8,
        visible: true,
      },
      propertyCapabilities: [
        capability('color'),
        capability('linewidth'),
        capability('alpha'),
        capability('visible'),
      ],
    });

    const projected = projectPropertyDescriptors({
      center: 'components',
      objects: [line],
      scope: 'group',
    });

    for (const key of ['color', 'linewidth', 'alpha', 'visible']) {
      const projection = byKey(projected, key);
      expect(projection.state).toBe('editable');
      expect(projection.propByObjectId['line.0']).toBe(key);
      expect(projection.counts.editable).toBe(1);
    }
  });

  it('reuses typography descriptors for text objects in the component center', () => {
    const text = object({
      id: 'text.0',
      kind: 'text',
      editable: [],
      currentProps: {
        fontfamily: 'Arial',
        fontsize: 11,
        fontweight: 'bold',
        fontstyle: 'italic',
        color: '#333333',
      },
      propertyCapabilities: [
        capability('fontfamily'),
        capability('fontsize'),
        capability('fontweight'),
        capability('fontstyle'),
        capability('color'),
      ],
    });

    const projected = projectPropertyDescriptors({
      center: 'components',
      objects: [text],
      scope: 'group',
    });

    expect(byKey(projected, 'fontfamily').value).toBe('Arial');
    expect(byKey(projected, 'fontsize').value).toBe(11);
    expect(byKey(projected, 'fontweight').value).toBe('bold');
    expect(byKey(projected, 'fontstyle').value).toBe('italic');
    expect(byKey(projected, 'color').value).toBe('#333333');
  });

  it('keeps a component property readonly when group replay is not declared', () => {
    const line = object({
      id: 'line.0',
      kind: 'line',
      currentProps: { linewidth: 1.5 },
      propertyCapabilities: [{
        ...capability('linewidth'),
        scopes: ['object'],
      }],
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'components',
      objects: [line],
      scope: 'group',
    }), 'linewidth');

    expect(projected.state).toBe('readonly');
    expect(projected.stateByObjectId).toEqual({ 'line.0': 'readonly' });
    expect(projected.counts.readonly).toBe(1);
    expect(projected.unsupportedReasons['line.0']).toContain('group');
  });

  it('uses a resolver-confirmed property without changing default aliases', () => {
    const patch = object({
      id: 'patch.0',
      kind: 'patch',
      currentProps: { facecolor: '#445566' },
      propertyCapabilities: [capability('facecolor')],
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'palette',
      objects: [patch],
      scope: 'object',
      resolvedPropByKey: { color: { 'patch.0': 'facecolor' } },
    }), 'color');

    expect(projected.state).toBe('editable');
    expect(projected.propByObjectId['patch.0']).toBe('facecolor');
    expect(projected.value).toBe('#445566');
    expect(resolveCanonicalPropertyAlias('color', patch)).toBeUndefined();
  });

  it('keeps a supported property readonly when the requested scope is not declared', () => {
    const title = object({
      id: 'title.0',
      currentProps: { fontsize: 12 },
      propertyCapabilities: [{
        ...capability('fontsize'),
        scopes: ['object'],
      }],
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [title],
      scope: 'group',
    }), 'fontsize');

    expect(projected.state).toBe('readonly');
    expect(projected.counts.readonly).toBe(1);
    expect(projected.unsupportedReasons['title.0']).toContain('group');
  });

  it('reports conditional replay without hiding an editable capability', () => {
    const annotation = object({
      id: 'annotation.0',
      currentProps: { rotation: 20 },
      propertyCapabilities: [capability('rotation', 'conditional')],
    });

    const projected = byKey(projectPropertyDescriptors({
      center: 'fonts',
      objects: [annotation],
      scope: 'object',
    }), 'rotation');

    expect(projected.state).toBe('editable');
    expect(projected.counts.conditional).toBe(1);
  });

  it('groups layout center descriptors without leaking text layout controls', () => {
    const descriptors = getPropertyDescriptorsForCenter('layout');
    const keys = descriptors.map(descriptor => descriptor.key);

    expect(keys).toEqual(['left', 'bottom', 'width', 'height', 'aspect', 'position']);
    expect(descriptors.filter(descriptor => descriptor.family === 'layout_geometry').map(descriptor => descriptor.key)).toEqual([
      'left',
      'bottom',
      'width',
      'height',
      'aspect',
    ]);
    expect(descriptors.find(descriptor => descriptor.key === 'position')?.family).toBe('position');
    expect(keys).not.toEqual(expect.arrayContaining(['rotation', 'ha', 'va']));
    expect(descriptors.every(descriptor => descriptor.coordinateSpace)).toBe(true);
  });

  it('projects subplot geometry through the layout center at subplot scope', () => {
    const subplot = object({
      id: 'subplot.0',
      kind: 'subplot',
      currentProps: {
        left: 0.12,
        bottom: 0.15,
        width: 0.78,
        height: 0.72,
        aspect: 1,
      },
      propertyCapabilities: [
        capability('left', 'stable', undefined, 'figure'),
        capability('bottom', 'stable', undefined, 'figure'),
        capability('width', 'stable', undefined, 'figure'),
        capability('height', 'stable', undefined, 'figure'),
        capability('aspect', 'stable', undefined, 'container'),
      ],
    });

    const projected = projectPropertyDescriptors({
      center: 'layout',
      objects: [subplot],
      scope: 'subplot',
    });

    for (const key of ['left', 'bottom', 'width', 'height', 'aspect'] as const) {
      const projection = byKey(projected, key);
      expect(projection.state).toBe('editable');
      expect(projection.scope).toBe('subplot');
      expect(projection.coordinateSpace).toBe(key === 'aspect' ? 'container' : 'figure');
      expect(projection.coordinateSpaceByObjectId).toEqual({
        'subplot.0': key === 'aspect' ? 'container' : 'figure',
      });
      expect(projection.propByObjectId['subplot.0']).toBe(key);
    }
  });

  it('exposes colorbar geometry and honors missing group-scope capability', () => {
    const colorbar = object({
      id: 'colorbar.0',
      kind: 'colorbar',
      currentProps: {
        left: 0.84,
        bottom: 0.18,
        width: 0.04,
        height: 0.64,
      },
      propertyCapabilities: [
        { ...capability('left', 'stable', undefined, 'figure'), scopes: ['object'] },
        capability('bottom', 'stable', undefined, 'figure'),
        capability('width', 'stable', undefined, 'figure'),
        capability('height', 'stable', undefined, 'figure'),
      ],
    });

    const projected = projectPropertyDescriptors({
      center: 'layout',
      objects: [colorbar],
      scope: 'group',
    });

    const left = byKey(projected, 'left');
    expect(left.state).toBe('readonly');
    expect(left.coordinateSpace).toBe('figure');
    expect(left.unsupportedReasons['colorbar.0']).toContain('group');

    for (const key of ['bottom', 'width', 'height'] as const) {
      const projection = byKey(projected, key);
      expect(projection.state).toBe('editable');
      expect(projection.propByObjectId['colorbar.0']).toBe(key);
      expect(projection.coordinateSpace).toBe('figure');
    }
  });

  it('keeps explicitly unsupported facet bounds visible with the renderer reason', () => {
    const facet = object({
      id: 'subplot.1',
      kind: 'subplot',
      editable: ['aspect'],
      currentProps: {
        aspect: 'auto',
        unsupportedProps: ['left', 'bottom', 'width', 'height'],
        unsupportedReason: 'Facet panels use a shared gtable layout.',
      },
      propertyCapabilities: [capability('aspect', 'stable', undefined, 'container')],
    });

    const projected = projectPropertyDescriptors({
      center: 'layout',
      objects: [facet],
      scope: 'object',
    });

    for (const key of ['left', 'bottom', 'width', 'height'] as const) {
      const projection = byKey(projected, key);
      expect(projection.state).toBe('unsupported');
      expect(projection.propByObjectId['subplot.1']).toBe(key);
      expect(projection.unsupportedReasons['subplot.1']).toContain('shared gtable');
    }
    expect(byKey(projected, 'aspect').state).toBe('editable');
  });

  it('projects position coordinate spaces from capability metadata without mixing typography layout', () => {
    const text = object({
      id: 'text.0',
      kind: 'text',
      currentProps: {
        position: { x: 0.2, y: 0.8, coord_system: 'axes' },
        rotation: 15,
        ha: 'left',
        va: 'top',
      },
      propertyCapabilities: [capability('position', 'stable', undefined, 'axes')],
    });
    const legend = object({
      id: 'legend.0',
      kind: 'legend',
      currentProps: { position: { x: 0.9, y: 0.9, coord_system: 'figure' } },
      propertyCapabilities: [capability('position', 'stable', undefined, 'figure')],
    });

    const projected = projectPropertyDescriptors({
      center: 'layout',
      objects: [text, legend],
      scope: 'object',
    });
    const position = byKey(projected, 'position');

    expect(position.state).toBe('mixed');
    expect(position.coordinateSpace).toBe('mixed');
    expect(position.coordinateSpaceByObjectId).toEqual({
      'text.0': 'axes',
      'legend.0': 'figure',
    });
    expect(projected.map(item => item.key)).not.toEqual(expect.arrayContaining(['rotation', 'ha', 'va']));
  });

  it('does not reinterpret an explicit unknown position coordinate system as axes', () => {
    const nativeText = object({
      id: 'r.text.0',
      kind: 'text',
      editable: ['position'],
      currentProps: { x: 1, y: 2, coord_system: 'native' },
    });

    const position = byKey(projectPropertyDescriptors({
      center: 'layout',
      objects: [nativeText],
      scope: 'object',
    }), 'position');

    expect(position.state).toBe('editable');
    expect(position.coordinateSpace).toBe('none');
    expect(position.coordinateSpaceByObjectId).toEqual({ 'r.text.0': 'none' });
  });

  it('does not advertise legacy position dragging while the strict layout resolver is active', () => {
    const legacyText = object({
      id: 'text.legacy',
      kind: 'text',
      editable: ['position'],
      currentProps: { x: 0.4, y: 0.6, coord_system: 'axes' },
    });

    const strictPosition = byKey(projectPropertyDescriptors({
      center: 'layout',
      objects: [legacyText],
      scope: 'object',
      allowLegacyFallback: false,
    }), 'position');
    const rollbackPosition = byKey(projectPropertyDescriptors({
      center: 'layout',
      objects: [legacyText],
      scope: 'object',
      allowLegacyFallback: true,
    }), 'position');

    expect(strictPosition.state).toBe('readonly');
    expect(rollbackPosition.state).toBe('editable');
    expect(rollbackPosition.coordinateSpaceByObjectId['text.legacy']).toBe('axes');
  });
});
