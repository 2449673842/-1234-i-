export interface ExportSnapshotRestoreResult {
  status: 'success';
  projectId: string;
  targetFigureId: string;
  capturedAt: string;
  restoredRevisions: Record<string, number>;
  message: string;
}

export async function restoreExportSnapshot(projectId: string, assetId: string): Promise<ExportSnapshotRestoreResult> {
  const response = await fetch(`/api/projects/${projectId}/export-assets/${assetId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status !== 'success') {
    const details = Array.isArray(data?.issues) && data.issues.length > 0 ? `\n${data.issues.join('\n')}` : '';
    throw new Error(`${data?.message || '恢复导出状态失败'}${details}`);
  }
  return data as ExportSnapshotRestoreResult;
}
