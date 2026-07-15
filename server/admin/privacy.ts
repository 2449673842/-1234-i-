const SENSITIVE_KEY_PATTERN = /(script|data|dataset|payload|trace|stack|path|file|content|token|password|secret|cookie|authorization|email|fingerprint|svg|image|export)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|etc|opt|root|mnt|Volumes)\/)[^\s,;]*/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const HIGH_ENTROPY_PATTERN = /\b(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const STRUCTURED_CONTENT_PATTERN = /[\r\n]|<svg\b|<script\b|data:image\/|base64,|(?:^|[,;])\s*[A-Za-z_][A-Za-z0-9_]*\s*[:=]/i;

export function sanitizeAdminOperationalText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (STRUCTURED_CONTENT_PATTERN.test(trimmed)) return '[redacted-content]';
  const sanitized = trimmed
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(ABSOLUTE_PATH_PATTERN, '[redacted-path]')
    .replace(BEARER_PATTERN, '[redacted-secret]')
    .replace(HIGH_ENTROPY_PATTERN, '[redacted-secret]')
    .replace(UUID_PATTERN, '[redacted-id]')
    .slice(0, Math.max(1, maxLength));
  return sanitized || null;
}

function sanitizeAuditValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeAdminOperationalText(value, 240);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 16)
      .map(item => sanitizeAuditValue(item, depth + 1))
      .filter(item => item !== undefined && item !== null);
  }
  if (value && typeof value === 'object') {
    return sanitizeAdminAuditMetadata(value, depth + 1);
  }
  return undefined;
}

export function sanitizeAdminAuditMetadata(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(output).length >= 32 || SENSITIVE_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeAuditValue(raw, depth);
    if (sanitized !== undefined && sanitized !== null) output[key.slice(0, 80)] = sanitized;
  }
  return output;
}
