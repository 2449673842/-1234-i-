import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportClientError } from './clientErrorReporter';

describe('client error reporter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes local paths and secret query values before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { location: { pathname: '/editor' } });
    vi.stubGlobal('navigator', { userAgent: 'Test Browser' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(reportClientError({
      source: 'render',
      title: 'R render failed',
      message: 'C:\\Users\\Researcher\\private\\table.csv?token=secret-value failed',
      projectId: 'project-1',
      metadata: { language: 'r' },
    })).resolves.toBe(true);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.message).toContain('[local-path]');
    expect(payload.message).not.toContain('Researcher');
    expect(payload.message).not.toContain('secret-value');
    expect(payload.metadata).toEqual({ language: 'r' });
  });

  it('does not send empty reports', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(reportClientError({ source: 'client', title: '', message: '' })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
