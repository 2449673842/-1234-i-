import { afterEach, describe, expect, it } from 'vitest';
import { assertAuthThrottleProductionConfig, hashAuthThrottleScope } from './authThrottle';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('authentication throttle identifiers', () => {
  it('uses deterministic HMAC identifiers without exposing the input', () => {
    process.env.NODE_ENV = 'development';
    const first = hashAuthThrottleScope('login_identifier', 'User@Example.test');
    const second = hashAuthThrottleScope('login_identifier', ' user@example.test ');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('user@example.test');
  });

  it('requires an independent strong secret in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SCIFIGURE_AUTH_THROTTLE_SECRET;
    expect(() => assertAuthThrottleProductionConfig()).toThrow(/AUTH_THROTTLE_SECRET/);
    process.env.SCIFIGURE_AUTH_THROTTLE_SECRET = 'production-auth-throttle-secret-32-plus';
    expect(() => assertAuthThrottleProductionConfig()).not.toThrow();
  });
});
