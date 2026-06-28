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
  | "patch"
  | "figure"
  | "axes"
  | "grid"
  | "axis_x"
  | "axis_y"
  | "bar_container"
  | "errorbar_container"
  | "stem_container"
  | "boxplot_container"
  | "violinplot_container"
  | "container";

export interface ManifestObject {
  id: string;
  kind: ManifestObjectKind;
  label: string;
  editable: string[];
  currentProps: Record<string, unknown>;
  role?: string;
  parentId?: string;
  children?: string[];
  stableKey?: string;
  fingerprint?: string;
  source?: {
    artistClass: string;
    axesIndex: number;
    zorder?: number;
  };
}

/* Coverage report — transparency about what the introspector missed */
export interface CoverageSummary {
  recognized: number;
  editable: number;
  readonly: number;
  unsupported: number;
}

export interface CoverageKindDetail {
  count: number;
  editableProps: string[];
}

export interface UnsupportedArtistDetail {
  class: string;
  count: number;
  reason: string;
}

export interface CoverageReport {
  summary: CoverageSummary;
  byKind: Record<string, CoverageKindDetail>;
  unsupportedArtists: UnsupportedArtistDetail[];
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
}

export interface Binding {
  paletteId: string;
  groupId: string;
  gids: string[];
  props: string[];
}

export interface SemanticGroup {
  groupId: string;
  label: string;
  paletteId: string;
  kind: "bar" | "line" | "scatter";
}

export interface Manifest {
  generatedBy: "introspection";
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
  mode: EditMode;
  timestamp: number;
}

export interface HistorySnapshot {
  editLog: EditEntry[];
  label: string;
  timestamp: number;
}

export interface ProjectHistoryState {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

/* ---- Figure Session ---- */

export interface FigureSession {
  sessionId: string;
  script: string;
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
  dataRef?: string;
  dataPayload?: Record<string, unknown>;
  editLog: EditEntry[];
  renderOptions?: {
    dpi?: number;
    format?: "svg" | "png" | "pdf";
  };
}

export interface RenderResponse {
  status: "success" | "error";
  sessionId: string;
  svg: string;
  manifest: Manifest;
  revision: number;
  editLog?: EditEntry[];
  coverageReport?: CoverageReport;
  timingMs: number;
  message?: string;
  traceback?: string;
}

export interface LocalPatchEntry {
  op: "set";
  mode: EditMode;
  gid: string;
  prop: string;
  value: unknown;
}

export interface CodePatchEntry {
  type: "code_patch";
  target_id: string;
  new_value: unknown;
  gids: string[];
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
