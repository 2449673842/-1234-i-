import { afterEach, describe, expect, it } from 'vitest';
import {
  assertArchiveBudget,
  assertGlobalStorageBudget,
  assertProjectTotalStorageBudget,
  assertProjectStorageBudget,
  assertUserTotalStorageBudget,
  assertUserStorageBudget,
  singleUploadLimitBytes,
} from './resourceBudgets';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('resource budgets', () => {
  it('caps archive selection count and cumulative bytes', () => {
    process.env.SCIFIGURE_ARCHIVE_MAX_FILES = '10';
    process.env.SCIFIGURE_ARCHIVE_MAX_MB = '50';
    expect(() => assertArchiveBudget(11, [])).toThrow('最多归档');
    expect(() => assertArchiveBudget(2, [30 * 1024 * 1024, 21 * 1024 * 1024])).toThrow('文件总量');
    expect(() => assertArchiveBudget(2, [1_024, 2_048])).not.toThrow();
  });

  it('caps project file count and cumulative uploaded bytes', () => {
    process.env.SCIFIGURE_PROJECT_MAX_FILES = '10';
    process.env.SCIFIGURE_PROJECT_MAX_UPLOAD_MB = '100';
    expect(() => assertProjectStorageBudget(Array.from({ length: 10 }, () => 1), 1)).toThrow('最多保存');
    expect(() => assertProjectStorageBudget([60 * 1024 * 1024], 41 * 1024 * 1024)).toThrow('总量');
    expect(() => assertProjectStorageBudget([1_024], 2_048)).not.toThrow();

    process.env.SCIFIGURE_USER_MAX_UPLOAD_MB = '500';
    expect(() => assertUserStorageBudget([400 * 1024 * 1024], 101 * 1024 * 1024)).toThrow('账号');
    expect(() => assertUserStorageBudget([1_024], 2_048)).not.toThrow();
  });

  it('keeps the single-file ceiling at or below 50 MB', () => {
    process.env.SCIFIGURE_SINGLE_UPLOAD_MAX_MB = '5000';
    expect(singleUploadLimitBytes()).toBe(50 * 1024 * 1024);
    process.env.SCIFIGURE_SINGLE_UPLOAD_MAX_MB = '20';
    expect(singleUploadLimitBytes()).toBe(20 * 1024 * 1024);
  });

  it('caps aggregate platform storage without touching existing files', () => {
    process.env.SCIFIGURE_GLOBAL_STORAGE_MAX_MB = '1024';
    expect(() => assertGlobalStorageBudget([900 * 1024 * 1024], 125 * 1024 * 1024)).toThrow('平台存储空间');
    expect(() => assertGlobalStorageBudget([900 * 1024 * 1024], 100 * 1024 * 1024)).not.toThrow();
  });

  it('caps aggregate project and user storage including export assets', () => {
    process.env.SCIFIGURE_PROJECT_TOTAL_STORAGE_MAX_MB = '100';
    process.env.SCIFIGURE_USER_TOTAL_STORAGE_MAX_MB = '500';
    expect(() => assertProjectTotalStorageBudget([90 * 1024 * 1024], 11 * 1024 * 1024)).toThrow('文件与导出资产');
    expect(() => assertProjectTotalStorageBudget([90 * 1024 * 1024], 10 * 1024 * 1024)).not.toThrow();
    expect(() => assertUserTotalStorageBudget([490 * 1024 * 1024], 11 * 1024 * 1024)).toThrow('文件与导出资产');
    expect(() => assertUserTotalStorageBudget([490 * 1024 * 1024], 10 * 1024 * 1024)).not.toThrow();
  });
});
