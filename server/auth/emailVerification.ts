import crypto from 'node:crypto';

export type EmailVerificationProvider = 'disabled' | 'console' | 'test' | 'resend' | 'webhook';

export function emailVerificationRequired(): boolean {
  return process.env.SCIFIGURE_EMAIL_VERIFICATION_REQUIRED === '1';
}

export function emailVerificationTtlMinutes(): number {
  return Math.max(5, Math.min(30, Number(process.env.SCIFIGURE_EMAIL_VERIFICATION_TTL_MINUTES || 10)));
}

export function emailVerificationProvider(): EmailVerificationProvider {
  const value = String(process.env.SCIFIGURE_EMAIL_PROVIDER || 'disabled').trim().toLowerCase();
  return value === 'console' || value === 'test' || value === 'resend' || value === 'webhook'
    ? value
    : 'disabled';
}

export function assertEmailVerificationProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!emailVerificationRequired()) {
    if (process.env.SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION === '1') return;
    throw new Error('生产环境必须启用邮箱验证；仅紧急维护可显式允许未验证注册');
  }
  verificationSecret();
  const provider = emailVerificationProvider();
  if (provider === 'resend') {
    if (!String(process.env.SCIFIGURE_RESEND_API_KEY || '').trim() || !String(process.env.SCIFIGURE_EMAIL_FROM || '').trim()) {
      throw new Error('Resend 邮件提供器配置不完整');
    }
    return;
  }
  if (provider === 'webhook') {
    const webhookUrl = String(process.env.SCIFIGURE_EMAIL_WEBHOOK_URL || '').trim();
    const webhookToken = String(process.env.SCIFIGURE_EMAIL_WEBHOOK_TOKEN || '').trim();
    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw new Error('邮件 webhook URL 无效');
    }
    if (parsed.protocol !== 'https:' || !webhookToken) {
      throw new Error('生产邮件 webhook 必须使用 HTTPS 并配置鉴权 token');
    }
    return;
  }
  throw new Error('生产环境必须配置 Resend 或 HTTPS webhook 邮件提供器');
}

function verificationSecret(): string {
  const configured = String(process.env.SCIFIGURE_EMAIL_VERIFICATION_SECRET || '');
  if (configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production' || emailVerificationRequired()) {
    throw new Error('SCIFIGURE_EMAIL_VERIFICATION_SECRET 必须设置为至少 32 个字符');
  }
  return 'development-only-email-verification-secret';
}

export function hashEmailVerificationCode(challengeId: string, code: string): string {
  return crypto
    .createHmac('sha256', verificationSecret())
    .update(`${challengeId}:${code}`)
    .digest('hex');
}

export function deriveEmailVerificationCode(challengeId: string): string {
  if (!/^evc_[0-9a-f-]{36}$/i.test(challengeId)) {
    throw new Error('Invalid email verification challenge id');
  }
  const digest = crypto
    .createHmac('sha256', verificationSecret())
    .update(`verification-code-v1:${challengeId}`)
    .digest();
  return (digest.readUInt32BE(0) % 1_000_000).toString().padStart(6, '0');
}

export function maskEmailAddress(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly deliveryCode: string,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

async function postJson(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new EmailDeliveryError('邮件服务暂时拒绝了发送请求', false, `provider_http_${response.status}`);
      }
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      const isTimeout = (error as Error)?.name === 'AbortError';
      throw new EmailDeliveryError(
        isTimeout ? '邮件服务响应超时' : '邮件服务连接状态未知',
        true,
        isTimeout ? 'provider_timeout' : 'provider_transport_unknown',
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendEmailVerificationCode(input: {
  deliveryId: string;
  email: string;
  code: string;
  expiresAt: string;
}): Promise<void> {
  const provider = emailVerificationProvider();
  if (provider === 'test') {
    if (process.env.SCIFIGURE_TEST_ISOLATED !== '1') {
      throw new Error('测试邮件提供器只能在隔离测试环境使用');
    }
    return;
  }
  if (provider === 'console') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产环境禁止把邮箱验证码写入控制台');
    }
    console.info(`[email-verification] ${maskEmailAddress(input.email)} code=${input.code}`);
    return;
  }
  if (provider === 'resend') {
    const apiKey = String(process.env.SCIFIGURE_RESEND_API_KEY || '');
    const from = String(process.env.SCIFIGURE_EMAIL_FROM || '');
    if (!apiKey || !from) throw new Error('Resend 邮件服务配置不完整');
    await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${apiKey}` }, {
      from,
      to: [input.email],
      subject: 'SciFigure 邮箱验证码',
      text: `你的 SciFigure 验证码是 ${input.code}。验证码将在 ${emailVerificationTtlMinutes()} 分钟后失效，请勿转发。`,
    });
    return;
  }
  if (provider === 'webhook') {
    const webhookUrl = String(process.env.SCIFIGURE_EMAIL_WEBHOOK_URL || '');
    const webhookToken = String(process.env.SCIFIGURE_EMAIL_WEBHOOK_TOKEN || '');
    const parsed = new URL(webhookUrl);
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      throw new Error('生产邮件 webhook 必须使用 HTTPS');
    }
    await postJson(webhookUrl, webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}, {
      template: 'email_verification',
      deliveryId: input.deliveryId,
      to: input.email,
      code: input.code,
      expiresAt: input.expiresAt,
    });
    return;
  }
  throw new Error('邮箱验证码已启用，但邮件提供器尚未配置');
}
