import type { EditingIntent } from './editingIntent';

/* ============================================================
 * IFC v2 Manifest + EditLog Protocol
 * Single source of truth for interactive figure editing.
 * ============================================================ */

/** Primitive field descriptor (intended for generic control rendering) */
export interface ManifestNumberField {
  type: "number";
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface ManifestTextField {
  type: "string";
  value: string;
}

export interface ManifestBoolField {
  type: "boolean";
  value: boolean;
}

export interface ManifestColorField {
  type: "color";
  value: string; // hex or rgba
}

export interface ManifestSelectField {
  type: "select";
  value: string;
  options: string[];
}

export type ManifestField =
  | ManifestNumberField
  | ManifestTextField
  | ManifestBoolField
  | ManifestColorField
  | ManifestSelectField;

/* ---- Object kinds recognised by the introspector ---- */

export type ManifestObjectKind =
  | "text"
  | "spine"
  | "spine_group"
  | "legend"
  | "line"
  | "collection"
  | "quiver"
  | "streamplot"
  | "contour"
  | "contourf"
  | "fill_between"
  | "patch"
  | "figure"
  | "subplot"
  | "polar_subplot"
  | "three_d_subplot"
  | "inset_subplot"
  | "geo_subplot"
  | "parasite_subplot"
  | "parasite_axis"
  | "secondary_xaxis"
  | "secondary_yaxis"
  | "unsupported_axes"
  | "brokenaxes_group"
  | "axes"
  | "grid"
  | "axis_x"
  | "axis_y"
  | "axis_z"
  | "xtick"
  | "ytick"
  | "bar_container"
  | "errorbar_container"
  | "stem_container"
  | "boxplot_container"
  | "violinplot_container"
  | "container"
  | "unsupported"
  | "heatmap"
  | "colorbar";

export type ManifestCoordinateSpace =
  | "data"
  | "axes"
  | "figure"
  | "display"
  | "container"
  | "none";

export type ManifestEditScope =
  | "object"
  | "group"
  | "subplot"
  | "figure"
  | "cross_figure";

export interface ManifestObjectRelation {
  parentId?: string;
  subplotId?: string;
  subplotIds?: string[];
  layerId?: string;
  layerIds?: string[];
  groupIds?: string[];
  scaleId?: string;
  guideId?: string;
  aesthetic?: string;
  groupKey?: string;
  dataKey?: string;
  legendId?: string;
  legendTitleId?: string;
  legendTextId?: string;
  legendTextIds?: string[];
  legendMarkerIds?: string[];
  colorbarId?: string;
  mappableId?: string;
  mappableIds?: string[];
  annotationId?: string;
  arrowId?: string;
  textId?: string;
  twinSubplotIds?: string[];
  sharedXSubplotIds?: string[];
  sharedYSubplotIds?: string[];
  axesFamily?: string;
  projection?: string;
  parentSubplotId?: string;
  ownerSubplotId?: string;
  pieId?: string;
  pieSliceId?: string;
  pieLabelId?: string;
  pieValueLabelId?: string;
  sliceIndex?: number;
  quiverId?: string;
  streamplotId?: string;
  lineCollectionId?: string;
  arrowPatchIds?: string[];
  diagramId?: string;
  diagramType?: string;
  diagramObjectId?: string;
  nodeId?: string;
  edgeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
}

/**
 * Additive v1.1 identity metadata. Existing gid/stableKey fields remain the
 * compatibility path until the shadow identity checks pass on real projects.
 */
export interface ManifestObjectIdentity {
  semanticKey?: string;
  instanceKey?: string;
  seriesKey?: string;
  scope?: "figure" | "subplot" | "container";
  coordinateSpace?: ManifestCoordinateSpace;
  relation?: ManifestObjectRelation;
}

export interface ManifestPropertyCapability {
  prop: string;
  patchMode: EditMode;
  scopes: ManifestEditScope[];
  preview: "exact" | "approximate" | "none";
  replay: "stable" | "conditional" | "unsupported";
  coordinateSpace?: ManifestCoordinateSpace;
  derivedEffects?: string[];
  unsupportedReason?: string;
}

export type SemanticCoverageStatus = "dedicated" | "flattened" | "ambiguous";

export interface ManifestSemanticCoverage {
  family: string;
  status: SemanticCoverageStatus;
  attribution: string;
  preservedKind: ManifestObjectKind;
  preservedRole?: string;
  preservedEditable: string[];
  reason: string;
}

export interface ManifestObject {
  id: string;
  kind: ManifestObjectKind;
  label: string;
  editable: string[];
  currentProps: Record<string, unknown>;
  role?: string;
  subplotId?: string;
  subplotIds?: string[];
  parentId?: string;
  children?: string[];
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObjectIdentity;
  propertyCapabilities?: ManifestPropertyCapability[];
  semanticCoverage?: ManifestSemanticCoverage;
  source?: {
    artistClass: string;
    axesIndex: number;
    callName?: string;
    ownerAxesIndex?: number;
    ownerAxesIndices?: number[];
    zorder?: number;
  };
}

/* Coverage report — transparency about what the introspector missed */
export interface CoverageSummary {
  recognized: number;
  editable: number;
  readonly: number;
  unsupported: number;
  dedicated?: number;
  flattened?: number;
  ambiguous?: number;
}

export interface CoverageKindDetail {
  count: number;
  editableProps: string[];
  editablePropsIntersection?: string[];
  editablePropVariants?: Array<{
    editableProps: string[];
    count: number;
  }>;
}

export interface UnsupportedArtistDetail {
  class: string;
  count: number;
  reason: string;
}

export interface ComplexArtistCoverageDetail {
  id: string;
  class: string;
  family: string;
  status: SemanticCoverageStatus;
  attribution: string;
  preservedKind: ManifestObjectKind;
  preservedRole?: string;
  preservedEditable: string[];
  reason: string;
}

export interface CoverageReport {
  summary: CoverageSummary;
  byKind: Record<string, CoverageKindDetail>;
  unsupportedArtists: UnsupportedArtistDetail[];
  complexArtists?: ComplexArtistCoverageDetail[];
}

/* ---- Manifest top-level ---- */

export interface ColorGroup {
  color: string;
  label: string;
  gids: string[];
  count: number;
}

export interface Palette {
  id: string;
  label: string;
  color: string;
  source: "constant" | "dict" | "inline" | string;
  line: number;
  usageCount?: number;
}

export interface Binding {
  paletteId: string;
  groupId: string;
  gids: string[];
  props: string[];
  groupIds?: string[];
  targetMode?: "exact" | "semantic" | "conditional" | "ambiguous" | "unresolved";
  targets?: BindingTarget[];
  warnings?: string[];
}

export interface BindingTarget {
  gid: string;
  prop: string;
  instanceKey?: string;
  seriesKey?: string;
  match: "label_and_color" | "exact_label" | "unique_color" | "scale_key";
  confidence: "exact" | "high" | "conditional";
  replayMode?: "object_patch" | "code_only";
}

export interface SemanticGroup {
  groupId: string;
  label: string;
  paletteId: string;
  kind: "bar" | "line" | "scatter" | "contour" | "contourf";
  aesthetic?: string;
  scaleId?: string;
  layerIds?: string[];
  subplotIds?: string[];
}

export interface Manifest {
  generatedBy: "introspection" | "r_svg";
  globals: Record<string, ManifestField>;
  objects: ManifestObject[];
  colorGroups?: ColorGroup[];
  palettes?: Palette[];
  groups?: SemanticGroup[];
  bindings?: Binding[];
  capabilities: {
    localPatch: boolean;
    backendPatch: boolean;
    codePatch: boolean;
  };
  coverageReport?: CoverageReport;
  unsupportedNotes?: string[];
}

/* ---- Edit Log ---- */

export type EditMode = "local_patch" | "backend_patch";

export interface EditEntry {
  gid: string;
  prop: string;
  value: unknown;
  matchColor?: string;
  mode: EditMode;
  timestamp: number;
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObjectIdentity;
}

export interface HistorySnapshot {
  editLog: EditEntry[];
  script?: string;
  label: string;
  timestamp: number;
  changeType?: "figure" | "code" | "mixed" | "system";
  codeSummary?: {
    previousLines: number;
    nextLines: number;
    addedLines: number;
    removedLines: number;
  };
}

export interface ProjectHistoryState {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

/* ---- Figure Session ---- */

export interface FigureSession {
  sessionId: string;
  script: string;
  language?: "python" | "r";
  dataPayload: Record<string, unknown> | null;
  editLog: EditEntry[];
  revision: number;
  manifest: Manifest | null;
  svg: string;
  createdAt: number;
  updatedAt: number;
}

/* ---- API Request / Response ---- */

export interface RenderRequest {
  script: string;
  language?: "python" | "r";
  dataRef?: string;
  dataPayload?: Record<string, unknown>;
  editLog: EditEntry[];
  renderOptions?: {
    dpi?: number;
    format?: "svg" | "png" | "pdf";
  };
}

export interface RendererPerformanceV1 {
  staticScanMs?: number;
  scriptExecutionMs?: number;
  dynamicScanMs?: number;
  figureDiscoveryMs?: number;
  editApplyMs?: number;
  introspectionMs?: number;
  svgSerializeMs?: number;
  binaryExportMs?: number;
  manifestBuildMs?: number;
  svgPostprocessMs?: number;
  totalMs: number;
}

export interface RuntimePerformanceV1 {
  mode: "local" | "docker";
  queueMs?: number;
  payloadStageMs?: number;
  processMs?: number;
  outputParseMs?: number;
  totalMs: number;
}

export interface ServerPerformanceV1 {
  cacheLookupMs?: number;
  persistMs?: number;
  cacheWriteMs?: number;
  totalMs: number;
}

export interface RenderPerformanceV1 {
  schemaVersion: "1.0";
  cacheHit: boolean;
  renderer: RendererPerformanceV1 | null;
  runtime: RuntimePerformanceV1 | null;
  server: ServerPerformanceV1;
}

export interface RenderCacheStatus {
  hit: boolean;
  key: string;
}

export interface RenderResponse {
  status: "success" | "error";
  sessionId: string;
  language?: "python" | "r";
  svg: string;
  manifest: Manifest;
  revision: number;
  editLog?: EditEntry[];
  coverageReport?: CoverageReport;
  timingMs: number;
  performance?: RenderPerformanceV1;
  cache?: RenderCacheStatus;
  message?: string;
  traceback?: string;
}

export interface LocalPatchEntry {
  op: "set";
  mode: EditMode;
  gid: string;
  prop: string;
  value: unknown;
  matchColor?: string;
  intent?: EditingIntent;
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObjectIdentity;
}

export interface CodePatchEntry {
  type: "code_patch";
  target_id: string;
  new_value: unknown;
  gids: string[];
  intent?: EditingIntent;
}

export type PatchEntry = LocalPatchEntry | CodePatchEntry;

export interface PatchResponse {
  status: "success" | "error" | "conflict";
  sessionId: string;
  applied: PatchEntry[];
  svg?: string;
  manifest?: Manifest;
  revision?: number;
  editLog?: EditEntry[];
  message?: string;
  script?: string;
  requestId?: string;
  rejected?: PatchEntry[];
  warnings?: unknown[];
  performance?: RenderPerformanceV1;
  cache?: RenderCacheStatus;
}

export interface CodePatchRequest {
  sessionId: string;
  patchedScript: string;
}

export interface CodePatchResponse {
  status: "success" | "error" | "drift_warning";
  svg?: string;
  manifest?: Manifest;
  revision?: number;
  sessionId?: string;
  editLog?: EditEntry[];
  message?: string;
  orphanedGids?: string[];
  traceback?: string;
  errors?: string[];
  performance?: RenderPerformanceV1;
  cache?: RenderCacheStatus;
}

/* ---- Export ---- */

export interface ExportRequest {
  sessionId: string;
  format: "svg" | "png" | "pdf";
  dpi?: number;
}

export interface ExportBundle {
  script: string;
  editLog: EditEntry[];
  dataSnapshot: Record<string, unknown> | null;
  dataFingerprint: string;
  metadata: {
    generatedAt: string;
    revision: number;
    appVersion: string;
    exportFormat: string;
    dpi: number;
    environment: string;
  };
}
