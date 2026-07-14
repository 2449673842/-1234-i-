import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard';

function installLegacyClipboard(copyResult = true) {
  const textarea = {
    value: '',
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const execCommand = vi.fn(() => copyResult);

  vi.stubGlobal('document', {
    body: { appendChild },
    createElement: vi.fn(() => textarea),
    execCommand,
  });

  return { appendChild, execCommand, textarea };
}

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the Clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTextToClipboard('modern copy')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('modern copy');
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const legacy = installLegacyClipboard();

    await expect(copyTextToClipboard('HTTP copy')).resolves.toBe(true);
    expect(legacy.textarea.value).toBe('HTTP copy');
    expect(legacy.appendChild).toHaveBeenCalledWith(legacy.textarea);
    expect(legacy.textarea.focus).toHaveBeenCalledOnce();
    expect(legacy.textarea.select).toHaveBeenCalledOnce();
    expect(legacy.execCommand).toHaveBeenCalledWith('copy');
    expect(legacy.textarea.remove).toHaveBeenCalledOnce();
  });

  it('falls back when the Clipboard API rejects the request', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const legacy = installLegacyClipboard();

    await expect(copyTextToClipboard('retry copy')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('retry copy');
    expect(legacy.execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports a failed legacy copy and still removes the temporary textarea', async () => {
    vi.stubGlobal('navigator', {});
    const legacy = installLegacyClipboard(false);

    await expect(copyTextToClipboard('blocked copy')).resolves.toBe(false);
    expect(legacy.execCommand).toHaveBeenCalledWith('copy');
    expect(legacy.textarea.remove).toHaveBeenCalledOnce();
  });

  it('returns false when no copy mechanism can handle the text', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', undefined);

    await expect(copyTextToClipboard('cannot copy')).resolves.toBe(false);
    await expect(copyTextToClipboard('')).resolves.toBe(false);
  });
});
