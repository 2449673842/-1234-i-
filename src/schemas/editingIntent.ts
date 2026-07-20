import type { ManifestObjectKind, PatchEntry } from './manifest';

export type EditingIntentName =
  | 'content.text'
  | 'style.text.axis_label'
  | 'style.text.tick_label'
  | 'style.text.legend'
  | 'style.text.title'
  | 'style.component'
  | 'layout.subplot.axes_box'
  | 'layout.colorbar'
  | 'layout.position.text'
  | 'layout.position.legend'
  | 'visibility.component';

export type EditingSelectionMode =
  | 'explicit_objects'
  | 'selected_only'
  | 'role_in_subplot'
  | 'role_in_figure';

export type EditingFallbackMode =
  | 'skip_with_warning'
  | 'degrade_gracefully'
  | 'fail';

export type SemanticTargetRole =
  | 'title'
  | 'x_axis_label'
  | 'y_axis_label'
  | 'z_axis_label'
  | 'x_tick_label'
  | 'y_tick_label'
  | 'z_tick_label'
  | 'legend_text'
  | 'legend_title'
  | 'legend_marker'
  | 'pie_legend_marker'
  | 'legend_container'
  | 'colorbar_label'
  | 'colorbar_tick_label'
  | 'subplot_axes_box'
  | 'axis_frame'
  | 'axis_spine'
  | 'tick_line'
  | 'grid'
  | 'data_line'
  | 'data_point'
  | 'data_quiver'
  | 'data_streamplot'
  | 'diagram_node'
  | 'diagram_edge'
  | 'diagram_arrow'
  | 'diagram_node_label'
  | 'diagram_coefficient_label'
  | 'diagram_fit_annotation'
  | 'diagram_group'
  | 'data_contour'
  | 'data_contourf'
  | 'data_band'
  | 'data_patch'
  | 'data_bar'
  | 'data_histogram'
  | 'data_stairs'
  | 'data_step'
  | 'data_pie_slice'
  | 'data_wedge_slice'
  | 'data_errorbar'
  | 'data_stem'
  | 'data_boxplot'
  | 'data_violin'
  | 'heatmap'
  | 'colorbar'
  | 'annotation_text'
  | 'annotation_arrow'
  | 'pie_label'
  | 'pie_value_label'
  | 'component';

export interface EditingIntentScope {
  figureIds?: string[];
  subplotIds?: string[] | '*';
  objectIds?: string[];
  targetRole?: SemanticTargetRole;
  targetKinds?: ManifestObjectKind[];
  selectionMode: EditingSelectionMode;
  crossFigure?: 'allow' | 'deny';
}

export interface EditingIntentOperation {
  prop: string;
  value: unknown;
}

export interface EditingIntentCommit {
  mode: 'draft' | 'immediate';
  applyAsOneHistoryStep?: boolean;
}

export interface EditingIntentFallback {
  onUnsupported: EditingFallbackMode;
}

export interface EditingIntent {
  intent: EditingIntentName;
  scope: EditingIntentScope;
  operation: EditingIntentOperation;
  commit?: EditingIntentCommit;
  fallback?: EditingIntentFallback;
}

export interface EditingIntentSkippedTarget {
  gid?: string;
  role?: SemanticTargetRole;
  reason: 'not_found' | 'unsupported_prop' | 'unsupported_scope' | 'unsupported_engine';
  detail: string;
}

export interface EditingIntentDiagnostic {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface EditingIntentCompileResult {
  patches: PatchEntry[];
  skipped: EditingIntentSkippedTarget[];
  diagnostics: EditingIntentDiagnostic[];
}

export interface EditingIntentApplyTargetReport {
  figureId: string;
  appliedCount: number;
  skippedCount: number;
  skipped: EditingIntentSkippedTarget[];
}

export interface EditingIntentApplyReport {
  id: string;
  sourceFigureId: string;
  scope: 'current' | 'all' | 'selected';
  createdAt: number;
  targetReports: EditingIntentApplyTargetReport[];
}
