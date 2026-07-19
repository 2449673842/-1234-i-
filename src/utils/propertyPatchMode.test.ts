import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import {
  isParentOwnedManifestObject,
  resolveCrossFigurePolicy,
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

describe('resolveCrossFigurePolicy', () => {
  it('allows cross-Figure replay only when every target explicitly supports it', () => {
    const first = legacyObject({
      id: 'contourf.0.0',
      kind: 'contourf',
      propertyCapabilities: [{
        prop: 'alpha',
        patchMode: 'backend_patch',
        scopes: ['object', 'group', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    });
    const second = legacyObject({
      id: 'contourf.1.0',
      kind: 'contourf',
      propertyCapabilities: [{
        prop: 'alpha',
        patchMode: 'backend_patch',
        scopes: ['object', 'group', 'cross_figure'],
        preview: 'none',
        replay: 'conditional',
      }],
    });

    expect(resolveCrossFigurePolicy([first, second], 'alpha')).toBe('allow');
  });

  it('denies cross-Figure replay for object-only, unsupported, legacy, or empty targets', () => {
    const objectOnly = legacyObject({
      propertyCapabilities: [{
        prop: 'cmap',
        patchMode: 'backend_patch',
        scopes: ['object', 'group'],
        preview: 'none',
        replay: 'stable',
      }],
    });
    const unsupported = legacyObject({
      propertyCapabilities: [{
        prop: 'cmap',
        patchMode: 'backend_patch',
        scopes: ['object', 'cross_figure'],
        preview: 'none',
        replay: 'unsupported',
      }],
    });

    expect(resolveCrossFigurePolicy([objectOnly], 'cmap')).toBe('deny');
    expect(resolveCrossFigurePolicy([unsupported], 'cmap')).toBe('deny');
    expect(resolveCrossFigurePolicy([legacyObject()], 'cmap')).toBe('deny');
    expect(resolveCrossFigurePolicy([], 'cmap')).toBe('deny');
  });

  it.each([
    ['histogram_series', 'bar_container', 'bins'],
    ['histogram_series', 'bar_container', 'counts'],
    ['histogram_series', 'bar_container', 'values'],
    ['histogram_series', 'bar_container', 'edges'],
    ['histogram_series', 'bar_container', 'histtype'],
    ['stairs_series', 'patch', 'baseline'],
    ['stairs_series', 'patch', 'values'],
    ['stairs_series', 'patch', 'edges'],
    ['step_series', 'line', 'x'],
    ['step_series', 'line', 'y'],
    ['step_series', 'line', 'where'],
    ['pie_slice', 'patch', 'values'],
    ['pie_slice', 'patch', 'fraction'],
    ['pie_slice', 'patch', 'center'],
    ['pie_slice', 'patch', 'radius'],
    ['pie_slice', 'patch', 'theta1'],
    ['pie_slice', 'patch', 'theta2'],
    ['pie_slice', 'patch', 'width'],
    ['pie_slice', 'patch', 'explode'],
    ['pie_slice', 'patch', 'startangle'],
    ['pie_slice', 'patch', 'counterclock'],
    ['pie_slice', 'patch', 'normalize'],
    ['pie_slice', 'patch', 'labeldistance'],
    ['pie_slice', 'patch', 'pctdistance'],
    ['wedge_slice', 'patch', 'center'],
    ['wedge_slice', 'patch', 'radius'],
    ['wedge_slice', 'patch', 'theta1'],
    ['wedge_slice', 'patch', 'theta2'],
    ['wedge_slice', 'patch', 'width'],
  ])('denies cross-Figure replay for structural Python series prop %s', (role, kind, prop) => {
    const structural = legacyObject({
      id: `${role}.0`,
      kind: kind as any,
      role,
      editable: [prop],
      currentProps: { [prop]: [] },
      propertyCapabilities: [{
        prop,
        patchMode: 'backend_patch',
        scopes: ['object', 'figure', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
      }],
    });

    expect(resolveCrossFigurePolicy([structural], prop)).toBe('deny');
  });
});

describe('isParentOwnedManifestObject', () => {
  it('recognizes contour child collections by semantic role or ownership marker', () => {
    expect(isParentOwnedManifestObject(legacyObject({ role: 'contour_child_collection' }))).toBe(true);
    expect(isParentOwnedManifestObject(legacyObject({ currentProps: { parentOwned: true } }))).toBe(true);
    expect(isParentOwnedManifestObject(legacyObject())).toBe(false);
    expect(isParentOwnedManifestObject(undefined)).toBe(false);
  });
});

describe('Python structural series patch modes', () => {
  it.each([
    ['histogram_series', 'bar_container', 'bins'],
    ['histogram_series', 'bar_container', 'counts'],
    ['histogram_series', 'bar_container', 'values'],
    ['histogram_series', 'bar_container', 'edges'],
    ['histogram_series', 'bar_container', 'histtype'],
    ['stairs_series', 'patch', 'baseline'],
    ['stairs_series', 'patch', 'values'],
    ['stairs_series', 'patch', 'edges'],
    ['step_series', 'line', 'x'],
    ['step_series', 'line', 'y'],
    ['step_series', 'line', 'where'],
    ['pie_slice', 'patch', 'values'],
    ['pie_slice', 'patch', 'fraction'],
    ['pie_slice', 'patch', 'center'],
    ['pie_slice', 'patch', 'radius'],
    ['pie_slice', 'patch', 'theta1'],
    ['pie_slice', 'patch', 'theta2'],
    ['pie_slice', 'patch', 'width'],
    ['pie_slice', 'patch', 'explode'],
    ['pie_slice', 'patch', 'startangle'],
    ['pie_slice', 'patch', 'counterclock'],
    ['pie_slice', 'patch', 'normalize'],
    ['pie_slice', 'patch', 'labeldistance'],
    ['pie_slice', 'patch', 'pctdistance'],
    ['wedge_slice', 'patch', 'center'],
    ['wedge_slice', 'patch', 'radius'],
    ['wedge_slice', 'patch', 'theta1'],
    ['wedge_slice', 'patch', 'theta2'],
    ['wedge_slice', 'patch', 'width'],
  ])('does not honor local patch capability for structural prop %s', (role, kind, prop) => {
    const structural = legacyObject({
      id: `${role}.0`,
      kind: kind as any,
      role,
      editable: [prop],
      currentProps: { [prop]: [] },
      propertyCapabilities: [{
        prop,
        patchMode: 'local_patch',
        scopes: ['object', 'figure', 'cross_figure'],
        preview: 'exact',
        replay: 'stable',
      }],
    });

    expect(resolvePatchMode(manifest(structural), structural, prop)).toBe('backend_patch');
  });
});
