import crypto from 'node:crypto';
import {
  getDb,
  getUserById,
  hashAuthToken,
  type UserAccount,
} from '../../db';
import {
  decryptAdminTotpSecret,
  encryptAdminTotpSecret,
  findUsableAdminTotpCounter,
  generateAdminRecoveryCodes,
  hashAdminRecoveryCode,
} from './adminMfa';

export interface AdminMfaState {
  enabled: boolean;
  pending: boolean;
  recoveryRequired: boolean;
  confirmedAt: string | null;
  pendingExpiresAt: string | null;
  recoveryCodesRemaining: number;
}

export type AdminMfaMethod = 'totp' | 'recovery';

export type AdminMfaConsumeResult =
  | { status: 'verified'; method: AdminMfaMethod }
  | { status: 'invalid' | 'not_configured' };

export type AdminMfaEnrollmentResult =
  | { status: 'enabled'; recoveryCodes: string[]; method: 'totp' }
  | { status: 'invalid' | 'expired' | 'already_enabled' };

export type AdminMfaLoginResult =
  | { status: 'verified'; user: UserAccount; method: AdminMfaMethod }
  | { status: 'invalid' | 'expired' | 'locked'; user: null };

type FactorRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'active' | 'recovery_required' | 'disabled';
  secret_envelope: string;
  last_accepted_step: number | null;
  enrollment_token_hash: string | null;
  pending_expires_at: string | null;
  confirmed_at: string | null;
};

function tokenHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function constantTimeHashEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function factorForUser(userId: string): FactorRow | undefined {
  return getDb().prepare(`
    SELECT id, user_id, status, secret_envelope, last_accepted_step,
           enrollment_token_hash, pending_expires_at, confirmed_at
    FROM admin_mfa_factors WHERE user_id = ? LIMIT 1
  `).get(userId) as FactorRow | undefined;
}

function consumeFactorInTransaction(
  factor: FactorRow | undefined,
  candidate: string,
  nowMs: number,
): AdminMfaConsumeResult {
  if (!factor || (factor.status !== 'active' && factor.status !== 'recovery_required')) {
    return { status: 'not_configured' };
  }
  const database = getDb();
  const normalized = String(candidate || '').trim();
  if (/^\d{6}$/.test(normalized)) {
    const secret = decryptAdminTotpSecret(factor.user_id, factor.id, factor.secret_envelope);
    const counter = findUsableAdminTotpCounter(secret, normalized, nowMs, factor.last_accepted_step);
    if (counter === null) return { status: 'invalid' };
    const updated = database.prepare(`
      UPDATE admin_mfa_factors
      SET last_accepted_step = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('active', 'recovery_required')
        AND (last_accepted_step IS NULL OR last_accepted_step < ?)
    `).run(counter, factor.id, counter);
    return updated.changes === 1 ? { status: 'verified', method: 'totp' } : { status: 'invalid' };
  }

  const recoveryHash = hashAdminRecoveryCode(factor.user_id, normalized);
  if (!recoveryHash) return { status: 'invalid' };
  const recovery = database.prepare(`
    SELECT id FROM admin_mfa_recovery_codes
    WHERE factor_id = ? AND code_hash = ? AND used_at IS NULL
    LIMIT 1
  `).get(factor.id, recoveryHash) as { id: string } | undefined;
  if (!recovery) return { status: 'invalid' };
  const consumed = database.prepare(`
    UPDATE admin_mfa_recovery_codes SET used_at = datetime('now')
    WHERE id = ? AND used_at IS NULL
  `).run(recovery.id);
  if (consumed.changes !== 1) return { status: 'invalid' };
  const remaining = Number((database.prepare(`
    SELECT COUNT(*) AS count FROM admin_mfa_recovery_codes
    WHERE factor_id = ? AND used_at IS NULL
  `).get(factor.id) as { count: number }).count || 0);
  if (remaining === 0) {
    database.prepare(`
      UPDATE admin_mfa_factors
      SET status = 'recovery_required', updated_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `).run(factor.id);
  }
  return { status: 'verified', method: 'recovery' };
}

function replaceRecoveryCodes(factor: FactorRow, recoveryCodes: string[]): void {
  const database = getDb();
  database.prepare('DELETE FROM admin_mfa_recovery_codes WHERE factor_id = ?').run(factor.id);
  const insert = database.prepare(`
    INSERT INTO admin_mfa_recovery_codes (id, factor_id, code_hash)
    VALUES (?, ?, ?)
  `);
  for (const code of recoveryCodes) {
    insert.run(`amr_${crypto.randomUUID()}`, factor.id, hashAdminRecoveryCode(factor.user_id, code));
  }
  database.prepare(`
    UPDATE admin_mfa_factors SET status = 'active', updated_at = datetime('now')
    WHERE id = ? AND status IN ('active', 'recovery_required')
  `).run(factor.id);
}

export function getAdminMfaState(userId: string): AdminMfaState {
  const factor = factorForUser(userId);
  const pending = factor?.status === 'pending'
    && Boolean(factor.pending_expires_at)
    && Date.parse(factor.pending_expires_at!) > Date.now();
  const recoveryCodesRemaining = factor ? Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM admin_mfa_recovery_codes
    WHERE factor_id = ? AND used_at IS NULL
  `).get(factor.id) as { count: number }).count || 0) : 0;
  return {
    enabled: factor?.status === 'active' || factor?.status === 'recovery_required',
    pending,
    recoveryRequired: factor?.status === 'recovery_required',
    confirmedAt: factor?.confirmed_at ?? null,
    pendingExpiresAt: pending ? factor?.pending_expires_at ?? null : null,
    recoveryCodesRemaining,
  };
}

export function beginAdminMfaEnrollment(input: {
  userId: string;
  secret: string;
  enrollmentToken: string;
  expiresAt: string;
}): { factorId: string } {
  const database = getDb();
  return database.transaction(() => {
    const user = getUserById(input.userId);
    if (!user || user.role !== 'admin') throw new Error('需要管理员权限');
    const existing = factorForUser(input.userId);
    if (existing?.status === 'active' || existing?.status === 'recovery_required') throw new Error('管理员二步验证已经启用');
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error('管理员二步验证设置已过期');

    if (existing) database.prepare('DELETE FROM admin_mfa_factors WHERE id = ?').run(existing.id);
    const factorId = `amf_${crypto.randomUUID()}`;
    const envelope = encryptAdminTotpSecret(input.userId, factorId, input.secret);
    database.prepare(`
      INSERT INTO admin_mfa_factors (
        id, user_id, status, secret_envelope, enrollment_token_hash, pending_expires_at
      ) VALUES (?, ?, 'pending', ?, ?, ?)
    `).run(factorId, input.userId, envelope, tokenHash(input.enrollmentToken), input.expiresAt);
    database.prepare('DELETE FROM admin_reauth_tokens WHERE actor_user_id = ?').run(input.userId);
    return { factorId };
  }).immediate();
}

export function confirmAdminMfaEnrollment(input: {
  userId: string;
  enrollmentToken: string;
  code: string;
  accessToken?: string | null;
  nowMs?: number;
}): AdminMfaEnrollmentResult {
  const nowMs = input.nowMs ?? Date.now();
  const recoveryCodes = generateAdminRecoveryCodes();
  const database = getDb();
  return database.transaction((): AdminMfaEnrollmentResult => {
    const factor = factorForUser(input.userId);
    if (factor?.status === 'active' || factor?.status === 'recovery_required') return { status: 'already_enabled' };
    if (!factor || factor.status !== 'pending' || !factor.enrollment_token_hash || !factor.pending_expires_at) {
      return { status: 'invalid' };
    }
    if (Date.parse(factor.pending_expires_at) <= nowMs) {
      database.prepare(`
        UPDATE admin_mfa_factors
        SET status = 'disabled', enrollment_token_hash = NULL, pending_expires_at = NULL,
            disabled_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).run(factor.id);
      return { status: 'expired' };
    }
    if (!constantTimeHashEqual(tokenHash(input.enrollmentToken), factor.enrollment_token_hash)) {
      return { status: 'invalid' };
    }
    const secret = decryptAdminTotpSecret(factor.user_id, factor.id, factor.secret_envelope);
    const counter = findUsableAdminTotpCounter(secret, String(input.code || '').trim(), nowMs, null);
    if (counter === null) return { status: 'invalid' };

    const enabled = database.prepare(`
      UPDATE admin_mfa_factors
      SET status = 'active', last_accepted_step = ?, enrollment_token_hash = NULL,
          pending_expires_at = NULL, confirmed_at = datetime('now'), disabled_at = NULL,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(counter, factor.id);
    if (enabled.changes !== 1) return { status: 'invalid' };
    replaceRecoveryCodes({ ...factor, status: 'active', last_accepted_step: counter }, recoveryCodes);
    database.prepare('DELETE FROM admin_reauth_tokens WHERE actor_user_id = ?').run(input.userId);

    if (input.accessToken) {
      const currentTokenHash = hashAuthToken(input.accessToken);
      const marked = database.prepare(`
        UPDATE auth_sessions
        SET admin_mfa_verified_at = datetime('now'), admin_mfa_method = 'totp'
        WHERE user_id = ? AND token_hash = ? AND datetime(expires_at) > datetime('now')
      `).run(input.userId, currentTokenHash);
      if (marked.changes !== 1) throw new Error('当前管理员会话已失效');
      database.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?').run(input.userId, currentTokenHash);
    } else {
      database.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(input.userId);
    }
    return { status: 'enabled', recoveryCodes, method: 'totp' };
  }).immediate();
}

export function createAdminMfaLoginChallenge(input: {
  userId: string;
  deviceScopeHash: string;
  ttlMs?: number;
  maxAttempts?: number;
}): { challengeToken: string; expiresAt: string } {
  const database = getDb();
  return database.transaction(() => {
    const user = getUserById(input.userId);
    const factor = factorForUser(input.userId);
    if (!user || user.role !== 'admin' || (factor?.status !== 'active' && factor?.status !== 'recovery_required')) {
      throw new Error('管理员二步验证尚未启用');
    }
    const ttlMs = Math.max(60_000, Math.min(10 * 60_000, Math.floor(input.ttlMs ?? 5 * 60_000)));
    const maxAttempts = Math.max(3, Math.min(8, Math.floor(input.maxAttempts ?? 5)));
    const challengeToken = `amc_${crypto.randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    database.prepare(`
      DELETE FROM admin_mfa_login_challenges
      WHERE datetime(expires_at) <= datetime('now') OR consumed_at IS NOT NULL OR user_id = ?
    `).run(input.userId);
    database.prepare(`
      INSERT INTO admin_mfa_login_challenges (
        id, user_id, token_hash, device_scope_hash, expires_at, max_attempts
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(`aml_${crypto.randomUUID()}`, input.userId, tokenHash(challengeToken), input.deviceScopeHash, expiresAt, maxAttempts);
    return { challengeToken, expiresAt };
  }).immediate();
}

export function getAdminMfaLoginChallengeSubject(
  challengeToken: string,
  deviceScopeHash: string,
  nowMs = Date.now(),
): string | null {
  const row = getDb().prepare(`
    SELECT user_id, device_scope_hash, expires_at, consumed_at
    FROM admin_mfa_login_challenges WHERE token_hash = ? LIMIT 1
  `).get(tokenHash(challengeToken)) as {
    user_id: string;
    device_scope_hash: string;
    expires_at: string;
    consumed_at: string | null;
  } | undefined;
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= nowMs) return null;
  return constantTimeHashEqual(row.device_scope_hash, deviceScopeHash) ? row.user_id : null;
}

export function consumeAdminMfaLoginChallenge(input: {
  challengeToken: string;
  deviceScopeHash: string;
  candidate: string;
  nowMs?: number;
}): AdminMfaLoginResult {
  const nowMs = input.nowMs ?? Date.now();
  const database = getDb();
  return database.transaction((): AdminMfaLoginResult => {
    const row = database.prepare(`
      SELECT id, user_id, device_scope_hash, expires_at, attempt_count, max_attempts, consumed_at
      FROM admin_mfa_login_challenges WHERE token_hash = ? LIMIT 1
    `).get(tokenHash(input.challengeToken)) as {
      id: string;
      user_id: string;
      device_scope_hash: string;
      expires_at: string;
      attempt_count: number;
      max_attempts: number;
      consumed_at: string | null;
    } | undefined;
    if (!row || row.consumed_at) return { status: 'invalid', user: null };
    if (Date.parse(row.expires_at) <= nowMs) {
      database.prepare("UPDATE admin_mfa_login_challenges SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
      return { status: 'expired', user: null };
    }
    if (row.attempt_count >= row.max_attempts) return { status: 'locked', user: null };
    if (!constantTimeHashEqual(row.device_scope_hash, input.deviceScopeHash)) {
      return { status: 'invalid', user: null };
    }

    const factor = factorForUser(row.user_id);
    const factorResult = consumeFactorInTransaction(factor, input.candidate, nowMs);
    if (factorResult.status !== 'verified') {
      const nextAttempts = row.attempt_count + 1;
      database.prepare(`
        UPDATE admin_mfa_login_challenges
        SET attempt_count = ?, consumed_at = CASE WHEN ? >= max_attempts THEN datetime('now') ELSE consumed_at END
        WHERE id = ?
      `).run(nextAttempts, nextAttempts, row.id);
      return { status: nextAttempts >= row.max_attempts ? 'locked' : 'invalid', user: null };
    }
    const user = getUserById(row.user_id);
    if (!user || user.role !== 'admin') return { status: 'invalid', user: null };
    database.prepare("UPDATE admin_mfa_login_challenges SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
    return { status: 'verified', user, method: factorResult.method };
  }).immediate();
}

export function consumeAdminMfaFactor(userId: string, candidate: string, nowMs = Date.now()): AdminMfaConsumeResult {
  const database = getDb();
  return database.transaction(() => consumeFactorInTransaction(factorForUser(userId), candidate, nowMs)).immediate();
}

export function regenerateAdminMfaRecoveryCodes(
  userId: string,
  candidate: string,
  nowMs = Date.now(),
): { status: 'regenerated'; recoveryCodes: string[] } | { status: 'invalid' | 'not_configured' } {
  const recoveryCodes = generateAdminRecoveryCodes();
  const database = getDb();
  return database.transaction((): { status: 'regenerated'; recoveryCodes: string[] } | { status: 'invalid' | 'not_configured' } => {
    const factor = factorForUser(userId);
    const result = consumeFactorInTransaction(factor, candidate, nowMs);
    if (result.status !== 'verified') return { status: result.status };
    if (!factor) return { status: 'not_configured' };
    replaceRecoveryCodes(factor, recoveryCodes);
    return { status: 'regenerated', recoveryCodes };
  }).immediate();
}

export function isAdminMfaVerifiedSession(accessToken: string, userId: string): boolean {
  const row = getDb().prepare(`
    SELECT admin_mfa_verified_at
    FROM auth_sessions
    WHERE user_id = ? AND token_hash = ? AND datetime(expires_at) > datetime('now')
    LIMIT 1
  `).get(userId, hashAuthToken(accessToken)) as { admin_mfa_verified_at: string | null } | undefined;
  if (!row?.admin_mfa_verified_at) return false;
  const configuredHours = Number(process.env.SCIFIGURE_ADMIN_MFA_SESSION_HOURS || 12);
  const maxAgeHours = Math.max(1, Math.min(24, Number.isFinite(configuredHours) ? configuredHours : 12));
  return Date.parse(row.admin_mfa_verified_at) > Date.now() - maxAgeHours * 60 * 60 * 1000;
}

export function markAuthSessionAdminMfa(
  accessToken: string,
  userId: string,
  method: AdminMfaMethod,
): boolean {
  return getDb().prepare(`
    UPDATE auth_sessions
    SET admin_mfa_verified_at = datetime('now'), admin_mfa_method = ?
    WHERE user_id = ? AND token_hash = ? AND datetime(expires_at) > datetime('now')
  `).run(method, userId, hashAuthToken(accessToken)).changes === 1;
}
