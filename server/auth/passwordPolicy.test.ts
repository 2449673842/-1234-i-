import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  validateAccountPassword,
} from './passwordPolicy';

describe('account password policy', () => {
  it('accepts the inclusive supported length range', () => {
    expect(validateAccountPassword('a'.repeat(ACCOUNT_PASSWORD_MIN_LENGTH))).toEqual({ valid: true });
    expect(validateAccountPassword('a'.repeat(ACCOUNT_PASSWORD_MAX_LENGTH))).toEqual({ valid: true });
  });

  it('rejects passwords outside the supported range before hashing or email delivery', () => {
    expect(validateAccountPassword('a'.repeat(ACCOUNT_PASSWORD_MIN_LENGTH - 1))).toMatchObject({
      valid: false,
      code: 'too_short',
    });
    expect(validateAccountPassword('a'.repeat(ACCOUNT_PASSWORD_MAX_LENGTH + 1))).toMatchObject({
      valid: false,
      code: 'too_long',
    });
  });
});
