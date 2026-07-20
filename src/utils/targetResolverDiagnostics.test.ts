import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest } from '../schemas/manifest';
import {
  clearTargetResolverShadowDiagnostics,
  getTargetResolverShadowDiagnostics,
  recordTargetResolverShadowDiagnostic,
  TARGET_RESOLVER_SHADOW_STORAGE_KEY,
} from './targetResolverDiagnostics';
import { EDITING_FEATURE_FLAGS } from './editingFeatureFlags';

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

  it('does not hydrate diagnostics from another release candidate', async () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: key => values.get(key) ?? null,
      key: index => [...values.keys()][index] ?? null,
      removeItem: key => { values.delete(key); },
      setItem: (key, value) => { values.set(key, value); },
    };
    const storedDiagnostic = (releaseCandidateId: string) => ({
      schemaVersion: 1,
      resolverVersion: 'v2',
      releaseCandidateId,
      id: `diagnostic:${releaseCandidateId}`,
      createdAt: 1,
      source: 'test',
      generatedBy: 'introspection',
      intent: 'style.text.axis_label',
      prop: 'color',
      selectionMode: 'explicit_objects',
      requestedObjectIds: ['ylabel.0'],
      equivalent: true,
      currentPatchKeys: ['ylabel.0:color'],
      shadowPatchKeys: ['ylabel.0:color'],
      currentOnlyPatchKeys: [],
      shadowOnlyPatchKeys: [],
      ambiguousCount: 0,
      skippedCount: 0,
    });
    storage.setItem(TARGET_RESOLVER_SHADOW_STORAGE_KEY, JSON.stringify({
      diagnostics: [
        storedDiagnostic('previous-release'),
        storedDiagnostic(EDITING_FEATURE_FLAGS.releaseCandidateId),
      ],
    }));
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

    try {
      vi.resetModules();
      const diagnosticsModule = await import('./targetResolverDiagnostics');
      const items = diagnosticsModule.getTargetResolverShadowDiagnostics();
      const evidence = diagnosticsModule.getTargetResolverShadowEvidence();

      expect(items.map(item => item.releaseCandidateId)).toEqual([
        EDITING_FEATURE_FLAGS.releaseCandidateId,
      ]);
      expect(evidence.releaseCandidateId).toBe(EDITING_FEATURE_FLAGS.releaseCandidateId);
      expect(evidence.total).toBe(1);
    } finally {
      vi.resetModules();
      if (previousDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      }
    }
  });
});
