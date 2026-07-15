import crypto from 'node:crypto';

function authThrottleSecret(): string {
  const configured = String(process.env.SCIFIGURE_AUTH_THROTTLE_SECRET || '');
  if (configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SCIFIGURE_AUTH_THROTTLE_SECRET 必须设置为至少 32 个字符');
  }
  return 'development-only-auth-throttle-secret';
}

export function assertAuthThrottleProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  authThrottleSecret();
}

export function hashAuthThrottleScope(namespace: string, value: string): string {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(namespace)) {
    throw new Error('Invalid authentication throttle namespace');
  }
  return crypto
    .createHmac('sha256', authThrottleSecret())
    .update(`${namespace}:${value.trim().toLowerCase()}`)
    .digest('hex');
}
