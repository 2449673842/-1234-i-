import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tempRoot = '';
let databaseModule: typeof import('../../db');
let userId = '';
let otherUserId = '';

beforeAll(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scifigure-usage-budget-'));
  process.env.SCIFIGURE_DATA_DIR = tempRoot;
  process.env.SCIFIGURE_DB_PATH = path.join(tempRoot, 'usage.db');
  process.env.SCIFIGURE_FIGURE_HISTORY_MAX_MB = '2';
  databaseModule = await import('../../db');
  const user = await databaseModule.createUserAccount(
    `usage-budget-${Date.now()}@example.test`,
    'Usage-Budget-Test-2026',
    'Usage Budget Test',
  );
  userId = user.id;
  const otherUser = await databaseModule.createUserAccount(
    `usage-budget-other-${Date.now()}@example.test`,
    'Usage-Budget-Other-Test-2026',
    'Usage Budget Other Test',
  );
  otherUserId = otherUser.id;
});

afterAll(async () => {
  databaseModule.getDb().close();
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

describe('persistent hourly usage budget', () => {
  it('never reassigns a session owner during an ID conflict', () => {
    const sessionId = 'session-owner-conflict-test';
    databaseModule.saveSession(sessionId, userId, 'print("owner")', null, [], 1);
    expect(() => databaseModule.saveSession(sessionId, otherUserId, 'print("attacker")', null, [], 2))
      .toThrow('Session ownership conflict');
    expect(databaseModule.getSession(sessionId, userId)?.script).toBe('print("owner")');
    expect(databaseModule.getSession(sessionId, otherUserId)).toBeNull();
  });

  it('rejects oversized Figure history before replacing durable project state', () => {
    const projectId = `history-budget-${Date.now()}`;
    const sessionId = `history-session-${Date.now()}`;
    databaseModule.createProject(projectId, userId, 'History Budget', { plot_type: 'custom' }, 'print("original")');
    databaseModule.replaceProjectFiguresAndSessions(projectId, userId, [{
      figureIndex: 0,
      sessionId,
      editLog: [],
      revision: 1,
      history: { past: [{ revision: 1 }], future: [] },
    }], 'print("original")', null);
    const before = databaseModule.listProjectFigures(projectId)[0];

    expect(() => databaseModule.replaceProjectFiguresAndSessions(projectId, userId, [{
      figureIndex: 0,
      sessionId,
      editLog: [],
      revision: 2,
      history: { past: ['x'.repeat(2 * 1024 * 1024)], future: [] },
    }], 'print("must-not-persist")', null)).toThrow('历史记录');

    const after = databaseModule.listProjectFigures(projectId)[0];
    expect(after.history).toBe(before.history);
    expect(after.revision).toBe(1);
    expect(databaseModule.getSession(sessionId, userId)?.script).toBe('print("original")');
  });

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

  it('persists authentication request budgets and rejects atomically', () => {
    const now = Date.UTC(2026, 6, 15, 11, 0, 0);
    const scopes = [
      { scopeHash: 'a'.repeat(64), limit: 2, label: 'ip_email' },
      { scopeHash: 'b'.repeat(64), limit: 10, label: 'global' },
    ];
    expect(databaseModule.consumeAuthRequestBudget('email_send', scopes, 15 * 60 * 1000, now)).toMatchObject({
      allowed: true,
      used: 1,
    });
    expect(databaseModule.consumeAuthRequestBudget('email_send', scopes, 15 * 60 * 1000, now + 1_000)).toMatchObject({
      allowed: true,
      used: 2,
    });
    expect(databaseModule.consumeAuthRequestBudget('email_send', scopes, 15 * 60 * 1000, now + 2_000)).toMatchObject({
      allowed: false,
      blockedScope: 'ip_email',
      used: 2,
    });
    const globalRow = databaseModule.getDb().prepare(`
      SELECT amount FROM auth_request_budgets
      WHERE category = 'email_send' AND scope_hash = ?
    `).get('b'.repeat(64)) as { amount: number };
    expect(globalRow.amount).toBe(2);
  });

  it('persists login failures, expires cooldowns and clears successful identifiers', () => {
    const identifierHash = 'c'.repeat(64);
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const policy = { maxFailures: 3, windowMs: 1_000, lockMs: 2_000 };
    expect(databaseModule.recordAuthLoginFailure(identifierHash, policy, now)).toMatchObject({ blocked: false, failureCount: 1 });
    expect(databaseModule.recordAuthLoginFailure(identifierHash, policy, now + 100)).toMatchObject({ blocked: false, failureCount: 2 });
    expect(databaseModule.recordAuthLoginFailure(identifierHash, policy, now + 200)).toMatchObject({ blocked: true, failureCount: 3 });
    expect(databaseModule.readAuthLoginThrottle(identifierHash, now + 300)).toMatchObject({ blocked: true });
    expect(databaseModule.readAuthLoginThrottle(identifierHash, now + 2_300)).toMatchObject({ blocked: false });
    expect(databaseModule.recordAuthLoginFailure(identifierHash, policy, now + 2_300)).toMatchObject({ blocked: false, failureCount: 1 });
    databaseModule.clearAuthLoginThrottle(identifierHash);
    expect(databaseModule.readAuthLoginThrottle(identifierHash, now + 2_400)).toMatchObject({ blocked: false, failureCount: 0 });
  });
});
