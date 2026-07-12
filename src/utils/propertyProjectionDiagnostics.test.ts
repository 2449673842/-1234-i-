import { beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../schemas/manifest';
import {
  clearPropertyProjectionShadowDiagnostics,
  getPropertyProjectionShadowDiagnostics,
  propertyDescriptorShadowEnabled,
  recordPropertyProjectionShadowDiagnostic,
} from './propertyProjectionDiagnostics';

const manifest: Manifest = {
  generatedBy: 'introspection',
  globals: {},
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  objects: [{
    id: 'title.0',
    kind: 'text',
    label: 'Sensitive title value is not recorded',
    editable: ['fontsize'],
    currentProps: { text: 'Private project title', fontsize: 12 },
  }],
};

describe('property projection shadow diagnostics', () => {
  beforeEach(() => clearPropertyProjectionShadowDiagnostics());

  it('does nothing when disabled', () => {
    expect(recordPropertyProjectionShadowDiagnostic(
      manifest,
      'fonts',
      manifest.objects,
      { enabled: false, log: false },
    )).toBeNull();
    expect(getPropertyProjectionShadowDiagnostics()).toEqual([]);
  });

  it('allows an explicit staging build flag when DEV is false', () => {
    expect(propertyDescriptorShadowEnabled({
      DEV: false,
      VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1: '1',
    })).toBe(true);
    expect(propertyDescriptorShadowEnabled({ DEV: true })).toBe(false);
  });

  it('records capability metadata without values or labels', () => {
    const result = recordPropertyProjectionShadowDiagnostic(
      manifest,
      'fonts',
      manifest.objects,
      { enabled: true, log: false },
    );

    expect(result?.objectCount).toBe(1);
    expect(result?.summaries.find(summary => summary.key === 'fontsize')?.counts.legacyFallback).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Private project title');
    expect(JSON.stringify(result)).not.toContain('Sensitive title');
  });

  it('returns defensive copies', () => {
    recordPropertyProjectionShadowDiagnostic(
      manifest,
      'fonts',
      manifest.objects,
      { enabled: true, log: false },
    );
    const first = getPropertyProjectionShadowDiagnostics();
    first[0]?.summaries[0]?.resolvedProps.push('mutated');

    expect(JSON.stringify(getPropertyProjectionShadowDiagnostics())).not.toContain('mutated');
  });
});
