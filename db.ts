import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import argon2 from 'argon2';
import { resolvePlanEntitlements, type PlanEntitlements } from './src/schemas/planEntitlements';

const DATA_ROOT = process.env.SCIFIGURE_DATA_DIR
  ? path.resolve(process.env.SCIFIGURE_DATA_DIR)
  : path.join(process.cwd(), 'data');

const DB_PATH = process.env.SCIFIGURE_DB_PATH
  ? path.resolve(process.env.SCIFIGURE_DB_PATH)
  : path.join(DATA_ROOT, 'scifigure.db');

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
      user_id TEXT,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
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
      revision INTEGER NOT NULL DEFAULT 1,
      edit_log TEXT NOT NULL DEFAULT '[]',
      history TEXT NOT NULL DEFAULT '{"past":[],"future":[]}'
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
    CREATE TABLE IF NOT EXISTS export_asset_snapshots (
      asset_id TEXT PRIMARY KEY REFERENCES export_assets(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      figure_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_export_asset_snapshots_project_created
      ON export_asset_snapshots(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      email_verified_at TEXT,
      email_verification_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS email_verification_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      consumed_at TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_verification_user_expiry
      ON email_verification_challenges(user_id, expires_at DESC);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT UNIQUE,
      device_id TEXT,
      expires_at TEXT NOT NULL,
      refresh_expires_at TEXT,
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
      actor_user_id TEXT,
      change_reason TEXT,
      admin_note TEXT,
      request_id TEXT,
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
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      status_code INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created
      ON admin_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
      ON admin_audit_logs(actor_user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_reauth_tokens (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_reauth_actor_expiry
      ON admin_reauth_tokens(actor_user_id, expires_at);
    CREATE TABLE IF NOT EXISTS admin_idempotency_requests (
      request_id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_idempotency_actor_created
      ON admin_idempotency_requests(actor_user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS error_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      title TEXT,
      message TEXT,
      component TEXT,
      operation TEXT,
      error_name TEXT,
      error_code TEXT,
      route TEXT,
      project_id TEXT,
      figure_id TEXT,
      client_version TEXT,
      user_agent_family TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_error_reports_last_seen
      ON error_reports(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_error_reports_filters
      ON error_reports(source, severity, status, last_seen_at DESC);
    CREATE TABLE IF NOT EXISTS usage_budgets (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      window_start TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, category, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_budgets_window
      ON usage_budgets(window_start);
    CREATE TABLE IF NOT EXISTS global_usage_budgets (
      category TEXT NOT NULL,
      window_start TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (category, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_global_usage_budgets_window
      ON global_usage_budgets(window_start);
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
  [
    "ALTER TABLE projects ADD COLUMN user_id TEXT",
    "ALTER TABLE sessions ADD COLUMN user_id TEXT",
    "ALTER TABLE users ADD COLUMN password_algorithm TEXT DEFAULT 'pbkdf2_sha256'",
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE users ADD COLUMN email_verified_at TEXT",
    "ALTER TABLE users ADD COLUMN email_verification_required INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE auth_sessions ADD COLUMN refresh_token_hash TEXT",
    "ALTER TABLE auth_sessions ADD COLUMN refresh_expires_at TEXT",
    "ALTER TABLE subscriptions ADD COLUMN actor_user_id TEXT",
    "ALTER TABLE subscriptions ADD COLUMN change_reason TEXT",
    "ALTER TABLE subscriptions ADD COLUMN admin_note TEXT",
    "ALTER TABLE subscriptions ADD COLUMN request_id TEXT",
    "ALTER TABLE error_reports ADD COLUMN project_id TEXT",
    "ALTER TABLE error_reports ADD COLUMN figure_id TEXT",
  ].forEach((sql) => {
    try {
      db.prepare(sql).run();
    } catch (e) {
      ignoreDuplicateColumnOnly(e);
    }
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_user_updated
      ON projects(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
      ON sessions(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_files_project
      ON project_files(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_figures_project
      ON project_figures(project_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expires
      ON auth_sessions(user_id, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_refresh_hash
      ON auth_sessions(refresh_token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_request_id
      ON subscriptions(request_id) WHERE request_id IS NOT NULL;
  `);
  [
    "ALTER TABLE project_figures ADD COLUMN preview_svg TEXT",
    "ALTER TABLE project_figures ADD COLUMN manifest TEXT",
    "ALTER TABLE project_figures ADD COLUMN code_slice TEXT",
    "ALTER TABLE project_figures ADD COLUMN fingerprint TEXT",
    "ALTER TABLE project_figures ADD COLUMN preview_updated_at TEXT",
    "ALTER TABLE project_figures ADD COLUMN edit_log TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE project_figures ADD COLUMN history TEXT NOT NULL DEFAULT '{\"past\":[],\"future\":[]}'",
  ].forEach((sql) => {
    try {
      db.prepare(sql).run();
    } catch (e) {
      ignoreDuplicateColumnOnly(e);
    }
  });
  db.exec(`
    UPDATE project_figures
    SET edit_log = COALESCE(
      (SELECT s.edit_log FROM sessions AS s WHERE s.id = project_figures.session_id),
      edit_log
    )
    WHERE (edit_log IS NULL OR edit_log = '[]');

    UPDATE project_figures
    SET edit_log = COALESCE(
      (
        SELECT json_extract(p.spec, '$.editLog')
        FROM projects AS p
        WHERE p.id = project_figures.project_id
          AND json_valid(p.spec)
          AND json_type(p.spec, '$.editLog') = 'array'
          AND (
            SELECT COUNT(*)
            FROM project_figures AS only_pf
            WHERE only_pf.project_id = project_figures.project_id
          ) = 1
      ),
      edit_log
    )
    WHERE (edit_log IS NULL OR edit_log = '[]');
  `);
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

function verifyLegacyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export async function hashPasswordArgon2(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPasswordAndMigrate(row: AuthUserRow, password: string): Promise<boolean> {
  const algorithm = row.password_algorithm || 'pbkdf2_sha256';
  if (algorithm === 'argon2id' || row.password_hash.startsWith('$argon2id$')) {
    return argon2.verify(row.password_hash, password);
  }
  const valid = verifyLegacyPassword(password, row.password_salt, row.password_hash);
  if (!valid) return false;
  const nextHash = await hashPasswordArgon2(password);
  getDb().prepare(`
    UPDATE users SET password_hash = ?, password_salt = '', password_algorithm = 'argon2id'
    WHERE id = ?
  `).run(nextHash, row.id);
  return true;
}

export function hashAuthToken(token: string): string {
  return sha256(token);
}

export function hashRedeemCode(code: string): string {
  return sha256(code.trim().toUpperCase());
}

export type UserRole = 'user' | 'admin';

export interface UserAccount {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  emailVerified: boolean;
  emailVerificationRequired: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthUserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  password_algorithm: string | null;
  role: string | null;
  email_verified_at: string | null;
  email_verification_required: number | null;
  created_at: string;
  last_login_at: string | null;
}

export interface LicenseState {
  plan: string;
  status: 'free' | 'pro' | 'expired';
  source: string;
  endsAt: string | null;
  isPro: boolean;
  entitlements: PlanEntitlements;
}

function mapUser(row: AuthUserRow): UserAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    emailVerified: Boolean(row.email_verified_at) || row.email_verification_required !== 1,
    emailVerificationRequired: row.email_verification_required === 1 && !row.email_verified_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function createUserAccount(
  email: string,
  password: string,
  displayName?: string,
  options: { emailVerificationRequired?: boolean } = {},
): Promise<UserAccount> {
  const normalizedEmail = email.trim().toLowerCase();
  const hash = await hashPasswordArgon2(password);
  const id = `usr_${crypto.randomUUID()}`;
  const verificationRequired = options.emailVerificationRequired === true;
  getDb().prepare(`
    INSERT INTO users (
      id, email, display_name, password_hash, password_salt, password_algorithm,
      email_verified_at, email_verification_required
    )
    VALUES (?, ?, ?, ?, '', 'argon2id', ?, ?)
  `).run(
    id,
    normalizedEmail,
    displayName?.trim() || null,
    hash,
    verificationRequired ? null : nowIso(),
    verificationRequired ? 1 : 0,
  );
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as AuthUserRow;
  claimLegacyOwnership(id);
  return mapUser(row);
}

export interface EmailVerificationChallenge {
  id: string;
  userId: string;
  expiresAt: string;
  attemptCount: number;
  maxAttempts: number;
}

export type EmailVerificationConsumeResult =
  | { status: 'verified'; user: UserAccount }
  | { status: 'invalid' | 'expired' | 'locked'; user: null };

export function createEmailVerificationChallenge(input: {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: string;
  maxAttempts?: number;
}): EmailVerificationChallenge {
  const database = getDb();
  return database.transaction(() => {
    database.prepare(`
      UPDATE email_verification_challenges
      SET consumed_at = COALESCE(consumed_at, datetime('now'))
      WHERE user_id = ? AND consumed_at IS NULL
    `).run(input.userId);
    database.prepare(`
      DELETE FROM email_verification_challenges
      WHERE datetime(expires_at) <= datetime('now', '-1 day')
    `).run();
    const maxAttempts = Math.max(3, Math.min(10, Math.floor(input.maxAttempts || 5)));
    database.prepare(`
      INSERT INTO email_verification_challenges (
        id, user_id, code_hash, expires_at, max_attempts
      ) VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.userId, input.codeHash, input.expiresAt, maxAttempts);
    return {
      id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
      attemptCount: 0,
      maxAttempts,
    };
  })();
}

function constantTimeHashEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function consumeEmailVerificationChallenge(
  challengeId: string,
  candidateCodeHash: string,
): EmailVerificationConsumeResult {
  const database = getDb();
  return database.transaction((): EmailVerificationConsumeResult => {
    const row = database.prepare(`
      SELECT id, user_id, code_hash, expires_at, attempt_count, max_attempts, consumed_at
      FROM email_verification_challenges
      WHERE id = ?
      LIMIT 1
    `).get(challengeId) as {
      id: string;
      user_id: string;
      code_hash: string;
      expires_at: string;
      attempt_count: number;
      max_attempts: number;
      consumed_at: string | null;
    } | undefined;
    if (!row || row.consumed_at) return { status: 'invalid', user: null };
    if (Date.parse(row.expires_at) <= Date.now()) {
      database.prepare("UPDATE email_verification_challenges SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
      return { status: 'expired', user: null };
    }
    if (row.attempt_count >= row.max_attempts) return { status: 'locked', user: null };

    if (!constantTimeHashEqual(candidateCodeHash, row.code_hash)) {
      const nextAttempts = row.attempt_count + 1;
      database.prepare(`
        UPDATE email_verification_challenges
        SET attempt_count = ?, consumed_at = CASE WHEN ? >= max_attempts THEN datetime('now') ELSE consumed_at END
        WHERE id = ?
      `).run(nextAttempts, nextAttempts, row.id);
      return { status: nextAttempts >= row.max_attempts ? 'locked' : 'invalid', user: null };
    }

    database.prepare(`
      UPDATE email_verification_challenges
      SET consumed_at = datetime('now')
      WHERE user_id = ? AND consumed_at IS NULL
    `).run(row.user_id);
    database.prepare(`
      UPDATE users
      SET email_verified_at = COALESCE(email_verified_at, datetime('now')),
          email_verification_required = 0
      WHERE id = ?
    `).run(row.user_id);
    const userRow = database.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as AuthUserRow;
    return { status: 'verified', user: mapUser(userRow) };
  })();
}

export function claimLegacyOwnership(requestingUserId: string): void {
  const configuredOwnerEmail = process.env.SCIFIGURE_LEGACY_OWNER_EMAIL?.trim().toLowerCase();
  if (!configuredOwnerEmail) return;

  const database = getDb();
  database.transaction(() => {
    const configuredOwner = database.prepare(`
      SELECT id FROM users WHERE email = ? LIMIT 1
    `).get(configuredOwnerEmail) as { id: string } | undefined;
    if (!configuredOwner || configuredOwner.id !== requestingUserId) return;

    const ownerUserId = configuredOwner.id;
    database.prepare(`
      UPDATE projects SET user_id = ? WHERE user_id IS NULL OR user_id = ''
    `).run(ownerUserId);
    database.prepare(`
      UPDATE sessions
      SET user_id = COALESCE(
        (
          SELECT p.user_id
          FROM project_figures pf
          JOIN projects p ON p.id = pf.project_id
          WHERE pf.session_id = sessions.id
          LIMIT 1
        ),
        ?
      )
      WHERE user_id IS NULL OR user_id = ''
    `).run(ownerUserId);
  })();
}

export function getUserByEmail(email: string): AuthUserRow | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as AuthUserRow | undefined;
  return row ?? null;
}

export function getUserById(userId: string): UserAccount | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as AuthUserRow | undefined;
  return row ? mapUser(row) : null;
}

export function setUserRoleByEmail(email: string, role: UserRole): UserAccount {
  const normalizedEmail = email.trim().toLowerCase();
  if (role !== 'user' && role !== 'admin') {
    throw new Error('无效的用户角色');
  }
  const result = getDb().prepare('UPDATE users SET role = ? WHERE email = ?').run(role, normalizedEmail);
  if (result.changes !== 1) {
    throw new Error(`未找到用户: ${normalizedEmail}`);
  }
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as AuthUserRow;
  return mapUser(row);
}

export interface AdminAuditLogInput {
  actorUserId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  success: boolean;
  statusCode?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AdminAuditLogEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  success: boolean;
  statusCode: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function logAdminAudit(input: AdminAuditLogInput): void {
  const metadata = JSON.stringify(input.metadata ?? {}).slice(0, 16_384);
  getDb().prepare(`
    INSERT INTO admin_audit_logs (
      id, actor_user_id, action, resource_type, resource_id, success,
      status_code, ip_address, user_agent, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `aal_${crypto.randomUUID()}`,
    input.actorUserId ?? null,
    input.action,
    input.resourceType ?? null,
    input.resourceId ?? null,
    input.success ? 1 : 0,
    input.statusCode ?? null,
    input.ipAddress?.slice(0, 128) ?? null,
    input.userAgent?.slice(0, 512) ?? null,
    metadata,
  );
}

export type ErrorReportSeverity = 'info' | 'warning' | 'error' | 'critical';
export type ErrorReportStatus = 'open' | 'triaged' | 'resolved' | 'ignored';

export interface ErrorReportInput {
  userId: string;
  source: string;
  severity: ErrorReportSeverity;
  title?: string | null;
  message?: string | null;
  component?: string | null;
  operation?: string | null;
  errorName?: string | null;
  errorCode?: string | null;
  route?: string | null;
  projectId?: string | null;
  figureId?: string | null;
  clientVersion?: string | null;
  userAgentFamily?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ErrorReportSummary {
  id: string;
  userId: string;
  source: string;
  severity: ErrorReportSeverity;
  status: ErrorReportStatus;
  title: string | null;
  message: string | null;
  component: string | null;
  operation: string | null;
  errorName: string | null;
  errorCode: string | null;
  route: string | null;
  projectId: string | null;
  figureId: string | null;
  clientVersion: string | null;
  userAgentFamily: string | null;
  fingerprint: string;
  occurrenceCount: number;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ErrorReportListResult {
  reports: ErrorReportSummary[];
  page: number;
  pageSize: number;
  total: number;
}

function normalizeErrorReportSeverity(value: string): ErrorReportSeverity {
  return value === 'critical' || value === 'warning' || value === 'info' ? value : 'error';
}

function normalizeErrorReportStatus(value: string): ErrorReportStatus {
  return value === 'triaged' || value === 'resolved' || value === 'ignored' ? value : 'open';
}

function errorReportFingerprint(input: ErrorReportInput): string {
  return sha256(JSON.stringify({
    userId: input.userId,
    source: input.source,
    severity: input.severity,
    title: input.title || '',
    message: input.message || '',
    component: input.component || '',
    operation: input.operation || '',
    errorName: input.errorName || '',
    errorCode: input.errorCode || '',
    route: input.route || '',
    projectId: input.projectId || '',
    figureId: input.figureId || '',
  }));
}

function mapErrorReport(row: any): ErrorReportSummary {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch {
    metadata = { invalidMetadata: true };
  }
  return {
    id: row.id,
    userId: row.user_id,
    source: row.source,
    severity: normalizeErrorReportSeverity(row.severity),
    status: normalizeErrorReportStatus(row.status),
    title: row.title ?? null,
    message: row.message ?? null,
    component: row.component ?? null,
    operation: row.operation ?? null,
    errorName: row.error_name ?? null,
    errorCode: row.error_code ?? null,
    route: row.route ?? null,
    projectId: row.project_id ?? null,
    figureId: row.figure_id ?? null,
    clientVersion: row.client_version ?? null,
    userAgentFamily: row.user_agent_family ?? null,
    fingerprint: row.fingerprint,
    occurrenceCount: Number(row.occurrence_count || 0),
    metadata,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function upsertErrorReport(input: ErrorReportInput): ErrorReportSummary {
  const fingerprint = errorReportFingerprint(input);
  const db = getDb();
  db.prepare(`
    INSERT INTO error_reports (
      id, user_id, source, severity, title, message, component, operation,
      error_name, error_code, route, project_id, figure_id, client_version,
      user_agent_family, fingerprint, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      occurrence_count = occurrence_count + 1,
      last_seen_at = datetime('now'),
      metadata = excluded.metadata
  `).run(
    `er_${crypto.randomUUID()}`,
    input.userId,
    input.source,
    input.severity,
    input.title ?? null,
    input.message ?? null,
    input.component ?? null,
    input.operation ?? null,
    input.errorName ?? null,
    input.errorCode ?? null,
    input.route ?? null,
    input.projectId ?? null,
    input.figureId ?? null,
    input.clientVersion ?? null,
    input.userAgentFamily ?? null,
    fingerprint,
    JSON.stringify(input.metadata ?? {}).slice(0, 4096),
  );
  const row = db.prepare('SELECT * FROM error_reports WHERE fingerprint = ?').get(fingerprint);
  return mapErrorReport(row);
}

export function listErrorReports(args: {
  page?: number;
  pageSize?: number;
  source?: string | null;
  severity?: string | null;
  status?: string | null;
  query?: string | null;
}): ErrorReportListResult {
  const page = Math.max(1, Math.floor(Number(args.page || 1)));
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(args.pageSize || 25))));
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.source) {
    where.push('er.source = ?');
    params.push(args.source);
  }
  if (args.severity) {
    where.push('er.severity = ?');
    params.push(args.severity);
  }
  if (args.status) {
    where.push('er.status = ?');
    params.push(args.status);
  }
  if (args.query) {
    where.push('(er.title LIKE ? OR er.message LIKE ? OR er.component LIKE ? OR er.error_code LIKE ?)');
    const like = `%${args.query}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM error_reports er
    ${whereSql}
  `).get(...params) as { count: number }).count;
  const rows = getDb().prepare(`
    SELECT er.*
    FROM error_reports er
    ${whereSql}
    ORDER BY er.last_seen_at DESC, er.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  return { reports: rows.map(mapErrorReport), page, pageSize, total };
}

export function getErrorReportById(id: string): ErrorReportSummary | null {
  const row = getDb().prepare('SELECT * FROM error_reports WHERE id = ?').get(id);
  return row ? mapErrorReport(row) : null;
}

export function listAdminAuditLogs(limit = 100): AdminAuditLogEntry[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = getDb().prepare(`
    SELECT * FROM admin_audit_logs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(safeLimit) as Array<{
    id: string;
    actor_user_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    success: number;
    status_code: number | null;
    ip_address: string | null;
    user_agent: string | null;
    metadata: string;
    created_at: string;
  }>;
  return rows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata || '{}');
    } catch {
      metadata = { invalidMetadata: true };
    }
    return {
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      success: row.success === 1,
      statusCode: row.status_code,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      metadata,
      createdAt: row.created_at,
    };
  });
}

export function touchUserLogin(userId: string): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
}

export function createAuthSession(
  userId: string,
  accessToken: string,
  refreshToken: string,
  deviceId?: string | null,
  accessTtlMinutes = 15,
  refreshTtlDays = 30,
): void {
  getDb().prepare(`
    INSERT INTO auth_sessions (
      id, user_id, token_hash, refresh_token_hash, device_id, expires_at, refresh_expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `ses_${crypto.randomUUID()}`,
    userId,
    hashAuthToken(accessToken),
    hashAuthToken(refreshToken),
    deviceId ?? null,
    new Date(Date.now() + accessTtlMinutes * 60 * 1000).toISOString(),
    addDaysIso(refreshTtlDays),
  );
}

export function getUserByAuthToken(token: string): UserAccount | null {
  const row = getDb().prepare(`
    SELECT u.*
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND datetime(s.expires_at) > datetime('now')
      AND (COALESCE(u.email_verification_required, 0) = 0 OR u.email_verified_at IS NOT NULL)
  `).get(hashAuthToken(token)) as AuthUserRow | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE token_hash = ?").run(hashAuthToken(token));
  return mapUser(row);
}

export function revokeAuthToken(token: string): number {
  return getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashAuthToken(token)).changes;
}

export function rotateRefreshSession(refreshToken: string, nextAccessToken: string, nextRefreshToken: string, accessTtlMinutes = 15): UserAccount | null {
  const database = getDb();
  return database.transaction(() => {
    const row = database.prepare(`
      SELECT s.id AS session_id, s.refresh_expires_at, u.*
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
        AND datetime(s.refresh_expires_at) > datetime('now')
        AND (COALESCE(u.email_verification_required, 0) = 0 OR u.email_verified_at IS NOT NULL)
    `).get(hashAuthToken(refreshToken)) as (AuthUserRow & { session_id: string; refresh_expires_at: string }) | undefined;
    if (!row) return null;
    database.prepare(`
      UPDATE auth_sessions
      SET token_hash = ?, refresh_token_hash = ?, expires_at = ?, last_seen_at = datetime('now')
      WHERE id = ?
    `).run(
      hashAuthToken(nextAccessToken),
      hashAuthToken(nextRefreshToken),
      new Date(Date.now() + accessTtlMinutes * 60 * 1000).toISOString(),
      row.session_id,
    );
    return mapUser(row);
  })();
}

export function revokeRefreshToken(refreshToken: string): number {
  return getDb().prepare('DELETE FROM auth_sessions WHERE refresh_token_hash = ?').run(hashAuthToken(refreshToken)).changes;
}

export function revokeAllUserSessions(userId: string): number {
  return getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId).changes;
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
    return {
      plan: 'free', status: 'free', source: 'anonymous', endsAt: null, isPro: false,
      entitlements: resolvePlanEntitlements({ authenticated: false, isPro: false }),
    };
  }
  const row = getDb().prepare(`
    SELECT plan, status, source, ends_at
    FROM subscriptions
    WHERE user_id = ?
      AND plan = 'pro'
      AND status = 'active'
      AND (ends_at IS NULL OR datetime(ends_at) > datetime('now'))
    ORDER BY CASE WHEN ends_at IS NULL THEN 1 ELSE 0 END DESC, ends_at DESC
    LIMIT 1
  `).get(userId) as { plan: string; status: string; source: string; ends_at: string | null } | undefined;
  if (!row) {
    return {
      plan: 'free', status: 'free', source: 'none', endsAt: null, isPro: false,
      entitlements: resolvePlanEntitlements({ authenticated: true, isPro: false }),
    };
  }
  const isPro = row.plan === 'pro';
  return {
    plan: row.plan,
    status: 'pro',
    source: row.source,
    endsAt: row.ends_at,
    isPro,
    entitlements: resolvePlanEntitlements({ authenticated: true, isPro }),
  };
}

export interface UsageBudgetResult {
  allowed: boolean;
  used: number;
  limit: number;
  resetAt: string;
}

export interface ScopedUsageBudgetResult extends UsageBudgetResult {
  blockedScope: 'user' | 'global' | null;
  globalUsed: number;
  globalLimit: number;
}

export function consumeScopedHourlyUsageBudget(
  userId: string,
  category: string,
  amount: number,
  userLimit: number,
  globalLimit: number,
  nowMs = Date.now(),
): ScopedUsageBudgetResult {
  if (!userId) throw new Error('Usage budget requires a user ID');
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(category)) throw new Error('Invalid usage budget category');
  const safeAmount = Math.max(0, Math.floor(Number(amount || 0)));
  const safeUserLimit = Math.max(1, Math.floor(Number(userLimit || 0)));
  const safeGlobalLimit = Math.max(1, Math.floor(Number(globalLimit || 0)));
  const windowStartMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const windowStart = new Date(windowStartMs).toISOString();
  const resetAt = new Date(windowStartMs + 3_600_000).toISOString();
  const database = getDb();
  const consume = database.transaction(() => {
    const retentionCutoff = new Date(windowStartMs - 48 * 3_600_000).toISOString();
    database.prepare('DELETE FROM usage_budgets WHERE window_start < ?').run(retentionCutoff);
    database.prepare('DELETE FROM global_usage_budgets WHERE window_start < ?').run(retentionCutoff);

    const userRow = database.prepare(`
      SELECT amount FROM usage_budgets
      WHERE user_id = ? AND category = ? AND window_start = ?
    `).get(userId, category, windowStart) as { amount: number } | undefined;
    const globalRow = database.prepare(`
      SELECT amount FROM global_usage_budgets
      WHERE category = ? AND window_start = ?
    `).get(category, windowStart) as { amount: number } | undefined;
    const used = Math.max(0, Number(userRow?.amount || 0));
    const globalUsed = Math.max(0, Number(globalRow?.amount || 0));

    if (safeAmount > safeUserLimit - used) {
      return {
        allowed: false,
        used,
        limit: safeUserLimit,
        resetAt,
        blockedScope: 'user' as const,
        globalUsed,
        globalLimit: safeGlobalLimit,
      };
    }
    if (safeAmount > safeGlobalLimit - globalUsed) {
      return {
        allowed: false,
        used,
        limit: safeUserLimit,
        resetAt,
        blockedScope: 'global' as const,
        globalUsed,
        globalLimit: safeGlobalLimit,
      };
    }

    const nextUsed = used + safeAmount;
    const nextGlobalUsed = globalUsed + safeAmount;
    database.prepare(`
      INSERT INTO usage_budgets (user_id, category, window_start, amount, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, category, window_start) DO UPDATE SET
        amount = excluded.amount,
        updated_at = datetime('now')
    `).run(userId, category, windowStart, nextUsed);
    database.prepare(`
      INSERT INTO global_usage_budgets (category, window_start, amount, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(category, window_start) DO UPDATE SET
        amount = excluded.amount,
        updated_at = datetime('now')
    `).run(category, windowStart, nextGlobalUsed);
    return {
      allowed: true,
      used: nextUsed,
      limit: safeUserLimit,
      resetAt,
      blockedScope: null,
      globalUsed: nextGlobalUsed,
      globalLimit: safeGlobalLimit,
    };
  });
  return consume.immediate();
}

export function consumeHourlyUsageBudget(
  userId: string,
  category: string,
  amount: number,
  limit: number,
  nowMs = Date.now(),
): UsageBudgetResult {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(category)) throw new Error('Invalid usage budget category');
  const safeAmount = Math.max(0, Math.floor(Number(amount || 0)));
  const safeLimit = Math.max(1, Math.floor(Number(limit || 0)));
  const windowStartMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const windowStart = new Date(windowStartMs).toISOString();
  const resetAt = new Date(windowStartMs + 3_600_000).toISOString();
  const database = getDb();
  const consume = database.transaction(() => {
    database.prepare('DELETE FROM usage_budgets WHERE window_start < ?').run(new Date(windowStartMs - 48 * 3_600_000).toISOString());
    const row = database.prepare(`
      SELECT amount FROM usage_budgets
      WHERE user_id = ? AND category = ? AND window_start = ?
    `).get(userId, category, windowStart) as { amount: number } | undefined;
    const used = Math.max(0, Number(row?.amount || 0));
    if (safeAmount > safeLimit - used) {
      return { allowed: false, used, limit: safeLimit, resetAt };
    }
    const nextUsed = used + safeAmount;
    database.prepare(`
      INSERT INTO usage_budgets (user_id, category, window_start, amount, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, category, window_start) DO UPDATE SET
        amount = excluded.amount,
        updated_at = datetime('now')
    `).run(userId, category, windowStart, nextUsed);
    return { allowed: true, used: nextUsed, limit: safeLimit, resetAt };
  });
  return consume.immediate();
}

export function consumeGlobalHourlyUsageBudget(
  category: string,
  amount: number,
  limit: number,
  nowMs = Date.now(),
): UsageBudgetResult {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(category)) throw new Error('Invalid global usage budget category');
  const safeAmount = Math.max(0, Math.floor(Number(amount || 0)));
  const safeLimit = Math.max(1, Math.floor(Number(limit || 0)));
  const windowStartMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const windowStart = new Date(windowStartMs).toISOString();
  const resetAt = new Date(windowStartMs + 3_600_000).toISOString();
  const database = getDb();
  const consume = database.transaction(() => {
    database.prepare('DELETE FROM global_usage_budgets WHERE window_start < ?').run(new Date(windowStartMs - 48 * 3_600_000).toISOString());
    const row = database.prepare(`
      SELECT amount FROM global_usage_budgets
      WHERE category = ? AND window_start = ?
    `).get(category, windowStart) as { amount: number } | undefined;
    const used = Math.max(0, Number(row?.amount || 0));
    if (safeAmount > safeLimit - used) {
      return { allowed: false, used, limit: safeLimit, resetAt };
    }
    const nextUsed = used + safeAmount;
    database.prepare(`
      INSERT INTO global_usage_budgets (category, window_start, amount, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(category, window_start) DO UPDATE SET
        amount = excluded.amount,
        updated_at = datetime('now')
    `).run(category, windowStart, nextUsed);
    return { allowed: true, used: nextUsed, limit: safeLimit, resetAt };
  });
  return consume.immediate();
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
  user_id: string;
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
  figure_count: number;
  project_type: 'single_figure' | 'multi_figure' | 'composition_code';
  project_type_label: string;
  preview: string | null;
}

export function listProjects(userId: string): ProjectSummary[] {
  const rows = getDb().prepare(`
    SELECT id, name, created_at, updated_at, spec
    FROM projects
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(userId) as ProjectRow[];

  return rows.map(r => {
    let spec: any = {};
    try { spec = JSON.parse(r.spec); } catch {}
    const raw = spec.raw_data;
    const groupCount = raw?.groups ? Object.keys(raw.groups).length : 0;
    const sampleCount = raw?.categories?.length ?? 0;
    const preview = typeof spec._preview === 'string' ? spec._preview : null;
    const figureCount = getDb().prepare('SELECT COUNT(*) AS count FROM project_figures WHERE project_id = ?').get(r.id) as { count?: number } | undefined;
    const compositionKind = spec?.composition?.kind;
    const projectType = compositionKind === 'code_composition_project'
      ? 'composition_code'
      : Number(figureCount?.count || 0) > 1
        ? 'multi_figure'
        : 'single_figure';
    const projectTypeLabel = projectType === 'composition_code'
      ? '组合代码项目'
      : projectType === 'multi_figure'
        ? '多 Figure 项目'
        : '单图项目';
    return {
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
      group_count: groupCount,
      sample_count: sampleCount,
      figure_count: Number(figureCount?.count || 0),
      project_type: projectType,
      project_type_label: projectTypeLabel,
      preview,
    };
  });
}

export function getProject(id: string, userId: string): ProjectRow | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, userId) as ProjectRow | undefined;
  return row ?? null;
}

export function createProject(id: string, userId: string, name: string, spec: object): void {
  getDb().prepare('INSERT INTO projects (id, user_id, name, spec) VALUES (?, ?, ?, ?)').run(id, userId, name, JSON.stringify(spec));
}

export function updateProject(id: string, userId: string, name: string, spec: object, script?: string): void {
  if (script !== undefined) {
    getDb().prepare('UPDATE projects SET name = ?, spec = ?, script = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').run(name, JSON.stringify(spec), script, id, userId);
  } else {
    getDb().prepare('UPDATE projects SET name = ?, spec = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').run(name, JSON.stringify(spec), id, userId);
  }
}

export function deleteProject(id: string, userId: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, userId);
}

// --- Session persistence ---

export interface SessionRow {
  id: string;
  user_id: string;
  script: string;
  data_payload: string | null;
  edit_log: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function saveSession(id: string, userId: string, script: string, dataPayload: Record<string, unknown> | null, editLog: unknown[], revision: number): void {
  getDb().prepare(`
    INSERT INTO sessions (id, user_id, script, data_payload, edit_log, revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      script = excluded.script,
      data_payload = excluded.data_payload,
      edit_log = excluded.edit_log,
      revision = excluded.revision,
      updated_at = datetime('now')
  `).run(id, userId, script, dataPayload ? JSON.stringify(dataPayload) : null, JSON.stringify(editLog), revision);
}

export function getSession(id: string, userId: string): SessionRow | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(id, userId) as SessionRow | undefined;
  return row ?? null;
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function cleanExpiredSessions(maxAgeMinutes: number = 120): void {
  getDb().prepare(`
    DELETE FROM sessions AS s
    WHERE s.updated_at < datetime('now', ?)
      AND NOT EXISTS (
        SELECT 1
        FROM project_figures AS pf
        WHERE pf.session_id = s.id
      )
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
  editingSnapshot?: ExportAssetSnapshotInput;
}

export interface ExportAssetSnapshotInput {
  figureId: string;
  schemaVersion: number;
  snapshotJson: string;
  snapshotHash: string;
}

export interface ExportAssetSnapshot {
  assetId: string;
  projectId: string;
  figureId: string;
  schemaVersion: number;
  snapshotJson: string;
  snapshotHash: string;
  createdAt: string;
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
  sizeBytes?: number;
  hasEditingSnapshot: boolean;
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
    hasEditingSnapshot: Boolean(row.has_editing_snapshot),
  };
}

export function addExportAsset(input: ExportAssetInput): ExportAsset {
  const database = getDb();
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO export_assets (
        id, project_id, figure_id, name, format, dpi, file_path, thumbnail_svg, metadata, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(input.tags ?? []),
    );
    if (input.editingSnapshot) {
      database.prepare(`
        INSERT INTO export_asset_snapshots (
          asset_id, project_id, figure_id, schema_version, snapshot_json, snapshot_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.projectId,
        input.editingSnapshot.figureId,
        input.editingSnapshot.schemaVersion,
        input.editingSnapshot.snapshotJson,
        input.editingSnapshot.snapshotHash,
      );
    }
    const asset = getExportAsset(input.id);
    if (!asset) throw new Error('导出资产写入失败');
    return asset;
  })();
}

export function listExportAssets(projectId: string): ExportAsset[] {
  const rows = getDb().prepare(`
    SELECT ea.*, CASE WHEN eas.asset_id IS NULL THEN 0 ELSE 1 END AS has_editing_snapshot
    FROM export_assets AS ea
    LEFT JOIN export_asset_snapshots AS eas ON eas.asset_id = ea.id
    WHERE ea.project_id = ?
    ORDER BY ea.created_at DESC
  `).all(projectId) as any[];
  return rows.map(mapExportAsset);
}

export function getExportAsset(assetId: string): ExportAsset | null {
  const row = getDb().prepare(`
    SELECT ea.*, CASE WHEN eas.asset_id IS NULL THEN 0 ELSE 1 END AS has_editing_snapshot
    FROM export_assets AS ea
    LEFT JOIN export_asset_snapshots AS eas ON eas.asset_id = ea.id
    WHERE ea.id = ?
  `).get(assetId) as any | undefined;
  return row ? mapExportAsset(row) : null;
}

export function getExportAssetSnapshot(assetId: string, projectId: string): ExportAssetSnapshot | null {
  const row = getDb().prepare(`
    SELECT * FROM export_asset_snapshots
    WHERE asset_id = ? AND project_id = ?
  `).get(assetId, projectId) as any | undefined;
  if (!row) return null;
  return {
    assetId: row.asset_id,
    projectId: row.project_id,
    figureId: row.figure_id,
    schemaVersion: row.schema_version,
    snapshotJson: row.snapshot_json,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
  };
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
  previewSvg?: string | null;
  manifest?: any;
  codeSlice?: any;
  fingerprint?: string | number | null;
  history?: unknown;
}

export function replaceProjectFiguresAndSessions(
  projectId: string,
  userId: string,
  figures: FigSessionInput[],
  script: string,
  dataPayload: Record<string, unknown> | null
): void {
  const db = getDb();
  db.transaction(() => {
    const previousRows = db.prepare(`
      SELECT figure_index, history
      FROM project_figures
      WHERE project_id = ?
    `).all(projectId) as Array<{ figure_index: number; history?: string | null }>;
    const previousHistoryByIndex = new Map(previousRows.map(row => [row.figure_index, row.history]));
    db.prepare('DELETE FROM project_figures WHERE project_id = ?').run(projectId);
    const insertFig = db.prepare(`
      INSERT INTO project_figures (
        id, project_id, figure_index, session_id, revision,
        preview_svg, manifest, code_slice, fingerprint, preview_updated_at,
        edit_log, history
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `);
    const insertSession = db.prepare(`
      INSERT INTO sessions (id, user_id, script, data_payload, edit_log, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        script = excluded.script,
        data_payload = excluded.data_payload,
        edit_log = excluded.edit_log,
        revision = excluded.revision,
        updated_at = datetime('now')
    `);

    figures.forEach(fig => {
      insertFig.run(
        projectId + '_' + fig.figureIndex,
        projectId,
        fig.figureIndex,
        fig.sessionId,
        fig.revision,
        fig.previewSvg ?? null,
        fig.manifest ? JSON.stringify(fig.manifest) : null,
        fig.codeSlice ? JSON.stringify(fig.codeSlice) : null,
        fig.fingerprint !== undefined && fig.fingerprint !== null ? String(fig.fingerprint) : null,
        JSON.stringify(fig.editLog || []),
        fig.history !== undefined
          ? JSON.stringify(fig.history)
          : previousHistoryByIndex.get(fig.figureIndex) || JSON.stringify({ past: [], future: [] })
      );

      const payload = dataPayload ? JSON.stringify(dataPayload) : null;
      insertSession.run(
        fig.sessionId,
        userId,
        script,
        payload,
        JSON.stringify(fig.editLog),
        fig.revision
      );
    });
  })();
}
