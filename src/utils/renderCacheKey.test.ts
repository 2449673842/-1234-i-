import { describe, expect, it } from 'vitest';
import { buildFigureRenderCacheKey } from './renderCacheKey';

const baseInput = {
  engine: 'python_matplotlib',
  projectId: 'project_1',
  figureId: 'fig_1',
  script: 'import matplotlib.pyplot as plt\nplt.figure()',
  dataPayload: { rows: [{ x: 1, y: 2 }] },
  figureFingerprint: 'fp_1',
  editLog: [{ gid: 'title.0', prop: 'fontsize', value: 10, mode: 'backend_patch' }],
  renderOptions: { dpi: 150 },
};

describe('buildFigureRenderCacheKey', () => {
  it('is deterministic for equivalent objects with different key order', async () => {
    const a = await buildFigureRenderCacheKey(baseInput);
    const b = await buildFigureRenderCacheKey({
      ...baseInput,
      dataPayload: { rows: [{ y: 2, x: 1 }] },
    });

    expect(a).toBe(b);
  });

  it('changes when editLog changes', async () => {
    const before = await buildFigureRenderCacheKey(baseInput);
    const after = await buildFigureRenderCacheKey({
      ...baseInput,
      editLog: [{ gid: 'title.0', prop: 'fontsize', value: 12, mode: 'backend_patch' }],
    });

    expect(after).not.toBe(before);
  });

  it('ignores non-semantic editLog audit fields', async () => {
    const before = await buildFigureRenderCacheKey({
      ...baseInput,
      editLog: [{ gid: 'title.0', prop: 'fontsize', value: 10, mode: 'backend_patch', timestamp: 100 }],
    });
    const after = await buildFigureRenderCacheKey({
      ...baseInput,
      editLog: [{ gid: 'title.0', prop: 'fontsize', value: 10, mode: 'backend_patch', timestamp: 200, requestId: 'req_2' }],
    });

    expect(after).toBe(before);
  });

  it('changes when target figure changes', async () => {
    const fig1 = await buildFigureRenderCacheKey(baseInput);
    const fig2 = await buildFigureRenderCacheKey({
      ...baseInput,
      figureId: 'fig_2',
    });

    expect(fig2).not.toBe(fig1);
  });

  it('changes when render options change', async () => {
    const lowDpi = await buildFigureRenderCacheKey(baseInput);
    const highDpi = await buildFigureRenderCacheKey({
      ...baseInput,
      renderOptions: { dpi: 600 },
    });

    expect(highDpi).not.toBe(lowDpi);
  });

  it('uses a stable default renderer authority when omitted', async () => {
    const omittedAuthority = await buildFigureRenderCacheKey(baseInput);
    const explicitDefaultAuthority = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererAuthority: {
        rendererSource: 'unspecified',
        rendererImage: 'unspecified',
        rendererRuntime: 'unspecified',
        rendererPackageContract: 'unspecified',
      },
    });

    expect(explicitDefaultAuthority).toBe(omittedAuthority);
  });

  it('changes when renderer authority changes', async () => {
    const matplotlibRuntime = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererAuthority: {
        rendererSource: 'server-session-render',
        rendererImage: 'python-renderer:2026-07-26',
        rendererRuntime: 'python-3.11',
        rendererPackageContract: { matplotlib: '3.9.x', numpy: '2.x' },
      },
    });
    const pinnedRuntime = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererAuthority: {
        rendererSource: 'server-session-render',
        rendererImage: 'python-renderer:2026-07-26',
        rendererRuntime: 'python-3.12',
        rendererPackageContract: { matplotlib: '3.9.x', numpy: '2.x' },
      },
    });

    expect(pinnedRuntime).not.toBe(matplotlibRuntime);
  });

  it('normalizes equivalent renderer package contracts', async () => {
    const a = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererAuthority: {
        rendererSource: 'server-session-render',
        rendererImage: 'python-renderer:2026-07-26',
        rendererRuntime: 'python-3.11',
        rendererPackageContract: { matplotlib: '3.9.x', numpy: '2.x' },
      },
    });
    const b = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererAuthority: {
        rendererSource: 'server-session-render',
        rendererImage: 'python-renderer:2026-07-26',
        rendererRuntime: 'python-3.11',
        rendererPackageContract: { numpy: '2.x', matplotlib: '3.9.x' },
      },
    });

    expect(b).toBe(a);
  });

  it('accepts top-level renderer authority fields for compatibility', async () => {
    const nestedAuthority = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererAuthority: {
        rendererSource: 'server-session-render',
        rendererImage: 'python-renderer:2026-07-26',
        rendererRuntime: 'python-3.11',
        rendererPackageContract: { matplotlib: '3.9.x' },
      },
    });
    const topLevelAuthority = await buildFigureRenderCacheKey({
      ...baseInput,
      rendererSource: 'server-session-render',
      rendererImage: 'python-renderer:2026-07-26',
      rendererRuntime: 'python-3.11',
      rendererPackageContract: { matplotlib: '3.9.x' },
    });

    expect(topLevelAuthority).toBe(nestedAuthority);
  });
});
