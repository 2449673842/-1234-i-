import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'scifigure.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      script TEXT NOT NULL,
      data_payload TEXT,
      edit_log TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated 
      ON sessions(updated_at);
    CREATE TABLE IF NOT EXISTS project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      columns TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_figures (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      figure_index INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
  `);

  const ignoreDuplicateColumnOnly = (e: unknown) => {
    const msg = String((e as any)?.message || e);
    if (!msg.includes("duplicate column") && !msg.includes("duplicate column name")) {
      throw e;
    }
  };

  // Safe migration for script and file_count columns
  try {
    db.prepare("ALTER TABLE projects ADD COLUMN script TEXT").run();
  } catch (e) {
    ignoreDuplicateColumnOnly(e);
  }
  try {
    db.prepare("ALTER TABLE projects ADD COLUMN file_count INTEGER DEFAULT 0").run();
  } catch (e) {
    ignoreDuplicateColumnOnly(e);
  }
}

export interface ProjectRow {
  id: string;
  name: string;
  spec: string;
  script?: string;
  file_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  group_count: number;
  sample_count: number;
  preview: string | null;
}

export function listProjects(): ProjectSummary[] {
  const rows = getDb().prepare(`
    SELECT id, name, created_at, updated_at, spec
    FROM projects
    ORDER BY updated_at DESC
  `).all() as ProjectRow[];

  return rows.map(r => {
    let spec: any = {};
    try { spec = JSON.parse(r.spec); } catch {}
    const raw = spec.raw_data;
    const groupCount = raw?.groups ? Object.keys(raw.groups).length : 0;
    const sampleCount = raw?.categories?.length ?? 0;
    const preview = typeof spec._preview === 'string' ? spec._preview : null;
    return {
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
      group_count: groupCount,
      sample_count: sampleCount,
      preview,
    };
  });
}

export function getProject(id: string): ProjectRow | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ?? null;
}

export function createProject(id: string, name: string, spec: object): void {
  getDb().prepare('INSERT INTO projects (id, name, spec) VALUES (?, ?, ?)').run(id, name, JSON.stringify(spec));
}

export function updateProject(id: string, name: string, spec: object, script?: string): void {
  if (script !== undefined) {
    getDb().prepare('UPDATE projects SET name = ?, spec = ?, script = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, JSON.stringify(spec), script, id);
  } else {
    getDb().prepare('UPDATE projects SET name = ?, spec = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, JSON.stringify(spec), id);
  }
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// --- Session persistence ---

export interface SessionRow {
  id: string;
  script: string;
  data_payload: string | null;
  edit_log: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function saveSession(id: string, script: string, dataPayload: Record<string, unknown> | null, editLog: unknown[], revision: number): void {
  getDb().prepare(`
    INSERT INTO sessions (id, script, data_payload, edit_log, revision, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      script = excluded.script,
      data_payload = excluded.data_payload,
      edit_log = excluded.edit_log,
      revision = excluded.revision,
      updated_at = datetime('now')
  `).run(id, script, dataPayload ? JSON.stringify(dataPayload) : null, JSON.stringify(editLog), revision);
}

export function getSession(id: string): SessionRow | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ?? null;
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function cleanExpiredSessions(maxAgeMinutes: number = 120): void {
  getDb().prepare(`
    DELETE FROM sessions
    WHERE updated_at < datetime('now', ?)
  `).run(`-${maxAgeMinutes} minutes`);
}

export interface DatasetEntry {
  datasetId: string;
  fileName: string;
  filePath: string;
  columns: string[];
  rowCount: number;
  uploadedAt: string;
}

export interface FigureEntry {
  figureId: string;
  index: number;
  manifest: any;
  editLog: any[];
  revision: number;
  svg: string;
}

export interface SciFigureProject {
  projectId: string;
  name: string;
  script: string;
  datasets: DatasetEntry[];
  figures: FigureEntry[];
  createdAt: string;
  updatedAt: string;
}

function countCjkChars(value: string): number {
  return (value.match(/[\u4e00-\u9fff]/g) || []).length;
}

function normalizeStoredFileName(fileName: string): string {
  const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) {
    return fileName;
  }
  return countCjkChars(decoded) > countCjkChars(fileName) ? decoded : fileName;
}

// Project files helpers
export function addProjectFile(id: string, projectId: string, originalName: string, storedPath: string, columns: string[], rowCount: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO project_files (id, project_id, original_name, stored_path, columns, row_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, originalName, storedPath, JSON.stringify(columns), rowCount);
    
    db.prepare('UPDATE projects SET file_count = file_count + 1 WHERE id = ?').run(projectId);
  })();
}

export function listProjectFiles(projectId: string): DatasetEntry[] {
  const rows = getDb().prepare('SELECT * FROM project_files WHERE project_id = ? ORDER BY uploaded_at ASC').all(projectId) as any[];
  return rows.map(r => ({
    datasetId: r.id,
    fileName: normalizeStoredFileName(r.original_name),
    filePath: r.stored_path,
    columns: JSON.parse(r.columns),
    rowCount: r.row_count,
    uploadedAt: r.uploaded_at
  }));
}

export function getProjectFile(fileId: string): any {
  return getDb().prepare('SELECT * FROM project_files WHERE id = ?').get(fileId);
}

export function deleteProjectFile(projectId: string, fileId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM project_files WHERE id = ? AND project_id = ?').run(fileId, projectId);
    db.prepare('UPDATE projects SET file_count = CASE WHEN file_count > 0 THEN file_count - 1 ELSE 0 END WHERE id = ?').run(projectId);
  })();
}

// Project figures helpers
export function addProjectFigure(id: string, projectId: string, figureIndex: number, sessionId: string): void {
  getDb().prepare(`
    INSERT INTO project_figures (id, project_id, figure_index, session_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      figure_index = excluded.figure_index,
      session_id = excluded.session_id
  `).run(projectId + '_' + figureIndex, projectId, figureIndex, sessionId);
}

export function listProjectFigures(projectId: string): any[] {
  return getDb().prepare('SELECT * FROM project_figures WHERE project_id = ? ORDER BY figure_index ASC').all(projectId) as any[];
}

export function deleteProjectFigures(projectId: string): void {
  getDb().prepare('DELETE FROM project_figures WHERE project_id = ?').run(projectId);
}

export interface FigSessionInput {
  figureIndex: number;
  sessionId: string;
  editLog: any[];
  revision: number;
}

export function replaceProjectFiguresAndSessions(
  projectId: string,
  figures: FigSessionInput[],
  script: string,
  dataPayload: Record<string, unknown> | null
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM project_figures WHERE project_id = ?').run(projectId);
    const insertFig = db.prepare(`
      INSERT INTO project_figures (id, project_id, figure_index, session_id)
      VALUES (?, ?, ?, ?)
    `);
    const insertSession = db.prepare(`
      INSERT INTO sessions (id, script, data_payload, edit_log, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        script = excluded.script,
        data_payload = excluded.data_payload,
        edit_log = excluded.edit_log,
        revision = excluded.revision,
        updated_at = datetime('now')
    `);

    figures.forEach(fig => {
      insertFig.run(projectId + '_' + fig.figureIndex, projectId, fig.figureIndex, fig.sessionId);

      const payload = dataPayload ? JSON.stringify(dataPayload) : null;
      insertSession.run(
        fig.sessionId,
        script,
        payload,
        JSON.stringify(fig.editLog),
        fig.revision
      );
    });
  })();
}
