import type {
  Binding,
  BindingTarget,
  EditMode,
  LocalPatchEntry,
  Manifest,
  ManifestObject,
} from '../schemas/manifest';

export type PaletteTargetStrategy = 'legacy' | 'strict';

export type PaletteTargetFallbackReason =
  | 'feature_disabled'
  | 'missing_binding_protocol'
  | 'missing_object_protocol';

export interface ResolvedPaletteTarget {
  objectId: string;
  prop: string;
  instanceKey?: string;
  seriesKey?: string;
  match: BindingTarget['match'] | 'legacy';
  confidence: BindingTarget['confidence'] | 'legacy';
  patchMode: EditMode;
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

const LOCAL_COLOR_PROPS = new Set(['color', 'facecolor', 'edgecolor', 'alpha', 'visible']);

function matchingBindings(manifest: Manifest, paletteId: string): Binding[] {
  return (manifest.bindings ?? []).filter(binding => binding.paletteId === paletteId);
}

function objectById(manifest: Manifest, gid: string): ManifestObject | undefined {
  return (manifest.objects ?? []).find(object => object.id === gid);
}

function fallbackProp(binding: Binding, object: ManifestObject): string {
  const declared = (binding.props ?? []).find(prop => object.editable.includes(prop));
  if (declared) return declared;
  if (object.kind === 'line') return 'color';
  if (object.editable.includes('facecolor')) return 'facecolor';
  if (object.editable.includes('color')) return 'color';
  return binding.props?.[0] || 'color';
}

function propertyCapability(object: ManifestObject, prop: string) {
  return object.propertyCapabilities?.find(capability => capability.prop === prop);
}

function resolvePatchMode(manifest: Manifest, object: ManifestObject, prop: string): EditMode {
  const capability = propertyCapability(object, prop);
  if (capability) return capability.patchMode;
  if (manifest.generatedBy === 'r_svg') return 'backend_patch';
  return LOCAL_COLOR_PROPS.has(prop) && object.editable.includes(prop)
    ? 'local_patch'
    : 'backend_patch';
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
    targets.push({
      objectId: gid,
      prop,
      instanceKey: object.identity?.instanceKey,
      seriesKey: object.identity?.seriesKey,
      match: 'legacy',
      confidence: 'legacy',
      patchMode: resolvePatchMode(manifest, object, prop),
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

export function resolvePaletteTargets(
  manifest: Manifest,
  paletteId: string,
  enabled: boolean,
  selectedObjectIds?: string[],
): PaletteTargetResolution {
  const bindings = matchingBindings(manifest, paletteId);
  if (!enabled) {
    return legacyResolution(manifest, paletteId, bindings, selectedObjectIds, 'feature_disabled');
  }
  if (bindings.length === 0) {
    return legacyResolution(manifest, paletteId, bindings, selectedObjectIds);
  }
  if (!bindings.every(bindingProtocolReady)) {
    return legacyResolution(
      manifest,
      paletteId,
      bindings,
      selectedObjectIds,
      'missing_binding_protocol',
    );
  }
  if (!objectProtocolReady(manifest, bindings)) {
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
  const targets = new Map<string, ResolvedPaletteTarget>();
  const skipped: PaletteTargetIssue[] = [];
  const ambiguous: PaletteTargetIssue[] = [];
  const warnings = Array.from(new Set(bindings.flatMap(binding => binding.warnings ?? [])));

  bindings.forEach((binding) => {
    if (binding.targetMode === 'ambiguous' || binding.targetMode === 'unresolved') {
      ambiguous.push({
        reason: 'ambiguous_binding',
        detail: binding.warnings?.[0] || `${paletteId} binding is ${binding.targetMode}.`,
      });
      return;
    }
    (binding.targets ?? []).forEach((target) => {
      if (selected && !selected.has(target.gid)) return;
      const object = objectById(manifest, target.gid);
      if (!object) {
        skipped.push({ objectId: target.gid, reason: 'not_found', detail: `${target.gid} is not present in the manifest.` });
        return;
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
      const capability = propertyCapability(object, target.prop);
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
        patchMode: capability.patchMode,
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

export function buildPaletteObjectPatches(
  resolution: PaletteTargetResolution,
  value: unknown,
): LocalPatchEntry[] {
  if (resolution.strategy === 'strict' && resolution.ambiguous.length > 0) return [];
  return resolution.targets.map(target => ({
    op: 'set',
    mode: target.patchMode,
    gid: target.objectId,
    prop: target.prop,
    value,
  }));
}
