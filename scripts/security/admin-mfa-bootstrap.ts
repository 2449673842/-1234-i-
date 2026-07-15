import crypto from 'node:crypto';
import { getUserByEmail, logAdminAudit } from '../../db';
import {
  adminMfaEncryptionConfigured,
  buildAdminOtpAuthUri,
  generateAdminTotpSecret,
} from '../../server/auth/adminMfa';
import {
  beginAdminMfaEnrollment,
  confirmAdminMfaEnrollment,
  getAdminMfaState,
} from '../../server/auth/adminMfaStore';
import { maskEmailAddress } from '../../server/auth/emailVerification';

function readArg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1]?.trim() || null;
}

function fail(message: string): never {
  console.error(JSON.stringify({ status: 'error', message }, null, 2));
  process.exit(1);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    fail('Interactive confirmation requires a TTY');
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Confirmation cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ' && value.length < 256) {
          value += character;
        }
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const email = readArg('email')?.toLowerCase();
  if (!email) fail('Missing --email');
  if (!adminMfaEncryptionConfigured()) {
    fail('SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY(S) must be configured before administrator MFA enrollment');
  }
  const row = getUserByEmail(email);
  if (!row || row.role !== 'admin') fail('Target account is not an administrator');
  const state = getAdminMfaState(row.id);
  const testToken = readArg('confirm-token');
  const testCode = readArg('code');
  if ((testToken || testCode) && process.env.SCIFIGURE_TEST_ISOLATED !== '1') {
    fail('Secret command-line arguments are disabled; use --confirm for hidden interactive input');
  }

  if (hasFlag('confirm') || testToken || testCode) {
    const confirmToken = testToken || await readHidden('Enrollment token: ');
    const code = testCode || await readHidden('Six-digit authenticator code: ');
    if (!/^ame_[A-Za-z0-9_-]{32,}$/.test(confirmToken) || !/^\d{6}$/.test(code)) {
      fail('Confirmation requires a valid enrollment token and six-digit code');
    }
    const result = confirmAdminMfaEnrollment({
      userId: row.id,
      enrollmentToken: confirmToken,
      code,
      accessToken: null,
    });
    if (result.status !== 'enabled') fail(`Administrator MFA confirmation failed: ${result.status}`);
    logAdminAudit({
      actorUserId: null,
      action: 'admin_mfa.enrollment.confirmed_offline',
      resourceType: 'admin_security',
      resourceId: row.id,
      success: true,
      statusCode: 200,
      metadata: { actor: 'offline_cli', recoveryCodeCount: result.recoveryCodes.length },
    });
    console.log(JSON.stringify({
      status: 'success',
      user: { id: row.id, maskedEmail: maskEmailAddress(row.email) },
      enabled: true,
      sessionsRevoked: true,
      recoveryCodes: result.recoveryCodes,
      warning: 'Recovery codes are shown once. Store them offline and clear this terminal output.',
    }, null, 2));
    return;
  }

  if (state.enabled) fail('Administrator MFA is already enabled');
  const secret = generateAdminTotpSecret();
  const enrollmentToken = `ame_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const factor = beginAdminMfaEnrollment({ userId: row.id, secret, enrollmentToken, expiresAt });
  logAdminAudit({
    actorUserId: null,
    action: 'admin_mfa.enrollment.started_offline',
    resourceType: 'admin_security',
    resourceId: row.id,
    success: true,
    statusCode: 200,
    metadata: { actor: 'offline_cli', expiresInSeconds: 600 },
  });
  console.log(JSON.stringify({
    status: 'pending_confirmation',
    user: { id: row.id, maskedEmail: maskEmailAddress(row.email) },
    factorId: factor.factorId,
    expiresAt,
    enrollmentToken,
    manualKey: secret,
    otpAuthUrl: buildAdminOtpAuthUri(row.id, secret),
    nextCommand: 'npm run security:admin-mfa-bootstrap -- --email <admin-email> --confirm',
    warning: 'The key and token are shown once. Complete confirmation within 10 minutes and clear this terminal output.',
  }, null, 2));
}

await main().catch(error => fail(error instanceof Error ? error.message : 'Administrator MFA bootstrap failed'));
