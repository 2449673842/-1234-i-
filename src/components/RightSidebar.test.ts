import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import {
  buildDiagramComponentGroups,
  isDedicatedDiagramComponentObject,
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
