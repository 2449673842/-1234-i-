import type { EditingCenterId, ProjectedPropertyState } from '../schemas/propertyDescriptor';
import type { ManifestCoordinateSpace, ManifestEditScope, ManifestObjectKind } from '../schemas/manifest';
import type { EditingIntentName, EditingSelectionMode, SemanticTargetRole } from '../schemas/editingIntent';

export type LegacyRetireEventType =
  | 'legacy_descriptor_projection'
  | 'legacy_resolver_path'
  | 'legacy_palette_resolver_path'
  | 'legacy_ui_surface_rendered'
  | 'legacy_position_drag_path';

export type LegacyUiSurface =
  | 'property_legacy_editable'
  | 'component_errorbar_legacy'
  | 'component_specialized_controls'
  | 'font_controls_rollback'
  | 'component_controls_rollback'
  | 'palette_controls_rollback'
  | 'layout_controls_rollback';

export interface LegacyDescriptorPropertySummary {
  key: string;
  state: ProjectedPropertyState;
  editableCount: number;
  readonlyCount: number;
  unsupportedCount: number;
  legacyFallbackCount: number;
}

export interface LegacyDescriptorProjectionEvent {
  eventType: 'legacy_descriptor_projection';
  generatedBy: 'introspection' | 'r_svg';
  center: EditingCenterId;
  scope: ManifestEditScope;
  objectCount: number;
  protocolCompleteCount: number;
  objectKindCounts: Partial<Record<ManifestObjectKind, number>>;
  properties: LegacyDescriptorPropertySummary[];
}

export interface LegacyResolverPathEvent {
  eventType: 'legacy_resolver_path';
  source: 'font-center' | 'component-center' | 'position-drag';
  center: 'fonts' | 'components' | 'layout';
  intent: EditingIntentName;
  prop: string;
  selectionMode: EditingSelectionMode;
  targetRole?: SemanticTargetRole;
  strategy: 'strict' | 'legacy';
  fallbackReason?: 'feature_disabled' | 'missing_identity' | 'missing_property_capabilities';
  patchCount: number;
  skippedCount: number;
  ambiguousCount: number;
  missingIdentityCount: number;
  missingCapabilityCount: number;
}

export interface LegacyPaletteResolverPathEvent {
  eventType: 'legacy_palette_resolver_path';
  strategy: 'strict' | 'legacy';
  fallbackReason?: 'feature_disabled' | 'missing_binding_protocol' | 'missing_object_protocol';
  targetMode: 'exact' | 'semantic' | 'conditional' | 'ambiguous' | 'unresolved' | 'legacy' | 'unbound';
  targetCount: number;
  codeOnlyCount: number;
  skippedCount: number;
  ambiguousCount: number;
}

export interface LegacyUiSurfaceRenderedEvent {
  eventType: 'legacy_ui_surface_rendered';
  surface: LegacyUiSurface;
  center: EditingCenterId;
  controlFamily: 'common' | 'specialized' | 'position';
  renderedControlCount: number;
}

export interface LegacyPositionDragPathEvent {
  eventType: 'legacy_position_drag_path';
  strategy: 'strict' | 'legacy';
  coordinateSpace: ManifestCoordinateSpace;
  objectKind: ManifestObjectKind;
  projectionState: ProjectedPropertyState;
  legacyFallbackCount: number;
}

export type LegacyRetireObservationEvent =
  | LegacyDescriptorProjectionEvent
  | LegacyResolverPathEvent
  | LegacyPaletteResolverPathEvent
  | LegacyUiSurfaceRenderedEvent
  | LegacyPositionDragPathEvent;

const EVENT_TYPES = new Set<LegacyRetireEventType>([
  'legacy_descriptor_projection',
  'legacy_resolver_path',
  'legacy_palette_resolver_path',
  'legacy_ui_surface_rendered',
  'legacy_position_drag_path',
]);
const CENTERS = new Set<EditingCenterId>(['properties', 'layout', 'components', 'palette', 'fonts']);
const SCOPES = new Set<ManifestEditScope>(['object', 'group', 'subplot', 'figure', 'cross_figure']);
const OBJECT_KINDS = new Set<ManifestObjectKind>([
  'text', 'spine', 'spine_group', 'legend', 'line', 'collection', 'patch', 'figure',
  'subplot', 'axes', 'grid', 'axis_x', 'axis_y', 'xtick', 'ytick', 'bar_container',
  'errorbar_container', 'stem_container', 'boxplot_container', 'violinplot_container',
  'container', 'unsupported', 'heatmap', 'colorbar',
]);
const PROPERTY_STATES = new Set<ProjectedPropertyState>(['editable', 'mixed', 'partial', 'readonly', 'unsupported']);
const COORDINATE_SPACES = new Set<ManifestCoordinateSpace>(['data', 'axes', 'figure', 'display', 'container', 'none']);
const SAFE_PROPERTIES = new Set([
  'text', 'fontfamily', 'fontsize', 'fontweight', 'fontstyle', 'color', 'facecolor',
  'edgecolor', 'rotation', 'ha', 'va', 'visible', 'alpha', 'linewidth', 'linestyle',
  'markersize', 'markeredgewidth', 'size', 'left', 'bottom', 'width', 'height', 'aspect',
  'position', 'anchor_position', 'tick_labelsize', 'tick_labelfamily', 'tick_labelcolor',
  'tick_fontweight', 'tick_fontstyle', 'tick_rotation', 'tick_direction', 'tick_length',
  'tick_width', 'tick_color', 'tick_pad', 'tick_label_dx', 'tick_label_dy', 'label',
  'label_fontsize', 'label_color', 'limits', 'markerscale', 'capsize', 'stem_linewidth',
  'stem_color', 'baseline_visible', 'median_color', 'tick_fontsize', 'show_minor_ticks',
]);
const INTENTS = new Set<EditingIntentName>([
  'content.text', 'style.text.axis_label', 'style.text.tick_label', 'style.text.legend',
  'style.text.title', 'style.component', 'layout.subplot.axes_box', 'layout.colorbar',
  'layout.position.text', 'layout.position.legend', 'visibility.component',
]);
const SELECTION_MODES = new Set<EditingSelectionMode>([
  'explicit_objects', 'selected_only', 'role_in_subplot', 'role_in_figure',
]);
const TARGET_ROLES = new Set<SemanticTargetRole>([
  'title', 'x_axis_label', 'y_axis_label', 'x_tick_label', 'y_tick_label', 'legend_text',
  'legend_title', 'legend_marker', 'legend_container', 'colorbar_label', 'colorbar_tick_label',
  'subplot_axes_box', 'axis_frame', 'axis_spine', 'tick_line', 'grid', 'data_line',
  'data_point', 'data_patch', 'data_bar', 'data_errorbar', 'data_stem', 'data_boxplot',
  'data_violin', 'heatmap', 'colorbar', 'annotation_text', 'annotation_arrow', 'component',
]);
const UI_SURFACES = new Set<LegacyUiSurface>([
  'property_legacy_editable', 'component_errorbar_legacy', 'component_specialized_controls',
  'font_controls_rollback', 'component_controls_rollback', 'palette_controls_rollback',
  'layout_controls_rollback',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown, max = 1_000_000): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(max, Math.floor(numeric)));
}

function safeProp(value: unknown): string {
  const prop = String(value ?? '');
  return SAFE_PROPERTIES.has(prop) ? prop : 'other';
}

function safeObjectKindCounts(value: unknown): Partial<Record<ManifestObjectKind, number>> {
  const input = record(value);
  if (!input) return {};
  return Object.fromEntries(Object.entries(input).flatMap(([key, rawCount]) => (
    OBJECT_KINDS.has(key as ManifestObjectKind) ? [[key, count(rawCount)]] : []
  ))) as Partial<Record<ManifestObjectKind, number>>;
}

export function sanitizeLegacyRetireObservationEvent(input: unknown): LegacyRetireObservationEvent | null {
  const source = record(input);
  if (!source || !EVENT_TYPES.has(source.eventType as LegacyRetireEventType)) return null;

  if (source.eventType === 'legacy_descriptor_projection') {
    if ((source.generatedBy !== 'introspection' && source.generatedBy !== 'r_svg')
      || !CENTERS.has(source.center as EditingCenterId)
      || !SCOPES.has(source.scope as ManifestEditScope)) return null;
    const properties = Array.isArray(source.properties) ? source.properties.slice(0, 64).flatMap((item) => {
      const property = record(item);
      if (!property || !PROPERTY_STATES.has(property.state as ProjectedPropertyState)) return [];
      return [{
        key: safeProp(property.key),
        state: property.state as ProjectedPropertyState,
        editableCount: count(property.editableCount),
        readonlyCount: count(property.readonlyCount),
        unsupportedCount: count(property.unsupportedCount),
        legacyFallbackCount: count(property.legacyFallbackCount),
      }];
    }) : [];
    return {
      eventType: source.eventType,
      generatedBy: source.generatedBy,
      center: source.center as EditingCenterId,
      scope: source.scope as ManifestEditScope,
      objectCount: count(source.objectCount),
      protocolCompleteCount: count(source.protocolCompleteCount),
      objectKindCounts: safeObjectKindCounts(source.objectKindCounts),
      properties,
    };
  }

  if (source.eventType === 'legacy_resolver_path') {
    const resolverSources = new Set(['font-center', 'component-center', 'position-drag']);
    const resolverCenters = new Set(['fonts', 'components', 'layout']);
    const strategies = new Set(['strict', 'legacy']);
    const fallbackReasons = new Set(['feature_disabled', 'missing_identity', 'missing_property_capabilities']);
    if (!resolverSources.has(String(source.source))
      || !resolverCenters.has(String(source.center))
      || !INTENTS.has(source.intent as EditingIntentName)
      || !SELECTION_MODES.has(source.selectionMode as EditingSelectionMode)
      || !strategies.has(String(source.strategy))) return null;
    const targetRole = TARGET_ROLES.has(source.targetRole as SemanticTargetRole)
      ? source.targetRole as SemanticTargetRole
      : undefined;
    const fallbackReason = fallbackReasons.has(String(source.fallbackReason))
      ? source.fallbackReason as LegacyResolverPathEvent['fallbackReason']
      : undefined;
    return {
      eventType: source.eventType,
      source: source.source as LegacyResolverPathEvent['source'],
      center: source.center as LegacyResolverPathEvent['center'],
      intent: source.intent as EditingIntentName,
      prop: safeProp(source.prop),
      selectionMode: source.selectionMode as EditingSelectionMode,
      targetRole,
      strategy: source.strategy as 'strict' | 'legacy',
      fallbackReason,
      patchCount: count(source.patchCount),
      skippedCount: count(source.skippedCount),
      ambiguousCount: count(source.ambiguousCount),
      missingIdentityCount: count(source.missingIdentityCount),
      missingCapabilityCount: count(source.missingCapabilityCount),
    };
  }

  if (source.eventType === 'legacy_palette_resolver_path') {
    const strategies = new Set(['strict', 'legacy']);
    const fallbackReasons = new Set(['feature_disabled', 'missing_binding_protocol', 'missing_object_protocol']);
    const targetModes = new Set(['exact', 'semantic', 'conditional', 'ambiguous', 'unresolved', 'legacy', 'unbound']);
    if (!strategies.has(String(source.strategy)) || !targetModes.has(String(source.targetMode))) return null;
    return {
      eventType: source.eventType,
      strategy: source.strategy as 'strict' | 'legacy',
      fallbackReason: fallbackReasons.has(String(source.fallbackReason))
        ? source.fallbackReason as LegacyPaletteResolverPathEvent['fallbackReason']
        : undefined,
      targetMode: source.targetMode as LegacyPaletteResolverPathEvent['targetMode'],
      targetCount: count(source.targetCount),
      codeOnlyCount: count(source.codeOnlyCount),
      skippedCount: count(source.skippedCount),
      ambiguousCount: count(source.ambiguousCount),
    };
  }

  if (source.eventType === 'legacy_ui_surface_rendered') {
    const controlFamilies = new Set(['common', 'specialized', 'position']);
    if (!UI_SURFACES.has(source.surface as LegacyUiSurface)
      || !CENTERS.has(source.center as EditingCenterId)
      || !controlFamilies.has(String(source.controlFamily))) return null;
    return {
      eventType: source.eventType,
      surface: source.surface as LegacyUiSurface,
      center: source.center as EditingCenterId,
      controlFamily: source.controlFamily as LegacyUiSurfaceRenderedEvent['controlFamily'],
      renderedControlCount: count(source.renderedControlCount),
    };
  }

  const strategies = new Set(['strict', 'legacy']);
  if (!strategies.has(String(source.strategy))
    || !COORDINATE_SPACES.has(source.coordinateSpace as ManifestCoordinateSpace)
    || !OBJECT_KINDS.has(source.objectKind as ManifestObjectKind)
    || !PROPERTY_STATES.has(source.projectionState as ProjectedPropertyState)) return null;
  return {
    eventType: 'legacy_position_drag_path',
    strategy: source.strategy as 'strict' | 'legacy',
    coordinateSpace: source.coordinateSpace as ManifestCoordinateSpace,
    objectKind: source.objectKind as ManifestObjectKind,
    projectionState: source.projectionState as ProjectedPropertyState,
    legacyFallbackCount: count(source.legacyFallbackCount),
  };
}

export function sanitizeLegacyRetireObservationBatch(input: unknown, maxEvents = 100): LegacyRetireObservationEvent[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, maxEvents).flatMap(event => {
    const sanitized = sanitizeLegacyRetireObservationEvent(event);
    return sanitized ? [sanitized] : [];
  });
}
