import type { Manifest, ManifestObject } from '../schemas/manifest';
import type { ProjectedPropertyDescriptor } from '../schemas/propertyDescriptor';
import { projectPropertyDescriptors } from './propertyDescriptors';
import type { PaletteTargetResolution, ResolvedPaletteTarget } from './paletteTargetResolver';

export interface PaletteColorProjectionRequest {
  manifest: Manifest;
  resolution: PaletteTargetResolution;
  paletteColor: string;
  controlId: string;
  allowCodePatch: boolean;
  selectedOnly?: boolean;
}

export interface PaletteColorProjection {
  controlId: string;
  representativeId: string;
  projection: ProjectedPropertyDescriptor;
  objectTargets: ResolvedPaletteTarget[];
  codeOnlyTargets: ResolvedPaletteTarget[];
}

function issueDetail(resolution: PaletteTargetResolution): string | undefined {
  return resolution.ambiguous[0]?.detail
    || resolution.skipped[0]?.detail
    || resolution.warnings[0];
}

function syntheticObject(
  id: string,
  color: string,
  editable: boolean,
  reason?: string,
): ManifestObject {
  return {
    id,
    kind: 'line',
    label: id,
    editable: ['color'],
    currentProps: { color },
    propertyCapabilities: [{
      prop: 'color',
      patchMode: 'backend_patch',
      scopes: ['object'],
      preview: 'none',
      replay: editable ? 'stable' : 'unsupported',
      unsupportedReason: editable ? undefined : reason || '当前颜色绑定不可安全编辑',
    }],
  } as ManifestObject;
}

function cloneTargetObject(
  object: ManifestObject,
  target: ResolvedPaletteTarget,
  id: string,
  paletteColor: string,
): ManifestObject {
  return {
    ...object,
    id,
    currentProps: {
      ...object.currentProps,
      ...(target.replayMode === 'code_only' ? { [target.prop]: paletteColor } : {}),
    },
  };
}

export function projectPaletteColorControl({
  manifest,
  resolution,
  paletteColor,
  controlId,
  allowCodePatch,
  selectedOnly = false,
}: PaletteColorProjectionRequest): PaletteColorProjection {
  const objectsById = new Map((manifest.objects ?? []).map(object => [object.id, object]));
  const objectTargets = resolution.targets.filter(target => target.replayMode !== 'code_only');
  const codeOnlyTargets = resolution.targets.filter(target => target.replayMode === 'code_only');
  const bindingBlocked = resolution.ambiguous.length > 0;
  const usableTargets = bindingBlocked && !allowCodePatch
    ? []
    : resolution.targets.filter(target => !selectedOnly || target.replayMode !== 'code_only');
  const projectedObjects: ManifestObject[] = [];
  const resolvedColorProps: Record<string, string> = {};

  usableTargets.forEach((target, index) => {
    if (target.replayMode === 'code_only' && !allowCodePatch) return;
    const object = objectsById.get(target.objectId);
    if (!object) return;
    const projectedId = `${controlId}::${index}`;
    projectedObjects.push(cloneTargetObject(object, target, projectedId, paletteColor));
    resolvedColorProps[projectedId] = target.prop;
  });

  if (projectedObjects.length === 0) {
    const editableCodeTarget = allowCodePatch && !selectedOnly;
    projectedObjects.push(syntheticObject(
      controlId,
      paletteColor,
      editableCodeTarget,
      issueDetail(resolution),
    ));
    resolvedColorProps[controlId] = 'color';
  }

  const projection = projectPropertyDescriptors({
    center: 'palette',
    objects: projectedObjects,
    scope: 'object',
    resolvedPropByKey: { color: resolvedColorProps },
  }).find(item => item.key === 'color');

  if (!projection) throw new Error('Palette color descriptor is not registered.');

  const issueCount = resolution.skipped.length + resolution.ambiguous.length;
  if (issueCount > 0 && projection.counts.editable > 0) {
    projection.counts = {
      ...projection.counts,
      total: projection.counts.total + issueCount,
      unsupported: projection.counts.unsupported + issueCount,
    };
    projection.state = 'partial';
    projection.unsupportedReasons[projectedObjects[0].id] = issueDetail(resolution);
  }

  return {
    controlId,
    representativeId: projectedObjects[0].id,
    projection,
    objectTargets,
    codeOnlyTargets,
  };
}
