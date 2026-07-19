import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import {
  buildDiagramComponentGroups,
  isDedicatedDiagramComponentObject,
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
