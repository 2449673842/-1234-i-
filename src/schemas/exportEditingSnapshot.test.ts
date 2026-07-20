import { describe, expect, it } from 'vitest';
import {
  EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  parseExportEditingSnapshot,
  type ExportEditingSnapshotV3,
} from './exportEditingSnapshot';

const snapshot: ExportEditingSnapshotV3 = {
  schemaVersion: EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  capturedAt: '2026-07-16T10:00:00.000Z',
  projectId: 'project-12345678',
  projectName: 'Snapshot test',
  targetFigureId: 'fig_1',
  projectScript: 'print("figure")',
  scriptLanguage: 'python',
  projectSpec: { plot_type: 'custom' },
  figures: [{
    figureId: 'fig_1',
    index: 0,
    sessionId: 'session-1',
    revision: 3,
    editLog: [],
    script: 'print("figure")',
    scriptLanguage: 'python',
  }],
  datasets: [{ datasetId: 'data-1', fileName: 'data.csv', rowCount: 2, columns: ['x'], sizeBytes: 10, sha256: 'a'.repeat(64) }],
  exportOptions: { requestedFormat: 'png', effectiveFormat: 'png', dpi: 300 },
};

describe('export editing snapshot schema', () => {
  it('accepts a complete current snapshot', () => {
    expect(parseExportEditingSnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects unknown versions and incomplete figure state', () => {
    expect(parseExportEditingSnapshot({ ...snapshot, schemaVersion: 99 })).toBeNull();
    expect(parseExportEditingSnapshot({ ...snapshot, figures: [{ figureId: 'fig_1' }] })).toBeNull();
  });

  it('keeps legacy single-script snapshots readable', () => {
    const legacy = {
      ...snapshot,
      schemaVersion: LEGACY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
      figures: snapshot.figures.map(({ script: _script, scriptLanguage: _scriptLanguage, ...figure }) => figure),
    };
    expect(parseExportEditingSnapshot(legacy)).toEqual(legacy);
  });

  it('keeps scripted v2 snapshots readable', () => {
    const scriptedV2 = {
      ...snapshot,
      schemaVersion: SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
    };
    expect(parseExportEditingSnapshot(scriptedV2)).toEqual(scriptedV2);
  });
});
