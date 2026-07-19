import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import { compareManifestIdentity, validateManifestIdentity } from './manifestIdentity';

function manifest(objects: ManifestObject[]): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects,
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
}

function identifiedText(id: string, instanceKey = `subplot:${id}`): ManifestObject {
  return {
    id,
    kind: 'text',
    label: id,
    editable: ['color'],
    currentProps: { color: '#000000' },
    subplotId: 'subplot.0',
    identity: {
      semanticKey: 'annotation:subplot.0',
      instanceKey,
      scope: 'subplot',
      coordinateSpace: 'axes',
      relation: { subplotId: 'subplot.0' },
    },
    propertyCapabilities: [{
      prop: 'color',
      patchMode: 'local_patch',
      scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
      preview: 'exact',
      replay: 'stable',
    }],
  };
}

describe('manifest identity shadow validation', () => {
  it('accepts complete additive identity metadata without changing legacy fields', () => {
    const subplot: ManifestObject = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'Panel',
      editable: [],
      currentProps: {},
      identity: {
        semanticKey: 'subplot_panel:subplot.0',
        instanceKey: 'subplot:subplot.0',
        scope: 'subplot',
        coordinateSpace: 'figure',
        relation: { subplotId: 'subplot.0' },
      },
      propertyCapabilities: [],
    };
    const report = validateManifestIdentity(manifest([subplot, identifiedText('text.0')]));

    expect(report.objectCount).toBe(2);
    expect(report.identityCoverage).toBe(1);
    expect(report.duplicateInstanceKeys).toEqual([]);
    expect(report.issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(report.shadowReady).toBe(true);
  });

  it('rejects duplicate instance keys instead of allowing ambiguous targets', () => {
    const report = validateManifestIdentity(manifest([
      identifiedText('text.0', 'subplot:duplicate'),
      identifiedText('text.1', 'subplot:duplicate'),
    ]));

    expect(report.shadowReady).toBe(false);
    expect(report.duplicateInstanceKeys).toEqual(['subplot:duplicate']);
    expect(report.issues.filter(issue => issue.code === 'duplicate_instance_key')).toHaveLength(2);
  });

  it('keeps identity stable when only editable style values change', () => {
    const before = manifest([identifiedText('text.0')]);
    const afterObject = identifiedText('text.0');
    afterObject.currentProps = { color: '#cc0000' };
    const comparison = compareManifestIdentity(before, manifest([afterObject]));

    expect(comparison.retentionRate).toBe(1);
    expect(comparison.missingInstanceKeys).toEqual([]);
    expect(comparison.addedInstanceKeys).toEqual([]);
  });

  it('keeps legacy manifests readable but not shadow-ready', () => {
    const legacyObject = identifiedText('text.0');
    delete legacyObject.identity;
    delete legacyObject.propertyCapabilities;
    const report = validateManifestIdentity(manifest([legacyObject]));

    expect(report.issues).toEqual([]);
    expect(report.identityCoverage).toBe(0);
    expect(report.shadowReady).toBe(false);
  });

  it('validates shared subplot relationships without collapsing them to one owner', () => {
    const subplots = [0, 1].map((index): ManifestObject => ({
      id: `subplot.${index}`,
      kind: 'subplot',
      label: `Panel ${index}`,
      editable: [],
      currentProps: {},
      identity: {
        semanticKey: `subplot_panel:subplot.${index}`,
        instanceKey: `subplot:subplot.${index}`,
        scope: 'subplot',
        coordinateSpace: 'figure',
        relation: { subplotId: `subplot.${index}` },
      },
      propertyCapabilities: [],
    }));
    const sharedColorbar: ManifestObject = {
      id: 'colorbar.2',
      kind: 'colorbar',
      label: 'Shared scale',
      editable: ['width'],
      currentProps: { width: 0.03 },
      subplotIds: ['subplot.0', 'subplot.1'],
      identity: {
        semanticKey: 'colorbar:subplot.0+subplot.1',
        instanceKey: 'container:colorbar.2',
        scope: 'container',
        coordinateSpace: 'figure',
        relation: { subplotIds: ['subplot.0', 'subplot.1'] },
      },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object', 'group'],
        preview: 'none',
        replay: 'stable',
      }],
    };

    const valid = validateManifestIdentity(manifest([...subplots, sharedColorbar]));
    expect(valid.issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(valid.shadowReady).toBe(true);

    sharedColorbar.identity!.relation!.subplotIds = ['subplot.0', 'subplot.0'];
    const invalid = validateManifestIdentity(manifest([...subplots, sharedColorbar]));
    expect(invalid.shadowReady).toBe(false);
    expect(invalid.issues.some(issue => issue.code === 'subplot_relation_conflict')).toBe(true);
  });

  it('validates R layer, group, guide, and multi-panel relation targets', () => {
    const objects: ManifestObject[] = [
      ...[0, 1].map((index): ManifestObject => ({
        id: `subplot.${index}`,
        kind: 'subplot',
        label: `Facet ${index}`,
        editable: [],
        currentProps: {},
        identity: {
          instanceKey: `r:subplot:subplot.${index}`,
          scope: 'subplot',
          coordinateSpace: 'figure',
          relation: { subplotId: `subplot.${index}` },
        },
        propertyCapabilities: [],
      })),
      {
        id: 'legend.0',
        kind: 'legend',
        label: 'Legend',
        editable: [],
        currentProps: {},
        identity: {
          instanceKey: 'r:figure:legend.0',
          scope: 'figure',
          coordinateSpace: 'container',
          relation: { groupIds: ['r.group.color.0.0'] },
        },
        propertyCapabilities: [],
      },
      {
        id: 'r.layer.0',
        kind: 'collection',
        label: 'Points',
        editable: [],
        currentProps: {},
        identity: {
          instanceKey: 'r:figure:r.layer.0',
          scope: 'figure',
          coordinateSpace: 'data',
          relation: {
            subplotIds: ['subplot.0', 'subplot.1'],
            groupIds: ['r.group.color.0.0'],
          },
        },
        propertyCapabilities: [],
      },
      {
        id: 'r.group.color.0.0',
        kind: 'collection',
        label: 'A',
        editable: ['color'],
        currentProps: { color: '#f8766d' },
        identity: {
          instanceKey: 'r:container:r.group.color.0.0',
          scope: 'container',
          coordinateSpace: 'data',
          relation: {
            layerIds: ['r.layer.0'],
            subplotIds: ['subplot.0', 'subplot.1'],
            guideId: 'legend.0',
            legendId: 'legend.0',
            scaleId: 'r.scale.color.0',
            aesthetic: 'color',
            groupKey: 'A',
          },
        },
        propertyCapabilities: [{
          prop: 'color',
          patchMode: 'backend_patch',
          scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
          preview: 'none',
          replay: 'stable',
        }],
      },
    ];

    const report = validateManifestIdentity(manifest(objects));
    expect(report.issues).toEqual([]);
    expect(report.shadowReady).toBe(true);
  });

  it('validates pie slice, label, and value-label object references', () => {
    const subplot: ManifestObject = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'Panel',
      editable: [],
      currentProps: {},
      identity: {
        instanceKey: 'subplot:subplot.0',
        scope: 'subplot',
        coordinateSpace: 'figure',
        relation: { subplotId: 'subplot.0' },
      },
      propertyCapabilities: [],
    };
    const pieSlice = identifiedText('patch.0.0');
    pieSlice.identity!.relation = {
      subplotId: 'subplot.0',
      pieId: 'pie.0.0',
      pieLabelId: 'text.0.0',
      pieValueLabelId: 'text.0.1',
      sliceIndex: 0,
    };
    const pieLabel = identifiedText('text.0.0');
    pieLabel.identity!.relation = {
      subplotId: 'subplot.0',
      pieId: 'pie.0.0',
      pieSliceId: 'patch.0.0',
      sliceIndex: 0,
    };
    const pieValueLabel = identifiedText('text.0.1');
    pieValueLabel.identity!.relation = {
      subplotId: 'subplot.0',
      pieId: 'pie.0.0',
      pieSliceId: 'patch.0.0',
      sliceIndex: 0,
    };

    const valid = validateManifestIdentity(manifest([subplot, pieSlice, pieLabel, pieValueLabel]));
    expect(valid.issues.filter(issue => issue.code === 'unknown_relation_target')).toEqual([]);

    pieSlice.identity!.relation!.pieLabelId = 'text.missing';
    const invalid = validateManifestIdentity(manifest([subplot, pieSlice, pieLabel, pieValueLabel]));
    expect(invalid.issues).toContainEqual(expect.objectContaining({
      code: 'unknown_relation_target',
      objectId: 'patch.0.0',
    }));
  });
});
