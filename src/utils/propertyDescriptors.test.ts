import { describe, expect, it } from 'vitest';
import type { ManifestObject, ManifestPropertyCapability } from '../schemas/manifest';
import {
  projectPropertyDescriptors,
  resolveCanonicalPropertyAlias,
} from './propertyDescriptors';

function capability(
  prop: string,
  replay: ManifestPropertyCapability['replay'] = 'stable',
  unsupportedReason?: string,
): ManifestPropertyCapability {
  return {
    prop,
    patchMode: 'backend_patch',
    scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
    preview: 'none',
    replay,
    unsupportedReason,
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
});
