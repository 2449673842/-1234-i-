import type {
  Binding,
  BindingTarget,
  EditMode,
  LocalPatchEntry,
  Manifest,
  ManifestObject,
} from '../schemas/manifest';
import {
  isParentOwnedManifestObject,
  propertyCapabilityFor,
  resolvePatchMode,
} from './propertyPatchMode';

export type PaletteTargetStrategy = 'legacy' | 'strict';

export type PaletteTargetFallbackReason =
  | 'feature_disabled'
  | 'missing_binding_protocol'
  | 'missing_object_protocol';

export interface ResolvedPaletteTarget {
  objectId: string;
  prop: string;
  matchColor?: string;
  instanceKey?: string;
  seriesKey?: string;
  match: BindingTarget['match'] | 'legacy';
  confidence: BindingTarget['confidence'] | 'legacy';
  patchMode: EditMode;
  replayMode: NonNullable<BindingTarget['replayMode']>;
}

export interface PaletteTargetIssue {
  objectId?: string;
  reason:
    | 'no_binding'
    | 'ambiguous_binding'
    | 'not_found'
    | 'identity_mismatch'
    | 'series_mismatch'
    | 'duplicate_identity'
    | 'unsupported_prop';
  detail: string;
  candidates?: string[];
}

export interface PaletteTargetResolution {
  paletteId: string;
  strategy: PaletteTargetStrategy;
  fallbackReason?: PaletteTargetFallbackReason;
  targetMode: Binding['targetMode'] | 'legacy' | 'unbound';
  targets: ResolvedPaletteTarget[];
  skipped: PaletteTargetIssue[];
  ambiguous: PaletteTargetIssue[];
  warnings: string[];
}

const COLOR_FALLBACK_KINDS = new Set([
  'line',
  'collection',
  'quiver',
  'streamplot',
  'fill_between',
  'patch',
  'bar_container',
  'errorbar_container',
  'stem_container',
  'boxplot_container',
  'violinplot_container',
]);
const COLOR_FALLBACK_PROPS = ['facecolor', 'color', 'edgecolor'];
const DIAGRAM_ROLES = new Set([
  'diagram_node',
  'diagram_edge',
  'diagram_arrow',
  'diagram_node_label',
  'diagram_coefficient_label',
  'diagram_fit_annotation',
  'diagram_group',
]);

interface DiagramIdentity {
  diagramId: string;
  diagramType: string;
  semanticRole: string;
  diagramObjectId: string;
  signature: string;
  edgeSignature?: string;
}

function isContourParent(object: ManifestObject | undefined): boolean {
  return object?.kind === 'contour'
    || object?.kind === 'contourf'
    || object?.role === 'contour_series'
    || object?.role === 'contourf_series';
}

function isContourChildCollection(manifest: Manifest, object: ManifestObject): boolean {
  if (object.role === 'contour_child_collection') return true;
  const parentId = object.parentId ?? object.identity?.relation?.parentId;
  if (!parentId) return false;
  return isContourParent(objectById(manifest, parentId));
}

function matchingBindings(manifest: Manifest, paletteId: string): Binding[] {
  return (manifest.bindings ?? []).filter(binding => binding.paletteId === paletteId);
}

function objectById(manifest: Manifest, gid: string): ManifestObject | undefined {
  return (manifest.objects ?? []).find(object => object.id === gid);
}

function targetKey(target: BindingTarget): string {
  return `${target.gid}:${target.prop}`;
}

function isDiagramSemanticObject(object: ManifestObject | undefined): boolean {
  return Boolean(object?.role && DIAGRAM_ROLES.has(object.role));
}

function relationString(
  relation: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = relation?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function diagramIdentityFor(object: ManifestObject): DiagramIdentity | null {
  if (!isDiagramSemanticObject(object) || !object.role) return null;
  const relation = object.identity?.relation as Record<string, unknown> | undefined;
  const diagramId = relationString(relation, 'diagramId');
  const diagramType = relationString(relation, 'diagramType');
  const diagramObjectId = relationString(relation, 'diagramObjectId');
  if (!diagramId || !diagramType || !diagramObjectId) return null;

  const edgeId = relationString(relation, 'edgeId');
  const sourceNodeId = relationString(relation, 'sourceNodeId');
  const targetNodeId = relationString(relation, 'targetNodeId');
  const edgeSignature = edgeId && sourceNodeId && targetNodeId
    ? `${diagramId}:${diagramType}:${edgeId}:${sourceNodeId}:${targetNodeId}`
    : undefined;

  return {
    diagramId,
    diagramType,
    semanticRole: object.role,
    diagramObjectId,
    signature: `${diagramId}:${diagramType}:${object.role}:${diagramObjectId}`,
    edgeSignature,
  };
}

function expectedDiagramSeriesKey(identity: DiagramIdentity): string {
  return `diagram:${identity.diagramId}:${identity.semanticRole}:${identity.diagramObjectId}`;
}

function diagramIdentityOwners(manifest: Manifest): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  (manifest.objects ?? []).forEach((object) => {
    const identity = diagramIdentityFor(object);
    if (!identity) return;
    owners.set(identity.signature, [...(owners.get(identity.signature) ?? []), object.id]);
  });
  return owners;
}

function isMultiColorValue(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) return false;
  const colors = new Set<string>();
  value.forEach((row) => {
    if (!Array.isArray(row) || row.length < 3) return;
    const rgb = row.slice(0, 3).map(component => Number(component));
    if (rgb.some(component => !Number.isFinite(component))) return;
    colors.add(rgb.map(component => Math.round(component * 255)).join(','));
  });
  return colors.size > 1;
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = /^#([0-9a-fA-F]{6})/.exec(value.trim());
    return match ? `#${match[1].toLowerCase()}` : null;
  }
  if (Array.isArray(value) && value.length >= 3 && !Array.isArray(value[0])) {
    const rgb = value.slice(0, 3).map(component => Number(component));
    if (rgb.some(component => !Number.isFinite(component))) return null;
    return `#${rgb.map(component => Math.round(component * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

function colorValueContains(value: unknown, targetHex: string): boolean {
  const normalized = normalizeHexColor(value);
  if (normalized === targetHex) return true;
  if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
    return value.some(row => normalizeHexColor(row) === targetHex);
  }
  return false;
}

function shouldUseColorSubsetPatch(value: unknown, targetHex: string): boolean {
  return isMultiColorValue(value) && colorValueContains(value, targetHex);
}

function replayModeForTarget(
  object: ManifestObject,
  prop: string,
  declared?: BindingTarget['replayMode'],
): NonNullable<BindingTarget['replayMode']> {
  if (declared) return declared;
  return isMultiColorValue(object.currentProps?.[prop]) ? 'code_only' : 'object_patch';
}

function colorPropSupportedByObject(object: ManifestObject, prop: string): boolean {
  const capability = object.propertyCapabilities?.find(item => item.prop === prop);
  if (capability) {
    return capability.replay !== 'unsupported'
      && capability.scopes.includes('object');
  }
  if (Array.isArray(object.propertyCapabilities)) return false;
  return object.editable.includes(prop);
}

function colorFallbackPropSupportedByObject(object: ManifestObject, prop: string): boolean {
  const capability = propertyCapabilityFor(object, prop);
  if (capability) return capability.replay !== 'unsupported' && capability.scopes.includes('object');
  return !Array.isArray(object.propertyCapabilities);
}

function fallbackProp(binding: Binding, object: ManifestObject): string | null {
  const declared = (binding.props ?? []).find(prop => colorPropSupportedByObject(object, prop));
  if (declared) return declared;
  if (object.kind === 'line' && colorPropSupportedByObject(object, 'color')) return 'color';
  if (colorPropSupportedByObject(object, 'facecolor')) return 'facecolor';
  if (colorPropSupportedByObject(object, 'color')) return 'color';
  return null;
}

function identityOwners(manifest: Manifest): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  (manifest.objects ?? []).forEach((object) => {
    const instanceKey = object.identity?.instanceKey;
    if (!instanceKey) return;
    owners.set(instanceKey, [...(owners.get(instanceKey) ?? []), object.id]);
  });
  return owners;
}

function legacyResolution(
  manifest: Manifest,
  paletteId: string,
  bindings: Binding[],
  selectedObjectIds?: string[],
  fallbackReason?: PaletteTargetFallbackReason,
): PaletteTargetResolution {
  const binding = bindings[0];
  if (!binding) {
    return {
      paletteId,
      strategy: 'legacy',
      fallbackReason,
      targetMode: 'unbound',
      targets: [],
      skipped: [{ reason: 'no_binding', detail: `${paletteId} has no binding.` }],
      ambiguous: [],
      warnings: [],
    };
  }
  if (binding.targetMode === 'ambiguous' || binding.targetMode === 'unresolved') {
    return {
      paletteId,
      strategy: 'legacy',
      fallbackReason,
      targetMode: binding.targetMode,
      targets: [],
      skipped: [],
      ambiguous: [{
        reason: 'ambiguous_binding',
        detail: binding.warnings?.[0] || `${paletteId} binding is ${binding.targetMode}.`,
      }],
      warnings: binding.warnings ?? [],
    };
  }
  const selected = selectedObjectIds ? new Set(selectedObjectIds) : null;
  const targets: ResolvedPaletteTarget[] = [];
  const skipped: PaletteTargetIssue[] = [];
  (binding.gids ?? []).forEach((gid) => {
    if (selected && !selected.has(gid)) return;
    const object = objectById(manifest, gid);
    if (!object) {
      skipped.push({ objectId: gid, reason: 'not_found', detail: `${gid} is not present in the manifest.` });
      return;
    }
    const prop = fallbackProp(binding, object);
    if (!prop) {
      skipped.push({
        objectId: gid,
        reason: 'unsupported_prop',
        detail: `${gid} has no renderer-declared palette color property.`,
      });
      return;
    }
    targets.push({
      objectId: gid,
      prop,
      instanceKey: object.identity?.instanceKey,
      seriesKey: object.identity?.seriesKey,
      match: 'legacy',
      confidence: 'legacy',
      patchMode: resolvePatchMode(manifest, object, prop),
      replayMode: replayModeForTarget(object, prop),
    });
  });
  return {
    paletteId,
    strategy: 'legacy',
    fallbackReason,
    targetMode: 'legacy',
    targets,
    skipped,
    ambiguous: [],
    warnings: binding.warnings ?? [],
  };
}

function bindingProtocolReady(binding: Binding): boolean {
  if (!binding.targetMode || !Array.isArray(binding.targets)) return false;
  if (binding.targetMode === 'ambiguous' || binding.targetMode === 'unresolved') return true;
  return binding.targets.every(target => Boolean(
    target.gid
    && target.prop
    && target.instanceKey
    && target.seriesKey
    && target.match
    && target.confidence,
  ));
}

function objectProtocolReady(manifest: Manifest, bindings: Binding[]): boolean {
  return bindings.every(binding => (binding.targets ?? []).every((target) => {
    const object = objectById(manifest, target.gid);
    if (!object) return true;
    return Boolean(object.identity?.instanceKey && Array.isArray(object.propertyCapabilities));
  }));
}

function mergeTargetMode(bindings: Binding[]): PaletteTargetResolution['targetMode'] {
  const modes = new Set(bindings.map(binding => binding.targetMode));
  if (modes.has('ambiguous')) return 'ambiguous';
  if (modes.has('unresolved')) return 'unresolved';
  if (modes.has('conditional')) return 'conditional';
  if (modes.has('semantic')) return 'semantic';
  return 'exact';
}

function histogramPaletteScope(manifest: Manifest, binding: Binding) {
  const histogramObjects = (binding.targets ?? [])
    .map(target => objectById(manifest, target.gid))
    .filter((object): object is ManifestObject => object?.role === 'histogram_series');
  if (histogramObjects.length === 0) return null;

  const histogramIds = new Set(histogramObjects.map(object => object.id));
  const seriesKeys = new Set(histogramObjects
    .map(object => object.identity?.seriesKey)
    .filter((value): value is string => Boolean(value)));
  (binding.targets ?? []).forEach((target) => {
    const object = objectById(manifest, target.gid);
    if (object?.role === 'histogram_series' && target.seriesKey) seriesKeys.add(target.seriesKey);
  });
  const legendMarkerIds = new Set(histogramObjects.flatMap(object => (
    object.identity?.relation?.legendMarkerIds ?? []
  )));

  return { histogramIds, seriesKeys, legendMarkerIds };
}

function isHistogramScopedPaletteTarget(
  object: ManifestObject,
  target: BindingTarget,
  scope: NonNullable<ReturnType<typeof histogramPaletteScope>>,
): boolean {
  if (object.role === 'histogram_series') {
    return Boolean(target.seriesKey && scope.seriesKeys.has(target.seriesKey));
  }
  if (object.role !== 'legend_marker') return false;

  const parentId = object.parentId ?? object.identity?.relation?.parentId;
  return Boolean(parentId && scope.histogramIds.has(parentId))
    || scope.legendMarkerIds.has(object.id);
}

function piePaletteScope(manifest: Manifest, binding: Binding) {
  const pieSlices = (binding.targets ?? [])
    .map(target => objectById(manifest, target.gid))
    .filter((object): object is ManifestObject => object?.role === 'pie_slice');
  if (pieSlices.length === 0) return null;

  const pieSliceIds = new Set(pieSlices.map(object => object.id));
  const seriesKeys = new Set(pieSlices
    .map(object => object.identity?.seriesKey)
    .filter((value): value is string => Boolean(value)));
  const legendMarkerIds = new Set(pieSlices.flatMap(object => (
    object.identity?.relation?.legendMarkerIds ?? []
  )));
  return { pieSliceIds, seriesKeys, legendMarkerIds };
}

function isPieScopedPaletteTarget(
  object: ManifestObject,
  target: BindingTarget,
  scope: NonNullable<ReturnType<typeof piePaletteScope>>,
): boolean {
  if (object.role === 'pie_slice') {
    return Boolean(target.seriesKey && scope.seriesKeys.has(target.seriesKey));
  }
  if (object.role !== 'legend_marker') return false;
  const parentId = object.parentId ?? object.identity?.relation?.parentId;
  return Boolean(parentId && scope.pieSliceIds.has(parentId))
    || scope.legendMarkerIds.has(object.id);
}

function diagramPaletteScope(
  manifest: Manifest,
  binding: Binding,
  selected: Set<string> | null,
  diagramOwners: Map<string, string[]>,
): {
  hasDiagramTargets: boolean;
  allowedTargetKeys: Set<string>;
  issue?: PaletteTargetIssue;
} {
  const entries: Array<{
    target: BindingTarget;
    object: ManifestObject;
    identity: DiagramIdentity;
  }> = [];
  let hasDiagramTargets = false;

  for (const target of binding.targets ?? []) {
    if (selected && !selected.has(target.gid)) continue;
    const object = objectById(manifest, target.gid);
    if (!isDiagramSemanticObject(object)) continue;
    hasDiagramTargets = true;
    if (!object) continue;

    const identity = diagramIdentityFor(object);
    if (!identity) {
      return {
        hasDiagramTargets,
        allowedTargetKeys: new Set(),
        issue: {
          objectId: target.gid,
          reason: 'identity_mismatch',
          detail: `${target.gid} is missing trusted diagram relation metadata.`,
        },
      };
    }
    const duplicateOwners = diagramOwners.get(identity.signature) ?? [];
    if (duplicateOwners.length > 1) {
      return {
        hasDiagramTargets,
        allowedTargetKeys: new Set(),
        issue: {
          objectId: target.gid,
          reason: 'duplicate_identity',
          detail: `${identity.signature} belongs to multiple diagram objects.`,
          candidates: duplicateOwners,
        },
      };
    }
    if (target.seriesKey !== expectedDiagramSeriesKey(identity)) {
      return {
        hasDiagramTargets,
        allowedTargetKeys: new Set(),
        issue: {
          objectId: target.gid,
          reason: 'series_mismatch',
          detail: `${target.gid} diagram relation conflicts with its palette binding identity.`,
        },
      };
    }
    entries.push({ target, object, identity });
  }

  if (!hasDiagramTargets) {
    return { hasDiagramTargets: false, allowedTargetKeys: new Set() };
  }
  if (entries.length === 0) {
    return {
      hasDiagramTargets: true,
      allowedTargetKeys: new Set(),
      issue: {
        reason: 'identity_mismatch',
        detail: `${binding.paletteId} has diagram targets without resolvable manifest objects.`,
      },
    };
  }

  const signatures = new Set(entries.map(entry => entry.identity.signature));
  if (signatures.size === 1) {
    return {
      hasDiagramTargets: true,
      allowedTargetKeys: new Set(entries.map(entry => targetKey(entry.target))),
    };
  }

  const roles = new Set(entries.map(entry => entry.identity.semanticRole));
  const edgeSignatures = new Set(entries
    .map(entry => entry.identity.edgeSignature)
    .filter((value): value is string => Boolean(value)));
  const isLinkedEdgeArrow = roles.size === 2
    && roles.has('diagram_edge')
    && roles.has('diagram_arrow')
    && edgeSignatures.size === 1
    && entries.every(entry => Boolean(entry.identity.edgeSignature));

  if (isLinkedEdgeArrow) {
    return {
      hasDiagramTargets: true,
      allowedTargetKeys: new Set(entries.map(entry => targetKey(entry.target))),
    };
  }

  return {
    hasDiagramTargets: true,
    allowedTargetKeys: new Set(),
    issue: {
      reason: 'ambiguous_binding',
      detail: `${binding.paletteId} spans multiple diagram identities without an explicit edge/arrow relation.`,
      candidates: entries.map(entry => entry.object.id),
    },
  };
}

export function resolvePaletteTargets(
  manifest: Manifest,
  paletteId: string,
  enabled: boolean,
  selectedObjectIds?: string[],
  requireProtocol = false,
): PaletteTargetResolution {
  const bindings = matchingBindings(manifest, paletteId);
  if (!enabled) {
    return legacyResolution(manifest, paletteId, bindings, selectedObjectIds, 'feature_disabled');
  }
  if (bindings.length === 0) {
    return legacyResolution(manifest, paletteId, bindings, selectedObjectIds);
  }
  if (!bindings.every(bindingProtocolReady)) {
    if (requireProtocol) {
      return {
        paletteId,
        strategy: 'strict',
        fallbackReason: 'missing_binding_protocol',
        targetMode: 'unresolved',
        targets: [],
        skipped: [],
        ambiguous: [{
          reason: 'ambiguous_binding',
          detail: `${paletteId} 缺少完整的 binding target 身份协议，已阻止对象颜色修改。`,
        }],
        warnings: [],
      };
    }
    return legacyResolution(
      manifest,
      paletteId,
      bindings,
      selectedObjectIds,
      'missing_binding_protocol',
    );
  }
  if (!objectProtocolReady(manifest, bindings)) {
    if (requireProtocol) {
      return {
        paletteId,
        strategy: 'strict',
        fallbackReason: 'missing_object_protocol',
        targetMode: 'unresolved',
        targets: [],
        skipped: [],
        ambiguous: [{
          reason: 'ambiguous_binding',
          detail: `${paletteId} 的目标对象缺少稳定 identity/capability，已阻止对象颜色修改。`,
        }],
        warnings: [],
      };
    }
    return legacyResolution(
      manifest,
      paletteId,
      bindings,
      selectedObjectIds,
      'missing_object_protocol',
    );
  }

  const selected = selectedObjectIds ? new Set(selectedObjectIds) : null;
  const owners = identityOwners(manifest);
  const diagramOwners = diagramIdentityOwners(manifest);
  const targets = new Map<string, ResolvedPaletteTarget>();
  const skipped: PaletteTargetIssue[] = [];
  const ambiguous: PaletteTargetIssue[] = [];
  const warnings = Array.from(new Set(bindings.flatMap(binding => binding.warnings ?? [])));

  bindings.forEach((binding) => {
    const histogramScope = histogramPaletteScope(manifest, binding);
    const pieScope = piePaletteScope(manifest, binding);
    const diagramScope = diagramPaletteScope(manifest, binding, selected, diagramOwners);
    if (binding.targetMode === 'ambiguous' || binding.targetMode === 'unresolved') {
      ambiguous.push({
        reason: 'ambiguous_binding',
        detail: binding.warnings?.[0] || `${paletteId} binding is ${binding.targetMode}.`,
      });
      return;
    }
    if (diagramScope.issue) {
      ambiguous.push(diagramScope.issue);
      return;
    }
    (binding.targets ?? []).forEach((target) => {
      if (selected && !selected.has(target.gid)) return;
      const object = objectById(manifest, target.gid);
      if (!object) {
        skipped.push({ objectId: target.gid, reason: 'not_found', detail: `${target.gid} is not present in the manifest.` });
        return;
      }
      if (diagramScope.hasDiagramTargets) {
        if (!isDiagramSemanticObject(object)) {
          skipped.push({
            objectId: target.gid,
            reason: 'series_mismatch',
            detail: `${target.gid} is outside the diagram palette binding scope.`,
          });
          return;
        }
        if (!diagramScope.allowedTargetKeys.has(targetKey(target))) {
          skipped.push({
            objectId: target.gid,
            reason: 'identity_mismatch',
            detail: `${target.gid} is not part of the trusted diagram palette identity.`,
          });
          return;
        }
      }
      const duplicateOwners = target.instanceKey ? owners.get(target.instanceKey) ?? [] : [];
      if (duplicateOwners.length > 1) {
        ambiguous.push({
          objectId: target.gid,
          reason: 'duplicate_identity',
          detail: `${target.instanceKey} belongs to multiple objects.`,
          candidates: duplicateOwners,
        });
        return;
      }
      if (target.instanceKey !== object.identity?.instanceKey) {
        skipped.push({
          objectId: target.gid,
          reason: 'identity_mismatch',
          detail: `${target.gid} instance identity changed since binding generation.`,
        });
        return;
      }
      if (target.seriesKey !== object.identity?.seriesKey) {
        skipped.push({
          objectId: target.gid,
          reason: 'series_mismatch',
          detail: `${target.gid} series identity changed since binding generation.`,
        });
        return;
      }
      if (histogramScope && !isHistogramScopedPaletteTarget(object, target, histogramScope)) {
        skipped.push({
          objectId: target.gid,
          reason: 'series_mismatch',
          detail: `${target.gid} is outside the histogram series binding scope.`,
        });
        return;
      }
      if (pieScope && !isPieScopedPaletteTarget(object, target, pieScope)) {
        skipped.push({
          objectId: target.gid,
          reason: 'series_mismatch',
          detail: `${target.gid} is outside the pie slice binding scope.`,
        });
        return;
      }
      const capability = propertyCapabilityFor(object, target.prop);
      if (!capability || capability.replay === 'unsupported' || !capability.scopes.includes('object')) {
        skipped.push({
          objectId: target.gid,
          reason: 'unsupported_prop',
          detail: `${target.gid} does not support stable ${target.prop} editing.`,
        });
        return;
      }
      targets.set(`${target.gid}:${target.prop}`, {
        objectId: target.gid,
        prop: target.prop,
        instanceKey: target.instanceKey,
        seriesKey: target.seriesKey,
        match: target.match,
        confidence: target.confidence,
        patchMode: resolvePatchMode(manifest, object, target.prop),
        replayMode: replayModeForTarget(object, target.prop, target.replayMode),
      });
    });
  });

  return {
    paletteId,
    strategy: 'strict',
    targetMode: mergeTargetMode(bindings),
    targets: Array.from(targets.values()),
    skipped,
    ambiguous,
    warnings,
  };
}

export function resolvePaletteColorFallbackTargets(
  manifest: Manifest,
  paletteId: string,
  paletteColor: unknown,
  selectedObjectIds?: string[],
): PaletteTargetResolution {
  const targetHex = normalizeHexColor(paletteColor);
  const selected = selectedObjectIds ? new Set(selectedObjectIds) : null;
  const targets = new Map<string, ResolvedPaletteTarget>();
  if (!targetHex) {
    return {
      paletteId,
      strategy: 'strict',
      targetMode: 'unresolved',
      targets: [],
      skipped: [{ reason: 'no_binding', detail: `${paletteId} has no normalizable palette color.` }],
      ambiguous: [],
      warnings: ['Palette color fallback could not normalize the palette color.'],
    };
  }

  if (selected && (manifest.objects ?? []).some(object => selected.has(object.id) && isDiagramSemanticObject(object))) {
    return {
      paletteId,
      strategy: 'strict',
      targetMode: 'conditional',
      targets: [],
      skipped: [],
      ambiguous: [{
        reason: 'ambiguous_binding',
        detail: `${paletteId} selected a diagram semantic object without an exact trusted diagram binding.`,
      }],
      warnings: ['Diagram semantic objects require exact diagram palette bindings; rendered-color fallback was disabled.'],
    };
  }

  const selectedObjects = (manifest.objects ?? []).filter(object => (
    (!selected || selected.has(object.id))
    && COLOR_FALLBACK_KINDS.has(object.kind)
    && !isDiagramSemanticObject(object)
    && !isParentOwnedManifestObject(object)
  ));
  const matchingPieSlices = selectedObjects.filter(object => (
    object.role === 'pie_slice'
    && COLOR_FALLBACK_PROPS.some(prop => (
      colorFallbackPropSupportedByObject(object, prop)
      && Object.prototype.hasOwnProperty.call(object.currentProps ?? {}, prop)
      && colorValueContains(object.currentProps?.[prop], targetHex)
    ))
  ));
  const pieSliceIds = new Set(matchingPieSlices.map(object => object.id));
  const pieLegendMarkerIds = new Set(matchingPieSlices.flatMap(object => (
    object.identity?.relation?.legendMarkerIds ?? []
  )));
  const hasPieBoundary = pieSliceIds.size > 0;

  (manifest.objects ?? []).forEach((object) => {
    if (selected && !selected.has(object.id)) return;
    if (!COLOR_FALLBACK_KINDS.has(object.kind)) return;
    if (isDiagramSemanticObject(object)) return;
    if (isParentOwnedManifestObject(object)) return;
    if (object.kind === 'collection' && isContourChildCollection(manifest, object)) return;
    if (hasPieBoundary) {
      const parentId = object.parentId ?? object.identity?.relation?.parentId;
      const insidePieBoundary = pieSliceIds.has(object.id)
        || pieLegendMarkerIds.has(object.id)
        || Boolean(parentId && pieSliceIds.has(parentId));
      if (!insidePieBoundary) return;
    }
    COLOR_FALLBACK_PROPS.forEach((prop) => {
      if (!colorFallbackPropSupportedByObject(object, prop)) return;
      if (!Object.prototype.hasOwnProperty.call(object.currentProps ?? {}, prop)) return;
      if (!colorValueContains(object.currentProps?.[prop], targetHex)) return;
      const useColorSubsetPatch = shouldUseColorSubsetPatch(object.currentProps?.[prop], targetHex);
      targets.set(`${object.id}:${prop}`, {
        objectId: object.id,
        prop,
        matchColor: useColorSubsetPatch ? targetHex : undefined,
        instanceKey: object.identity?.instanceKey,
        seriesKey: object.identity?.seriesKey,
        match: 'unique_color',
        confidence: 'conditional',
        patchMode: useColorSubsetPatch ? 'backend_patch' : resolvePatchMode(manifest, object, prop),
        replayMode: useColorSubsetPatch ? 'object_patch' : replayModeForTarget(object, prop),
      });
    });
  });

  return {
    paletteId,
    strategy: 'strict',
    targetMode: 'conditional',
    targets: Array.from(targets.values()),
    skipped: [],
    ambiguous: [],
    warnings: ['Palette binding used scoped rendered-color fallback because the static palette binding was missing or ambiguous.'],
  };
}

export function buildPaletteObjectPatches(
  resolution: PaletteTargetResolution,
  value: unknown,
): LocalPatchEntry[] {
  if (resolution.strategy === 'strict' && resolution.ambiguous.length > 0) return [];
  return resolution.targets.filter(target => target.replayMode !== 'code_only').map(target => ({
    op: 'set',
    mode: target.patchMode,
    gid: target.objectId,
    prop: target.prop,
    value,
    ...(target.matchColor ? { matchColor: target.matchColor } : {}),
  }));
}

export function buildPaletteUpdatePatches(
  resolution: PaletteTargetResolution,
  value: unknown,
  codeTargetId?: string,
): Array<LocalPatchEntry | {
  type: 'code_patch';
  target_id: string;
  new_value: unknown;
  gids: string[];
}> {
  const objectPatches = buildPaletteObjectPatches(resolution, value);
  if (!codeTargetId) return objectPatches;
  const replayedObjectPatches = objectPatches.map(patch => ({
    ...patch,
    mode: 'backend_patch' as const,
  }));
  return [{
    type: 'code_patch',
    target_id: codeTargetId,
    new_value: value,
    gids: Array.from(new Set(resolution.targets.map(target => target.objectId))),
  }, ...replayedObjectPatches];
}
