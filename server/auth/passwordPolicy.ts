export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 1024;

export type AccountPasswordValidation =
  | { valid: true }
  | { valid: false; code: 'too_short' | 'too_long'; message: string };

export function validateAccountPassword(password: string): AccountPasswordValidation {
  if (password.length < ACCOUNT_PASSWORD_MIN_LENGTH) {
    return {
      valid: false,
      code: 'too_short',
      message: `密码至少需要 ${ACCOUNT_PASSWORD_MIN_LENGTH} 位`,
    };
  }
  if (password.length > ACCOUNT_PASSWORD_MAX_LENGTH) {
    return {
      valid: false,
      code: 'too_long',
      message: `密码不能超过 ${ACCOUNT_PASSWORD_MAX_LENGTH} 位`,
    };
  }
  return { valid: true };
}
