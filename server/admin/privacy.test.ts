import { describe, expect, it } from 'vitest';
import { sanitizeAdminAuditMetadata, sanitizeAdminOperationalText } from './privacy';

describe('admin privacy boundary', () => {
  it('redacts user identifiers, paths and secrets from operational text', () => {
    const value = sanitizeAdminOperationalText(
      'Grant user@example.test from C:\\Users\\Researcher\\private.csv with Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(value).toContain('[redacted-email]');
    expect(value).toContain('[redacted-path]');
    expect(value).toContain('[redacted-secret]');
    expect(value).not.toContain('user@example.test');
    expect(value).not.toContain('private.csv');
  });

  it('replaces pasted structured content instead of storing it', () => {
    expect(sanitizeAdminOperationalText('sample,value\nA,1')).toBe('[redacted-content]');
  });

  it('drops sensitive audit keys and sanitizes nested values', () => {
    expect(sanitizeAdminAuditMetadata({
      plan: 'pro',
      reason: 'Requested by user@example.test',
      token: 'must-not-survive',
      nested: { path: '/srv/private.csv', status: 'ok' },
    })).toEqual({
      plan: 'pro',
      reason: 'Requested by [redacted-email]',
      nested: { status: 'ok' },
    });
  });
});
