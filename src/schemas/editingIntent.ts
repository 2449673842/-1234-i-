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
  | 'x_tick_label'
  | 'y_tick_label'
  | 'legend_text'
  | 'legend_container'
  | 'subplot_axes_box'
  | 'axis_frame'
  | 'grid'
  | 'data_line'
  | 'data_point'
  | 'data_patch'
  | 'heatmap'
  | 'colorbar'
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
