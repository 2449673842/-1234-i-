import { describe, expect, it } from 'vitest';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import {
  draftAppliesToFigure,
  draftsEligibleForDirectPersistence,
  draftsRequiringEngineApply,
  evictSupersededGlobalPaletteDrafts,
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

  it('evicts a superseded global palette draft and all of its replay patches', () => {
    const globalValue = '#cc5500';
    const globalCodeDraft: DraftPatch = {
      gid: 'code_patch',
      prop: 'RED',
      value: globalValue,
      new_value: globalValue,
      mode: 'backend_patch',
      type: 'code_patch',
      target_id: 'RED',
      gids: ['line.0', 'line.1', 'collection.1'],
    };
    const current = {
      'code_patch:RED': globalCodeDraft,
      'line.0:color': { ...colorDraft, gid: 'line.0', value: globalValue },
      'line.1:color': { ...colorDraft, gid: 'line.1', value: globalValue },
      'collection.1:facecolor': {
        ...colorDraft,
        gid: 'collection.1',
        prop: 'facecolor',
        value: globalValue,
      },
      'line.0:linewidth': widthDraft,
    };
    const incoming: DraftPatch[] = [{
      ...colorDraft,
      gid: 'line.1',
      value: '#aa00cc',
      intent: {
        intent: 'style.component',
        scope: {
          selectionMode: 'role_in_subplot',
          subplotIds: ['subplot.1'],
          objectIds: ['line.1'],
          crossFigure: 'deny',
        },
        operation: { prop: 'color', value: '#aa00cc' },
      },
    }];

    expect(evictSupersededGlobalPaletteDrafts(current, incoming)).toEqual({
      'line.0:linewidth': widthDraft,
    });
  });

  it('keeps global palette drafts for all-subplot updates and unrelated scoped objects', () => {
    const globalCodeDraft: DraftPatch = {
      gid: 'code_patch',
      prop: 'BLUE',
      value: '#2255aa',
      new_value: '#2255aa',
      mode: 'backend_patch',
      type: 'code_patch',
      target_id: 'BLUE',
      gids: ['line.0'],
    };
    const current = { 'code_patch:BLUE': globalCodeDraft };
    const allSubplots: DraftPatch = {
      ...colorDraft,
      gid: 'line.0',
      intent: {
        intent: 'style.component',
        scope: { selectionMode: 'explicit_objects', subplotIds: '*', objectIds: ['line.0'] },
        operation: { prop: 'color', value: colorDraft.value },
      },
    };
    const unrelatedScoped: DraftPatch = {
      ...colorDraft,
      gid: 'line.9',
      intent: {
        intent: 'style.component',
        scope: { selectionMode: 'role_in_subplot', subplotIds: ['subplot.9'], objectIds: ['line.9'] },
        operation: { prop: 'color', value: colorDraft.value },
      },
    };

    expect(evictSupersededGlobalPaletteDrafts(current, [allSubplots])).toEqual(current);
    expect(evictSupersededGlobalPaletteDrafts(current, [unrelatedScoped])).toEqual(current);
  });

  it('keeps unrelated color properties and color subsets on the same object', () => {
    const globalCodeDraft: DraftPatch = {
      gid: 'code_patch',
      prop: 'BLUE',
      value: '#2255aa',
      new_value: '#2255aa',
      mode: 'backend_patch',
      type: 'code_patch',
      target_id: 'BLUE',
      gids: ['collection.1'],
    };
    const globalFacecolorDraft: DraftPatch = {
      ...colorDraft,
      gid: 'collection.1',
      prop: 'facecolor',
      value: '#2255aa',
      matchColor: '#0f3cf0',
    };
    const current = {
      'code_patch:BLUE': globalCodeDraft,
      'collection.1:facecolor:match:#0f3cf0': globalFacecolorDraft,
    };
    const scopedIntent = {
      intent: 'style.component' as const,
      scope: {
        selectionMode: 'role_in_subplot' as const,
        subplotIds: ['subplot.1'],
        objectIds: ['collection.1'],
        crossFigure: 'deny' as const,
      },
      operation: { prop: 'facecolor', value: '#aa00cc' },
    };

    const scopedEdgecolor: DraftPatch = {
      ...globalFacecolorDraft,
      prop: 'edgecolor',
      value: '#aa00cc',
      matchColor: undefined,
      intent: {
        ...scopedIntent,
        operation: { prop: 'edgecolor', value: '#aa00cc' },
      },
    };
    const scopedRedSubset: DraftPatch = {
      ...globalFacecolorDraft,
      value: '#aa00cc',
      matchColor: '#d62728',
      intent: scopedIntent,
    };

    expect(evictSupersededGlobalPaletteDrafts(current, [scopedEdgecolor])).toEqual(current);
    expect(evictSupersededGlobalPaletteDrafts(current, [scopedRedSubset])).toEqual(current);
  });
});
