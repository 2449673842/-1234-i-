import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLegacyRetireObservationQueue,
  flushLegacyRetireObservationQueue,
  recordLegacyRetireObservation,
} from './legacyRetireObservationClient';

const uiEvent = (renderedControlCount = 1) => ({
  eventType: 'legacy_ui_surface_rendered',
  surface: 'font_controls_rollback',
  center: 'fonts',
  controlFamily: 'common',
  renderedControlCount,
  objectId: 'title.0',
  label: 'Private label',
  value: '#ff0000',
  paletteId: 'secret_palette',
  color: '#00ff00',
  script: 'print("secret")',
});

describe('legacy retire observation client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY', '1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    clearLegacyRetireObservationQueue();
  });

  afterEach(() => {
    clearLegacyRetireObservationQueue();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('batches sanitized events after 250ms', async () => {
    recordLegacyRetireObservation(uiEvent(2));
    recordLegacyRetireObservation(uiEvent(3));

    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      events: [
        {
          eventType: 'legacy_ui_surface_rendered',
          surface: 'font_controls_rollback',
          center: 'fonts',
          controlFamily: 'common',
          renderedControlCount: 2,
        },
        {
          eventType: 'legacy_ui_surface_rendered',
          surface: 'font_controls_rollback',
          center: 'fonts',
          controlFamily: 'common',
          renderedControlCount: 3,
        },
      ],
    });
  });

  it('does not enqueue or flush when disabled', async () => {
    vi.stubEnv('VITE_SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY', '0');
    recordLegacyRetireObservation(uiEvent());
    await vi.advanceTimersByTimeAsync(500);
    await flushLegacyRetireObservationQueue();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps sensitive values out of transport and drops failures silently', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    recordLegacyRetireObservation(uiEvent());
    await flushLegacyRetireObservationQueue();

    expect(fetch).toHaveBeenCalledTimes(1);
    const serialized = String(vi.mocked(fetch).mock.calls[0][1]?.body);
    expect(serialized).not.toContain('title.0');
    expect(serialized).not.toContain('Private label');
    expect(serialized).not.toContain('#ff0000');
    expect(serialized).not.toContain('secret_palette');
    expect(serialized).not.toContain('#00ff00');
    expect(serialized).not.toContain('print("secret")');
  });
});
