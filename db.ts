import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

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
    CREATE TABLE IF NOT EXISTS export_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      figure_id TEXT,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      dpi INTEGER,
      file_path TEXT NOT NULL,
      thumbnail_svg TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_export_assets_project_created
      ON export_assets(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash
      ON auth_sessions(token_hash);
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
      ON subscriptions(user_id, status, ends_at);
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      plan TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS redeem_records (
      id TEXT PRIMARY KEY,
      code_id TEXT NOT NULL REFERENCES redeem_codes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
      device_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_records_code_user
      ON redeem_records(code_id, user_id);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_fingerprint TEXT NOT NULL,
      name TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, device_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS license_checks (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      device_id TEXT,
      result TEXT NOT NULL,
      reason TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function hashAuthToken(token: string): string {
  return sha256(token);
}

export function hashRedeemCode(code: string): string {
  return sha256(code.trim().toUpperCase());
}

export interface UserAccount {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthUserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  created_at: string;
  last_login_at: string | null;
}

export interface LicenseState {
  plan: string;
  status: 'free' | 'pro' | 'expired';
  source: string;
  endsAt: string | null;
  isPro: boolean;
}

function mapUser(row: AuthUserRow): UserAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function createUserAccount(email: string, password: string, displayName?: string): UserAccount {
  const normalizedEmail = email.trim().toLowerCase();
  const { hash, salt } = hashPassword(password);
  const id = `usr_${crypto.randomUUID()}`;
  getDb().prepare(`
    INSERT INTO users (id, email, display_name, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, normalizedEmail, displayName?.trim() || null, hash, salt);
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as AuthUserRow;
  return mapUser(row);
}

export function getUserByEmail(email: string): AuthUserRow | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as AuthUserRow | undefined;
  return row ?? null;
}

export function getUserById(userId: string): UserAccount | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as AuthUserRow | undefined;
  return row ? mapUser(row) : null;
}

export function touchUserLogin(userId: string): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
}

export function createAuthSession(userId: string, token: string, deviceId?: string | null, ttlDays = 30): void {
  getDb().prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, device_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`ses_${crypto.randomUUID()}`, userId, hashAuthToken(token), deviceId ?? null, addDaysIso(ttlDays));
}

export function getUserByAuthToken(token: string): UserAccount | null {
  const row = getDb().prepare(`
    SELECT u.*
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')
  `).get(hashAuthToken(token)) as AuthUserRow | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE token_hash = ?").run(hashAuthToken(token));
  return mapUser(row);
}

export function revokeAuthToken(token: string): number {
  return getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashAuthToken(token)).changes;
}

export function upsertDevice(userId: string, deviceFingerprint: string, name?: string | null): string {
  const id = `dev_${crypto.randomUUID()}`;
  getDb().prepare(`
    INSERT INTO devices (id, user_id, device_fingerprint, name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, device_fingerprint) DO UPDATE SET
      name = COALESCE(excluded.name, devices.name),
      last_seen_at = datetime('now')
  `).run(id, userId, deviceFingerprint, name ?? null);
  const row = getDb().prepare('SELECT id FROM devices WHERE user_id = ? AND device_fingerprint = ?').get(userId, deviceFingerprint) as { id: string };
  return row.id;
}

export function getActiveDeviceCount(userId: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM devices
    WHERE user_id = ? AND datetime(last_seen_at) > datetime('now', '-45 days')
  `).get(userId) as { count: number };
  return row.count;
}

export function getLicenseState(userId: string | null): LicenseState {
  if (!userId) {
    return { plan: 'free', status: 'free', source: 'anonymous', endsAt: null, isPro: false };
  }
  const row = getDb().prepare(`
    SELECT plan, status, source, ends_at
    FROM subscriptions
    WHERE user_id = ?
      AND status = 'active'
      AND (ends_at IS NULL OR datetime(ends_at) > datetime('now'))
    ORDER BY CASE WHEN ends_at IS NULL THEN 1 ELSE 0 END DESC, ends_at DESC
    LIMIT 1
  `).get(userId) as { plan: string; status: string; source: string; ends_at: string | null } | undefined;
  if (!row) {
    return { plan: 'free', status: 'free', source: 'none', endsAt: null, isPro: false };
  }
  return { plan: row.plan, status: 'pro', source: row.source, endsAt: row.ends_at, isPro: row.plan === 'pro' };
}

export function createRedeemCode(args: {
  code: string;
  label?: string;
  plan?: string;
  durationDays: number;
  maxUses?: number;
  expiresAt?: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO redeem_codes (id, code_hash, label, plan, duration_days, max_uses, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `rc_${crypto.randomUUID()}`,
    hashRedeemCode(args.code),
    args.label ?? null,
    args.plan ?? 'pro',
    args.durationDays,
    args.maxUses ?? 1,
    args.expiresAt ?? null
  );
}

export function redeemCodeForUser(userId: string, code: string, deviceId?: string | null): LicenseState {
  const db = getDb();
  return db.transaction(() => {
    const codeHash = hashRedeemCode(code);
    const redeem = db.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').get(codeHash) as any | undefined;
    if (!redeem) throw new Error('兑换码不存在');
    if (redeem.disabled_at) throw new Error('兑换码已停用');
    if (redeem.expires_at && new Date(redeem.expires_at).getTime() < Date.now()) throw new Error('兑换码已过期');
    if (redeem.used_count >= redeem.max_uses) throw new Error('兑换码使用次数已用完');

    const already = db.prepare('SELECT id FROM redeem_records WHERE code_id = ? AND user_id = ?').get(redeem.id, userId);
    if (already) throw new Error('该账号已使用过此兑换码');

    db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE id = ?').run(redeem.id);
    db.prepare(`
      INSERT INTO redeem_records (id, code_id, user_id, device_id)
      VALUES (?, ?, ?, ?)
    `).run(`rr_${crypto.randomUUID()}`, redeem.id, userId, deviceId ?? null);

    const current = getLicenseState(userId);
    const baseTime = current.isPro && current.endsAt ? Math.max(Date.now(), new Date(current.endsAt).getTime()) : Date.now();
    const nextEnd = new Date(baseTime + redeem.duration_days * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, plan, status, starts_at, ends_at, source)
      VALUES (?, ?, ?, 'active', ?, ?, 'redeem_code')
    `).run(`sub_${crypto.randomUUID()}`, userId, redeem.plan, nowIso(), nextEnd);
    return getLicenseState(userId);
  })();
}

export function logLicenseCheck(userId: string | null, deviceId: string | null, result: string, reason?: string): void {
  getDb().prepare(`
    INSERT INTO license_checks (id, user_id, device_id, result, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(`lc_${crypto.randomUUID()}`, userId, deviceId, result, reason ?? null);
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

export interface ExportAssetInput {
  id: string;
  projectId: string;
  figureId: string | null;
  name: string;
  format: string;
  dpi?: number | null;
  filePath: string;
  thumbnailSvg?: string | null;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ExportAsset {
  assetId: string;
  projectId: string;
  figureId: string | null;
  name: string;
  format: string;
  dpi: number | null;
  filePath: string;
  thumbnailSvg: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
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

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapExportAsset(row: any): ExportAsset {
  return {
    assetId: row.id,
    projectId: row.project_id,
    figureId: row.figure_id ?? null,
    name: row.name,
    format: row.format,
    dpi: row.dpi ?? null,
    filePath: row.file_path,
    thumbnailSvg: row.thumbnail_svg ?? null,
    metadata: parseJsonField<Record<string, unknown>>(row.metadata, {}),
    tags: parseJsonField<string[]>(row.tags, []),
    createdAt: row.created_at,
  };
}

export function addExportAsset(input: ExportAssetInput): ExportAsset {
  getDb().prepare(`
    INSERT INTO export_assets (
      id, project_id, figure_id, name, format, dpi, file_path, thumbnail_svg, metadata, tags
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.figureId,
    input.name,
    input.format.toLowerCase(),
    input.dpi ?? null,
    input.filePath,
    input.thumbnailSvg ?? null,
    JSON.stringify(input.metadata ?? {}),
    JSON.stringify(input.tags ?? [])
  );
  const asset = getExportAsset(input.id);
  if (!asset) {
    throw new Error('导出资产写入失败');
  }
  return asset;
}

export function listExportAssets(projectId: string): ExportAsset[] {
  const rows = getDb().prepare(`
    SELECT * FROM export_assets
    WHERE project_id = ?
    ORDER BY created_at DESC
  `).all(projectId) as any[];
  return rows.map(mapExportAsset);
}

export function getExportAsset(assetId: string): ExportAsset | null {
  const row = getDb().prepare('SELECT * FROM export_assets WHERE id = ?').get(assetId) as any | undefined;
  return row ? mapExportAsset(row) : null;
}

export function deleteExportAssets(projectId: string, assetIds: string[]): number {
  if (assetIds.length === 0) return 0;
  const db = getDb();
  return db.transaction(() => {
    let count = 0;
    const stmt = db.prepare('DELETE FROM export_assets WHERE project_id = ? AND id = ?');
    for (const assetId of assetIds) {
      count += stmt.run(projectId, assetId).changes;
    }
    return count;
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
      INSERT INTO project_figures (id, project_id, figure_index, session_id, revision)
      VALUES (?, ?, ?, ?, ?)
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
      insertFig.run(projectId + '_' + fig.figureIndex, projectId, fig.figureIndex, fig.sessionId, fig.revision);

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
