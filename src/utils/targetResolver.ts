import type {
  EditingIntent,
  EditingIntentCompileResult,
  EditingIntentSkippedTarget,
  SemanticTargetRole,
} from '../schemas/editingIntent';
import type {
  EditMode,
  Manifest,
  ManifestEditScope,
  ManifestObject,
  ManifestPropertyCapability,
  PatchEntry,
} from '../schemas/manifest';
import { compileEditingIntent, inferEditingTargetRole } from './editingIntentCompiler';

export type ShadowTargetMatch = 'exact' | 'semantic' | 'fanout';

export interface ShadowResolvedTarget {
  objectId: string;
  instanceKey?: string;
  prop: string;
  patchMode: EditMode;
  match: ShadowTargetMatch;
}

export interface ShadowTargetIssue {
  objectId?: string;
  reason: 'not_found' | 'unsupported_prop' | 'unsupported_scope' | 'ambiguous_identity';
  detail: string;
  candidates?: string[];
}

export interface ShadowTargetResolution {
  requestedObjectIds: string[];
  resolved: ShadowResolvedTarget[];
  skipped: ShadowTargetIssue[];
  ambiguous: ShadowTargetIssue[];
}

export interface TargetResolverShadowComparison {
  currentPatchKeys: string[];
  shadowPatchKeys: string[];
  matchingPatchKeys: string[];
  currentOnlyPatchKeys: string[];
  shadowOnlyPatchKeys: string[];
  equivalent: boolean;
  resolution: ShadowTargetResolution;
}

export type ControlledTargetCompilerStrategy = 'legacy' | 'strict';

export type StrictProtocolFallbackReason =
  | 'feature_disabled'
  | 'missing_identity'
  | 'missing_property_capabilities';

export interface StrictProtocolReadiness {
  ready: boolean;
  missingIdentityObjectIds: string[];
  missingPropertyCapabilityObjectIds: string[];
}

export interface ControlledTargetCompileResult extends EditingIntentCompileResult {
  strategy: ControlledTargetCompilerStrategy;
  fallbackReason?: StrictProtocolFallbackReason;
  readiness: StrictProtocolReadiness;
  resolution?: ShadowTargetResolution;
}

const LOCAL_PATCH_PROPS = new Set([
  'text',
  'color',
  'facecolor',
  'edgecolor',
  'alpha',
  'visible',
]);

const TICK_PROP_MAP: Record<string, string> = {
  fontsize: 'tick_labelsize',
  fontfamily: 'tick_labelfamily',
  color: 'tick_labelcolor',
  fontweight: 'tick_fontweight',
  fontstyle: 'tick_fontstyle',
};

function capabilityFor(object: ManifestObject, prop: string): ManifestPropertyCapability | undefined {
  return object.propertyCapabilities?.find(capability => capability.prop === prop);
}

function supportsProp(object: ManifestObject, prop: string): boolean {
  const capability = capabilityFor(object, prop);
  if (capability) return capability.replay !== 'unsupported';
  const unsupported = object.currentProps?.unsupportedProps;
  if (Array.isArray(unsupported) && unsupported.map(String).includes(prop)) return false;
  return object.editable.includes(prop);
}

function requiredCapabilityScope(intent: EditingIntent): ManifestEditScope {
  if (intent.scope.crossFigure === 'allow') return 'cross_figure';
  if (intent.scope.selectionMode === 'role_in_subplot') return 'subplot';
  if (intent.scope.selectionMode === 'role_in_figure') return 'figure';
  return 'object';
}

function patchMode(manifest: Manifest, object: ManifestObject, prop: string): EditMode {
  const capability = capabilityFor(object, prop);
  if (capability) return capability.patchMode;
  if (manifest.generatedBy === 'r_svg') return 'backend_patch';
  return LOCAL_PATCH_PROPS.has(prop) && object.editable.includes(prop)
    ? 'local_patch'
    : 'backend_patch';
}

function strictSubplotIds(object: ManifestObject): string[] {
  if (object.identity) {
    const relation = object.identity.relation;
    if (relation?.subplotIds?.length) return Array.from(new Set(relation.subplotIds));
    return relation?.subplotId ? [relation.subplotId] : [];
  }
  if (object.subplotIds?.length) return Array.from(new Set(object.subplotIds));
  return object.subplotId ? [object.subplotId] : [];
}

function strictSubplotId(object: ManifestObject): string | undefined {
  const subplotIds = strictSubplotIds(object);
  return subplotIds.length === 1 ? subplotIds[0] : undefined;
}

function strictParentId(object: ManifestObject): string | undefined {
  if (object.identity) return object.identity.relation?.parentId;
  return object.parentId;
}

const CONTAINER_KIND_BY_ROLE: Partial<Record<SemanticTargetRole, ManifestObject['kind']>> = {
  data_bar: 'bar_container',
  data_errorbar: 'errorbar_container',
  data_stem: 'stem_container',
  data_boxplot: 'boxplot_container',
  data_violin: 'violinplot_container',
};

function preferSeriesContainers(
  candidates: ManifestObject[],
  role: SemanticTargetRole | undefined,
): ManifestObject[] {
  const containerKind = role ? CONTAINER_KIND_BY_ROLE[role] : undefined;
  if (!containerKind) return candidates;
  const containerIds = new Set(
    candidates.filter(object => object.kind === containerKind).map(object => object.id),
  );
  if (containerIds.size === 0) return candidates;
  return candidates.filter(object => {
    if (object.kind === containerKind) return true;
    const parentId = strictParentId(object);
    return !parentId || !containerIds.has(parentId);
  });
}

function matchesRole(object: ManifestObject, role: SemanticTargetRole): boolean {
  const inferred = inferEditingTargetRole(object);
  return inferred === role || (role === 'axis_frame' && inferred === 'axis_spine');
}

function selectCandidatesBeforeSubplot(
  manifest: Manifest,
  intent: EditingIntent,
): ManifestObject[] {
  const scope = intent.scope;
  let candidates = manifest.objects ?? [];

  if (scope.objectIds?.length) {
    const ids = new Set(scope.objectIds);
    candidates = candidates.filter(object => ids.has(object.id));
  }
  if (scope.targetKinds?.length) {
    const kinds = new Set(scope.targetKinds);
    candidates = candidates.filter(object => kinds.has(object.kind));
  }
  if (scope.targetRole) {
    candidates = candidates.filter(object => matchesRole(object, scope.targetRole!));
  }
  return candidates;
}

function selectCandidates(manifest: Manifest, intent: EditingIntent): ManifestObject[] {
  const scope = intent.scope;
  let candidates = selectCandidatesBeforeSubplot(manifest, intent);
  if (scope.subplotIds && scope.subplotIds !== '*') {
    const subplotIds = new Set(scope.subplotIds);
    candidates = candidates.filter(object => strictSubplotIds(object).some(subplotId => subplotIds.has(subplotId)));
  }
  return candidates;
}

function resolveGroupedTickTargets(
  manifest: Manifest,
  role: 'x_tick_label' | 'y_tick_label',
  candidates: ManifestObject[],
): ManifestObject[] {
  const axisKind = role === 'x_tick_label' ? 'axis_x' : 'axis_y';
  const subplotIds = new Set(
    candidates.flatMap(strictSubplotIds),
  );
  return (manifest.objects ?? []).filter(object => (
    object.kind === axisKind
    && (subplotIds.size === 0 || strictSubplotIds(object).some(subplotId => subplotIds.has(subplotId)))
  ));
}

function removeAmbiguousIdentities(
  candidates: ManifestObject[],
): { candidates: ManifestObject[]; ambiguous: ShadowTargetIssue[] } {
  const byIdentity = new Map<string, ManifestObject[]>();
  candidates.forEach((object) => {
    const instanceKey = object.identity?.instanceKey;
    if (!instanceKey) return;
    const owners = byIdentity.get(instanceKey) ?? [];
    owners.push(object);
    byIdentity.set(instanceKey, owners);
  });

  const ambiguousKeys = new Set<string>();
  const ambiguous: ShadowTargetIssue[] = [];
  byIdentity.forEach((owners, instanceKey) => {
    if (owners.length < 2) return;
    ambiguousKeys.add(instanceKey);
    ambiguous.push({
      reason: 'ambiguous_identity',
      detail: `${instanceKey} resolves to multiple objects.`,
      candidates: owners.map(object => object.id),
    });
  });

  return {
    candidates: candidates.filter(object => (
      !object.identity?.instanceKey || !ambiguousKeys.has(object.identity.instanceKey)
    )),
    ambiguous,
  };
}

function resolveEditingTargets(
  manifest: Manifest,
  intent: EditingIntent,
  requirePropertyCapabilities: boolean,
): ShadowTargetResolution {
  const requestedObjectIds = intent.scope.objectIds ?? [];
  let prop = intent.operation.prop;
  const role = intent.scope.targetRole;
  let candidates = preferSeriesContainers(selectCandidates(manifest, intent), role);

  if (
    (role === 'x_tick_label' || role === 'y_tick_label')
    && intent.intent !== 'content.text'
    && intent.scope.selectionMode !== 'explicit_objects'
    && intent.scope.selectionMode !== 'selected_only'
  ) {
    prop = TICK_PROP_MAP[prop] ?? prop;
    candidates = resolveGroupedTickTargets(manifest, role, candidates);
  }

  if (candidates.length === 0) {
    return {
      requestedObjectIds,
      resolved: [],
      skipped: [{ reason: 'not_found', detail: 'No object matched the strict shadow target rules.' }],
      ambiguous: [],
    };
  }

  const identityResult = removeAmbiguousIdentities(candidates);
  const skipped: ShadowTargetIssue[] = [];
  const supported = identityResult.candidates.filter((object) => {
    const capability = capabilityFor(object, prop);
    if (!requirePropertyCapabilities && supportsProp(object, prop)) return true;
    if (requirePropertyCapabilities && capability && capability.replay !== 'unsupported') {
      const requiredScope = requiredCapabilityScope(intent);
      if (capability.scopes.includes(requiredScope)) return true;
      skipped.push({
        objectId: object.id,
        reason: 'unsupported_scope',
        detail: `${object.id} does not allow ${prop} in ${requiredScope} scope.`,
      });
      return false;
    }
    skipped.push({
      objectId: object.id,
      reason: 'unsupported_prop',
      detail: `${object.id} does not support ${prop}.`,
    });
    return false;
  });

  const fanout = supported.length > 1
    || intent.scope.selectionMode === 'role_in_figure'
    || intent.scope.selectionMode === 'role_in_subplot';
  const requested = new Set(requestedObjectIds);
  const resolved = supported.map((object): ShadowResolvedTarget => ({
    objectId: object.id,
    instanceKey: object.identity?.instanceKey,
    prop,
    patchMode: patchMode(manifest, object, prop),
    match: requested.has(object.id) ? 'exact' : fanout ? 'fanout' : 'semantic',
  }));

  return {
    requestedObjectIds,
    resolved,
    skipped,
    ambiguous: identityResult.ambiguous,
  };
}

export function resolveEditingTargetsShadow(
  manifest: Manifest,
  intent: EditingIntent,
): ShadowTargetResolution {
  return resolveEditingTargets(manifest, intent, false);
}

function strictProtocolTargets(manifest: Manifest, intent: EditingIntent): ManifestObject[] {
  const role = intent.scope.targetRole;
  const initial = preferSeriesContainers(selectCandidatesBeforeSubplot(manifest, intent), role);
  if (
    (role === 'x_tick_label' || role === 'y_tick_label')
    && intent.intent !== 'content.text'
    && intent.scope.selectionMode !== 'explicit_objects'
    && intent.scope.selectionMode !== 'selected_only'
  ) {
    const grouped = resolveGroupedTickTargets(manifest, role, initial);
    if (grouped.length > 0) {
      return Array.from(new Map(
        [...initial, ...grouped].map(object => [object.id, object]),
      ).values());
    }
  }
  return initial;
}

export function getStrictProtocolReadiness(
  manifest: Manifest,
  intent: EditingIntent,
): StrictProtocolReadiness {
  const candidates = strictProtocolTargets(manifest, intent);
  const missingIdentityObjectIds = candidates
    .filter(object => !object.identity?.instanceKey)
    .map(object => object.id);
  const missingPropertyCapabilityObjectIds = candidates
    .filter(object => !Array.isArray(object.propertyCapabilities))
    .map(object => object.id);
  return {
    ready: missingIdentityObjectIds.length === 0
      && missingPropertyCapabilityObjectIds.length === 0,
    missingIdentityObjectIds,
    missingPropertyCapabilityObjectIds,
  };
}

function issueToSkippedTarget(
  issue: ShadowTargetIssue,
  role?: SemanticTargetRole,
): EditingIntentSkippedTarget {
  const reason: EditingIntentSkippedTarget['reason'] = issue.reason === 'ambiguous_identity'
    ? 'unsupported_scope'
    : issue.reason;
  return {
    gid: issue.objectId,
    role,
    reason,
    detail: issue.detail,
  };
}

function patchesFromResolution(
  resolution: ShadowTargetResolution,
  intent: EditingIntent,
): PatchEntry[] {
  const patches = new Map<string, PatchEntry>();
  resolution.resolved.forEach((target) => {
    const key = `${target.objectId}:${target.prop}`;
    patches.set(key, {
      op: 'set',
      mode: target.patchMode,
      gid: target.objectId,
      prop: target.prop,
      value: intent.operation.value,
    });
  });
  return Array.from(patches.values());
}

export function compileEditingIntentStrict(
  manifest: Manifest,
  intent: EditingIntent,
): ControlledTargetCompileResult {
  const readiness = getStrictProtocolReadiness(manifest, intent);
  if (!readiness.ready) {
    const legacy = compileEditingIntent(manifest, intent);
    const fallbackReason: StrictProtocolFallbackReason = readiness.missingIdentityObjectIds.length > 0
      ? 'missing_identity'
      : 'missing_property_capabilities';
    return {
      ...legacy,
      strategy: 'legacy',
      fallbackReason,
      readiness,
      diagnostics: [
        ...legacy.diagnostics,
        {
          level: 'info',
          message: '严格目标协议不完整，本次操作已使用兼容编译器。',
        },
      ],
    };
  }

  const resolution = resolveEditingTargets(manifest, intent, true);
  const patches = patchesFromResolution(resolution, intent);
  const skipped = [
    ...resolution.skipped.map(issue => issueToSkippedTarget(issue, intent.scope.targetRole)),
    ...resolution.ambiguous.map(issue => issueToSkippedTarget(issue, intent.scope.targetRole)),
  ];
  return {
    strategy: 'strict',
    readiness,
    resolution,
    patches,
    skipped,
    diagnostics: [{
      level: skipped.length > 0 ? 'warning' : 'info',
      message: `严格目标解析完成：将修改 ${patches.length} 个对象，跳过 ${skipped.length} 个对象。`,
    }],
  };
}

export function compileEditingIntentWithControlledResolver(
  manifest: Manifest,
  intent: EditingIntent,
  enabled: boolean,
): ControlledTargetCompileResult {
  if (enabled) return compileEditingIntentStrict(manifest, intent);
  const legacy = compileEditingIntent(manifest, intent);
  return {
    ...legacy,
    strategy: 'legacy',
    fallbackReason: 'feature_disabled',
    readiness: getStrictProtocolReadiness(manifest, intent),
  };
}

function sortedPatchKeys(items: Array<{ objectId: string; prop: string }>): string[] {
  return Array.from(new Set(items.map(item => `${item.objectId}:${item.prop}`))).sort();
}

export function compareTargetResolverWithCurrentCompiler(
  manifest: Manifest,
  intent: EditingIntent,
): TargetResolverShadowComparison {
  const current = compileEditingIntent(manifest, intent);
  const resolution = resolveEditingTargetsShadow(manifest, intent);
  const currentPatchKeys = Array.from(new Set(current.patches
    .filter(patch => 'gid' in patch)
    .map(patch => 'gid' in patch ? `${patch.gid}:${patch.prop}` : '')))
    .filter(Boolean)
    .sort();
  const shadowPatchKeys = sortedPatchKeys(resolution.resolved);
  const currentSet = new Set(currentPatchKeys);
  const shadowSet = new Set(shadowPatchKeys);
  const matchingPatchKeys = currentPatchKeys.filter(key => shadowSet.has(key));
  const currentOnlyPatchKeys = currentPatchKeys.filter(key => !shadowSet.has(key));
  const shadowOnlyPatchKeys = shadowPatchKeys.filter(key => !currentSet.has(key));

  return {
    currentPatchKeys,
    shadowPatchKeys,
    matchingPatchKeys,
    currentOnlyPatchKeys,
    shadowOnlyPatchKeys,
    equivalent: currentOnlyPatchKeys.length === 0 && shadowOnlyPatchKeys.length === 0,
    resolution,
  };
}
