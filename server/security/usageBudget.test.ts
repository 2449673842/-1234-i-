import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tempRoot = '';
let databaseModule: typeof import('../../db');
let userId = '';

beforeAll(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scifigure-usage-budget-'));
  process.env.SCIFIGURE_DATA_DIR = tempRoot;
  process.env.SCIFIGURE_DB_PATH = path.join(tempRoot, 'usage.db');
  databaseModule = await import('../../db');
  const user = await databaseModule.createUserAccount(
    `usage-budget-${Date.now()}@example.test`,
    'Usage-Budget-Test-2026',
    'Usage Budget Test',
  );
  userId = user.id;
});

afterAll(async () => {
  databaseModule.getDb().close();
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

describe('persistent hourly usage budget', () => {
  it('persists consumption, rejects overflow and resets in the next hour', () => {
    const now = Date.UTC(2026, 6, 15, 8, 10, 0);
    expect(databaseModule.consumeHourlyUsageBudget(userId, 'download_bytes', 60, 100, now)).toMatchObject({
      allowed: true,
      used: 60,
    });
    expect(databaseModule.consumeHourlyUsageBudget(userId, 'download_bytes', 41, 100, now + 1_000)).toMatchObject({
      allowed: false,
      used: 60,
    });
    expect(databaseModule.consumeHourlyUsageBudget(userId, 'download_bytes', 40, 100, now + 2_000)).toMatchObject({
      allowed: true,
      used: 100,
    });
    expect(databaseModule.consumeHourlyUsageBudget(userId, 'download_bytes', 100, 100, now + 3_600_000)).toMatchObject({
      allowed: true,
      used: 100,
    });
    expect(databaseModule.consumeGlobalHourlyUsageBudget('download_bytes', 80, 100, now)).toMatchObject({
      allowed: true,
      used: 80,
    });
    expect(databaseModule.consumeGlobalHourlyUsageBudget('download_bytes', 21, 100, now + 1_000)).toMatchObject({
      allowed: false,
      used: 80,
    });
  });

  it('commits user and global usage atomically', () => {
    const now = Date.UTC(2026, 6, 15, 10, 10, 0);
    const category = 'upload_bytes';
    expect(databaseModule.consumeGlobalHourlyUsageBudget(category, 90, 100, now)).toMatchObject({ allowed: true });

    const blocked = databaseModule.consumeScopedHourlyUsageBudget(userId, category, 20, 100, 100, now + 1_000);
    expect(blocked).toMatchObject({ allowed: false, blockedScope: 'global', used: 0, globalUsed: 90 });

    const userAfterReject = databaseModule.consumeHourlyUsageBudget(userId, category, 100, 100, now + 2_000);
    expect(userAfterReject).toMatchObject({ allowed: true, used: 100 });
  });
});
