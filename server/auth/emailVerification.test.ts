import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEmailVerificationProductionConfig,
  deriveEmailVerificationCode,
  hashEmailVerificationCode,
} from './emailVerification';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.NODE_ENV = 'production';
  delete process.env.SCIFIGURE_EMAIL_VERIFICATION_REQUIRED;
  delete process.env.SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION;
  delete process.env.SCIFIGURE_EMAIL_PROVIDER;
  delete process.env.SCIFIGURE_EMAIL_VERIFICATION_SECRET;
  delete process.env.SCIFIGURE_RESEND_API_KEY;
  delete process.env.SCIFIGURE_EMAIL_FROM;
  delete process.env.SCIFIGURE_EMAIL_WEBHOOK_URL;
  delete process.env.SCIFIGURE_EMAIL_WEBHOOK_TOKEN;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('production email verification configuration', () => {
  it('derives a stable secret-bound six-digit code for outbox recovery', () => {
    process.env.NODE_ENV = 'test';
    process.env.SCIFIGURE_EMAIL_VERIFICATION_SECRET = 'test-email-secret-at-least-32-characters';
    const challengeId = 'evc_00000000-0000-4000-8000-000000000123';
    const code = deriveEmailVerificationCode(challengeId);
    expect(code).toMatch(/^\d{6}$/);
    expect(deriveEmailVerificationCode(challengeId)).toBe(code);
    expect(hashEmailVerificationCode(challengeId, code)).toMatch(/^[a-f0-9]{64}$/);

    process.env.SCIFIGURE_EMAIL_VERIFICATION_SECRET = 'different-test-email-secret-32-plus';
    expect(deriveEmailVerificationCode(challengeId)).not.toBe(code);
  });

  it('fails closed when production verification is not explicitly enabled', () => {
    productionEnv();
    expect(() => assertEmailVerificationProductionConfig()).toThrow(/邮箱验证/);
  });

  it('requires a real provider and a strong verification secret', () => {
    productionEnv({ SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: '1' });
    expect(() => assertEmailVerificationProductionConfig()).toThrow(/邮件提供器|SECRET/);
  });

  it('accepts a complete Resend configuration', () => {
    productionEnv({
      SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: '1',
      SCIFIGURE_EMAIL_PROVIDER: 'resend',
      SCIFIGURE_EMAIL_VERIFICATION_SECRET: 'production-email-secret-at-least-32-characters',
      SCIFIGURE_RESEND_API_KEY: 're_test_key',
      SCIFIGURE_EMAIL_FROM: 'SciFigure <noreply@example.test>',
    });
    expect(() => assertEmailVerificationProductionConfig()).not.toThrow();
  });

  it('allows an explicit break-glass override without pretending verification is enabled', () => {
    productionEnv({ SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION: '1' });
    expect(() => assertEmailVerificationProductionConfig()).not.toThrow();
  });
});
