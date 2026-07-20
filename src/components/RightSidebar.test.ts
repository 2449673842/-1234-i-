import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import {
  buildSupportedSidebarPatchEntry,
  buildSupportedObjectPatchEntries,
  buildDiagramComponentGroups,
  isDedicatedDiagramComponentObject,
  supportsComponentBatchProp,
  supportsSubplotBoundProp,
} from './RightSidebar';

function manifestObject(id: string, kind: ManifestObject['kind'], role?: string): ManifestObject {
  return {
    id,
    kind,
    label: id,
    editable: ['color', 'facecolor', 'edgecolor', 'linewidth', 'fontsize'],
    currentProps: {},
    ...(role ? { role } : {}),
    identity: {
      relation: {
        diagramId: 'sem.demo',
        diagramType: 'sem',
        diagramObjectId: id,
      } as ManifestObject['identity']['relation'],
    },
  };
}

describe('RightSidebar diagram component center groups', () => {
  it('creates distinct Chinese-labeled groups for diagram semantic roles', () => {
    const groups = buildDiagramComponentGroups([
      manifestObject('diagram.group.0', 'container', 'diagram_group'),
      manifestObject('patch.node.0', 'patch', 'diagram_node'),
      manifestObject('line.edge.0', 'line', 'diagram_edge'),
      manifestObject('patch.arrow.0', 'patch', 'diagram_arrow'),
      manifestObject('text.node.0', 'text', 'diagram_node_label'),
      manifestObject('text.coefficient.0', 'text', 'diagram_coefficient_label'),
      manifestObject('text.fit.0', 'text', 'diagram_fit_annotation'),
    ]);

    expect(groups.map(group => ({
      id: group.id,
      label: group.label,
      objectIds: group.objects.map(object => object.id),
    }))).toEqual([
      { id: 'diagramGroups', label: '图示 / SEM 整体组', objectIds: ['diagram.group.0'] },
      { id: 'diagramNodes', label: '图示节点', objectIds: ['patch.node.0'] },
      { id: 'diagramEdges', label: '图示连线 / 路径', objectIds: ['line.edge.0'] },
      { id: 'diagramArrows', label: '图示箭头', objectIds: ['patch.arrow.0'] },
      { id: 'diagramNodeLabels', label: '图示节点标签', objectIds: ['text.node.0'] },
      { id: 'diagramCoefficientLabels', label: '路径系数标签', objectIds: ['text.coefficient.0'] },
      { id: 'diagramFitAnnotations', label: '模型拟合注释', objectIds: ['text.fit.0'] },
    ]);
  });

  it('marks diagram semantic objects as dedicated instead of generic component objects', () => {
    const dedicated = [
      manifestObject('patch.node.0', 'patch', 'diagram_node'),
      manifestObject('line.edge.0', 'line', 'diagram_edge'),
      manifestObject('patch.arrow.0', 'patch', 'diagram_arrow'),
      manifestObject('text.node.0', 'text', 'diagram_node_label'),
      manifestObject('text.coefficient.0', 'text', 'diagram_coefficient_label'),
      manifestObject('text.fit.0', 'text', 'diagram_fit_annotation'),
      manifestObject('diagram.group.0', 'container', 'diagram_group'),
    ];

    expect(dedicated.every(isDedicatedDiagramComponentObject)).toBe(true);
    expect(isDedicatedDiagramComponentObject(manifestObject('text.ordinary', 'text'))).toBe(false);
    expect(isDedicatedDiagramComponentObject(manifestObject('line.ordinary', 'line'))).toBe(false);
    expect(isDedicatedDiagramComponentObject(manifestObject('patch.ordinary', 'patch'))).toBe(false);
    expect(isDedicatedDiagramComponentObject(manifestObject('collection.ordinary', 'collection'))).toBe(false);
  });

  it('keeps diagram groups behind the component target resolver v2 gate', () => {
    const groups = buildDiagramComponentGroups([
      manifestObject('patch.node.0', 'patch', 'diagram_node'),
    ], false);

    expect(groups).toEqual([]);
  });
});

describe('RightSidebar subplot bound capability gates', () => {
  it('uses propertyCapabilities as the modern per-bound authority', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'subplot.0',
      editable: ['left', 'bottom', 'width', 'height'],
      currentProps: { left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    expect(supportsSubplotBoundProp(subplot, 'width')).toBe(true);
    expect(supportsSubplotBoundProp(subplot, 'left')).toBe(false);
    expect(supportsSubplotBoundProp(subplot, 'bottom')).toBe(false);
    expect(supportsSubplotBoundProp(subplot, 'height')).toBe(false);
  });

  it('keeps legacy subplot bound fallback when capability metadata is absent', () => {
    const legacySubplot = {
      id: 'subplot.legacy',
      kind: 'subplot',
      label: 'subplot.legacy',
      editable: ['left', 'height'],
      currentProps: { left: 0.1, height: 0.8 },
    } as ManifestObject;

    expect(supportsSubplotBoundProp(legacySubplot, 'left')).toBe(true);
    expect(supportsSubplotBoundProp(legacySubplot, 'height')).toBe(true);
    expect(supportsSubplotBoundProp(legacySubplot, 'width')).toBe(false);
  });
});

describe('RightSidebar component center capability gates', () => {
  it('keeps declared global fields editable while rejecting unknown globals', () => {
    const manifest: Manifest = {
      generatedBy: 'introspection',
      globals: {
        'figure.width_in': { type: 'number', value: 6, min: 1, max: 20, step: 0.1 },
      },
      objects: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, 'global', 'figure.width_in', 7)).toEqual({
      op: 'set',
      gid: 'global',
      prop: 'figure.width_in',
      value: 7,
      mode: 'backend_patch',
    });
    expect(buildSupportedSidebarPatchEntry(manifest, 'global', 'figure.unknown', 7)).toBeNull();
  });

  it('blocks direct and immediate object patches omitted from modern capabilities', () => {
    const line = {
      id: 'line.0',
      kind: 'line',
      label: 'line.0',
      editable: ['color', 'linewidth'],
      currentProps: { color: '#000000', linewidth: 1 },
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const manifest: Manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [line],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, line.id, 'color', '#ff0000')).toMatchObject({
      gid: line.id,
      prop: 'color',
      mode: 'backend_patch',
    });
    expect(buildSupportedSidebarPatchEntry(manifest, line.id, 'linewidth', 2)).toBeNull();
  });

  it('filters axis and spine preset properties through the same target gate', () => {
    const axis = {
      id: 'axis.x.0',
      kind: 'axis_x',
      label: 'axis.x.0',
      editable: ['tick_direction', 'tick_length'],
      currentProps: {},
      propertyCapabilities: [{
        prop: 'tick_direction',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const spine = {
      id: 'spine_group.0',
      kind: 'spine_group',
      label: 'spine_group.0',
      editable: ['color', 'linewidth'],
      currentProps: {},
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;
    const manifest: Manifest = {
      generatedBy: 'introspection',
      globals: {},
      objects: [axis, spine],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    };

    expect(buildSupportedSidebarPatchEntry(manifest, axis.id, 'tick_direction', 'in')).not.toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, axis.id, 'tick_length', 5)).toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, spine.id, 'color', '#112233')).not.toBeNull();
    expect(buildSupportedSidebarPatchEntry(manifest, spine.id, 'linewidth', 2)).toBeNull();
  });

  it('filters batch patch candidates through modern property capabilities', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'subplot.0',
      editable: ['left', 'width'],
      currentProps: { left: 0.1, width: 0.8 },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    const patches = buildSupportedObjectPatchEntries({
      generatedBy: 'introspection',
      globals: {},
      objects: [subplot],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    }, subplot, [
      { prop: 'left', value: 0.2 },
      { prop: 'width', value: 0.7 },
    ]);

    expect(patches).toEqual([{
      op: 'set',
      gid: subplot.id,
      prop: 'width',
      value: 0.7,
      mode: 'backend_patch',
    }]);
  });

  it('uses propertyCapabilities as the modern per-prop authority for subplot batch controls', () => {
    const subplot = {
      id: 'subplot.0',
      kind: 'subplot',
      label: 'subplot.0',
      editable: ['left', 'bottom', 'width', 'height', 'aspect'],
      currentProps: {
        left: 0.1,
        bottom: 0.1,
        width: 0.8,
        height: 0.8,
        aspect: 'auto',
      },
      propertyCapabilities: [{
        prop: 'width',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    expect(supportsComponentBatchProp(subplot, 'width')).toBe(true);
    expect(supportsComponentBatchProp(subplot, 'left')).toBe(false);
    expect(supportsComponentBatchProp(subplot, 'bottom')).toBe(false);
    expect(supportsComponentBatchProp(subplot, 'height')).toBe(false);
    expect(supportsComponentBatchProp(subplot, 'aspect')).toBe(false);
  });

  it('keeps legacy component center subplot bounds editable without propertyCapabilities', () => {
    const legacySubplot = {
      id: 'subplot.legacy',
      kind: 'subplot',
      label: 'subplot.legacy',
      editable: ['left'],
      currentProps: { left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 },
    } as ManifestObject;

    expect(supportsComponentBatchProp(legacySubplot, 'left')).toBe(true);
    expect(supportsComponentBatchProp(legacySubplot, 'bottom')).toBe(true);
    expect(supportsComponentBatchProp(legacySubplot, 'width')).toBe(true);
    expect(supportsComponentBatchProp(legacySubplot, 'height')).toBe(true);
  });

  it('does not expose modern legend layout props omitted from capabilities', () => {
    const legend = {
      id: 'legend.0',
      kind: 'legend',
      label: 'legend.0',
      editable: ['handlelength', 'handleheight'],
      currentProps: { handlelength: 2, handleheight: 0.7 },
      propertyCapabilities: [{
        prop: 'handlelength',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    } as ManifestObject;

    expect(supportsComponentBatchProp(legend, 'handlelength')).toBe(true);
    expect(supportsComponentBatchProp(legend, 'handleheight')).toBe(false);
  });
});
