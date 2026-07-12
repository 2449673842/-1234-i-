import { beforeEach, describe, expect, it } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest } from '../schemas/manifest';
import {
  clearTargetResolverShadowDiagnostics,
  getTargetResolverShadowDiagnostics,
  recordTargetResolverShadowDiagnostic,
} from './targetResolverDiagnostics';

const manifest: Manifest = {
  generatedBy: 'introspection',
  globals: {},
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  objects: [{
    id: 'ylabel.0',
    kind: 'text',
    label: 'Y label',
    editable: ['color'],
    currentProps: { color: '#000000' },
    subplotId: 'subplot.0',
    identity: {
      semanticKey: 'y_axis_label:subplot.0',
      instanceKey: 'subplot:ylabel.0',
      scope: 'subplot',
      coordinateSpace: 'axes',
      relation: { subplotId: 'subplot.0' },
    },
  }],
};

const intent: EditingIntent = {
  intent: 'style.text.axis_label',
  scope: {
    selectionMode: 'explicit_objects',
    objectIds: ['ylabel.0'],
    targetRole: 'y_axis_label',
    subplotIds: ['subplot.0'],
  },
  operation: { prop: 'color', value: '#cc0000' },
};

describe('target resolver shadow diagnostics', () => {
  beforeEach(() => clearTargetResolverShadowDiagnostics());

  it('does no work when diagnostics are disabled', () => {
    const result = recordTargetResolverShadowDiagnostic(manifest, intent, 'test', {
      enabled: false,
      log: false,
    });

    expect(result).toBeNull();
    expect(getTargetResolverShadowDiagnostics()).toEqual([]);
  });

  it('records redacted target keys without retaining operation values', () => {
    const result = recordTargetResolverShadowDiagnostic(manifest, intent, 'right-sidebar', {
      enabled: true,
      log: false,
    });

    expect(result?.equivalent).toBe(true);
    expect(result?.currentPatchKeys).toEqual(['ylabel.0:color']);
    expect(result?.shadowPatchKeys).toEqual(['ylabel.0:color']);
    expect(JSON.stringify(result)).not.toContain('#cc0000');
    expect(getTargetResolverShadowDiagnostics()).toHaveLength(1);
  });

  it('returns defensive copies of diagnostic arrays', () => {
    recordTargetResolverShadowDiagnostic(manifest, intent, 'test', {
      enabled: true,
      log: false,
    });
    const firstRead = getTargetResolverShadowDiagnostics();
    firstRead[0]?.currentPatchKeys.push('mutated');

    expect(getTargetResolverShadowDiagnostics()[0]?.currentPatchKeys).toEqual(['ylabel.0:color']);
  });
});
