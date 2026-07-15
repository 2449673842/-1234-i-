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
