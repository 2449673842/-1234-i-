import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import { resolvePropertyPatchMode } from './propertyPatchMode';

function object(patchMode: 'local_patch' | 'backend_patch'): ManifestObject {
  return {
    id: 'title.0',
    kind: 'text',
    label: 'Title',
    editable: ['color'],
    currentProps: { color: '#000000' },
    propertyCapabilities: [{
      prop: 'color',
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
});
