import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-data-integrity-'));
const dataRoot = path.join(tempRoot, 'data');
const dbPath = path.join(dataRoot, 'scifigure.db');
const sourceProjectId = 'source-project';
const targetProjectId = 'target-project';
const sourcePath = path.join(dataRoot, 'projects', sourceProjectId, 'files', '100_fixture.csv');
const targetPath = path.join(dataRoot, 'projects', targetProjectId, 'files', '200_fixture.csv');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runScript(script, args = []) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, SCIFIGURE_DATA_DIR: dataRoot, SCIFIGURE_DB_PATH: dbPath },
    encoding: 'utf8',
  });
}

try {
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'x,y\n1,2\n3,4\n', 'utf8');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, spec TEXT DEFAULT '{}', script TEXT DEFAULT '', file_count INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE project_files (id TEXT PRIMARY KEY, project_id TEXT, original_name TEXT, stored_path TEXT, columns TEXT, row_count INTEGER, uploaded_at TEXT);
    CREATE TABLE export_assets (id TEXT PRIMARY KEY, project_id TEXT, file_path TEXT, format TEXT, created_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, script TEXT, data_payload TEXT, edit_log TEXT, revision INTEGER, updated_at TEXT);
    CREATE TABLE project_figures (id TEXT PRIMARY KEY, project_id TEXT, figure_index INTEGER, session_id TEXT, revision INTEGER, edit_log TEXT, history TEXT);
  `);
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('user-1', 'owner@local.invalid');
  db.prepare('INSERT INTO projects (id, user_id, name, file_count) VALUES (?, ?, ?, 1)').run(sourceProjectId, 'user-1', 'Source');
  db.prepare('INSERT INTO projects (id, user_id, name, file_count) VALUES (?, ?, ?, 1)').run(targetProjectId, 'user-1', 'Target');
  const insertFile = db.prepare('INSERT INTO project_files (id, project_id, original_name, stored_path, columns, row_count, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertFile.run('source-file', sourceProjectId, 'fixture.csv', sourcePath, '["x","y"]', 2, '2026-01-01 00:00:00');
  insertFile.run('target-file', targetProjectId, 'fixture.csv', targetPath, '["x","y"]', 2, '2026-01-02 00:00:00');
  db.prepare('INSERT INTO project_figures (id, project_id, figure_index, session_id, revision, edit_log, history) VALUES (?, ?, 0, ?, 2, ?, ?)')
    .run('target-figure', targetProjectId, 'target-session', '[{"gid":"title.0","prop":"color","value":"#123456"}]', '{"past":[],"future":[]}');
  db.close();

  const dryRun = runScript('scripts/recover_missing_project_files.mjs');
  assert(dryRun.status === 0, `Dry run failed: ${dryRun.stderr || dryRun.stdout}`);
  assert(!fs.existsSync(targetPath), 'Dry run modified the missing target');
  const dryReport = JSON.parse(dryRun.stdout);
  assert(dryReport.highConfidenceCount === 1 && dryReport.missingCount === 1, 'Dry run did not identify the recoverable file');

  const apply = runScript('scripts/recover_missing_project_files.mjs', ['--apply']);
  assert(apply.status === 0, `Apply failed: ${apply.stderr || apply.stdout}`);
  assert(fs.readFileSync(targetPath, 'utf8') === fs.readFileSync(sourcePath, 'utf8'), 'Recovered file content differs from the source');

  const sessionDryRun = runScript('scripts/recover_missing_figure_sessions.mjs');
  assert(sessionDryRun.status === 0, `Session dry run failed: ${sessionDryRun.stderr || sessionDryRun.stdout}`);
  assert(JSON.parse(sessionDryRun.stdout).missingCount === 1, 'Session dry run did not detect the missing durable session');
  const sessionApply = runScript('scripts/recover_missing_figure_sessions.mjs', ['--apply']);
  assert(sessionApply.status === 0, `Session apply failed: ${sessionApply.stderr || sessionApply.stdout}`);

  const audit = runScript('scripts/audit_data_integrity.mjs');
  assert(audit.status === 0, `Audit failed after recovery: ${audit.stderr || audit.stdout}`);
  const auditReport = JSON.parse(audit.stdout);
  assert(auditReport.issueCount === 0, `Audit still reports issues: ${audit.stdout}`);
  console.log(JSON.stringify({ status: 'PASS', recovered: targetPath }, null, 2));
} finally {
  const resolved = path.resolve(tempRoot);
  if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('scifigure-data-integrity-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
