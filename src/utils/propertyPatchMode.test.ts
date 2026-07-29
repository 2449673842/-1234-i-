import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import {
  isTextContentPatchProp,
  resolvePatchMode,
  resolvePatchModeById,
  resolvePropertyPatchMode,
} from './propertyPatchMode';

function object(patchMode: 'local_patch' | 'backend_patch', prop = 'color', kind: ManifestObject['kind'] = 'text'): ManifestObject {
  return {
    id: 'title.0',
    kind,
    label: 'Title',
    editable: [prop],
    currentProps: { [prop]: prop === 'text' || prop === 'content' || prop === 'label' || prop === 'title' ? 'Title' : '#000000' },
    propertyCapabilities: [{
      prop,
      patchMode,
      scopes: ['object'],
      preview: 'exact',
      replay: 'stable',
    }],
  };
}

describe('resolvePropertyPatchMode', () => {
  it('uses renderer capability before the legacy local-property rule', () => {
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      object: object('backend_patch'),
      prop: 'color',
      legacyLocal: true,
    })).toBe('backend_patch');
  });

  it('uses renderer capability before the R compatibility fallback', () => {
    expect(resolvePropertyPatchMode({
      generatedBy: 'r_svg',
      object: object('local_patch'),
      prop: 'color',
      legacyLocal: false,
    })).toBe('local_patch');
  });

  it('keeps legacy Python and R behavior when capabilities are absent', () => {
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      prop: 'color',
      legacyLocal: true,
    })).toBe('local_patch');
    expect(resolvePropertyPatchMode({
      generatedBy: 'r_svg',
      prop: 'color',
      legacyLocal: true,
    })).toBe('backend_patch');
  });

  it('forces text content props to backend patches even when stale capabilities claim local patches', () => {
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      object: object('local_patch', 'text'),
      prop: 'text',
      legacyLocal: true,
    })).toBe('backend_patch');
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      object: object('local_patch', 'content'),
      prop: 'content',
      legacyLocal: true,
    })).toBe('backend_patch');
  });

  it('forces scoped text-content aliases to backend patches without changing unrelated local text styling', () => {
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      object: object('local_patch', 'label', 'axis_x'),
      prop: 'label',
      legacyLocal: true,
    })).toBe('backend_patch');
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      object: object('local_patch', 'title', 'legend'),
      prop: 'title',
      legacyLocal: true,
    })).toBe('backend_patch');
    expect(resolvePropertyPatchMode({
      generatedBy: 'matplotlib',
      object: object('local_patch', 'color'),
      prop: 'color',
      legacyLocal: true,
    })).toBe('local_patch');
  });

  it('identifies only content props and scoped aliases as text content patches', () => {
    expect(isTextContentPatchProp('text')).toBe(true);
    expect(isTextContentPatchProp('content')).toBe(true);
    expect(isTextContentPatchProp('label', { kind: 'axis_y' })).toBe(true);
    expect(isTextContentPatchProp('label', { kind: 'subplot' })).toBe(false);
    expect(isTextContentPatchProp('color', { kind: 'text' })).toBe(false);
  });
});

function legacyObject(overrides: Partial<ManifestObject> = {}): ManifestObject {
  return {
    id: 'line.0',
    kind: 'line',
    label: 'line',
    editable: ['color', 'linewidth'],
    currentProps: { color: '#123456', linewidth: 1 },
    ...overrides,
  };
}

function manifest(target: ManifestObject, generatedBy: Manifest['generatedBy'] = 'introspection'): Manifest {
  return {
    generatedBy,
    globals: {},
    objects: [target],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
}

describe('resolvePatchMode', () => {
  it('allows local only for an exact and stable declared capability', () => {
    const target = legacyObject({
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'local_patch',
        scopes: ['object'],
        preview: 'exact',
        replay: 'stable',
      }],
    });
    expect(resolvePatchMode(manifest(target), target, 'color')).toBe('local_patch');
  });

  it('promotes approximate, conditional, text, and R edits to backend validation', () => {
    const approximate = legacyObject({
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'local_patch',
        scopes: ['object'],
        preview: 'approximate',
        replay: 'stable',
      }],
    });
    const conditional = legacyObject({
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'local_patch',
        scopes: ['object'],
        preview: 'exact',
        replay: 'conditional',
      }],
    });
    const text = legacyObject({ kind: 'text', editable: ['text'], currentProps: { text: 'Title' } });
    expect(resolvePatchMode(manifest(approximate), approximate, 'color')).toBe('backend_patch');
    expect(resolvePatchMode(manifest(conditional), conditional, 'color')).toBe('backend_patch');
    expect(resolvePatchMode(manifest(text), text, 'text')).toBe('backend_patch');
    expect(resolvePatchMode(manifest(approximate, 'r_svg'), approximate, 'color')).toBe('backend_patch');
  });

  it('fails closed for omitted capabilities, unsupported props, grids, and missing gids', () => {
    const omitted = legacyObject({ propertyCapabilities: [] });
    const unsupported = legacyObject({ currentProps: { color: '#123456', unsupportedProps: ['color'] } });
    const grid = legacyObject({ kind: 'grid', editable: ['visible'], currentProps: { visible: false } });
    expect(resolvePatchMode(manifest(omitted), omitted, 'color')).toBe('backend_patch');
    expect(resolvePatchMode(manifest(unsupported), unsupported, 'color')).toBe('backend_patch');
    expect(resolvePatchMode(manifest(grid), grid, 'visible')).toBe('backend_patch');
    expect(resolvePatchModeById(manifest(omitted), 'missing.0', 'color')).toBe('backend_patch');
  });
});
