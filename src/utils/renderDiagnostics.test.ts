import { describe, expect, it } from 'vitest';
import type { Manifest, RenderResponse } from '../schemas/manifest';
import {
  normalizeFigureModel,
  normalizeRenderDiagnostics,
  normalizeRenderResponse,
} from './standardFigureModel';

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects: [],
    capabilities: {
      localPatch: true,
      backendPatch: true,
      codePatch: true,
    },
    ...overrides,
  };
}

describe('render diagnostics normalization', () => {
  it('projects raw renderer warnings and layout timing into the standard model', () => {
    const response: RenderResponse = {
      status: 'success',
      sessionId: 'session_1',
      svg: '<svg />',
      manifest: makeManifest(),
      revision: 3,
      timingMs: 123,
      timingBreakdown: { totalMs: 123, layoutDiagnosticsMs: 8.6 },
      determinismWarnings: [{
        type: 'non_deterministic_source',
        message: 'numpy.random has no fixed seed.',
        symbol: 'numpy.random',
        line: 7,
      }],
      layoutWarnings: [{
        type: 'layout_overlap',
        message: 'Labels overlap.',
        elements: ['axes.0.title', 'axes.0.xlabel'],
      }],
    };

    expect(normalizeRenderResponse(response).diagnostics).toEqual({
      determinismWarnings: response.determinismWarnings,
      layoutWarnings: response.layoutWarnings,
      layoutDiagnosticsMs: 9,
    });
  });

  it('replays diagnostics embedded in a cache manifest without renderer timing', () => {
    const manifest = makeManifest({
      renderDiagnostics: {
        determinismWarnings: [{
          type: 'non_deterministic_source',
          message: 'Current time changes between renders.',
          symbol: 'time.time',
        }],
        layoutWarnings: [{
          type: 'layout_clip',
          message: 'Legend may be clipped.',
          element: 'figure.legend.0',
        }],
        layoutDiagnosticsMs: 4,
      },
    });
    const cachedResponse: RenderResponse = {
      status: 'success',
      sessionId: 'session_2',
      svg: '<svg />',
      manifest,
      revision: 4,
      timingMs: 0,
      cache: { hit: true, key: 'render-cache-key' },
    };

    expect(normalizeRenderResponse(cachedResponse).diagnostics).toEqual(manifest.renderDiagnostics);
    expect(normalizeFigureModel({ manifest }).diagnostics).toEqual(manifest.renderDiagnostics);
  });

  it('drops malformed warnings while keeping valid, non-negative timing', () => {
    expect(normalizeRenderDiagnostics({
      determinismWarnings: [
        { type: 'valid', message: 'kept' },
        { type: 'missing-message' } as any,
      ],
      layoutWarnings: 'not-an-array' as any,
      layoutDiagnosticsMs: -2.4,
    })).toEqual({
      determinismWarnings: [{ type: 'valid', message: 'kept' }],
      layoutWarnings: [],
      layoutDiagnosticsMs: 0,
    });
  });

  it('preserves R warning diagnostics and runtime inventory when present', () => {
    const response: RenderResponse = {
      status: 'success',
      sessionId: 'session-r',
      svg: '<svg />',
      manifest: makeManifest(),
      revision: 1,
      timingMs: 1,
      warningDiagnostics: [{ type: 'font_warning', message: 'fallback' }],
      runtimeInventory: { schemaVersion: '1.0', timezone: 'UTC' },
    };

    expect(normalizeRenderResponse(response).diagnostics).toMatchObject({
      warningDiagnostics: response.warningDiagnostics,
      runtimeInventory: response.runtimeInventory,
    });
  });
});
