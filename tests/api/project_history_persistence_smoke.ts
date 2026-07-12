import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const root = path.resolve(import.meta.dirname, '../..');
const tmpDir = path.join(root, 'tmp', 'project-history-persistence-smoke');
const dbPath = path.join(tmpDir, `history-${Date.now()}.db`);

fs.mkdirSync(tmpDir, { recursive: true });
process.env.SCIFIGURE_DB_PATH = dbPath;

const {
  claimLegacyOwnership,
  cleanExpiredSessions,
  getDb,
  replaceProjectFiguresAndSessions,
} = await import('../../db');

const db = getDb();
const userId = randomUUID();
const projectId = randomUUID();
const durableSessionId = `${projectId}_fig_1`;
const disposableSessionId = `temporary_${randomUUID()}`;
const otherUserId = randomUUID();
const legacyProjectId = randomUUID();
const legacySessionId = `legacy_${randomUUID()}`;
const ownerEmail = `history-${Date.now()}@example.test`;
const history = {
  past: [{ editLog: [], label: '初始图', timestamp: 1 }],
  future: [],
};

try {
  db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role)
    VALUES (?, ?, 'hash', 'salt', 'user')
  `).run(userId, ownerEmail);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role)
    VALUES (?, ?, 'hash', 'salt', 'user')
  `).run(otherUserId, `other-${Date.now()}@example.test`);
  db.prepare(`
    INSERT INTO projects (id, user_id, name, spec, script)
    VALUES (?, ?, 'History smoke', '{}', '')
  `).run(projectId, userId);
  db.prepare(`
    INSERT INTO sessions (id, user_id, script, edit_log, revision, updated_at)
    VALUES (?, ?, '', ?, 3, datetime('now', '-1 day'))
  `).run(durableSessionId, userId, JSON.stringify([{ gid: 'title.0', prop: 'color', value: '#123456', mode: 'backend_patch' }]));
  db.prepare(`
    INSERT INTO sessions (id, user_id, script, edit_log, revision, updated_at)
    VALUES (?, ?, '', '[]', 1, datetime('now', '-1 day'))
  `).run(disposableSessionId, userId);
  db.prepare(`
    INSERT INTO project_figures (
      id, project_id, figure_index, session_id, revision, edit_log, history
    ) VALUES (?, ?, 0, ?, 3, ?, ?)
  `).run(
    `${projectId}_0`,
    projectId,
    durableSessionId,
    JSON.stringify([{ gid: 'title.0', prop: 'color', value: '#123456', mode: 'backend_patch' }]),
    JSON.stringify(history),
  );

  db.prepare(`
    INSERT INTO projects (id, user_id, name, spec, script)
    VALUES (?, NULL, 'Legacy ownership smoke', '{}', '')
  `).run(legacyProjectId);
  db.prepare(`
    INSERT INTO sessions (id, user_id, script, edit_log, revision)
    VALUES (?, NULL, '', '[]', 1)
  `).run(legacySessionId);
  db.prepare(`
    INSERT INTO project_figures (id, project_id, figure_index, session_id, revision)
    VALUES (?, ?, 0, ?, 1)
  `).run(`${legacyProjectId}_0`, legacyProjectId, legacySessionId);

  delete process.env.SCIFIGURE_LEGACY_OWNER_EMAIL;
  claimLegacyOwnership(otherUserId);
  if ((db.prepare('SELECT user_id FROM projects WHERE id = ?').get(legacyProjectId) as any).user_id !== null) {
    throw new Error('legacy project was claimed without an explicit owner configuration');
  }

  process.env.SCIFIGURE_LEGACY_OWNER_EMAIL = ownerEmail;
  claimLegacyOwnership(otherUserId);
  if ((db.prepare('SELECT user_id FROM projects WHERE id = ?').get(legacyProjectId) as any).user_id !== null) {
    throw new Error('legacy project was claimed by a non-configured requester');
  }

  claimLegacyOwnership(userId);
  const legacyOwner = (db.prepare('SELECT user_id FROM projects WHERE id = ?').get(legacyProjectId) as any).user_id;
  const legacySessionOwner = (db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(legacySessionId) as any).user_id;
  if (legacyOwner !== userId || legacySessionOwner !== userId) {
    throw new Error(`explicit legacy ownership failed: project=${legacyOwner}, session=${legacySessionOwner}`);
  }

  cleanExpiredSessions(120);

  const durableExists = Boolean(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(durableSessionId));
  const disposableExists = Boolean(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(disposableSessionId));
  if (!durableExists || disposableExists) {
    throw new Error(`session cleanup boundary failed: durable=${durableExists}, disposable=${disposableExists}`);
  }

  replaceProjectFiguresAndSessions(
    projectId,
    userId,
    [{
      figureIndex: 0,
      sessionId: durableSessionId,
      editLog: [{ gid: 'title.0', prop: 'fontsize', value: 12, mode: 'backend_patch' }],
      revision: 4,
      previewSvg: '<svg/>',
      manifest: { objects: [] },
    }],
    '',
    null,
  );

  const figure = db.prepare('SELECT revision, edit_log, history FROM project_figures WHERE project_id = ? AND figure_index = 0').get(projectId) as any;
  const persistedHistory = JSON.parse(figure.history || '{}');
  const persistedEditLog = JSON.parse(figure.edit_log || '[]');
  if (figure.revision !== 4 || persistedEditLog.length !== 1 || persistedHistory.past?.length !== 1) {
    throw new Error(`figure replacement persistence failed: ${JSON.stringify({ figure, persistedEditLog, persistedHistory })}`);
  }

  console.log('PASS project session cleanup excludes saved Figure sessions');
  console.log('PASS project Figure replacement preserves durable history');
  console.log('PASS legacy ownership requires an explicitly configured account');
} finally {
  delete process.env.SCIFIGURE_LEGACY_OWNER_EMAIL;
  db.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}
