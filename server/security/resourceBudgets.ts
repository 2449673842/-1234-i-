export class ResourceBudgetError extends Error {
  statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = 'ResourceBudgetError';
  }
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function singleUploadLimitBytes(): number {
  // Keep the public upload surface below the reverse-proxy ceiling. Raising this
  // hard cap requires an explicit code and infrastructure review.
  return envInteger('SCIFIGURE_SINGLE_UPLOAD_MAX_MB', 50, 1, 50) * 1024 * 1024;
}

export function projectStorageLimits(): { maxFiles: number; maxBytes: number } {
  return {
    maxFiles: envInteger('SCIFIGURE_PROJECT_MAX_FILES', 200, 10, 2_000),
    maxBytes: envInteger('SCIFIGURE_PROJECT_MAX_UPLOAD_MB', 256, 50, 2_048) * 1024 * 1024,
  };
}

export function userStorageLimitBytes(): number {
  return envInteger('SCIFIGURE_USER_MAX_UPLOAD_MB', 1_024, 250, 10_240) * 1024 * 1024;
}

export function globalStorageLimitBytes(): number {
  return envInteger('SCIFIGURE_GLOBAL_STORAGE_MAX_MB', 20_480, 1_024, 102_400) * 1024 * 1024;
}

export function projectTotalStorageLimitBytes(): number {
  return envInteger('SCIFIGURE_PROJECT_TOTAL_STORAGE_MAX_MB', 1_024, 100, 5_120) * 1024 * 1024;
}

export function userTotalStorageLimitBytes(): number {
  return envInteger('SCIFIGURE_USER_TOTAL_STORAGE_MAX_MB', 2_048, 500, 20_480) * 1024 * 1024;
}

export function archiveLimits(): { maxFiles: number; maxBytes: number } {
  return {
    maxFiles: envInteger('SCIFIGURE_ARCHIVE_MAX_FILES', 200, 10, 2_000),
    maxBytes: envInteger('SCIFIGURE_ARCHIVE_MAX_MB', 250, 50, 4_096) * 1024 * 1024,
  };
}

export function sessionPersistenceLimits(): {
  maxScriptBytes: number;
  maxDataPayloadBytes: number;
  maxEditLogBytes: number;
  maxFigureHistoryBytes: number;
  maxDisposableSessions: number;
  maxDisposableBytes: number;
  maxProjectFigures: number;
  maxProjectBatchBytes: number;
} {
  return {
    maxScriptBytes: envInteger('SCIFIGURE_SESSION_SCRIPT_MAX_MB', 2, 1, 8) * 1024 * 1024,
    maxDataPayloadBytes: envInteger('SCIFIGURE_SESSION_DATA_MAX_MB', 32, 4, 64) * 1024 * 1024,
    maxEditLogBytes: envInteger('SCIFIGURE_SESSION_EDIT_LOG_MAX_MB', 8, 1, 32) * 1024 * 1024,
    maxFigureHistoryBytes: envInteger('SCIFIGURE_FIGURE_HISTORY_MAX_MB', 16, 2, 64) * 1024 * 1024,
    maxDisposableSessions: envInteger('SCIFIGURE_DISPOSABLE_SESSION_MAX_COUNT', 100, 10, 1_000),
    maxDisposableBytes: envInteger('SCIFIGURE_DISPOSABLE_SESSION_MAX_MB', 256, 32, 2_048) * 1024 * 1024,
    maxProjectFigures: envInteger('SCIFIGURE_PROJECT_MAX_FIGURES', 500, 20, 2_000),
    maxProjectBatchBytes: envInteger('SCIFIGURE_PROJECT_SESSION_BATCH_MAX_MB', 512, 64, 4_096) * 1024 * 1024,
  };
}

export function projectCatalogLimits(): {
  maxProjects: number;
  maxRecordBytes: number;
  maxCatalogBytes: number;
} {
  return {
    maxProjects: envInteger('SCIFIGURE_USER_PROJECT_SAFETY_MAX_COUNT', 500, 50, 5_000),
    maxRecordBytes: envInteger('SCIFIGURE_PROJECT_RECORD_MAX_MB', 4, 1, 16) * 1024 * 1024,
    maxCatalogBytes: envInteger('SCIFIGURE_USER_PROJECT_CATALOG_MAX_MB', 256, 32, 2_048) * 1024 * 1024,
  };
}

export function projectRecordSizeBytes(name: string, specJson: string, script: string | null): number {
  if (!name.trim() || name.length > 200) {
    throw new ResourceBudgetError('项目名称必须为 1-200 个字符');
  }
  const sizeBytes = Buffer.byteLength(name, 'utf8')
    + Buffer.byteLength(specJson, 'utf8')
    + (script ? Buffer.byteLength(script, 'utf8') : 0);
  if (sizeBytes > projectCatalogLimits().maxRecordBytes) {
    throw new ResourceBudgetError(`单个项目配置和脚本不能超过 ${Math.floor(projectCatalogLimits().maxRecordBytes / 1024 / 1024)} MB`);
  }
  return sizeBytes;
}

export function assertUserProjectCatalogBudget(
  existingCount: number,
  existingBytes: number,
  incomingBytes: number,
  createsNewProject: boolean,
): void {
  const limits = projectCatalogLimits();
  if (createsNewProject && existingCount + 1 > limits.maxProjects) {
    throw new ResourceBudgetError(`单个账号最多创建 ${limits.maxProjects} 个项目（安全上限）`);
  }
  if (Math.max(0, existingBytes) + Math.max(0, incomingBytes) > limits.maxCatalogBytes) {
    throw new ResourceBudgetError(`单个账号的项目配置和脚本不能超过 ${Math.floor(limits.maxCatalogBytes / 1024 / 1024)} MB`);
  }
}

export function sessionRecordSizeBytes(script: string, dataPayloadJson: string | null, editLogJson: string): number {
  const limits = sessionPersistenceLimits();
  const scriptBytes = Buffer.byteLength(script, 'utf8');
  const dataBytes = dataPayloadJson ? Buffer.byteLength(dataPayloadJson, 'utf8') : 0;
  const editLogBytes = Buffer.byteLength(editLogJson, 'utf8');
  if (scriptBytes > limits.maxScriptBytes) {
    throw new ResourceBudgetError(`绘图脚本不能超过 ${Math.floor(limits.maxScriptBytes / 1024 / 1024)} MB`);
  }
  if (dataBytes > limits.maxDataPayloadBytes) {
    throw new ResourceBudgetError(`会话内联数据不能超过 ${Math.floor(limits.maxDataPayloadBytes / 1024 / 1024)} MB；较大数据请使用项目上传文件`);
  }
  if (editLogBytes > limits.maxEditLogBytes) {
    throw new ResourceBudgetError(`会话编辑记录不能超过 ${Math.floor(limits.maxEditLogBytes / 1024 / 1024)} MB`);
  }
  return scriptBytes + dataBytes + editLogBytes;
}

export function figureHistorySizeBytes(historyJson: string): number {
  const bytes = Buffer.byteLength(historyJson, 'utf8');
  const maxBytes = sessionPersistenceLimits().maxFigureHistoryBytes;
  if (bytes > maxBytes) {
    throw new ResourceBudgetError(`单个 Figure 历史记录不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  return bytes;
}

export function assertDisposableSessionStorageBudget(
  existingCount: number,
  existingBytes: number,
  incomingBytes: number,
  createsNewSession: boolean,
): void {
  const limits = sessionPersistenceLimits();
  if (createsNewSession && existingCount + 1 > limits.maxDisposableSessions) {
    throw new ResourceBudgetError(`单个账号最多保留 ${limits.maxDisposableSessions} 个未保存临时会话；请先保存为项目`);
  }
  if (Math.max(0, existingBytes) + Math.max(0, incomingBytes) > limits.maxDisposableBytes) {
    throw new ResourceBudgetError(`单个账号的未保存临时会话不能超过 ${Math.floor(limits.maxDisposableBytes / 1024 / 1024)} MB`);
  }
}

export function assertProjectSessionBatchBudget(totalBytes: number, figureCount: number): void {
  const limits = sessionPersistenceLimits();
  if (Math.max(0, Math.floor(figureCount)) > limits.maxProjectFigures) {
    throw new ResourceBudgetError(`单个项目最多生成 ${limits.maxProjectFigures} 个 Figure`);
  }
  const maxBytes = limits.maxProjectBatchBytes;
  if (Math.max(0, totalBytes) > maxBytes) {
    throw new ResourceBudgetError(`单个项目的 Figure 会话批次不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
}

export function assertUserStorageBudget(existingSizes: number[], incomingSize: number): void {
  const maxBytes = userStorageLimitBytes();
  const totalBytes = existingSizes.reduce((sum, size) => sum + Math.max(0, size), 0) + Math.max(0, incomingSize);
  if (totalBytes > maxBytes) {
    throw new ResourceBudgetError(`单个账号的数据文件总量不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
}

export function assertGlobalStorageBudget(existingSizes: number[], incomingSize: number): void {
  const maxBytes = globalStorageLimitBytes();
  const totalBytes = existingSizes.reduce((sum, size) => sum + Math.max(0, size), 0) + Math.max(0, incomingSize);
  if (totalBytes > maxBytes) {
    throw new ResourceBudgetError('平台存储空间已达到安全上限，请联系管理员处理后再上传');
  }
}

export function assertProjectTotalStorageBudget(existingSizes: number[], incomingSize: number): void {
  const maxBytes = projectTotalStorageLimitBytes();
  const totalBytes = existingSizes.reduce((sum, size) => sum + Math.max(0, size), 0) + Math.max(0, incomingSize);
  if (totalBytes > maxBytes) {
    throw new ResourceBudgetError(`单个项目的文件与导出资产总量不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
}

export function assertUserTotalStorageBudget(existingSizes: number[], incomingSize: number): void {
  const maxBytes = userTotalStorageLimitBytes();
  const totalBytes = existingSizes.reduce((sum, size) => sum + Math.max(0, size), 0) + Math.max(0, incomingSize);
  if (totalBytes > maxBytes) {
    throw new ResourceBudgetError(`单个账号的文件与导出资产总量不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
}

export function assertProjectStorageBudget(
  existingSizes: number[],
  incomingSize: number,
): void {
  const limits = projectStorageLimits();
  if (existingSizes.length + 1 > limits.maxFiles) {
    throw new ResourceBudgetError(`单个项目最多保存 ${limits.maxFiles} 个数据文件`);
  }
  const totalBytes = existingSizes.reduce((sum, size) => sum + Math.max(0, size), 0) + Math.max(0, incomingSize);
  if (totalBytes > limits.maxBytes) {
    throw new ResourceBudgetError(`单个项目的数据文件总量不能超过 ${Math.floor(limits.maxBytes / 1024 / 1024)} MB`);
  }
}

export function assertArchiveBudget(requestedCount: number, selectedSizes: number[]): void {
  const limits = archiveLimits();
  if (requestedCount > limits.maxFiles || selectedSizes.length > limits.maxFiles) {
    throw new ResourceBudgetError(`单次最多归档 ${limits.maxFiles} 个导出文件`);
  }
  const totalBytes = selectedSizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  if (totalBytes > limits.maxBytes) {
    throw new ResourceBudgetError(`单次归档的文件总量不能超过 ${Math.floor(limits.maxBytes / 1024 / 1024)} MB`);
  }
}
