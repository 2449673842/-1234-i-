import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminMfaEncryptionConfigured,
  adminMfaMode,
  assertAdminMfaProductionConfig,
  buildAdminOtpAuthUri,
  decryptAdminTotpSecret,
  encryptAdminTotpSecret,
  findUsableAdminTotpCounter,
  generateAdminRecoveryCodes,
  generateAdminTotpCode,
  hashAdminRecoveryCode,
} from './adminMfa';

const originalEnv = { ...process.env };
const testKey = crypto.createHash('sha256').update('scifigure-admin-mfa-test-key').digest('base64');

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('administrator TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 vector after truncating to six digits', () => {
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = testKey;
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateAdminTotpCode(secret, 59_000)).toBe('287082');
    const counter = findUsableAdminTotpCounter(secret, '287082', 59_000, null);
    expect(counter).toBe(1);
    expect(findUsableAdminTotpCounter(secret, '287082', 59_000, counter)).toBeNull();
  });

  it('allows only the bounded clock window and rejects a consumed counter', () => {
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = testKey;
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = 1_710_000_000_000;
    const previous = generateAdminTotpCode(secret, now - 30_000);
    const tooOld = generateAdminTotpCode(secret, now - 60_000);
    const accepted = findUsableAdminTotpCounter(secret, previous, now, null);
    expect(accepted).not.toBeNull();
    expect(findUsableAdminTotpCounter(secret, previous, now, accepted)).toBeNull();
    expect(findUsableAdminTotpCounter(secret, tooOld, now, null)).toBeNull();
  });

  it('encrypts the secret with account-bound authenticated encryption', () => {
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = testKey;
    const userId = 'usr_00000000-0000-4000-8000-000000000001';
    const factorId = 'amf_00000000-0000-4000-8000-000000000001';
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const envelope = encryptAdminTotpSecret(userId, factorId, secret);
    expect(envelope).toMatch(/^v2\.primary\./);
    expect(envelope).not.toContain(secret);
    expect(decryptAdminTotpSecret(userId, factorId, envelope)).toBe(secret);
    expect(() => decryptAdminTotpSecret('usr_00000000-0000-4000-8000-000000000002', factorId, envelope)).toThrow();
    expect(() => decryptAdminTotpSecret(userId, 'amf_00000000-0000-4000-8000-000000000002', envelope)).toThrow();
  });

  it('decrypts existing factors after rotating to a new primary key', () => {
    const oldKey = crypto.createHash('sha256').update('old-admin-mfa-key').digest('base64');
    const newKey = crypto.createHash('sha256').update('new-admin-mfa-key').digest('base64');
    const userId = 'usr_00000000-0000-4000-8000-000000000001';
    const factorId = 'amf_00000000-0000-4000-8000-000000000001';
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    delete process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY;
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS = `old:${oldKey}`;
    const oldEnvelope = encryptAdminTotpSecret(userId, factorId, secret);
    expect(oldEnvelope).toMatch(/^v2\.old\./);
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS = `new:${newKey},old:${oldKey}`;
    expect(decryptAdminTotpSecret(userId, factorId, oldEnvelope)).toBe(secret);
    expect(encryptAdminTotpSecret(userId, factorId, secret)).toMatch(/^v2\.new\./);
  });

  it('tries retained keys for legacy envelopes that do not contain a key id', () => {
    const oldKey = crypto.createHash('sha256').update('legacy-old-admin-mfa-key').digest();
    const newKey = crypto.createHash('sha256').update('legacy-new-admin-mfa-key').digest();
    const userId = 'usr_00000000-0000-4000-8000-000000000001';
    const factorId = 'amf_00000000-0000-4000-8000-000000000001';
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const derived = crypto.createHmac('sha256', oldKey).update('scifigure-admin-mfa:totp-secret:v1').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    cipher.setAAD(Buffer.from(`scifigure:admin-mfa:${userId}:${factorId}:totp:v1`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const legacyEnvelope = ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');

    delete process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY;
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS = `new:${newKey.toString('base64')},old:${oldKey.toString('base64')}`;
    expect(decryptAdminTotpSecret(userId, factorId, legacyEnvelope)).toBe(secret);
  });

  it('generates one-time recovery values while storing only keyed hashes', () => {
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = testKey;
    const userId = 'usr_00000000-0000-4000-8000-000000000001';
    const codes = generateAdminRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/);
      const hash = hashAdminRecoveryCode(userId, code);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).not.toContain(code.replace(/-/g, ''));
    }
  });

  it('builds an account-id label without embedding an email address', () => {
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = testKey;
    const uri = buildAdminOtpAuthUri('usr_00000000-0000-4000-8000-000000000001', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('issuer=SciFigure');
    expect(uri).not.toContain('@');
  });
});

describe('administrator MFA production configuration', () => {
  it('defaults to observe outside production and enforce in production', () => {
    delete process.env.SCIFIGURE_ADMIN_MFA_MODE;
    process.env.NODE_ENV = 'development';
    expect(adminMfaMode()).toBe('observe');
    process.env.NODE_ENV = 'production';
    expect(adminMfaMode()).toBe('enforce');
  });

  it('fails closed when a production admin console lacks a valid encryption key', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY;
    expect(adminMfaEncryptionConfigured()).toBe(false);
    expect(() => assertAdminMfaProductionConfig(true)).toThrow(/密钥/);
  });

  it('rejects production observe mode unless the break-glass override is explicit', () => {
    process.env.NODE_ENV = 'production';
    process.env.SCIFIGURE_ADMIN_MFA_MODE = 'observe';
    process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = testKey;
    expect(() => assertAdminMfaProductionConfig(true)).toThrow(/强制/);
    process.env.SCIFIGURE_ALLOW_ADMIN_MFA_OBSERVE_IN_PRODUCTION = '1';
    expect(() => assertAdminMfaProductionConfig(true)).not.toThrow();
  });
});
