import crypto from 'node:crypto';

export type AdminMfaMode = 'observe' | 'enforce';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const ENVELOPE_VERSION = 'v2';

type AdminMfaKey = { id: string; key: Buffer };

function decodeConfiguredKey(configured: string): Buffer {
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(configured)) {
    key = Buffer.from(configured, 'hex');
  } else {
    if (!/^[A-Za-z0-9+/_=-]+$/.test(configured)) {
      throw new Error('SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制');
    }
    key = Buffer.from(configured.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (key.length !== 32) {
    throw new Error('SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY 解码后必须恰好为 32 字节');
  }
  return key;
}

function configuredKeyring(): AdminMfaKey[] {
  const keyring = String(process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS || '').trim();
  const singleKey = String(process.env.SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY || '').trim();
  if (keyring && singleKey) {
    throw new Error('管理员二步验证只能配置密钥环或单密钥，不能同时设置');
  }
  if (keyring) {
    const entries = keyring.split(',').map(entry => entry.trim()).filter(Boolean).map((entry): AdminMfaKey => {
      const separator = entry.indexOf(':');
      const id = separator > 0 ? entry.slice(0, separator).trim() : '';
      const encoded = separator > 0 ? entry.slice(separator + 1).trim() : '';
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !encoded) {
        throw new Error('SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS 必须使用 kid:base64 格式');
      }
      return { id, key: decodeConfiguredKey(encoded) };
    });
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      throw new Error('管理员二步验证密钥 ID 不能重复');
    }
    return entries;
  }
  return singleKey ? [{ id: 'primary', key: decodeConfiguredKey(singleKey) }] : [];
}

function masterKey(keyId?: string): AdminMfaKey {
  const keyring = configuredKeyring();
  if (keyring.length === 0) {
    throw new Error('管理员二步验证密钥尚未配置');
  }
  const selected = keyId ? keyring.find(entry => entry.id === keyId) : keyring[0];
  if (!selected) throw new Error('管理员二步验证密钥版本不可用');
  return selected;
}

function deriveKey(purpose: string, keyId?: string): Buffer {
  const selected = masterKey(keyId);
  return crypto
    .createHmac('sha256', selected.key)
    .update(`scifigure-admin-mfa:${purpose}:v1`)
    .digest();
}

export function adminMfaMode(): AdminMfaMode {
  const configured = String(process.env.SCIFIGURE_ADMIN_MFA_MODE || '').trim().toLowerCase();
  if (!configured) return process.env.NODE_ENV === 'production' ? 'enforce' : 'observe';
  if (configured === 'observe' || configured === 'enforce') return configured;
  throw new Error('SCIFIGURE_ADMIN_MFA_MODE 只能是 observe 或 enforce');
}

export function adminMfaEncryptionConfigured(): boolean {
  return configuredKeyring().length > 0;
}

export function assertAdminMfaProductionConfig(adminConsoleEnabled: boolean): void {
  if (process.env.NODE_ENV !== 'production' || !adminConsoleEnabled) return;
  if (adminMfaMode() !== 'enforce' && process.env.SCIFIGURE_ALLOW_ADMIN_MFA_OBSERVE_IN_PRODUCTION !== '1') {
    throw new Error('生产管理员后台必须强制启用二步验证');
  }
  masterKey();
}

export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Invalid Base32 secret');
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid Base32 secret');
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateAdminTotpSecret(): string {
  return encodeBase32(crypto.randomBytes(20));
}

function hotp(secret: string, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid TOTP counter');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export function adminTotpCounter(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function generateAdminTotpCode(secret: string, nowMs = Date.now()): string {
  return hotp(secret, adminTotpCounter(nowMs));
}

function constantTimeTextEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function findUsableAdminTotpCounter(
  secret: string,
  candidate: string,
  nowMs = Date.now(),
  lastUsedCounter: number | null = null,
): number | null {
  if (!/^\d{6}$/.test(candidate)) return null;
  const current = adminTotpCounter(nowMs);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const counter = current + delta;
    if (counter < 0 || (lastUsedCounter !== null && counter <= lastUsedCounter)) continue;
    if (constantTimeTextEqual(hotp(secret, counter), candidate)) return counter;
  }
  return null;
}

function envelopeAad(userId: string, factorId: string): Buffer {
  if (!/^usr_[A-Za-z0-9_-]{8,}$/.test(userId)) throw new Error('Invalid administrator identifier');
  if (!/^amf_[A-Za-z0-9_-]{8,}$/.test(factorId)) throw new Error('Invalid administrator MFA factor identifier');
  return Buffer.from(`scifigure:admin-mfa:${userId}:${factorId}:totp:v1`, 'utf8');
}

export function encryptAdminTotpSecret(userId: string, factorId: string, secret: string): string {
  decodeBase32(secret);
  const selected = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('totp-secret', selected.id), iv);
  cipher.setAAD(envelopeAad(userId, factorId));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, selected.id, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

export function decryptAdminTotpSecret(userId: string, factorId: string, envelope: string): string {
  const parts = String(envelope || '').split('.');
  const isLegacy = parts[0] === 'v1' && parts.length === 4;
  const isCurrent = parts[0] === ENVELOPE_VERSION && parts.length === 5;
  if (!isLegacy && !isCurrent) {
    throw new Error('Invalid administrator MFA secret envelope');
  }
  const keyId = isCurrent ? parts[1] : undefined;
  const [ivText, ciphertextText, tagText] = isCurrent ? parts.slice(2) : parts.slice(1);
  const iv = Buffer.from(ivText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Invalid administrator MFA secret envelope');
  }
  const candidateKeyIds = isLegacy ? configuredKeyring().map(entry => entry.id) : [keyId!];
  for (const candidateKeyId of candidateKeyIds) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('totp-secret', candidateKeyId), iv);
      decipher.setAAD(envelopeAad(userId, factorId));
      decipher.setAuthTag(tag);
      const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      decodeBase32(secret);
      return secret;
    } catch {
      // Legacy envelopes have no key id, so every retained key must be tried.
    }
  }
  throw new Error('Administrator MFA secret cannot be decrypted with the configured keyring');
}

export function buildAdminOtpAuthUri(userId: string, secret: string): string {
  decodeBase32(secret);
  const issuer = 'SciFigure';
  const label = `${issuer}:${userId}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function normalizeAdminRecoveryCode(value: string): string {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function generateAdminRecoveryCodes(count = 10): string[] {
  const boundedCount = Math.max(6, Math.min(12, Math.floor(count)));
  return Array.from({ length: boundedCount }, () => {
    const raw = encodeBase32(crypto.randomBytes(10)).slice(0, 16);
    return raw.match(/.{1,4}/g)!.join('-');
  });
}

export function hashAdminRecoveryCode(userId: string, code: string): string {
  const normalized = normalizeAdminRecoveryCode(code);
  if (!/^[A-Z2-7]{16}$/.test(normalized)) return '';
  return crypto
    .createHash('sha256')
    .update(`scifigure-admin-recovery:v1:${userId}:${normalized}`)
    .digest('hex');
}
