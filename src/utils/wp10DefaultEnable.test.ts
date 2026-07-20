import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import { buildDiagramComponentGroups } from '../components/RightSidebar';
import { resolvePaletteTargets } from './paletteTargetResolver';
import { mapPatchesToTargetFigure } from './semanticPatchMapping';
import { compileEditingIntentWithControlledResolver } from './targetResolver';
import { resolveEditingFeatureFlags } from './editingFeatureFlags';

const manifest = (objects: ManifestObject[]): Manifest => ({
  generatedBy: 'introspection',
  globals: {},
  objects,
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
});

const componentIntent: EditingIntent = {
  intent: 'style.component',
  scope: {
    selectionMode: 'explicit_objects',
    objectIds: ['line.0'],
    targetRole: 'data_line',
  },
  operation: { prop: 'color', value: '#cc0000' },
};

function editableLine(id: string, modern = true): ManifestObject {
  return {
    id,
    kind: 'line',
    label: id,
    role: 'data_line',
    subplotId: 'subplot.0',
    editable: ['color', 'linewidth'],
    currentProps: { color: '#000000', linewidth: 1 },
    ...(modern ? {
      identity: {
        instanceKey: `subplot:${id}`,
        semanticKey: 'data_line:subplot.0',
        seriesKey: 'series:primary',
        scope: 'subplot' as const,
        coordinateSpace: 'data' as const,
        relation: { subplotId: 'subplot.0' },
      },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch' as const,
        scopes: ['object', 'figure', 'cross_figure'],
        preview: 'none' as const,
        replay: 'stable' as const,
      }, {
        prop: 'linewidth',
        patchMode: 'backend_patch' as const,
        scopes: ['object', 'figure', 'cross_figure'],
        preview: 'none' as const,
        replay: 'stable' as const,
      }],
    } : {}),
  };
}

describe('WP10 default-enable regression contract', () => {
  it('routes App cross-Figure draft compilation through the controlled resolver', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    expect(appSource).toContain('compileEditingIntentWithControlledResolver(');
    expect(appSource).not.toContain(
      'compileEditingIntent(targetManifest, retargetEditingIntentForFigure',
    );
  });

  it('uses one default-on V2 policy with independent rollback flags', () => {
    expect(resolveEditingFeatureFlags({})).toMatchObject({
      generalTargetResolverV2: true,
      fontTargetResolverV2: true,
      componentTargetResolverV2: true,
      paletteTargetResolverV2: true,
      crossFigureIdentityV2: true,
      targetResolverLegacyAdapter: true,
      crossFigureLegacyScoreAdapter: false,
    });
    expect(resolveEditingFeatureFlags({
      VITE_SCIFIGURE_GENERAL_TARGET_RESOLVER_V2: '0',
      VITE_SCIFIGURE_TARGET_RESOLVER_LEGACY_ADAPTER: '0',
      VITE_SCIFIGURE_CROSS_FIGURE_IDENTITY_V2: '0',
      VITE_SCIFIGURE_CROSS_FIGURE_LEGACY_SCORE_ADAPTER: '1',
    })).toMatchObject({
      generalTargetResolverV2: false,
      targetResolverLegacyAdapter: false,
      crossFigureIdentityV2: false,
      crossFigureLegacyScoreAdapter: true,
    });
  });

  it('enables the component editing domain by default and allows an explicit rollback', () => {
    const diagramNode = {
      ...editableLine('patch.node.0'),
      kind: 'patch' as const,
      role: 'diagram_node',
      identity: {
        instanceKey: 'diagram:node.0',
        semanticKey: 'diagram_node:sem.0:node.0',
        scope: 'subplot' as const,
        coordinateSpace: 'data' as const,
        relation: { diagramId: 'sem.0', diagramType: 'sem', diagramObjectId: 'node.0' },
      },
    };

    expect(buildDiagramComponentGroups([diagramNode])).toHaveLength(1);
    expect(buildDiagramComponentGroups([diagramNode], false)).toEqual([]);
  });

  it('uses strict resolution for complete manifests and preserves the general legacy adapter', () => {
    const modern = manifest([editableLine('line.0')]);
    const strict = compileEditingIntentWithControlledResolver(modern, componentIntent, true);

    expect(strict.strategy).toBe('strict');
    expect(strict.patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'line.0', prop: 'color', value: '#cc0000' },
    ]);

    const rollback = compileEditingIntentWithControlledResolver(modern, componentIntent, false);
    expect(rollback.strategy).toBe('legacy');
    expect(rollback.fallbackReason).toBe('feature_disabled');

    const legacy = compileEditingIntentWithControlledResolver(
      manifest([editableLine('line.0', false)]),
      componentIntent,
      true,
    );

    expect(legacy.strategy).toBe('legacy');
    expect(legacy.fallbackReason).toBe('missing_identity');
    expect(legacy.patches).toEqual([
      { op: 'set', mode: 'local_patch', gid: 'line.0', prop: 'color', value: '#cc0000' },
    ]);

    const conservative = compileEditingIntentWithControlledResolver(
      manifest([editableLine('line.0', false)]),
      componentIntent,
      { enabled: true, legacyAdapterEnabled: false },
    );
    expect(conservative.strategy).toBe('strict');
    expect(conservative.fallbackReason).toBe('legacy_adapter_disabled');
    expect(conservative.patches).toEqual([]);
    expect(conservative.skipped).toHaveLength(1);
  });

  it('keeps the palette adapter explicitly rollbackable', () => {
    const figure: Manifest = {
      ...manifest([editableLine('line.0')]),
      bindings: [{
        paletteId: 'Primary',
        groupId: 'palette_primary',
        gids: ['line.0'],
        props: ['color'],
        targetMode: 'exact',
        targets: [{
          gid: 'line.0',
          prop: 'color',
          instanceKey: 'subplot:line.0',
          seriesKey: 'series:primary',
          match: 'label_and_color',
          confidence: 'exact',
        }],
      }],
    };

    expect(resolvePaletteTargets(figure, 'Primary', true).strategy).toBe('strict');
    const rollback = resolvePaletteTargets(figure, 'Primary', false);
    expect(rollback.strategy).toBe('legacy');
    expect(rollback.fallbackReason).toBe('feature_disabled');
  });

  it('keeps the cross-Figure score adapter independently disabled for weak matches', () => {
    const source = manifest([{
      ...editableLine('line.source', false),
      label: 'Shared label',
      subplotId: 'subplot.0',
    }]);
    const target = manifest([{
      ...editableLine('line.target', false),
      label: 'Shared label',
      subplotId: 'subplot.0',
    }]);
    const patch = { gid: 'line.source', prop: 'color', value: '#cc0000', mode: 'backend_patch' };

    const result = mapPatchesToTargetFigure([patch], source, target);

    expect(result.patches).toEqual([]);
    expect(result.skipped).toEqual([patch]);

    const rollback = mapPatchesToTargetFigure([patch], source, target, {
      identityV2Enabled: false,
    });
    expect(rollback.patches).toHaveLength(1);

    const compatibilityAdapter = mapPatchesToTargetFigure([patch], source, target, {
      identityV2Enabled: true,
      legacyScoreAdapterEnabled: true,
    });
    expect(compatibilityAdapter.patches).toHaveLength(1);
  });

  it('persists redacted shadow evidence across module sessions', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    } satisfies Storage);

    try {
      const diagnostics = await import('./targetResolverDiagnostics');
      diagnostics.clearTargetResolverShadowDiagnostics();
      const figure = manifest([editableLine('line.0')]);
      const roleIntent: EditingIntent = {
        intent: 'style.component',
        scope: {
          selectionMode: 'role_in_figure',
          targetRole: 'data_line',
        },
        operation: { prop: 'linewidth', value: 2.5 },
      };
      for (let run = 0; run < 3; run += 1) {
        diagnostics.recordTargetResolverShadowDiagnostic(
          figure,
          componentIntent,
          `wp10-explicit-${run}`,
          { enabled: true, log: false },
        );
        diagnostics.recordTargetResolverShadowDiagnostic(
          figure,
          roleIntent,
          `wp10-role-${run}`,
          { enabled: true, log: false },
        );
      }

      const recorded = diagnostics.getTargetResolverShadowDiagnostics();
      expect(recorded).toHaveLength(6);
      expect(recorded.every(item => item.equivalent)).toBe(true);
      expect(JSON.stringify(recorded)).not.toContain('#cc0000');
      expect(JSON.stringify(recorded)).not.toContain('2.5');

      vi.resetModules();
      const nextSession = await import('./targetResolverDiagnostics');
      expect(nextSession.getTargetResolverShadowDiagnostics()).toHaveLength(6);
      expect(nextSession.getTargetResolverShadowEvidence()).toMatchObject({
        total: 6,
        equivalent: 6,
        divergent: 0,
      });
      nextSession.clearTargetResolverShadowDiagnostics();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
