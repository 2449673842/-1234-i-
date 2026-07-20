import type { EditEntry } from './manifest';

export const LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION = 3 as const;

export interface ExportDatasetSnapshotV1 {
  datasetId: string;
  fileName: string;
  rowCount: number;
  columns: string[];
  sizeBytes: number;
  sha256: string;
}

export interface ExportFigureSnapshotV1 {
  figureId: string;
  index: number;
  sessionId: string;
  revision: number;
  editLog: EditEntry[];
}

export interface ExportFigureSnapshotV2 extends ExportFigureSnapshotV1 {
  script: string;
  scriptLanguage: 'python' | 'r';
}

interface ExportEditingSnapshotBase {
  capturedAt: string;
  projectId: string;
  projectName: string;
  targetFigureId: string;
  projectScript: string;
  scriptLanguage: 'python' | 'r';
  projectSpec: Record<string, unknown>;
  datasets: ExportDatasetSnapshotV1[];
  exportOptions: { requestedFormat: string; effectiveFormat: string; dpi: number | null };
}

export interface ExportEditingSnapshotV1 extends ExportEditingSnapshotBase {
  schemaVersion: typeof LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION;
  figures: ExportFigureSnapshotV1[];
}

export interface ExportEditingSnapshotV2 extends ExportEditingSnapshotBase {
  schemaVersion: typeof SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION;
  figures: ExportFigureSnapshotV2[];
}

export interface ExportEditingSnapshotV3 extends ExportEditingSnapshotBase {
  schemaVersion: typeof EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION;
  figures: ExportFigureSnapshotV2[];
}

export type ExportEditingSnapshot =
  | ExportEditingSnapshotV1
  | ExportEditingSnapshotV2
  | ExportEditingSnapshotV3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseExportEditingSnapshot(value: unknown): ExportEditingSnapshot | null {
  if (!isRecord(value)) return null;
  const schemaVersion = value.schemaVersion;
  if (
    schemaVersion !== LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION
    && schemaVersion !== SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION
    && schemaVersion !== EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION
  ) return null;
  if (
    typeof value.capturedAt !== 'string'
    || typeof value.projectId !== 'string'
    || typeof value.projectName !== 'string'
    || typeof value.targetFigureId !== 'string'
    || typeof value.projectScript !== 'string'
    || (value.scriptLanguage !== 'python' && value.scriptLanguage !== 'r')
    || !isRecord(value.projectSpec)
    || !Array.isArray(value.figures)
    || value.figures.length === 0
    || !Array.isArray(value.datasets)
    || !isRecord(value.exportOptions)
  ) return null;

  const figures: Array<ExportFigureSnapshotV1 | ExportFigureSnapshotV2> = [];
  for (const rawFigure of value.figures) {
    if (
      !isRecord(rawFigure)
      || typeof rawFigure.figureId !== 'string'
      || typeof rawFigure.index !== 'number'
      || !Number.isInteger(rawFigure.index)
      || rawFigure.index < 0
      || typeof rawFigure.sessionId !== 'string'
      || typeof rawFigure.revision !== 'number'
      || !Number.isFinite(rawFigure.revision)
      || !Array.isArray(rawFigure.editLog)
    ) return null;
    if (
      schemaVersion !== LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION
      && (
        typeof rawFigure.script !== 'string'
        || (rawFigure.scriptLanguage !== 'python' && rawFigure.scriptLanguage !== 'r')
      )
    ) return null;
    figures.push(rawFigure as unknown as ExportFigureSnapshotV1 | ExportFigureSnapshotV2);
  }

  const datasets: ExportDatasetSnapshotV1[] = [];
  for (const rawDataset of value.datasets) {
    if (
      !isRecord(rawDataset)
      || typeof rawDataset.datasetId !== 'string'
      || typeof rawDataset.fileName !== 'string'
      || typeof rawDataset.rowCount !== 'number'
      || !Array.isArray(rawDataset.columns)
      || rawDataset.columns.some(column => typeof column !== 'string')
      || typeof rawDataset.sizeBytes !== 'number'
      || typeof rawDataset.sha256 !== 'string'
    ) return null;
    datasets.push(rawDataset as unknown as ExportDatasetSnapshotV1);
  }

  const requestedFormat = value.exportOptions.requestedFormat;
  const effectiveFormat = value.exportOptions.effectiveFormat;
  const dpi = value.exportOptions.dpi;
  if (
    typeof requestedFormat !== 'string'
    || typeof effectiveFormat !== 'string'
    || (dpi !== null && (typeof dpi !== 'number' || !Number.isFinite(dpi)))
  ) return null;

  const base = {
    capturedAt: value.capturedAt,
    projectId: value.projectId,
    projectName: value.projectName,
    targetFigureId: value.targetFigureId,
    projectScript: value.projectScript,
    scriptLanguage: value.scriptLanguage as 'python' | 'r',
    projectSpec: value.projectSpec,
    datasets,
    exportOptions: { requestedFormat, effectiveFormat, dpi: dpi === null ? null : dpi as number },
  };
  if (schemaVersion === LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION) {
    return {
        ...base,
        schemaVersion,
        figures: figures as ExportFigureSnapshotV1[],
      };
  }
  return {
    ...base,
    schemaVersion,
    figures: figures as ExportFigureSnapshotV2[],
  } as ExportEditingSnapshotV2 | ExportEditingSnapshotV3;
}
