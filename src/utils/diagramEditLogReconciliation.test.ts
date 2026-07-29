import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import { reconcileDiagramEditLogToManifest } from './diagramEditLogReconciliation';

function diagramLabel(
  id: string,
  objectId: string,
  nodeId: string,
  stableKey: string,
  fingerprint: string,
): ManifestObject {
  return {
    id,
    kind: 'text',
    role: 'diagram_node_label',
    label: objectId,
    editable: ['fontsize', 'position'],
    currentProps: {},
    stableKey,
    fingerprint,
    fingerprintVersion: 2,
    identity: {
      semanticKey: `diagram_node_label:sankey:${objectId}`,
      instanceKey: `subplot:${id}`,
      seriesKey: `diagram:sankey:diagram_node_label:${objectId}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: {
        subplotId: 'subplot.0',
        diagramId: 'sankey',
        diagramType: 'network',
        diagramObjectId: objectId,
        nodeId,
      },
    },
    propertyCapabilities: [
      {
        prop: 'fontsize',
        patchMode: 'backend_patch',
        preview: 'none',
        replay: 'stable',
        scopes: ['object'],
      },
      {
        prop: 'position',
        patchMode: 'backend_patch',
        preview: 'none',
        replay: 'stable',
        scopes: ['object'],
      },
    ],
  };
}

function manifest(...objects: ManifestObject[]): Manifest {
  return { objects } as Manifest;
}

function oldEdit(overrides: Record<string, unknown> = {}) {
  return {
    gid: 'text.0.0',
    prop: 'fontsize',
    value: 14,
    mode: 'backend_patch',
    timestamp: 123,
    stableKey: 'old-label-key',
    fingerprint: 'old-label-fingerprint',
    fingerprintVersion: 2,
    identity: {
      semanticKey: 'diagram_node_label:sankey:N2O_label',
      instanceKey: 'subplot:text.0.0',
      seriesKey: 'diagram:sankey:diagram_node_label:N2O_label',
      scope: 'subplot' as const,
      coordinateSpace: 'data' as const,
      relation: {
        subplotId: 'subplot.0',
        diagramId: 'sankey',
        diagramType: 'network',
        diagramObjectId: 'N2O_label',
        nodeId: 'N2O',
      },
    },
    ...overrides,
  };
}

describe('reconcileDiagramEditLogToManifest', () => {
  it('remaps a reordered diagram label only by its unique explicit relation', () => {
    const n2 = diagramLabel('text.0.0', 'N2_label', 'N2', 'n2-key', 'n2-fp');
    const n2o = diagramLabel('text.0.1', 'N2O_label', 'N2O', 'n2o-key', 'n2o-fp');

    const result = reconcileDiagramEditLogToManifest([oldEdit()], manifest(n2, n2o));

    expect(result.unresolved).toEqual([]);
    expect(result.remapped).toHaveLength(1);
    expect(result.editLog[0]).toMatchObject({
      gid: 'text.0.1',
      prop: 'fontsize',
      value: 14,
      stableKey: 'n2o-key',
      fingerprint: 'n2o-fp',
      fingerprintVersion: 2,
      identity: n2o.identity,
    });
  });

  it('refreshes stale structural metadata even when the raw gid did not move', () => {
    const current = diagramLabel('text.0.0', 'N2O_label', 'N2O', 'new-key', 'new-fp');

    const result = reconcileDiagramEditLogToManifest([oldEdit()], manifest(current));

    expect(result.remapped).toHaveLength(1);
    expect(result.editLog[0].stableKey).toBe('new-key');
    expect(result.editLog[0].fingerprint).toBe('new-fp');
  });

  it('fails closed when the explicit relation is duplicated', () => {
    const first = diagramLabel('text.0.1', 'N2O_label', 'N2O', 'first-key', 'first-fp');
    const second = diagramLabel('text.0.2', 'N2O_label', 'N2O', 'second-key', 'second-fp');
    const edit = oldEdit();

    const result = reconcileDiagramEditLogToManifest([edit], manifest(first, second));

    expect(result.remapped).toEqual([]);
    expect(result.unresolved).toEqual([edit]);
    expect(result.editLog[0]).toBe(edit);
  });

  it('fails closed for topology drift, incomplete relations, and unsupported props', () => {
    const target = diagramLabel('text.0.1', 'N2O_label', 'N2', 'target-key', 'target-fp');
    const topologyDrift = oldEdit();
    const incomplete = oldEdit({
      identity: {
        ...oldEdit().identity,
        relation: { diagramId: 'sankey', diagramObjectId: 'N2O_label' },
      },
    });
    const unsupported = oldEdit({ prop: 'text' });

    const result = reconcileDiagramEditLogToManifest(
      [topologyDrift, incomplete, unsupported],
      manifest(target),
    );

    expect(result.remapped).toEqual([]);
    expect(result.unresolved).toEqual([topologyDrift, incomplete, unsupported]);
  });

  it('leaves ordinary edits untouched', () => {
    const edit = { gid: 'line.0.0', prop: 'color', value: '#123456' };
    const result = reconcileDiagramEditLogToManifest([edit], manifest());

    expect(result.editLog[0]).toBe(edit);
    expect(result.remapped).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});
