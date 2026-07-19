import { describe, expect, it } from 'vitest';
import type { Manifest, PatchEntry } from '../schemas/manifest';
import { enrichDraftPatchWithIdentity, enrichPatchEntriesWithIdentity } from './patchIdentity';

function manifest(objects: Manifest['objects']): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects,
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
}

describe('patch identity enrichment', () => {
  it('attaches target manifest identity to ordinary object patches', () => {
    const patches: PatchEntry[] = [
      { op: 'set', mode: 'backend_patch', gid: 'line.0', prop: 'linewidth', value: 2, matchColor: '#336699' },
    ];
    const enriched = enrichPatchEntriesWithIdentity(patches, manifest([{
      id: 'line.0',
      kind: 'line',
      label: 'Line',
      editable: ['linewidth'],
      currentProps: { linewidth: 1 },
      stableKey: 'line:series:a',
      fingerprint: 'fp-line-0',
      fingerprintVersion: 2,
      identity: {
        instanceKey: 'instance:line.0',
        seriesKey: 'series:a',
        semanticKey: 'line:a',
        scope: 'subplot',
        coordinateSpace: 'data',
        relation: { subplotId: 'subplot.0' },
      },
    }]));

    expect(enriched[0]).toMatchObject({
      matchColor: '#336699',
      stableKey: 'line:series:a',
      fingerprint: 'fp-line-0',
      fingerprintVersion: 2,
      identity: {
        instanceKey: 'instance:line.0',
        seriesKey: 'series:a',
        semanticKey: 'line:a',
        scope: 'subplot',
        coordinateSpace: 'data',
      },
    });
  });

  it('does not attach identity to global or code patches', () => {
    const patches: PatchEntry[] = [
      { op: 'set', mode: 'backend_patch', gid: 'global', prop: 'figure.dpi', value: 300 },
      { type: 'code_patch', target_id: 'COLOR', new_value: '#000000', gids: ['line.0'] },
    ];

    const enriched = enrichPatchEntriesWithIdentity(patches, manifest([]));

    expect(enriched).toEqual(patches);
    expect(enriched[0]).not.toHaveProperty('identity');
    expect(enriched[1]).not.toHaveProperty('identity');
  });

  it('does not compare a legacy unversioned fingerprint after the v2 algorithm change', () => {
    const patches: PatchEntry[] = [
      { op: 'set', mode: 'backend_patch', gid: 'line.legacy', prop: 'color', value: '#123456' },
    ];
    const enriched = enrichPatchEntriesWithIdentity(patches, manifest([{
      id: 'line.legacy',
      kind: 'line',
      label: 'Legacy line',
      editable: ['color'],
      currentProps: {},
      stableKey: 'legacy-stable',
      fingerprint: 'legacy-style-sensitive-fingerprint',
      identity: { seriesKey: 'legacy-stable', scope: 'subplot' },
    }]));

    expect(enriched[0]).toMatchObject({ stableKey: 'legacy-stable' });
    expect(enriched[0]).not.toHaveProperty('fingerprint');
    expect(enriched[0]).not.toHaveProperty('fingerprintVersion');
  });

  it('uses the remapped target gid against the target manifest', () => {
    const patches: PatchEntry[] = [
      { op: 'set', mode: 'backend_patch', gid: 'line.target', prop: 'color', value: '#333333' },
    ];
    const enriched = enrichPatchEntriesWithIdentity(patches, manifest([{
      id: 'line.source',
      kind: 'line',
      label: 'Source line',
      editable: ['color'],
      currentProps: {},
      identity: {
        instanceKey: 'source-instance',
        seriesKey: 'source-series',
        semanticKey: 'source-semantic',
        scope: 'subplot',
        coordinateSpace: 'data',
      },
    }, {
      id: 'line.target',
      kind: 'line',
      label: 'Target line',
      editable: ['color'],
      currentProps: {},
      stableKey: 'target-stable',
      identity: {
        instanceKey: 'target-instance',
        seriesKey: 'target-series',
        semanticKey: 'target-semantic',
        scope: 'subplot',
        coordinateSpace: 'data',
      },
    }]));

    expect('type' in enriched[0]).toBe(false);
    if (!('type' in enriched[0])) {
      expect(enriched[0].stableKey).toBe('target-stable');
      expect(enriched[0].identity?.instanceKey).toBe('target-instance');
      expect(enriched[0].identity?.seriesKey).toBe('target-series');
      expect(enriched[0].identity?.semanticKey).toBe('target-semantic');
    }
  });

  it('leaves missing object patches unchanged for server preflight rejection', () => {
    const patch: PatchEntry = { op: 'set', mode: 'backend_patch', gid: 'missing.0', prop: 'color', value: '#fff' };

    const enriched = enrichPatchEntriesWithIdentity([patch], manifest([]));

    expect(enriched[0]).toBe(patch);
  });

  it('does not mutate input patches or manifest identity objects', () => {
    const patches: PatchEntry[] = [
      { op: 'set', mode: 'backend_patch', gid: 'text.0', prop: 'fontsize', value: 12 },
    ];
    const targetManifest = manifest([{
      id: 'text.0',
      kind: 'text',
      label: 'Title',
      editable: ['fontsize'],
      currentProps: {},
      identity: {
        instanceKey: 'text-instance',
        seriesKey: 'text-series',
        semanticKey: 'text-semantic',
        scope: 'figure',
        coordinateSpace: 'figure',
        relation: { subplotId: 'subplot.0' },
      },
    }]);

    const enriched = enrichPatchEntriesWithIdentity(patches, targetManifest);
    if (!('type' in enriched[0])) {
      enriched[0].identity!.instanceKey = 'changed';
      enriched[0].identity!.relation!.subplotId = 'changed-subplot';
    }

    expect(patches).toEqual([
      { op: 'set', mode: 'backend_patch', gid: 'text.0', prop: 'fontsize', value: 12 },
    ]);
    expect(targetManifest.objects[0].identity?.instanceKey).toBe('text-instance');
    expect(targetManifest.objects[0].identity?.relation?.subplotId).toBe('subplot.0');
  });

  it('captures draft identity once and never overwrites stale identity on apply', () => {
    const oldDraft = enrichDraftPatchWithIdentity({
      gid: 'line.0.1',
      prop: 'color',
      value: '#aa0000',
      mode: 'local_patch',
    }, manifest([{
      id: 'line.0.1',
      kind: 'line',
      label: 'Beta',
      editable: ['color'],
      currentProps: { color: '#225577' },
      stableKey: 'series:beta',
      fingerprint: 'beta-v2',
      fingerprintVersion: 2,
      identity: { instanceKey: 'line:beta', seriesKey: 'beta', scope: 'subplot' },
    }]));

    const applied = enrichPatchEntriesWithIdentity([{
      op: 'set',
      mode: 'local_patch',
      gid: oldDraft.gid,
      prop: oldDraft.prop,
      value: oldDraft.value,
      stableKey: oldDraft.stableKey,
      fingerprint: oldDraft.fingerprint,
      fingerprintVersion: oldDraft.fingerprintVersion,
      identity: oldDraft.identity,
    }], manifest([{
      id: 'line.0.1',
      kind: 'line',
      label: 'Alpha',
      editable: ['color'],
      currentProps: { color: '#225577' },
      stableKey: 'series:alpha',
      fingerprint: 'alpha-v2',
      fingerprintVersion: 2,
      identity: { instanceKey: 'line:alpha', seriesKey: 'alpha', scope: 'subplot' },
    }]));

    expect(applied[0]).toMatchObject({
      stableKey: 'series:beta',
      fingerprint: 'beta-v2',
      identity: { instanceKey: 'line:beta', seriesKey: 'beta' },
    });
  });

  it('preserves partial diagram patch identity so missing topology stays detectable', () => {
    const partialIdentity = {
      instanceKey: 'stale-edge-instance',
      relation: {
        diagramId: 'stale-diagram',
        sourceNodeId: 'stale-source',
      },
    };
    const patches: PatchEntry[] = [
      {
        op: 'set',
        mode: 'backend_patch',
        gid: 'diagram.edge.0',
        prop: 'linewidth',
        value: 2,
        identity: partialIdentity,
      },
    ];
    const targetManifest = manifest([{
      id: 'diagram.edge.0',
      kind: 'patch',
      label: 'Edge A to B',
      editable: ['linewidth'],
      currentProps: { linewidth: 1 },
      identity: {
        instanceKey: 'manifest-edge-instance',
        seriesKey: 'manifest-edge-series',
        semanticKey: 'manifest-edge-semantic',
        scope: 'figure',
        coordinateSpace: 'data',
        relation: {
          diagramId: 'current-diagram',
          diagramType: 'networkx',
          diagramObjectId: 'current-network',
          edgeId: 'current-edge',
          sourceNodeId: 'current-source',
          targetNodeId: 'current-target',
        },
      },
    }]);

    const enriched = enrichPatchEntriesWithIdentity(patches, targetManifest);

    expect(enriched[0]).not.toBe(patches[0]);
    expect(enriched[0]).toMatchObject({
      identity: {
        instanceKey: 'stale-edge-instance',
        relation: {
          diagramId: 'stale-diagram',
          sourceNodeId: 'stale-source',
        },
      },
    });
    expect(enriched[0]).not.toHaveProperty('identity.seriesKey');
    expect(enriched[0]).not.toHaveProperty('identity.semanticKey');
    expect(enriched[0]).not.toHaveProperty('identity.relation.targetNodeId');

    if (!('type' in enriched[0])) {
      enriched[0].identity!.instanceKey = 'mutated-instance';
      enriched[0].identity!.relation!.sourceNodeId = 'mutated-source';
    }

    if ('type' in patches[0]) throw new Error('expected an ordinary patch entry');
    expect(patches[0].identity).toEqual(partialIdentity);
    expect(targetManifest.objects[0].identity?.seriesKey).toBe('manifest-edge-series');
    expect(targetManifest.objects[0].identity?.relation?.targetNodeId).toBe('current-target');
  });

  it('preserves partial diagram draft identity instead of backfilling current topology', () => {
    const draft = {
      gid: 'diagram.node.0',
      prop: 'facecolor',
      value: '#cc5500',
      mode: 'local_patch' as const,
      identity: {
        semanticKey: 'stale-node-semantic',
        relation: {
          diagramObjectId: 'stale-network',
          nodeId: 'stale-node',
        },
      },
    };
    const targetManifest = manifest([{
      id: 'diagram.node.0',
      kind: 'patch',
      label: 'Node A',
      editable: ['facecolor'],
      currentProps: { facecolor: '#333333' },
      identity: {
        instanceKey: 'manifest-node-instance',
        seriesKey: 'manifest-node-series',
        semanticKey: 'manifest-node-semantic',
        scope: 'figure',
        coordinateSpace: 'data',
        relation: {
          diagramId: 'current-diagram',
          diagramType: 'networkx',
          diagramObjectId: 'current-network',
          nodeId: 'current-node',
        },
      },
    }]);

    const enriched = enrichDraftPatchWithIdentity(draft, targetManifest);

    expect(enriched).not.toBe(draft);
    expect(enriched).toMatchObject({
      identity: {
        semanticKey: 'stale-node-semantic',
        relation: {
          diagramObjectId: 'stale-network',
          nodeId: 'stale-node',
        },
      },
    });
    expect(enriched).not.toHaveProperty('identity.instanceKey');
    expect(enriched).not.toHaveProperty('identity.seriesKey');
    expect(enriched).not.toHaveProperty('identity.relation.diagramId');

    enriched.identity!.semanticKey = 'mutated-semantic';
    enriched.identity!.relation!.nodeId = 'mutated-node';

    expect(draft.identity).toEqual({
      semanticKey: 'stale-node-semantic',
      relation: {
        diagramObjectId: 'stale-network',
        nodeId: 'stale-node',
      },
    });
    expect(targetManifest.objects[0].identity?.instanceKey).toBe('manifest-node-instance');
    expect(targetManifest.objects[0].identity?.relation?.diagramId).toBe('current-diagram');
  });

  it('fills identity for legacy drafts that were created before v2 metadata', () => {
    const enriched = enrichDraftPatchWithIdentity({
      gid: 'line.legacy',
      prop: 'linewidth',
      value: 2,
      mode: 'backend_patch',
    }, manifest([{
      id: 'line.legacy',
      kind: 'line',
      label: 'Legacy',
      editable: ['linewidth'],
      currentProps: { linewidth: 1 },
      stableKey: 'legacy-line',
      identity: { instanceKey: 'legacy-instance', scope: 'subplot' },
    }]));

    expect(enriched).toMatchObject({
      stableKey: 'legacy-line',
      identity: { instanceKey: 'legacy-instance' },
    });
  });
});
