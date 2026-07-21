import { describe, expect, it } from 'vitest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import {
  draftAppliesToFigure,
  draftsEligibleForDirectPersistence,
  draftsRequiringEngineApply,
  isSameDraftPatch,
  mergeDraftSettlement,
  settleDraftTransaction,
} from './draftTransaction';

const colorDraft: DraftPatch = {
  gid: 'line.0.0',
  prop: 'color',
  value: '#cc0000',
  mode: 'local_patch',
};

const widthDraft: DraftPatch = {
  gid: 'line.0.0',
  prop: 'linewidth',
  value: 2,
  mode: 'backend_patch',
};

describe('draft transaction settlement', () => {
  it('removes drafts only after every attempted target succeeds', () => {
    const settlement = settleDraftTransaction(
      { color: colorDraft, width: widthDraft },
      [
        { targetId: 'fig_1', draftKeys: ['color', 'width'] },
        { targetId: 'fig_2', draftKeys: ['color', 'width'] },
      ],
      [
        { targetId: 'fig_1', success: true },
        { targetId: 'fig_2', success: true },
      ],
    );

    expect(settlement.nextBucket).toEqual({});
    expect(settlement.completedDraftKeys.sort()).toEqual(['color', 'width']);
    expect(settlement.failedTargetIds).toEqual([]);
  });

  it('retains only failed figure targets after a partial apply', () => {
    const settlement = settleDraftTransaction(
      { color: colorDraft, width: widthDraft },
      [
        { targetId: 'fig_1', draftKeys: ['color', 'width'] },
        { targetId: 'fig_2', draftKeys: ['color'] },
      ],
      [
        { targetId: 'fig_1', success: true },
        { targetId: 'fig_2', success: false },
      ],
    );

    expect(settlement.nextBucket).toEqual({
      color: { ...colorDraft, pendingFigureIds: ['fig_2'] },
    });
    expect(settlement.completedDraftKeys).toEqual(['width']);
    expect(settlement.pendingDraftKeys).toEqual(['color']);
    expect(settlement.failedTargetIds).toEqual(['fig_2']);
  });

  it('keeps all attempted drafts when every request fails', () => {
    const settlement = settleDraftTransaction(
      { color: colorDraft, width: widthDraft },
      [{ targetId: 'fig_1', draftKeys: ['color', 'width'] }],
      [{ targetId: 'fig_1', success: false }],
    );

    expect(settlement.nextBucket.color.pendingFigureIds).toEqual(['fig_1']);
    expect(settlement.nextBucket.width.pendingFigureIds).toEqual(['fig_1']);
    expect(settlement.completedDraftKeys).toEqual([]);
  });

  it('keeps drafts that did not produce a safe target patch', () => {
    const settlement = settleDraftTransaction(
      { color: colorDraft },
      [],
      [],
    );

    expect(settlement.nextBucket).toEqual({ color: colorDraft });
    expect(settlement.pendingDraftKeys).toEqual(['color']);
  });

  it('limits retry drafts to failed figures until the user changes them', () => {
    const retryDraft = { ...colorDraft, pendingFigureIds: ['fig_2'] };

    expect(draftAppliesToFigure(retryDraft, 'fig_1')).toBe(false);
    expect(draftAppliesToFigure(retryDraft, 'fig_2')).toBe(true);
    expect(draftAppliesToFigure(colorDraft, 'fig_1')).toBe(true);
  });

  it('does not clear a newer draft written while an older request is running', () => {
    const snapshot = { color: colorDraft };
    const newerColorDraft = { ...colorDraft, value: '#00aa55' };
    const current = { color: newerColorDraft, width: widthDraft };

    const merged = mergeDraftSettlement(current, snapshot, {});

    expect(merged).toEqual({ color: newerColorDraft, width: widthDraft });
  });

  it('clears an applied draft when React recreated the same draft object', () => {
    const snapshot = { color: colorDraft };
    const current = { color: { ...colorDraft }, width: widthDraft };

    const merged = mergeDraftSettlement(current, snapshot, {});

    expect(merged).toEqual({ width: widthDraft });
  });

  it('does not settle a different mixed-color subset draft', () => {
    expect(isSameDraftPatch(
      { ...colorDraft, matchColor: '#0f3cf0' },
      { ...colorDraft, matchColor: '#d62728' },
    )).toBe(false);
  });

  it('treats equivalent mixed-color subset keys as the same draft', () => {
    expect(isSameDraftPatch(
      { ...colorDraft, matchColor: ' #0F3CF0 ' },
      { ...colorDraft, matchColor: '#0f3cf0' },
    )).toBe(true);
  });

  it('does not let save consume drafts reserved for failed-figure retry', () => {
    const retryDraft = { ...colorDraft, pendingFigureIds: ['fig_2'] };

    expect(draftsEligibleForDirectPersistence([retryDraft, widthDraft, colorDraft])).toEqual([colorDraft]);
    expect(draftsRequiringEngineApply([retryDraft, widthDraft, colorDraft])).toEqual([retryDraft, widthDraft]);
  });

  it('requires code patches to be applied before project persistence', () => {
    const codeDraft: DraftPatch = {
      gid: 'code_patch',
      prop: 'SERIES_COLOR',
      value: '#118833',
      mode: 'backend_patch',
      type: 'code_patch',
      target_id: 'SERIES_COLOR',
      new_value: '#118833',
      gids: ['line.0.0'],
    };

    expect(draftsEligibleForDirectPersistence([codeDraft])).toEqual([]);
    expect(draftsRequiringEngineApply([codeDraft])).toEqual([codeDraft]);
  });
});
