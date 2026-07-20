import type { Manifest, ManifestObject, PatchEntry } from '../schemas/manifest';
import type {
  EditingIntent,
  EditingIntentCompileResult,
  EditingIntentSkippedTarget,
  SemanticTargetRole,
} from '../schemas/editingIntent';
import {
  isPythonStructuralSeriesProp,
  resolvePatchMode,
  supportsObjectProp,
} from './propertyPatchMode';
import { requiresSpecialAxesRelationIdentity } from './specialAxesIdentity';

const TICK_PROP_MAP: Record<string, string> = {
  fontsize: 'tick_labelsize',
  fontfamily: 'tick_labelfamily',
  color: 'tick_labelcolor',
  fontweight: 'tick_fontweight',
  fontstyle: 'tick_fontstyle',
  rotation: 'tick_rotation',
};

function unsupportedProps(object: ManifestObject): string[] {
  const unsupported = object.currentProps?.unsupportedProps;
  return Array.isArray(unsupported) ? unsupported.map(String) : [];
}

function inferRole(object: ManifestObject): SemanticTargetRole {
  if (object.id.startsWith('title.') || object.id.startsWith('suptitle.')) return 'title';
  if (object.id.startsWith('xlabel.') || object.id.startsWith('supxlabel.')) return 'x_axis_label';
  if (object.id.startsWith('ylabel.') || object.id.startsWith('supylabel.')) return 'y_axis_label';
  if (object.id.startsWith('zlabel.')) return 'z_axis_label';
  if (object.id.startsWith('xtick.') || object.kind === 'axis_x') return 'x_tick_label';
  if (object.id.startsWith('ytick.') || object.kind === 'axis_y') return 'y_tick_label';
  if (object.id.startsWith('ztick.') || object.kind === 'axis_z') return 'z_tick_label';
  if (object.role === 'legend_title' || object.id.startsWith('legend_title.')) return 'legend_title';
  if (object.role === 'legend_marker' && object.identity?.relation?.pieSliceId) return 'pie_legend_marker';
  if (object.role === 'legend_marker' || /^legend_(?:line|patch|collection|marker)\./.test(object.id)) return 'legend_marker';
  if (object.id.startsWith('legend_text.')) return 'legend_text';
  if (object.kind === 'legend') return 'legend_container';
  if (object.role === 'colorbar_label' || object.id.startsWith('colorbar_label.')) return 'colorbar_label';
  if (object.role === 'colorbar_tick_label' || object.id.startsWith('colorbar_tick.')) return 'colorbar_tick_label';
  if (object.role === 'histogram_series') return 'data_histogram';
  if (object.role === 'stairs_series') return 'data_stairs';
  if (object.role === 'step_series') return 'data_step';
  if (object.role === 'pie_slice') return 'data_pie_slice';
  if (object.role === 'wedge_slice') return 'data_wedge_slice';
  if (object.role === 'pie_label') return 'pie_label';
  if (object.role === 'pie_value_label') return 'pie_value_label';
  if (object.role === 'quiver_field' || object.kind === 'quiver') return 'data_quiver';
  if (object.role === 'streamplot_field' || object.kind === 'streamplot') return 'data_streamplot';
  if (object.role === 'diagram_node') return 'diagram_node';
  if (object.role === 'diagram_edge') return 'diagram_edge';
  if (object.role === 'diagram_arrow') return 'diagram_arrow';
  if (object.role === 'diagram_node_label') return 'diagram_node_label';
  if (object.role === 'diagram_coefficient_label') return 'diagram_coefficient_label';
  if (object.role === 'diagram_fit_annotation') return 'diagram_fit_annotation';
  if (object.role === 'diagram_group') return 'diagram_group';
  if (object.role === 'bar_series' || object.kind === 'bar_container') return 'data_bar';
  if (object.role === 'errorbar_series' || object.kind === 'errorbar_container') return 'data_errorbar';
  if (object.role === 'stem_series' || object.kind === 'stem_container') return 'data_stem';
  if (object.role === 'boxplot_group' || object.kind === 'boxplot_container') return 'data_boxplot';
  if (object.role === 'violin_group' || object.kind === 'violinplot_container') return 'data_violin';
  if (object.role === 'contour_series' || object.kind === 'contour') return 'data_contour';
  if (object.role === 'contourf_series' || object.kind === 'contourf') return 'data_contourf';
  if (object.kind === 'subplot') return 'subplot_axes_box';
  if (object.kind === 'spine') return 'axis_spine';
  if (object.kind === 'spine_group') return 'axis_frame';
  if (object.role === 'tick_line' || object.id.startsWith('tick_line.')) return 'tick_line';
  if (object.role === 'annotation_text' || object.role === 'ggplot_text_annotation') return 'annotation_text';
  if (object.role === 'annotation_arrow') return 'annotation_arrow';
  if (object.kind === 'grid') return 'grid';
  if (object.kind === 'line') return 'data_line';
  if (object.kind === 'fill_between' || object.role === 'fill_between_series') return 'data_band';
  if (
    object.role === 'contour_child_collection'
    || object.role === 'streamplot_child_line'
    || object.role === 'streamplot_child_arrow'
  ) return 'component';
  if (object.kind === 'collection') return 'data_point';
  if (object.kind === 'patch' || object.kind.endsWith('_container')) return 'data_patch';
  if (object.kind === 'heatmap') return 'heatmap';
  if (object.kind === 'colorbar') return 'colorbar';
  return 'component';
}

function objectSubplotId(object: ManifestObject): string | undefined {
  const relation = object.identity?.relation;
  if (relation?.subplotIds?.length === 1) return relation.subplotIds[0];
  if ((relation?.subplotIds?.length ?? 0) > 1) return undefined;
  if (relation?.subplotId) return relation.subplotId;
  if (object.subplotId) return object.subplotId;
  if (requiresSpecialAxesRelationIdentity(object) || object.identity) return undefined;
  const suffix = object.id.match(/\.(\d+)(?:\.\d+)?$/)?.[1];
  return suffix !== undefined ? `subplot.${suffix}` : undefined;
}

function supportsProp(object: ManifestObject, prop: string): boolean {
  if (unsupportedProps(object).includes(prop)) return false;
  return supportsObjectProp(object, prop);
}

function skip(
  object: ManifestObject | undefined,
  reason: EditingIntentSkippedTarget['reason'],
  detail: string,
  role?: SemanticTargetRole,
): EditingIntentSkippedTarget {
  return {
    gid: object?.id,
    role,
    reason,
    detail,
  };
}

function uniqueByGidAndProp(patches: PatchEntry[]): PatchEntry[] {
  const seen = new Set<string>();
  const result: PatchEntry[] = [];
  for (const patch of patches) {
    if (!('gid' in patch) || !('prop' in patch)) {
      result.push(patch);
      continue;
    }
    const key = `${patch.gid}:${patch.prop}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(patch);
  }
  return result;
}

export function isStyleIntent(intentName: EditingIntent['intent']): boolean {
  return intentName.startsWith('style.') || intentName === 'visibility.component';
}

export function isContentIntent(intentName: EditingIntent['intent']): boolean {
  return intentName.startsWith('content.');
}

export function isPositionIntent(intentName: EditingIntent['intent']): boolean {
  return intentName.startsWith('layout.position.');
}

export function isExplicitlyDeniedCrossFigure(intent: EditingIntent): boolean {
  return intent.scope.crossFigure === 'deny';
}

export function isLayoutIntent(intentName: EditingIntent['intent']): boolean {
  return intentName.startsWith('layout.') && !isPositionIntent(intentName);
}

function resolveTickAxisObjects(
  manifest: Manifest,
  role: 'x_tick_label' | 'y_tick_label' | 'z_tick_label',
  candidates: ManifestObject[],
): ManifestObject[] {
  const axisContract = role === 'x_tick_label'
    ? { prefix: 'axis.x.', kind: 'axis_x' as const }
    : role === 'y_tick_label'
      ? { prefix: 'axis.y.', kind: 'axis_y' as const }
      : { prefix: 'axis.z.', kind: 'axis_z' as const };
  const indexes = new Set<string>();

  candidates.forEach((object) => {
    if (object.kind === axisContract.kind) {
      const index = object.id.match(/\.(\d+)$/)?.[1];
      if (index !== undefined) indexes.add(index);
      return;
    }
    const index = object.id.match(/\.(\d+)(?:\.\d+)?$/)?.[1];
    if (index !== undefined) indexes.add(index);
  });

  return Array.from(indexes)
    .map(index => manifest.objects.find(object => object.id === `${axisContract.prefix}${index}`))
    .filter((object): object is ManifestObject => Boolean(object));
}

function selectCandidates(manifest: Manifest, intent: EditingIntent): ManifestObject[] {
  const scope = intent.scope;
  let candidates = manifest.objects ?? [];

  if (scope.objectIds && scope.objectIds.length > 0) {
    const objectIds = new Set(scope.objectIds);
    candidates = candidates.filter(object => objectIds.has(object.id));
  }

  if (scope.targetKinds && scope.targetKinds.length > 0) {
    const kinds = new Set(scope.targetKinds);
    candidates = candidates.filter(object => kinds.has(object.kind));
  }

  if (scope.targetRole) {
    candidates = candidates.filter(object => {
      const role = inferRole(object);
      return role === scope.targetRole || (scope.targetRole === 'axis_frame' && role === 'axis_spine');
    });
  }

  if (scope.subplotIds && scope.subplotIds !== '*') {
    const subplotIds = new Set(scope.subplotIds);
    candidates = candidates.filter(object => {
      const subplotId = objectSubplotId(object);
      return subplotId ? subplotIds.has(subplotId) : false;
    });
  }

  return candidates;
}

export function compileEditingIntent(manifest: Manifest, intent: EditingIntent): EditingIntentCompileResult {
  const role = intent.scope.targetRole;
  const requestedProp = intent.operation.prop;
  const value = intent.operation.value;
  const selected = selectCandidates(manifest, intent);
  const skipped: EditingIntentSkippedTarget[] = [];
  const patches: PatchEntry[] = [];

  if (selected.length === 0) {
    return {
      patches: [],
      skipped: [skip(undefined, 'not_found', `No objects matched ${role || intent.intent}.`, role)],
      diagnostics: [{ level: 'warning', message: '没有找到匹配当前编辑意图的对象。' }],
    };
  }

  let targets = selected;
  let prop = requestedProp;

  if (
    (role === 'x_tick_label' || role === 'y_tick_label' || role === 'z_tick_label')
    && intent.intent !== 'content.text'
    && intent.scope.selectionMode !== 'explicit_objects'
    && intent.scope.selectionMode !== 'selected_only'
  ) {
    prop = TICK_PROP_MAP[requestedProp] || requestedProp;
    const axisTargets = resolveTickAxisObjects(manifest, role, selected);
    if (axisTargets.length > 0) {
      targets = axisTargets;
    } else {
      selected.forEach(object => skipped.push(skip(
        object,
        'unsupported_scope',
        'Tick-label group editing requires the virtual axis object.',
        role,
      )));
      targets = [];
    }
  }

  targets.forEach((object) => {
    if (!supportsProp(object, prop)) {
      skipped.push(skip(object, 'unsupported_prop', `${object.id} does not support ${prop}.`, role));
      return;
    }
    patches.push({
      op: 'set',
      mode: resolvePatchMode(manifest, object, prop),
      gid: object.id,
      prop,
      value,
    });
  });

  const uniquePatches = uniqueByGidAndProp(patches);
  const diagnostics = [
    {
      level: skipped.length > 0 ? 'warning' as const : 'info' as const,
      message: `编辑意图编译完成：将修改 ${uniquePatches.length} 个对象，跳过 ${skipped.length} 个对象。`,
    },
  ];

  return { patches: uniquePatches, skipped, diagnostics };
}

export function inferEditingTargetRole(object: ManifestObject): SemanticTargetRole {
  return inferRole(object);
}

export function retargetEditingIntentForFigure(intent: EditingIntent): EditingIntent {
  const deniedByDefault = isContentIntent(intent.intent)
    || isPositionIntent(intent.intent)
    || isLayoutIntent(intent.intent);
  const explicitSelection = intent.scope.selectionMode === 'explicit_objects'
    || intent.scope.selectionMode === 'selected_only';

  if (
    intent.scope.crossFigure === 'deny'
    || (deniedByDefault && intent.scope.crossFigure !== 'allow')
    || (explicitSelection && intent.scope.crossFigure !== 'allow')
  ) {
    return {
      ...intent,
      scope: {
        ...intent.scope,
        objectIds: ['__scifig_cross_figure_denied__'],
        targetRole: undefined,
        targetKinds: undefined,
        selectionMode: 'explicit_objects',
      },
    };
  }

  if (!intent.scope.targetRole && !intent.scope.targetKinds?.length) {
    return {
      ...intent,
      scope: {
        ...intent.scope,
        objectIds: ['__scifig_no_cross_figure_semantic_target__'],
        selectionMode: 'explicit_objects',
      },
    };
  }

  return {
    ...intent,
    scope: {
      ...intent.scope,
      objectIds: undefined,
      selectionMode: (intent.scope.targetRole || intent.scope.targetKinds?.length)
        ? 'role_in_figure'
        : intent.scope.selectionMode,
      // Do not pin an exact source-object selection to a same-named subplot in
      // a different figure. The target manifest should resolve its own scope.
      subplotIds: intent.scope.selectionMode === 'explicit_objects' || intent.scope.selectionMode === 'selected_only'
        ? '*'
        : intent.scope.subplotIds,
    },
  };
}
