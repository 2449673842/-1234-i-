import { describe, expect, it } from 'vitest';
import type { ManifestObject } from '../schemas/manifest';
import { buildInlineTextPatch, resolveAxesPatchPanelGid, resolvePendingDragSubmissionOutcome, shouldResetPendingDragForRenderChange, supportsInlineTextEditing } from './ChartPreview';

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
