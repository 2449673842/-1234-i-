import type { EditEntry } from './manifest';

export const EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION = 1 as const;

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

export interface ExportEditingSnapshotV1 {
  schemaVersion: typeof EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  projectId: string;
  projectName: string;
  targetFigureId: string;
  projectScript: string;
  scriptLanguage: 'python' | 'r';
  projectSpec: Record<string, unknown>;
  figures: ExportFigureSnapshotV1[];
  datasets: ExportDatasetSnapshotV1[];
  exportOptions: { requestedFormat: string; effectiveFormat: string; dpi: number | null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseExportEditingSnapshot(value: unknown): ExportEditingSnapshotV1 | null {
  if (!isRecord(value) || value.schemaVersion !== EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION) return null;
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

  const figures: ExportFigureSnapshotV1[] = [];
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
    figures.push(rawFigure as unknown as ExportFigureSnapshotV1);
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

  return {
    schemaVersion: EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: value.capturedAt,
    projectId: value.projectId,
    projectName: value.projectName,
    targetFigureId: value.targetFigureId,
    projectScript: value.projectScript,
    scriptLanguage: value.scriptLanguage,
    projectSpec: value.projectSpec,
    figures,
    datasets,
    exportOptions: { requestedFormat, effectiveFormat, dpi: dpi === null ? null : dpi as number },
  };
}
