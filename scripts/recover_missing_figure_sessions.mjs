import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = process.cwd();
const DATA_ROOT = process.env.SCIFIGURE_DATA_DIR
  ? path.resolve(process.env.SCIFIGURE_DATA_DIR)
  : path.resolve(ROOT, 'data');
const DB_PATH = process.env.SCIFIGURE_DB_PATH
  ? path.resolve(process.env.SCIFIGURE_DB_PATH)
  : path.join(DATA_ROOT, 'scifigure.db');
const BACKUPS_ROOT = path.join(DATA_ROOT, 'backups');
const APPLY = process.argv.includes('--apply');

function projectScript(row) {
  if (String(row.script || '').trim()) return String(row.script);
  try {
    const spec = JSON.parse(row.spec || '{}');
    return String(spec.custom_script || spec.script || '');
  } catch {
    return '';
  }
}

if (!fs.existsSync(DB_PATH)) throw new Error(`Database not found: ${DB_PATH}`);

const db = new Database(DB_PATH, { readonly: !APPLY });
const missing = db.prepare(`
  SELECT
    pf.id AS figure_id,
    pf.project_id,
    pf.session_id,
    pf.revision,
    pf.edit_log,
    p.name AS project_name,
    p.user_id,
    p.script,
    p.spec
  FROM project_figures pf
  JOIN projects p ON p.id = pf.project_id
  LEFT JOIN sessions s ON s.id = pf.session_id
  WHERE s.id IS NULL
  ORDER BY p.updated_at, pf.figure_index
`).all().map(row => ({
  ...row,
  recoveredScript: projectScript(row),
}));

const report = {
  createdAt: new Date().toISOString(),
  mode: APPLY ? 'apply' : 'dry-run',
  dataRoot: DATA_ROOT,
  missingCount: missing.length,
  recoverableCount: missing.filter(row => row.user_id && row.session_id).length,
  restored: [],
  skipped: [],
  sessions: missing.map(row => ({
    figureId: row.figure_id,
    projectId: row.project_id,
    projectName: row.project_name,
    sessionId: row.session_id,
    userId: row.user_id,
    revision: row.revision,
    editCount: (() => {
      try { return JSON.parse(row.edit_log || '[]').length; } catch { return null; }
    })(),
    scriptLength: row.recoveredScript.length,
  })),
};

if (APPLY && missing.length > 0) {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_ROOT, `pre-session-recovery-${stamp}.db`);
  await db.backup(backupPath);
  report.databaseBackup = path.relative(ROOT, backupPath);

  const insert = db.prepare(`
    INSERT INTO sessions (id, user_id, script, data_payload, edit_log, revision, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `);
  db.transaction(() => {
    for (const row of missing) {
      if (!row.user_id || !row.session_id) {
        report.skipped.push({ figureId: row.figure_id, sessionId: row.session_id, reason: 'missing owner or session id' });
        continue;
      }
      const result = insert.run(row.session_id, row.user_id, row.recoveredScript, row.edit_log || '[]', Number(row.revision || 1));
      if (result.changes === 1) {
        report.restored.push({ figureId: row.figure_id, projectId: row.project_id, sessionId: row.session_id });
      } else {
        report.skipped.push({ figureId: row.figure_id, sessionId: row.session_id, reason: 'session already exists' });
      }
    }
  })();

  const reportPath = path.join(BACKUPS_ROOT, `figure-session-recovery-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  report.reportPath = path.relative(ROOT, reportPath);
}

db.close();
console.log(JSON.stringify(report, null, 2));
if (report.recoverableCount !== report.missingCount || report.skipped.length > 0) process.exitCode = 1;
