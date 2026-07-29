import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import {
  buildInlineTextPatch,
  buildRadarDimensionLabelPositionPatch,
  buildRadarLabelOffsetValue,
  isRadarDimensionLabelObject,
  resolveAxesPatchPanelGid,
  resolveLegendContainerGid,
  resolvePendingDragSubmissionOutcome,
  resolveRenderFigureBox,
  shouldResetPendingDragForRenderChange,
  supportsInlineTextEditing,
} from './ChartPreview';

describe('ChartPreview legend drag target resolution', () => {
  it('promotes primary, figure-level, and extra legend children to their container', () => {
    expect(resolveLegendContainerGid('legend_text.0.1')).toBe('legend.0');
    expect(resolveLegendContainerGid('legend_collection.figure.0.1')).toBe('legend.figure.0');
    expect(resolveLegendContainerGid('legend_text.0.extra.0.1')).toBe('legend.0.extra.0');
    expect(resolveLegendContainerGid('legend_collection.2.extra.3.0')).toBe('legend.2.extra.3');
  });

  it('leaves non-legend objects unchanged', () => {
    expect(resolveLegendContainerGid('text.0.1')).toBe('text.0.1');
    expect(resolveLegendContainerGid(null)).toBeNull();
  });
});

describe('ChartPreview pending drag submission transaction', () => {
  it('clears pending movement only after renderer success', () => {
    expect(resolvePendingDragSubmissionOutcome({ status: 'success' })).toEqual({
      clearPending: true,
      message: null,
    });
  });

  it('retains pending movement after renderer rejection', () => {
    expect(resolvePendingDragSubmissionOutcome({
      status: 'conflict',
      message: 'identity mismatch',
    })).toEqual({
      clearPending: false,
      message: '位置未保存：identity mismatch。待确认移动已保留，可重试。',
    });
  });

  it('retains pending movement after request failure', () => {
    expect(resolvePendingDragSubmissionOutcome(null, new Error('network unavailable'))).toEqual({
      clearPending: false,
      message: '位置未保存：network unavailable。待确认移动已保留，可重试。',
    });
  });

  it('does not clear pending movement for a render refresh during submission', () => {
    expect(shouldResetPendingDragForRenderChange(true)).toBe(false);
    expect(shouldResetPendingDragForRenderChange(false)).toBe(true);
  });
});

function textObject(overrides: Partial<ManifestObject> = {}): ManifestObject {
  return {
    id: 'text.0',
    kind: 'text',
    label: 'text.0',
    editable: ['text'],
    currentProps: { text: 'Original' },
    ...overrides,
  };
}

describe('ChartPreview inline text editing capability gate', () => {
  it('blocks modern manifest objects when text is omitted from authoritative capabilities', () => {
    const object = textObject({
      propertyCapabilities: [{
        prop: 'color',
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      }],
    });

    expect(supportsInlineTextEditing(object)).toBe(false);
    expect(buildInlineTextPatch(object.id, object, 'Updated')).toBeNull();
  });

  it('keeps legacy editable text objects inline editable', () => {
    const object = textObject();

    expect(supportsInlineTextEditing(object)).toBe(true);
    expect(buildInlineTextPatch(object.id, object, 'Updated')).toMatchObject({
      op: 'set',
      mode: 'backend_patch',
      gid: 'text.0',
      prop: 'text',
      value: 'Updated',
      intent: {
        intent: 'content.text',
        scope: {
          objectIds: ['text.0'],
          targetKinds: ['text'],
          crossFigure: 'deny',
        },
      },
    });
  });
});

describe('ChartPreview subplot hit mapping', () => {
  it('maps a normal axes patch back to the matching logical subplot', () => {
    const subplot: ManifestObject = {
      id: 'subplot.3',
      kind: 'subplot',
      label: '(d)',
      editable: ['left', 'bottom', 'width', 'height'],
      currentProps: {},
      source: { artistClass: 'Axes', axesIndex: 3 },
    };

    expect(resolveAxesPatchPanelGid([subplot], 3)).toBe('subplot.3');
  });

  it('keeps special axes selectable when no normal subplot exists', () => {
    const polar: ManifestObject = {
      id: 'subplot.polar.0',
      kind: 'polar_subplot',
      label: 'polar',
      editable: [],
      currentProps: {},
      source: { artistClass: 'PolarAxes', axesIndex: 0 },
    };

    expect(resolveAxesPatchPanelGid([polar], 0)).toBe('subplot.polar.0');
  });
});

describe('ChartPreview expanded render viewport mapping', () => {
  const fallback = { x: 0, y: 0, width: 360, height: 240 };

  it('uses the original Figure bounds inside an expanded SVG canvas', () => {
    expect(resolveRenderFigureBox({
      figure: { x: 12, y: 8, width: 300, height: 200 },
    }, fallback)).toEqual({ x: 12, y: 8, width: 300, height: 200 });
  });

  it('keeps old manifests compatible by falling back to the SVG viewBox', () => {
    expect(resolveRenderFigureBox(undefined, fallback)).toEqual(fallback);
    expect(resolveRenderFigureBox({ figure: { width: 0, height: 200 } }, fallback)).toEqual(fallback);
  });
});

describe('ChartPreview radar dimension label dragging contract', () => {
  const radarLabel: ManifestObject = {
    id: 'xtick.0.2',
    kind: 'text',
    role: 'x_tick_label',
    label: 'Total nitrogen',
    editable: ['text', 'radar_label_offset'],
    currentProps: {
      text: 'Total nitrogen',
      radarSemanticRole: 'dimension_label',
      radar_label_offset: { dx: 3, dy: -2 },
    },
    propertyCapabilities: [{
      prop: 'radar_label_offset',
      patchMode: 'backend_patch',
      scopes: ['object'],
      preview: 'approximate',
      replay: 'stable',
      coordinateSpace: 'display',
    }],
  };

  it('recognizes only capability-backed radar dimension labels', () => {
    expect(isRadarDimensionLabelObject(radarLabel.id, radarLabel)).toBe(true);
    expect(isRadarDimensionLabelObject(radarLabel.id, {
      ...radarLabel,
      kind: 'xtick',
    })).toBe(true);
    expect(isRadarDimensionLabelObject('xtick.0.2', {
      ...radarLabel,
      currentProps: { text: 'ordinary tick' },
    })).toBe(false);
  });

  it('converts SVG drag deltas into stable point offsets', () => {
    expect(buildRadarLabelOffsetValue(radarLabel, 7.25, 4.5)).toEqual({
      dx: 10.25,
      dy: -6.5,
    });
  });

  it('keeps an xtick label patch scoped to the selected manifest kind', () => {
    const xtickLabel = { ...radarLabel, kind: 'xtick' as const };

    expect(buildRadarDimensionLabelPositionPatch(xtickLabel.id, xtickLabel, 4, -3)).toMatchObject({
      gid: 'xtick.0.2',
      prop: 'radar_label_offset',
      intent: {
        scope: {
          objectIds: ['xtick.0.2'],
          targetKinds: ['xtick'],
          crossFigure: 'deny',
        },
      },
    });
  });
});
