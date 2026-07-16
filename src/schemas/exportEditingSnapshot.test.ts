import { describe, expect, it } from 'vitest';
import {
  EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  parseExportEditingSnapshot,
  type ExportEditingSnapshotV1,
} from './exportEditingSnapshot';

const snapshot: ExportEditingSnapshotV1 = {
  schemaVersion: EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  capturedAt: '2026-07-16T10:00:00.000Z',
  projectId: 'project-12345678',
  projectName: 'Snapshot test',
  targetFigureId: 'fig_1',
  projectScript: 'print("figure")',
  scriptLanguage: 'python',
  projectSpec: { plot_type: 'custom' },
  figures: [{ figureId: 'fig_1', index: 0, sessionId: 'session-1', revision: 3, editLog: [] }],
  datasets: [{ datasetId: 'data-1', fileName: 'data.csv', rowCount: 2, columns: ['x'], sizeBytes: 10, sha256: 'a'.repeat(64) }],
  exportOptions: { requestedFormat: 'png', effectiveFormat: 'png', dpi: 300 },
};

describe('export editing snapshot schema', () => {
  it('accepts a complete v1 snapshot', () => {
    expect(parseExportEditingSnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects unknown versions and incomplete figure state', () => {
    expect(parseExportEditingSnapshot({ ...snapshot, schemaVersion: 2 })).toBeNull();
    expect(parseExportEditingSnapshot({ ...snapshot, figures: [{ figureId: 'fig_1' }] })).toBeNull();
  });
});
