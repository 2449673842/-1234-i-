import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import { isTextContentPatchProp, resolvePropertyPatchMode } from './propertyPatchMode';

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
