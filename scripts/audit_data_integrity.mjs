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

function resolveStoredPath(storedPath) {
  return path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(ROOT, storedPath);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`Data integrity audit failed: database not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const userRows = db.prepare('SELECT id, email FROM users').all();
const users = new Set(userRows.map(row => row.id));
const projects = db.prepare('SELECT id, user_id, name, file_count FROM projects').all();
const projectFiles = db.prepare('SELECT id, project_id, original_name AS file_name, stored_path FROM project_files').all();
const exports = db.prepare('SELECT id, project_id, file_path, format, created_at FROM export_assets').all();
const figures = db.prepare('SELECT id, project_id, session_id, edit_log, history FROM project_figures').all();
const sessions = new Map(db.prepare('SELECT id, user_id FROM sessions').all().map(row => [row.id, row]));
db.close();

const issues = [];
const projectById = new Map(projects.map(project => [project.id, project]));
for (const project of projects) {
  if (!project.user_id || !users.has(project.user_id)) {
    issues.push({ kind: 'project_owner', projectId: project.id, name: project.name, userId: project.user_id || null });
  }
  const actualFileCount = projectFiles.filter(file => file.project_id === project.id).length;
  if (Number(project.file_count || 0) !== actualFileCount) {
    issues.push({ kind: 'project_file_count_mismatch', projectId: project.id, name: project.name, recorded: Number(project.file_count || 0), actual: actualFileCount });
  }
}
for (const file of projectFiles) {
  if (!projectById.has(file.project_id)) {
    issues.push({ kind: 'project_file_orphan', projectId: file.project_id, fileId: file.id, fileName: file.file_name });
    continue;
  }
  const absolute = resolveStoredPath(file.stored_path);
  if (!fs.existsSync(absolute)) {
    const project = projectById.get(file.project_id);
    issues.push({ kind: 'project_file_missing', projectId: file.project_id, projectName: project?.name || null, fileId: file.id, fileName: file.file_name, storedPath: file.stored_path });
  }
}
for (const asset of exports) {
  if (!projectById.has(asset.project_id)) {
    issues.push({ kind: 'export_asset_orphan', projectId: asset.project_id, assetId: asset.id, format: asset.format });
    continue;
  }
  const absolute = resolveStoredPath(asset.file_path);
  if (!fs.existsSync(absolute)) {
    issues.push({ kind: 'export_file_missing', projectId: asset.project_id, assetId: asset.id, format: asset.format, filePath: asset.file_path, createdAt: asset.created_at });
  }
}

for (const figure of figures) {
  const project = projectById.get(figure.project_id);
  if (!project) {
    issues.push({ kind: 'project_figure_orphan', projectId: figure.project_id, figureId: figure.id });
    continue;
  }
  const session = sessions.get(figure.session_id);
  if (!session) {
    issues.push({ kind: 'project_figure_session_missing', projectId: figure.project_id, projectName: project.name, figureId: figure.id, sessionId: figure.session_id });
  } else if (project.user_id && session.user_id !== project.user_id) {
    issues.push({ kind: 'project_figure_session_owner_mismatch', projectId: figure.project_id, projectName: project.name, figureId: figure.id, sessionId: figure.session_id });
  }
  for (const [field, value] of [['edit_log', figure.edit_log], ['history', figure.history]]) {
    try {
      JSON.parse(value || (field === 'history' ? '{"past":[],"future":[]}' : '[]'));
    } catch {
      issues.push({ kind: 'project_figure_json_invalid', projectId: figure.project_id, projectName: project.name, figureId: figure.id, field });
    }
  }
}

const testUsers = userRows.filter(user => /(?:@example\.test$|@scifigure\.local$|^(?:smoke|cache|perf|sandbox|refresh|isolation-|security-|inspect-|capability-))/i.test(user.email));
const warnings = testUsers.map(user => ({
  kind: 'test_account_in_real_database',
  userId: user.id,
  email: user.email,
  projectCount: projects.filter(project => project.user_id === user.id).length,
}));

const summary = {
  checkedAt: new Date().toISOString(),
  dataRoot: DATA_ROOT,
  counts: { users: users.size, projects: projects.length, projectFiles: projectFiles.length, exportAssets: exports.length },
  issueCount: issues.length,
  warningCount: warnings.length,
  issuesByKind: Object.fromEntries(
    [...new Set(issues.map(issue => issue.kind))].map(kind => [kind, issues.filter(issue => issue.kind === kind).length]),
  ),
  affectedProjects: projects
    .map(project => {
      const projectIssues = issues.filter(issue => issue.projectId === project.id);
      return projectIssues.length > 0
        ? { projectId: project.id, projectName: project.name, issueCount: projectIssues.length }
        : null;
    })
    .filter(Boolean),
  warnings,
  issues,
};
console.log(JSON.stringify(summary, null, 2));
if (issues.length > 0) process.exitCode = 1;
